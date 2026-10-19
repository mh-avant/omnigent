/**
 * Detect shell commands an agent asks the user to run, so the chat can offer a
 * one-tap "Run" that queues each as a `!command` shell input.
 */

/** Harnesses whose web composer treats a `!command` message as a shell input. */
const SHELL_INPUT_HARNESSES = new Set(["claude-native", "codex-native"]);

/** Fence languages whose whole body is commands, even without `!` prefixes. */
const SHELL_LANGUAGES = new Set(["bash", "sh", "shell", "zsh", "console", "shell-session"]);

/** More commands than this reads as a script to study, not steps to run. */
export const MAX_RUNNABLE_COMMANDS = 10;

const PROMPT_PREFIX = /^\$\s+/;

/**
 * Whether a session's harness runs a `!command` message as a shell input.
 *
 * @param harness - The session harness id, e.g. `"claude-native"`.
 */
export function harnessRunsShellCommands(harness: string | null | undefined): boolean {
  return harness != null && SHELL_INPUT_HARNESSES.has(harness);
}

/** The command after a single leading `!`, or null when `line` is not one. */
function bangCommand(line: string): string | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith("!") || trimmed.startsWith("!!")) return null;
  const command = trimmed.slice(1).trim();
  return command === "" ? null : command;
}

/** Split code into logical lines, joining trailing-backslash continuations. */
function logicalLines(code: string): string[] {
  const lines: string[] = [];
  let pending = "";
  for (const line of code.split(/\r?\n/)) {
    const piece = pending === "" ? line : line.trimStart();
    if (/\\\s*$/.test(piece)) {
      pending += `${piece.replace(/\\\s*$/, "").trimEnd()} `;
      continue;
    }
    lines.push(pending + piece);
    pending = "";
  }
  if (pending !== "") lines.push(pending);
  return lines;
}

/**
 * Commands a fenced code block asks the user to run, one per queued input.
 *
 * `!`-prefixed lines win: each becomes its own command and other lines are
 * treated as commentary. Otherwise a shell-language block yields one command
 * per line, keeping only `$ `-prompted lines when it shows a transcript.
 * Heredocs and long scripts yield nothing, since splitting them would change
 * what runs.
 *
 * @param code - The code block body.
 * @param language - The fence language, e.g. `"bash"`, if any.
 * @returns The commands without their `!` prefix, e.g. `["gcloud auth login"]`.
 */
export function extractRunnableCommands(code: string, language?: string | null): string[] {
  const lines = logicalLines(code);
  const bangCommands = lines.map(bangCommand).filter((command) => command !== null);
  if (bangCommands.length > 0) {
    return bangCommands.length <= MAX_RUNNABLE_COMMANDS ? bangCommands : [];
  }

  if (!language || !SHELL_LANGUAGES.has(language.toLowerCase())) return [];
  if (code.includes("<<")) return [];

  const nonBlank = lines.map((line) => line.trim()).filter((line) => line !== "");
  const hasPrompts = nonBlank.some((line) => PROMPT_PREFIX.test(line));
  const commands = nonBlank
    .filter((line) => (hasPrompts ? PROMPT_PREFIX.test(line) : !/^[#!]/.test(line)))
    .map((line) => line.replace(PROMPT_PREFIX, "").trim())
    .filter((line) => line !== "");
  return commands.length <= MAX_RUNNABLE_COMMANDS ? commands : [];
}

/**
 * The command in an inline code span written as `` `! cmd` ``, or null.
 *
 * @param text - The inline code text, e.g. `"! gcloud auth login"`.
 */
export function extractInlineRunnableCommand(text: string): string | null {
  return text.includes("\n") ? null : bangCommand(text);
}
