// Touch text selection for the terminal. xterm only selects with a mouse, so
// a long-press selects the word under the finger through xterm's public
// select() API, drag handles adjust the range, and the view draws the menu.

import type { IBufferLine, IDisposable, Terminal } from "@xterm/xterm";

/** How long a still finger must rest before the word under it is selected. */
export const TOUCH_SELECT_LONG_PRESS_MS = 450;

/** Character-grid geometry in client (viewport) coordinates. */
export interface TouchGridMetrics {
  left: number;
  top: number;
  cellWidth: number;
  cellHeight: number;
  cols: number;
  rows: number;
}

/** A boundary between cells: ``col`` in 0..cols, ``row`` an absolute buffer line. */
export interface CellBoundary {
  col: number;
  row: number;
}

/** Half-open range between two boundaries, ``start`` before ``end``. */
export interface CellRange {
  start: CellBoundary;
  end: CellBoundary;
}

export type TouchSelectionHandle = "start" | "end";

/** What the view draws, in client coordinates. */
export interface TouchSelectionSnapshot {
  /** Each handle's anchor (boundary x, row bottom), or null while scrolled out of view. */
  start: { x: number; y: number } | null;
  end: { x: number; y: number } | null;
  /** Vertical extent of the visible selection, or of the pressed row when nothing is selected. */
  top: number;
  bottom: number;
  cellHeight: number;
  hasSelection: boolean;
  /** A finger is adjusting the range; the menu stays hidden until it lifts. */
  dragging: boolean;
}

export type TouchSelectionListener = (snapshot: TouchSelectionSnapshot | null) => void;

export function compareBoundaries(a: CellBoundary, b: CellBoundary): number {
  return a.row - b.row || a.col - b.col;
}

/** Cell count xterm's ``select(col, row, length)`` needs to cover the range. */
export function rangeLength(range: CellRange, cols: number): number {
  return (range.end.row - range.start.row) * cols + range.end.col - range.start.col;
}

/** The cell under a point (long-press target), clamped to the grid. */
export function cellAt(x: number, y: number, grid: TouchGridMetrics, viewportY: number) {
  return {
    col: clamp(Math.floor((x - grid.left) / grid.cellWidth), 0, grid.cols - 1),
    row: clamp(Math.floor((y - grid.top) / grid.cellHeight), 0, grid.rows - 1) + viewportY,
  };
}

/** The boundary nearest a point on the row under it (handle drags). */
export function boundaryAt(
  x: number,
  y: number,
  grid: TouchGridMetrics,
  viewportY: number,
): CellBoundary {
  return {
    col: clamp(Math.round((x - grid.left) / grid.cellWidth), 0, grid.cols),
    row: clamp(Math.floor((y - grid.top) / grid.cellHeight), 0, grid.rows - 1) + viewportY,
  };
}

/**
 * Columns ``[start, end)`` of the word covering ``col``, or null on blank or
 * separator cells. The trailing half of a wide character joins its word.
 */
export function wordRangeAt(
  line: IBufferLine | undefined,
  col: number,
  separators: string,
): { start: number; end: number } | null {
  if (!line) return null;
  const isWordCell = (x: number) => {
    const cell = line.getCell(x);
    if (!cell) return false;
    if (cell.getWidth() === 0) return true;
    const chars = cell.getChars();
    return chars.trim() !== "" && !separators.includes(chars);
  };
  if (!isWordCell(col)) return null;
  let start = col;
  while (start > 0 && isWordCell(start - 1)) start -= 1;
  let end = col + 1;
  while (end < line.length && isWordCell(end)) end += 1;
  return { start, end };
}

/** Grow a pressed word toward a dragging finger without ever dropping the word. */
export function extendRange(anchor: CellRange, point: CellBoundary): CellRange {
  if (compareBoundaries(point, anchor.start) < 0) return { start: point, end: anchor.end };
  if (compareBoundaries(point, anchor.end) > 0) return { start: anchor.start, end: point };
  return anchor;
}

/** The range spanned by a dragged handle and the opposite, fixed end. */
export function spanRange(fixed: CellBoundary, point: CellBoundary): CellRange | null {
  const order = compareBoundaries(point, fixed);
  if (order === 0) return null;
  return order < 0 ? { start: point, end: fixed } : { start: fixed, end: point };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/**
 * Long-press / handle-drag state machine over one xterm instance. The owning
 * session forwards its container's touch events; the view subscribes to
 * snapshots and calls back for handle drags and menu actions.
 */
export class TerminalTouchSelection {
  private readonly term: Terminal;
  private readonly grid: () => TouchGridMetrics | null;
  private readonly disposables: IDisposable[];
  private listener: TouchSelectionListener | null = null;
  private pressTimer: number | null = null;
  private pressPoint: { x: number; y: number } | null = null;
  /** The pressed word (or cell); a drag that follows the long-press extends it. */
  private pressAnchor: CellRange | null = null;
  private longPressed = false;
  /** The selection mode is showing (handles and/or the menu). */
  private active = false;
  /** Absolute row the menu tracks after a long-press on a blank cell. */
  private menuRow: number | null = null;
  private dragging = false;
  private dragFixed: CellBoundary | null = null;
  private grabOffset = { dx: 0, dy: 0 };
  private frame = 0;

  constructor(term: Terminal, grid: () => TouchGridMetrics | null) {
    this.term = term;
    this.grid = grid;
    this.disposables = [
      // xterm clears the selection itself on resize, buffer switches and
      // mouse-mode changes; the handles and menu go with it.
      term.onSelectionChange(() => {
        if (this.active && this.menuRow === null && !term.hasSelection()) this.dismiss();
        else this.schedule();
      }),
      term.onScroll(() => this.schedule()),
      term.onRender(() => this.schedule()),
    ];
  }

  setListener(listener: TouchSelectionListener | null): void {
    this.listener = listener;
    listener?.(this.active ? this.snapshot() : null);
  }

  get isActive(): boolean {
    return this.active;
  }

  /** A single finger touched the terminal: arm the long-press. */
  touchStart(x: number, y: number): void {
    this.cancelPress();
    this.longPressed = false;
    this.pressPoint = { x, y };
    this.pressTimer = window.setTimeout(() => this.longPress(), TOUCH_SELECT_LONG_PRESS_MS);
  }

  /**
   * The finger moved. Returns true while a long-press owns the gesture (the
   * caller must not scroll); before that, any move the caller treats as a
   * scroll should call {@link cancelPress}.
   */
  touchMove(x: number, y: number): boolean {
    if (!this.longPressed) return false;
    const grid = this.grid();
    if (grid === null) return true;
    const point = boundaryAt(x, y, grid, this.term.buffer.active.viewportY);
    if (this.pressAnchor === null) {
      // A long-press on a blank cell: dragging starts a selection from it.
      const cell = cellAt(this.pressPoint!.x, this.pressPoint!.y, grid, viewportYOf(this.term));
      this.pressAnchor = { start: cell, end: { col: cell.col + 1, row: cell.row } };
    }
    this.dragging = true;
    this.menuRow = null;
    this.selectRange(extendRange(this.pressAnchor, point));
    return true;
  }

  /** The finger lifted. Returns true when it ended a long-press (suppress the tap). */
  touchEnd(): boolean {
    const wasLongPress = this.longPressed;
    this.cancelPress();
    if (wasLongPress) {
      this.dragging = false;
      this.emit();
      return true;
    }
    return false;
  }

  /** The gesture became a scroll or a multi-touch: never fire the long-press. */
  cancelPress(): void {
    if (this.pressTimer !== null) window.clearTimeout(this.pressTimer);
    this.pressTimer = null;
    this.longPressed = false;
    this.pressAnchor = null;
  }

  /** A plain tap on the terminal while selecting dismisses the selection. */
  tap(): void {
    if (this.active) this.clear();
  }

  beginHandleDrag(handle: TouchSelectionHandle, x: number, y: number): void {
    const pos = this.term.getSelectionPosition();
    const grid = this.grid();
    if (!pos || grid === null) return;
    const start = { col: pos.start.x, row: pos.start.y };
    const end = { col: pos.end.x, row: pos.end.y };
    const moving = handle === "start" ? start : end;
    this.dragFixed = handle === "start" ? end : start;
    // Track the handle's own boundary, not the fingertip, so it never jumps.
    const viewportY = viewportYOf(this.term);
    this.grabOffset = {
      dx: x - (grid.left + moving.col * grid.cellWidth),
      dy: y - (grid.top + (moving.row - viewportY + 0.5) * grid.cellHeight),
    };
    this.dragging = true;
    this.emit();
  }

  dragHandle(x: number, y: number): void {
    const grid = this.grid();
    if (!this.dragging || this.dragFixed === null || grid === null) return;
    const px = x - this.grabOffset.dx;
    const py = y - this.grabOffset.dy;
    // Past the top or bottom edge, scroll the scrollback toward the finger.
    if (py < grid.top) this.term.scrollLines(-1);
    else if (py > grid.top + grid.rows * grid.cellHeight) this.term.scrollLines(1);
    const range = spanRange(this.dragFixed, boundaryAt(px, py, grid, viewportYOf(this.term)));
    if (range !== null) this.selectRange(range);
  }

  endHandleDrag(): void {
    this.dragging = false;
    this.dragFixed = null;
    this.emit();
  }

  /** Select every row currently on screen. */
  selectScreen(): void {
    const top = viewportYOf(this.term);
    this.menuRow = null;
    this.active = true;
    this.term.selectLines(top, top + this.term.rows - 1);
    this.emit();
  }

  selectionText(): string {
    return this.term.getSelection();
  }

  clear(): void {
    this.dismiss();
    this.term.clearSelection();
  }

  dispose(): void {
    this.cancelPress();
    if (this.frame) window.cancelAnimationFrame(this.frame);
    for (const d of this.disposables) d.dispose();
    this.listener = null;
  }

  private longPress(): void {
    this.pressTimer = null;
    const grid = this.grid();
    if (this.pressPoint === null || grid === null) return;
    this.longPressed = true;
    this.active = true;
    const cell = cellAt(this.pressPoint.x, this.pressPoint.y, grid, viewportYOf(this.term));
    const line = this.term.buffer.active.getLine(cell.row);
    const word = wordRangeAt(line, cell.col, this.term.options.wordSeparator ?? " ");
    if (word === null) {
      // Nothing to select: offer the menu (Paste, Select screen) at the press.
      this.pressAnchor = null;
      this.menuRow = cell.row;
      this.term.clearSelection();
      this.emit();
      return;
    }
    this.menuRow = null;
    this.pressAnchor = {
      start: { col: word.start, row: cell.row },
      end: { col: word.end, row: cell.row },
    };
    this.selectRange(this.pressAnchor);
  }

  private selectRange(range: CellRange): void {
    this.term.select(range.start.col, range.start.row, rangeLength(range, this.term.cols));
    this.emit();
  }

  private dismiss(): void {
    const wasActive = this.active;
    this.active = false;
    this.dragging = false;
    this.dragFixed = null;
    this.menuRow = null;
    if (wasActive) this.listener?.(null);
  }

  /** Coalesce scroll/render bursts into one snapshot per frame. */
  private schedule(): void {
    if (!this.active || this.frame) return;
    this.frame = window.requestAnimationFrame(() => {
      this.frame = 0;
      this.emit();
    });
  }

  private emit(): void {
    if (this.active) this.listener?.(this.snapshot());
  }

  private snapshot(): TouchSelectionSnapshot | null {
    const grid = this.grid();
    if (grid === null) return null;
    const viewportY = viewportYOf(this.term);
    const lastRow = viewportY + grid.rows - 1;
    const rowTop = (row: number) => grid.top + (row - viewportY) * grid.cellHeight;
    const visible = (row: number) => row >= viewportY && row <= lastRow;
    const pos = this.term.getSelectionPosition();
    if (pos) {
      const anchor = (col: number, row: number) =>
        visible(row)
          ? { x: grid.left + col * grid.cellWidth, y: rowTop(row) + grid.cellHeight }
          : null;
      return {
        start: anchor(pos.start.x, pos.start.y),
        end: anchor(pos.end.x, pos.end.y),
        top: rowTop(clamp(pos.start.y, viewportY, lastRow)),
        bottom: rowTop(clamp(pos.end.y, viewportY, lastRow)) + grid.cellHeight,
        cellHeight: grid.cellHeight,
        hasSelection: true,
        dragging: this.dragging,
      };
    }
    if (this.menuRow === null) return null;
    const row = clamp(this.menuRow, viewportY, lastRow);
    return {
      start: null,
      end: null,
      top: rowTop(row),
      bottom: rowTop(row) + grid.cellHeight,
      cellHeight: grid.cellHeight,
      hasSelection: false,
      dragging: false,
    };
  }
}

function viewportYOf(term: Terminal): number {
  return term.buffer.active.viewportY;
}
