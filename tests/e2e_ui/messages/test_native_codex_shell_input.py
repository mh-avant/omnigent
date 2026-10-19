"""Web shell commands run through Codex's shell RPC, not as prompts."""

import shutil
import time
import uuid

import httpx
import pytest
from playwright.sync_api import Page, expect

from tests.e2e_ui.conftest import reset_mock_llm, set_fallback_mock_llm

from .test_message_render_parity import _ASSISTANT, _USER, _WORKING, _ensure_chat_view, _send
from .test_native_codex_render_parity import (
    _CODEX_MOCK_MODEL,
    _open_terminal_view,
    _wait_terminal_connected,
)


@pytest.fixture(scope="session", autouse=True)
def _requires_codex() -> None:
    for binary in ("codex", "tmux"):
        if shutil.which(binary) is None:
            pytest.skip(f"requires the real {binary} executable")


def _shell_inputs(client: httpx.Client, session_id: str) -> list[str]:
    """Commands mirrored as ``terminal_command`` inputs, oldest first."""
    items = client.get(f"/v1/sessions/{session_id}/items", params={"limit": 100, "order": "asc"})
    items.raise_for_status()
    return [
        item["input"]
        for item in items.json()["data"]
        if item["type"] == "terminal_command" and item["kind"] == "input"
    ]


@pytest.mark.nightly
@pytest.mark.timeout(300)
def test_run_button_runs_each_suggested_command_in_codex_shell(
    page: Page,
    native_codex_mock_session: tuple[str, str],
    mock_llm_server_url: str,
) -> None:
    base_url, session_id = native_codex_mock_session
    first = f"run-first-{uuid.uuid4().hex[:8]}"
    second = f"run-second-{uuid.uuid4().hex[:8]}"
    reply = f"Please run:\n\n```\n!echo {first}\n!echo {second}\n```"
    reset_mock_llm(mock_llm_server_url)
    for model in ("default", _CODEX_MOCK_MODEL):
        set_fallback_mock_llm(mock_llm_server_url, model, reply)

    page.goto(f"{base_url}/c/{session_id}")
    _open_terminal_view(page)
    _wait_terminal_connected(page)
    _ensure_chat_view(page)
    _send(page, "What should I run?")
    expect(page.locator(_ASSISTANT, has_text="Please run:").first).to_be_visible(timeout=90_000)
    expect(page.locator(_WORKING)).to_have_count(0, timeout=60_000)

    page.locator(_ASSISTANT).get_by_role("button", name="Run 2 commands").click()
    page.get_by_role("dialog").get_by_role("button", name="Run", exact=True).click()

    for marker in (first, second):
        expect(page.locator(_USER, has_text=f"!echo {marker}")).to_have_count(1, timeout=60_000)
    with httpx.Client(base_url=base_url, timeout=15) as client:
        deadline = time.monotonic() + 60
        while _shell_inputs(client, session_id) != [f"echo {first}", f"echo {second}"]:
            assert time.monotonic() < deadline, _shell_inputs(client, session_id)
            time.sleep(1)
        snapshot = client.get(f"/v1/sessions/{session_id}")
        snapshot.raise_for_status()
        assert snapshot.json()["pending_inputs"] == []
        # The shell commands never reached the model as prompts.
        assert page.locator(_ASSISTANT, has_text="Please run:").count() == 1
