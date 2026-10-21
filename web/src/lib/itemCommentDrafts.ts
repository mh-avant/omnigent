// Item-comment drafts: comments the user has written on labelled items but not
// yet submitted. They stay in this browser only, in localStorage keyed by
// session, so a reload or another tab sees the same drafts (synced through the
// `storage` event). Attachments are kept by id in `itemCommentFiles`.
//
// Submitting marks the drafts as sent rather than deleting them: the message
// may wait in the in-memory send queue, so the drafts only go once its post
// succeeds. A page that goes away first leaves them orphaned, and the next
// composer to open the session puts them back (see `useItemCommentSubmissions`).
//
// The module also carries what the transcript and the composer share: the
// popover's request to comment on an item, whether a composer can take it,
// and the order in which the transcript defines its items.

import { useMemo, useSyncExternalStore } from "react";
import type { MentionItem } from "./composerMentions";
import { forgetDraftFiles, sweepDraftFiles } from "./itemCommentFiles";
import type { ItemLabelIndex } from "./itemLabels";
import type { StoredReplyDraft } from "./replyDraft";

const STORAGE_PREFIX = "omnigent.itemComments.";

/** An attachment on a draft; its bytes live in `itemCommentFiles`. */
export interface ItemCommentDraftFile {
  id: string;
  name: string;
  type: string;
  size: number;
}

export interface ItemCommentDraft {
  id: string;
  label: string;
  /** The item's title when the draft was written, for items not loaded at submit. */
  title: string;
  text: string;
  replyDraft?: StoredReplyDraft;
  mentions?: MentionItem[];
  files: ItemCommentDraftFile[];
  createdAt: number;
  /** The submission this draft went out in, until that message posts. */
  submissionId?: string;
}

/** A comment message sent but not yet posted. */
export interface ItemCommentSubmission {
  id: string;
  /** The message text, to find it in the queue and the transcript. */
  text: string;
  /** The message typed alongside, put back with the drafts if the send is undone. */
  general?: { text: string; replyDraft?: StoredReplyDraft };
  /** The page that sent it went away before the post succeeded. */
  orphaned?: boolean;
}

export interface ItemCommentState {
  drafts: readonly ItemCommentDraft[];
  submissions: readonly ItemCommentSubmission[];
}

/** What the popover asks the composer to do. */
export interface ItemCommentRequest {
  label: string;
  title: string;
  /** The draft to edit; a new comment when absent. */
  draftId?: string;
  nonce: number;
}

const EMPTY_STATE: ItemCommentState = { drafts: [], submissions: [] };
const states = new Map<string, ItemCommentState>();
const requests = new Map<string, ItemCommentRequest>();
const composerCounts = new Map<string, number>();
const labelOrders = new Map<string, readonly string[]>();
const publishedIndexes = new Map<string, ItemLabelIndex>();
const ownedSubmissionIds = new Set<string>();
const listeners = new Set<() => void>();
let requestSeq = 0;
// Page-scoped, so every reload starts with the tray collapsed.
let trayExpanded = false;

function notify(): void {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  ensureWindowListeners();
  return () => listeners.delete(listener);
}

function storage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readDraft(value: unknown): ItemCommentDraft | null {
  if (!isRecord(value)) return null;
  const { id, label, title, text, files, createdAt } = value;
  if (typeof id !== "string" || typeof label !== "string" || typeof text !== "string") return null;
  return {
    ...(value as unknown as ItemCommentDraft),
    title: typeof title === "string" ? title : "",
    files: Array.isArray(files)
      ? files.filter(
          (file): file is ItemCommentDraftFile =>
            isRecord(file) && typeof file.id === "string" && typeof file.name === "string",
        )
      : [],
    createdAt: typeof createdAt === "number" ? createdAt : 0,
  };
}

function readState(raw: string | null): ItemCommentState {
  if (!raw) return EMPTY_STATE;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed)) return EMPTY_STATE;
    const drafts = Array.isArray(parsed.drafts)
      ? parsed.drafts.flatMap((draft) => readDraft(draft) ?? [])
      : [];
    const submissions = Array.isArray(parsed.submissions)
      ? parsed.submissions.filter(
          (submission): submission is ItemCommentSubmission =>
            isRecord(submission) &&
            typeof submission.id === "string" &&
            typeof submission.text === "string",
        )
      : [];
    return drafts.length === 0 && submissions.length === 0 ? EMPTY_STATE : { drafts, submissions };
  } catch {
    return EMPTY_STATE;
  }
}

/** The drafts and pending submissions for `sessionId`. */
export function getItemCommentState(sessionId: string | null): ItemCommentState {
  if (sessionId === null) return EMPTY_STATE;
  let state = states.get(sessionId);
  if (state === undefined) {
    state = readState(storage()?.getItem(STORAGE_PREFIX + sessionId) ?? null);
    states.set(sessionId, state);
  }
  return state;
}

function writeState(sessionId: string, next: ItemCommentState): void {
  const state = next.drafts.length === 0 && next.submissions.length === 0 ? EMPTY_STATE : next;
  states.set(sessionId, state);
  try {
    const store = storage();
    if (state === EMPTY_STATE) store?.removeItem(STORAGE_PREFIX + sessionId);
    else store?.setItem(STORAGE_PREFIX + sessionId, JSON.stringify(state));
  } catch {
    // Storage full or unavailable: the drafts still work in this page.
  }
  notify();
}

function update(sessionId: string, change: (state: ItemCommentState) => ItemCommentState): void {
  writeState(sessionId, change(getItemCommentState(sessionId)));
}

/** File ids no remaining draft in the session uses. */
function unusedFileIds(
  sessionId: string,
  candidates: readonly ItemCommentDraftFile[],
): Set<string> {
  const used = new Set(
    getItemCommentState(sessionId).drafts.flatMap((d) => d.files.map((f) => f.id)),
  );
  return new Set(candidates.map((file) => file.id).filter((id) => !used.has(id)));
}

/** Saves a draft, replacing the one with the same id in place. */
export function saveItemCommentDraft(sessionId: string, draft: ItemCommentDraft): void {
  const previous = getItemCommentState(sessionId).drafts.find((d) => d.id === draft.id);
  update(sessionId, (state) => ({
    ...state,
    drafts: previous
      ? state.drafts.map((d) => (d.id === draft.id ? draft : d))
      : [...state.drafts, draft],
  }));
  if (previous) forgetDraftFiles(unusedFileIds(sessionId, previous.files));
}

/** Removes a draft and returns it, keeping its files so an undo can restore it. */
export function removeItemCommentDraft(
  sessionId: string,
  draftId: string,
): ItemCommentDraft | null {
  const removed = getItemCommentState(sessionId).drafts.find((d) => d.id === draftId) ?? null;
  if (removed === null) return null;
  update(sessionId, (state) => ({
    ...state,
    drafts: state.drafts.filter((d) => d.id !== draftId),
  }));
  return removed;
}

/** Removes every draft not already submitted and returns them. */
export function discardItemCommentDrafts(sessionId: string): ItemCommentDraft[] {
  const discarded = getItemCommentState(sessionId).drafts.filter((d) => !d.submissionId);
  update(sessionId, (state) => ({
    ...state,
    drafts: state.drafts.filter((d) => d.submissionId),
  }));
  return discarded;
}

/** Marks `draftIds` as sent in `submission`, owned by this page until it posts. */
export function markItemCommentsSubmitted(
  sessionId: string,
  draftIds: readonly string[],
  submission: ItemCommentSubmission,
): void {
  ownedSubmissionIds.add(submission.id);
  const ids = new Set(draftIds);
  update(sessionId, (state) => ({
    drafts: state.drafts.map((d) => (ids.has(d.id) ? { ...d, submissionId: submission.id } : d)),
    submissions: [...state.submissions.filter((s) => s.id !== submission.id), submission],
  }));
}

/** The message posted: its drafts are done. */
export function completeItemCommentSubmission(sessionId: string, submissionId: string): void {
  ownedSubmissionIds.delete(submissionId);
  const sent = getItemCommentState(sessionId).drafts.filter((d) => d.submissionId === submissionId);
  update(sessionId, (state) => ({
    drafts: state.drafts.filter((d) => d.submissionId !== submissionId),
    submissions: state.submissions.filter((s) => s.id !== submissionId),
  }));
  forgetDraftFiles(
    unusedFileIds(
      sessionId,
      sent.flatMap((d) => d.files),
    ),
  );
}

/** The message didn't go out: its comments become drafts again. Returns the submission. */
export function restoreItemCommentSubmission(
  sessionId: string,
  submissionId: string,
): ItemCommentSubmission | null {
  ownedSubmissionIds.delete(submissionId);
  const submission =
    getItemCommentState(sessionId).submissions.find((s) => s.id === submissionId) ?? null;
  update(sessionId, (state) => ({
    drafts: state.drafts.map((d) => {
      if (d.submissionId !== submissionId) return d;
      const draft = { ...d };
      delete draft.submissionId;
      return draft;
    }),
    submissions: state.submissions.filter((s) => s.id !== submissionId),
  }));
  return submission;
}

/** Whether this page sent `submissionId` and is still tracking it. */
export function ownsItemCommentSubmission(submissionId: string): boolean {
  return ownedSubmissionIds.has(submissionId);
}

/** Drafts and pending submissions for `sessionId`, kept current across tabs. */
export function useItemCommentState(sessionId: string | null): ItemCommentState {
  return useSyncExternalStore(
    subscribe,
    () => getItemCommentState(sessionId),
    () => EMPTY_STATE,
  );
}

/** Drafts per label (submitted ones included until they post), for chip marks. */
export function useItemCommentDraftCounts(sessionId: string | null): ReadonlyMap<string, number> {
  const { drafts } = useItemCommentState(sessionId);
  return useMemo(() => {
    const counts = new Map<string, number>();
    for (const draft of drafts) counts.set(draft.label, (counts.get(draft.label) ?? 0) + 1);
    return counts;
  }, [drafts]);
}

/** Asks the session's composer to start (or edit) a comment on an item. */
export function requestItemComment(
  sessionId: string,
  request: Omit<ItemCommentRequest, "nonce">,
): void {
  requestSeq += 1;
  requests.set(sessionId, { ...request, nonce: requestSeq });
  notify();
}

/** Clears a request once the composer has acted on it. */
export function clearItemCommentRequest(sessionId: string, nonce: number): void {
  if (requests.get(sessionId)?.nonce !== nonce) return;
  requests.delete(sessionId);
  notify();
}

export function useItemCommentRequest(sessionId: string | null): ItemCommentRequest | null {
  return useSyncExternalStore(
    subscribe,
    () => (sessionId === null ? null : (requests.get(sessionId) ?? null)),
    () => null,
  );
}

/** Marks `sessionId` as having a composer that takes comments; returns the undo. */
export function registerItemCommentComposer(sessionId: string): () => void {
  composerCounts.set(sessionId, (composerCounts.get(sessionId) ?? 0) + 1);
  notify();
  return () => {
    const count = (composerCounts.get(sessionId) ?? 1) - 1;
    if (count > 0) composerCounts.set(sessionId, count);
    else composerCounts.delete(sessionId);
    notify();
  };
}

/** Whether a composer can take a comment on this session's items. */
export function useCanCommentOnItems(sessionId: string | null): boolean {
  return useSyncExternalStore(
    subscribe,
    () => sessionId !== null && composerCounts.has(sessionId),
    () => false,
  );
}

/** Shares the transcript's label index with the composer, which renders apart from it. */
export function publishItemLabelIndex(sessionId: string, index: ItemLabelIndex): void {
  publishedIndexes.set(sessionId, index);
  const order = index.enabled ? [...index.items.keys()] : [];
  const previous = labelOrders.get(sessionId);
  if (previous?.length === order.length && previous.every((label, i) => label === order[i])) {
    return;
  }
  labelOrders.set(sessionId, order);
  notify();
}

/** The transcript's current label index for `sessionId`, if it has rendered. */
export function getPublishedItemLabelIndex(sessionId: string): ItemLabelIndex | null {
  return publishedIndexes.get(sessionId) ?? null;
}

const NO_LABELS: readonly string[] = [];

/** Labels in the order the transcript defines them. */
export function useItemLabelOrder(sessionId: string | null): readonly string[] {
  return useSyncExternalStore(
    subscribe,
    () => (sessionId === null ? NO_LABELS : (labelOrders.get(sessionId) ?? NO_LABELS)),
    () => NO_LABELS,
  );
}

function readTrayExpanded(): boolean {
  return trayExpanded;
}

/** Whether the drafts tray is expanded; collapsed again after a reload. */
export function useItemCommentTrayExpanded(): [boolean, (expanded: boolean) => void] {
  const expanded = useSyncExternalStore(subscribe, readTrayExpanded, () => false);
  return [expanded, setItemCommentTrayExpanded];
}

/** DOM id of the drafts tray, so other surfaces can jump to it. */
export const ITEM_COMMENT_TRAY_ID = "item-comment-tray";

/** Expands the drafts tray and moves focus to it. */
export function revealItemCommentTray(): void {
  setItemCommentTrayExpanded(true);
  requestAnimationFrame(() => document.getElementById(ITEM_COMMENT_TRAY_ID)?.focus());
}

function setItemCommentTrayExpanded(expanded: boolean): void {
  trayExpanded = expanded;
  notify();
}

let windowListenersAdded = false;

function ensureWindowListeners(): void {
  if (windowListenersAdded || typeof window === "undefined") return;
  windowListenersAdded = true;
  window.addEventListener("storage", (event) => {
    if (event.key === null) {
      states.clear();
      notify();
      return;
    }
    if (!event.key.startsWith(STORAGE_PREFIX)) return;
    states.set(event.key.slice(STORAGE_PREFIX.length), readState(event.newValue));
    notify();
  });
  // The send queue lives in this page; once it goes, anything it still held is
  // orphaned, and the next page to open the session gives the drafts back.
  window.addEventListener("pagehide", () => setOwnedSubmissionsOrphaned(true));
  window.addEventListener("pageshow", (event) => {
    if (event.persisted) setOwnedSubmissionsOrphaned(false);
  });
  const referenced = referencedDraftFileIds();
  if (referenced !== null) void sweepDraftFiles(referenced);
}

function setOwnedSubmissionsOrphaned(orphaned: boolean): void {
  for (const [sessionId, state] of states) {
    if (!state.submissions.some((s) => ownedSubmissionIds.has(s.id))) continue;
    writeState(sessionId, {
      ...state,
      submissions: state.submissions.map((s) =>
        ownedSubmissionIds.has(s.id) ? { ...s, orphaned } : s,
      ),
    });
  }
}

/** Every file id a stored draft uses; null when storage can't be read in full. */
function referencedDraftFileIds(): Set<string> | null {
  const ids = new Set<string>();
  const store = storage();
  if (store === null) return null;
  try {
    for (let index = 0; index < store.length; index += 1) {
      const key = store.key(index);
      if (!key?.startsWith(STORAGE_PREFIX)) continue;
      for (const draft of readState(store.getItem(key)).drafts) {
        for (const file of draft.files) ids.add(file.id);
      }
    }
  } catch {
    return null;
  }
  return ids;
}

/** Forgets every in-memory state, for tests. */
export function resetItemCommentDraftsForTests(): void {
  states.clear();
  requests.clear();
  composerCounts.clear();
  labelOrders.clear();
  publishedIndexes.clear();
  ownedSubmissionIds.clear();
  trayExpanded = false;
  notify();
}
