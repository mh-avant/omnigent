// Item labels (`[Q2]`) in chat markdown: a later mention previews the block
// that defined the item (and how it was closed), the defining message shows a
// static badge, and a transcript not using labels keeps the text as written.

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type React from "react";
import { MemoryRouter, useLocation } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ItemLabelIndexContext,
  ItemLabelMessageContext,
  buildItemLabelIndex,
  type ItemLabelIndex,
  type ItemLabelSource,
} from "@/lib/itemLabels";
import { FilePathAwareMessageResponse } from "./ChatMarkdown";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
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

function renderMarkdown(markdown: string, messageId: string, index: ItemLabelIndex | null = INDEX) {
  const message = (
    <ItemLabelMessageContext.Provider value={messageId}>
      <FilePathAwareMessageResponse>{markdown}</FilePathAwareMessageResponse>
    </ItemLabelMessageContext.Provider>
  );
  const tree: React.ReactNode = (
    <ItemLabelIndexContext.Provider value={index}>{message}</ItemLabelIndexContext.Provider>
  );
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <MemoryRouter initialEntries={["/c/conv_1"]}>
        {tree}
        <LocationProbe />
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

  it("renders the label as a static badge in the message that defines it", async () => {
    renderMarkdown(DEFINING.text, DEFINING.messageId);

    expect(await screen.findByText("Q2")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Show item/ })).toBeNull();
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
    renderMarkdown("Still waiting on [Q2].", "resp_later");
    const chip = await screen.findByRole("button", { name: "Show item Q2" });

    fireEvent.pointerEnter(chip, { pointerType: "mouse" });
    const show = await screen.findByRole("button", { name: "Show in conversation" });
    // Focus stays put, so hovering never pulls it out of the composer.
    expect(document.activeElement).not.toBe(show);
    fireEvent.pointerLeave(chip, { pointerType: "mouse" });
    const popover = show.closest<HTMLElement>("[data-slot=popover-content]")!;
    fireEvent.pointerEnter(popover, { pointerType: "mouse" });
    await wait(300);
    expect(screen.getByRole("button", { name: "Show in conversation" })).toBe(show);

    fireEvent.pointerLeave(popover, { pointerType: "mouse" });
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "Show in conversation" })).toBeNull(),
    );
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
