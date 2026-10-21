// Which of a session's pull requests the server watches until they're green:
//
//   usePullRequestWatch     — GET    /v1/sessions/{id}/pr-watch
//   useSetPullRequestWatch  — PUT {mode: "all"} / PATCH one PR / DELETE (all off)
//
// The server polls the PRs and wakes the agent; the client only shows and
// changes the selection. Hidden unless the server enables the `pr_watch` feature.

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { errorFromResponse } from "@/hooks/usePullRequests";
import { useServerInfo } from "@/lib/CapabilitiesContext";
import { isFeatureEnabled } from "@/lib/capabilities";
import { authenticatedFetch } from "@/lib/identity";
import { isTempConvId } from "@/lib/tempConversationId";

/** Why a PR's watch ended. */
export type PullRequestWatchEnd =
  "green" | "merged" | "closed" | "checks_unreadable" | "budget" | "undeliverable";

export interface PullRequestWatchEntry {
  pr_url: string;
  watching: boolean;
  ended?: PullRequestWatchEnd | null;
  wakes: number;
  max_wakes: number;
  started_at?: number | null;
}

export interface PullRequestWatchStatus {
  object: "session.pr_watch";
  /** `all` also covers PRs the session opens later. */
  mode: "off" | "all" | "selected";
  active: boolean;
  /** Wake-up budget each newly watched PR gets. */
  max_wakes: number;
  prs: PullRequestWatchEntry[];
}

/** One change to the selection, from the composer control or the PR panel. */
export type PullRequestWatchChange =
  { kind: "all"; watch: boolean } | { kind: "pr"; prUrl: string; watch: boolean };

/** While a watch runs, refresh often enough to notice a PR's watch ending. */
const ACTIVE_WATCH_POLL_MS = 30_000;

function watchUrl(conversationId: string): string {
  return `/v1/sessions/${encodeURIComponent(conversationId)}/pr-watch`;
}

function watchKey(conversationId: string | undefined) {
  return ["pr-watch", conversationId];
}

/** Whether this server offers PR watching, so callers can hide the controls. */
export function usePullRequestWatchAvailable(conversationId: string | undefined | null): boolean {
  const serverInfo = useServerInfo();
  return (
    isFeatureEnabled(serverInfo, "pr_watch") && !!conversationId && !isTempConvId(conversationId)
  );
}

/** The entry for `prUrl`, if the session has watched it. */
export function pullRequestWatchEntry(
  status: PullRequestWatchStatus | undefined,
  prUrl: string,
): PullRequestWatchEntry | undefined {
  return status?.prs.find((entry) => entry.pr_url === prUrl);
}

/** Whether `prUrl` is watched now or, in "all" mode, will be on the next poll. */
export function isPullRequestWatched(
  status: PullRequestWatchStatus | undefined,
  prUrl: string,
): boolean {
  const entry = pullRequestWatchEntry(status, prUrl);
  return entry ? entry.watching : status?.mode === "all";
}

export function usePullRequestWatch(conversationId: string | undefined | null) {
  const enabled = usePullRequestWatchAvailable(conversationId);
  return useQuery({
    queryKey: watchKey(conversationId ?? undefined),
    enabled,
    queryFn: async (): Promise<PullRequestWatchStatus> => {
      const response = await authenticatedFetch(watchUrl(conversationId!));
      if (!response.ok) throw await errorFromResponse(response);
      return (await response.json()) as PullRequestWatchStatus;
    },
    refetchInterval: (query) => (query.state.data?.active ? ACTIVE_WATCH_POLL_MS : false),
  });
}

function requestFor(change: PullRequestWatchChange): RequestInit {
  const json = (method: string, body: unknown): RequestInit => ({
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (change.kind === "all") {
    return change.watch ? json("PUT", { mode: "all" }) : { method: "DELETE" };
  }
  return json("PATCH", { pr_url: change.prUrl, watch: change.watch });
}

export function useSetPullRequestWatch(conversationId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (change: PullRequestWatchChange) => {
      const response = await authenticatedFetch(watchUrl(conversationId), requestFor(change));
      if (!response.ok) throw await errorFromResponse(response);
      return (await response.json()) as PullRequestWatchStatus;
    },
    onSuccess: (status) => queryClient.setQueryData(watchKey(conversationId), status),
  });
}
