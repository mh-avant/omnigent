// Drag handles and the Copy / Paste / Select screen menu for a touch
// selection. Positions arrive in the terminal surface's local coordinates;
// the session owns the selection itself (see terminalTouchSelection.ts).

import { memo, type PointerEvent, type TouchEvent } from "react";
import type { TouchSelectionHandle, TouchSelectionSnapshot } from "./terminalTouchSelection";

/** Gap between the selection and the menu, in CSS px. */
const MENU_GAP_PX = 10;
/** Menu height used to decide whether it fits above the selection. */
const MENU_HEIGHT_PX = 40;
/** Extra clearance below the selection for the end handle's knob. */
const END_KNOB_CLEARANCE_PX = 14;

export interface TerminalTouchSelectionOverlayProps {
  snapshot: TouchSelectionSnapshot;
  canPaste: boolean;
  /** Handle color, matched to the terminal's selection highlight. */
  accent: string;
  onCopy: () => void;
  onPaste: () => void;
  onSelectScreen: () => void;
  onHandleDragStart: (handle: TouchSelectionHandle, x: number, y: number) => void;
  onHandleDrag: (x: number, y: number) => void;
  onHandleDragEnd: () => void;
}

// iOS moves focus to a tapped button even when pointerdown is prevented, which
// blurs the terminal and drops the soft keyboard; cancelling touchend stops it.
function keepTerminalFocus(e: PointerEvent | TouchEvent) {
  e.preventDefault();
}

export const TerminalTouchSelectionOverlay = memo(function TerminalTouchSelectionOverlay({
  snapshot,
  canPaste,
  accent,
  onCopy,
  onPaste,
  onSelectScreen,
  onHandleDragStart,
  onHandleDrag,
  onHandleDragEnd,
}: TerminalTouchSelectionOverlayProps) {
  const handle = (which: TouchSelectionHandle, anchor: { x: number; y: number } | null) => {
    if (anchor === null) return null;
    return (
      <div
        key={which}
        data-testid={`terminal-selection-handle-${which}`}
        aria-hidden
        className="pointer-events-auto absolute flex w-11 touch-none justify-center"
        style={{
          left: anchor.x - 22,
          top: anchor.y - snapshot.cellHeight - (which === "start" ? 14 : 0),
          height: snapshot.cellHeight + 14,
          flexDirection: which === "start" ? "column" : "column-reverse",
          alignItems: "center",
        }}
        onPointerDown={(e) => {
          if (!e.isPrimary) return;
          e.preventDefault();
          e.currentTarget.setPointerCapture(e.pointerId);
          onHandleDragStart(which, e.clientX, e.clientY);
        }}
        onPointerMove={(e) => {
          if (e.currentTarget.hasPointerCapture(e.pointerId)) onHandleDrag(e.clientX, e.clientY);
        }}
        onPointerUp={onHandleDragEnd}
        onPointerCancel={onHandleDragEnd}
        onTouchEnd={keepTerminalFocus}
      >
        <span className="size-3 shrink-0 rounded-full" style={{ backgroundColor: accent }} />
        <span className="w-0.5 flex-1" style={{ backgroundColor: accent }} />
      </div>
    );
  };

  const menuTop =
    snapshot.top - MENU_HEIGHT_PX - MENU_GAP_PX >= 0
      ? snapshot.top - MENU_HEIGHT_PX - MENU_GAP_PX
      : snapshot.bottom + MENU_GAP_PX + (snapshot.hasSelection ? END_KNOB_CLEARANCE_PX : 0);
  const actions = [
    snapshot.hasSelection ? { label: "Copy", run: onCopy } : null,
    canPaste ? { label: "Paste", run: onPaste } : null,
    { label: "Select screen", run: onSelectScreen },
  ].filter((action) => action !== null);

  return (
    <div
      className="pointer-events-none absolute inset-0 z-10"
      data-testid="terminal-touch-selection"
    >
      {handle("start", snapshot.start)}
      {handle("end", snapshot.end)}
      {!snapshot.dragging && (
        <div
          role="toolbar"
          aria-label="Terminal selection"
          className="pointer-events-auto absolute left-1/2 flex -translate-x-1/2 overflow-hidden rounded-lg border border-border bg-popover text-popover-foreground text-sm shadow-lg"
          style={{ top: menuTop, height: MENU_HEIGHT_PX }}
        >
          {actions.map((action, index) => (
            <button
              key={action.label}
              type="button"
              tabIndex={-1}
              className={
                "whitespace-nowrap px-3.5 active:bg-accent" +
                (index > 0 ? " border-l border-border" : "")
              }
              onPointerDown={keepTerminalFocus}
              // Touch acts on touchend: it is a user gesture for the clipboard,
              // and cancelling it suppresses the click that would run it twice.
              onTouchEnd={(e) => {
                e.preventDefault();
                action.run();
              }}
              onClick={action.run}
            >
              {action.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
});
