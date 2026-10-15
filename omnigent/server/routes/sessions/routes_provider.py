"""Switch a running session to another provider of its harness family.

A session's provider is fixed in its runner's environment, so a switch saves
the new choice and restarts the runner: at once when the runner is idle, else
when its current turn ends. Claude keeps the conversation in its config
directory, so the new runner resumes it as long as both providers share that
directory, which the host reports as a ``switch_group``.
"""

from __future__ import annotations

import asyncio
import logging
from dataclasses import dataclass
from typing import Any, Literal

from fastapi import APIRouter, Request
from pydantic import BaseModel

from omnigent.db.db_models import current_workspace_id, workspace_scope
from omnigent.entities import Conversation
from omnigent.errors import ErrorCode, OmnigentError
from omnigent.host.frames import CAP_SESSION_PROVIDER
from omnigent.runner.routing import RunnerRouter
from omnigent.server.auth import LEVEL_OWNER, AuthProvider
from omnigent.server.host_registry import HostRegistry
from omnigent.server.routes._auth_helpers import require_access, require_user
from omnigent.server.routes._errors import session_not_found
from omnigent.server.routes._sessions.common import _session_status_cache
from omnigent.server.routes._sessions.helpers import (
    _get_runner_client,
    _resolve_harness,
    _validated_provider_override,
)
from omnigent.server.routes._sessions.orchestration import (
    _MID_TURN_STATUSES,
    _is_native_terminal_session,
    _stop_host_runner_intentionally,
)
from omnigent.server.routes.host_providers import request_host_providers
from omnigent.stores.agent_store import AgentStore
from omnigent.stores.conversation_store import ConversationStore
from omnigent.stores.permission_store import PermissionStore

_logger = logging.getLogger(__name__)

# Harnesses whose conversation a new runner resumes from the shared Claude directory.
_SWITCHABLE_HARNESSES = frozenset({"claude-native", "claude-sdk"})
_RUNNER_EXIT_TIMEOUT_S = 15.0
_RUNNER_EXIT_POLL_S = 0.2


class SessionProviderRequest(BaseModel):
    """Body of ``POST /v1/sessions/{id}/provider``.

    :param provider: A ``providers:`` entry name on the session's host, e.g.
        ``"claude-max2"``, or ``None`` for the host default.
    """

    provider: str | None


class SessionProviderResponse(BaseModel):
    """Result of a provider switch.

    :param provider_override: The session's provider now, ``None`` for the
        host default.
    :param applied: ``"now"`` when the runner restarts (or starts) on it right
        away, ``"after_turn"`` when it restarts once the current turn ends.
    """

    provider_override: str | None
    applied: Literal["now", "after_turn"]


@dataclass
class _PendingSwitch:
    """A runner restart waiting for its sessions to go idle."""

    session_id: str
    workspace_id: int
    app_state: Any
    conversation_store: ConversationStore
    runner_router: RunnerRouter | None
    host_registry: HostRegistry


# custom-lint: disable-next=workspace-scoped-cache -- keyed by globally unique runner_id
_pending_switches: dict[str, _PendingSwitch] = {}
# custom-lint: disable-next=workspace-scoped-cache -- set of Task objects
_switch_tasks: set[asyncio.Task[None]] = set()


def _spawn(coro: Any) -> None:
    """Run *coro* in the background, keeping a reference until it finishes."""
    task = asyncio.get_running_loop().create_task(coro)
    _switch_tasks.add(task)
    task.add_done_callback(_switch_tasks.discard)


def note_session_status(status: str) -> None:
    """Apply pending switches whose runners went idle. Called on status edges.

    :param status: The session's new status, e.g. ``"idle"``.
    """
    if _pending_switches and status not in _MID_TURN_STATUSES:
        _spawn(_apply_ready_switches())


async def _runner_busy(runner_id: str, conversation_store: ConversationStore) -> bool:
    """Whether any session on *runner_id* is mid-turn or waiting on the user."""
    statuses = await asyncio.to_thread(
        conversation_store.list_runner_session_statuses, runner_id, limit=1000
    )
    return any(
        _session_status_cache.get(session_id, persisted) in _MID_TURN_STATUSES
        for session_id, persisted in statuses
    )


async def _apply_ready_switches() -> None:
    """Restart every pending runner whose sessions are all idle now."""
    for runner_id, pending in list(_pending_switches.items()):
        with workspace_scope(pending.workspace_id):
            if await _runner_busy(runner_id, pending.conversation_store):
                continue
        if _pending_switches.get(runner_id) is pending:
            await _restart_runner(runner_id)


async def _wait_for_runner_exit(session_id: str, runner_router: RunnerRouter | None) -> None:
    """Wait until the stopped runner's tunnel is gone, so a wake relaunches."""
    loop = asyncio.get_running_loop()
    deadline = loop.time() + _RUNNER_EXIT_TIMEOUT_S
    while await _get_runner_client(session_id, runner_router) is not None:
        if loop.time() >= deadline:
            raise TimeoutError(f"runner for {session_id} did not exit after a provider switch")
        await asyncio.sleep(_RUNNER_EXIT_POLL_S)


async def _restart_runner(runner_id: str) -> None:
    """Stop *runner_id* and bring its session back up on the saved provider.

    Failures are logged: the session then starts on the new provider with its
    next message.
    """
    from omnigent.server.routes.sessions.routes_core import wake_native_runner

    pending = _pending_switches.pop(runner_id, None)
    if pending is None:
        return
    store = pending.conversation_store
    with workspace_scope(pending.workspace_id):
        try:
            conv = await asyncio.to_thread(store.get_conversation, pending.session_id)
            # Another launch already replaced the runner with one on the saved provider.
            if conv is None or conv.runner_id != runner_id or conv.host_id is None:
                return
            stopped = await _stop_host_runner_intentionally(
                conv.id, conv.host_id, runner_id, pending.host_registry, store
            )
            if not stopped:
                _logger.warning(
                    "Provider switch could not stop runner %s for %s",
                    runner_id,
                    conv.id,
                    extra={"session_id": conv.id},
                )
                return
            await _wait_for_runner_exit(conv.id, pending.runner_router)
            if not _is_native_terminal_session(conv):
                return
            conv = await asyncio.to_thread(store.get_conversation, conv.id) or conv
            await wake_native_runner(
                pending.app_state,
                conv,
                store,
                pending.runner_router,
                offline_message="The session host went offline during a provider switch.",
            )
        except Exception:
            _logger.warning(
                "Provider switch restart failed for %s",
                pending.session_id,
                exc_info=True,
                extra={"session_id": pending.session_id},
            )


def _default_row(rows: list[dict[str, Any]]) -> dict[str, Any] | None:
    return next((row for row in rows if row.get("default")), None)


async def _check_switch_target(
    host_registry: HostRegistry, conv: Conversation, harness: str, provider: str | None
) -> None:
    """Fail unless *provider* is ready on the host and shares the session's directory.

    :raises OmnigentError: When the host is offline or too old, the provider is
        unknown or not signed in, or it keeps a separate login directory.
    """
    host_conn = host_registry.get(conv.host_id) if conv.host_id else None
    if host_conn is None:
        raise OmnigentError(
            "The session's host is offline. Reconnect it and retry.",
            code=ErrorCode.RUNNER_UNAVAILABLE,
        )
    if CAP_SESSION_PROVIDER not in host_conn.hello.capabilities:
        raise OmnigentError(
            "Update the host to switch a session's provider.", code=ErrorCode.INVALID_INPUT
        )
    result = await request_host_providers(
        host_registry=host_registry, host_conn=host_conn, harness=harness
    )
    if result.status != "ok":
        raise OmnigentError(
            result.error or "The host could not list its providers.",
            code=ErrorCode.RUNNER_UNAVAILABLE,
        )
    rows = list(result.providers)
    by_name = {row["name"]: row for row in rows}
    target = by_name.get(provider) if provider else _default_row(rows)
    if target is None:
        raise OmnigentError(
            f"Provider {provider!r} is not configured on the session's host.",
            code=ErrorCode.INVALID_INPUT,
        )
    if not target["ready"]:
        raise OmnigentError(
            f"Account {target['name']!r} is not signed in on the session's host.",
            code=ErrorCode.INVALID_INPUT,
        )
    current = (by_name.get(conv.provider_override) if conv.provider_override else None) or (
        _default_row(rows)
    )
    group = target.get("switch_group")
    if group is None or current is None or current.get("switch_group") != group:
        raise OmnigentError(
            f"{target['name']!r} keeps a separate login and conversation history. "
            "Start a new session on it instead.",
            code=ErrorCode.INVALID_INPUT,
        )


async def switch_session_provider(
    app_state: Any,
    conv: Conversation,
    provider: str | None,
    *,
    agent_store: AgentStore,
    conversation_store: ConversationStore,
    runner_router: RunnerRouter | None,
    host_registry: HostRegistry,
) -> SessionProviderResponse:
    """Save *provider* for *conv* and restart its runner on it.

    :param app_state: The FastAPI ``app.state``.
    :param conv: The session to switch.
    :param provider: The provider name, or ``None`` for the host default.
    :param agent_store: Store for the session's agent.
    :param conversation_store: Store for the session.
    :param runner_router: Routes requests to the session's runner.
    :param host_registry: The connected hosts.
    :returns: The saved provider and when the switch applies.
    :raises OmnigentError: When the session or provider cannot switch.
    """
    harness = _resolve_harness(conv)
    if harness is None or harness not in _SWITCHABLE_HARNESSES:
        raise OmnigentError(
            "Only Claude sessions can switch providers while they run.",
            code=ErrorCode.INVALID_INPUT,
        )
    if conv.host_id is None:
        raise OmnigentError(
            "This session runs on another session's runner; switch the provider there.",
            code=ErrorCode.INVALID_INPUT,
        )
    agent = await asyncio.to_thread(agent_store.get, conv.agent_id) if conv.agent_id else None
    if agent is None:
        raise OmnigentError("The session's agent no longer exists.", code=ErrorCode.INVALID_INPUT)
    if provider is not None:
        _validated_provider_override(
            provider,
            agent,
            host_id=conv.host_id,
            host_type="external",
            sub_agent_name=conv.sub_agent_name,
        )
    if provider == conv.provider_override:
        return SessionProviderResponse(provider_override=provider, applied="now")
    await _check_switch_target(host_registry, conv, harness, provider)
    updated = await asyncio.to_thread(conversation_store.set_provider_override, conv.id, provider)
    if updated is None:
        raise session_not_found()
    runner_id = updated.runner_id
    if runner_id is None or await _get_runner_client(updated.id, runner_router) is None:
        # Nothing runs yet: the next launch starts on the saved provider.
        return SessionProviderResponse(provider_override=provider, applied="now")
    _pending_switches[runner_id] = _PendingSwitch(
        session_id=updated.id,
        workspace_id=current_workspace_id(),
        app_state=app_state,
        conversation_store=conversation_store,
        runner_router=runner_router,
        host_registry=host_registry,
    )
    if await _runner_busy(runner_id, conversation_store):
        return SessionProviderResponse(provider_override=provider, applied="after_turn")
    _spawn(_restart_runner(runner_id))
    return SessionProviderResponse(provider_override=provider, applied="now")


def register_provider_routes(
    router: APIRouter,
    *,
    conversation_store: ConversationStore,
    agent_store: AgentStore,
    runner_router: RunnerRouter | None = None,
    auth_provider: AuthProvider | None = None,
    permission_store: PermissionStore | None = None,
    host_registry: HostRegistry | None = None,
) -> None:
    """Register ``POST /v1/sessions/{id}/provider`` on *router*."""

    @router.post("/sessions/{session_id}/provider")
    async def set_session_provider(
        request: Request, session_id: str, body: SessionProviderRequest
    ) -> SessionProviderResponse:
        """Switch a running session to another provider, e.g. another Claude account.

        Owner-only: the provider decides which of the host owner's accounts
        pays for the session.
        """
        user_id = require_user(request, auth_provider)
        await require_access(
            user_id, session_id, LEVEL_OWNER, permission_store, conversation_store
        )
        if host_registry is None:
            raise OmnigentError(
                "This server has no connected hosts.", code=ErrorCode.INVALID_INPUT
            )
        conv = await asyncio.to_thread(conversation_store.get_conversation, session_id)
        if conv is None:
            raise session_not_found()
        return await switch_session_provider(
            request.app.state,
            conv,
            body.provider,
            agent_store=agent_store,
            conversation_store=conversation_store,
            runner_router=runner_router,
            host_registry=host_registry,
        )
