// The PR panel's "Watch until green" switch against the real hooks, with fetch
// stubbed: hidden without the feature, toggles one PR through PATCH, follows
// "all" mode, and shows the server's refusal.

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import { FALLBACK_SERVER_INFO } from "@/lib/capabilities";
import { CapabilitiesProvider } from "@/lib/CapabilitiesContext";
import { PullRequestWatchSwitch } from "./PullRequestWatch";

const PR_URL = "https://github.com/acme/app/pull/7";
const WATCH_PATH = "/v1/sessions/conv_1/pr-watch";

afterEach(() => vi.unstubAllGlobals());

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

function watchStatus(mode: "off" | "all" | "selected") {
  const prs =
    mode === "selected"
      ? [{ pr_url: PR_URL, watching: true, ended: null, wakes: 2, max_wakes: 10 }]
      : [];
  return { object: "session.pr_watch", mode, active: mode !== "off", max_wakes: 10, prs };
}

/** Stub the watch route; `patch` answers a watch request. */
function stubWatch(
  initial: "off" | "all" | "selected",
  patch: () => Response = () => json(watchStatus("selected")),
) {
  const calls: string[] = [];
  const fetch = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), "http://localhost");
    if (url.pathname !== WATCH_PATH) return Promise.resolve(json({}, 404));
    const method = init?.method ?? "GET";
    if (method === "GET") {
      calls.push(method);
      return Promise.resolve(json(watchStatus(initial)));
    }
    const body = JSON.parse(String(init?.body)) as { pr_url: string; watch: boolean };
    calls.push(`${method} ${body.pr_url} ${body.watch}`);
    return Promise.resolve(body.watch ? patch() : json(watchStatus("off")));
  });
  vi.stubGlobal("fetch", fetch);
  return calls;
}

function renderSwitch(enabled: boolean) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <CapabilitiesProvider
        info={{ ...FALLBACK_SERVER_INFO, features: enabled ? { pr_watch: true } : {} }}
      >
        <TooltipProvider>
          <PullRequestWatchSwitch conversationId="conv_1" prUrl={PR_URL} canEdit />
        </TooltipProvider>
      </CapabilitiesProvider>
    </QueryClientProvider>,
  );
}

it("renders nothing and asks nothing while the feature is off", () => {
  const calls = stubWatch("selected");
  const { container } = renderSwitch(false);
  expect(container).toBeEmptyDOMElement();
  expect(calls).toEqual([]);
});

it("starts and stops watching this PR", async () => {
  const calls = stubWatch("off");
  renderSwitch(true);

  const toggle = await screen.findByTestId("pr-watch-switch");
  expect(toggle).toHaveAttribute("aria-checked", "false");

  fireEvent.click(toggle);
  await waitFor(() => expect(toggle).toHaveAttribute("aria-checked", "true"));

  fireEvent.click(toggle);
  await waitFor(() => expect(toggle).toHaveAttribute("aria-checked", "false"));
  expect(calls).toEqual(["GET", `PATCH ${PR_URL} true`, `PATCH ${PR_URL} false`]);
});

it("shows the PR as watched while every PR is", async () => {
  stubWatch("all");
  renderSwitch(true);
  expect(await screen.findByTestId("pr-watch-switch")).toHaveAttribute("aria-checked", "true");
});

it("shows why the server refused to watch", async () => {
  stubWatch("off", () =>
    json({ error: { message: "Only open pull requests can be watched" } }, 409),
  );
  renderSwitch(true);

  fireEvent.click(await screen.findByTestId("pr-watch-switch"));

  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Only open pull requests can be watched",
  );
  expect(screen.getByTestId("pr-watch-switch")).toHaveAttribute("aria-checked", "false");
});
