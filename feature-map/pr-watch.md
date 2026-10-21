# Watch pull requests until they're green

A user picks which of a session's pull requests to watch from **Watch PRs** in
the composer bar: **All PRs in this session** (every PR now and any it opens
later) or individual PRs. The server then polls each watched PR through the same
path as the Pull Requests panel and, while the session is idle, wakes the agent
with one `[System: PR watch — …]` message listing every PR where a check failed
on the head commit, a repository owner, member or collaborator commented or
reviewed, or the branch stopped merging cleanly. Each PR's watch ends with a
transcript note when its CI passes and no changes are requested, when it is
merged or closed, or after its wake-up budget.

## Sub-features

- `composer`: the composer bar's **Watch PRs** chip reads **Watching N PRs**
  while watching; its popover has the **All PRs in this session** box, one box
  per open PR with its number, title, CI state and wake-ups used, and what a
  watch does. With **All** on every PR box is checked; unchecking one turns
  **All** off and keeps the rest.
- `all`: in **All** mode the server picks up each PR the session tracks,
  including ones opened or attached later; merged and closed ones are skipped.
- `panel`: the Pull Requests panel's **Watch until green** switch changes the
  same selection for the PR it shows.
- `access`: only users with edit access can change the selection; others see
  the boxes disabled with the reason. A session whose host is offline shows
  the boxes disabled with that reason.
- `wake`: failed checks, new comments and reviews from trusted accounts, and merge
  conflicts produce one coalesced message per idle poll across all watched
  PRs, never during a turn.
- `untrusted`: comments and reviews from anyone who is not an owner, member or
  collaborator of the repository never wake the agent and their text is never sent.
- `stop`: green, merged, closed, budget spent, checks unreadable, or five
  consecutive failed wake-up deliveries end that PR's watch with a
  `[System: PR watch stopped — …]` note that does not start a turn; the
  popover shows why it stopped and **All** does not pick it up again.
- `api`: `GET`, `PUT` (`{"mode": "all"}` or `{"pr_urls": […]}`), `PATCH`
  (`{"pr_url": …, "watch": true|false}`) and `DELETE` (everything off) on
  `/v1/sessions/{id}/pr-watch`; `max_wakes` sets the per-PR budget.
- `refused`: watching a merged or closed PR, or one whose checks the account
  cannot read, shows the server's reason in the popover or under the switch.
- `gate`: everything is absent unless the `pr_watch` feature is enabled.

## How to get to it (user POV)

- Desktop web and desktop app: in a session whose workspace is a git checkout,
  click **Watch PRs** in the bar above the composer.
- Pull Requests tab: select an open PR and flip **Watch until green** in its
  header.
- Chat transcript: wake-ups and stop notes render as muted system markers whose
  body expands on click.
- REST API: the routes above with a session-editor's credentials, for agents
  and scripts.

## Driving it with the repro environment

Preconditions: start the server with `OMNIGENT_FEATURES=pr_watch` (optionally
`OMNIGENT_PR_WATCH_INTERVAL_S=15` for a fast loop and
`OMNIGENT_PR_WATCH_MAX_WAKES`), and use a session whose workspace is a checkout
with open PRs the host's `gh` account can read. Public PRs of another
repository can be attached from the Pull Requests tab for a read-only drive;
use a scratch repository you own when the agent should push and comment.

- Composer control, modes and per-PR toggles:
  `web/src/components/composer/ComposerPrWatch.test.tsx`.
- Panel switch and refusal: `web/src/shell/PullRequestWatch.test.tsx`.
- Event detection, dedupe, coalescing across PRs, "all" pick-up, idle-only
  delivery and stop rules:
  `tests/server/test_pr_watch.py`.
- Route permissions, feature gate, modes, baseline and reserved labels:
  `tests/server/routes/test_session_pr_watch.py`.
- Live drive (no test): attach two PRs, one with a failing check, turn on
  **All**, wait one interval, and confirm one wake-up message lists only the
  red PR while the green one gets a stop note. Attach a third PR and confirm the
  next poll picks it up. In another session select two red PRs, uncheck one, and
  confirm the wake-up lists only the other. Restart without the flag and confirm
  the chip and switch are gone.

## Gotchas

- Comments and reviews by the PR author or the host's signed-in account never
  wake the agent; that account is the one the agent pushes and replies as.
- Only GitHub's `OWNER`, `MEMBER` and `COLLABORATOR` author associations count as
  trusted. Bots such as `github-actions` report `CONTRIBUTOR` or `NONE`, so their
  review comments do not wake the agent. Providers and hosts that report no
  association (GitLab, Azure DevOps, older hosts) get check and conflict wake-ups only.
- A trusted reviewer's requested changes block green; an untrusted one's do not.
- Comments and reviews that existed when a PR's watch started count as seen,
  except requested changes, which are reported on the first poll.
- A reviewer's requested changes block "green" until they re-review or are
  re-requested; the watch keeps polling quietly meanwhile.
- A PR with no CI at all is green only after two quiet polls of the same commit.
- In **All** mode with no PR being watched, the server re-reads the session's
  PR list only after new session activity or every ten intervals, so a PR
  attached from the panel in a quiet session can take that long to be picked up.
- Turning **All** on again retries PRs whose watch ended; a still-green PR then
  gets a second stop note.
- Removing a PR from the session ends its watch quietly.
- Merge-conflict detection and repeated reviews by one reviewer need a host
  running this version; older hosts still get check and comment wake-ups.
- Polls go through the session's runner, or its host when the runner is offline,
  and are skipped while the host is disconnected from this server replica.
- Forking a session does not copy its watches.
