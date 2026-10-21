"""UI journey: an item label in a later message previews where it was raised.

An agent raises labelled items (``[Q2]``) in a verbose reply, then refers to
them by label in a later status update. Clicking the later chip must preview
the defining item's own block, not the whole message, without scrolling the
transcript; "Show in conversation" then jumps to the defining message. Closing
an item (``~~[Q2]~~``) strikes its chips, the popover shows how it was closed,
and the pinned Open items panel lists only what is still open. Comments drafted
on several items go out as one message and rebuild each item's thread.
"""

from __future__ import annotations

import re
import uuid
from pathlib import Path

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
    popover = page.locator('[data-slot="popover-content"][data-state="open"]')
    # The label in its defining message opens the same preview.
    page.locator(_ASSISTANT).first.get_by_role("button", name="Show item Q3").click()
    expect(popover).to_contain_text("Index naming")
    page.keyboard.press("Escape")

    status.get_by_role("button", name="Show item Q2").click()
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


_COMMENT_REPLY = (
    "Thanks for the notes. [Q2] I'm copying the soft-deleted rows as-is. "
    "For [R1], I'll leave the cascade in place."
)

_USER = '[data-testid="message-bubble"][data-role="user"]'


def test_item_comments_submit_together_and_thread_in_popover(
    page: Page,
    seeded_session: tuple[str, str],
    mock_llm_server_url: str,
    tmp_path: Path,
) -> None:
    """Comments drafted on several items go out as one message and come back from the transcript.

    The user comments on Q2 from a later chip and on R1 from its defining
    message (with an attachment), types a general note, and submits. After a
    reload the popovers rebuild each item's thread from the transcript: the
    comment, its file, and the agent's reply sentence. At phone width the
    item's definition, the Save button and the collapsed tray's send button
    still fit.
    """
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
        [{"text": _COMMENT_REPLY}],
        key=f"comments-{run}",
        match=f"General note {run}",
    )

    page.set_viewport_size({"width": 1280, "height": 900})
    page.goto(f"{base_url}/c/{session_id}")
    _send(page, f"Run the migration audit {run}")
    _settle(page, 1)
    _send(page, f"What's the status {run}?")
    _settle(page, 2)

    popover = page.locator('[data-slot="popover-content"][data-state="open"]')
    composer = page.get_by_label("Message the agent")
    comment_mode = page.get_by_test_id("item-comment-mode")
    tray = page.get_by_test_id("item-comment-tray")
    status = page.locator(_ASSISTANT).nth(1)

    # Comment on Q2 from a later mention: its definition stays readable, and
    # Enter saves the comment to the drafts tray, which stays collapsed.
    status.get_by_role("button", name="Show item Q2").click()
    popover.get_by_role("button", name="Comment").click()
    expect(comment_mode).to_contain_text("Q2")
    expect(comment_mode).to_contain_text("Soft-deleted rows")
    expect(comment_mode.get_by_role("region", name="Q2 text")).to_contain_text("drop them")
    composer.fill("Copy them as-is; the audit export needs them.")
    composer.press("Enter")
    expect(comment_mode).to_have_count(0)
    expect(tray).to_contain_text("1 comment · Q2")
    expect(tray.get_by_test_id("item-comment-draft-row")).to_have_count(0)
    expect(status.get_by_role("button", name="Show item Q2, 1 draft")).to_be_visible()

    # Comment on R1 from the message that defines it, with a file attached.
    notes = tmp_path / "cascade-notes.txt"
    notes.write_text("sessions.account_id cascades to migrated events\n")
    page.locator(_ASSISTANT).first.get_by_role("button", name="Show item R1").click()
    popover.get_by_role("button", name="Comment").click()
    expect(comment_mode).to_contain_text("R1")
    composer.fill("Keep the cascade; deleting an account should remove its events.")
    page.locator('form.chat-composer-form input[type="file"]').set_input_files(str(notes))
    page.get_by_role("button", name="Save comment").click()
    tray.get_by_role("button", name="Show comment drafts").click()
    expect(tray.get_by_test_id("item-comment-draft-row")).to_have_count(2)
    expect(tray).to_contain_text("Copy them as-is")

    # A message typed alongside goes out as the General section.
    composer.fill(f"General note {run}: the audit can resume after this.")
    tray.get_by_role("button", name="Send 2 comments + message").click()
    _settle(page, 3)
    review = page.locator(_USER).last
    expect(review).to_contain_text("Comments on 2 items")
    expect(review).to_contain_text("cascade-notes.txt")
    expect(tray).to_have_count(0)

    # Reloaded, the threads come back from the transcript.
    page.goto(f"{base_url}/c/{session_id}")
    expect(page.locator(_ASSISTANT)).to_have_count(3, timeout=15_000)
    status = page.locator(_ASSISTANT).nth(1)
    status.get_by_role("button", name="Show item Q2, 1 comment").click()
    expect(popover).to_contain_text("Comments (1)")
    expect(popover).to_contain_text("Copy them as-is; the audit export needs them.")
    expect(popover).to_contain_text("Agent replied")
    expect(popover).to_contain_text("I'm copying the soft-deleted rows as-is.")
    page.keyboard.press("Escape")
    status.get_by_role("button", name="Show item R1, 1 comment").click()
    expect(popover).to_contain_text("Keep the cascade")
    expect(popover).to_contain_text("cascade-notes.txt")
    expect(popover).to_contain_text("I'll leave the cascade in place.")
    page.keyboard.press("Escape")

    # Phone width: comment from the Open items panel; after a reload the tray
    # starts collapsed and its send button names the typed message.
    page.set_viewport_size({"width": 390, "height": 844})
    page.goto(f"{base_url}/c/{session_id}")
    expect(page.locator(_ASSISTANT)).to_have_count(3, timeout=15_000)
    page.get_by_test_id("open-items").get_by_role("button", name="Show item Q3").first.click()
    popover.get_by_role("button", name="Comment").click()
    expect(comment_mode).to_be_in_viewport()
    definition = comment_mode.get_by_role("region", name="Q3 text")
    expect(definition).to_contain_text("Renaming touches 14 indexes")
    assert (definition.bounding_box() or {"height": 999})["height"] <= 844 / 3 + 1
    composer.fill("Keep our naming.")
    save = page.get_by_role("button", name="Save comment")
    expect(save).to_be_in_viewport()
    # The save button stays inside the composer on narrow phones.
    composer_form = save.locator("xpath=ancestor::form[1]")
    for width in (430, 375, 320):
        page.set_viewport_size({"width": width, "height": 844})
        save_box, form_box = save.bounding_box(), composer_form.bounding_box()
        assert save_box is not None and form_box is not None
        assert save_box["x"] + save_box["width"] <= form_box["x"] + form_box["width"]
        assert form_box["x"] + form_box["width"] <= width
    page.set_viewport_size({"width": 390, "height": 844})
    save.click()
    page.reload()
    expect(tray).to_contain_text("1 comment · Q3")
    expect(tray.get_by_test_id("item-comment-draft-row")).to_have_count(0)
    composer.fill("One more thing.")
    expect(tray.get_by_role("button", name="Send 1 comment + message")).to_be_in_viewport()
    # Collapsed or expanded, the send button stays inside the tray on narrow phones.
    send = tray.get_by_test_id("submit-item-comments")
    for expanded in (False, True):
        if expanded:
            tray.get_by_role("button", name="Show comment drafts").click()
            expect(tray.get_by_role("button", name="Discard all")).to_be_visible()
        for width in (430, 375, 320):
            page.set_viewport_size({"width": width, "height": 844})
            send_box, tray_box = send.bounding_box(), tray.bounding_box()
            assert send_box is not None and tray_box is not None
            assert send_box["x"] + send_box["width"] <= tray_box["x"] + tray_box["width"]
            assert tray_box["x"] + tray_box["width"] <= width
