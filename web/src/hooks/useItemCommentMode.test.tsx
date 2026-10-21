// Comment mode against a stand-in composer: drafting sets the typed message
// aside, submit sends one structured message through the send callback, and
// the drafts settle with the send path (posted, cancelled, or orphaned).

import { act, cleanup, renderHook } from "@testing-library/react";
import { useRef } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildItemCommentMessage, scanItemLabelSource } from "@/lib/itemComments";
import {
  getItemCommentState,
  publishItemLabelIndex,
  resetItemCommentDraftsForTests,
  type ItemCommentState,
} from "@/lib/itemCommentDrafts";
import { buildItemLabelIndex } from "@/lib/itemLabels";
import { useChatStore } from "@/store/chatStore";
import { useItemCommentMode, type ComposerContent } from "./useItemCommentMode";

const SESSION_ID = "conv_comments";
const DEFINING_TEXT = [
  "Before I continue:",
  "",
  "1. **[R1] Backfill locking.** One transaction locks the table.",
  "2. **[Q2] Report cutoff timezone.** UTC or the account's zone?",
].join("\n");

let composer: ComposerContent;
const send = vi.fn<(text: string, files?: File[]) => void>();

function renderCommentMode() {
  return renderHook(() => {
    const setAsideRef = useRef<ComposerContent | null>(null);
    return useItemCommentMode({
      sessionId: SESSION_ID,
      enabled: true,
      setAsideRef,
      read: () => composer,
      write: (content) => {
        composer = content;
      },
      focus: () => {},
      mentionPreamble: (mentions) =>
        mentions.map((mention) => `[Attached: ${mention.path}]`).join("\n") +
        (mentions.length > 0 ? "\n\n" : ""),
      send,
    });
  });
}

type CommentMode = ReturnType<typeof renderCommentMode>["result"];

function comment(result: CommentMode, label: string, text: string, files: File[] = []) {
  act(() => result.current.startComment({ label, title: `${label} title` }));
  composer = { text, files, mentions: [] };
  act(() => result.current.saveComment());
}

function unsent(state: ItemCommentState) {
  return state.drafts.filter((draft) => !draft.submissionId);
}

beforeEach(() => {
  vi.useFakeTimers();
  composer = { text: "", files: [], mentions: [] };
  send.mockReset();
  useChatStore.setState({
    conversationId: SESSION_ID,
    queuedMessages: [],
    pendingUserMessages: [],
    blocks: [],
    failedSendDraft: null,
    restoredSendDraft: null,
  });
  publishItemLabelIndex(
    SESSION_ID,
    buildItemLabelIndex([
      scanItemLabelSource({ messageId: "a1", role: "assistant", text: DEFINING_TEXT }),
    ]),
  );
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  resetItemCommentDraftsForTests();
  localStorage.clear();
});

describe("useItemCommentMode", () => {
  it("sets the typed message aside while commenting and saves the comment as a draft", () => {
    composer = { text: "Half-typed message", files: [], mentions: [] };
    const { result } = renderCommentMode();

    act(() => result.current.startComment({ label: "Q2", title: "Report cutoff timezone" }));
    expect(result.current.target).toEqual({
      label: "Q2",
      title: "Report cutoff timezone",
      draftId: null,
    });
    expect(composer.text).toBe("");
    expect(result.current.excerpt).toBe("UTC or the account's zone?");
    expect(result.current.item?.source.messageId).toBe("a1");

    composer = { text: "Use the account's zone.", files: [], mentions: [] };
    act(() => result.current.saveComment());

    expect(result.current.target).toBeNull();
    expect(result.current.item).toBeNull();
    expect(composer.text).toBe("Half-typed message");
    expect(result.current.unsentDrafts.map((draft) => [draft.label, draft.text])).toEqual([
      ["Q2", "Use the account's zone."],
    ]);
  });

  it("keeps the comment as a draft on leaving, and deletes an edited draft cleared out", () => {
    const { result } = renderCommentMode();
    act(() => result.current.startComment({ label: "Q2", title: "Cutoff" }));
    composer = { text: "Typed before Escape", files: [], mentions: [] };
    act(() => result.current.leaveCommentMode());
    const [draft] = result.current.unsentDrafts;
    expect(draft.text).toBe("Typed before Escape");

    act(() => result.current.editDraft(draft.id));
    expect(composer.text).toBe("Typed before Escape");
    expect(result.current.target?.draftId).toBe(draft.id);
    composer = { text: "", files: [], mentions: [] };
    act(() => result.current.saveComment());
    expect(result.current.unsentDrafts).toEqual([]);
  });

  it("submits every draft as one message in definition order, with the typed message last", async () => {
    const { result } = renderCommentMode();
    comment(result, "Q2", "Use the account's zone.", [
      new File(["a,b"], "image.png", { type: "image/png" }),
    ]);
    comment(result, "R1", "Batch it at 5,000 rows.");
    comment(result, "Q2", "Store the zone per row.", [
      new File(["c"], "image.png", { type: "image/png" }),
    ]);
    composer = { text: "Q2 blocks the export PR.", files: [], mentions: [] };

    await act(() => result.current.submitComments());

    expect(send).toHaveBeenCalledTimes(1);
    const [text, files] = send.mock.calls[0];
    expect(text).toBe(
      buildItemCommentMessage(
        [
          {
            label: "R1",
            title: "Backfill locking",
            comments: [{ text: "Batch it at 5,000 rows.", attachments: [] }],
          },
          {
            label: "Q2",
            title: "Report cutoff timezone",
            comments: [
              { text: "Use the account's zone.", attachments: ["q2-1.png"] },
              { text: "Store the zone per row.", attachments: ["q2-2.png"] },
            ],
          },
        ],
        { text: "Q2 blocks the export PR.", attachments: [] },
      ),
    );
    expect(files?.map((file) => file.name)).toEqual(["q2-1.png", "q2-2.png"]);
    expect(composer.text).toBe("");
    // Sent, but kept until the message posts.
    expect(getItemCommentState(SESSION_ID).drafts).toHaveLength(3);
    expect(unsent(getItemCommentState(SESSION_ID))).toEqual([]);
  });

  it("counts the comment being written when submitting from comment mode", async () => {
    composer = { text: "General note", files: [], mentions: [] };
    const { result } = renderCommentMode();
    act(() => result.current.startComment({ label: "R1", title: "Backfill locking" }));
    composer = { text: "Run it at night.", files: [], mentions: [] };

    await act(() => result.current.submitComments());

    expect(send.mock.calls[0][0]).toContain("#### [R1] Backfill locking\n\nRun it at night.");
    expect(send.mock.calls[0][0]).toContain("#### General\n\nGeneral note");
    expect(result.current.target).toBeNull();
  });

  it("drops the drafts once the message posts", async () => {
    const { result } = renderCommentMode();
    comment(result, "R1", "Batch it.");
    await act(() => result.current.submitComments());
    const [text] = send.mock.calls[0];

    act(() => {
      useChatStore.setState({
        queuedMessages: [{ queueId: "q_1", text, conversationId: SESSION_ID }],
      });
      vi.advanceTimersByTime(10);
    });
    expect(getItemCommentState(SESSION_ID).drafts).toHaveLength(1);

    act(() => {
      useChatStore.setState({
        queuedMessages: [],
        pendingUserMessages: [
          { tempId: "pend_1", content: [{ type: "input_text", text }], posted: true },
        ],
      });
      vi.advanceTimersByTime(10);
    });
    expect(getItemCommentState(SESSION_ID)).toEqual({ drafts: [], submissions: [] });
  });

  it("gives the comments and the typed message back when the queued message is cancelled", async () => {
    const { result } = renderCommentMode();
    comment(result, "R1", "Batch it.");
    composer = { text: "Also, thanks.", files: [], mentions: [] };
    await act(() => result.current.submitComments());
    const [text] = send.mock.calls[0];
    act(() => {
      useChatStore.setState({
        queuedMessages: [{ queueId: "q_1", text, conversationId: SESSION_ID }],
      });
    });

    act(() => {
      useChatStore.setState({ queuedMessages: [] });
      expect(result.current.restoreQueuedMessage(text)).toBe(true);
    });

    expect(result.current.unsentDrafts.map((draft) => draft.text)).toEqual(["Batch it."]);
    expect(getItemCommentState(SESSION_ID).submissions).toEqual([]);
    expect(composer.text).toBe("Also, thanks.");
  });

  it("gives back a message that vanished without posting, after a grace period", async () => {
    const { result } = renderCommentMode();
    comment(result, "R1", "Batch it.");
    await act(() => result.current.submitComments());

    act(() => vi.advanceTimersByTime(10));
    expect(unsent(getItemCommentState(SESSION_ID))).toEqual([]);
    act(() => vi.advanceTimersByTime(5000));
    expect(unsent(getItemCommentState(SESSION_ID)).map((draft) => draft.text)).toEqual([
      "Batch it.",
    ]);
  });

  it("restores comments a closed page left orphaned, unless the transcript has them", () => {
    const orphanedText = buildItemCommentMessage([
      { label: "R1", title: "Backfill locking", comments: [{ text: "Lost.", attachments: [] }] },
    ]);
    const postedText = buildItemCommentMessage([
      { label: "Q2", title: "Cutoff", comments: [{ text: "Landed.", attachments: [] }] },
    ]);
    localStorage.setItem(
      `omnigent.itemComments.${SESSION_ID}`,
      JSON.stringify({
        drafts: [
          {
            id: "d1",
            label: "R1",
            title: "",
            text: "Lost.",
            files: [],
            createdAt: 1,
            submissionId: "s1",
          },
          {
            id: "d2",
            label: "Q2",
            title: "",
            text: "Landed.",
            files: [],
            createdAt: 2,
            submissionId: "s2",
          },
          {
            id: "d3",
            label: "Q2",
            title: "",
            text: "Elsewhere.",
            files: [],
            createdAt: 3,
            submissionId: "s3",
          },
        ],
        submissions: [
          { id: "s1", text: orphanedText, orphaned: true },
          { id: "s2", text: postedText, orphaned: true },
          { id: "s3", text: "still sending in another tab" },
        ],
      }),
    );
    useChatStore.setState({
      blocks: [
        {
          type: "user_message",
          ctx: { itemId: "item_1" },
          content: [{ type: "input_text", text: postedText }],
        } as never,
      ],
    });

    const { result } = renderCommentMode();
    act(() => vi.advanceTimersByTime(10));

    expect(result.current.unsentDrafts.map((draft) => draft.text)).toEqual(["Lost."]);
    expect(getItemCommentState(SESSION_ID).drafts.map((draft) => draft.id)).toEqual(["d1", "d3"]);
    expect(result.current.sendingElsewhere).toEqual([{ submissionId: "s3", commentCount: 1 }]);
  });

  it("turns a failed comment send back into drafts instead of composer text", async () => {
    const { result } = renderCommentMode();
    comment(result, "R1", "Batch it.");
    await act(() => result.current.submitComments());
    const [text] = send.mock.calls[0];

    let handled = false;
    act(() => {
      handled = result.current.takeFailedSend(text);
    });

    expect(handled).toBe(true);
    expect(result.current.unsentDrafts.map((draft) => draft.text)).toEqual(["Batch it."]);
    expect(result.current.takeFailedSend("an ordinary message")).toBe(false);
  });
});
