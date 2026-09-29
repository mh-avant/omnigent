"""Several logins of the same subscription CLI, one per ``config_dir``.

A ``subscription`` provider normally rides the CLI's default login
(``~/.claude`` / ``~/.codex``). Giving it a ``config_dir`` pins it to its own
login directory, so a host can keep e.g. two Claude Max accounts and pick one
per session. The directory is handed to the CLI through the env var it already
honors (:data:`~omnigent.onboarding.provider_config.SUBSCRIPTION_CONFIG_DIR_ENV`).
"""

from __future__ import annotations

import logging
import os
import shlex
import sys
from collections.abc import Mapping, MutableMapping
from pathlib import Path

from omnigent.errors import ErrorCode, OmnigentError
from omnigent.onboarding.provider_config import (
    ANTHROPIC_FAMILY,
    OPENAI_FAMILY,
    SUBSCRIPTION_CONFIG_DIR_ENV,
    SUBSCRIPTION_KIND,
    ProviderEntry,
    default_provider_for_harness,
    load_config,
    subscription_config_dir,
)

_logger = logging.getLogger(__name__)

_CLI_FAMILY: dict[str, str] = {"claude": ANTHROPIC_FAMILY, "codex": OPENAI_FAMILY}
# The harness whose provider decides each CLI's login directory.
_CLI_HARNESS: dict[str, str] = {"claude": "claude-sdk", "codex": "codex"}


def subscription_home_env(entry: ProviderEntry) -> dict[str, str]:
    """Return the env var that points *entry*'s CLI at its login directory.

    :param entry: Any provider entry.
    :returns: e.g. ``{"CLAUDE_CONFIG_DIR": "/home/u/.claude-max2"}``; empty when
        the entry is not a subscription with a ``config_dir``.
    """
    path = subscription_config_dir(entry)
    var = SUBSCRIPTION_CONFIG_DIR_ENV.get(entry.cli or "")
    if path is None or var is None:
        return {}
    return {var: str(path)}


def _default_login_dir(cli: str, env: Mapping[str, str]) -> Path:
    """Return where *cli* keeps its login when no ``config_dir`` is configured."""
    configured = env.get(SUBSCRIPTION_CONFIG_DIR_ENV[cli])
    if configured:
        return Path(configured).expanduser()
    return Path.home() / (".claude" if cli == "claude" else ".codex")


def subscription_login_dir(entry: ProviderEntry, env: Mapping[str, str] | None = None) -> Path:
    """Return the directory *entry*'s login lives in.

    :param entry: A ``claude`` / ``codex`` subscription entry.
    :param env: Environment consulted when the entry has no ``config_dir``;
        defaults to this process's.
    :returns: The ``config_dir``, else the CLI's env/home default.
    """
    return subscription_config_dir(entry) or _default_login_dir(
        str(entry.cli), os.environ if env is None else env
    )


def subscription_login_command(entry: ProviderEntry) -> str:
    """Return the shell command that signs *entry*'s account in.

    :param entry: A ``claude`` / ``codex`` subscription entry.
    :returns: e.g. ``"CLAUDE_CONFIG_DIR=/home/u/.claude-max2 claude auth login --claudeai"``.
    """
    from omnigent.onboarding.harness_install import harness_install_spec

    spec = harness_install_spec(_CLI_FAMILY[str(entry.cli)])
    argv = [str(entry.cli), *(spec.login_args or ())] if spec is not None else [str(entry.cli)]
    prefix = " ".join(f"{k}={shlex.quote(v)}" for k, v in subscription_home_env(entry).items())
    return " ".join(filter(None, [prefix, shlex.join(argv)]))


def subscription_logged_in(entry: ProviderEntry) -> bool:
    """Whether *entry*'s account has a usable stored login. Local and never raises.

    Reads the credential file in the login directory; on macOS, where Claude
    keeps its token in the Keychain, asks ``claude auth status`` for that
    directory instead.

    :param entry: A ``claude`` / ``codex`` subscription entry.
    :returns: ``True`` when a login is present.
    """
    from omnigent.onboarding.ambient import claude_auth_has_credential, codex_auth_has_credential

    try:
        directory = subscription_login_dir(entry)
    except OmnigentError:
        return False
    if entry.cli == "codex":
        return codex_auth_has_credential(directory / "auth.json")
    if claude_auth_has_credential(directory / ".credentials.json"):
        return True
    if sys.platform == "darwin":
        from omnigent.onboarding.harness_install import harness_cli_logged_in

        return harness_cli_logged_in(
            ANTHROPIC_FAMILY, env={SUBSCRIPTION_CONFIG_DIR_ENV["claude"]: str(directory)}
        )
    return False


def require_subscription_login(entry: ProviderEntry) -> None:
    """Fail loudly when *entry*'s account is not logged in.

    :param entry: Any provider entry; only ``claude`` / ``codex`` subscriptions
        are checked.
    :raises OmnigentError: When the account has no usable login, naming the
        account and the command that signs it in.
    """
    if entry.kind != SUBSCRIPTION_KIND or entry.cli not in _CLI_FAMILY:
        return
    if subscription_logged_in(entry):
        return
    raise OmnigentError(
        f"Subscription account {entry.name!r} is not logged in "
        f"(login directory {subscription_login_dir(entry)}). "
        f"Sign in on this host with: {subscription_login_command(entry)}",
        code=ErrorCode.INVALID_INPUT,
    )


def require_subscription_dir_active(entry: ProviderEntry, active_dir: Path) -> None:
    """Fail when *entry* pins a login directory this process is not using.

    Native CLIs inherit the runner's login directory, which the host sets from
    the session's account. A spec-pinned account with a different directory
    would otherwise run on the wrong login.

    :param entry: Any provider entry.
    :param active_dir: The directory this process's CLI would use.
    :raises OmnigentError: When *entry*'s ``config_dir`` differs from it.
    """
    configured = subscription_config_dir(entry)
    if configured is None or configured == active_dir.expanduser().absolute():
        return
    raise OmnigentError(
        f"Subscription account {entry.name!r} uses {configured}, but this session runs "
        f"with {active_dir}. Choose {entry.name!r} as the session's account when "
        "creating the session instead of pinning it in the agent spec.",
        code=ErrorCode.INVALID_INPUT,
    )


def default_accounts_env(config: dict[str, object]) -> dict[str, str]:
    """Return the login-dir env for each CLI whose default provider pins one.

    A host exports this into every runner it launches, so native and SDK
    harnesses (and the files Omnigent reads on their behalf) agree on the
    account. Never raises: a malformed config leaves the process defaults.

    :param config: The parsed ``~/.omnigent/config.yaml`` mapping.
    :returns: e.g. ``{"CLAUDE_CONFIG_DIR": "/home/u/.claude-max1"}``.
    """
    env: dict[str, str] = {}
    for cli, harness in _CLI_HARNESS.items():
        try:
            entry = default_provider_for_harness(config, harness)
            if entry is not None and entry.cli == cli:
                env.update(subscription_home_env(entry))
        except OmnigentError as exc:
            _logger.warning("Ignoring %s account directory: %s", cli, exc)
    return env


def apply_default_account_env(harness: str, env: MutableMapping[str, str] | None = None) -> None:
    """Point this process at the default account's login directory for *harness*.

    For single-session CLI entry points (``omnigent claude`` / ``omnigent
    codex``), whose children inherit the process environment.

    :param harness: ``"claude-native"`` or ``"codex-native"``.
    :param env: The environment to update; defaults to ``os.environ``.
    """
    target = os.environ if env is None else env
    try:
        entry = default_provider_for_harness(load_config(), harness)
    except OmnigentError:
        return
    if entry is not None:
        target.update(subscription_home_env(entry))
