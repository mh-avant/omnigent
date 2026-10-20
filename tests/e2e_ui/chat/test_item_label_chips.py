"""UI journey: an item label in a later message previews where it was raised.

An agent raises labelled items (``[Q2]``) in a verbose reply, then refers to
them by label in a later status update. Clicking the later chip must preview
the defining item's own block, not the whole message, without scrolling the
transcript; "Show in conversation" then jumps to the defining message. Closing
an item (``~~[Q2]~~``) strikes its chips, the popover shows how it was closed,
and the pinned Open items panel lists only what is still open.
"""

from __future__ import annotations

import re
import uuid

from playwright.sync_api import Page, expect

from tests.e2e_ui.conftest import configure_mock_llm

_COMPOSER = "Send a message…"
_ASSISTANT = '[data-testid="message-bubble"][data-role="assistant"]'
_WORKING = '[data-testid="working-indicator"]'

_AUDIT_REPLY = """\
I finished the migration audit. A few things need your call before I continue:

1. **[Q1] Backfill window.** The `events` table has 41M rows; one backfill
   transaction would hold locks for ~20 minutes. I can batch by `created_at`
   day (about 900 batches, ~35 min total) or run it in the maintenance window.
2. **[Q2] Soft-deleted rows.** 3,112 rows have `deleted_at` set but still
   reference live accounts. Options:
   - copy them as-is (keeps audit history)
   - drop them (cleaner, but the audit export loses them)
3. **[Q3] Index naming.** Upstream uses `ix_<table>_<cols>`, ours uses
   `<table>_<cols>_idx`. Renaming touches 14 indexes.

[R1] Heads-up: the `ON DELETE CASCADE` on `sessions.account_id` will cascade
through the new table too, so deleting an account removes its migrated events."""

_STATUS_REPLY = (
    "Batching is underway (412 of 900 days). [Q1] is settled by the batching. "
    "Still need your decision on [Q2] and [Q3], and [R1] still applies."
)

_CLOSING_REPLY = (
    "Done. ~~[Q2]~~ copied the soft-deleted rows as-is. ~~[Q3]~~ keeping our index naming."
)


def _send(page: Page, text: str) -> None:
    composer = page.get_by_placeholder(_COMPOSER)
    expect(composer).to_be_visible()
    composer.fill(text)
    page.get_by_role("button", name="Send", exact=True).click()


def _settle(page: Page, assistant_count: int) -> None:
    expect(page.locator(_ASSISTANT)).to_have_count(assistant_count, timeout=60_000)
    expect(page.locator(_WORKING)).to_have_count(0, timeout=60_000)


def test_item_label_chip_previews_defining_item(
    page: Page,
    seeded_session: tuple[str, str],
    mock_llm_server_url: str,
) -> None:
    base_url, session_id = seeded_session
    run = uuid.uuid4().hex[:8]

    configure_mock_llm(
        mock_llm_server_url, [{"text": _AUDIT_REPLY}], key=f"audit-{run}", match=f"audit {run}"
    )
    configure_mock_llm(
        mock_llm_server_url, [{"text": _STATUS_REPLY}], key=f"status-{run}", match=f"status {run}"
    )
    configure_mock_llm(
        mock_llm_server_url,
        [{"text": _CLOSING_REPLY}],
        key=f"answer-{run}",
        match=f"answers {run}",
    )

    page.set_viewport_size({"width": 1280, "height": 900})
    page.goto(f"{base_url}/c/{session_id}")
    _send(page, f"Run the migration audit {run}")
    _settle(page, 1)
    _send(page, f"What's the status {run}?")
    _settle(page, 2)
    _send(page, f"My answers {run}: [Q2] copy them as-is. [Q3] keep our naming.")
    _settle(page, 3)

    status = page.locator(_ASSISTANT).nth(1)
    # The defining message shows static badges; the status update shows chips.
    expect(
        page.locator(_ASSISTANT).first.get_by_role("button", name="Show item Q2")
    ).to_have_count(0)

    status.get_by_role("button", name="Show item Q2").click()
    popover = page.locator('[data-slot="popover-content"][data-state="open"]')
    expect(popover).to_contain_text("Soft-deleted rows")
    expect(popover).to_contain_text("drop them")
    expect(popover).not_to_contain_text("Backfill window")
    page.keyboard.press("Escape")

    status.get_by_role("button", name="Show item R1").click()
    expect(popover).to_contain_text("ON DELETE CASCADE")
    page.keyboard.press("Escape")

    user_reply = page.locator('[data-testid="message-bubble"][data-role="user"]').nth(2)
    user_reply.get_by_role("button", name="Show item Q3 (closed)").click()
    expect(popover).to_contain_text("Index naming")
    expect(popover).to_contain_text("Closed · Agent")
    expect(popover).to_contain_text("keeping our index naming")
    page.keyboard.press("Escape")

    # The panel lists what is still open; closed items fold under "Closed".
    panel = page.get_by_test_id("open-items")
    expect(panel).to_contain_text("Open items")
    expect(panel).to_contain_text("(2)")
    panel.get_by_role("button", name="Show item R1").first.click()
    expect(popover).to_contain_text("ON DELETE CASCADE")
    page.keyboard.press("Escape")
    panel.locator("summary").click()
    expect(panel.get_by_role("button", name="Show item Q2 (closed)")).to_contain_text(
        "Soft-deleted rows"
    )

    status.get_by_role("button", name="Show item Q2 (closed)").click()
    popover.get_by_role("button", name="Show in conversation").click()
    expect(page).to_have_url(re.compile(r"[?&]message="), timeout=5_000)

    # Reloaded history at phone width resolves labels the same way.
    page.set_viewport_size({"width": 390, "height": 844})
    page.goto(f"{base_url}/c/{session_id}")
    expect(page.locator(_ASSISTANT)).to_have_count(3, timeout=15_000)
    page.locator(_ASSISTANT).nth(1).scroll_into_view_if_needed()
    page.locator(_ASSISTANT).nth(1).get_by_role("button", name="Show item R1").click()
    expect(popover).to_contain_text("ON DELETE CASCADE")
