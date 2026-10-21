"""Choose which of a session's pull requests to watch (see :mod:`omnigent.server.pr_watch`)."""

from __future__ import annotations

import asyncio
import time
from typing import Literal

from fastapi import APIRouter, Request
from pydantic import BaseModel, Field, model_validator

from omnigent.db.db_models import LABEL_VALUE_MAX_LEN
from omnigent.entities import Conversation
from omnigent.errors import ErrorCode, OmnigentError
from omnigent.server.auth import LEVEL_EDIT, LEVEL_READ, AuthProvider
from omnigent.server.feature_flags import Feature, FeatureFlags
from omnigent.server.pr_watch import (
    MAX_WAKES_LIMIT,
    MAX_WATCHED_PRS,
    SessionWatch,
    WatchState,
    baseline_state,
    clear_watch,
    configured_max_wakes,
    read_session_watch,
    remove_entry,
    save_entry,
    set_all_mode,
    watch_status,
    watchable_pr,
)
from omnigent.server.routes._auth_helpers import get_user_id as _get_user_id
from omnigent.server.routes._auth_helpers import (
    require_access_and_level as _require_access_and_level,
)
from omnigent.stores import ConversationStore
from omnigent.stores.permission_store import PermissionStore


class PullRequestWatchRequest(BaseModel):
    """Body of ``PUT /v1/sessions/{id}/pr-watch``: replace what the session watches.

    :param mode: ``all`` watches every PR the session tracks, now and later;
        ``selected`` watches exactly ``pr_urls`` (none turns the watch off).
    :param pr_urls: The PRs to watch in ``selected`` mode, as the PR panel lists them.
    :param max_wakes: Wake-ups per PR before its watch gives up; the server
        default when omitted.
    """

    mode: Literal["all", "selected"] = "selected"
    pr_urls: list[str] = Field(default_factory=list, max_length=MAX_WATCHED_PRS)
    max_wakes: int | None = Field(default=None, ge=1, le=MAX_WAKES_LIMIT)

    @model_validator(mode="after")
    def _urls_only_when_selected(self) -> PullRequestWatchRequest:
        if self.mode == "all" and self.pr_urls:
            raise ValueError("pr_urls applies only to mode 'selected'")
        if any(not url or len(url) > LABEL_VALUE_MAX_LEN for url in self.pr_urls):
            raise ValueError(f"each pr_url must be 1 to {LABEL_VALUE_MAX_LEN} characters")
        return self


class PullRequestWatchChange(BaseModel):
    """Body of ``PATCH /v1/sessions/{id}/pr-watch``: watch or unwatch one PR.

    :param pr_url: A pull request the session tracks.
    :param watch: Whether to watch it.
    :param max_wakes: Wake-ups before its watch gives up; the server default when omitted.
    """

    pr_url: str = Field(min_length=1, max_length=LABEL_VALUE_MAX_LEN)
    watch: bool
    max_wakes: int | None = Field(default=None, ge=1, le=MAX_WAKES_LIMIT)


class PullRequestWatchEntry(BaseModel):
    """One pull request's watch.

    :param pr_url: The pull request.
    :param watching: Whether its watch is running.
    :param ended: Why its watch ended (``green``, ``merged``, ``closed``,
        ``checks_unreadable``, ``budget`` or ``undeliverable``), else ``None``.
    :param wakes: Wake-up messages sent for it so far.
    :param max_wakes: Wake-ups before its watch stops.
    :param started_at: Epoch seconds when its watch started.
    """

    pr_url: str
    watching: bool
    ended: str | None = None
    wakes: int
    max_wakes: int
    started_at: int | None = None


class PullRequestWatchStatus(BaseModel):
    """A session's pull request watch.

    :param mode: ``all`` (every tracked PR, including ones opened later),
        ``selected`` (the PRs in ``prs`` that are watching) or ``off``.
    :param active: Whether anything is watched.
    :param max_wakes: The wake-up budget newly watched PRs get.
    :param prs: Each PR watched now or earlier. In ``all`` mode, tracked PRs
        missing here are picked up on the next poll.
    """

    object: str = "session.pr_watch"
    mode: Literal["off", "all", "selected"]
    active: bool
    max_wakes: int
    prs: list[PullRequestWatchEntry]


def register_pr_watch_routes(
    router: APIRouter,
    *,
    conversation_store: ConversationStore,
    auth_provider: AuthProvider | None = None,
    permission_store: PermissionStore | None = None,
) -> None:
    """Register the pull request watch routes on *router*."""

    async def _authorized(request: Request, session_id: str, level: int) -> Conversation:
        flags = getattr(request.app.state, "feature_flags", FeatureFlags())
        if not flags.enabled(Feature.PR_WATCH):
            raise OmnigentError("Pull request watching is disabled", code=ErrorCode.NOT_FOUND)
        user_id = _get_user_id(request, auth_provider)
        access = await _require_access_and_level(
            user_id, session_id, level, permission_store, conversation_store
        )
        conv = access.conversation or await asyncio.to_thread(
            conversation_store.get_conversation, session_id
        )
        if conv is None:
            raise OmnigentError("Session not found", code=ErrorCode.NOT_FOUND)
        return conv

    async def _editable_watch(
        request: Request, session_id: str
    ) -> tuple[Conversation, SessionWatch]:
        conv = await _authorized(request, session_id, LEVEL_EDIT)
        return conv, read_session_watch(conv.labels)

    async def _baseline(
        request: Request, session_id: str, conv: Conversation, pr_url: str, max_wakes: int | None
    ) -> WatchState:
        """Read *pr_url* like the PR panel and return the state its watch starts from."""
        read_pr_info = getattr(request.app.state, "pr_info_reader", None)
        if read_pr_info is None:
            raise OmnigentError(
                "Pull request watching is unavailable", code=ErrorCode.RUNNER_UNAVAILABLE
            )
        info = await read_pr_info(session_id, conv, pr_url)
        try:
            watchable_pr(info)
        except OmnigentError as exc:
            raise OmnigentError(f"{exc.message}: {pr_url}", code=exc.code) from exc
        return baseline_state(
            info, max_wakes=max_wakes or configured_max_wakes(), now=int(time.time())
        )

    async def _status(request: Request, session_id: str) -> PullRequestWatchStatus:
        watcher = getattr(request.app.state, "pr_watcher", None)
        if watcher is not None:
            watcher.request_poll(session_id)
        conv = await asyncio.to_thread(conversation_store.get_conversation, session_id)
        if conv is None:
            raise OmnigentError("Session not found", code=ErrorCode.NOT_FOUND)
        return PullRequestWatchStatus(**watch_status(conv))

    @router.get("/sessions/{session_id}/pr-watch", response_model=PullRequestWatchStatus)
    async def get_session_pr_watch(request: Request, session_id: str) -> PullRequestWatchStatus:
        """Return which of the session's pull requests are watched."""
        conv = await _authorized(request, session_id, LEVEL_READ)
        return PullRequestWatchStatus(**watch_status(conv))

    @router.put("/sessions/{session_id}/pr-watch", response_model=PullRequestWatchStatus)
    async def set_session_pr_watch(
        request: Request, session_id: str, body: PullRequestWatchRequest
    ) -> PullRequestWatchStatus:
        """Watch every tracked pull request, or exactly the listed ones.

        A watch wakes the agent on failed checks, merge conflicts and comments or
        reviews from collaborators, and ends once checks pass with no changes
        requested. PRs are read through the session's runner or host, like the
        Pull Requests panel, so the watch uses the same account. Requires edit access.
        """
        conv, watch = await _editable_watch(request, session_id)
        if body.mode == "all":
            # Start over: PRs whose watch ended are picked up again if still open.
            for pr_url, state in watch.prs.items():
                if state.ended:
                    await remove_entry(conversation_store, session_id, pr_url)
            await set_all_mode(conversation_store, session_id, True, max_wakes=body.max_wakes)
            return await _status(request, session_id)

        wanted = list(dict.fromkeys(body.pr_urls))
        started = {
            pr_url: await _baseline(request, session_id, conv, pr_url, body.max_wakes)
            for pr_url in wanted
            if pr_url not in watch.watching
        }
        await set_all_mode(conversation_store, session_id, False)
        for pr_url in watch.prs:
            if pr_url not in wanted:
                await remove_entry(conversation_store, session_id, pr_url)
        for pr_url, state in started.items():
            await save_entry(conversation_store, session_id, pr_url, state)
        return await _status(request, session_id)

    @router.patch("/sessions/{session_id}/pr-watch", response_model=PullRequestWatchStatus)
    async def change_session_pr_watch(
        request: Request, session_id: str, body: PullRequestWatchChange
    ) -> PullRequestWatchStatus:
        """Watch or stop watching one pull request. Requires edit access.

        Stopping one while every PR is watched leaves the others watched but
        stops picking up new PRs.
        """
        conv, watch = await _editable_watch(request, session_id)
        if body.watch:
            if body.pr_url not in watch.watching:
                if body.pr_url not in watch.prs and len(watch.prs) >= MAX_WATCHED_PRS:
                    raise OmnigentError(
                        f"A session can watch at most {MAX_WATCHED_PRS} pull requests",
                        code=ErrorCode.CONFLICT,
                    )
                state = await _baseline(request, session_id, conv, body.pr_url, body.max_wakes)
                await save_entry(conversation_store, session_id, body.pr_url, state)
        else:
            await remove_entry(conversation_store, session_id, body.pr_url)
            if watch.all_prs:
                await set_all_mode(conversation_store, session_id, False)
        return await _status(request, session_id)

    @router.delete("/sessions/{session_id}/pr-watch", response_model=PullRequestWatchStatus)
    async def stop_session_pr_watch(request: Request, session_id: str) -> PullRequestWatchStatus:
        """Stop watching every pull request. Requires edit access."""
        await _authorized(request, session_id, LEVEL_EDIT)
        await clear_watch(conversation_store, session_id)
        return await _status(request, session_id)
