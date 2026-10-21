/**
 * "Watch PRs" chip for the composer workspace bar: which of the session's pull
 * requests the server keeps on until they're green. Its popover has an "All
 * PRs" box (every PR now and any the session opens later) and one box per open
 * PR. Renders nothing unless the server enables the `pr_watch` feature.
 */
import { useId, useState } from "react";
import { EyeIcon, Loader2Icon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { useCanEdit } from "@/hooks/usePermissions";
import {
  type PullRequestWatchEnd,
  type PullRequestWatchStatus,
  isPullRequestWatched,
  pullRequestWatchEntry,
  usePullRequestWatch,
  usePullRequestWatchAvailable,
  useSetPullRequestWatch,
} from "@/hooks/usePullRequestWatch";
import {
  type PullRequestAssociation,
  type PullRequestChecks,
  usePullRequestInfo,
} from "@/hooks/usePullRequests";
import { cn } from "@/lib/utils";

export const PR_WATCH_HINT =
  "Wakes the agent on failed checks, merge conflicts and comments from collaborators; " +
  "stops when green.";

const ENDED_LABELS: Record<PullRequestWatchEnd, string> = {
  green: "Stopped: green",
  merged: "Stopped: merged",
  closed: "Stopped: closed",
  checks_unreadable: "Stopped: checks unreadable",
  budget: "Stopped: wake-ups used up",
  undeliverable: "Stopped: couldn't wake the agent",
};

/** The chip's text: what is watched, or the call to action. */
export function prWatchLabel(status: PullRequestWatchStatus | undefined, prUrls: string[]): string {
  if (!status?.active) return "Watch PRs";
  const count = prUrls.filter((url) => isPullRequestWatched(status, url)).length;
  if (count === 0) return status.mode === "all" ? "Watching new PRs" : "Watch PRs";
  return `Watching ${count} PR${count === 1 ? "" : "s"}`;
}

function ChecksBadge({ checks }: { checks: PullRequestChecks }) {
  const [label, tone] =
    checks.failing > 0
      ? [`${checks.failing} failing`, "border-destructive/40 text-destructive"]
      : checks.pending > 0
        ? ["running", "border-amber-500/40 text-amber-600 dark:text-amber-400"]
        : checks.total > 0
          ? ["passing", "border-emerald-500/40 text-emerald-600 dark:text-emerald-400"]
          : ["no checks", "border-border text-muted-foreground"];
  return (
    <span
      data-testid="pr-watch-checks"
      className={cn("shrink-0 rounded-full border px-1.5 text-xs tabular-nums", tone)}
    >
      {label}
    </span>
  );
}

/** One tracked PR. Its details load when the popover opens; closed PRs drop out. */
function WatchRow({
  conversationId,
  pr,
  status,
  disabled,
  onChange,
}: {
  conversationId: string;
  pr: PullRequestAssociation;
  status: PullRequestWatchStatus | undefined;
  disabled: boolean;
  onChange: (watch: boolean) => void;
}) {
  const id = useId();
  const info = usePullRequestInfo(conversationId, { prUrl: pr.url }).data?.pr;
  if (info && info.url === pr.url && info.state !== "OPEN") return null;
  const entry = pullRequestWatchEntry(status, pr.url);
  const watched = isPullRequestWatched(status, pr.url);
  const detail = entry?.ended
    ? ENDED_LABELS[entry.ended]
    : entry?.watching
      ? `${entry.wakes}/${entry.max_wakes} wake-ups`
      : null;
  return (
    <li className="flex items-start gap-2 px-1 py-1.5" data-testid="pr-watch-row">
      <Checkbox
        id={id}
        checked={watched}
        disabled={disabled}
        onCheckedChange={(checked) => onChange(checked === true)}
        componentId="composer.pr_watch.pr"
        className="mt-0.5"
        aria-label={`Watch #${pr.number}`}
      />
      <label htmlFor={id} className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex min-w-0 items-center gap-1.5">
          <span className="shrink-0 tabular-nums text-muted-foreground">#{pr.number}</span>
          <span className="truncate" title={pr.title ?? info?.title ?? pr.url}>
            {pr.title ?? info?.title ?? pr.repository}
          </span>
        </span>
        {detail && <span className="text-xs text-muted-foreground">{detail}</span>}
      </label>
      {info?.url === pr.url ? (
        <ChecksBadge checks={info.checks} />
      ) : (
        <Loader2Icon
          className="mt-0.5 size-3.5 shrink-0 animate-spin text-muted-foreground"
          aria-label="Loading checks"
        />
      )}
    </li>
  );
}

export function ComposerPrWatch({ conversationId }: { conversationId: string | null }) {
  const available = usePullRequestWatchAvailable(conversationId);
  if (!available || !conversationId) return null;
  return <ComposerPrWatchControl conversationId={conversationId} />;
}

function ComposerPrWatchControl({ conversationId }: { conversationId: string }) {
  const [open, setOpen] = useState(false);
  const allId = useId();
  const canEdit = useCanEdit(conversationId);
  const github = usePullRequestInfo(conversationId);
  const status = usePullRequestWatch(conversationId);
  const setWatch = useSetPullRequestWatch(conversationId);
  const prs = github.data?.tracking_available ? (github.data.prs ?? []) : [];
  const unavailable = github.isError
    ? "Pull requests can't be read while the session's host is offline."
    : github.data && !github.data.tracking_available
      ? "This session's host can't track pull requests."
      : null;
  // Show nothing until the session's PR state is known; a non-repo has nothing to watch.
  if (!status.data || (!github.data && !github.isError)) return null;
  if (github.data && !github.data.available) return null;

  const watchStatus = status.data;
  const label = prWatchLabel(
    watchStatus,
    prs.map((pr) => pr.url),
  );
  const disabledReason = !canEdit
    ? "Only people who can edit this session can change what it watches."
    : unavailable;
  const busy = setWatch.isPending;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="xs"
          data-testid="composer-pr-watch"
          aria-label={label}
          className={cn(
            "shrink-0 gap-1 px-1 font-normal text-muted-foreground md:px-2",
            watchStatus.active && "text-foreground",
          )}
        >
          <EyeIcon
            className={cn("size-3.5", watchStatus.active && "text-primary")}
            strokeWidth={1.5}
            aria-hidden="true"
          />
          {label}
        </Button>
      </PopoverTrigger>
      <PopoverContent
        side="top"
        align="start"
        collisionPadding={8}
        aria-label="Watch pull requests"
        data-testid="composer-pr-watch-popover"
        className="max-h-[min(28rem,var(--radix-popover-content-available-height))] w-[min(24rem,calc(100vw-2rem))] gap-2 overflow-y-auto"
      >
        <div className="flex flex-col gap-0.5 px-1">
          <span className="font-medium">Watch pull requests until green</span>
          <span className="text-xs text-muted-foreground">
            {PR_WATCH_HINT} Up to {watchStatus.max_wakes} wake-ups per PR.
          </span>
        </div>
        <div className="flex items-start gap-2 rounded-md bg-muted/50 px-1 py-1.5">
          <Checkbox
            id={allId}
            checked={watchStatus.mode === "all"}
            disabled={!!disabledReason || busy}
            onCheckedChange={(checked) => setWatch.mutate({ kind: "all", watch: checked === true })}
            componentId="composer.pr_watch.all"
            data-testid="pr-watch-all"
            className="mt-0.5"
          />
          <label htmlFor={allId} className="flex flex-col gap-0.5">
            <span>All PRs in this session</span>
            <span className="text-xs text-muted-foreground">Including any it opens later.</span>
          </label>
        </div>
        {prs.length > 0 ? (
          <ul className="flex flex-col divide-y divide-border">
            {prs.map((pr) => (
              <WatchRow
                key={pr.url}
                conversationId={conversationId}
                pr={pr}
                status={watchStatus}
                disabled={!!disabledReason || busy}
                onChange={(watch) => setWatch.mutate({ kind: "pr", prUrl: pr.url, watch })}
              />
            ))}
          </ul>
        ) : (
          !unavailable && (
            <p className="px-1 text-xs text-muted-foreground">
              No pull requests yet. With All on, the first one the session opens is watched.
            </p>
          )
        )}
        {disabledReason && (
          <p role="note" className="px-1 text-xs text-muted-foreground">
            {disabledReason}
          </p>
        )}
        {setWatch.error && (
          <p role="alert" className="px-1 text-xs text-destructive">
            {setWatch.error.message}
          </p>
        )}
      </PopoverContent>
    </Popover>
  );
}
