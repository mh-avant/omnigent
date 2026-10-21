// The composer's "Watch PRs" control against the real watch hooks, with fetch
// stubbed as a small in-memory server and the PR panel data mocked.

import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { PullRequestWatchStatus } from "@/hooks/usePullRequestWatch";
import type * as UsePullRequestsModule from "@/hooks/usePullRequests";
import { FALLBACK_SERVER_INFO } from "@/lib/capabilities";
import { CapabilitiesProvider } from "@/lib/CapabilitiesContext";
import { ComposerPrWatch, prWatchLabel } from "./ComposerPrWatch";

const PR_7 = "https://github.com/acme/app/pull/7";
const PR_9 = "https://github.com/acme/app/pull/9";
const PR_5 = "https://github.com/acme/app/pull/5";
const WATCH_PATH = "/v1/sessions/conv_1/pr-watch";

const state = vi.hoisted(() => ({
  canEdit: true,
  offline: false,
  tracked: [] as string[],
  details: {} as Record<string, { state: string; failing: number; title: string }>,
}));

vi.mock("@/hooks/usePermissions", () => ({ useCanEdit: () => state.canEdit }));
vi.mock("@/hooks/usePullRequests", async (importOriginal) => ({
  ...(await importOriginal<typeof UsePullRequestsModule>()),
  usePullRequestInfo: (_conversationId: string, options?: { prUrl?: string }) => {
    if (state.offline) return { data: undefined, isError: true };
    const prUrl = options?.prUrl;
    if (!prUrl) {
      return {
        data: {
          object: "session.github.info",
          available: true,
          tracking_available: true,
          prs: state.tracked.map((url) => ({
            url,
            host: "github.com",
            repository: "acme/app",
            number: Number(url.split("/").pop()),
            title: state.details[url]?.title,
            relationship: "created",
          })),
        },
        isError: false,
      };
    }
    const detail = state.details[prUrl];
    return {
      data: {
        object: "session.github.info",
        available: true,
        pr: {
          url: prUrl,
          number: Number(prUrl.split("/").pop()),
          title: detail.title,
          state: detail.state,
          checks: { passing: 0, failing: detail.failing, pending: 0, total: 1, runs: [] },
        },
      },
      isError: false,
    };
  },
}));

let server: PullRequestWatchStatus;
let calls: string[];

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

function entry(prUrl: string) {
  return { pr_url: prUrl, watching: true, ended: null, wakes: 1, max_wakes: 10, started_at: 1 };
}

beforeEach(() => {
  state.canEdit = true;
  state.offline = false;
  state.tracked = [PR_7, PR_9, PR_5];
  state.details = {
    [PR_7]: { state: "OPEN", failing: 2, title: "Fix the parser" },
    [PR_9]: { state: "OPEN", failing: 0, title: "Add docs" },
    [PR_5]: { state: "MERGED", failing: 0, title: "Old work" },
  };
  server = { object: "session.pr_watch", mode: "off", active: false, max_wakes: 10, prs: [] };
  calls = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), "http://localhost");
      if (url.pathname !== WATCH_PATH) return Promise.resolve(json({}, 404));
      const method = init?.method ?? "GET";
      const body = init?.body ? JSON.parse(String(init.body)) : null;
      calls.push(body ? `${method} ${JSON.stringify(body)}` : method);
      if (method === "PUT") {
        // As after the next poll: open PRs enrolled, the merged one noted as ended.
        const merged = { ...entry(PR_5), watching: false, ended: "merged" as const };
        server = { ...server, mode: "all", active: true, prs: [entry(PR_7), entry(PR_9), merged] };
      } else if (method === "PATCH" && body.watch) {
        server = { ...server, mode: "selected", active: true, prs: [entry(body.pr_url)] };
      } else if (method === "PATCH") {
        const prs = server.prs.filter((pr) => pr.pr_url !== body.pr_url);
        server = { ...server, mode: prs.length ? "selected" : "off", active: !!prs.length, prs };
      } else if (method === "DELETE") {
        server = { ...server, mode: "off", active: false, prs: [] };
      }
      return Promise.resolve(json(server));
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function renderControl(enabled = true) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <CapabilitiesProvider
        info={{ ...FALLBACK_SERVER_INFO, features: enabled ? { pr_watch: true } : {} }}
      >
        <ComposerPrWatch conversationId="conv_1" />
      </CapabilitiesProvider>
    </QueryClientProvider>,
  );
}

async function openPopover() {
  fireEvent.click(await screen.findByTestId("composer-pr-watch"));
  return screen.findByTestId("composer-pr-watch-popover");
}

it("renders nothing and asks nothing while the feature is off", () => {
  const { container } = renderControl(false);
  expect(container).toBeEmptyDOMElement();
  expect(calls).toEqual([]);
});

it("watches every PR, then drops one and keeps the rest", async () => {
  renderControl();
  expect(await screen.findByTestId("composer-pr-watch")).toHaveTextContent("Watch PRs");
  const popover = await openPopover();

  // Open PRs only, each with its CI state.
  const rows = within(popover).getAllByTestId("pr-watch-row");
  expect(rows.map((row) => row.textContent)).toEqual([
    expect.stringContaining("#7Fix the parser2 failing"),
    expect.stringContaining("#9Add docspassing"),
  ]);
  expect(popover).toHaveTextContent("comments from collaborators; stops when green");

  fireEvent.click(within(popover).getByTestId("pr-watch-all"));
  await waitFor(() =>
    expect(screen.getByTestId("composer-pr-watch")).toHaveTextContent("Watching 2 PRs"),
  );
  expect(within(popover).getByTestId("pr-watch-all")).toHaveAttribute("aria-checked", "true");
  const boxes = within(popover).getAllByRole("checkbox", { name: /Watch #/ });
  expect(boxes.map((box) => box.getAttribute("aria-checked"))).toEqual(["true", "true"]);
  expect(popover).toHaveTextContent("1/10 wake-ups");

  fireEvent.click(within(popover).getByRole("checkbox", { name: "Watch #9" }));
  await waitFor(() =>
    expect(screen.getByTestId("composer-pr-watch")).toHaveTextContent("Watching 1 PR"),
  );
  expect(within(popover).getByTestId("pr-watch-all")).toHaveAttribute("aria-checked", "false");
  expect(calls).toEqual(["GET", 'PUT {"mode":"all"}', `PATCH {"pr_url":"${PR_9}","watch":false}`]);
});

it("watches one PR on its own", async () => {
  renderControl();
  const popover = await openPopover();
  fireEvent.click(within(popover).getByRole("checkbox", { name: "Watch #7" }));
  await waitFor(() =>
    expect(screen.getByTestId("composer-pr-watch")).toHaveTextContent("Watching 1 PR"),
  );
  expect(calls).toContain(`PATCH {"pr_url":"${PR_7}","watch":true}`);
});

it.each([
  ["a viewer", () => (state.canEdit = false), "Only people who can edit this session"],
  ["an offline host", () => (state.offline = true), "host is offline"],
])("is disabled with a reason for %s", async (_name, arrange, reason) => {
  arrange();
  renderControl();
  const popover = await openPopover();
  expect(within(popover).getByTestId("pr-watch-all")).toBeDisabled();
  expect(within(popover).getByRole("note")).toHaveTextContent(reason);
});

it("labels the chip from the watched PRs", () => {
  const status: PullRequestWatchStatus = {
    object: "session.pr_watch",
    mode: "all",
    active: true,
    max_wakes: 10,
    prs: [{ ...entry(PR_9), watching: false, ended: "green" }],
  };
  expect(prWatchLabel(undefined, [PR_7])).toBe("Watch PRs");
  expect(prWatchLabel(status, [])).toBe("Watching new PRs");
  expect(prWatchLabel(status, [PR_7, PR_9])).toBe("Watching 1 PR");
  expect(prWatchLabel({ ...status, mode: "off", active: false }, [PR_7])).toBe("Watch PRs");
});
