"""Authenticated workspace preference persistence contract."""

from typing import Protocol

from omnigent.errors import ErrorCode, OmnigentError
from omnigent.preference_sync import (
    PREFERENCE_PAGE_SIZE,
    PreferenceMutation,
    PreferenceNamespace,
    PreferencePage,
    PreferenceResult,
    SharedPreferenceEntry,
    SharedPreferenceKey,
)

_PAGINATION_RESTARTS = 2


class PreferenceStore(Protocol):
    def identity(self, user_id: str | None) -> PreferenceNamespace: ...

    def read(
        self, *, user_id: str | None, limit: int = PREFERENCE_PAGE_SIZE, cursor: str | None = None
    ) -> PreferencePage: ...

    def apply(self, operation: PreferenceMutation, *, user_id: str | None) -> PreferenceResult: ...


def read_preference_entry(
    store: PreferenceStore, key: SharedPreferenceKey, *, user_id: str | None
) -> SharedPreferenceEntry | None:
    """Return one key's entry, or ``None`` when it was never saved.

    :param store: The shared-preference store.
    :param key: The key to find, e.g. ``{"kind": "harness", "name": "default"}``.
    :param user_id: Authenticated user, or ``None`` for the reserved local namespace.
    :returns: The entry; its ``value`` is ``None`` after a removal.
    :raises OmnigentError: When edits keep landing between pages, or the read fails.
    """
    restarts = 0
    cursor: str | None = None
    while True:
        try:
            page = store.read(user_id=user_id, cursor=cursor)
        except OmnigentError as exc:
            # An edit landed between pages: restart from page one.
            if (
                exc.code != ErrorCode.CONFLICT
                or cursor is None
                or restarts >= _PAGINATION_RESTARTS
            ):
                raise
            restarts += 1
            cursor = None
            continue
        for entry in page.entries:
            if entry.key == key:
                return entry
        if page.next_cursor is None:
            return None
        cursor = page.next_cursor
