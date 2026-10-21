import { toast } from "sonner";
import { removeItemCommentDraft, saveItemCommentDraft } from "@/lib/itemCommentDrafts";

/** How long the Undo pill stays up after a draft is deleted. */
const DELETE_UNDO_DURATION_MS = 5000;

/** Deletes a comment draft and offers an Undo that puts it back in its place. */
export function deleteItemCommentDraftWithUndo(sessionId: string, draftId: string): void {
  const removed = removeItemCommentDraft(sessionId, draftId);
  if (removed === null) return;
  toast(`Deleted the draft on ${removed.label}`, {
    duration: DELETE_UNDO_DURATION_MS,
    action: { label: "Undo", onClick: () => saveItemCommentDraft(sessionId, removed) },
    testId: "item-comment-undo-toast",
  });
}
