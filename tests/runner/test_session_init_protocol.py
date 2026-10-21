"""Chat features on the server-to-runner session-init snapshot."""

from __future__ import annotations

import pytest

from omnigent.entities import Conversation
from omnigent.runner.session_init_protocol import (
    RunnerSessionInitEnvelope,
    build_runner_session_init_payload,
)


@pytest.mark.parametrize(
    ("stored", "expected"),
    [(None, ["run_commands"]), ("", []), ("run_commands,retired", ["run_commands"])],
)
def test_snapshot_carries_decoded_chat_features(stored: str | None, expected: list[str]) -> None:
    conversation = Conversation(
        id="conv_chat_features",
        created_at=1,
        updated_at=1,
        agent_id="ag_chat_features",
        root_conversation_id="conv_chat_features",
        chat_features_override=stored,
    )
    payload = build_runner_session_init_payload(conversation, server_version="0.0.0")
    envelope = RunnerSessionInitEnvelope.model_validate(payload["session_init"])
    assert envelope.snapshot.chat_features == expected


def test_snapshot_from_older_server_defaults_chat_features() -> None:
    payload = build_runner_session_init_payload(
        Conversation(
            id="conv_old",
            created_at=1,
            updated_at=1,
            agent_id="ag_old",
            root_conversation_id="conv_old",
        ),
        server_version="0.0.0",
    )
    raw = payload["session_init"]
    assert isinstance(raw, dict)
    del raw["snapshot"]["chat_features"]
    envelope = RunnerSessionInitEnvelope.model_validate(raw)
    assert envelope.snapshot.chat_features == ["run_commands"]
