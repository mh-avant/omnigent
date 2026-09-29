import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DropdownMenu, DropdownMenuContent } from "@/components/ui/dropdown-menu";
import type { HostProvider } from "@/hooks/useHostProviders";
import {
  buildAccountSection,
  currentProvider,
  inPlaceSwitchBlocked,
  SEPARATE_LOGIN_HINT,
} from "./accountSection";
import { ComposerConfigSections, type ComposerConfigSection } from "./ComposerConfigSections";

afterEach(cleanup);

const MAX1: HostProvider = {
  name: "claude-max1",
  kind: "subscription",
  label: "claude CLI login (~/.claude-max1)",
  default: true,
  ready: true,
  switch_group: "claude-accounts",
};
const MAX2: HostProvider = {
  ...MAX1,
  name: "claude-max2",
  label: "claude CLI login (~/.claude-max2)",
  default: false,
};
// Older hosts omit switch_group entirely.
const DBX: HostProvider = {
  name: "databricks",
  kind: "databricks",
  label: "Databricks profile alt",
  default: false,
  ready: true,
};

function renderSection(section: ComposerConfigSection | undefined) {
  return render(
    <DropdownMenu open>
      <DropdownMenuContent>
        <ComposerConfigSections extra={section ? [section] : []} />
      </DropdownMenuContent>
    </DropdownMenu>,
  );
}

describe("buildAccountSection", () => {
  it("is omitted without a real choice", () => {
    expect(
      buildAccountSection({ providers: [MAX1], value: null, testIdPrefix: "t", onSelect: vi.fn() }),
    ).toBeUndefined();
  });

  it("checks the default and maps picks to a name, or null for the default", () => {
    const onSelect = vi.fn();
    renderSection(
      buildAccountSection({
        providers: [MAX2, MAX1, DBX],
        value: null,
        testIdPrefix: "t",
        onSelect,
      }),
    );

    expect(screen.getByTestId("t-accounts")).toHaveTextContent(/^Account/);
    const first = screen.getAllByRole("menuitemcheckbox")[0];
    expect(first).toHaveTextContent("Default (claude-max1)");
    expect(first).toHaveAttribute("aria-checked", "true");
    fireEvent.click(screen.getByTestId("t-account-claude-max2"));
    expect(onSelect).toHaveBeenLastCalledWith("claude-max2");
  });

  it("sends null when going back to the default", () => {
    const onSelect = vi.fn();
    renderSection(
      buildAccountSection({
        providers: [MAX1, MAX2],
        value: "claude-max2",
        testIdPrefix: "t",
        onSelect,
      }),
    );

    expect(screen.getByTestId("t-account-claude-max2")).toHaveAttribute("aria-checked", "true");
    fireEvent.click(screen.getByTestId("t-account-claude-max1"));
    expect(onSelect).toHaveBeenLastCalledWith(null);
  });

  it("disables an account that is not signed in", () => {
    renderSection(
      buildAccountSection({
        providers: [MAX1, { ...MAX2, ready: false }],
        value: null,
        testIdPrefix: "t",
        onSelect: vi.fn(),
      }),
    );

    const option = screen.getByTestId("t-account-claude-max2");
    expect(option).toHaveAttribute("data-disabled");
    expect(option).toHaveTextContent("not signed in");
  });
});

describe("inPlaceSwitchBlocked", () => {
  it("allows only the running account's switch group", () => {
    const current = currentProvider([MAX1, MAX2, DBX], null);
    expect(current).toBe(MAX1);
    expect(inPlaceSwitchBlocked(MAX1, current)).toBeUndefined();
    expect(inPlaceSwitchBlocked(MAX2, current)).toBeUndefined();
    expect(inPlaceSwitchBlocked(DBX, current)).toBe(SEPARATE_LOGIN_HINT);
    expect(inPlaceSwitchBlocked({ ...MAX2, switch_group: "other" }, current)).toBe(
      SEPARATE_LOGIN_HINT,
    );
  });

  it("blocks every other account when the running one has no group", () => {
    const current = currentProvider([MAX1, MAX2, DBX], "databricks");
    expect(inPlaceSwitchBlocked(MAX1, current)).toBe(SEPARATE_LOGIN_HINT);
    expect(inPlaceSwitchBlocked(DBX, current)).toBeUndefined();
  });
});
