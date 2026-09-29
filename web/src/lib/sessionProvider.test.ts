import { describe, expect, it } from "vitest";
import type { HostProvider } from "@/hooks/useHostProviders";
import { resolveSessionProvider } from "./sessionProvider";

const MAX1: HostProvider = {
  name: "max1",
  kind: "subscription",
  label: "a",
  default: true,
  ready: true,
};
const MAX2: HostProvider = { ...MAX1, name: "max2", label: "b", default: false };

const base = { userPick: undefined, projectProvider: undefined, accountsApply: true };

describe("resolveSessionProvider", () => {
  it("runs on the host default with no pick and no project account", () => {
    expect(resolveSessionProvider({ ...base, providers: [MAX1, MAX2] })).toEqual({
      override: null,
      projectFallback: null,
    });
  });

  it("uses the project's account when the host lists it", () => {
    expect(
      resolveSessionProvider({ ...base, projectProvider: "max2", providers: [MAX1, MAX2] }),
    ).toEqual({ override: "max2", projectFallback: null });
  });

  it("sends no override when the project's account is the host default", () => {
    expect(
      resolveSessionProvider({ ...base, projectProvider: "max1", providers: [MAX1, MAX2] }),
    ).toEqual({ override: null, projectFallback: null });
  });

  it("lets the user's pick win over the project's account", () => {
    expect(
      resolveSessionProvider({
        ...base,
        userPick: null,
        projectProvider: "max2",
        providers: [MAX1, MAX2],
      }),
    ).toEqual({ override: null, projectFallback: null });
  });

  it("falls back with a reason when the host can't run the harness on it", () => {
    const choice = resolveSessionProvider({
      ...base,
      projectProvider: "codex-alt",
      providers: [MAX1, MAX2],
    });
    expect(choice.override).toBeNull();
    expect(choice.projectFallback).toMatch(/"codex-alt" isn't available for this harness/);
  });

  it("falls back with a reason when the account is not signed in", () => {
    const choice = resolveSessionProvider({
      ...base,
      projectProvider: "max2",
      providers: [MAX1, { ...MAX2, ready: false }],
    });
    expect(choice.override).toBeNull();
    expect(choice.projectFallback).toMatch(/isn't signed in/);
  });

  it("sends the project's account while the list loads, for the host to check", () => {
    expect(
      resolveSessionProvider({ ...base, projectProvider: "max2", providers: undefined }),
    ).toEqual({ override: "max2", projectFallback: null });
  });

  it("says so when accounts don't apply to the session", () => {
    const choice = resolveSessionProvider({
      ...base,
      projectProvider: "max2",
      providers: undefined,
      accountsApply: false,
    });
    expect(choice.override).toBeNull();
    expect(choice.projectFallback).toMatch(/doesn't apply to sandbox or routed sessions/);
  });
});
