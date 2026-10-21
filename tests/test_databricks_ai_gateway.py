"""Unity Gateway usage-attribution headers."""

from __future__ import annotations

import pytest

from omnigent.databricks_ai_gateway import (
    gateway_attribution_headers,
    with_gateway_attribution,
    with_gateway_attribution_lines,
)

_GW = "https://dbc-1.cloud.databricks.com/ai-gateway/anthropic"


@pytest.mark.parametrize(("via_ug", "surfaces"), [(False, "omnigent"), (True, "omnigent, ug")])
def test_gateway_attribution_headers_name_omnigent_outermost(via_ug: bool, surfaces: str) -> None:
    assert gateway_attribution_headers("codex", via_ug=via_ug) == {
        "Databricks-Custom-Coding-Agent": "codex",
        "Databricks-Custom-Client-Surfaces": surfaces,
    }


def test_with_gateway_attribution_marks_ug_providers_by_user_agent() -> None:
    assert with_gateway_attribution({"User-Agent": "ucode/0.1.0 pi/0.80.0"}, "pi", _GW) == {
        "User-Agent": "ucode/0.1.0 pi/0.80.0",
        "Databricks-Custom-Coding-Agent": "pi",
        "Databricks-Custom-Client-Surfaces": "omnigent, ug",
    }
    assert (
        with_gateway_attribution(None, "pi", _GW)["Databricks-Custom-Client-Surfaces"]
        == "omnigent"
    )


def test_with_gateway_attribution_lines_appends_to_the_claude_block() -> None:
    block = with_gateway_attribution_lines(
        "x-databricks-use-coding-agent-mode: true", "claude-code", via_ug=True
    )

    assert block.splitlines() == [
        "x-databricks-use-coding-agent-mode: true",
        "Databricks-Custom-Coding-Agent: claude-code",
        "Databricks-Custom-Client-Surfaces: omnigent, ug",
    ]


def test_ug_configured_workspace_marks_a_provider_without_a_ug_user_agent(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """ug's state names the workspace even when only managed config carries ug's User-Agent."""
    from omnigent.databricks_ai_gateway import is_ug_route

    configured = {"https://dbc-1.cloud.databricks.com"}
    monkeypatch.setattr(
        "omnigent.onboarding.ucode_state.read_ucode_state",
        lambda url: object() if url in configured else None,
    )

    assert is_ug_route("https://dbc-1.cloud.databricks.com/ai-gateway/codex/v1")
    assert not is_ug_route("https://dbc-2.cloud.databricks.com/ai-gateway/codex/v1")
    assert with_gateway_attribution(
        {"X-Tag": "1"}, "codex", "https://dbc-1.cloud.databricks.com/ai-gateway/codex/v1"
    ) == {
        "X-Tag": "1",
        "Databricks-Custom-Coding-Agent": "codex",
        "Databricks-Custom-Client-Surfaces": "omnigent, ug",
    }


def test_gateway_request_tags_send_the_session_id_and_user_labels_only() -> None:
    from omnigent.databricks_ai_gateway import gateway_request_tags_value

    labels = {
        "team": "ml",
        "project": "chat bot",
        "omnigent.wrapper": "claude-code-native-ui",
        "omni_project": "sidebar",
        "cost_control.plan": "{}",
        # A label cannot replace the session id.
        "omnigent_session_id": "spoofed",
    }

    assert gateway_request_tags_value("conv_abc123", labels) == (
        '{"omnigent_session_id":"conv_abc123","project":"chat bot","team":"ml"}'
    )


def test_gateway_request_tags_drop_labels_past_the_cap_but_keep_the_session_id() -> None:
    from omnigent.databricks_ai_gateway import gateway_request_tags, gateway_request_tags_value

    labels = {"a": "x" * 5000, "b": "y" * 5000, "c": "small", "d\n": "é"}

    tags = gateway_request_tags("conv_1", labels)

    assert list(tags) == ["omnigent_session_id", "a", "c", "d\n"]
    encoded = gateway_request_tags_value("conv_1", labels)
    assert encoded is not None and encoded.isascii() and "\n" not in encoded
    assert len(encoded) <= 8 * 1024
    assert gateway_request_tags("conv_1", {"a": "x" * 9000}) == {"omnigent_session_id": "conv_1"}


@pytest.mark.parametrize(
    ("switch", "enabled"), [(None, True), ("1", True), ("0", False), ("off", False)]
)
def test_gateway_request_tags_switch(
    monkeypatch: pytest.MonkeyPatch, switch: str | None, enabled: bool
) -> None:
    from omnigent.databricks_ai_gateway import (
        REQUEST_TAGS_SWITCH_ENV,
        REQUEST_TAGS_VALUE_ENV,
        gateway_request_tags_env,
        gateway_request_tags_headers,
    )

    if switch is None:
        monkeypatch.delenv(REQUEST_TAGS_SWITCH_ENV, raising=False)
    else:
        monkeypatch.setenv(REQUEST_TAGS_SWITCH_ENV, switch)

    env = gateway_request_tags_env("conv_1", {"team": "ml"})
    harness_env = {REQUEST_TAGS_VALUE_ENV: '{"omnigent_session_id":"conv_1"}'}
    if switch is not None:
        harness_env[REQUEST_TAGS_SWITCH_ENV] = switch

    assert bool(env) is enabled
    assert gateway_request_tags_headers(harness_env) == (
        {"Databricks-Ai-Gateway-Request-Tags": '{"omnigent_session_id":"conv_1"}'}
        if enabled
        else {}
    )
    assert gateway_request_tags_headers({}) == {}


def test_with_gateway_request_tags_line_appends_to_the_claude_block() -> None:
    from omnigent.databricks_ai_gateway import with_gateway_request_tags_line

    assert with_gateway_request_tags_line(None, '{"omnigent_session_id":"c"}') == (
        'Databricks-Ai-Gateway-Request-Tags: {"omnigent_session_id":"c"}'
    )
    assert with_gateway_request_tags_line("X-A: 1", "{}").splitlines() == [
        "X-A: 1",
        "Databricks-Ai-Gateway-Request-Tags: {}",
    ]
