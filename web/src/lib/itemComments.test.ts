import { describe, expect, it } from "vitest";
import {
  buildItemCommentMessage,
  itemCommentTitle,
  orderByItemDefinition,
  parseItemCommentMessage,
  scanItemLabelSource,
  summarizeItemCommentMessage,
  uniqueItemCommentFilenames,
} from "./itemComments";

const REVIEW = buildItemCommentMessage(
  [
    {
      label: "Q2",
      title: "Report cutoff timezone",
      comments: [
        { text: "Use the account's zone.\n\nFinance closes in local time.", attachments: [] },
        {
          text: "Store the zone on each report row too.",
          attachments: ["q2-cutoff-examples.csv"],
        },
      ],
    },
    {
      label: "R1",
      title: "Backfill locking",
      comments: [{ text: "Batch it at 5,000 rows.", attachments: ["r1-lock-wait.png"] }],
    },
  ],
  { text: "Q2 blocks the export PR.", attachments: [] },
);

describe("buildItemCommentMessage", () => {
  it("writes one section per item, numbering several comments, then the general note", () => {
    expect(REVIEW).toBe(
      [
        "Comments on 2 items:",
        "#### [Q2] Report cutoff timezone",
        "**1.** Use the account's zone.\n\nFinance closes in local time.",
        "**2.** Store the zone on each report row too.",
        "Attachments: q2-cutoff-examples.csv",
        "#### [R1] Backfill locking",
        "Batch it at 5,000 rows.",
        "Attachments: r1-lock-wait.png",
        "#### General",
        "Q2 blocks the export PR.",
      ].join("\n\n"),
    );
  });

  it("demotes headings, escapes structure lookalikes, and keeps code fences as written", () => {
    const message = buildItemCommentMessage([
      {
        label: "Q1",
        title: "Cache",
        comments: [
          {
            text: [
              "#### [Q9] Not a section",
              "**3.** not a number",
              "Attachments: not files",
              "```md",
              "#### [Q8] inside a fence",
              "```",
            ].join("\n"),
            attachments: [],
          },
        ],
      },
    ]);
    expect(message).toContain("**[Q9] Not a section**");
    expect(message).toContain("**3\\.** not a number");
    expect(message).toContain("Attachments\\: not files");
    expect(message).toContain("```md\n#### [Q8] inside a fence\n```");

    const parsed = parseItemCommentMessage(message);
    expect(parsed?.sections.map((section) => section.label)).toEqual(["Q1"]);
    expect(parsed?.sections[0].comments).toHaveLength(1);
    expect(parsed?.sections[0].comments[0].attachments).toEqual([]);
  });

  it("puts a number on its own line before a comment that starts with a block", () => {
    const message = buildItemCommentMessage([
      {
        label: "Q1",
        title: "",
        comments: [
          { text: "- first\n- second", attachments: [] },
          { text: "Plain.", attachments: [] },
        ],
      },
    ]);
    expect(message).toBe(
      "Comments on 1 item:\n\n#### [Q1]\n\n**1.**\n\n- first\n- second\n\n**2.** Plain.",
    );
    expect(parseItemCommentMessage(message)?.sections[0].comments).toEqual([
      { number: 1, text: "- first\n- second", attachments: [] },
      { number: 2, text: "Plain.", attachments: [] },
    ]);
  });

  it("keeps other items' brackets out of a heading", () => {
    const message = buildItemCommentMessage([
      { label: "Q1", title: "Follow-up to [R2]", comments: [{ text: "Yes.", attachments: [] }] },
    ]);
    expect(message).toContain("#### [Q1] Follow-up to R2");
  });
});

describe("parseItemCommentMessage", () => {
  it("round-trips the serializer's output", () => {
    expect(parseItemCommentMessage(REVIEW)).toEqual({
      itemCount: 2,
      sections: [
        {
          label: "Q2",
          title: "Report cutoff timezone",
          comments: [
            {
              number: 1,
              text: "Use the account's zone.\n\nFinance closes in local time.",
              attachments: [],
            },
            {
              number: 2,
              text: "Store the zone on each report row too.",
              attachments: ["q2-cutoff-examples.csv"],
            },
          ],
        },
        {
          label: "R1",
          title: "Backfill locking",
          comments: [
            { number: null, text: "Batch it at 5,000 rows.", attachments: ["r1-lock-wait.png"] },
          ],
        },
      ],
      general: { text: "Q2 blocks the export PR.", attachments: [] },
    });
  });

  it("reads a hand-written shape without the lead line and ignores fenced headings", () => {
    const parsed = parseItemCommentMessage(
      ["```", "#### [Q1] fenced", "```", "#### [Q3] Index naming", "Keep ours."].join("\n"),
    );
    expect(parsed).toEqual({
      itemCount: null,
      sections: [
        {
          label: "Q3",
          title: "Index naming",
          comments: [{ number: null, text: "Keep ours.", attachments: [] }],
        },
      ],
      general: null,
    });
  });

  it("returns null for a message without comment sections", () => {
    expect(parseItemCommentMessage("Thanks, [Q2] is settled.")).toBeNull();
    expect(parseItemCommentMessage("#### General\n\nJust a note.")).toBeNull();
  });
});

describe("uniqueItemCommentFilenames", () => {
  it("renames pasted images by label and keeps every name unique in the message", () => {
    expect(
      uniqueItemCommentFilenames([
        { prefix: "Q2", names: ["image.png", "notes.csv", "image.png"] },
        { prefix: "R1", names: ["notes.csv", "a,b.txt"] },
        { prefix: "general", names: ["image.jpg"] },
      ]),
    ).toEqual([
      ["q2-1.png", "notes.csv", "q2-2.png"],
      ["notes-2.csv", "a_b.txt"],
      ["general-1.jpg"],
    ]);
  });
});

describe("orderByItemDefinition", () => {
  it("sorts by where the item was defined and keeps unknown items last, in order", () => {
    const drafts = [
      { label: "R1", id: 1 },
      { label: "X9", id: 2 },
      { label: "Q2", id: 3 },
      { label: "R1", id: 4 },
    ];
    expect(orderByItemDefinition(drafts, ["Q2", "R1"]).map((draft) => draft.id)).toEqual([
      3, 1, 4, 2,
    ]);
  });
});

describe("itemCommentTitle", () => {
  it("takes the item's short title and cuts it at 80 characters", () => {
    const markdown = "1. **[Q2] Report cutoff timezone.** Should cutoffs use UTC? See [R1].";
    expect(itemCommentTitle(markdown, "Q2")).toBe("Report cutoff timezone");
    const long = itemCommentTitle(`[Q1] ${"word ".repeat(30)}`, "Q1");
    expect(long).toHaveLength(80);
    expect(long.endsWith("…")).toBe(true);
  });
});

describe("summarizeItemCommentMessage", () => {
  it("counts the comments and the items they are on", () => {
    expect(summarizeItemCommentMessage(REVIEW)).toEqual({ commentCount: 3, labels: ["Q2", "R1"] });
    expect(summarizeItemCommentMessage("Plain message")).toBeNull();
  });
});

describe("scanItemLabelSource", () => {
  it("reports comment sections and the labels only their headings mention", () => {
    const scan = scanItemLabelSource({
      messageId: "u1",
      role: "user",
      text: buildItemCommentMessage([
        { label: "Q1", title: "Cache", comments: [{ text: "Same as [R2].", attachments: [] }] },
        { label: "R2", title: "Queue", comments: [{ text: "Fine.", attachments: [] }] },
      ]),
    });
    expect(scan.labels).toEqual(["Q1", "R2"]);
    expect(scan.comments?.map((section) => section.label)).toEqual(["Q1", "R2"]);
    // R2 is also mentioned in Q1's comment, which counts as a plain mention.
    expect(scan.commentHeadingOnly).toEqual(["Q1"]);
  });

  it("parses comments only in user messages", () => {
    const scan = scanItemLabelSource({
      messageId: "a1",
      role: "assistant",
      text: "#### [Q1] Cache\n\nDetails. [Q2] too.",
    });
    expect(scan.comments).toBeUndefined();
  });
});
