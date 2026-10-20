// Open state for a click popover that also previews on desktop hover.
//
// Hovering the trigger with a mouse opens it after a short delay, and leaving
// both the trigger and the popover closes it. A click pins it open, so it then
// stays until dismissed like any popover. Touch input never hovers.

import { useCallback, useEffect, useRef, useState } from "react";
import type React from "react";

export const HOVER_OPEN_DELAY_MS = 300;
export const HOVER_CLOSE_DELAY_MS = 200;
const HOVER_QUERY = "(hover: hover) and (pointer: fine)";

/** Whether `event` comes from a mouse on a device whose primary pointer can hover. */
export function canHoverPreview(event: Pick<React.PointerEvent, "pointerType">): boolean {
  if (event.pointerType !== "mouse") return false;
  if (typeof window === "undefined" || !window.matchMedia) return false;
  return window.matchMedia(HOVER_QUERY).matches;
}

/**
 * Popover open state with a hover preview. Spread `triggerProps` on the
 * trigger and `contentProps` on the content; `hover` false keeps click only.
 */
export function useHoverPopover(hover: boolean) {
  const [open, setOpen] = useState(false);
  const [pinned, setPinned] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Whether the popover being closed had been pinned, so focus returns to the trigger.
  const restoreFocusRef = useRef(false);

  const clearTimer = useCallback(() => {
    if (timerRef.current === null) return;
    clearTimeout(timerRef.current);
    timerRef.current = null;
  }, []);
  useEffect(() => clearTimer, [clearTimer]);

  const schedule = (next: boolean, delay: number) => {
    clearTimer();
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      restoreFocusRef.current = false;
      setOpen(next);
    }, delay);
  };

  const onOpenChange = (next: boolean) => {
    clearTimer();
    restoreFocusRef.current = pinned;
    setOpen(next);
    setPinned(next);
  };

  const leave = (event: React.PointerEvent) => {
    if (!hover || event.pointerType !== "mouse" || pinned) return;
    if (open) schedule(false, HOVER_CLOSE_DELAY_MS);
    else clearTimer();
  };

  const triggerProps = {
    onClick: (event: React.MouseEvent) => {
      // A click on a hover preview pins it instead of toggling it shut.
      if (!open || pinned) return;
      event.preventDefault();
      clearTimer();
      setPinned(true);
    },
    onPointerEnter: (event: React.PointerEvent) => {
      if (!hover || !canHoverPreview(event)) return;
      if (open) clearTimer();
      else schedule(true, HOVER_OPEN_DELAY_MS);
    },
    onPointerLeave: leave,
  };

  const contentProps = {
    onPointerEnter: () => {
      if (open && !pinned) clearTimer();
    },
    onPointerLeave: leave,
    onPointerDown: () => {
      if (open && !pinned) setPinned(true);
    },
    // A hover preview leaves focus where it was, both opening and closing.
    onOpenAutoFocus: (event: Event) => {
      if (!pinned) event.preventDefault();
    },
    onCloseAutoFocus: (event: Event) => {
      if (!restoreFocusRef.current) event.preventDefault();
    },
  };

  return { open, pinned, onOpenChange, triggerProps, contentProps };
}
