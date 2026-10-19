import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_SIDEBAR_FOCUS,
  isSidebarFocusActive,
  readSidebarFocus,
  writeSidebarFocus,
} from "./sidebarFocusPreferences";

afterEach(() => {
  localStorage.clear();
});

describe("sidebarFocusPreferences", () => {
  it("defaults to no filter when nothing is stored", () => {
    expect(readSidebarFocus()).toEqual(DEFAULT_SIDEBAR_FOCUS);
    expect(isSidebarFocusActive(DEFAULT_SIDEBAR_FOCUS)).toBe(false);
  });

  it("round-trips both filters", () => {
    const focus = { needsMe: true, recency: "week" } as const;
    writeSidebarFocus(focus);
    expect(readSidebarFocus()).toEqual(focus);
    expect(isSidebarFocusActive(focus)).toBe(true);
  });

  it("falls back per field on unknown or corrupt values", () => {
    localStorage.setItem(
      "omnigent:sidebar-focus",
      JSON.stringify({ needsMe: "yes", recency: "year" }),
    );
    expect(readSidebarFocus()).toEqual(DEFAULT_SIDEBAR_FOCUS);
    localStorage.setItem("omnigent:sidebar-focus", "{not json");
    expect(readSidebarFocus()).toEqual(DEFAULT_SIDEBAR_FOCUS);
  });
});
