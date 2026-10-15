"""Providers a connected host can run a harness on, for the new-session picker."""

from __future__ import annotations

import asyncio
import secrets

from fastapi import APIRouter, HTTPException, Query, Request
from pydantic import BaseModel

from omnigent.host.frames import (
    CAP_SESSION_PROVIDER,
    HostProvidersFrame,
    HostProvidersResultFrame,
    encode_host_frame,
)
from omnigent.server.auth import AuthProvider
from omnigent.server.host_registry import HostConnection, HostRegistry
from omnigent.server.routes._auth_helpers import require_user
from omnigent.server.routes._host_launch import host_absent_error, resolve_host_owner
from omnigent.stores.host_store import HostStore

_PROVIDERS_TIMEOUT_S = 15.0


class HostProviderSummary(BaseModel):
    """A provider a session can choose, without credentials.

    :param name: The ``providers:`` entry name, e.g. ``"claude-max2"``.
    :param kind: ``subscription``, ``key``, ``gateway``, ``local``,
        ``databricks``, ``cli-config``, or ``bedrock``.
    :param label: Where it authenticates, e.g. ``"claude CLI login (~/.claude-max2)"``.
    :param default: Whether sessions use it when none is chosen.
    :param ready: ``False`` when a subscription account is not logged in.
    :param switch_group: Opaque id shared by the providers a running session
        can switch between, e.g. ``"3f2a9c1d0b7e"``; ``None`` when switching is
        not supported.
    """

    name: str
    kind: str
    label: str
    default: bool
    ready: bool
    switch_group: str | None = None


class HostProvidersResponse(BaseModel):
    """Providers a host can run the requested harness on."""

    providers: list[HostProviderSummary]


def create_host_providers_router(
    host_registry: HostRegistry,
    host_store: HostStore,
    *,
    auth_provider: AuthProvider | None = None,
) -> APIRouter:
    """Build the host provider listing route, mounted under ``/v1``."""
    router = APIRouter()

    @router.get("/hosts/{host_id}/providers")
    async def get_host_providers(
        request: Request, host_id: str, harness: str = Query(min_length=1)
    ) -> HostProvidersResponse:
        """List the providers configured on a host that can run *harness*.

        Names and non-secret labels only; the caller must own the host.
        """
        user_id = require_user(request, auth_provider)
        host = await asyncio.to_thread(
            resolve_host_owner, user_id=user_id, host_id=host_id, host_store=host_store
        )
        conn = host_registry.get(host_id)
        if conn is None:
            raise host_absent_error(host)
        if CAP_SESSION_PROVIDER not in conn.hello.capabilities:
            return HostProvidersResponse(providers=[])
        result = await request_host_providers(
            host_registry=host_registry, host_conn=conn, harness=harness
        )
        if result.status != "ok":
            raise HTTPException(
                status_code=502, detail=result.error or "host provider listing failed"
            )
        return HostProvidersResponse(
            providers=[HostProviderSummary.model_validate(p) for p in result.providers]
        )

    return router


async def request_host_providers(
    *, host_registry: HostRegistry, host_conn: HostConnection, harness: str
) -> HostProvidersResultFrame:
    """Request the provider listing over the host tunnel, with bounded waiting."""
    request_id = secrets.token_hex(8)
    future: asyncio.Future[HostProvidersResultFrame] = asyncio.get_running_loop().create_future()
    host_conn.pending_providers[request_id] = future
    try:
        host_registry.send_text(
            host_conn,
            encode_host_frame(HostProvidersFrame(request_id=request_id, harness=harness)),
        )
        return await asyncio.wait_for(future, timeout=_PROVIDERS_TIMEOUT_S)
    except ConnectionError as exc:
        raise HTTPException(
            status_code=502, detail=f"host '{host_conn.host_id}' connection lost"
        ) from exc
    except TimeoutError as exc:
        raise HTTPException(
            status_code=504,
            detail=(
                f"host '{host_conn.host_id}' did not list providers "
                f"within {_PROVIDERS_TIMEOUT_S:.0f}s"
            ),
        ) from exc
    finally:
        host_conn.pending_providers.pop(request_id, None)
