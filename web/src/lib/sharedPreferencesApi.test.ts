import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { authenticatedFetch } from "./identity";
import {
  applySharedPreference,
  readSharedPreferences,
  type SharedPreferenceOperation,
  sharedPreferenceInstallationId,
} from "./sharedPreferencesApi";

vi.mock("./identity", () => ({
  authenticatedFetch: vi.fn(),
}));

const mockAuthenticatedFetch = vi.mocked(authenticatedFetch);

function mockJsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: "",
    json: async () => body,
  } as unknown as Response;
}

const IDENTITY = { authority_id: "a", user_id: "local", workspace_id: "0" };

function page(revision: number, name: string, nextCursor: string | null) {
  return {
    protocol_version: 1,
    identity: IDENTITY,
    revision,
    entries: [{ key: { kind: "model", name }, version: 1, value: name }],
    conflicts: [],
    next_cursor: nextCursor,
  };
}

const OPERATION: SharedPreferenceOperation = {
  protocol_version: 1,
  identity: IDENTITY,
  operation_id: "11111111-1111-4111-8111-111111111111",
  installation_id: "web-test",
  key: { kind: "chat_features", name: "default" },
  expected_version: 0,
  value: [],
  resolves: [],
};

describe("shared preferences API", () => {
  beforeEach(() => {
    mockAuthenticatedFetch.mockReset();
  });
  afterEach(() => {
    localStorage.clear();
  });

  it("returns null when the server has not enabled shared preferences", async () => {
    mockAuthenticatedFetch.mockResolvedValueOnce(mockJsonResponse({}, 404));
    await expect(readSharedPreferences()).resolves.toBeNull();
  });

  it("follows every page and restarts when an edit lands between pages", async () => {
    mockAuthenticatedFetch
      .mockResolvedValueOnce(mockJsonResponse(page(1, "model", "c1")))
      .mockResolvedValueOnce(mockJsonResponse({ error: { message: "restart" } }, 409))
      .mockResolvedValueOnce(mockJsonResponse(page(2, "model", "c2")))
      .mockResolvedValueOnce(mockJsonResponse(page(2, "opencode_model", null)));

    const snapshot = await readSharedPreferences();
    expect(snapshot?.revision).toBe(2);
    expect(snapshot?.entries.map((entry) => entry.key.name)).toEqual(["model", "opencode_model"]);
    expect(mockAuthenticatedFetch.mock.calls.map(([path]) => path)).toEqual([
      "/v1/preferences/shared",
      "/v1/preferences/shared?cursor=c1",
      "/v1/preferences/shared",
      "/v1/preferences/shared?cursor=c2",
    ]);
  });

  it("retries an unanswered edit once with the same operation", async () => {
    mockAuthenticatedFetch
      .mockRejectedValueOnce(new TypeError("network"))
      .mockResolvedValueOnce(mockJsonResponse({ status: "applied" }));

    await expect(applySharedPreference(OPERATION)).resolves.toMatchObject({ status: "applied" });
    const bodies = mockAuthenticatedFetch.mock.calls.map(([, init]) => (init as RequestInit).body);
    expect(bodies).toEqual([JSON.stringify(OPERATION), JSON.stringify(OPERATION)]);
  });

  it("keeps one installation ID per browser", () => {
    const first = sharedPreferenceInstallationId();
    expect(first).toMatch(/^web-/);
    expect(sharedPreferenceInstallationId()).toBe(first);
  });
});
