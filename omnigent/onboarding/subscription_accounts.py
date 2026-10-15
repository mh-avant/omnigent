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
from urllib.parse import urlparse

from omnigent.errors import ErrorCode, OmnigentError
from omnigent.onboarding.provider_config import (
    ANTHROPIC_FAMILY,
    BEDROCK_KIND,
    CLI_CONFIG_KIND,
    DATABRICKS_KIND,
    OPENAI_FAMILY,
    SESSION_PROVIDER_ENV,
    SUBSCRIPTION_CONFIG_DIR_ENV,
    SUBSCRIPTION_KIND,
    SUBSCRIPTION_TOKEN_ENV,
    ProviderEntry,
    default_provider_for_harness,
    harness_family,
    load_config,
    load_providers,
    provider_families,
    session_provider,
    subscription_config_dir,
    subscription_token,
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


def subscription_token_env(entry: ProviderEntry) -> dict[str, str]:
    """Return the env var that hands *entry*'s account token to its CLI.

    :param entry: Any provider entry.
    :returns: e.g. ``{"CLAUDE_CODE_OAUTH_TOKEN": "sk-ant-oat01-..."}``; empty
        when the entry is not a subscription with a ``token_ref``.
    :raises OmnigentError: ``harness_not_configured`` when the token is not set.
    """
    var = SUBSCRIPTION_TOKEN_ENV.get(entry.cli or "")
    if var is None:
        return {}
    try:
        token = subscription_token(entry)
    except OmnigentError as exc:
        raise OmnigentError(
            f"Subscription account {entry.name!r} has no token: {exc.message} "
            f"Create one with `{entry.cli} setup-token`.",
            code=ErrorCode.HARNESS_NOT_CONFIGURED,
        ) from exc
    return {var: token} if token else {}


def claude_account_env(pinned: str | None = None) -> dict[str, str]:
    """Return the token env for the Claude account this process runs on.

    The account is the agent's pinned provider, else the session's choice or
    the host default (see
    :func:`~omnigent.onboarding.provider_config.get_default_provider`).

    :param pinned: The provider an agent spec pins via ``executor.auth``, if any.
    :returns: e.g. ``{"CLAUDE_CODE_OAUTH_TOKEN": "sk-ant-oat01-..."}``; empty
        for an account that uses its stored login.
    :raises OmnigentError: ``harness_not_configured`` when the account's token
        is not set.
    """
    config = load_config()
    entry = (
        load_providers(config).get(pinned)
        if pinned
        else default_provider_for_harness(config, "claude-sdk")
    )
    if entry is None or entry.kind != SUBSCRIPTION_KIND or entry.cli != "claude":
        return {}
    return subscription_token_env(entry)


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
    :returns: e.g. ``"CLAUDE_CONFIG_DIR=/home/u/.claude-max2 claude auth login --claudeai"``,
        or ``"claude setup-token"`` for a token account.
    """
    from omnigent.onboarding.harness_install import harness_install_spec

    if entry.token_ref is not None:
        return shlex.join([str(entry.cli), "setup-token"])

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

    if entry.token_ref is not None:
        try:
            return bool(subscription_token(entry))
        except OmnigentError:
            return False
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
    if entry.token_ref is not None:
        raise OmnigentError(
            f"Subscription account {entry.name!r} has no token stored as "
            f"{entry.token_ref!r}. Create one with `{subscription_login_command(entry)}` "
            "and add it with `omnigent setup`.",
            code=ErrorCode.INVALID_INPUT,
        )
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


def require_session_account_dir(
    cli: str, launch_dir: Path, launch_env: Mapping[str, str] | None = None
) -> None:
    """Fail when the session's *cli* account is not the login its CLI starts with.

    The host points the runner at the account the session chose, but an agent
    spec's ``env`` or the host's harness startup command can still move the
    CLI to another login directory or replace the account's token.

    :param cli: The subscription CLI, e.g. ``"claude"``.
    :param launch_dir: The login directory the CLI process would use, e.g.
        ``Path("/srv/claude")``.
    :param launch_env: The environment the CLI process starts with, used to
        check a token account's token. ``None`` skips that check.
    :raises OmnigentError: ``harness_not_configured`` when the session chose a
        *cli* subscription account whose login directory or token differs.
    """
    entry = session_provider(load_config())
    if entry is None or entry.kind != SUBSCRIPTION_KIND or entry.cli != cli:
        return
    token_env = subscription_token_env(entry)
    if launch_env is not None and any(launch_env.get(k) != v for k, v in token_env.items()):
        var = SUBSCRIPTION_TOKEN_ENV[cli]
        raise OmnigentError(
            f"This session runs on account {entry.name!r}, but the agent's env or this "
            f"host's {cli} startup command sets a different {var}. Remove that setting, "
            "or start the session on the account that token belongs to.",
            code=ErrorCode.HARNESS_NOT_CONFIGURED,
        )
    expected = subscription_login_dir(entry)
    if os.path.realpath(expected) == os.path.realpath(launch_dir):
        return
    raise OmnigentError(
        f"This session runs on account {entry.name!r} ({expected}), but its {cli} "
        f"terminal would start with the login in {launch_dir}: the agent's env or this "
        f"host's {cli} startup command changes {SUBSCRIPTION_CONFIG_DIR_ENV[cli]} or HOME. "
        "Remove that setting, or start the session on the account that uses that directory.",
        code=ErrorCode.HARNESS_NOT_CONFIGURED,
    )


def session_runner_env(
    config: dict[str, object], provider: str, harness: str | None
) -> dict[str, str]:
    """Return the runner env for a session that chose *provider*.

    Validates the choice on this host and fails loudly rather than letting
    the session run on another credential.

    :param config: The parsed ``~/.omnigent/config.yaml`` mapping.
    :param provider: The chosen ``providers:`` entry name, e.g. ``"claude-max2"``.
    :param harness: The session's canonical harness, or ``None`` when unknown.
    :returns: :data:`SESSION_PROVIDER_ENV` plus the login-dir env, the chosen
        provider's directory winning for the family it serves.
    :raises OmnigentError: When the provider is not configured here, cannot
        serve the harness, or is a subscription that is not logged in.
    """
    entry = load_providers(config).get(provider)
    if entry is None:
        raise OmnigentError(
            f"Provider {provider!r} is not configured on this host. Add it under "
            "'providers:' in ~/.omnigent/config.yaml.",
            code=ErrorCode.INVALID_INPUT,
        )
    family = harness_family(harness) if harness else None
    if family is not None and family not in provider_families(entry):
        raise OmnigentError(
            f"Provider {provider!r} cannot run the {harness!r} harness.",
            code=ErrorCode.INVALID_INPUT,
        )
    require_subscription_login(entry)
    env = default_accounts_env(config)
    for cli, cli_harness in _CLI_HARNESS.items():
        if entry.cli == cli or harness_family(cli_harness) in provider_families(entry):
            # The chosen provider owns this CLI's family: drop the default's dir.
            env.pop(SUBSCRIPTION_CONFIG_DIR_ENV[cli], None)
    env.update(subscription_home_env(entry))
    env[SESSION_PROVIDER_ENV] = provider
    return env


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
    """Point this process at the default account's login for *harness*.

    For single-session CLI entry points (``omnigent claude`` / ``omnigent
    codex``), whose children inherit the process environment.

    :param harness: ``"claude-native"`` or ``"codex-native"``.
    :param env: The environment to update; defaults to ``os.environ``.
    :raises OmnigentError: ``harness_not_configured`` when the default account
        is a token account whose token is not set.
    """
    target = os.environ if env is None else env
    try:
        entry = default_provider_for_harness(load_config(), harness)
    except OmnigentError:
        return
    if entry is not None:
        target.update(subscription_home_env(entry))
        target.update(subscription_token_env(entry))


def _provider_label(entry: ProviderEntry, family: str) -> str:
    """Describe *entry* for a picker without resolving or revealing credentials."""
    if entry.kind == SUBSCRIPTION_KIND:
        if entry.token_ref is not None:
            return f"{entry.cli} account token"
        return f"{entry.cli} login (own directory)" if entry.config_dir else f"{entry.cli} login"
    if entry.kind == DATABRICKS_KIND:
        return f"Databricks profile {entry.profile}" if entry.profile else "Databricks"
    if entry.kind == CLI_CONFIG_KIND:
        return entry.display_name or f"{entry.cli} provider {entry.model_provider}"
    if entry.kind == BEDROCK_KIND:
        return "AWS Bedrock"
    raw = entry.families.get(family)
    host = urlparse(raw.base_url).netloc if raw is not None else ""
    return f"{entry.kind} · {host}" if host else entry.kind


def provider_choices(config: dict[str, object], harness: str) -> list[dict[str, str | bool]]:
    """List the configured providers a session of *harness* could run on.

    :param config: The parsed ``~/.omnigent/config.yaml`` mapping.
    :param harness: A canonical harness, e.g. ``"claude-native"``.
    :returns: Rows of ``name`` / ``kind`` / ``label`` / ``default`` / ``ready``;
        ``ready`` is ``False`` for a subscription account that is not logged in.
        Empty for a harness with no provider family.
    :raises OmnigentError: If the provider config is malformed.
    """
    family = harness_family(harness)
    if family is None:
        return []
    default = default_provider_for_harness(config, harness)
    rows: list[dict[str, str | bool]] = []
    for entry in load_providers(config).values():
        if family not in provider_families(entry):
            continue
        if entry.kind == BEDROCK_KIND and harness != "claude-native":
            continue
        rows.append(
            {
                "name": entry.name,
                "kind": entry.kind,
                "label": _provider_label(entry, family),
                "default": default is not None and default.name == entry.name,
                "ready": entry.cli not in _CLI_FAMILY
                or entry.kind != SUBSCRIPTION_KIND
                or subscription_logged_in(entry),
            }
        )
    return rows
