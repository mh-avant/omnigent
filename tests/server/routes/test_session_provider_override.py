"""Sub-agents inherit their parent's provider only within its family and host."""

from __future__ import annotations

from types import SimpleNamespace
from typing import Any

import pytest

from omnigent.entities import Conversation
from omnigent.errors import OmnigentError
from omnigent.server.routes._sessions.helpers import (
    _inherited_provider_override,
    _validated_provider_override,
)
from omnigent.spec.types import ApiKeyAuth, ProviderAuth


def _parent(**overrides: Any) -> Conversation:
    values: dict[str, Any] = {
        "id": "conv_parent",
        "root_conversation_id": "conv_parent",
        "created_at": 0,
        "updated_at": 0,
        "host_id": "host-a",
        "provider_override": "claude-max2",
    }
    values.update(overrides)
    return Conversation(**values)


@pytest.fixture(autouse=True)
def _parent_runs_claude(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(
        "omnigent.server.routes.sessions._resolve_harness", lambda *_a, **_k: "claude-native"
    )


@pytest.mark.parametrize(
    "child_harness,child_host,expected",
    [
        ("claude-sdk", "host-a", "claude-max2"),
        ("claude-native", None, "claude-max2"),
        ("codex", "host-a", None),
        ("claude-sdk", "host-b", None),
    ],
)
def test_child_inherits_within_family_and_host(
    child_harness: str, child_host: str | None, expected: str | None
) -> None:
    assert (
        _inherited_provider_override(
            _parent(), child_harness=child_harness, child_host_id=child_host
        )
        == expected
    )


def test_parent_without_provider_passes_nothing_on() -> None:
    assert (
        _inherited_provider_override(
            _parent(provider_override=None), child_harness="claude-sdk", child_host_id="host-a"
        )
        is None
    )


def _agent_with_auth(monkeypatch: pytest.MonkeyPatch, auth: object) -> SimpleNamespace:
    spec = SimpleNamespace(executor=SimpleNamespace(auth=auth))
    cache = SimpleNamespace(load=lambda *_a, **_k: SimpleNamespace(spec=spec))
    monkeypatch.setattr("omnigent.runtime.get_agent_cache", lambda: cache)
    return SimpleNamespace(id="ag", name="pinned", bundle_location="x", session_id=None)


def test_agent_pinning_another_credential_rejects_a_session_provider(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    agent = _agent_with_auth(monkeypatch, ApiKeyAuth(api_key="k"))

    with pytest.raises(OmnigentError, match="pins its credential"):
        _validated_provider_override("claude-max2", agent, host_id="host-a", host_type="external")


def test_agent_pinning_the_same_provider_accepts_it(monkeypatch: pytest.MonkeyPatch) -> None:
    agent = _agent_with_auth(monkeypatch, ProviderAuth(name="claude-max2"))

    assert (
        _validated_provider_override("claude-max2", agent, host_id="host-a", host_type="external")
        == "claude-max2"
    )
