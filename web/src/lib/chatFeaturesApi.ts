// The chat-feature catalog (`/v1/chat-features`) and the per-user default,
// stored as the `chat_features` shared preference. New sessions start with the
// saved set unless the create request names its own.

import type { ChatFeatureDefinition } from "./chatFeatures";
import { authenticatedFetch } from "./identity";
import { randomUUID } from "./randomUUID";
import { apiErrorFromResponse } from "./sessionsApi";
import {
  applySharedPreference,
  isSharedPreferenceConflict,
  readSharedPreferences,
  type SharedPreferenceIdentity,
  type SharedPreferenceKey,
  sameSharedPreferenceKey,
  sharedPreferenceInstallationId,
} from "./sharedPreferencesApi";

export const CHAT_FEATURES_PREFERENCE_KEY: SharedPreferenceKey = {
  kind: "chat_features",
  name: "default",
};

/** An edit made elsewhere that competes with the current default. */
export interface ChatFeatureDefaultConflict {
  operationId: string;
  /** Its feature keys, or `null` when it removed the default. */
  value: string[] | null;
}

/** The user's saved default, as the shared-preferences store holds it. */
export interface ChatFeatureDefault {
  /** False when the server hasn't enabled shared preferences, so nothing can be saved. */
  supported: boolean;
  /**
   * Saved feature keys, including any this build doesn't know, or `null` when
   * none is saved and new sessions get every feature.
   */
  saved: string[] | null;
  /** The entry's version, sent as `expected_version`; `0` when never saved. */
  version: number;
  /** Unresolved competing edits; saving resolves them. */
  conflicts: ChatFeatureDefaultConflict[];
  /** The namespace edits must echo; `null` when unsupported. */
  identity: SharedPreferenceIdentity | null;
}

/** The default on a server without shared preferences. */
export const UNSUPPORTED_CHAT_FEATURE_DEFAULT: ChatFeatureDefault = {
  supported: false,
  saved: null,
  version: 0,
  conflicts: [],
  identity: null,
};

function featureKeys(value: unknown): string[] | null {
  return Array.isArray(value)
    ? value.filter((key): key is string => typeof key === "string")
    : null;
}

/** Every chat feature a session can enable, in display order. */
export async function getChatFeatureCatalog(): Promise<ChatFeatureDefinition[]> {
  const res = await authenticatedFetch("/v1/chat-features");
  if (!res.ok) throw await apiErrorFromResponse(res);
  return ((await res.json()) as { available: ChatFeatureDefinition[] }).available;
}

/** Read the user's saved default chat features. */
export async function getChatFeatureDefault(): Promise<ChatFeatureDefault> {
  const snapshot = await readSharedPreferences();
  if (snapshot === null) return UNSUPPORTED_CHAT_FEATURE_DEFAULT;
  const entry = snapshot.entries.find((candidate) =>
    sameSharedPreferenceKey(candidate.key, CHAT_FEATURES_PREFERENCE_KEY),
  );
  return {
    supported: true,
    saved: featureKeys(entry?.value),
    version: entry?.version ?? 0,
    conflicts: snapshot.conflicts
      .filter((conflict) => sameSharedPreferenceKey(conflict.key, CHAT_FEATURES_PREFERENCE_KEY))
      .map((conflict) => ({
        operationId: conflict.operation_id,
        value: featureKeys(conflict.value),
      })),
    identity: snapshot.identity,
  };
}

/**
 * The feature keys new sessions start with, limited to the catalog.
 *
 * @param saved - The saved keys, or `null` for every feature.
 * @param catalog - The features this server offers.
 */
export function effectiveChatFeatureDefault(
  saved: readonly string[] | null,
  catalog: readonly ChatFeatureDefinition[],
): string[] {
  const keys = catalog.map((feature) => feature.key);
  return saved === null ? keys : keys.filter((key) => saved.includes(key));
}

/**
 * Save the user's default, resolving the competing edits listed in `current`.
 * When another edit lands first, it re-reads and retries once.
 *
 * @param value - Feature keys new sessions should start with, or `null` to
 *   remove the saved default.
 * @param current - The default this edit replaces.
 * @returns The default as stored afterwards.
 */
export async function saveChatFeatureDefault(
  value: string[] | null,
  current: ChatFeatureDefault,
): Promise<ChatFeatureDefault> {
  let base = current;
  // Sequential by necessity: a retry is built from the re-read that precedes it.
  /* oxlint-disable no-await-in-loop */
  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (base.identity === null) {
      throw new Error("Shared preferences are not enabled on this server.");
    }
    let conflicted: boolean;
    try {
      const result = await applySharedPreference({
        protocol_version: 1,
        identity: base.identity,
        operation_id: randomUUID(),
        installation_id: sharedPreferenceInstallationId(),
        key: CHAT_FEATURES_PREFERENCE_KEY,
        expected_version: base.version,
        value,
        resolves: base.conflicts.map((conflict) => conflict.operationId),
      });
      conflicted = result.status === "conflict";
    } catch (error) {
      if (!isSharedPreferenceConflict(error)) throw error;
      conflicted = true;
    }
    base = await getChatFeatureDefault();
    if (!conflicted) return base;
  }
  /* oxlint-enable no-await-in-loop */
  throw new Error("Another device changed your chat features at the same time.");
}
