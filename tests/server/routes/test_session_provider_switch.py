"""A running session switches provider by restarting its runner, now or after its turn."""

from __future__ import annotations

import asyncio
import dataclasses
from types import SimpleNamespace
from typing import Any

import pytest

from omnigent.entities import Conversation
from omnigent.errors import ErrorCode, OmnigentError
from omnigent.host.frames import CAP_SESSION_PROVIDER
from omnigent.server.routes.sessions import routes_provider

_SHARED = "3f2a9c1d0b7e"
_ROWS = [
    {"name": "max1", "ready": True, "default": True, "switch_group": _SHARED},
    {"name": "max2", "ready": True, "default": False, "switch_group": _SHARED},
    {"name": "dbx", "ready": True, "default": False, "switch_group": _SHARED},
    {"name": "alt", "ready": True, "default": False, "switch_group": "9d8e7f6a5b4c"},
    {"name": "max3", "ready": False, "default": False, "switch_group": _SHARED},
]


class _Store:
    """The conversation-store calls a switch makes, over one session."""

    def __init__(self, conv: Conversation, status: str = "idle") -> None:
        self.conv = conv
        self.status = status

    def get_conversation(self, session_id: str) -> Conversation | None:
        return self.conv if session_id == self.conv.id else None

    def set_provider_override(self, session_id: str, provider: str | None) -> Conversation:
        self.conv = dataclasses.replace(self.conv, provider_override=provider)
        return self.conv

    def list_runner_session_statuses(
        self, runner_id: str, *, after: str | None = None, limit: int = 200
    ) -> list[tuple[str, str | None]]:
        return [(self.conv.id, self.status)] if runner_id == self.conv.runner_id else []


@pytest.fixture
def calls(monkeypatch: pytest.MonkeyPatch) -> dict[str, list[Any]]:
    """Stub the host, runner and restart steps; record what the switch did."""
    recorded: dict[str, list[Any]] = {"stop": [], "wake": []}

    async def stop(session_id: str, host_id: str, runner_id: str, *_a: Any) -> bool:
        recorded["stop"].append((session_id, host_id, runner_id))
        return True

    async def wake(_state: Any, conv: Conversation, *_a: Any, **_k: Any) -> Conversation:
        recorded["wake"].append(conv.provider_override)
        return conv

    async def providers(**_k: Any) -> SimpleNamespace:
        return SimpleNamespace(status="ok", providers=_ROWS, error=None)

    async def runner_client(session_id: str, _router: Any) -> object | None:
        return None if session_id == "conv_asleep" else object()

    async def exited(*_a: Any) -> None:
        return None

    monkeypatch.setattr(routes_provider, "_resolve_harness", lambda conv: conv.harness_override)
    monkeypatch.setattr(
        routes_provider, "_validated_provider_override", lambda value, *a, **k: value
    )
    monkeypatch.setattr(routes_provider, "request_host_providers", providers)
    monkeypatch.setattr(routes_provider, "_get_runner_client", runner_client)
    monkeypatch.setattr(routes_provider, "_stop_host_runner_intentionally", stop)
    monkeypatch.setattr(routes_provider, "_wait_for_runner_exit", exited)
    monkeypatch.setattr(routes_provider, "_is_native_terminal_session", lambda conv: True)
    monkeypatch.setattr("omnigent.server.routes.sessions.routes_core.wake_native_runner", wake)
    monkeypatch.setattr(routes_provider, "_pending_switches", {})
    return recorded


def _conv(**overrides: Any) -> Conversation:
    values: dict[str, Any] = {
        "id": "conv_main",
        "root_conversation_id": "conv_main",
        "created_at": 0,
        "updated_at": 0,
        "host_id": "host-a",
        "runner_id": "runner-1",
        "agent_id": "agent-1",
        "harness_override": "claude-native",
    }
    values.update(overrides)
    return Conversation(**values)


async def _switch(store: _Store, provider: str | None, *, online: bool = True) -> Any:
    host = SimpleNamespace(hello=SimpleNamespace(capabilities=[CAP_SESSION_PROVIDER]))
    result = await routes_provider.switch_session_provider(
        SimpleNamespace(),
        store.conv,
        provider,
        agent_store=SimpleNamespace(get=lambda agent_id: object()),
        conversation_store=store,  # type: ignore[arg-type]
        runner_router=None,
        host_registry=SimpleNamespace(get=lambda host_id: host if online else None),  # type: ignore[arg-type]
    )
    await asyncio.gather(*routes_provider._switch_tasks)
    return result


async def test_idle_session_restarts_on_the_new_account(calls: dict[str, list[Any]]) -> None:
    store = _Store(_conv())

    result = await _switch(store, "max2")

    assert (result.provider_override, result.applied) == ("max2", "now")
    assert store.conv.provider_override == "max2"
    assert calls["stop"] == [("conv_main", "host-a", "runner-1")]
    assert calls["wake"] == ["max2"]


async def test_busy_session_switches_once_its_turn_ends(calls: dict[str, list[Any]]) -> None:
    store = _Store(_conv(), status="running")

    result = await _switch(store, "dbx")

    assert result.applied == "after_turn"
    assert store.conv.provider_override == "dbx"
    assert calls["stop"] == []
    # Another busy edge leaves it waiting; the turn's end applies it.
    routes_provider.note_session_status("running")
    store.status = "waiting"
    routes_provider.note_session_status("idle")
    await asyncio.gather(*routes_provider._switch_tasks)
    assert calls["stop"] == []
    store.status = "idle"
    routes_provider.note_session_status("idle")
    await asyncio.gather(*routes_provider._switch_tasks)
    assert calls["stop"] == [("conv_main", "host-a", "runner-1")]
    assert calls["wake"] == ["dbx"]
    assert routes_provider._pending_switches == {}


async def test_session_without_a_runner_starts_on_the_new_account(
    calls: dict[str, list[Any]],
) -> None:
    store = _Store(_conv(id="conv_asleep", root_conversation_id="conv_asleep"))

    result = await _switch(store, "max2")

    assert result.applied == "now"
    assert store.conv.provider_override == "max2"
    assert calls["stop"] == []
    assert routes_provider._pending_switches == {}


async def test_switching_back_to_the_host_default(calls: dict[str, list[Any]]) -> None:
    store = _Store(_conv(provider_override="max2"))

    result = await _switch(store, None)

    assert result.provider_override is None
    assert calls["wake"] == [None]


@pytest.mark.parametrize(
    "conv_overrides,provider,online,message",
    [
        ({}, "alt", True, "keeps a separate login"),
        ({}, "max3", True, "not signed in"),
        ({}, "gone", True, "not configured"),
        ({"harness_override": "codex-native"}, "max2", True, "Only Claude sessions"),
        ({}, "max2", False, "host is offline"),
        ({"provider_override": "alt"}, "max2", True, "keeps a separate login"),
    ],
)
async def test_switch_refuses_providers_it_cannot_resume_on(
    calls: dict[str, list[Any]],
    conv_overrides: dict[str, Any],
    provider: str,
    online: bool,
    message: str,
) -> None:
    store = _Store(_conv(**conv_overrides))
    before = store.conv.provider_override

    with pytest.raises(OmnigentError, match=message) as failure:
        await _switch(store, provider, online=online)

    assert failure.value.code in {ErrorCode.INVALID_INPUT, ErrorCode.RUNNER_UNAVAILABLE}
    assert store.conv.provider_override == before
    assert calls["stop"] == []
