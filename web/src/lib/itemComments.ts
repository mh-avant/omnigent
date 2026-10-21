// Item comments: the user's comments on labelled items (`[Q2]`), sent to the
// agent together as one plain-markdown user message and read back out of the
// transcript to rebuild each item's comment thread. The message is ordinary
// text, so every harness receives the same thing:
//
//   Comments on 2 items:
//
//   #### [Q2] Report cutoff timezone
//
//   **1.** Use the account's zone.
//
//   **2.** Store the zone on each report row too.
//
//   Attachments: q2-cutoff-examples.csv
//
//   #### General
//
//   Q2 blocks the export PR.
//
// One section per item, in the order the items were defined; numbered
// paragraphs only when an item has several comments; an `Attachments:` line
// naming the files sent with that comment; an optional `#### General` section
// for a message typed alongside.

import {
  itemLabelsIn,
  itemLabelTitle,
  scanLines,
  struckItemLabelsIn,
  type ItemCommentPart,
  type ItemCommentSection,
  type ItemLabelScan,
  type ItemLabelSource,
} from "./itemLabels";

/** One comment to send: its text and the (already unique) names of its files. */
export interface ItemCommentBody {
  text: string;
  attachments: readonly string[];
}

/** One item's comments, in the order they were written. */
export interface ItemCommentGroup {
  label: string;
  /** Heading title: from the label index, or the copy saved with the draft. */
  title: string;
  comments: readonly ItemCommentBody[];
}

/** A comment message read back from the transcript. */
export interface ParsedItemCommentMessage {
  /** The count the lead line states, when it is present. */
  itemCount: number | null;
  sections: readonly ItemCommentSection[];
  /** The `#### General` note for the whole message, if any. */
  general: ItemCommentBody | null;
}

const TITLE_MAX_LENGTH = 80;
const LABEL_TOKEN_RE = /\[([A-Z]{1,3}\d{1,3})\]/g;
const SECTION_RE = /^#### \[([A-Z]{1,3}\d{1,3})\](?:[ \t]+(.*?))?[ \t]*$/;
const GENERAL_RE = /^#### General[ \t]*$/;
const ANY_HEADING_RE = /^ {0,3}(#{1,6})[ \t]+(.*?)[ \t#]*$/;
const SECTION_END_RE = /^ {0,3}#{1,4}[ \t]/;
const LEAD_RE = /^Comments on (\d+) items?:[ \t]*$/;
const NUMBER_RE = /^\*\*(\d+)\.\*\*(?:[ \t]+|$)/;
const ATTACHMENTS_RE = /^Attachments:[ \t]*(.*)$/;
// A first line that starts its own block can't share a line with `**N.**`.
const BLOCK_START_RE = /^(?: {4}|\t| {0,3}(?:[-*+]\s|\d{1,9}[.)]\s|>|`{3}|~{3}|\||<))/;

/**
 * The heading title for an item: its short title without other items'
 * brackets (a heading must not mention them), cut at 80 characters.
 */
export function itemCommentTitle(markdown: string, label: string): string {
  const plain = itemLabelTitle(markdown, label)
    .replace(LABEL_TOKEN_RE, "$1")
    .replace(/\s+/g, " ")
    .replace(/[.:;,]+$/, "")
    .trim();
  return plain.length > TITLE_MAX_LENGTH
    ? `${plain.slice(0, TITLE_MAX_LENGTH - 1).trimEnd()}…`
    : plain;
}

/**
 * Keeps a comment from breaking the message's structure: headings become bold
 * text, and lines that would read as a comment number or an attachments line
 * are escaped. Code fences are left as written.
 */
function sanitizeCommentText(text: string): string {
  const lines = scanLines(text.replace(/\r\n?/g, "\n")).map(({ text: line, inFence }) => {
    if (inFence) return line;
    const heading = line.match(ANY_HEADING_RE);
    if (heading) return heading[2] ? `**${heading[2]}**` : "";
    return line.replace(/^(\*\*\d+)\.(\*\*)/, "$1\\.$2").replace(/^Attachments:/, "Attachments\\:");
  });
  return lines
    .join("\n")
    .replace(/^\s*\n/, "")
    .trimEnd();
}

function commentBlock(comment: ItemCommentBody, number: number | null): string {
  let body = sanitizeCommentText(comment.text);
  if (number !== null) {
    const marker = `**${number}.**`;
    body =
      body === ""
        ? marker
        : BLOCK_START_RE.test(body)
          ? `${marker}\n\n${body}`
          : `${marker} ${body}`;
  }
  const attachments =
    comment.attachments.length > 0 ? `Attachments: ${comment.attachments.join(", ")}` : "";
  return [body, attachments].filter((part) => part !== "").join("\n\n");
}

/** The message that sends `groups` (already in item order) and an optional general note. */
export function buildItemCommentMessage(
  groups: readonly ItemCommentGroup[],
  general: ItemCommentBody | null = null,
): string {
  const sections = groups.filter((group) => group.comments.length > 0);
  const parts = [`Comments on ${sections.length} ${sections.length === 1 ? "item" : "items"}:`];
  for (const { label, title, comments } of sections) {
    const heading = title.replace(LABEL_TOKEN_RE, "$1").replace(/\s+/g, " ").trim();
    parts.push(heading ? `#### [${label}] ${heading}` : `#### [${label}]`);
    const numbered = comments.length > 1;
    comments.forEach((comment, index) => {
      const block = commentBlock(comment, numbered ? index + 1 : null);
      if (block) parts.push(block);
    });
  }
  if (general && (general.text.trim() !== "" || general.attachments.length > 0)) {
    parts.push("#### General");
    const block = commentBlock(general, null);
    if (block) parts.push(block);
  }
  return parts.join("\n\n");
}

// Names browsers give pasted or unnamed images.
const GENERIC_FILENAME_RE = /^(?:image|blob|unknown|pasted[ _-]?image)?(\.[A-Za-z0-9]+)?$/i;

function extensionOf(filename: string): string {
  const dot = filename.lastIndexOf(".");
  return dot > 0 ? filename.slice(dot) : "";
}

/**
 * Names for each group's files that are unique within one message, so every
 * comment can list its files by name. A pasted `image.png` on Q2 becomes
 * `q2-1.png`; a repeated name gets a `-2` suffix. Commas are replaced, since
 * the `Attachments:` line is comma-separated.
 *
 * @param groups - Each comment's prefix (its label, or `general`) and file names.
 * @returns The new names, in the same shape.
 */
export function uniqueItemCommentFilenames(
  groups: readonly { prefix: string; names: readonly string[] }[],
): string[][] {
  const used = new Set<string>();
  const counters = new Map<string, number>();
  const claim = (name: string) => {
    const extension = extensionOf(name);
    const stem = extension ? name.slice(0, -extension.length) : name;
    let candidate = name;
    for (let suffix = 2; used.has(candidate.toLowerCase()); suffix += 1) {
      candidate = `${stem}-${suffix}${extension}`;
    }
    used.add(candidate.toLowerCase());
    return candidate;
  };
  return groups.map(({ prefix, names }) =>
    names.map((raw) => {
      const name = raw.replace(/[,\n\r]+/g, "_").trim();
      if (!GENERIC_FILENAME_RE.test(name)) return claim(name);
      const base = prefix.toLowerCase();
      const count = (counters.get(base) ?? 0) + 1;
      counters.set(base, count);
      return claim(`${base}-${count}${extensionOf(name) || ".png"}`);
    }),
  );
}

/** Orders drafts by where their items were defined; unknown items keep their order, last. */
export function orderByItemDefinition<T extends { label: string }>(
  drafts: readonly T[],
  labelOrder: readonly string[],
): T[] {
  const rank = new Map(labelOrder.map((label, index) => [label, index]));
  return drafts
    .map((draft, index) => ({ draft, index }))
    .sort(
      (a, b) =>
        (rank.get(a.draft.label) ?? labelOrder.length) -
          (rank.get(b.draft.label) ?? labelOrder.length) || a.index - b.index,
    )
    .map(({ draft }) => draft);
}

function trimBlankLines(lines: string[]): string[] {
  let start = 0;
  let end = lines.length;
  while (start < end && lines[start].trim() === "") start += 1;
  while (end > start && lines[end - 1].trim() === "") end -= 1;
  return lines.slice(start, end);
}

function readComment(lines: string[], fenced: boolean[]): ItemCommentBody {
  const body = [...lines];
  let attachments: string[] = [];
  for (let at = body.length - 1; at >= 0; at -= 1) {
    if (body[at].trim() === "") continue;
    const match = fenced[at] ? null : body[at].match(ATTACHMENTS_RE);
    if (match) {
      attachments = match[1]
        .split(/,\s*/)
        .map((name) => name.trim())
        .filter((name) => name !== "");
      body.splice(at, 1);
    }
    break;
  }
  return { text: trimBlankLines(body).join("\n"), attachments };
}

function readSection(lines: { text: string; inFence: boolean }[]): ItemCommentPart[] {
  const parts: ItemCommentPart[] = [];
  let current: { number: number | null; lines: string[]; fenced: boolean[] } = {
    number: null,
    lines: [],
    fenced: [],
  };
  const flush = () => {
    const comment = readComment(current.lines, current.fenced);
    if (comment.text !== "" || comment.attachments.length > 0 || current.number !== null) {
      parts.push({ number: current.number, ...comment });
    }
  };
  lines.forEach((line, index) => {
    const paragraphStart = index === 0 || lines[index - 1].text.trim() === "";
    const numbered = !line.inFence && paragraphStart ? line.text.match(NUMBER_RE) : null;
    if (numbered) {
      flush();
      current = {
        number: Number(numbered[1]),
        lines: [line.text.slice(numbered[0].length)],
        fenced: [false],
      };
      return;
    }
    current.lines.push(line.text);
    current.fenced.push(line.inFence);
  });
  flush();
  return parts;
}

/**
 * Reads a comment message back into its sections, skipping code fences. A
 * section runs from `#### [LABEL] <title>` to the next heading or the end;
 * `**N.**` paragraphs split it into comments. Returns null for a message
 * without comment sections.
 */
export function parseItemCommentMessage(markdown: string): ParsedItemCommentMessage | null {
  const lines = scanLines(markdown);
  let itemCount: number | null = null;
  const sections: ItemCommentSection[] = [];
  let general: ItemCommentBody | null = null;
  let open: { label: string | null; title: string; start: number } | null = null;
  const close = (end: number) => {
    if (open === null) return;
    const body = lines.slice(open.start, end);
    if (open.label === null) {
      general = readComment(
        body.map((line) => line.text),
        body.map((line) => line.inFence),
      );
    } else {
      sections.push({ label: open.label, title: open.title, comments: readSection(body) });
    }
    open = null;
  };
  lines.forEach((line, index) => {
    if (line.inFence) return;
    const section = line.text.match(SECTION_RE);
    if (section) {
      close(index);
      open = { label: section[1], title: section[2] ?? "", start: index + 1 };
      return;
    }
    if (GENERAL_RE.test(line.text)) {
      close(index);
      open = { label: null, title: "", start: index + 1 };
      return;
    }
    if (SECTION_END_RE.test(line.text)) {
      close(index);
      return;
    }
    if (open === null && sections.length === 0 && itemCount === null) {
      const lead = line.text.match(LEAD_RE);
      if (lead) itemCount = Number(lead[1]);
    }
  });
  close(lines.length);
  if (sections.length === 0) return null;
  return { itemCount, sections, general };
}

/** What a queued comment message holds, for its one-line summary. */
export function summarizeItemCommentMessage(
  markdown: string,
): { commentCount: number; labels: string[] } | null {
  const parsed = parseItemCommentMessage(markdown);
  if (parsed === null) return null;
  const labels = [...new Set(parsed.sections.map((section) => section.label))];
  const commentCount = parsed.sections.reduce(
    (total, section) => total + section.comments.length,
    0,
  );
  return { commentCount, labels };
}

/** What `source` says about labels, including any comment sections it sends. */
export function scanItemLabelSource(source: ItemLabelSource): ItemLabelScan {
  const labels = itemLabelsIn(source.text);
  if (labels.length === 0) return { source, labels, struck: [] };
  const struck = struckItemLabelsIn(source.text);
  const parsed = source.role === "user" ? parseItemCommentMessage(source.text) : null;
  if (parsed === null) return { source, labels, struck };
  // A label mentioned only in comment headings leaves the item open or closed.
  const withoutHeadings = scanLines(source.text)
    .filter((line) => line.inFence || !SECTION_RE.test(line.text))
    .map((line) => line.text)
    .join("\n");
  const mentionedElsewhere = new Set(itemLabelsIn(withoutHeadings));
  return {
    source,
    labels,
    struck,
    comments: parsed.sections,
    commentHeadingOnly: labels.filter((label) => !mentionedElsewhere.has(label)),
  };
}
