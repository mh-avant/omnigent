import { act, renderHook } from "@testing-library/react";
import type React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  HOVER_CLOSE_DELAY_MS,
  HOVER_OPEN_DELAY_MS,
  canHoverPreview,
  useHoverPopover,
} from "./useHoverPopover";

const mouse = { pointerType: "mouse" } as React.PointerEvent;
const touch = { pointerType: "touch" } as React.PointerEvent;

function stubHoverDevice(canHover: boolean) {
  vi.stubGlobal(
    "matchMedia",
    vi.fn((query: string) => ({ matches: canHover, media: query })),
  );
}

beforeEach(() => {
  vi.useFakeTimers();
  stubHoverDevice(true);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("canHoverPreview", () => {
  it("needs a mouse on a device whose primary pointer can hover", () => {
    expect(canHoverPreview(mouse)).toBe(true);
    expect(canHoverPreview(touch)).toBe(false);
    stubHoverDevice(false);
    expect(canHoverPreview(mouse)).toBe(false);
  });
});

describe("useHoverPopover", () => {
  it("opens after the hover delay and closes after leaving the trigger", () => {
    const { result } = renderHook(() => useHoverPopover(true));
    act(() => result.current.triggerProps.onPointerEnter(mouse));
    act(() => vi.advanceTimersByTime(HOVER_OPEN_DELAY_MS - 1));
    expect(result.current.open).toBe(false);
    act(() => vi.advanceTimersByTime(1));
    expect(result.current.open).toBe(true);
    expect(result.current.pinned).toBe(false);

    act(() => result.current.triggerProps.onPointerLeave(mouse));
    act(() => vi.advanceTimersByTime(HOVER_CLOSE_DELAY_MS));
    expect(result.current.open).toBe(false);
  });

  it("stays open while the pointer moves onto the popover", () => {
    const { result } = renderHook(() => useHoverPopover(true));
    act(() => result.current.triggerProps.onPointerEnter(mouse));
    act(() => vi.advanceTimersByTime(HOVER_OPEN_DELAY_MS));
    act(() => result.current.triggerProps.onPointerLeave(mouse));
    act(() => result.current.contentProps.onPointerEnter());
    act(() => vi.advanceTimersByTime(HOVER_CLOSE_DELAY_MS * 2));
    expect(result.current.open).toBe(true);
    act(() => result.current.contentProps.onPointerLeave(mouse));
    act(() => vi.advanceTimersByTime(HOVER_CLOSE_DELAY_MS));
    expect(result.current.open).toBe(false);
  });

  it("does not open when the pointer leaves before the delay", () => {
    const { result } = renderHook(() => useHoverPopover(true));
    act(() => result.current.triggerProps.onPointerEnter(mouse));
    act(() => result.current.triggerProps.onPointerLeave(mouse));
    act(() => vi.advanceTimersByTime(HOVER_OPEN_DELAY_MS));
    expect(result.current.open).toBe(false);
  });

  it("pins a hover preview on click, which then ignores leaving", () => {
    const { result } = renderHook(() => useHoverPopover(true));
    act(() => result.current.triggerProps.onPointerEnter(mouse));
    act(() => vi.advanceTimersByTime(HOVER_OPEN_DELAY_MS));
    const click = { preventDefault: vi.fn() } as unknown as React.MouseEvent;
    act(() => result.current.triggerProps.onClick(click));
    // The click is kept from toggling the popover shut.
    expect(click.preventDefault).toHaveBeenCalled();
    expect(result.current.pinned).toBe(true);
    act(() => result.current.triggerProps.onPointerLeave(mouse));
    act(() => vi.advanceTimersByTime(HOVER_CLOSE_DELAY_MS * 2));
    expect(result.current.open).toBe(true);

    act(() => result.current.onOpenChange(false));
    expect(result.current).toMatchObject({ open: false, pinned: false });
  });

  it("keeps focus in place for a hover preview but not for a click-opened popover", () => {
    const { result } = renderHook(() => useHoverPopover(true));
    const focusEvent = () => ({ preventDefault: vi.fn() }) as unknown as Event;
    act(() => result.current.triggerProps.onPointerEnter(mouse));
    act(() => vi.advanceTimersByTime(HOVER_OPEN_DELAY_MS));
    const hoverOpen = focusEvent();
    result.current.contentProps.onOpenAutoFocus(hoverOpen);
    expect(hoverOpen.preventDefault).toHaveBeenCalled();
    act(() => result.current.triggerProps.onPointerLeave(mouse));
    act(() => vi.advanceTimersByTime(HOVER_CLOSE_DELAY_MS));
    const hoverClose = focusEvent();
    result.current.contentProps.onCloseAutoFocus(hoverClose);
    expect(hoverClose.preventDefault).toHaveBeenCalled();

    act(() => result.current.onOpenChange(true));
    const clickOpen = focusEvent();
    result.current.contentProps.onOpenAutoFocus(clickOpen);
    expect(clickOpen.preventDefault).not.toHaveBeenCalled();
    act(() => result.current.onOpenChange(false));
    const clickClose = focusEvent();
    result.current.contentProps.onCloseAutoFocus(clickClose);
    expect(clickClose.preventDefault).not.toHaveBeenCalled();
  });

  it("ignores touch, devices without hover, and hover turned off", () => {
    const touchOnly = renderHook(() => useHoverPopover(true));
    act(() => touchOnly.result.current.triggerProps.onPointerEnter(touch));
    const clickOnly = renderHook(() => useHoverPopover(false));
    act(() => clickOnly.result.current.triggerProps.onPointerEnter(mouse));
    stubHoverDevice(false);
    const noHover = renderHook(() => useHoverPopover(true));
    act(() => noHover.result.current.triggerProps.onPointerEnter(mouse));
    act(() => vi.advanceTimersByTime(HOVER_OPEN_DELAY_MS));
    expect(touchOnly.result.current.open).toBe(false);
    expect(clickOnly.result.current.open).toBe(false);
    expect(noHover.result.current.open).toBe(false);
  });
});
