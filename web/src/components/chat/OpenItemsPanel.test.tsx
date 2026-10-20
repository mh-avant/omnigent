import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ItemLabelIndexContext,
  buildItemLabelIndex,
  itemLabelsIn,
  struckItemLabelsIn,
  type ItemLabelIndex,
  type ItemLabelSource,
} from "@/lib/itemLabels";
import { OpenItemsPanel, fitItemChipCount } from "./OpenItemsPanel";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function indexOf(...texts: string[]): ItemLabelIndex {
  return buildItemLabelIndex(
    texts.map((text, position) => {
      const source: ItemLabelSource = { messageId: `m${position}`, role: "assistant", text };
      return { source, labels: itemLabelsIn(text), struck: struckItemLabelsIn(text) };
    }),
  );
}

function renderPanel(index: ItemLabelIndex) {
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <MemoryRouter>
        <ItemLabelIndexContext.Provider value={index}>
          <OpenItemsPanel />
        </ItemLabelIndexContext.Provider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("OpenItemsPanel", () => {
  it("lists open items in the header and every item with its title below", () => {
    renderPanel(
      indexOf(
        "- **[Q1] Backfill window.** Batch it?\n- **[Q2] Soft-deleted rows.** Copy or drop?",
        "~~[Q1]~~ batching it.",
      ),
    );

    const panel = screen.getByTestId("open-items");
    expect(panel.textContent).toContain("Open items(1)");
    expect(screen.getAllByRole("button", { name: "Show item Q2" })).toHaveLength(2);
    expect(screen.getByRole("button", { name: "Show item Q1 (closed)" }).textContent).toContain(
      "Backfill window.",
    );
    expect(panel.textContent).toContain("Closed (1)");
  });

  it("collapses on a press outside it, but not inside it or a popover", () => {
    renderPanel(
      indexOf("- **[Q1] Backfill window.** Batch it?\n- **[Q2] Soft-deleted rows.** Drop?"),
    );
    const panel = screen.getByTestId("open-items") as HTMLDetailsElement;
    const popover = document.createElement("div");
    popover.dataset.slot = "popover-content";
    document.body.append(popover);
    panel.open = true;

    fireEvent.pointerDown(panel.querySelector("summary")!);
    fireEvent.pointerDown(popover);
    expect(panel.open).toBe(true);
    fireEvent.pointerDown(document.body);
    expect(panel.open).toBe(false);
    popover.remove();
  });

  it("hides until the transcript uses labels", () => {
    renderPanel(indexOf("Use [A4] paper."));
    expect(screen.queryByTestId("open-items")).toBeNull();
  });

  it("shows as many header chips as fit the row, then +N", () => {
    const observers: ResizeObserverCallback[] = [];
    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor(callback: ResizeObserverCallback) {
          observers.push(callback);
        }
        observe() {}
        disconnect() {}
      },
    );
    // jsdom does no layout: chips measure 30px, the "+N" count 20px.
    let rowWidth = 100;
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(() => rowWidth);
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (
      this: HTMLElement,
    ) {
      return { width: this.textContent?.startsWith("+") ? 20 : 30 } as DOMRect;
    });
    const labels = ["Q1", "Q2", "Q3", "Q4", "Q5"];
    renderPanel(indexOf(labels.map((label) => `- [${label}] Item.`).join("\n")));

    // Each item has a row in the expanded list, plus a header chip when shown.
    const headerChipCount = () => screen.getAllByRole("button", { name: /^Show item/ }).length - 5;
    expect(headerChipCount()).toBe(2);
    expect(screen.getByText("+3")).toBeTruthy();

    rowWidth = 200;
    act(() => observers.forEach((callback) => callback([], {} as ResizeObserver)));
    expect(headerChipCount()).toBe(5);
    expect(screen.queryByText("+3")).toBeNull();
  });
});

describe("fitItemChipCount", () => {
  it("fits chips and gaps, reserving room for +N only when some are left out", () => {
    // All three fit without a count: 30 + 4 + 30 + 4 + 30.
    expect(fitItemChipCount([30, 30, 30], 98, 4, 20)).toBe(3);
    // Two then the count: 30 + 4 + 30 + 4 + 20.
    expect(fitItemChipCount([30, 30, 30], 97, 4, 20)).toBe(2);
    expect(fitItemChipCount([30, 30, 30], 87, 4, 20)).toBe(1);
    expect(fitItemChipCount([60, 30], 50, 4, 20)).toBe(0);
    expect(fitItemChipCount([], 50, 4, 20)).toBe(0);
  });
});
