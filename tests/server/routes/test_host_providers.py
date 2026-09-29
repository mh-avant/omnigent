"""The host provider listing is owner-only and empty for older hosts."""

from __future__ import annotations

import asyncio
from unittest.mock import AsyncMock

import httpx
import pytest
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

from omnigent.errors import OmnigentError
from omnigent.host.frames import (
    CAP_SESSION_PROVIDER,
    HostHelloFrame,
    HostProvidersFrame,
    HostProvidersResultFrame,
    decode_host_frame,
)
from omnigent.server.host_registry import HostConnection, HostRegistry
from omnigent.server.routes.host_providers import create_host_providers_router
from omnigent.stores.host_store import HostStore

_HOST_ID = "a828988dc0b441fb8d04dad3761773b9"
_MAX2: dict[str, str | bool] = {
    "name": "claude-max2",
    "kind": "subscription",
    "label": "claude CLI login (~/.claude-max2)",
    "default": False,
    "ready": True,
}


class _Auth:
    def get_user_id(self, request: Request) -> str | None:
        return request.headers.get("x-test-user")


def _register(registry: HostRegistry, *capabilities: str) -> HostConnection:
    return registry.register(
        _HOST_ID,
        AsyncMock(),
        HostHelloFrame(
            version="test",
            frame_protocol_version=1,
            name="laptop",
            capabilities=list(capabilities),
        ),
        owner="owner",
    )


@pytest.fixture
def providers_app(db_uri: str) -> tuple[FastAPI, HostRegistry]:
    registry = HostRegistry()
    hosts = HostStore(db_uri)
    hosts.upsert_on_connect(_HOST_ID, "laptop", "owner")
    app = FastAPI()
    app.include_router(
        create_host_providers_router(registry, hosts, auth_provider=_Auth()), prefix="/v1"
    )

    @app.exception_handler(OmnigentError)
    async def handle_error(request: Request, exc: OmnigentError) -> JSONResponse:
        return JSONResponse(status_code=exc.http_status, content={"detail": exc.message})

    return app, registry


def _client(app: FastAPI) -> httpx.AsyncClient:
    return httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test")


async def test_owner_gets_providers_for_the_harness(providers_app) -> None:
    app, registry = providers_app
    conn = _register(registry, CAP_SESSION_PROVIDER)
    async with _client(app) as client:
        task = asyncio.create_task(
            client.get(
                f"/v1/hosts/{_HOST_ID}/providers",
                params={"harness": "claude-native"},
                headers={"x-test-user": "owner"},
            )
        )
        frame = decode_host_frame((await asyncio.wait_for(conn.outbound_queue.get(), 2)).data)
        assert isinstance(frame, HostProvidersFrame)
        assert frame.harness == "claude-native"
        conn.pending_providers[frame.request_id].set_result(
            HostProvidersResultFrame(frame.request_id, "ok", providers=[_MAX2])
        )
        response = await task
    assert response.status_code == 200
    assert response.json() == {"providers": [_MAX2]}
    assert not conn.pending_providers


async def test_non_owner_does_not_reach_the_host(providers_app) -> None:
    app, registry = providers_app
    conn = _register(registry, CAP_SESSION_PROVIDER)
    async with _client(app) as client:
        response = await client.get(
            f"/v1/hosts/{_HOST_ID}/providers",
            params={"harness": "codex"},
            headers={"x-test-user": "stranger"},
        )
    assert response.status_code == 403
    assert conn.outbound_queue.empty()


async def test_older_host_lists_nothing(providers_app) -> None:
    app, registry = providers_app
    conn = _register(registry)
    async with _client(app) as client:
        response = await client.get(
            f"/v1/hosts/{_HOST_ID}/providers",
            params={"harness": "codex"},
            headers={"x-test-user": "owner"},
        )
    assert response.status_code == 200
    assert response.json() == {"providers": []}
    assert conn.outbound_queue.empty()


async def test_host_failure_is_a_bad_gateway(providers_app) -> None:
    app, registry = providers_app
    conn = _register(registry, CAP_SESSION_PROVIDER)
    async with _client(app) as client:
        task = asyncio.create_task(
            client.get(
                f"/v1/hosts/{_HOST_ID}/providers",
                params={"harness": "codex"},
                headers={"x-test-user": "owner"},
            )
        )
        frame = decode_host_frame((await asyncio.wait_for(conn.outbound_queue.get(), 2)).data)
        conn.pending_providers[frame.request_id].set_result(
            HostProvidersResultFrame(frame.request_id, "failed", error="bad config")
        )
        response = await task
    assert response.status_code == 502
    assert response.json()["detail"] == "bad config"
