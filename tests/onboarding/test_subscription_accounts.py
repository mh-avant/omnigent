"""Tests for subscription accounts with their own login directory."""

from __future__ import annotations

import json
import subprocess
from pathlib import Path
from typing import Any

import pytest
import yaml

from omnigent.errors import ErrorCode, OmnigentError
from omnigent.onboarding import harness_install, harness_readiness
from omnigent.onboarding.provider_config import (
    SESSION_PROVIDER_ENV,
    describe_active_credential,
    get_default_provider,
    load_providers,
    subscription_config_dir,
)
from omnigent.onboarding.subscription_accounts import (
    apply_default_account_env,
    claude_account_env,
    default_accounts_env,
    host_provider_summary,
    provider_choices,
    require_session_account_dir,
    require_subscription_dir_active,
    require_subscription_login,
    session_runner_env,
    subscription_home_env,
    subscription_logged_in,
    subscription_login_command,
    subscription_token_env,
)


def _providers(**entries: dict[str, object]) -> dict[str, object]:
    return {"providers": entries}


def _write_claude_login(directory: Path) -> None:
    directory.mkdir(parents=True, exist_ok=True)
    (directory / ".credentials.json").write_text(
        json.dumps({"claudeAiOauth": {"accessToken": "a", "refreshToken": "r"}})
    )


def _write_codex_login(directory: Path) -> None:
    directory.mkdir(parents=True, exist_ok=True)
    (directory / "auth.json").write_text(json.dumps({"tokens": {"refresh_token": "r"}}))


@pytest.fixture
def config_home(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> Path:
    monkeypatch.setenv("OMNIGENT_CONFIG_HOME", str(tmp_path / "omnigent"))
    (tmp_path / "omnigent").mkdir()
    return tmp_path / "omnigent"


def _write_config(config_home: Path, config: dict[str, object]) -> None:
    (config_home / "config.yaml").write_text(yaml.safe_dump(config))


def test_config_dir_parses_and_expands(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    monkeypatch.setenv("ACCOUNTS", str(tmp_path))
    entry = load_providers(
        _providers(max2={"kind": "subscription", "cli": "claude", "config_dir": "$ACCOUNTS/m2"})
    )["max2"]

    assert entry.config_dir == "$ACCOUNTS/m2"
    assert subscription_config_dir(entry) == tmp_path / "m2"
    assert subscription_home_env(entry) == {"CLAUDE_CONFIG_DIR": str(tmp_path / "m2")}


def test_config_dir_maps_codex_to_codex_home(tmp_path: Path) -> None:
    entry = load_providers(
        _providers(b={"kind": "subscription", "cli": "codex", "config_dir": str(tmp_path)})
    )["b"]

    assert subscription_home_env(entry) == {"CODEX_HOME": str(tmp_path)}


@pytest.mark.parametrize("cli,config_dir", [("pi", "~/.pi-2"), ("claude", ""), ("claude", 3)])
def test_config_dir_rejected_when_unsupported_or_empty(cli: str, config_dir: object) -> None:
    with pytest.raises(OmnigentError, match="config_dir"):
        load_providers(
            _providers(x={"kind": "subscription", "cli": cli, "config_dir": config_dir})
        )


def test_readout_names_the_account_directory() -> None:
    config = _providers(
        max2={
            "kind": "subscription",
            "cli": "claude",
            "config_dir": "~/.claude-max2",
            "default": True,
        }
    )

    cred = describe_active_credential(config, "claude-sdk")

    assert cred is not None
    assert cred.source == "claude CLI login (~/.claude-max2)"


def test_login_detection_reads_the_account_directory(tmp_path: Path) -> None:
    providers = load_providers(
        _providers(
            max2={"kind": "subscription", "cli": "claude", "config_dir": str(tmp_path / "m2")},
            b={"kind": "subscription", "cli": "codex", "config_dir": str(tmp_path / "cb")},
        )
    )
    assert not subscription_logged_in(providers["max2"])
    assert not subscription_logged_in(providers["b"])

    _write_claude_login(tmp_path / "m2")
    _write_codex_login(tmp_path / "cb")

    assert subscription_logged_in(providers["max2"])
    assert subscription_logged_in(providers["b"])


def test_missing_login_fails_with_the_login_command(tmp_path: Path) -> None:
    entry = load_providers(
        _providers(max2={"kind": "subscription", "cli": "claude", "config_dir": str(tmp_path)})
    )["max2"]

    with pytest.raises(OmnigentError) as excinfo:
        require_subscription_login(entry)

    message = str(excinfo.value)
    assert "'max2' is not logged in" in message
    assert f"CLAUDE_CONFIG_DIR={tmp_path} claude auth login --claudeai" in message
    assert subscription_login_command(entry) in message


def test_pinned_directory_must_match_the_active_one(tmp_path: Path) -> None:
    entry = load_providers(
        _providers(b={"kind": "subscription", "cli": "codex", "config_dir": str(tmp_path / "b")})
    )["b"]

    require_subscription_dir_active(entry, tmp_path / "b")
    with pytest.raises(OmnigentError, match="Choose 'b' as the session's account"):
        require_subscription_dir_active(entry, tmp_path / "other")


def test_default_accounts_env_covers_both_clis(tmp_path: Path) -> None:
    config = _providers(
        max1={
            "kind": "subscription",
            "cli": "claude",
            "config_dir": str(tmp_path / "m1"),
            "default": True,
        },
        codex={"kind": "subscription", "cli": "codex", "default": True},
    )

    assert default_accounts_env(config) == {"CLAUDE_CONFIG_DIR": str(tmp_path / "m1")}


def test_apply_default_account_env_updates_target(config_home: Path, tmp_path: Path) -> None:
    _write_config(
        config_home,
        _providers(
            b={
                "kind": "subscription",
                "cli": "codex",
                "config_dir": str(tmp_path / "b"),
                "default": True,
            }
        ),
    )
    env: dict[str, str] = {}

    apply_default_account_env("codex-native", env)

    assert env == {"CODEX_HOME": str(tmp_path / "b")}


def test_login_probe_and_login_run_with_account_env(monkeypatch: pytest.MonkeyPatch) -> None:
    calls: list[dict[str, Any]] = []

    def fake_run(argv: list[str], **kwargs: Any) -> subprocess.CompletedProcess[str]:
        calls.append({"argv": argv, "env": kwargs.get("env")})
        return subprocess.CompletedProcess(argv, 0, stdout='{"loggedIn": false}', stderr="")

    monkeypatch.setattr(harness_install.shutil, "which", lambda _b: "/usr/bin/claude")
    monkeypatch.setattr(harness_install.subprocess, "run", fake_run)
    monkeypatch.setattr(harness_install.sys.stdin, "isatty", lambda: True)

    harness_install.harness_login("anthropic", env={"CLAUDE_CONFIG_DIR": "/tmp/acct"})

    assert [c["argv"][1:] for c in calls] == [
        ["auth", "status"],
        ["auth", "login", "--claudeai"],
        ["auth", "status"],
    ]
    assert all(c["env"]["CLAUDE_CONFIG_DIR"] == "/tmp/acct" for c in calls)


def test_readiness_checks_default_account_login(
    monkeypatch: pytest.MonkeyPatch, config_home: Path, tmp_path: Path
) -> None:
    _write_config(
        config_home,
        _providers(
            max1={
                "kind": "subscription",
                "cli": "claude",
                "config_dir": str(tmp_path / "m1"),
                "default": True,
            }
        ),
    )
    monkeypatch.setattr(
        "omnigent.onboarding.ambient._claude_login_detected",
        lambda: pytest.fail("the default login must not be consulted"),
    )

    assert not harness_readiness._claude_code_login_configured()
    _write_claude_login(tmp_path / "m1")
    assert harness_readiness._claude_code_login_configured()


def test_codex_account_without_login_does_not_fall_back(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    from omnigent.harnesses.codex_native import app_server

    config = _providers(
        b={"kind": "subscription", "cli": "codex", "config_dir": str(tmp_path / "b")},
        openrouter={
            "kind": "gateway",
            "openai": {"base_url": "https://example.invalid/v1", "api_key": "k"},
        },
    )
    monkeypatch.setattr(
        app_server,
        "_first_routable_codex_provider",
        lambda *a, **k: pytest.fail("an account with its own login dir must not fall back"),
    )

    launch = app_server._resolve_subscription_launch(load_providers(config)["b"], None, config)

    assert launch.login_required


def _session_config(tmp_path: Path) -> dict[str, object]:
    return _providers(
        max1={
            "kind": "subscription",
            "cli": "claude",
            "config_dir": str(tmp_path / "m1"),
            "default": True,
        },
        max2={"kind": "subscription", "cli": "claude", "config_dir": str(tmp_path / "m2")},
        codex_b={
            "kind": "subscription",
            "cli": "codex",
            "config_dir": str(tmp_path / "cb"),
            "default": True,
        },
        dbx={"kind": "databricks", "profile": "alt"},
        openrouter={
            "kind": "gateway",
            "anthropic": {"base_url": "https://openrouter.ai/api", "api_key": "sk-literal"},
        },
    )


def test_session_runner_env_swaps_in_the_chosen_account(tmp_path: Path) -> None:
    _write_claude_login(tmp_path / "m2")

    env = session_runner_env(_session_config(tmp_path), "max2", "claude-native")

    assert env == {
        "CLAUDE_CONFIG_DIR": str(tmp_path / "m2"),
        "CODEX_HOME": str(tmp_path / "cb"),
        SESSION_PROVIDER_ENV: "max2",
    }


def test_session_runner_env_drops_account_dirs_a_gateway_replaces(tmp_path: Path) -> None:
    env = session_runner_env(_session_config(tmp_path), "dbx", "claude-sdk")

    # Databricks serves both families, so neither default login dir applies.
    assert env == {SESSION_PROVIDER_ENV: "dbx"}


@pytest.mark.parametrize(
    "provider,harness,message",
    [
        ("nope", "claude-native", "'nope' is not configured on this host"),
        ("codex_b", "claude-native", "cannot run the 'claude-native' harness"),
        ("max2", "claude-sdk", "'max2' is not logged in"),
    ],
)
def test_session_runner_env_fails_loudly(
    tmp_path: Path, provider: str, harness: str, message: str
) -> None:
    with pytest.raises(OmnigentError, match=message):
        session_runner_env(_session_config(tmp_path), provider, harness)


def test_session_provider_becomes_the_default_for_its_family(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    config = _session_config(tmp_path)
    monkeypatch.setenv(SESSION_PROVIDER_ENV, "max2")

    assert get_default_provider(config, "anthropic").name == "max2"  # type: ignore[union-attr]
    # Other families keep their own defaults.
    assert get_default_provider(config, "openai").name == "codex_b"  # type: ignore[union-attr]

    monkeypatch.setenv(SESSION_PROVIDER_ENV, "gone")
    with pytest.raises(OmnigentError, match="'gone', which is no longer configured"):
        get_default_provider(config, "anthropic")


def test_session_account_must_be_the_login_the_cli_starts_with(
    config_home: Path, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    _write_config(config_home, _session_config(tmp_path))
    (tmp_path / "m2").mkdir()
    (tmp_path / "link").symlink_to(tmp_path / "m2")

    # Without a session choice the launch's own login stands.
    require_session_account_dir("claude", tmp_path / "elsewhere")

    monkeypatch.setenv(SESSION_PROVIDER_ENV, "max2")
    require_session_account_dir("claude", tmp_path / "m2")
    require_session_account_dir("claude", tmp_path / "link")
    with pytest.raises(OmnigentError, match="runs on account 'max2'") as failure:
        require_session_account_dir("claude", tmp_path / "elsewhere")
    # The native-terminal error payload shows this code's message to the user.
    assert failure.value.code == ErrorCode.HARNESS_NOT_CONFIGURED

    # A gateway account has no login directory for the launch to diverge from.
    monkeypatch.setenv(SESSION_PROVIDER_ENV, "dbx")
    require_session_account_dir("claude", tmp_path / "elsewhere")


def _token_config() -> dict[str, object]:
    return _providers(
        max1={"kind": "subscription", "cli": "claude", "default": True},
        max2={"kind": "subscription", "cli": "claude", "token_ref": "env:MAX2_TOKEN"},
    )


@pytest.mark.parametrize(
    "cli,token_ref",
    [("codex", "env:CODEX_TOKEN"), ("claude", "sk-ant-oat01-literal"), ("claude", 3)],
)
def test_token_ref_rejected_when_unsupported_or_inline(cli: str, token_ref: object) -> None:
    with pytest.raises(OmnigentError, match="'token_ref' must be"):
        load_providers(_providers(a={"kind": "subscription", "cli": cli, "token_ref": token_ref}))


def test_token_account_signs_in_with_its_token(monkeypatch: pytest.MonkeyPatch) -> None:
    entry = load_providers(_token_config())["max2"]
    monkeypatch.delenv("MAX2_TOKEN", raising=False)

    assert not subscription_logged_in(entry)
    assert subscription_login_command(entry) == "claude setup-token"
    with pytest.raises(OmnigentError, match="no token stored as 'env:MAX2_TOKEN'"):
        require_subscription_login(entry)

    monkeypatch.setenv("MAX2_TOKEN", "sk-ant-oat01-max2")
    assert subscription_logged_in(entry)
    assert subscription_token_env(entry) == {"CLAUDE_CODE_OAUTH_TOKEN": "sk-ant-oat01-max2"}
    # A token account shares the default login directory, so it sets none.
    assert subscription_home_env(entry) == {}
    rows = provider_choices(_token_config(), "claude-native")
    row = next(r for r in rows if r["name"] == "max2")
    assert row["label"] == "claude account token"
    # It shares the default login's sessions, so a running session can switch to it.
    assert row["switch_group"] == rows[0]["switch_group"]
    assert row["ready"] is True
    assert "sk-ant-oat01" not in json.dumps(row)


def test_claude_account_env_follows_the_pin_then_the_session(
    config_home: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _write_config(config_home, _token_config())
    monkeypatch.setenv("MAX2_TOKEN", "sk-ant-oat01-max2")
    token_env = {"CLAUDE_CODE_OAUTH_TOKEN": "sk-ant-oat01-max2"}

    # The default account uses its stored login.
    assert claude_account_env() == {}
    assert claude_account_env("max2") == token_env

    monkeypatch.setenv(SESSION_PROVIDER_ENV, "max2")
    assert claude_account_env() == token_env
    # An agent pinning the stored-login account keeps it.
    assert claude_account_env("max1") == {}

    monkeypatch.delenv("MAX2_TOKEN")
    with pytest.raises(OmnigentError, match="setup-token") as failure:
        claude_account_env()
    assert failure.value.code == ErrorCode.HARNESS_NOT_CONFIGURED


def test_session_token_account_must_reach_the_cli(
    config_home: Path, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    _write_config(config_home, _token_config())
    monkeypatch.setenv("MAX2_TOKEN", "sk-ant-oat01-max2")
    monkeypatch.setenv("CLAUDE_CONFIG_DIR", str(tmp_path / "shared"))
    monkeypatch.setenv(SESSION_PROVIDER_ENV, "max2")
    shared = tmp_path / "shared"

    require_session_account_dir("claude", shared, {"CLAUDE_CODE_OAUTH_TOKEN": "sk-ant-oat01-max2"})
    for launch_env in ({}, {"CLAUDE_CODE_OAUTH_TOKEN": "sk-ant-oat01-other"}):
        with pytest.raises(OmnigentError, match="sets a different CLAUDE_CODE_OAUTH_TOKEN"):
            require_session_account_dir("claude", shared, launch_env)


def test_provider_choices_list_family_providers_without_secrets(tmp_path: Path) -> None:
    _write_claude_login(tmp_path / "m1")

    rows = provider_choices(_session_config(tmp_path), "claude-native")
    groups = {row["name"]: row.pop("switch_group") for row in rows}

    # Separate login dirs keep separate sessions; the rest share the host's.
    assert len({groups["max1"], groups["max2"], groups["dbx"]}) == 3
    assert groups["dbx"] == groups["openrouter"]
    assert rows == [
        {
            "name": "max1",
            "kind": "subscription",
            "label": "claude login (own directory)",
            "default": True,
            "ready": True,
        },
        {
            "name": "max2",
            "kind": "subscription",
            "label": "claude login (own directory)",
            "default": False,
            "ready": False,
        },
        {
            "name": "dbx",
            "kind": "databricks",
            "label": "Databricks profile alt",
            "default": False,
            "ready": True,
        },
        {
            "name": "openrouter",
            "kind": "gateway",
            "label": "gateway · openrouter.ai",
            "default": False,
            "ready": True,
        },
    ]
    assert "sk-literal" not in json.dumps(rows)
    # Picker labels never name the host's login directories.
    assert str(tmp_path) not in json.dumps(rows)
    assert provider_choices(_session_config(tmp_path), "cursor") == []


def test_host_provider_summary_names_each_providers_clis_and_defaults(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    _write_claude_login(tmp_path / "m1")
    config = _session_config(tmp_path)

    rows = {row.pop("name"): row for row in host_provider_summary(config)}

    assert rows["max1"] == {
        "kind": "subscription",
        "label": "claude login (own directory)",
        "clis": ["claude"],
        "default_for": ["claude"],
        "ready": True,
    }
    assert rows["max2"]["ready"] is False
    assert rows["codex_b"]["clis"] == rows["codex_b"]["default_for"] == ["codex"]
    assert rows["dbx"]["clis"] == ["claude", "codex"]
    assert rows["openrouter"]["clis"] == ["claude"]
    assert str(tmp_path) not in json.dumps(rows)

    # Inside a runner on Databricks, children of either CLI default to it.
    monkeypatch.setenv(SESSION_PROVIDER_ENV, "dbx")
    dbx = next(row for row in host_provider_summary(config) if row["name"] == "dbx")
    assert dbx["default_for"] == ["claude", "codex"]


@pytest.mark.parametrize(
    "session_provider,provider,own_runner",
    [
        (None, "max1", False),
        (None, "max2", True),
        (None, "codex_b", False),
        # Databricks serves both families, so the runner must use it for both.
        (None, "dbx", True),
        ("dbx", "dbx", False),
        ("dbx", "max1", True),
        ("dbx", "codex_b", True),
    ],
)
def test_child_account_shares_the_runner_only_on_the_runners_account(
    config_home: Path,
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
    session_provider: str | None,
    provider: str,
    own_runner: bool,
) -> None:
    from omnigent.runner.child_account import choose_child_account

    _write_config(config_home, _session_config(tmp_path))
    for login in ("m1", "m2"):
        _write_claude_login(tmp_path / login)
    _write_codex_login(tmp_path / "cb")
    if session_provider is not None:
        monkeypatch.setenv(SESSION_PROVIDER_ENV, session_provider)

    assert choose_child_account(provider).own_runner is own_runner


def test_host_launch_env_uses_defaults_or_the_session_choice(
    config_home: Path, tmp_path: Path
) -> None:
    from omnigent.host.connect import _runner_account_env
    from omnigent.host.frames import HostLaunchRunnerFrame

    _write_config(config_home, _session_config(tmp_path))
    frame = HostLaunchRunnerFrame(request_id="r", binding_token="t", workspace="/w")

    assert _runner_account_env(frame) == {
        "CLAUDE_CONFIG_DIR": str(tmp_path / "m1"),
        "CODEX_HOME": str(tmp_path / "cb"),
    }
    frame.provider, frame.harness = "max2", "claude-native"
    with pytest.raises(OmnigentError, match="not logged in"):
        _runner_account_env(frame)
