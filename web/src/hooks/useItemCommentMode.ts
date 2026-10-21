// Comment mode for the chat composer. Commenting on an item turns the real
// composer into that comment's editor: whatever the user had typed is set
// aside and comes back when the comment is saved to the drafts tray. Submit
// sends every draft (and any typed message, as a "General" section) as one
// structured message through the normal send path, so it queues like any
// other message while the agent is busy.

import { useCallback, useEffect, useMemo, useRef, useState, type MutableRefObject } from "react";
import { toast } from "sonner";
import { extractUserText } from "@/components/chat/chatBubbleParts";
import { deleteItemCommentDraftWithUndo } from "@/components/chat/itemCommentActions";
import { attachmentFilename } from "@/lib/attachments";
import type { AnyBlock, MessageContentBlock } from "@/lib/blocks";
import type { MentionItem } from "@/lib/composerMentions";
import { loadDraftFile, rememberDraftFile } from "@/lib/itemCommentFiles";
import {
  buildItemCommentMessage,
  itemCommentTitle,
  orderByItemDefinition,
  uniqueItemCommentFilenames,
  type ItemCommentBody,
  type ItemCommentGroup,
} from "@/lib/itemComments";
import {
  clearItemCommentRequest,
  completeItemCommentSubmission,
  discardItemCommentDrafts,
  getItemCommentState,
  getPublishedItemLabelIndex,
  markItemCommentsSubmitted,
  ownsItemCommentSubmission,
  registerItemCommentComposer,
  restoreItemCommentSubmission,
  saveItemCommentDraft,
  useItemCommentRequest,
  useItemCommentState,
  useItemLabelOrder,
  type ItemCommentDraft,
  type ItemCommentRequest,
  type ItemCommentSubmission,
} from "@/lib/itemCommentDrafts";
import { itemLabelTitleParts, type ItemLabelEntry } from "@/lib/itemLabels";
import type { StoredReplyDraft } from "@/lib/replyDraft";
import { useChatStore, type ChatState } from "@/store/chatStore";

/** What the composer holds: its text, quotes, attachments and @-mentions. */
export interface ComposerContent {
  text: string;
  replyDraft?: StoredReplyDraft;
  files: File[];
  mentions: MentionItem[];
}

export interface ItemCommentTarget {
  label: string;
  title: string;
  /** The draft being edited; null for a new comment. */
  draftId: string | null;
}

interface UseItemCommentModeOptions {
  /** The session on screen; null (or a temp id) while there is none. */
  sessionId: string | null;
  /** Whether this composer can take comments (writable, not locked). */
  enabled: boolean;
  read: () => ComposerContent;
  write: (content: ComposerContent) => void;
  focus: () => void;
  /** The "[Attached: …]" lines that deliver `mentions` at send time. */
  mentionPreamble: (mentions: MentionItem[]) => string;
  send: (text: string, files?: File[]) => void;
  /**
   * Holds the composer content set aside while commenting. Owned by the
   * composer, which saves it as the session draft in place of the comment.
   */
  setAsideRef: MutableRefObject<ComposerContent | null>;
}

const EMPTY_CONTENT: ComposerContent = { text: "", files: [], mentions: [] };
// A message gone from the queue with no bubble may still be posting from the
// background flush; wait this long before giving its comments back.
const MISSING_GRACE_MS = 4000;

// Files typed alongside a submitted message, so undoing it can put them back.
const generalFilesBySubmission = new Map<string, File[]>();
// Messages whose comments went back to drafts in this page, so a late restore
// of the same text as a failed send doesn't also refill the composer.
const restoredSubmissionTexts = new Set<string>();

function isEmpty(content: ComposerContent): boolean {
  return content.text.trim() === "" && content.files.length === 0 && content.mentions.length === 0;
}

function textOf(content: MessageContentBlock[]): string {
  return extractUserText(content).replace(/\s+/g, " ").trim();
}

/** Where a submitted comment message stands, from the chat store. */
export function itemCommentSubmissionFate(
  text: string,
  conversationId: string,
  chat: Pick<
    ChatState,
    "queuedMessages" | "pendingUserMessages" | "blocks" | "failedSendDraft" | "restoredSendDraft"
  >,
): "waiting" | "posted" | "missing" {
  if (chat.queuedMessages.some((m) => m.conversationId === conversationId && m.text === text)) {
    return "waiting";
  }
  // A failed send is handed back through the composer's failed-send restore.
  if (chat.failedSendDraft?.text === text || chat.restoredSendDraft?.text === text) {
    return "waiting";
  }
  const wanted = textOf([{ type: "input_text", text }]);
  const pending = chat.pendingUserMessages.find((p) => textOf(p.content) === wanted);
  if (pending) return pending.posted ? "posted" : "waiting";
  // Native transcripts add attachment markers, which extractUserText strips.
  const committed = chat.blocks.some(
    (block: AnyBlock) => block.type === "user_message" && textOf(block.content).includes(wanted),
  );
  return committed ? "posted" : "missing";
}

function draftComment(draft: ItemCommentDraft, preamble: (m: MentionItem[]) => string): string {
  return preamble(draft.mentions ?? []) + draft.text;
}

async function loadDraftFiles(drafts: readonly ItemCommentDraft[]): Promise<{
  files: File[][];
  missing: number;
}> {
  let missing = 0;
  const files = await Promise.all(
    drafts.map(async (draft) => {
      const loaded = await Promise.all(draft.files.map((file) => loadDraftFile(file.id)));
      missing += loaded.filter((file) => file === null).length;
      return loaded.filter((file): file is File => file !== null);
    }),
  );
  return { files, missing };
}

function renamed(file: File, name: string): File {
  if (attachmentFilename(file) === name) return file;
  return new File([file], name, { type: file.type, lastModified: file.lastModified });
}

function newDraftId(): string {
  return `draft-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/** The text after an item's title in its defining block, for the collapsed header card. */
function itemExcerpt(entry: ItemLabelEntry | null, label: string): string {
  return entry ? itemLabelTitleParts(entry.source.text, label).rest : "";
}

/**
 * Comment mode, the drafts it saves, and submitting them. Also reconciles
 * submitted comments with the send path: drafts go once their message posts,
 * and come back when it was cancelled, failed, or lost with a closed page.
 */
export function useItemCommentMode({
  sessionId,
  enabled,
  read,
  write,
  focus,
  mentionPreamble,
  send,
  setAsideRef,
}: UseItemCommentModeOptions) {
  const [target, setTarget] = useState<ItemCommentTarget | null>(null);
  const targetRef = useRef(target);
  targetRef.current = target;
  const submittingRef = useRef(false);
  const io = useRef({ read, write, focus, mentionPreamble, send });
  io.current = { read, write, focus, mentionPreamble, send };

  const state = useItemCommentState(sessionId);
  const labelOrder = useItemLabelOrder(sessionId);
  const request = useItemCommentRequest(enabled ? sessionId : null);

  useEffect(() => {
    if (!enabled || sessionId === null) return;
    return registerItemCommentComposer(sessionId);
  }, [enabled, sessionId]);

  const unsentDrafts = useMemo(
    () =>
      orderByItemDefinition(
        [...state.drafts.filter((d) => !d.submissionId)].sort((a, b) => a.createdAt - b.createdAt),
        labelOrder,
      ),
    [state.drafts, labelOrder],
  );

  /** Saves what the composer holds as the target's draft; returns whether it saved one. */
  const commitComment = useCallback((): boolean => {
    const current = targetRef.current;
    if (current === null || sessionId === null) return false;
    const content = io.current.read();
    const existing = current.draftId
      ? getItemCommentState(sessionId).drafts.find((d) => d.id === current.draftId)
      : undefined;
    if (isEmpty(content)) return false;
    saveItemCommentDraft(sessionId, {
      id: existing?.id ?? newDraftId(),
      label: current.label,
      title: current.title,
      text: content.text,
      ...(content.replyDraft ? { replyDraft: content.replyDraft } : {}),
      ...(content.mentions.length > 0 ? { mentions: content.mentions } : {}),
      files: content.files.map((file) => ({
        id: rememberDraftFile(file),
        name: attachmentFilename(file),
        type: file.type,
        size: file.size,
      })),
      createdAt: existing?.createdAt ?? Date.now(),
    });
    return true;
  }, [sessionId]);

  const leaveToSetAside = useCallback(() => {
    const setAside = setAsideRef.current ?? EMPTY_CONTENT;
    setAsideRef.current = null;
    setTarget(null);
    io.current.write(setAside);
    io.current.focus();
  }, [setAsideRef]);

  const startComment = useCallback(
    (next: Omit<ItemCommentRequest, "nonce">) => {
      if (sessionId === null) return;
      if (targetRef.current !== null) commitComment();
      else setAsideRef.current = io.current.read();
      const draft = next.draftId
        ? getItemCommentState(sessionId).drafts.find(
            (d) => d.id === next.draftId && !d.submissionId,
          )
        : undefined;
      const nextTarget = { label: next.label, title: next.title, draftId: draft?.id ?? null };
      setTarget(nextTarget);
      targetRef.current = nextTarget;
      io.current.write({
        text: draft?.text ?? "",
        ...(draft?.replyDraft ? { replyDraft: draft.replyDraft } : {}),
        files: [],
        mentions: draft?.mentions ?? [],
      });
      if (draft && draft.files.length > 0) {
        void loadDraftFiles([draft]).then(({ files, missing }) => {
          if (targetRef.current !== nextTarget) return;
          io.current.write({ ...io.current.read(), files: files[0] ?? [] });
          if (missing > 0) toast.error("Some attachments on this draft are no longer available.");
        });
      }
      io.current.focus();
    },
    [sessionId, commitComment, setAsideRef],
  );

  // The popover's Comment and Edit buttons arrive as requests.
  useEffect(() => {
    if (request === null || sessionId === null) return;
    clearItemCommentRequest(sessionId, request.nonce);
    startComment(request);
  }, [request, sessionId, startComment]);

  /** Enter or ✓: save the comment; clearing everything deletes an edited draft. */
  const saveComment = useCallback(() => {
    const current = targetRef.current;
    if (current === null || sessionId === null) return;
    if (!commitComment() && current.draftId)
      deleteItemCommentDraftWithUndo(sessionId, current.draftId);
    leaveToSetAside();
  }, [sessionId, commitComment, leaveToSetAside]);

  /** Escape or ×: leave comment mode, keeping what was typed as a draft. */
  const leaveCommentMode = useCallback(() => {
    if (targetRef.current === null) return;
    commitComment();
    leaveToSetAside();
  }, [commitComment, leaveToSetAside]);

  const restoreSubmission = useCallback(
    (submission: ItemCommentSubmission, announce: boolean) => {
      if (sessionId === null) return;
      restoreItemCommentSubmission(sessionId, submission.id);
      restoredSubmissionTexts.add(submission.text);
      const files = generalFilesBySubmission.get(submission.id) ?? [];
      generalFilesBySubmission.delete(submission.id);
      const general = submission.general;
      if (general || files.length > 0) {
        // Back where it was typed: under the comment being written, or the composer.
        const inComment = targetRef.current !== null;
        const holder = inComment ? (setAsideRef.current ?? EMPTY_CONTENT) : io.current.read();
        const merged: ComposerContent = {
          ...holder,
          text: [holder.text, general?.text ?? ""]
            .filter((part) => part.trim() !== "")
            .join("\n\n"),
          ...(holder.text.trim() === "" && general?.replyDraft
            ? { replyDraft: general.replyDraft }
            : {}),
          files: [...holder.files, ...files],
        };
        if (inComment) setAsideRef.current = merged;
        else io.current.write(merged);
      }
      if (announce) toast("Your comments weren't sent. They're back in your drafts.");
    },
    [sessionId, setAsideRef],
  );

  /** The queue strip's ✎ or ×, or recall, on a queued comment message. */
  const restoreQueuedMessage = useCallback(
    (text: string): boolean => {
      if (sessionId === null) return false;
      const submission = getItemCommentState(sessionId).submissions.find(
        (s) => s.text === text && ownsItemCommentSubmission(s.id),
      );
      if (!submission) return false;
      restoreSubmission(submission, false);
      return true;
    },
    [sessionId, restoreSubmission],
  );

  /**
   * A failed send handed back for retry. For a comment message the drafts come
   * back instead of the message text; returns whether it was one.
   */
  const takeFailedSend = useCallback(
    (text: string): boolean => {
      if (sessionId === null) return false;
      const submission = getItemCommentState(sessionId).submissions.find((s) => s.text === text);
      if (submission) {
        restoreSubmission(submission, true);
        return true;
      }
      return restoredSubmissionTexts.has(text);
    },
    [sessionId, restoreSubmission],
  );

  /** Restores another tab's submission that never posted. */
  const restoreElsewhere = useCallback(
    (submissionId: string) => {
      if (sessionId === null) return;
      const submission = getItemCommentState(sessionId).submissions.find(
        (s) => s.id === submissionId,
      );
      if (submission) restoreSubmission(submission, false);
    },
    [sessionId, restoreSubmission],
  );

  const submitComments = useCallback(async () => {
    if (sessionId === null || submittingRef.current) return;
    submittingRef.current = true;
    try {
      const inComment = targetRef.current !== null;
      if (inComment) commitComment();
      const general = inComment ? (setAsideRef.current ?? EMPTY_CONTENT) : io.current.read();
      const index = getPublishedItemLabelIndex(sessionId);
      const order = index?.enabled ? [...index.items.keys()] : [];
      const drafts = orderByItemDefinition(
        getItemCommentState(sessionId)
          .drafts.filter((d) => !d.submissionId)
          .sort((a, b) => a.createdAt - b.createdAt),
        order,
      );
      if (drafts.length === 0) return;
      const { files: draftFiles, missing } = await loadDraftFiles(drafts);
      const names = uniqueItemCommentFilenames([
        ...drafts.map((draft, at) => ({
          prefix: draft.label,
          names: draftFiles[at].map(attachmentFilename),
        })),
        { prefix: "general", names: general.files.map(attachmentFilename) },
      ]);
      const groups = new Map<string, ItemCommentGroup & { comments: ItemCommentBody[] }>();
      drafts.forEach((draft, at) => {
        const entry = index?.items.get(draft.label);
        const group = groups.get(draft.label) ?? {
          label: draft.label,
          title: entry ? itemCommentTitle(entry.source.text, draft.label) : draft.title,
          comments: [],
        };
        group.comments.push({
          text: draftComment(draft, io.current.mentionPreamble),
          attachments: names[at],
        });
        groups.set(draft.label, group);
      });
      const generalNames = names[drafts.length];
      const generalText = io.current.mentionPreamble(general.mentions) + general.text;
      const message = buildItemCommentMessage(
        [...groups.values()],
        generalText.trim() !== "" || generalNames.length > 0
          ? { text: generalText, attachments: generalNames }
          : null,
      );
      const files = [
        ...drafts.flatMap((_, at) => draftFiles[at].map((file, i) => renamed(file, names[at][i]))),
        ...general.files.map((file, i) => renamed(file, generalNames[i])),
      ];
      const submission: ItemCommentSubmission = {
        id: newDraftId(),
        text: message,
        ...(general.text.trim() !== ""
          ? {
              general: {
                text: general.text,
                ...(general.replyDraft ? { replyDraft: general.replyDraft } : {}),
              },
            }
          : {}),
      };
      if (general.files.length > 0) generalFilesBySubmission.set(submission.id, general.files);
      markItemCommentsSubmitted(
        sessionId,
        drafts.map((draft) => draft.id),
        submission,
      );
      setAsideRef.current = null;
      setTarget(null);
      targetRef.current = null;
      io.current.write(EMPTY_CONTENT);
      if (missing > 0)
        toast.error("Some draft attachments were no longer available and were left out.");
      io.current.send(message, files.length > 0 ? files : undefined);
    } finally {
      submittingRef.current = false;
    }
  }, [sessionId, commitComment, setAsideRef]);

  // Leaving the session ends comment mode; the comment is kept as a draft
  // there, and the composer's own cleanup saves the set-aside text.
  useEffect(() => {
    return () => {
      if (targetRef.current === null) return;
      commitComment();
      setAsideRef.current = null;
      targetRef.current = null;
      setTarget(null);
    };
  }, [sessionId, commitComment, setAsideRef]);

  // Settle submitted comments against the send path.
  const missingSinceRef = useRef(new Map<string, number>());
  useEffect(() => {
    if (sessionId === null) return;
    const missingSince = missingSinceRef.current;
    let timer: ReturnType<typeof setTimeout> | undefined;
    // Deferred: a queue flush removes the message a moment before its send
    // shows the bubble.
    function schedule(delay = 0) {
      if (timer !== undefined) clearTimeout(timer);
      timer = setTimeout(evaluate, delay);
    }
    function evaluate() {
      if (sessionId === null) return;
      const chat = useChatStore.getState();
      if (chat.conversationId !== sessionId) return;
      for (const submission of getItemCommentState(sessionId).submissions) {
        const owned = ownsItemCommentSubmission(submission.id);
        // Another tab's message is that tab's to settle.
        if (!owned && !submission.orphaned) continue;
        const fate = itemCommentSubmissionFate(submission.text, sessionId, chat);
        if (fate === "waiting") {
          missingSince.delete(submission.id);
        } else if (fate === "posted") {
          generalFilesBySubmission.delete(submission.id);
          completeItemCommentSubmission(sessionId, submission.id);
        } else if (!owned) {
          // Orphaned by a page that went away: the transcript has loaded, and
          // the message isn't in it.
          restoreSubmission(submission, true);
        } else {
          const since = missingSince.get(submission.id) ?? Date.now();
          missingSince.set(submission.id, since);
          if (Date.now() - since >= MISSING_GRACE_MS) {
            missingSince.delete(submission.id);
            restoreSubmission(submission, true);
          } else {
            schedule(MISSING_GRACE_MS);
          }
        }
      }
    }
    schedule();
    const unsubscribe = useChatStore.subscribe(() => {
      if (getItemCommentState(sessionId).submissions.length > 0) schedule();
    });
    return () => {
      unsubscribe();
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [sessionId, state.submissions, restoreSubmission]);

  const sendingElsewhere = useMemo(
    () =>
      state.submissions
        .filter((s) => !ownsItemCommentSubmission(s.id) && !s.orphaned)
        .map((s) => ({
          submissionId: s.id,
          commentCount: state.drafts.filter((d) => d.submissionId === s.id).length,
        })),
    [state],
  );

  const item =
    target && sessionId
      ? (getPublishedItemLabelIndex(sessionId)?.items.get(target.label) ?? null)
      : null;
  return {
    target,
    /** The item being commented on, when the transcript has loaded its definition. */
    item,
    excerpt: target ? itemExcerpt(item, target.label) : "",
    unsentDrafts,
    sendingElsewhere,
    startComment,
    saveComment,
    leaveCommentMode,
    submitComments,
    restoreQueuedMessage,
    takeFailedSend,
    restoreElsewhere,
    editDraft: (draftId: string) => {
      const draft = unsentDrafts.find((d) => d.id === draftId);
      if (draft) startComment({ label: draft.label, title: draft.title, draftId });
    },
    deleteDraft: (draftId: string) => {
      if (sessionId === null) return;
      if (targetRef.current?.draftId === draftId) leaveToSetAside();
      deleteItemCommentDraftWithUndo(sessionId, draftId);
    },
    discardAll: () => {
      if (sessionId === null) return;
      if (targetRef.current?.draftId) leaveToSetAside();
      discardItemCommentDrafts(sessionId);
    },
  };
}
