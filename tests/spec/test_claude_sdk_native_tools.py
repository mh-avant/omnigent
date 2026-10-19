"""Claude SDK ``native_tools`` survive YAML loading and CLI bundle transport."""

from pathlib import Path

import pytest
import yaml

from omnigent.chat import _bundle_agent
from omnigent.errors import OmnigentError
from omnigent.spec import load
from omnigent.spec.omnigent import agent_def_to_agent_spec, agent_spec_to_agent_def


def _write_agent(tmp_path: Path, *, directory: bool, executor: dict) -> Path:
    source = tmp_path / "agent"
    source.mkdir()
    if directory:
        executor_config = dict(executor)
        model = executor_config.pop("model", None)
        config = {
            "spec_version": 1,
            "name": "claude-native-tools",
            "executor": {"type": "omnigent", "model": model, "config": executor_config},
            "prompt": "Explicit agent instructions.",
        }
        (source / "config.yaml").write_text(yaml.safe_dump(config))
        return source
    config = {
        "name": "claude-native-tools",
        "executor": executor,
        "prompt": "Explicit agent instructions.",
    }
    path = source / "agent.yaml"
    path.write_text(yaml.safe_dump(config))
    return path


@pytest.mark.parametrize("directory", [False, True], ids=["yaml", "bundle"])
@pytest.mark.parametrize(
    "native_tools", [None, ["WebSearch"], ["WebSearch", "WebFetch"]], ids=["unset", "one", "both"]
)
def test_native_tools_survives_bundle_transport(
    tmp_path: Path, directory: bool, native_tools: list[str] | None
) -> None:
    executor: dict[str, object] = {"harness": "claude-sdk", "model": "claude-sonnet-4-6"}
    if native_tools is not None:
        executor["native_tools"] = native_tools
    path = _write_agent(tmp_path, directory=directory, executor=executor)
    spec = load(_bundle_agent(path), dest=tmp_path / "uploaded")

    for candidate in (spec, agent_def_to_agent_spec(agent_spec_to_agent_def(spec))):
        assert candidate.executor.config.get("native_tools") == native_tools


@pytest.mark.parametrize("directory", [False, True], ids=["yaml", "bundle"])
@pytest.mark.parametrize(
    ("value", "message"),
    [
        (["Bash"], r"native_tools.*unsupported tool\(s\) Bash"),
        ("WebSearch", r"native_tools.*must be a list"),
        ([1], r"native_tools.*must be a list"),
    ],
    ids=["unsupported", "string", "non-string-item"],
)
def test_native_tools_rejects_invalid_values(
    tmp_path: Path, directory: bool, value: object, message: str
) -> None:
    path = _write_agent(
        tmp_path, directory=directory, executor={"harness": "claude-sdk", "native_tools": value}
    )
    with pytest.raises((OmnigentError, ValueError), match=message):
        load(path)


@pytest.mark.parametrize("harness", ["claude-native", "codex"])
def test_native_tools_rejects_unsupported_harness(tmp_path: Path, harness: str) -> None:
    path = _write_agent(
        tmp_path, directory=False, executor={"harness": harness, "native_tools": ["WebSearch"]}
    )
    with pytest.raises(OmnigentError, match=r"native_tools.*only supported.*claude-sdk"):
        load(path)
