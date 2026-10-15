// Touch selection runs against a real xterm (as TerminalSession's tests do);
// jsdom has no layout, so the grid geometry is supplied directly.

import { Terminal } from "@xterm/xterm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  TOUCH_SELECT_LONG_PRESS_MS,
  TerminalTouchSelection,
  boundaryAt,
  extendRange,
  rangeLength,
  spanRange,
  wordRangeAt,
  type TouchGridMetrics,
  type TouchSelectionSnapshot,
} from "./terminalTouchSelection";

const CELL_W = 10;
const CELL_H = 20;
const grid: TouchGridMetrics = {
  left: 0,
  top: 0,
  cellWidth: CELL_W,
  cellHeight: CELL_H,
  cols: 20,
  rows: 5,
};

/** Client point at the middle of a cell. */
const at = (col: number, row: number) => [col * CELL_W + 5, row * CELL_H + 10] as const;

async function makeTerminal(text: string) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const term = new Terminal({ cols: grid.cols, rows: grid.rows, allowProposedApi: true });
  term.open(container);
  await new Promise<void>((resolve) => {
    term.write(text, resolve);
  });
  return term;
}

describe("touch selection geometry", () => {
  it("finds the word under a cell and nothing on blanks or separators", async () => {
    const term = await makeTerminal("git push (origin)  x\r\n你好 ok");
    const line = (row: number) => term.buffer.active.getLine(row);
    const separators = term.options.wordSeparator ?? " ";

    expect(wordRangeAt(line(0), 1, separators)).toEqual({ start: 0, end: 3 });
    expect(wordRangeAt(line(0), 12, separators)).toEqual({ start: 10, end: 16 });
    expect(wordRangeAt(line(0), 3, separators)).toBeNull(); // space
    expect(wordRangeAt(line(0), 9, separators)).toBeNull(); // "("
    // A wide character spans two cells; pressing either half takes both.
    expect(wordRangeAt(line(1), 1, separators)).toEqual({ start: 0, end: 4 });
    term.dispose();
  });

  it("maps points to cell boundaries and ranges to xterm select lengths", () => {
    expect(boundaryAt(34, 50, grid, 100)).toEqual({ col: 3, row: 102 });
    expect(boundaryAt(36, 50, grid, 100)).toEqual({ col: 4, row: 102 });
    // Clamped to the grid on every side.
    expect(boundaryAt(-40, -40, grid, 0)).toEqual({ col: 0, row: 0 });
    expect(boundaryAt(999, 999, grid, 0)).toEqual({ col: 20, row: 4 });

    const range = { start: { col: 15, row: 1 }, end: { col: 3, row: 2 } };
    expect(rangeLength(range, 20)).toBe(8);
  });

  it("extends a pressed word toward the finger without dropping the word", () => {
    const word = { start: { col: 4, row: 2 }, end: { col: 9, row: 2 } };
    expect(extendRange(word, { col: 6, row: 2 })).toBe(word);
    expect(extendRange(word, { col: 1, row: 1 })).toEqual({
      start: { col: 1, row: 1 },
      end: word.end,
    });
    expect(extendRange(word, { col: 12, row: 3 })).toEqual({
      start: word.start,
      end: { col: 12, row: 3 },
    });
  });

  it("orders a dragged handle against the fixed end and refuses an empty span", () => {
    const fixed = { col: 5, row: 1 };
    expect(spanRange(fixed, { col: 2, row: 1 })).toEqual({ start: { col: 2, row: 1 }, end: fixed });
    expect(spanRange(fixed, { col: 0, row: 2 })).toEqual({ start: fixed, end: { col: 0, row: 2 } });
    expect(spanRange(fixed, { col: 5, row: 1 })).toBeNull();
  });
});

describe("TerminalTouchSelection", () => {
  let term: Terminal;
  let selection: TerminalTouchSelection;
  let snapshots: (TouchSelectionSnapshot | null)[];

  beforeEach(async () => {
    term = await makeTerminal("hello world\r\nfoo-bar baz\r\n\r\nlast line");
    vi.useFakeTimers();
    selection = new TerminalTouchSelection(term, () => grid);
    snapshots = [];
    selection.setListener((s) => snapshots.push(s));
    // Subscribing reports the current (idle) state once.
    expect(snapshots).toEqual([null]);
    snapshots = [];
  });

  afterEach(() => {
    selection.dispose();
    term.dispose();
    vi.useRealTimers();
  });

  function longPress(col: number, row: number) {
    selection.touchStart(...at(col, row));
    vi.advanceTimersByTime(TOUCH_SELECT_LONG_PRESS_MS);
  }

  it("selects the word under a long-press and anchors a handle at each end", () => {
    longPress(8, 0);

    expect(term.getSelection()).toBe("world");
    expect(snapshots.at(-1)).toMatchObject({
      start: { x: 6 * CELL_W, y: CELL_H },
      end: { x: 11 * CELL_W, y: CELL_H },
      top: 0,
      bottom: CELL_H,
      hasSelection: true,
      dragging: false,
    });
    // Lifting the finger ends the long-press, which the caller must swallow.
    expect(selection.touchEnd()).toBe(true);
    expect(selection.isActive).toBe(true);
  });

  it("does nothing before the hold time, or once the finger starts scrolling", () => {
    selection.touchStart(...at(8, 0));
    vi.advanceTimersByTime(TOUCH_SELECT_LONG_PRESS_MS - 1);
    expect(selection.touchEnd()).toBe(false);
    vi.advanceTimersByTime(TOUCH_SELECT_LONG_PRESS_MS);
    expect(term.hasSelection()).toBe(false);

    selection.touchStart(...at(8, 0));
    selection.cancelPress();
    vi.advanceTimersByTime(TOUCH_SELECT_LONG_PRESS_MS);
    expect(term.hasSelection()).toBe(false);
    expect(snapshots).toEqual([]);
  });

  it("extends the pressed word as the same finger drags, then shows the menu on lift", () => {
    longPress(8, 0);

    expect(selection.touchMove(3 * CELL_W, 1 * CELL_H + 10)).toBe(true);
    expect(term.getSelection()).toBe("world\nfoo");
    expect(snapshots.at(-1)?.dragging).toBe(true);

    // Dragging back before the word keeps the word and grows to the left.
    selection.touchMove(2 * CELL_W, 10);
    expect(term.getSelection()).toBe("llo world");

    selection.touchEnd();
    expect(snapshots.at(-1)?.dragging).toBe(false);
  });

  it("offers the menu without handles when the long-press lands on a blank cell", () => {
    longPress(5, 2);

    expect(term.hasSelection()).toBe(false);
    expect(snapshots.at(-1)).toMatchObject({
      start: null,
      end: null,
      top: 2 * CELL_H,
      hasSelection: false,
    });
  });

  it("moves the dragged handle and lets it cross the fixed end", () => {
    longPress(8, 0);
    selection.touchEnd();

    // Grab the start handle a little below its boundary, as a finger would.
    selection.beginHandleDrag("start", 6 * CELL_W + 3, 40);
    selection.dragHandle(0 * CELL_W + 3, 40);
    expect(term.getSelection()).toBe("hello world");

    // Past the end handle, the dragged handle becomes the new end.
    selection.dragHandle(4 * CELL_W + 3, 40 + CELL_H);
    expect(term.getSelection()).toBe("\nfoo-");
    selection.endHandleDrag();
    expect(snapshots.at(-1)?.dragging).toBe(false);
  });

  it("selects the visible screen", () => {
    selection.selectScreen();
    expect(term.getSelection()).toBe("hello world\nfoo-bar baz\n\nlast line\n");
    expect(snapshots.at(-1)?.hasSelection).toBe(true);
  });

  it("dismisses on a tap, and when xterm drops the selection itself", () => {
    longPress(8, 0);
    selection.touchEnd();
    selection.tap();
    expect(term.hasSelection()).toBe(false);
    expect(snapshots.at(-1)).toBeNull();
    expect(selection.isActive).toBe(false);

    longPress(1, 1);
    selection.touchEnd();
    term.clearSelection();
    expect(snapshots.at(-1)).toBeNull();
    expect(selection.isActive).toBe(false);
  });
});
