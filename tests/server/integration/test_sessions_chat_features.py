"""Integration tests for per-session ``chat_features`` and the per-user default.

Mirrors ``test_sessions_cost_control_override.py``: create stores a resolved
set, PATCH writes it, and the snapshot reads it back. Unlike that switch, an
explicit JSON ``null`` resets to the caller's saved default rather than unset.
The default is the ``chat_features`` key of the opt-in shared preferences.
"""

from __future__ import annotations

from typing import Any
from uuid import uuid4

import httpx
import pytest

from omnigent.stores.preference_store.sqlalchemy_store import SqlAlchemyPreferenceStore
from tests.server.helpers import create_test_agent

pytestmark = pytest.mark.asyncio

_KEY = {"kind": "chat_features", "name": "default"}


@pytest.fixture()
def server_preference_store(db_uri: str) -> SqlAlchemyPreferenceStore:
    return SqlAlchemyPreferenceStore(db_uri, authority_id="test-authority")


async def _create_session(client: httpx.AsyncClient, **fields: Any) -> dict[str, Any]:
    agent = await create_test_agent(client)
    resp = await client.post(
        "/v1/sessions", json={"agent_id": agent["id"], "initial_items": [], **fields}
    )
    assert resp.status_code == 201, resp.text
    return resp.json()


async def _save_default(client: httpx.AsyncClient, enabled: list[str] | None) -> dict[str, Any]:
    snapshot = (await client.get("/v1/preferences/shared")).json()
    version = next((entry["version"] for entry in snapshot["entries"] if entry["key"] == _KEY), 0)
    resp = await client.post(
        "/v1/preferences/shared/operations",
        json={
            "protocol_version": 1,
            "identity": snapshot["identity"],
            "operation_id": str(uuid4()),
            "installation_id": "browser",
            "key": _KEY,
            "expected_version": version,
            "value": enabled,
        },
    )
    assert resp.status_code == 200, resp.text
    return resp.json()


async def test_catalog_lists_every_feature(client: httpx.AsyncClient) -> None:
    resp = await client.get("/v1/chat-features")
    assert resp.status_code == 200, resp.text
    available = resp.json()["available"]
    assert [option["key"] for option in available] == ["run_commands"]
    assert available[0]["title"] == "Run suggested commands"


async def test_saved_value_is_normalized_and_keeps_unknown_keys(
    client: httpx.AsyncClient,
) -> None:
    saved = await _save_default(client, ["run_commands", "from_newer_build", "run_commands"])
    assert saved["entry"]["value"] == ["from_newer_build", "run_commands"]
    # The same set in another order changes nothing.
    again = await _save_default(client, ["run_commands", "from_newer_build"])
    assert again["status"] == "unchanged"
    # Unknown keys are dropped only when a session resolves the default.
    assert (await _create_session(client))["chat_features"] == ["run_commands"]
    await _save_default(client, ["from_newer_build"])
    assert (await _create_session(client))["chat_features"] == []


async def test_create_resolves_request_then_saved_default_then_builtin(
    client: httpx.AsyncClient,
) -> None:
    assert (await _create_session(client))["chat_features"] == ["run_commands"]

    await _save_default(client, [])
    session = await _create_session(client)
    assert session["chat_features"] == []
    explicit = await _create_session(client, chat_features=["run_commands"])
    assert explicit["chat_features"] == ["run_commands"]

    # The stored set is explicit, so a later default change leaves it alone.
    await _save_default(client, ["run_commands"])
    reread = await client.get(f"/v1/sessions/{session['id']}")
    assert reread.json()["chat_features"] == []

    # Removing the saved choice falls back to every feature.
    await _save_default(client, None)
    assert (await _create_session(client))["chat_features"] == ["run_commands"]

    agent = await create_test_agent(client)
    unknown = await client.post(
        "/v1/sessions",
        json={"agent_id": agent["id"], "initial_items": [], "chat_features": ["nope"]},
    )
    assert unknown.status_code == 400
    assert "nope" in unknown.text


@pytest.mark.parametrize("server_preference_store", [None])
async def test_without_shared_preferences_sessions_get_every_feature(
    client: httpx.AsyncClient,
) -> None:
    assert (await client.get("/v1/preferences/shared")).status_code == 404
    assert (await client.get("/v1/chat-features")).status_code == 200
    session = await _create_session(client)
    assert session["chat_features"] == ["run_commands"]
    sid = session["id"]
    cleared = await client.patch(f"/v1/sessions/{sid}", json={"chat_features": []})
    assert cleared.json()["chat_features"] == []
    reset = await client.patch(f"/v1/sessions/{sid}", json={"chat_features": None})
    assert reset.json()["chat_features"] == ["run_commands"]


async def test_patch_sets_resets_and_rejects_chat_features(client: httpx.AsyncClient) -> None:
    session = await _create_session(client)
    sid = session["id"]

    cleared = await client.patch(f"/v1/sessions/{sid}", json={"chat_features": []})
    assert cleared.status_code == 200, cleared.text
    assert cleared.json()["chat_features"] == []

    renamed = await client.patch(f"/v1/sessions/{sid}", json={"title": "renamed"})
    assert renamed.json()["chat_features"] == []

    unknown = await client.patch(f"/v1/sessions/{sid}", json={"chat_features": ["nope"]})
    assert unknown.status_code == 400
    assert (await client.get(f"/v1/sessions/{sid}")).json()["chat_features"] == []

    # Explicit null resets to the caller's current default, not the built-in one.
    await _save_default(client, [])
    await client.patch(f"/v1/sessions/{sid}", json={"chat_features": ["run_commands"]})
    reset = await client.patch(f"/v1/sessions/{sid}", json={"chat_features": None})
    assert reset.status_code == 200, reset.text
    assert reset.json()["chat_features"] == []


async def test_children_and_forks_copy_the_source_chat_features(
    client: httpx.AsyncClient,
) -> None:
    parent = await _create_session(client, chat_features=[])

    child = await _create_session(client, parent_session_id=parent["id"])
    assert child["chat_features"] == []

    fork = await client.post(f"/v1/sessions/{parent['id']}/fork", json={})
    assert fork.status_code in (200, 201), fork.text
    forked = await client.get(f"/v1/sessions/{fork.json()['id']}")
    assert forked.json()["chat_features"] == []


async def test_runner_receives_chat_features_at_init_and_per_turn(
    client: httpx.AsyncClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    from omnigent.server.routes import sessions as sessions_mod
    from tests.server.integration.test_sessions_harness_override import _stub_runner_client

    captured = _stub_runner_client(monkeypatch)

    async def _skip_relay_readiness(*_: Any, **__: Any) -> None:
        return None

    def _accept_runner_id(_router: Any, raw: str, *, user_id: Any = None) -> str:
        del user_id
        return raw.strip()

    monkeypatch.setattr(sessions_mod, "_ensure_runner_relay_ready", _skip_relay_readiness)
    monkeypatch.setattr(sessions_mod, "_registered_runner_id", _accept_runner_id)

    sid = (await _create_session(client, chat_features=[]))["id"]
    bind = await client.patch(f"/v1/sessions/{sid}", json={"runner_id": "runner_chat_features"})
    assert bind.status_code == 200, bind.text
    init_posts = [body for path, body in captured.get("posts", []) if path == "/v1/sessions"]
    assert init_posts[-1]["session_init"]["snapshot"]["chat_features"] == []

    message = {
        "type": "message",
        "data": {"role": "user", "content": [{"type": "input_text", "text": "hi"}]},
    }
    assert (await client.post(f"/v1/sessions/{sid}/events", json=message)).status_code == 202
    assert captured["body"]["chat_features"] == []

    # A PATCH reaches the next forwarded turn without a runner restart.
    await client.patch(f"/v1/sessions/{sid}", json={"chat_features": ["run_commands"]})
    assert (await client.post(f"/v1/sessions/{sid}/events", json=message)).status_code == 202
    assert captured["body"]["chat_features"] == ["run_commands"]
