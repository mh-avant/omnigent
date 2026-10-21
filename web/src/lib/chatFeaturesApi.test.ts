import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  type ChatFeatureDefault,
  effectiveChatFeatureDefault,
  getChatFeatureCatalog,
  getChatFeatureDefault,
  saveChatFeatureDefault,
  UNSUPPORTED_CHAT_FEATURE_DEFAULT,
} from "./chatFeaturesApi";
import { authenticatedFetch } from "./identity";

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
const KEY = { kind: "chat_features", name: "default" };
const CATALOG = [{ key: "run_commands", title: "Run suggested commands", description: "Run" }];

function snapshot(
  value: string[] | null,
  version: number,
  conflicts: { operation_id: string; value: string[] | null }[] = [],
) {
  return {
    protocol_version: 1,
    identity: IDENTITY,
    revision: version + conflicts.length,
    entries: version === 0 ? [] : [{ key: KEY, version, value, installation_id: "web-x" }],
    conflicts: conflicts.map((conflict) => ({
      protocol_version: 1,
      identity: IDENTITY,
      installation_id: "web-y",
      key: KEY,
      expected_version: 0,
      resolves: [],
      ...conflict,
    })),
    next_cursor: null,
  };
}

function current(saved: string[] | null, version: number): ChatFeatureDefault {
  return { supported: true, saved, version, conflicts: [], identity: IDENTITY };
}

/** Bodies of the operations the client posted. */
function postedOperations(): Record<string, unknown>[] {
  return mockAuthenticatedFetch.mock.calls
    .filter(([, init]) => (init as RequestInit | undefined)?.method === "POST")
    .map(([, init]) => JSON.parse((init as RequestInit).body as string));
}

describe("chat features API", () => {
  beforeEach(() => {
    mockAuthenticatedFetch.mockReset();
  });

  it("reads the catalog", async () => {
    mockAuthenticatedFetch.mockResolvedValueOnce(mockJsonResponse({ available: CATALOG }));
    await expect(getChatFeatureCatalog()).resolves.toEqual(CATALOG);
    expect(mockAuthenticatedFetch).toHaveBeenCalledWith("/v1/chat-features");
  });

  it("reports an unsupported default when the server has no shared preferences", async () => {
    mockAuthenticatedFetch.mockResolvedValueOnce(mockJsonResponse({ detail: "Not Found" }, 404));
    await expect(getChatFeatureDefault()).resolves.toEqual(UNSUPPORTED_CHAT_FEATURE_DEFAULT);
  });

  it("reads the saved keys, unknown ones included, with competing edits", async () => {
    mockAuthenticatedFetch.mockResolvedValueOnce(
      mockJsonResponse(
        snapshot(["from_newer_build", "run_commands"], 2, [{ operation_id: "op-1", value: [] }]),
      ),
    );
    await expect(getChatFeatureDefault()).resolves.toEqual({
      supported: true,
      saved: ["from_newer_build", "run_commands"],
      version: 2,
      conflicts: [{ operationId: "op-1", value: [] }],
      identity: IDENTITY,
    });
  });

  it("limits the effective default to the catalog; null means every feature", () => {
    expect(effectiveChatFeatureDefault(null, CATALOG)).toEqual(["run_commands"]);
    expect(effectiveChatFeatureDefault(["from_newer_build"], CATALOG)).toEqual([]);
  });

  it("saves with the current version and resolves listed conflicts", async () => {
    mockAuthenticatedFetch
      .mockResolvedValueOnce(mockJsonResponse({ status: "applied" }))
      .mockResolvedValueOnce(mockJsonResponse(snapshot([], 3)));
    const base = {
      ...current(["run_commands"], 2),
      conflicts: [{ operationId: "op-1", value: null }],
    };

    await expect(saveChatFeatureDefault([], base)).resolves.toMatchObject({
      saved: [],
      version: 3,
    });
    const [operation] = postedOperations();
    expect(operation).toMatchObject({
      protocol_version: 1,
      identity: IDENTITY,
      key: KEY,
      expected_version: 2,
      value: [],
      resolves: ["op-1"],
    });
    expect(operation.installation_id).toMatch(/^web-/);
  });

  it("re-reads and retries once when another edit landed first", async () => {
    mockAuthenticatedFetch
      .mockResolvedValueOnce(mockJsonResponse({ status: "conflict" }))
      .mockResolvedValueOnce(
        mockJsonResponse(snapshot(["run_commands"], 2, [{ operation_id: "mine", value: [] }])),
      )
      .mockResolvedValueOnce(mockJsonResponse({ status: "applied" }))
      .mockResolvedValueOnce(mockJsonResponse(snapshot([], 3)));

    await expect(saveChatFeatureDefault([], current(null, 1))).resolves.toMatchObject({
      saved: [],
      conflicts: [],
    });
    const [first, retry] = postedOperations();
    expect(first).toMatchObject({ expected_version: 1, resolves: [] });
    expect(retry).toMatchObject({ expected_version: 2, resolves: ["mine"] });
    expect(retry.operation_id).not.toBe(first.operation_id);
  });

  it("retries a 409 once and then gives up", async () => {
    const stale = mockJsonResponse({ error: { message: "version is ahead" } }, 409);
    mockAuthenticatedFetch
      .mockResolvedValueOnce(stale)
      .mockResolvedValueOnce(mockJsonResponse(snapshot(["run_commands"], 1)))
      .mockResolvedValueOnce(stale)
      .mockResolvedValueOnce(mockJsonResponse(snapshot(["run_commands"], 1)));

    await expect(saveChatFeatureDefault([], current(null, 5))).rejects.toThrow(
      "Another device changed",
    );
    expect(postedOperations().map((operation) => operation.expected_version)).toEqual([5, 1]);
  });

  it("refuses to save when the server has no shared preferences", async () => {
    await expect(saveChatFeatureDefault([], UNSUPPORTED_CHAT_FEATURE_DEFAULT)).rejects.toThrow(
      "not enabled",
    );
    expect(mockAuthenticatedFetch).not.toHaveBeenCalled();
  });
});
