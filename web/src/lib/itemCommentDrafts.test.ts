import { afterEach, describe, expect, it } from "vitest";
import {
  completeItemCommentSubmission,
  discardItemCommentDrafts,
  getItemCommentState,
  markItemCommentsSubmitted,
  removeItemCommentDraft,
  resetItemCommentDraftsForTests,
  restoreItemCommentSubmission,
  saveItemCommentDraft,
  useItemCommentState,
  type ItemCommentDraft,
} from "./itemCommentDrafts";
import { act, cleanup, renderHook } from "@testing-library/react";

const SESSION_ID = "conv_drafts";
const STORAGE_KEY = `omnigent.itemComments.${SESSION_ID}`;

function draft(id: string, label = "Q2"): ItemCommentDraft {
  return { id, label, title: "", text: `${id} text`, files: [], createdAt: 1 };
}

afterEach(() => {
  cleanup();
  resetItemCommentDraftsForTests();
  localStorage.clear();
});

describe("item comment drafts", () => {
  it("keeps drafts in localStorage per session and reads them back after a reload", () => {
    saveItemCommentDraft(SESSION_ID, draft("d1"));
    saveItemCommentDraft(SESSION_ID, { ...draft("d1"), text: "edited" });
    saveItemCommentDraft(SESSION_ID, draft("d2", "R1"));

    resetItemCommentDraftsForTests();
    expect(getItemCommentState(SESSION_ID).drafts.map((d) => [d.id, d.text])).toEqual([
      ["d1", "edited"],
      ["d2", "d2 text"],
    ]);
    expect(getItemCommentState("other").drafts).toEqual([]);
  });

  it("keeps submitted drafts until the message posts, or gives them back", () => {
    saveItemCommentDraft(SESSION_ID, draft("d1"));
    saveItemCommentDraft(SESSION_ID, draft("d2"));
    markItemCommentsSubmitted(SESSION_ID, ["d1"], { id: "s1", text: "message" });
    expect(discardItemCommentDrafts(SESSION_ID).map((d) => d.id)).toEqual(["d2"]);
    expect(getItemCommentState(SESSION_ID).drafts.map((d) => d.submissionId)).toEqual(["s1"]);

    expect(restoreItemCommentSubmission(SESSION_ID, "s1")?.text).toBe("message");
    expect(getItemCommentState(SESSION_ID)).toEqual({
      drafts: [draft("d1")],
      submissions: [],
    });

    markItemCommentsSubmitted(SESSION_ID, ["d1"], { id: "s2", text: "message" });
    completeItemCommentSubmission(SESSION_ID, "s2");
    expect(getItemCommentState(SESSION_ID)).toEqual({ drafts: [], submissions: [] });
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
  });

  it("follows another tab's changes through the storage event", () => {
    const { result } = renderHook(() => useItemCommentState(SESSION_ID));
    expect(result.current.drafts).toEqual([]);

    const value = JSON.stringify({ drafts: [draft("d9")], submissions: [] });
    act(() => {
      localStorage.setItem(STORAGE_KEY, value);
      window.dispatchEvent(new StorageEvent("storage", { key: STORAGE_KEY, newValue: value }));
    });
    expect(result.current.drafts.map((d) => d.id)).toEqual(["d9"]);

    act(() => {
      window.dispatchEvent(new StorageEvent("storage", { key: STORAGE_KEY, newValue: null }));
    });
    expect(result.current.drafts).toEqual([]);
  });

  it("marks this page's unposted submissions orphaned when the page goes away", () => {
    renderHook(() => useItemCommentState(SESSION_ID));
    saveItemCommentDraft(SESSION_ID, draft("d1"));
    markItemCommentsSubmitted(SESSION_ID, ["d1"], { id: "s1", text: "message" });

    act(() => {
      window.dispatchEvent(new Event("pagehide"));
    });
    resetItemCommentDraftsForTests();
    expect(getItemCommentState(SESSION_ID).submissions).toEqual([
      { id: "s1", text: "message", orphaned: true },
    ]);
  });

  it("ignores malformed storage", () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ drafts: [{ nope: 1 }, draft("d1")] }));
    expect(getItemCommentState(SESSION_ID).drafts.map((d) => d.id)).toEqual(["d1"]);
    localStorage.setItem(`omnigent.itemComments.bad`, "{");
    expect(getItemCommentState("bad")).toEqual({ drafts: [], submissions: [] });
    expect(removeItemCommentDraft("bad", "x")).toBeNull();
  });
});
