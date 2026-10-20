// Item labels: short bracketed tags such as `[Q3]` or `[R12]` that an agent
// attaches to an item when it first raises it, then reuses to refer back to it.
// The first message carrying a label defines the item; later mentions render as
// chips that preview the defining block without scrolling the transcript. A
// struck-through mention (`~~[Q3]~~`) closes the item; the newest mention wins.

import { createContext } from "react";

/** Fragment href a label link carries from the remark pass to the link renderer. */
export const ITEM_LABEL_HREF_PREFIX = "#omnigent-item-";

// One to three capitals then one to three digits, so task-list `[x]`, numeric
// footnotes `[1]`, and prose in brackets never match. A label followed by `(`
// is the text of a markdown link, not a label.
const ITEM_LABEL_SOURCE = String.raw`\[([A-Z]{1,3}\d{1,3})\](?!\()`;

function itemLabelPattern(): RegExp {
  return new RegExp(ITEM_LABEL_SOURCE, "g");
}

/** A transcript message that may define item labels. */
export interface ItemLabelSource {
  messageId: string;
  role: "user" | "assistant";
  text: string;
  createdAtS?: number;
}

/** What one message says about labels. */
export interface ItemLabelScan {
  source: ItemLabelSource;
  /** Distinct labels in order of first appearance. */
  labels: readonly string[];
  /** Labels this message mentions struck through. */
  struck: readonly string[];
}

/** One labelled item across the transcript. */
export interface ItemLabelEntry {
  label: string;
  /** The message that first carried the label. */
  source: ItemLabelSource;
  /** The message whose struck mention closed the item; null while open. */
  closedBy: ItemLabelSource | null;
  /** How many messages mention the label. */
  messageCount: number;
}

export interface ItemLabelIndex {
  /**
   * Whether the transcript uses labels: some label recurs across messages, or
   * one message tags several items. A lone bracketed code stays plain text.
   */
  enabled: boolean;
  /** Items in order of definition. */
  items: ReadonlyMap<string, ItemLabelEntry>;
}

/** The transcript's label index; null on surfaces without a transcript. */
export const ItemLabelIndexContext = createContext<ItemLabelIndex | null>(null);

/** Id of the message whose markdown is being rendered. */
export const ItemLabelMessageContext = createContext<string | null>(null);

/** Builds the index from messages in transcript order; the first definition wins. */
export function buildItemLabelIndex(scans: Iterable<ItemLabelScan>): ItemLabelIndex {
  const items = new Map<string, ItemLabelEntry>();
  let enabled = false;
  for (const { source, labels, struck } of scans) {
    if (labels.length > 1) enabled = true;
    for (const label of labels) {
      const closedBy = struck.includes(label) ? source : null;
      const entry = items.get(label);
      if (!entry) {
        items.set(label, { label, source, closedBy, messageCount: 1 });
        continue;
      }
      entry.closedBy = closedBy;
      entry.messageCount += 1;
      enabled = true;
    }
  }
  return { enabled, items };
}

interface ScannedLine {
  text: string;
  /** Inside a fenced code block, or one of its fence lines. */
  inFence: boolean;
}

const FENCE_OPEN_RE = /^ {0,3}(`{3,}|~{3,})/;

function scanLines(markdown: string): ScannedLine[] {
  const lines: ScannedLine[] = [];
  let fence: string | null = null;
  for (const text of markdown.split("\n")) {
    if (fence === null) {
      const open = text.match(FENCE_OPEN_RE);
      if (open) fence = open[1];
      lines.push({ text, inFence: open !== null });
      continue;
    }
    const close = text.trim();
    if (close.length >= fence.length && close === fence[0].repeat(close.length)) fence = null;
    lines.push({ text, inFence: true });
  }
  return lines;
}

/** Blanks out inline code spans so a label inside backticks is never matched. */
function withoutInlineCode(line: string): string {
  return line.replace(/(`+)[^`]*?\1/g, (span) => " ".repeat(span.length));
}

function labelsInLine(line: string): string[] {
  return Array.from(withoutInlineCode(line).matchAll(itemLabelPattern()), (match) => match[1]);
}

/** The distinct labels in `markdown`, in order of definition, skipping code. */
export function itemLabelsIn(markdown: string): string[] {
  const lines = scanLines(markdown);
  const seen = new Set<string>();
  for (const line of lines) {
    if (line.inFence) continue;
    for (const label of labelsInLine(line.text)) seen.add(label);
  }
  if (seen.size < 2) return [...seen];
  // Stable sort: labels defined on the same line keep their written order.
  const definedAt = new Map([...seen].map((label) => [label, definitionLineIndex(lines, label)]));
  return [...seen].sort((a, b) => (definedAt.get(a) ?? 0) - (definedAt.get(b) ?? 0));
}

const STRIKETHROUGH_RE = /~~(?=\S)(.*?\S)~~/g;

function struckLabelsInLine(line: string): string[] {
  return Array.from(withoutInlineCode(line).matchAll(STRIKETHROUGH_RE), (span) =>
    labelsInLine(span[1]),
  ).flat();
}

/** The distinct labels `markdown` mentions inside strikethrough, skipping code. */
export function struckItemLabelsIn(markdown: string): string[] {
  const seen = new Set<string>();
  for (const line of scanLines(markdown)) {
    if (line.inFence) continue;
    for (const label of struckLabelsInLine(line.text)) seen.add(label);
  }
  return [...seen];
}

const SENTENCE_BREAK_RE = /(?<=[.!?])\s+(?=\S)/;
const LEADING_MARKER_RE = /^\s*(?:[-*+]\s+|\d{1,9}[.)]\s+|#{1,6}\s+|>\s*)*/;

/** Whether `line` starts with `label`, after list, heading, and emphasis markers. */
function startsWithLabel(line: string, label: string): boolean {
  const rest = line.replace(LEADING_MARKER_RE, "").replace(/^(?:\*\*|__|\*|_|~~)+/, "");
  return labelsInLine(rest).includes(label) && rest.startsWith(`[${label}]`);
}

/**
 * Index of the line that defines `label`: the first line the label starts,
 * since an item can be mentioned in passing before its own entry; otherwise
 * the first line that mentions it. -1 when absent.
 */
function definitionLineIndex(lines: ScannedLine[], label: string): number {
  const leading = lines.findIndex((line) => !line.inFence && startsWithLabel(line.text, label));
  if (leading >= 0) return leading;
  return lines.findIndex((line) => !line.inFence && labelsInLine(line.text).includes(label));
}

/**
 * The sentence in `markdown` that mentions `label`, preferring a struck
 * mention: the line that closed an item says how it was resolved.
 */
export function extractLabelSentence(markdown: string, label: string): string | null {
  const lines = scanLines(markdown).filter((line) => !line.inFence);
  const line =
    lines.find((candidate) => struckLabelsInLine(candidate.text).includes(label)) ??
    lines.find((candidate) => labelsInLine(candidate.text).includes(label));
  if (!line) return null;
  const text = line.text.replace(LEADING_MARKER_RE, "").trim();
  const sentences = text.split(SENTENCE_BREAK_RE);
  return sentences.find((sentence) => labelsInLine(sentence).includes(label)) ?? text;
}

const LEADING_BOLD_RE = /^(\*\*|__)(?!\s*\1)(.+?)\1/;
const plainText = (text: string) => text.replace(/\*\*|__|~~|`/g, "").trim();

/**
 * An item's short title and the text after it on its block's first line, both
 * without markup: the leading bold span if there is one, else the first sentence.
 */
export function itemLabelTitleParts(
  markdown: string,
  label: string,
): { title: string; rest: string } {
  const block = extractItemBlock(markdown, label) ?? "";
  const first = block.split("\n").find((line) => line.trim() !== "") ?? "";
  const line = first
    .replace(LEADING_MARKER_RE, "")
    .replace(itemLabelPattern(), (match, found: string) => (found === label ? "" : match))
    .replace(/^[\s:.\-–—]+/, "");
  const bold = line.match(LEADING_BOLD_RE);
  if (bold) {
    const title = plainText(bold[2]).replace(/^[\s:.\-–—]+|:$/g, "");
    if (title) return { title, rest: plainText(line.slice(bold[0].length)) };
  }
  const [title = "", ...rest] = plainText(line).split(SENTENCE_BREAK_RE);
  return { title, rest: rest.join(" ") };
}

/** A short plain-text title for an item; see `itemLabelTitleParts`. */
export function itemLabelTitle(markdown: string, label: string): string {
  return itemLabelTitleParts(markdown, label).title;
}

const LIST_ITEM_RE = /^(\s*)(?:[-*+]|\d{1,9}[.)])\s+/;
const HEADING_RE = /^ {0,3}(#{1,6})\s/;
const TABLE_SEPARATOR_RE = /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/;

const isBlank = (line: ScannedLine | undefined) => line !== undefined && line.text.trim() === "";
const indentOf = (text: string) => text.length - text.trimStart().length;

function headingLevel(line: ScannedLine): number | null {
  if (line.inFence) return null;
  const match = line.text.match(HEADING_RE);
  return match ? match[1].length : null;
}

function listItemIndent(line: ScannedLine): number | null {
  if (line.inFence) return null;
  const match = line.text.match(LIST_ITEM_RE);
  return match ? match[1].length : null;
}

/** First line index past the list that starts at `start`. */
function endOfList(lines: ScannedLine[], start: number, indent: number): number {
  let end = start + 1;
  while (end < lines.length) {
    const line = lines[end];
    if (isBlank(line)) {
      let next = end + 1;
      while (isBlank(lines[next])) next += 1;
      const following = lines[next];
      if (!following) break;
      const nested = following.inFence || indentOf(following.text) > indent;
      if (!nested && listItemIndent(following) !== indent) break;
      end = next;
      continue;
    }
    if (headingLevel(line) !== null) break;
    end += 1;
  }
  return end;
}

/** First line index past the list item that starts at `start`. */
function endOfListItem(lines: ScannedLine[], start: number, indent: number): number {
  let end = start + 1;
  while (end < lines.length) {
    const line = lines[end];
    if (isBlank(line)) {
      let next = end + 1;
      while (isBlank(lines[next])) next += 1;
      const following = lines[next];
      if (!following || (!following.inFence && indentOf(following.text) <= indent)) break;
      end = next;
      continue;
    }
    if (line.inFence) {
      end += 1;
      continue;
    }
    const itemIndent = listItemIndent(line);
    if (itemIndent !== null && itemIndent <= indent) break;
    if (headingLevel(line) !== null) break;
    end += 1;
  }
  return end;
}

function dedent(texts: string[], amount: number): string[] {
  return texts.map((text) => (indentOf(text) >= amount ? text.slice(amount) : text.trimStart()));
}

/**
 * The markdown block where `label` is first defined in `markdown`: its list
 * item (with nested content), heading section, table row (with the header), or
 * paragraph (with a list it introduces). Returns null when the label is absent.
 */
export function extractItemBlock(markdown: string, label: string): string | null {
  const lines = scanLines(markdown);
  const at = definitionLineIndex(lines, label);
  if (at < 0) return null;
  const slice = (start: number, end: number) => lines.slice(start, end).map((line) => line.text);
  const finish = (texts: string[]) => texts.join("\n").trim();

  const level = headingLevel(lines[at]);
  if (level !== null) {
    let end = at + 1;
    while (end < lines.length) {
      const nextLevel = headingLevel(lines[end]);
      if (nextLevel !== null && nextLevel <= level) break;
      end += 1;
    }
    return finish(slice(at, end));
  }

  // The innermost list item holding the label: walk up its paragraph lines.
  let itemStart = at;
  while (
    itemStart >= 0 &&
    !isBlank(lines[itemStart]) &&
    headingLevel(lines[itemStart]) === null &&
    listItemIndent(lines[itemStart]) === null
  ) {
    itemStart -= 1;
  }
  if (itemStart >= 0) {
    const marker = lines[itemStart].inFence ? null : lines[itemStart].text.match(LIST_ITEM_RE);
    if (marker) {
      // Drop the item's own marker so it previews as a standalone block.
      const [first, ...rest] = slice(itemStart, endOfListItem(lines, itemStart, marker[1].length));
      return finish([first.slice(marker[0].length), ...dedent(rest, marker[0].length)]);
    }
  }

  let start = at;
  while (start > 0 && !isBlank(lines[start - 1]) && !lines[start - 1].inFence) start -= 1;
  let end = at + 1;
  while (end < lines.length && !isBlank(lines[end]) && !lines[end].inFence) end += 1;

  if (lines[at].text.includes("|") && TABLE_SEPARATOR_RE.test(lines[start + 1]?.text ?? "")) {
    return at <= start + 1
      ? finish(slice(start, end))
      : finish([...slice(start, start + 2), lines[at].text]);
  }

  // A paragraph ending in ":" introduces the list that follows it.
  if (lines[end - 1].text.trimEnd().endsWith(":")) {
    let next = end;
    while (isBlank(lines[next])) next += 1;
    const indent = lines[next] ? listItemIndent(lines[next]) : null;
    if (indent !== null)
      return finish([...slice(start, end), "", ...slice(next, endOfList(lines, next, indent))]);
  }
  return finish(slice(start, end));
}

interface MdastNode {
  type: string;
  value?: string;
  url?: string;
  children?: MdastNode[];
}

// Text under these nodes is already a link, code, or raw markup.
const NON_LABEL_PARENTS = new Set([
  "link",
  "linkReference",
  "definition",
  "inlineCode",
  "code",
  "html",
]);

function splitLabelText(node: MdastNode): MdastNode[] {
  const text = node.value ?? "";
  const parts: MdastNode[] = [];
  let last = 0;
  for (const match of text.matchAll(itemLabelPattern())) {
    const index = match.index ?? 0;
    if (index > last) parts.push({ type: "text", value: text.slice(last, index) });
    parts.push({
      type: "link",
      url: `${ITEM_LABEL_HREF_PREFIX}${match[1]}`,
      children: [{ type: "text", value: match[0] }],
    });
    last = index + match[0].length;
  }
  if (parts.length === 0) return [node];
  if (last < text.length) parts.push({ type: "text", value: text.slice(last) });
  return parts;
}

function linkifyItemLabels(node: MdastNode): void {
  if (!node.children || NON_LABEL_PARENTS.has(node.type)) return;
  node.children = node.children.flatMap((child) => {
    if (child.type === "text") return splitLabelText(child);
    linkifyItemLabels(child);
    return [child];
  });
}

/** Remark plugin turning each item label into a link the chat renderer draws as a chip. */
export function remarkItemLabels() {
  return (tree: MdastNode) => linkifyItemLabels(tree);
}
