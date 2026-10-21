"""Tests for the chat-feature registry."""

import pytest

from omnigent.runtime.chat_features import (
    CHAT_FEATURE_DEFINITIONS,
    DEFAULT_CHAT_FEATURES,
    ChatFeature,
    chat_feature_instructions,
    chat_features_from_wire,
    decode_chat_features,
    encode_chat_features,
    ordered_chat_features,
    parse_chat_features,
)


def test_every_feature_has_one_definition_and_is_on_by_default() -> None:
    defined = [definition.feature for definition in CHAT_FEATURE_DEFINITIONS]

    assert sorted(defined) == sorted(ChatFeature)
    assert frozenset(ChatFeature) == DEFAULT_CHAT_FEATURES


def test_parse_accepts_known_keys() -> None:
    assert parse_chat_features(["run_commands", "run_commands"]) == {ChatFeature.RUN_COMMANDS}
    assert parse_chat_features([]) == frozenset()


def test_parse_rejects_unknown_keys_by_name() -> None:
    with pytest.raises(ValueError, match="bogus, nope"):
        parse_chat_features(["run_commands", "nope", "bogus"])


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        (None, DEFAULT_CHAT_FEATURES),
        ("", frozenset()),
        ("run_commands", frozenset({ChatFeature.RUN_COMMANDS})),
        ("retired,run_commands", frozenset({ChatFeature.RUN_COMMANDS})),
        ("retired", frozenset()),
    ],
    ids=["legacy-null", "empty", "one", "drops-unknown", "only-unknown"],
)
def test_decode_is_lenient(raw: str | None, expected: frozenset[ChatFeature]) -> None:
    assert decode_chat_features(raw) == expected


@pytest.mark.parametrize(
    ("value", "expected"),
    [
        (None, DEFAULT_CHAT_FEATURES),
        ("run_commands", DEFAULT_CHAT_FEATURES),
        ([], frozenset()),
        (["run_commands", "retired", 3], frozenset({ChatFeature.RUN_COMMANDS})),
    ],
    ids=["missing", "not-a-list", "empty", "drops-unknown"],
)
def test_chat_features_from_wire(value: object, expected: frozenset[ChatFeature]) -> None:
    assert chat_features_from_wire(value) == expected


def test_encode_round_trips_through_decode() -> None:
    assert encode_chat_features(frozenset()) == ""
    assert encode_chat_features([ChatFeature.RUN_COMMANDS] * 2) == "run_commands"
    for features in (frozenset(), DEFAULT_CHAT_FEATURES):
        assert decode_chat_features(encode_chat_features(features)) == features


def test_instructions_and_order_follow_the_registry() -> None:
    assert chat_feature_instructions(frozenset()) == []
    assert chat_feature_instructions(DEFAULT_CHAT_FEATURES) == [
        definition.instruction for definition in CHAT_FEATURE_DEFINITIONS
    ]
    assert ordered_chat_features(DEFAULT_CHAT_FEATURES) == [
        definition.feature for definition in CHAT_FEATURE_DEFINITIONS
    ]
