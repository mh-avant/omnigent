"""Tests for subscription accounts with their own login directory."""

from __future__ import annotations

import json
import subprocess
from pathlib import Path
from typing import Any

import pytest
import yaml

from omnigent.errors import OmnigentError
from omnigent.onboarding import harness_install, harness_readiness
from omnigent.onboarding.provider_config import (
    describe_active_credential,
    load_providers,
    subscription_config_dir,
)
from omnigent.onboarding.subscription_accounts import (
    apply_default_account_env,
    default_accounts_env,
    require_subscription_dir_active,
    require_subscription_login,
    subscription_home_env,
    subscription_logged_in,
    subscription_login_command,
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
