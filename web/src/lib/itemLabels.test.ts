import { describe, expect, it } from "vitest";
import {
  ITEM_LABEL_HREF_PREFIX,
  buildItemLabelIndex,
  extractItemBlock,
  extractLabelSentence,
  itemLabelTitle,
  itemLabelTitleParts,
  itemLabelsIn,
  remarkItemLabels,
  struckItemLabelsIn,
  type ItemLabelSource,
} from "./itemLabels";

describe("itemLabelsIn", () => {
  it("finds distinct labels in order and ignores code, links, and non-label brackets", () => {
    const markdown = [
      "**[Q2] Cache scope.** Also see [Q1] and [Q2].",
      "- [x] done, footnote [1], [note], [A1](https://example.com)",
      "Inline `[Q9]` is code.",
      "```",
      "[Q8] inside a fence",
      "```",
      "Then [R10].",
    ].join("\n");
    expect(itemLabelsIn(markdown)).toEqual(["Q2", "Q1", "R10"]);
  });
});

describe("extractItemBlock", () => {
  it("returns the list item holding the label with its nested content, unmarked", () => {
    const markdown = [
      "Open questions:",
      "",
      "1. [Q1] First thing.",
      "2. [Q2] Should the cache be per-user?",
      "   It changes eviction.",
      "   - option a",
      "   - option b",
      "",
      "   ```ts",
      "   const x = 1;",
      "   ```",
      "3. [Q3] Third.",
    ].join("\n");
    expect(extractItemBlock(markdown, "Q2")).toBe(
      [
        "[Q2] Should the cache be per-user?",
        "It changes eviction.",
        "- option a",
        "- option b",
        "",
        "```ts",
        "const x = 1;",
        "```",
      ].join("\n"),
    );
  });

  it("returns a nested list item on its own", () => {
    const markdown = ["- Parent", "  - [R1] Child detail", "  - Sibling"].join("\n");
    expect(extractItemBlock(markdown, "R1")).toBe("[R1] Child detail");
  });

  it("returns a heading's section up to the next heading of the same level", () => {
    const markdown = [
      "## [Q4] Migration order",
      "Run A before B.",
      "### Details",
      "More.",
      "## Next",
      "Unrelated.",
    ].join("\n");
    expect(extractItemBlock(markdown, "Q4")).toBe(
      ["## [Q4] Migration order", "Run A before B.", "### Details", "More."].join("\n"),
    );
  });

  it("returns a table row with the table header", () => {
    const markdown = [
      "| Id | Finding |",
      "| --- | --- |",
      "| [F1] | Slow query |",
      "| [F2] | Leaky cache |",
    ].join("\n");
    expect(extractItemBlock(markdown, "F2")).toBe(
      ["| Id | Finding |", "| --- | --- |", "| [F2] | Leaky cache |"].join("\n"),
    );
  });

  it("returns a paragraph, including a list it introduces", () => {
    const markdown = [
      "Intro.",
      "",
      "[Q5] Pick a retry policy. Options:",
      "",
      "- exponential",
      "- fixed",
      "",
      "Unrelated paragraph.",
    ].join("\n");
    expect(extractItemBlock(markdown, "Q5")).toBe(
      ["[Q5] Pick a retry policy. Options:", "", "- exponential", "- fixed"].join("\n"),
    );
  });

  it("prefers the item a label starts over an earlier passing mention", () => {
    const markdown = [
      "**[Q1] Why k3s?** The goal changes how much tooling you adopt in [Q7].",
      "",
      "**[Q7] Which tooling?** Manifests, Kustomize, or Helm.",
    ].join("\n");
    expect(extractItemBlock(markdown, "Q7")).toBe(
      "**[Q7] Which tooling?** Manifests, Kustomize, or Helm.",
    );
    expect(itemLabelsIn(markdown)).toEqual(["Q1", "Q7"]);
    expect(itemLabelTitle(markdown, "Q7")).toBe("Which tooling?");
  });

  it("returns null when the label only appears in code", () => {
    expect(extractItemBlock("`[Q1]`\n```\n[Q1]\n```", "Q1")).toBeNull();
  });
});

function message(messageId: string, text: string): ItemLabelSource {
  return { messageId, role: "assistant", text };
}

function scan(source: ItemLabelSource) {
  return {
    source,
    labels: itemLabelsIn(source.text),
    struck: struckItemLabelsIn(source.text),
  };
}

describe("buildItemLabelIndex", () => {
  it("defines each label at its first message and counts later mentions", () => {
    const first = message("m1", "[Q1] [Q2]");
    const second = message("m2", "[Q2] [Q3]");
    const index = buildItemLabelIndex([scan(first), scan(second)]);
    expect(index.items.get("Q2")).toMatchObject({ source: first, messageCount: 2 });
    expect(index.items.get("Q3")).toMatchObject({ source: second, messageCount: 1 });
    expect([...index.items.keys()]).toEqual(["Q1", "Q2", "Q3"]);
  });

  it("closes an item on a struck mention and reopens it on a later plain one", () => {
    const defining = message("m1", "[Q1] Pick a cache. [Q2] Pick a queue.");
    const closing = message("m2", "~~[Q1]~~ settled: per-user cache.");
    const closed = buildItemLabelIndex([scan(defining), scan(closing)]);
    expect(closed.items.get("Q1")?.closedBy).toBe(closing);
    expect(closed.items.get("Q2")?.closedBy).toBeNull();

    const reopened = buildItemLabelIndex([
      scan(defining),
      scan(closing),
      scan(message("m3", "Reopening [Q1]: per-user eviction is too costly.")),
    ]);
    expect(reopened.items.get("Q1")?.closedBy).toBeNull();
  });

  it("stays disabled until labels recur or one message tags several items", () => {
    const lone = buildItemLabelIndex([scan(message("m1", "Paper size [A4] only."))]);
    expect(lone.enabled).toBe(false);
    expect(lone.items.size).toBe(1);

    const recurring = buildItemLabelIndex([
      scan(message("m1", "[Q1] One question.")),
      scan(message("m2", "Still waiting on [Q1].")),
    ]);
    expect(recurring.enabled).toBe(true);

    const several = buildItemLabelIndex([scan(message("m1", "[Q1] One. [Q2] Two."))]);
    expect(several.enabled).toBe(true);
  });
});

describe("struckItemLabelsIn", () => {
  it("finds labels inside strikethrough spans, outside code", () => {
    const markdown = [
      "- ~~[Q1]~~ done, ~~[Q2] dropped~~, [Q3] still open",
      "`~~[Q4]~~`",
      "```",
      "~~[Q5]~~",
      "```",
    ].join("\n");
    expect(struckItemLabelsIn(markdown)).toEqual(["Q1", "Q2"]);
  });
});

describe("extractLabelSentence", () => {
  it("returns the sentence with the struck mention, without its list marker", () => {
    const markdown = [
      "Status: [Q2] came up again earlier.",
      "",
      "- Batching is done. ~~[Q2]~~ copied as-is to keep audit history. Moving on.",
    ].join("\n");
    expect(extractLabelSentence(markdown, "Q2")).toBe(
      "~~[Q2]~~ copied as-is to keep audit history.",
    );
  });

  it("falls back to a plain mention and returns null when absent", () => {
    expect(extractLabelSentence("Done with [Q3]. Next.", "Q3")).toBe("Done with [Q3].");
    expect(extractLabelSentence("Nothing here.", "Q3")).toBeNull();
  });
});

describe("itemLabelTitle", () => {
  it("takes the item's leading bold span, inside or after the label", () => {
    const markdown = "1. **[Q2] Soft-deleted rows.** 3,112 rows still reference `accounts`.";
    expect(itemLabelTitle(markdown, "Q2")).toBe("Soft-deleted rows.");
    expect(itemLabelTitle("- [Q2] **Docker socket access?** Mount it read-only.", "Q2")).toBe(
      "Docker socket access?",
    );
    expect(itemLabelTitle("[N1] **Note:** keep [Q2] open.", "N1")).toBe("Note");
  });

  it("falls back to the first sentence without the label or markup", () => {
    expect(itemLabelTitle("[R1]: the cascade reaches `events`. It also locks.", "R1")).toBe(
      "the cascade reaches events.",
    );
    expect(itemLabelTitle("[R2] A **partial** bold. Then more.", "R2")).toBe("A partial bold.");
    expect(itemLabelTitle("[R3] ** ** No title here", "R3")).toBe("No title here");
  });
});

describe("itemLabelTitleParts", () => {
  it("returns the first line's text after the title as the rest", () => {
    expect(itemLabelTitleParts("[Q2] **Docker socket?** Mount it. Or not.", "Q2")).toEqual({
      title: "Docker socket?",
      rest: "Mount it. Or not.",
    });
    expect(itemLabelTitleParts("[R1] Cascade reaches events. It also locks.", "R1")).toEqual({
      title: "Cascade reaches events.",
      rest: "It also locks.",
    });
    expect(itemLabelTitleParts("Nothing labelled here.", "Q9")).toEqual({ title: "", rest: "" });
  });
});

describe("remarkItemLabels", () => {
  it("splits labels in text into links and leaves links and code alone", () => {
    const tree = {
      type: "root",
      children: [
        {
          type: "paragraph",
          children: [
            { type: "text", value: "See [Q1] and [R2]." },
            { type: "inlineCode", value: "[Q3]" },
            { type: "link", url: "https://x", children: [{ type: "text", value: "[Q4]" }] },
          ],
        },
      ],
    };
    remarkItemLabels()(tree);
    expect(tree.children[0].children).toEqual([
      { type: "text", value: "See " },
      {
        type: "link",
        url: `${ITEM_LABEL_HREF_PREFIX}Q1`,
        children: [{ type: "text", value: "[Q1]" }],
      },
      { type: "text", value: " and " },
      {
        type: "link",
        url: `${ITEM_LABEL_HREF_PREFIX}R2`,
        children: [{ type: "text", value: "[R2]" }],
      },
      { type: "text", value: "." },
      { type: "inlineCode", value: "[Q3]" },
      { type: "link", url: "https://x", children: [{ type: "text", value: "[Q4]" }] },
    ]);
  });
});
