import { describe, expect, it } from "vitest";
import {
  extractInlineRunnableCommand,
  extractRunnableCommands,
  harnessRunsShellCommands,
  MAX_RUNNABLE_COMMANDS,
  sessionOffersRunCommands,
} from "./runnableCommands";

describe("extractRunnableCommands", () => {
  it("splits each !-prefixed line into its own command", () => {
    const code = "! gcloud auth login\n!gh auth status\n";
    expect(extractRunnableCommands(code, undefined)).toEqual([
      "gcloud auth login",
      "gh auth status",
    ]);
  });

  it("ignores commentary lines around ! commands, in any language", () => {
    const code = "# first log in\n! gcloud auth login\nthen retry";
    expect(extractRunnableCommands(code, "text")).toEqual(["gcloud auth login"]);
  });

  it("does not treat !! or a bare ! as a command", () => {
    expect(extractRunnableCommands("!!\n!\n", "bash")).toEqual([]);
  });

  it("joins backslash continuations into one command", () => {
    const code = "! docker run \\\n  --rm alpine";
    expect(extractRunnableCommands(code, undefined)).toEqual(["docker run --rm alpine"]);
  });

  it("yields one command per line of a shell block, skipping comments", () => {
    const code = "# install\nnpm install\n\nnpm test\n";
    expect(extractRunnableCommands(code, "bash")).toEqual(["npm install", "npm test"]);
    expect(extractRunnableCommands(code, "Shell")).toEqual(["npm install", "npm test"]);
  });

  it("keeps only prompted lines of a console transcript", () => {
    const code = "$ git status\nOn branch main\n$ git log -1\n";
    expect(extractRunnableCommands(code, "console")).toEqual(["git status", "git log -1"]);
  });

  it("offers nothing for non-shell blocks without ! lines", () => {
    expect(extractRunnableCommands("print('hi')", "python")).toEqual([]);
    expect(extractRunnableCommands("npm install", undefined)).toEqual([]);
  });

  it("offers nothing for a heredoc, which line splitting would break", () => {
    expect(extractRunnableCommands("cat <<EOF > a.txt\nhi\nEOF", "bash")).toEqual([]);
  });

  it("offers nothing for a block longer than the command cap", () => {
    const code = Array.from({ length: MAX_RUNNABLE_COMMANDS + 1 }, (_, i) => `!echo ${i}`).join(
      "\n",
    );
    expect(extractRunnableCommands(code, undefined)).toEqual([]);
  });
});

describe("extractInlineRunnableCommand", () => {
  it("reads a ! inline span", () => {
    expect(extractInlineRunnableCommand("! gcloud auth login")).toBe("gcloud auth login");
    expect(extractInlineRunnableCommand("!ls")).toBe("ls");
  });

  it("rejects plain inline code", () => {
    expect(extractInlineRunnableCommand("git status")).toBeNull();
    expect(extractInlineRunnableCommand("!!")).toBeNull();
  });
});

describe("harnessRunsShellCommands", () => {
  it("allows only harnesses with a shell input mode", () => {
    expect(harnessRunsShellCommands("claude-native")).toBe(true);
    expect(harnessRunsShellCommands("codex-native")).toBe(true);
    expect(harnessRunsShellCommands("claude-sdk")).toBe(false);
    expect(harnessRunsShellCommands(null)).toBe(false);
  });
});

describe("sessionOffersRunCommands", () => {
  it("needs both a shell-input harness and the run_commands feature", () => {
    expect(sessionOffersRunCommands("claude-native", ["run_commands"])).toBe(true);
    expect(sessionOffersRunCommands("claude-native", [])).toBe(false);
    expect(sessionOffersRunCommands("codex-native", ["item_labels"])).toBe(false);
    expect(sessionOffersRunCommands("claude-sdk", ["run_commands"])).toBe(false);
  });
});
