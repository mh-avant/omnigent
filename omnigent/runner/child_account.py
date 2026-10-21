"""The account (provider) a ``sys_session_create`` child runs on.

A runner's provider lives in its environment, so a child co-located on its
parent's runner shares the parent's accounts. A child on another account gets
its own runner on the same host, launched with that provider like any session
created with ``provider_override``. These checks read this host's
``providers:`` config, the same one the host resolves the child's launch from.
"""

from __future__ import annotations

from dataclasses import dataclass

from omnigent.errors import OmnigentError
from omnigent.onboarding.provider_config import (
    ANTHROPIC_FAMILY,
    OPENAI_FAMILY,
    get_default_provider,
    load_config,
    load_providers,
    provider_families,
)
from omnigent.onboarding.subscription_accounts import (
    provider_choices,
    require_subscription_login,
)
from omnigent.util.json_types import JsonObject

# Where an agent finds the valid names.
_DISCOVERY_HINT = "sys_list_models lists this host's providers under 'host_providers'."


class ChildAccountError(Exception):
    """A provider the child cannot run on, as a tool error.

    :param code: Machine-readable reason, e.g. ``"provider_not_found"``.
    :param message: What is wrong and how to fix it.
    """

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message

    def as_tool_error(self, provider: str) -> JsonObject:
        """Return the JSON object the tool reports."""
        return {"error": self.code, "provider": provider, "message": self.message}


@dataclass(frozen=True)
class ChildAccount:
    """Where a child on *provider* runs.

    :param provider: The ``providers:`` entry name, e.g. ``"claude-alt"``.
    :param own_runner: Whether the child needs its own runner because the
        parent's runner runs another account for the provider's families.
    """

    provider: str
    own_runner: bool


def choose_child_account(provider: str) -> ChildAccount:
    """Check *provider* on this host and decide whether the child needs its own runner.

    :param provider: The requested ``providers:`` entry name.
    :returns: The child's placement.
    :raises ChildAccountError: ``provider_not_found`` when it is not configured
        here, ``provider_not_ready`` when its subscription is not signed in.
    """
    try:
        config = load_config()
        providers = load_providers(config)
    except OmnigentError as exc:
        raise ChildAccountError("provider_config_invalid", exc.message) from exc
    entry = providers.get(provider)
    if entry is None:
        configured = ", ".join(sorted(providers)) or "none"
        raise ChildAccountError(
            "provider_not_found",
            f"Provider {provider!r} is not configured on this host "
            f"(configured: {configured}). {_DISCOVERY_HINT}",
        )
    try:
        require_subscription_login(entry)
    except OmnigentError as exc:
        raise ChildAccountError("provider_not_ready", exc.message) from exc
    families = provider_families(entry) & {ANTHROPIC_FAMILY, OPENAI_FAMILY}
    try:
        shared = bool(families) and all(
            (current := get_default_provider(config, family)) is not None
            and current.name == provider
            for family in families
        )
    except OmnigentError:
        shared = False
    return ChildAccount(provider=provider, own_runner=not shared)


def require_child_harness(provider: str, harness: str | None, agent_name: str | None) -> None:
    """Fail unless *provider* can run the child's harness on this host.

    :param provider: The requested ``providers:`` entry name.
    :param harness: The child's canonical harness, e.g. ``"codex-native"``.
    :param agent_name: The child's agent, for the message.
    :raises ChildAccountError: ``provider_not_for_harness`` listing the
        providers that can run it.
    """
    try:
        choices = provider_choices(load_config(), harness) if harness else []
    except OmnigentError as exc:
        raise ChildAccountError("provider_config_invalid", exc.message) from exc
    if any(choice["name"] == provider for choice in choices):
        return
    agent = f"agent {agent_name!r}" if agent_name else "the agent"
    if not choices:
        raise ChildAccountError(
            "provider_not_for_harness",
            f"The child ({agent}) runs the {harness!r} harness, which has no account "
            "to choose. Omit 'provider' for it.",
        )
    valid = ", ".join(
        f"{choice['name']} (default)" if choice["default"] else str(choice["name"])
        for choice in choices
    )
    raise ChildAccountError(
        "provider_not_for_harness",
        f"Provider {provider!r} cannot run {agent} (harness {harness!r}). "
        f"Providers for {harness!r} on this host: {valid}.",
    )
