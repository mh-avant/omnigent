// Item labels (`[Q2]`) in chat markdown: a chip previews the block that
// defined the item (how it was closed, its comments and unsent drafts) and
// offers Comment, and a transcript not using labels keeps the text as written.

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type React from "react";
import { MemoryRouter, useLocation } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildItemCommentMessage, scanItemLabelSource } from "@/lib/itemComments";
import {
  getItemCommentState,
  registerItemCommentComposer,
  resetItemCommentDraftsForTests,
  saveItemCommentDraft,
  useItemCommentRequest,
} from "@/lib/itemCommentDrafts";
import {
  ItemLabelIndexContext,
  ItemLabelMessageContext,
  ItemLabelSessionContext,
  buildItemLabelIndex,
  type ItemLabelIndex,
  type ItemLabelSource,
} from "@/lib/itemLabels";
import { FilePathAwareMessageResponse } from "./ChatMarkdown";

const SESSION_ID = "conv_1";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  resetItemCommentDraftsForTests();
  localStorage.clear();
});

const DEFINING: ItemLabelSource = {
  messageId: "resp_defining",
  role: "assistant",
  text: [
    "Open questions:",
    "",
    "1. [Q1] Unrelated first item.",
    "2. [Q2] Should the cache be per-user? It changes eviction.",
  ].join("\n"),
};
const INDEX = buildItemLabelIndex([{ source: DEFINING, labels: ["Q1", "Q2"], struck: [] }]);
const CLOSING: ItemLabelSource = {
  messageId: "msg_closing",
  role: "user",
  text: "Thanks. ~~[Q2]~~ keep it global for now. Ship it.",
};
const CLOSED_INDEX = buildItemLabelIndex([
  { source: DEFINING, labels: ["Q1", "Q2"], struck: [] },
  { source: CLOSING, labels: ["Q2"], struck: ["Q2"] },
]);

function LocationProbe() {
  return <output data-testid="location">{useLocation().search}</output>;
}

function CommentRequestProbe() {
  const request = useItemCommentRequest(SESSION_ID);
  return (
    <output data-testid="comment-request">
      {request ? `${request.label}|${request.title}|${request.draftId ?? ""}` : ""}
    </output>
  );
}

function renderMarkdown(markdown: string, messageId: string, index: ItemLabelIndex | null = INDEX) {
  const message = (
    <ItemLabelMessageContext.Provider value={messageId}>
      <FilePathAwareMessageResponse>{markdown}</FilePathAwareMessageResponse>
    </ItemLabelMessageContext.Provider>
  );
  const tree: React.ReactNode = (
    <ItemLabelSessionContext.Provider value={SESSION_ID}>
      <ItemLabelIndexContext.Provider value={index}>{message}</ItemLabelIndexContext.Provider>
    </ItemLabelSessionContext.Provider>
  );
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <MemoryRouter initialEntries={["/c/conv_1"]}>
        {tree}
        <LocationProbe />
        <CommentRequestProbe />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("item labels in chat markdown", () => {
  it("previews the defining item from a later mention and links to its message", async () => {
    renderMarkdown("Still waiting on [Q2].", "resp_later");

    fireEvent.click(await screen.findByRole("button", { name: "Show item Q2" }));

    expect(await screen.findByText(/Should the cache be per-user\?/)).toBeTruthy();
    expect(screen.queryByText(/Unrelated first item/)).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Show in conversation" }));
    expect(screen.getByTestId("location").textContent).toBe("?message=resp_defining");
  });

  it("opens the same preview from the label in its defining message", async () => {
    renderMarkdown(DEFINING.text, DEFINING.messageId);

    fireEvent.click(await screen.findByRole("button", { name: "Show item Q2" }));

    expect(await screen.findByText(/It changes eviction\./, { selector: "p" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Show in conversation" })).toBeTruthy();
  });

  it("offers Comment only while a composer takes comments, and asks it to start one", async () => {
    renderMarkdown("Still waiting on [Q2].", "resp_later");
    fireEvent.click(await screen.findByRole("button", { name: "Show item Q2" }));
    await screen.findByText(/Should the cache be per-user\?/);
    expect(screen.queryByRole("button", { name: "Comment" })).toBeNull();
    fireEvent.keyDown(screen.getByRole("button", { name: "Show in conversation" }), {
      key: "Escape",
    });
    cleanup();

    const unregister = registerItemCommentComposer(SESSION_ID);
    renderMarkdown("Still waiting on [Q2].", "resp_later");
    fireEvent.click(await screen.findByRole("button", { name: "Show item Q2" }));
    fireEvent.click(await screen.findByRole("button", { name: "Comment" }));

    expect(screen.getByTestId("comment-request").textContent).toBe(
      "Q2|Should the cache be per-user?|",
    );
    expect(screen.queryByText(/It changes eviction/)).toBeNull();
    unregister();
  });

  it("lists sent comments with their files and the agent's reply, then this browser's drafts", async () => {
    const review: ItemLabelSource = {
      messageId: "msg_review",
      role: "user",
      text: buildItemCommentMessage([
        {
          label: "Q2",
          title: "Should the cache be per-user",
          comments: [{ text: "Per-user, capped at 1 GB.", attachments: ["sizes.csv"] }],
        },
      ]),
      files: [{ filename: "sizes.csv", fileId: "file_csv", image: false }],
    };
    const reply: ItemLabelSource = {
      messageId: "resp_reply",
      role: "assistant",
      text: "On it. [Q2] The cache is now per-user with a 1 GB cap. Tests pass.",
    };
    const index = buildItemLabelIndex(
      [DEFINING, review, reply].map((source) => scanItemLabelSource(source)),
    );
    saveItemCommentDraft(SESSION_ID, {
      id: "draft_1",
      label: "Q2",
      title: "Should the cache be per-user",
      text: "Same rule for the archive job.",
      files: [],
      createdAt: 1,
    });
    const unregister = registerItemCommentComposer(SESSION_ID);
    renderMarkdown("Recap: [Q2].", "resp_recap", index);

    fireEvent.click(
      await screen.findByRole("button", { name: "Show item Q2, 1 comment, 1 draft" }),
    );

    const comment = await screen.findByTestId("item-comment");
    expect(comment.textContent).toContain("Per-user, capped at 1 GB.");
    expect(comment.textContent).toContain("sizes.csv");
    expect(comment.textContent).toContain("Agent replied");
    expect(comment.textContent).toContain("The cache is now per-user with a 1 GB cap.");
    expect(comment.textContent).not.toContain("Tests pass");
    expect(screen.getByText("Comments (1)")).toBeTruthy();

    const draft = screen.getByTestId("item-comment-draft");
    expect(draft.textContent).toContain("Draft · not sent");
    expect(draft.textContent).toContain("Same rule for the archive job.");

    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    expect(screen.getByTestId("comment-request").textContent).toBe(
      "Q2|Should the cache be per-user?|draft_1",
    );
    unregister();
  });

  it("deletes a draft from the popover", async () => {
    saveItemCommentDraft(SESSION_ID, {
      id: "draft_1",
      label: "Q2",
      title: "Cache",
      text: "Drop me.",
      files: [],
      createdAt: 1,
    });
    renderMarkdown("Still waiting on [Q2].", "resp_later");
    const chip = await screen.findByRole("button", { name: "Show item Q2, 1 draft" });
    expect(chip.querySelector('[data-testid="item-label-draft-mark"]')).not.toBeNull();

    fireEvent.click(chip);
    fireEvent.click(await screen.findByRole("button", { name: "Delete" }));

    expect(getItemCommentState(SESSION_ID).drafts).toEqual([]);
  });

  it("keeps the written text where no transcript index is available", async () => {
    renderMarkdown("Still waiting on [Q2].", "resp_later", null);

    expect(await screen.findByText("Still waiting on [Q2].")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Show item/ })).toBeNull();
  });

  it("keeps a lone label as written until the transcript uses labels", async () => {
    const lone = buildItemLabelIndex([
      { source: { ...DEFINING, text: "Use [A4] paper." }, labels: ["A4"], struck: [] },
    ]);
    renderMarkdown("Use [A4] paper.", DEFINING.messageId, lone);

    expect(await screen.findByText("Use [A4] paper.")).toBeTruthy();
  });

  it("strikes a closed item and shows how it was closed", async () => {
    renderMarkdown("Recap: [Q1] and [Q2].", "resp_recap", CLOSED_INDEX);

    fireEvent.click(await screen.findByRole("button", { name: "Show item Q2 (closed)" }));

    expect(await screen.findByText(/Should the cache be per-user\?/)).toBeTruthy();
    expect(screen.getByText(/^Closed · User/)).toBeTruthy();
    expect(screen.getByText(/keep it global for now\./)).toBeTruthy();
    expect(screen.queryByText(/Ship it/)).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Show" }));
    expect(screen.getByTestId("location").textContent).toBe("?message=msg_closing");
  });

  const wait = (ms: number) =>
    new Promise<void>((resolve) => {
      setTimeout(resolve, ms);
    });
  const stubHoverDevice = () =>
    vi.stubGlobal(
      "matchMedia",
      vi.fn((query: string) => ({ matches: query.includes("hover: hover"), media: query })),
    );

  it("previews on a desktop mouse hover and stays open over the popover", async () => {
    stubHoverDevice();
    const unregister = registerItemCommentComposer(SESSION_ID);
    renderMarkdown("Still waiting on [Q2].", "resp_later");
    const chip = await screen.findByRole("button", { name: "Show item Q2" });

    fireEvent.pointerEnter(chip, { pointerType: "mouse" });
    const comment = await screen.findByRole("button", { name: "Comment" });
    // Focus stays put, so hovering never pulls it out of the composer.
    expect(document.activeElement).not.toBe(comment);
    fireEvent.pointerLeave(chip, { pointerType: "mouse" });
    const popover = comment.closest<HTMLElement>("[data-slot=popover-content]")!;
    fireEvent.pointerEnter(popover, { pointerType: "mouse" });
    await wait(300);
    expect(screen.getByRole("button", { name: "Comment" })).toBe(comment);

    fireEvent.pointerLeave(popover, { pointerType: "mouse" });
    await waitFor(() => expect(screen.queryByRole("button", { name: "Comment" })).toBeNull());
    unregister();
  });

  it("does not preview on touch", async () => {
    stubHoverDevice();
    renderMarkdown("Still waiting on [Q2].", "resp_later");
    const chip = await screen.findByRole("button", { name: "Show item Q2" });
    fireEvent.pointerEnter(chip, { pointerType: "touch" });
    await wait(400);
    expect(screen.queryByText(/Should the cache be per-user\?/)).toBeNull();
  });
});
