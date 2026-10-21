"""``/v1/sessions/{id}/pr-watch``: feature gate, permissions, modes and baseline."""

from __future__ import annotations

from collections.abc import AsyncIterator
from pathlib import Path
from typing import Any

import httpx
import pytest
import pytest_asyncio
from fastapi import FastAPI

from omnigent.entities import Conversation
from omnigent.runtime.agent_cache import AgentCache
from omnigent.server.app import create_app
from omnigent.server.auth import LEVEL_OWNER, LEVEL_READ, UnifiedAuthProvider
from omnigent.server.feature_flags import Feature, FeatureFlags
from omnigent.server.pr_watch import (
    MODE_LABEL_KEY,
    WatchState,
    entry_label_keys,
    read_session_watch,
)
from omnigent.stores.agent_store.sqlalchemy_store import SqlAlchemyAgentStore
from omnigent.stores.artifact_store.local import LocalArtifactStore
from omnigent.stores.conversation_store.sqlalchemy_store import SqlAlchemyConversationStore
from omnigent.stores.file_store.sqlalchemy_store import SqlAlchemyFileStore
from omnigent.stores.permission_store.sqlalchemy_store import SqlAlchemyPermissionStore

pytestmark = pytest.mark.asyncio

PR_URL = "https://github.com/org/repo/pull/7"
PR_9 = "https://github.com/org/repo/pull/9"
OWNER = {"X-Forwarded-Email": "owner@example.test"}
VIEWER = {"X-Forwarded-Email": "viewer@example.test"}


@pytest.fixture
def watch_app(runtime_init: None, db_uri: str, tmp_path: Path) -> FastAPI:
    artifact_store = LocalArtifactStore(str(tmp_path / "artifacts"))
    app = create_app(
        agent_store=SqlAlchemyAgentStore(db_uri),
        file_store=SqlAlchemyFileStore(db_uri),
        conversation_store=SqlAlchemyConversationStore(db_uri),
        artifact_store=artifact_store,
        agent_cache=AgentCache(artifact_store=artifact_store, cache_dir=tmp_path / "cache"),
        permission_store=SqlAlchemyPermissionStore(db_uri),
        auth_provider=UnifiedAuthProvider(source="header", local_single_user=False),
    )
    app.state.feature_flags = FeatureFlags(frozenset({Feature.PR_WATCH}))
    return app


@pytest_asyncio.fixture
async def client(watch_app: FastAPI) -> AsyncIterator[httpx.AsyncClient]:
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=watch_app), base_url="http://test"
    ) as client:
        yield client


@pytest.fixture
def session(db_uri: str) -> Conversation:
    conv = SqlAlchemyConversationStore(db_uri).create_conversation()
    permissions = SqlAlchemyPermissionStore(db_uri)
    permissions.grant("owner@example.test", conv.id, LEVEL_OWNER)
    permissions.grant("viewer@example.test", conv.id, LEVEL_READ)
    return conv


def _serve_pr(app: FastAPI, **pr: Any) -> list[str]:
    """Answer the PR reader the way a host would; returns the URLs it was asked for."""
    asked: list[str] = []

    async def read(session_id: str, conv: Conversation, pr_url: str) -> dict[str, Any]:
        asked.append(pr_url)
        return {
            "object": "session.github.info",
            "pr": {
                "number": 7,
                "url": pr_url,
                "state": "OPEN",
                "author": "agent-bot",
                "checks": {"passing": 1, "failing": 0, "pending": 0, "total": 1, "runs": []},
                "comments": [
                    {"author": "alice", "body": "hi", "created_at": "2026-10-21T09:00:00Z"}
                ],
                **pr,
            },
        }

    app.state.pr_info_reader = read
    return asked


def _labels(db_uri: str, session_id: str) -> dict[str, str]:
    conv = SqlAlchemyConversationStore(db_uri).get_conversation(session_id)
    assert conv is not None
    return conv.labels


async def test_owner_picks_prs_then_all_then_off(
    watch_app: FastAPI, client: httpx.AsyncClient, session: Conversation, db_uri: str
) -> None:
    # The session routes hand the watcher the panel's reader and message path.
    assert callable(watch_app.state.server_message_dispatch)
    asked = _serve_pr(watch_app)
    url = f"/v1/sessions/{session.id}/pr-watch"
    assert (await client.get(url, headers=VIEWER)).json() == {
        "object": "session.pr_watch",
        "mode": "off",
        "active": False,
        "max_wakes": 10,
        "prs": [],
    }

    started = await client.patch(
        url, json={"pr_url": PR_URL, "watch": True, "max_wakes": 3}, headers=OWNER
    )

    assert started.status_code == 200, started.text
    [entry] = started.json()["prs"]
    assert started.json()["mode"] == "selected"
    assert entry == {
        "pr_url": PR_URL,
        "watching": True,
        "ended": None,
        "wakes": 0,
        "max_wakes": 3,
        "started_at": entry["started_at"],
    }
    # Comments that predate the watch are not news.
    watch = read_session_watch(_labels(db_uri, session.id))
    assert watch.prs[PR_URL].comment_mark == "2026-10-21T09:00:00Z"

    # Selecting a set reads only the PRs not already watched.
    picked = await client.put(url, json={"pr_urls": [PR_URL, PR_9]}, headers=OWNER)
    assert [pr["pr_url"] for pr in picked.json()["prs"]] == [PR_URL, PR_9]
    assert asked == [PR_URL, PR_9]

    every = await client.put(url, json={"mode": "all", "max_wakes": 4}, headers=OWNER)
    assert (every.json()["mode"], every.json()["max_wakes"]) == ("all", 4)
    assert (await client.get(url, headers=VIEWER)).json()["mode"] == "all"

    # Unchecking one PR in "all" mode keeps the rest and stops picking up new ones.
    one_off = await client.patch(url, json={"pr_url": PR_9, "watch": False}, headers=OWNER)
    assert one_off.json()["mode"] == "selected"
    assert [pr["pr_url"] for pr in one_off.json()["prs"]] == [PR_URL]
    assert MODE_LABEL_KEY not in _labels(db_uri, session.id)

    stopped = await client.delete(url, headers=OWNER)

    assert (stopped.json()["mode"], stopped.json()["prs"]) == ("off", [])
    assert not any(key.startswith("omnigent.pr_watch") for key in _labels(db_uri, session.id))


async def test_all_mode_retries_prs_whose_watch_ended(
    watch_app: FastAPI, client: httpx.AsyncClient, session: Conversation, db_uri: str
) -> None:
    _serve_pr(watch_app)
    url = f"/v1/sessions/{session.id}/pr-watch"
    await client.put(url, json={"pr_urls": [PR_URL, PR_9]}, headers=OWNER)
    store = SqlAlchemyConversationStore(db_uri)
    watch = read_session_watch(_labels(db_uri, session.id))
    _, state_key = entry_label_keys(PR_9)
    store.set_labels(session.id, {state_key: WatchState(ended="green").encode()})
    assert watch.watching == [PR_URL, PR_9]

    every = await client.put(url, json={"mode": "all"}, headers=OWNER)

    assert [pr["pr_url"] for pr in every.json()["prs"]] == [PR_URL]


async def test_watch_needs_edit_access_an_open_pr_and_the_feature(
    watch_app: FastAPI, client: httpx.AsyncClient, session: Conversation
) -> None:
    url = f"/v1/sessions/{session.id}/pr-watch"
    _serve_pr(watch_app)
    on = {"pr_url": PR_URL, "watch": True}
    assert (await client.patch(url, json=on, headers=VIEWER)).status_code == 403
    assert (await client.put(url, json={"mode": "all"}, headers=VIEWER)).status_code == 403
    assert (await client.delete(url, headers=VIEWER)).status_code == 403
    mixed = {"mode": "all", "pr_urls": [PR_URL]}
    assert (await client.put(url, json=mixed, headers=OWNER)).status_code == 422

    _serve_pr(watch_app, state="MERGED")
    refused = await client.put(url, json={"pr_urls": [PR_URL]}, headers=OWNER)
    assert refused.status_code == 409
    assert PR_URL in refused.text and "Only open pull requests" in refused.text
    _serve_pr(watch_app, checks_supported=False)
    assert (await client.patch(url, json=on, headers=OWNER)).status_code == 409

    watch_app.state.feature_flags = FeatureFlags()
    assert (await client.get(url, headers=OWNER)).status_code == 404


@pytest.mark.parametrize("key", ["omnigent.pr_watch", MODE_LABEL_KEY, "omnigent.pr_watch.x.url"])
async def test_clients_cannot_write_watch_labels_directly(
    client: httpx.AsyncClient, session: Conversation, key: str
) -> None:
    response = await client.patch(
        f"/v1/sessions/{session.id}",
        json={"labels": {key: "all"}},
        headers=OWNER,
    )
    assert response.status_code == 400
