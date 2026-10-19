// Device-local "Needs me" and recency filters that narrow the sidebar to the
// sessions worth looking at. Independent of the My/Shared/All/Archived scope
// and of the flagged grouping options, so they compose with either.

const STORAGE_KEY = "omnigent:sidebar-focus";

/** How recently a session must have been updated to stay listed (a rolling window). */
export type SidebarRecency = "any" | "day" | "week" | "month";

export interface SidebarFocus {
  /** Only sessions with a pending approval or an unread agent reply. */
  needsMe: boolean;
  recency: SidebarRecency;
}

export const SIDEBAR_RECENCIES: readonly SidebarRecency[] = ["any", "day", "week", "month"];

export const DEFAULT_SIDEBAR_FOCUS: SidebarFocus = { needsMe: false, recency: "any" };

/** Whether either filter narrows the list. */
export function isSidebarFocusActive(focus: SidebarFocus): boolean {
  return focus.needsMe || focus.recency !== "any";
}

/**
 * Read the persisted filters. Each field falls back to its default on its own,
 * so a stale or hand-edited entry can't strand the viewer on a filter the menu
 * no longer offers. Never throws.
 */
export function readSidebarFocus(): SidebarFocus {
  if (typeof window === "undefined") return DEFAULT_SIDEBAR_FOCUS;
  let stored: Partial<Record<keyof SidebarFocus, unknown>>;
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? "null");
    if (typeof parsed !== "object" || parsed === null) return DEFAULT_SIDEBAR_FOCUS;
    stored = parsed;
  } catch {
    return DEFAULT_SIDEBAR_FOCUS;
  }
  return {
    needsMe: stored.needsMe === true,
    recency: SIDEBAR_RECENCIES.includes(stored.recency as SidebarRecency)
      ? (stored.recency as SidebarRecency)
      : DEFAULT_SIDEBAR_FOCUS.recency,
  };
}

/** Persist the filters. Swallows quota/access errors. */
export function writeSidebarFocus(value: SidebarFocus): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(value));
  } catch {
    // A local view preference; losing it is harmless.
  }
}
