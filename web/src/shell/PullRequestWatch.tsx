// "Watch until green" in the Pull Requests panel header: a second way to change
// the selection the composer's "Watch PRs" control shows. Renders nothing
// unless the server enables the `pr_watch` feature.

import { PR_WATCH_HINT } from "@/components/composer/ComposerPrWatch";
import { Switch } from "@/components/ui/switch";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  isPullRequestWatched,
  usePullRequestWatch,
  useSetPullRequestWatch,
} from "@/hooks/usePullRequestWatch";

export function PullRequestWatchSwitch({
  conversationId,
  prUrl,
  canEdit,
}: {
  conversationId: string;
  prUrl: string;
  canEdit: boolean;
}) {
  const status = usePullRequestWatch(conversationId);
  const setWatch = useSetPullRequestWatch(conversationId);
  if (!status.data) return null;
  const watching = isPullRequestWatched(status.data, prUrl);
  return (
    <div className="flex shrink-0 flex-col items-end gap-0.5">
      <Tooltip>
        <TooltipTrigger asChild>
          <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
            Watch until green
            <Switch
              size="sm"
              checked={watching}
              disabled={!canEdit || setWatch.isPending}
              onCheckedChange={(watch) => setWatch.mutate({ kind: "pr", prUrl, watch })}
              componentId="github.panel.watch_until_green"
              data-testid="pr-watch-switch"
            />
          </label>
        </TooltipTrigger>
        <TooltipContent className="max-w-72">
          {status.data.mode === "all"
            ? `${PR_WATCH_HINT} Every PR in this session is watched; turning this one off keeps the others.`
            : PR_WATCH_HINT}
        </TooltipContent>
      </Tooltip>
      {setWatch.error && (
        <span role="alert" className="text-xs text-destructive">
          {setWatch.error.message}
        </span>
      )}
    </div>
  );
}
