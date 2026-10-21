import { useId, useState } from "react";
import {
  ArrowUpIcon,
  CheckIcon,
  ChevronDownIcon,
  ChevronUpIcon,
  MessageSquareTextIcon,
  PaperclipIcon,
  PencilIcon,
  Trash2Icon,
  XIcon,
} from "lucide-react";

import { ItemLabelDefinition, itemLabelChipClass } from "@/components/blocks/ChatMarkdown";
import { Button } from "@/components/ui/button";
import {
  ITEM_COMMENT_TRAY_ID,
  useItemCommentTrayExpanded,
  type ItemCommentDraft,
} from "@/lib/itemCommentDrafts";
import type { ItemLabelEntry } from "@/lib/itemLabels";
import { cn } from "@/lib/utils";

/** Matches the queued-messages strip, so both trays read as one stack. */
const ACTION_BUTTON_CLASS =
  "shrink-0 text-muted-foreground transition-colors hover:text-foreground focus-visible:text-foreground max-md:size-11";
const ACTION_ICON_CLASS = "size-3.5 max-md:size-4";
const LABEL_BADGE_CLASS = cn(itemLabelChipClass(false), "pointer-events-none shrink-0");
const NOTHING_SENDING_ELSEWHERE: { submissionId: string; commentCount: number }[] = [];

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

/** "3 comments · Q2 ×2 · R1"; `composingLabel` counts a comment still being written. */
export function summarizeItemCommentDrafts(
  drafts: readonly ItemCommentDraft[],
  composingLabel: string | null = null,
): string {
  const labels = drafts.map((draft) => draft.label);
  if (composingLabel !== null) labels.push(composingLabel);
  const counts = new Map<string, number>();
  for (const label of labels) counts.set(label, (counts.get(label) ?? 0) + 1);
  const parts = [...counts].map(([label, count]) => (count > 1 ? `${label} ×${count}` : label));
  return [plural(labels.length, "comment"), ...parts].join(" · ");
}

/** The tray's send button text, e.g. "Send 3 comments + message". */
export function itemCommentSendLabel(commentCount: number, withMessage: boolean): string {
  return `Send ${plural(commentCount, "comment")}${withMessage ? " + message" : ""}`;
}

/** The phone-width send button text, e.g. "Send 3 + message". */
export function itemCommentSendShortLabel(commentCount: number, withMessage: boolean): string {
  return `Send ${commentCount}${withMessage ? " + message" : ""}`;
}

function firstLine(text: string): string {
  return text.split("\n").find((line) => line.trim() !== "") ?? "";
}

function DraftRow({
  draft,
  editing,
  onEdit,
  onDelete,
}: {
  draft: ItemCommentDraft;
  editing: boolean;
  onEdit: (draftId: string) => void;
  onDelete: (draftId: string) => void;
}) {
  const preview = firstLine(draft.text);
  return (
    <div
      role="listitem"
      data-testid="item-comment-draft-row"
      className="flex min-w-0 items-center gap-1.5 py-0.5 text-sm text-foreground"
    >
      <span className={LABEL_BADGE_CLASS}>{draft.label}</span>
      <span
        className={cn("min-w-0 flex-1 truncate", !preview && "text-muted-foreground")}
        title={draft.text}
      >
        {editing ? "Editing…" : preview || "Attachment only"}
      </span>
      {draft.files.length > 0 && (
        <span
          className="flex shrink-0 items-center gap-0.5 text-xs text-muted-foreground tabular-nums"
          title={draft.files.map((file) => file.name).join("\n")}
        >
          <PaperclipIcon className="size-3" aria-hidden="true" />
          {draft.files.length}
          <span className="sr-only"> attachments</span>
        </span>
      )}
      <span className="flex shrink-0 items-center">
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          aria-label={`Edit draft on ${draft.label}`}
          className={ACTION_BUTTON_CLASS}
          disabled={editing}
          onClick={() => onEdit(draft.id)}
        >
          <PencilIcon className={ACTION_ICON_CLASS} aria-hidden="true" />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          aria-label={`Delete draft on ${draft.label}`}
          className={ACTION_BUTTON_CLASS}
          onClick={() => onDelete(draft.id)}
        >
          <Trash2Icon className={ACTION_ICON_CLASS} aria-hidden="true" />
        </Button>
      </span>
    </div>
  );
}

interface ItemCommentTrayProps {
  /** Unsent drafts, in the order the items were defined. */
  drafts: readonly ItemCommentDraft[];
  /** The draft loaded into the composer, if one is being edited. */
  editingDraftId: string | null;
  /** The item of a new comment being written, which sending includes. */
  composingLabel?: string | null;
  /** Whether a typed message goes along as the General section. */
  withMessage?: boolean;
  /** Why sending is unavailable right now; null when it can send. */
  sendDisabledReason?: string | null;
  onSend: () => void;
  onEdit: (draftId: string) => void;
  onDelete: (draftId: string) => void;
  onDiscardAll: () => void;
  /** Comments another tab submitted and hasn't posted yet, which it can give back. */
  sendingElsewhere?: { submissionId: string; commentCount: number }[];
  onRestoreSubmission?: (submissionId: string) => void;
  /** Width class matching the surface the tray docks onto. */
  widthClassName?: string;
}

/**
 * Comment drafts, docked above the composer like the queued-messages strip.
 * Starts collapsed to one line; its send button, which sends every comment as
 * one message, shows either way. Renders nothing without drafts.
 */
export function ItemCommentTray({
  drafts,
  editingDraftId,
  composingLabel = null,
  withMessage = false,
  sendDisabledReason = null,
  onSend,
  onEdit,
  onDelete,
  onDiscardAll,
  sendingElsewhere = NOTHING_SENDING_ELSEWHERE,
  onRestoreSubmission,
  widthClassName,
}: ItemCommentTrayProps) {
  const [expanded, setExpanded] = useItemCommentTrayExpanded();
  const [confirmingDiscard, setConfirmingDiscard] = useState(false);
  const messageNoteId = useId();
  if (drafts.length === 0 && sendingElsewhere.length === 0) return null;
  const commentCount = drafts.length + (composingLabel !== null ? 1 : 0);
  const showDiscard = expanded && drafts.length > 0;

  return (
    <section
      id={ITEM_COMMENT_TRAY_ID}
      tabIndex={-1}
      aria-label="Comment drafts"
      data-testid="item-comment-tray"
      className={cn(
        "composer-queued-surface mx-auto -mb-4 flex w-full flex-col rounded-t-2xl px-2 pt-1.5 pb-5.5 outline-none md:px-3",
        widthClassName,
      )}
    >
      <div className="flex min-w-0 items-center gap-1 text-xs text-muted-foreground">
        <button
          type="button"
          aria-expanded={expanded}
          aria-label={expanded ? "Collapse comment drafts" : "Show comment drafts"}
          className="flex min-w-0 flex-1 items-center gap-1.5 rounded py-1 text-left hover:text-foreground max-md:min-h-11"
          onClick={() => setExpanded(!expanded)}
        >
          <MessageSquareTextIcon className="size-3.5 shrink-0" aria-hidden="true" />
          {expanded ? (
            <span className="truncate">
              <span className="font-medium text-foreground">Comment drafts</span>
              {" · only on this browser"}
            </span>
          ) : (
            <span className="truncate text-foreground">
              {summarizeItemCommentDrafts(drafts, composingLabel)}
            </span>
          )}
          {expanded ? (
            <ChevronDownIcon className="size-3.5 shrink-0" aria-hidden="true" />
          ) : (
            <ChevronUpIcon className="size-3.5 shrink-0" aria-hidden="true" />
          )}
        </button>
        {showDiscard && (
          <span className="flex shrink-0 items-center gap-1">
            {confirmingDiscard ? (
              <>
                <span className="text-foreground">Discard {drafts.length}?</span>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  aria-label="Confirm discard all drafts"
                  className={ACTION_BUTTON_CLASS}
                  onClick={() => {
                    setConfirmingDiscard(false);
                    onDiscardAll();
                  }}
                >
                  <CheckIcon className={ACTION_ICON_CLASS} aria-hidden="true" />
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  aria-label="Keep drafts"
                  className={ACTION_BUTTON_CLASS}
                  onClick={() => setConfirmingDiscard(false)}
                >
                  <XIcon className={ACTION_ICON_CLASS} aria-hidden="true" />
                </Button>
              </>
            ) : (
              <button
                type="button"
                className="rounded px-1 py-1 hover:text-foreground max-md:min-h-11"
                onClick={() => setConfirmingDiscard(true)}
              >
                Discard all
              </button>
            )}
          </span>
        )}
        {commentCount > 0 && !(showDiscard && confirmingDiscard) && (
          <>
            {/* Phones get the short label; either may truncate rather than overflow. */}
            <Button
              type="button"
              size="sm"
              data-testid="submit-item-comments"
              className="ml-1 h-7 min-w-0 shrink gap-1 px-2 max-md:h-9"
              disabled={sendDisabledReason !== null}
              title={sendDisabledReason ?? undefined}
              aria-label={itemCommentSendLabel(commentCount, withMessage)}
              aria-describedby={withMessage ? messageNoteId : undefined}
              onClick={onSend}
            >
              <ArrowUpIcon className="size-3.5" viewBox="4 4 16 16" aria-hidden="true" />
              <span className="truncate max-sm:hidden">
                {itemCommentSendLabel(commentCount, withMessage)}
              </span>
              <span className="truncate sm:hidden">
                {itemCommentSendShortLabel(commentCount, withMessage)}
              </span>
            </Button>
            {withMessage && (
              <span id={messageNoteId} className="sr-only">
                The message you typed goes along as a General note.
              </span>
            )}
          </>
        )}
      </div>
      {expanded && (
        <div
          role="list"
          aria-label="Comment drafts"
          className="flex max-h-32 flex-col gap-0.5 overflow-y-auto overscroll-contain"
        >
          {drafts.map((draft) => (
            <DraftRow
              key={draft.id}
              draft={draft}
              editing={draft.id === editingDraftId}
              onEdit={onEdit}
              onDelete={onDelete}
            />
          ))}
          {composingLabel !== null && (
            <div
              role="listitem"
              className="flex min-w-0 items-center gap-1.5 py-0.5 text-sm text-muted-foreground"
            >
              <span className={LABEL_BADGE_CLASS}>{composingLabel}</span>
              <span className="min-w-0 flex-1 truncate">Writing…</span>
            </div>
          )}
          {sendingElsewhere.map(({ submissionId, commentCount: sendingCount }) => (
            <div
              key={submissionId}
              role="listitem"
              className="flex min-w-0 items-center gap-2 py-0.5 text-sm text-muted-foreground"
            >
              <span className="min-w-0 flex-1 truncate">
                {plural(sendingCount, "comment")} sending from another tab
              </span>
              {onRestoreSubmission && (
                <button
                  type="button"
                  className="shrink-0 text-xs text-link hover:underline max-md:min-h-11"
                  onClick={() => onRestoreSubmission(submissionId)}
                >
                  Back to drafts
                </button>
              )}
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

/** Caps the expanded definition at a third of the visible viewport, keyboard included. */
const DEFINITION_MAX_HEIGHT_CLASS = "max-h-[calc(var(--omnigent-viewport-height,100dvh)/3)]";

/**
 * Comment mode's header card at the top of the composer: names the item the
 * comment is for and shows its definition, expanded until collapsed to one
 * line. × leaves comment mode and keeps the draft.
 */
export function ItemCommentModeHeader({
  label,
  title,
  item,
  excerpt,
  editing,
  onLeave,
}: {
  label: string;
  title: string;
  /** The item's definition, when the transcript has loaded it. */
  item: ItemLabelEntry | null;
  excerpt: string;
  editing: boolean;
  onLeave: () => void;
}) {
  const [expanded, setExpanded] = useState(true);
  const definitionId = useId();
  const showDefinition = expanded && item !== null;
  return (
    <div
      data-testid="item-comment-mode"
      className="mx-3 mt-3 flex flex-col rounded-md border-l-2 border-l-warning bg-muted/40 text-sm"
    >
      <div className="flex items-start gap-2 px-2 py-1.5">
        <div className="flex min-w-0 flex-1 flex-col">
          <span className="flex min-w-0 items-baseline gap-1.5">
            <span className="shrink-0 text-muted-foreground">
              {editing ? "Editing comment on" : "Commenting on"}
            </span>
            <span className={LABEL_BADGE_CLASS}>{label}</span>
            {title && <span className="truncate font-medium">{title}</span>}
          </span>
          {!showDefinition && excerpt && (
            <span className="truncate text-muted-foreground">{excerpt}</span>
          )}
        </div>
        {item !== null && (
          <button
            type="button"
            onClick={() => setExpanded(!expanded)}
            className="mt-0.5 shrink-0 rounded-full text-muted-foreground hover:text-foreground max-md:-m-2 max-md:p-2"
            aria-expanded={expanded}
            aria-controls={showDefinition ? definitionId : undefined}
            aria-label={expanded ? `Collapse ${label} text` : `Show ${label} text`}
            title={expanded ? "Collapse to one line" : "Show the full item"}
          >
            {expanded ? (
              <ChevronUpIcon className="size-3.5" aria-hidden="true" />
            ) : (
              <ChevronDownIcon className="size-3.5" aria-hidden="true" />
            )}
          </button>
        )}
        <button
          type="button"
          onClick={onLeave}
          className="mt-0.5 shrink-0 rounded-full text-muted-foreground hover:text-foreground max-md:-m-2 max-md:p-2"
          aria-label="Leave comment mode"
          title="Leave comment mode (Esc); the draft is kept"
        >
          <XIcon className="size-3.5" />
        </button>
      </div>
      {showDefinition && (
        <div
          id={definitionId}
          role="region"
          aria-label={`${label} text`}
          data-testid="item-comment-mode-definition"
          className={cn(
            "overflow-y-auto overscroll-contain border-t border-border/60 px-2 py-1.5",
            DEFINITION_MAX_HEIGHT_CLASS,
          )}
        >
          <ItemLabelDefinition item={item} />
        </div>
      )}
    </div>
  );
}
