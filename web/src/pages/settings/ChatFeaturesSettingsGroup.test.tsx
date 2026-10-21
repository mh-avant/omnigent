import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import { authenticatedFetch } from "@/lib/identity";
import { ChatFeaturesSettingsGroup } from "./ChatFeaturesSettingsGroup";

vi.mock("@/lib/identity", () => ({
  authenticatedFetch: vi.fn(),
}));

const mockAuthenticatedFetch = vi.mocked(authenticatedFetch);

const IDENTITY = { authority_id: "a", user_id: "local", workspace_id: "0" };
const KEY = { kind: "chat_features", name: "default" };

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: "",
    json: async () => body,
  } as unknown as Response;
}

function snapshot(
  value: string[] | null,
  version: number,
  conflicts: { operation_id: string; value: string[] | null }[] = [],
) {
  return {
    protocol_version: 1,
    identity: IDENTITY,
    revision: version,
    entries: version === 0 ? [] : [{ key: KEY, version, value }],
    conflicts: conflicts.map((conflict) => ({
      protocol_version: 1,
      identity: IDENTITY,
      installation_id: "web-other",
      key: KEY,
      expected_version: 0,
      resolves: [],
      ...conflict,
    })),
    next_cursor: null,
  };
}

/** Serve the catalog, then answer shared-preference reads and edits in order. */
function serve(sharedResponses: Response[], operationResponses: Response[] = []) {
  mockAuthenticatedFetch.mockImplementation(async (path, init) => {
    if (path === "/v1/chat-features") {
      return jsonResponse({
        available: [
          {
            key: "run_commands",
            title: "Run suggested commands",
            description: "Show a Run button on shell commands the agent suggests.",
          },
        ],
      });
    }
    const queue =
      (init as RequestInit | undefined)?.method === "POST" ? operationResponses : sharedResponses;
    const next = queue.shift();
    if (!next) throw new Error(`unexpected request ${String(path)}`);
    return next;
  });
}

function renderGroup() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <TooltipProvider>
        <ChatFeaturesSettingsGroup />
      </TooltipProvider>
    </QueryClientProvider>,
  );
}

function postedOperations(): Record<string, unknown>[] {
  return mockAuthenticatedFetch.mock.calls
    .filter(([, init]) => (init as RequestInit | undefined)?.method === "POST")
    .map(([, init]) => JSON.parse((init as RequestInit).body as string));
}

describe("ChatFeaturesSettingsGroup", () => {
  beforeEach(() => {
    mockAuthenticatedFetch.mockReset();
  });
  afterEach(cleanup);

  it("saves the default as a shared preference and shows the saved state", async () => {
    serve(
      [jsonResponse(snapshot(null, 0)), jsonResponse(snapshot([], 1))],
      [jsonResponse({ status: "applied" })],
    );
    renderGroup();

    const toggle = await screen.findByTestId("chat-feature-toggle-run_commands");
    expect(toggle).toHaveAttribute("aria-checked", "true");
    expect(toggle).not.toBeDisabled();
    fireEvent.click(toggle);

    await waitFor(() => expect(toggle).toHaveAttribute("aria-checked", "false"));
    expect(postedOperations()).toEqual([
      expect.objectContaining({ key: KEY, expected_version: 0, value: [], resolves: [] }),
    ]);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("keeps saved keys this build doesn't know", async () => {
    serve(
      [jsonResponse(snapshot(["from_newer_build"], 1)), jsonResponse(snapshot([], 2))],
      [jsonResponse({ status: "applied" })],
    );
    renderGroup();

    const toggle = await screen.findByTestId("chat-feature-toggle-run_commands");
    expect(toggle).toHaveAttribute("aria-checked", "false");
    fireEvent.click(toggle);

    await waitFor(() => expect(postedOperations()).toHaveLength(1));
    expect(postedOperations()[0].value).toEqual(["run_commands", "from_newer_build"]);
  });

  it("keeps the previous default and reports a failed save", async () => {
    serve(
      [jsonResponse(snapshot(["run_commands"], 1)), jsonResponse(snapshot(["run_commands"], 1))],
      [jsonResponse({ error: { message: "boom" } }, 500)],
    );
    renderGroup();

    const toggle = await screen.findByTestId("chat-feature-toggle-run_commands");
    fireEvent.click(toggle);

    expect(await screen.findByRole("alert")).toHaveTextContent("Couldn't save");
    expect(toggle).toHaveAttribute("aria-checked", "true");
  });

  it("disables the default and says why when the server has no shared preferences", async () => {
    serve([jsonResponse({ detail: "Not Found" }, 404)]);
    renderGroup();

    const toggle = await screen.findByTestId("chat-feature-toggle-run_commands");
    expect(toggle).toBeDisabled();
    expect(toggle).toHaveAttribute("aria-checked", "true");
    expect(screen.getByTestId("chat-features-shared-preferences-required")).toHaveTextContent(
      "needs shared preferences enabled on the server",
    );
  });

  it("shows competing values and resolves them with the one the user keeps", async () => {
    serve(
      [
        jsonResponse(snapshot(["run_commands"], 1, [{ operation_id: "op-other", value: [] }])),
        jsonResponse(snapshot([], 2)),
      ],
      [jsonResponse({ status: "applied" })],
    );
    renderGroup();

    const conflicts = await screen.findByTestId("chat-features-conflicts");
    expect(conflicts).toHaveTextContent("Current: Run suggested commands");
    expect(conflicts).toHaveTextContent("Other: None");
    fireEvent.click(screen.getByTestId("chat-features-keep-op-other"));

    await waitFor(() => expect(screen.queryByTestId("chat-features-conflicts")).toBeNull());
    expect(postedOperations()).toEqual([
      expect.objectContaining({ expected_version: 1, value: [], resolves: ["op-other"] }),
    ]);
  });
});
