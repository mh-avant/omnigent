"""Per-session chat features: a web UI renderer paired with a framework instruction.

Each feature tells the agent to write in the form its renderer expects, so a
disabled feature drops both the instruction and the UI. Adding a feature is one
:data:`CHAT_FEATURE_DEFINITIONS` entry plus its web renderer.
"""

from __future__ import annotations

from collections.abc import Iterable
from dataclasses import dataclass
from enum import StrEnum


class ChatFeature(StrEnum):
    """Stable keys stored on sessions and sent over the API and runner wire."""

    RUN_COMMANDS = "run_commands"


@dataclass(frozen=True)
class ChatFeatureDefinition:
    """User-facing metadata and the agent instruction for one chat feature."""

    feature: ChatFeature
    title: str
    description: str
    instruction: str


CHAT_FEATURE_DEFINITIONS: tuple[ChatFeatureDefinition, ...] = (
    ChatFeatureDefinition(
        feature=ChatFeature.RUN_COMMANDS,
        title="Run suggested commands",
        description=(
            "Show a Run button on shell commands the agent suggests, and ask the "
            "agent to tag shell code blocks so the button can find them."
        ),
        instruction=(
            "Code blocks: give every fenced code block a language tag. Tag shell "
            "commands the user should run as `bash`, one command per line, and don't "
            "tag prose, prompts, logs or program output as a shell language."
        ),
    ),
)

DEFAULT_CHAT_FEATURES: frozenset[ChatFeature] = frozenset(
    definition.feature for definition in CHAT_FEATURE_DEFINITIONS
)

_KNOWN_KEYS = frozenset(feature.value for feature in ChatFeature)


def parse_chat_features(values: Iterable[str]) -> frozenset[ChatFeature]:
    """Parse API input strictly.

    :param values: Feature keys, e.g. ``["run_commands"]``.
    :returns: The parsed set.
    :raises ValueError: If any key is unknown; the message names every one.
    """
    keys = list(values)
    unknown = sorted({key for key in keys if key not in _KNOWN_KEYS})
    if unknown:
        raise ValueError(f"Unknown chat feature(s): {', '.join(unknown)}")
    return frozenset(ChatFeature(key) for key in keys)


def decode_chat_features(raw: str | None) -> frozenset[ChatFeature]:
    """Decode a stored value leniently.

    :param raw: Comma-joined keys from :func:`encode_chat_features`. ``None``
        (a session created before this setting existed) means the defaults.
    :returns: The known features in ``raw``; unknown keys are dropped.
    """
    if raw is None:
        return DEFAULT_CHAT_FEATURES
    return _known_features(raw.split(","))


def chat_features_from_wire(value: object) -> frozenset[ChatFeature]:
    """Decode a list of keys from a runner payload leniently.

    :param value: The payload's ``chat_features`` value. Anything but a list
        (the key is missing because the server predates it) means the defaults.
    :returns: The known features in ``value``; unknown keys are dropped.
    """
    if not isinstance(value, list):
        return DEFAULT_CHAT_FEATURES
    return _known_features(key for key in value if isinstance(key, str))


def encode_chat_features(features: Iterable[ChatFeature]) -> str:
    """Encode features for storage: sorted, comma-joined, ``""`` when empty."""
    return ",".join(sorted(str(feature) for feature in set(features)))


def ordered_chat_features(features: Iterable[ChatFeature]) -> list[ChatFeature]:
    """Return ``features`` in registry order, for stable API output."""
    enabled = set(features)
    return [
        definition.feature
        for definition in CHAT_FEATURE_DEFINITIONS
        if definition.feature in enabled
    ]


def chat_feature_instructions(features: Iterable[ChatFeature]) -> list[str]:
    """Instruction texts of the enabled features, in registry order."""
    enabled = set(features)
    return [
        definition.instruction
        for definition in CHAT_FEATURE_DEFINITIONS
        if definition.feature in enabled
    ]


def _known_features(keys: Iterable[str]) -> frozenset[ChatFeature]:
    return frozenset(ChatFeature(key) for key in (k.strip() for k in keys) if key in _KNOWN_KEYS)
