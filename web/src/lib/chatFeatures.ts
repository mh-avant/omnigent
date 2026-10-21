/**
 * Chat features: per-session switches that pair a chat renderer with the
 * agent instruction that makes its output renderable. The server owns the
 * catalog (titles, descriptions, order); the web only needs the keys of the
 * renderers it gates.
 */

/** Show Run on agent-suggested shell commands. */
export const RUN_COMMANDS_CHAT_FEATURE = "run_commands";

/** Features a session has when the server sent none (every feature is on). */
export const DEFAULT_CHAT_FEATURES: readonly string[] = [RUN_COMMANDS_CHAT_FEATURE];

/** Native harnesses that read framework instructions only when they launch. */
const LAUNCH_INSTRUCTION_HARNESSES = new Set(["claude-native", "codex-native"]);

/** One feature as `/v1/chat-features` describes it. */
export interface ChatFeatureDefinition {
  key: string;
  title: string;
  description: string;
}

/**
 * Whether a chat-feature change reaches the agent only after its session
 * restarts, because the harness takes its instructions at launch.
 *
 * @param harness - The session harness id, e.g. `"claude-native"`.
 */
export function chatFeaturesApplyOnRestart(harness: string | null | undefined): boolean {
  return harness != null && LAUNCH_INSTRUCTION_HARNESSES.has(harness);
}

/**
 * `enabled` with `key` switched on or off, in catalog order.
 *
 * @param enabled - The currently enabled feature keys.
 * @param key - The feature to switch, e.g. `"run_commands"`.
 * @param on - Whether `key` should be enabled.
 * @param available - The catalog, whose order the result follows; keys
 *   missing from it keep their relative order at the end.
 */
export function withChatFeature(
  enabled: readonly string[],
  key: string,
  on: boolean,
  available: readonly ChatFeatureDefinition[],
): string[] {
  const next = new Set(enabled);
  if (on) next.add(key);
  else next.delete(key);
  const position = (feature: string) => {
    const index = available.findIndex((definition) => definition.key === feature);
    return index === -1 ? available.length : index;
  };
  return [...next].sort((left, right) => position(left) - position(right));
}
