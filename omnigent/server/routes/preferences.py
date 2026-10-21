"""Per-user preference routes (``/v1/preferences``) and the chat-feature catalog.

Shared preferences take explicit reads and versioned edits. The only value the
server adopts is the chat-features default, read when a session is created.
"""

import asyncio
import logging
from collections.abc import Iterable
from typing import Annotated, Any

from fastapi import APIRouter, Query, Request
from pydantic import TypeAdapter, ValidationError

from omnigent.errors import ErrorCode, OmnigentError
from omnigent.preference_sync import (
    PREFERENCE_PAGE_SIZE,
    Name,
    PreferenceMutation,
    PreferencePage,
    PreferenceResult,
    SharedPreferenceKey,
)
from omnigent.runtime.chat_features import (
    CHAT_FEATURE_DEFINITIONS,
    DEFAULT_CHAT_FEATURES,
    ChatFeature,
    chat_features_from_wire,
    decode_chat_features,
    parse_chat_features,
)
from omnigent.server.auth import AuthProvider
from omnigent.server.routes._auth_helpers import require_user
from omnigent.server.schemas import ChatFeatureCatalogResponse, ChatFeatureOption
from omnigent.stores.preference_store import PreferenceStore, read_preference_entry

_logger = logging.getLogger(__name__)

_USER_ID = TypeAdapter(Name)


def create_preferences_router(
    store: PreferenceStore,
    auth_provider: AuthProvider | None = None,
) -> APIRouter:
    router = APIRouter()

    def user_id(request: Request) -> str | None:
        authenticated = require_user(request, auth_provider)
        if authenticated is None:
            return None
        try:
            return _USER_ID.validate_python(authenticated)
        except ValidationError as exc:
            raise OmnigentError(
                "Invalid preference user ID", code=ErrorCode.INVALID_INPUT
            ) from exc

    @router.get("/preferences/shared", response_model=PreferencePage)
    async def read_preferences(
        request: Request,
        limit: Annotated[int, Query(ge=1, le=PREFERENCE_PAGE_SIZE)] = PREFERENCE_PAGE_SIZE,
        cursor: Annotated[str | None, Query(max_length=4096)] = None,
    ) -> PreferencePage:
        return await asyncio.to_thread(
            store.read, user_id=user_id(request), limit=limit, cursor=cursor
        )

    @router.post("/preferences/shared/operations", response_model=PreferenceResult)
    async def apply_preference(request: Request, body: PreferenceMutation) -> PreferenceResult:
        return await asyncio.to_thread(store.apply, body, user_id=user_id(request))

    return router


def parse_requested_chat_features(values: Iterable[str]) -> frozenset[ChatFeature]:
    """Parse chat-feature keys from an API request.

    :param values: Requested keys, e.g. ``["run_commands"]``.
    :returns: The parsed set.
    :raises OmnigentError: ``INVALID_INPUT`` naming any unknown key.
    """
    try:
        return parse_chat_features(values)
    except ValueError as exc:
        raise OmnigentError(str(exc), code=ErrorCode.INVALID_INPUT) from exc


CHAT_FEATURES_PREFERENCE_KEY = SharedPreferenceKey(kind="chat_features", name="default")


def saved_chat_features(
    preference_store: PreferenceStore | None, *, user_id: str | None
) -> frozenset[ChatFeature] | None:
    """Read the user's default chat features from shared preferences.

    :param preference_store: The shared store; ``None`` when the server has none.
    :param user_id: The user, as the shared routes identify them.
    :returns: The known features in the saved value, or ``None`` when there is
        no usable saved value (never saved, removed, or unreadable).
    """
    if preference_store is None:
        return None
    try:
        entry = read_preference_entry(
            preference_store,
            CHAT_FEATURES_PREFERENCE_KEY,
            user_id=None if user_id is None else _USER_ID.validate_python(user_id),
        )
    except (OmnigentError, ValidationError):
        # A broken preference read must not block creating the session.
        _logger.warning("Could not read the saved chat-features default", exc_info=True)
        return None
    if entry is None or entry.value is None:
        return None
    return chat_features_from_wire(entry.value)


def resolve_session_chat_features(
    requested: frozenset[ChatFeature] | None,
    *,
    user_id: str | None,
    preference_store: PreferenceStore | None,
) -> frozenset[ChatFeature]:
    """Resolve a new session's chat features: request, then saved default, then every feature.

    :param requested: Parsed features from the create request, or ``None`` if omitted.
    :param user_id: The creating user.
    :param preference_store: The shared store; ``None`` uses every feature.
    :returns: The set to store on the session.
    """
    if requested is not None:
        return requested
    saved = saved_chat_features(preference_store, user_id=user_id)
    return DEFAULT_CHAT_FEATURES if saved is None else saved


async def resolve_new_session_chat_features(
    requested: frozenset[ChatFeature] | None,
    *,
    user_id: str | None,
    app_state: Any,
    parent_chat_features_override: str | None = None,
    has_parent: bool = False,
) -> frozenset[ChatFeature]:
    """Resolve the chat features a new session stores.

    A sub-agent inherits its parent's set; otherwise an omitted request uses
    the creator's saved default, then every feature.

    :param requested: Parsed request value, or ``None`` when omitted.
    :param user_id: The creating user.
    :param app_state: ``app.state``, carrying the optional shared ``preference_store``.
    :param parent_chat_features_override: The parent's stored value.
    :param has_parent: Whether the session is a sub-agent child.
    :returns: The resolved set.
    """
    if requested is None and has_parent:
        return decode_chat_features(parent_chat_features_override)
    return await asyncio.to_thread(
        resolve_session_chat_features,
        requested,
        user_id=user_id,
        preference_store=getattr(app_state, "preference_store", None),
    )


def create_chat_features_router(auth_provider: AuthProvider | None = None) -> APIRouter:
    """Build the read-only chat-feature catalog router (``GET /chat-features``).

    :param auth_provider: Identifies the caller; ``None`` in single-user mode.
    :returns: A configured :class:`APIRouter`.
    """
    router = APIRouter()

    @router.get("/chat-features")
    async def list_chat_features(request: Request) -> ChatFeatureCatalogResponse:
        """Every chat feature a session can enable, in display order."""
        require_user(request, auth_provider)
        return ChatFeatureCatalogResponse(
            available=[
                ChatFeatureOption(
                    key=str(definition.feature),
                    title=definition.title,
                    description=definition.description,
                )
                for definition in CHAT_FEATURE_DEFINITIONS
            ]
        )

    return router
