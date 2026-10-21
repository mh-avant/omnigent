// Typed client for the opt-in shared-preferences API
// (`/v1/preferences/shared`). The server mounts it only when it sets
// `shared_preferences_authority_id`; otherwise reads report it as unavailable.

import { authenticatedFetch } from "./identity";
import { randomUUID } from "./randomUUID";
import { ApiError, apiErrorFromResponse } from "./sessionsApi";

const SHARED_PATH = "/v1/preferences/shared";
const INSTALLATION_ID_STORAGE_KEY = "omnigent.sharedPreferences.installationId";
/** Edits landing between pages restart the read; give up after this many restarts. */
const PAGINATION_RESTARTS = 2;

/** The authenticated namespace every edit must echo back. */
export interface SharedPreferenceIdentity {
  authority_id: string;
  user_id: string;
  workspace_id: string;
}

/** One merge unit, e.g. `{ kind: "chat_features", name: "default" }`. */
export interface SharedPreferenceKey {
  kind: string;
  name: string | { ecosystem: string; source: string; name: string };
}

export type SharedPreferenceValue = string | boolean | string[] | null;

export interface SharedPreferenceEntry {
  key: SharedPreferenceKey;
  /** `0` for a key that was never saved. */
  version: number;
  /** `null` once the choice was removed. */
  value: SharedPreferenceValue;
  installation_id?: string | null;
}

/** An explicit edit; a conflicting one is kept as an alternative to resolve. */
export interface SharedPreferenceOperation {
  protocol_version: 1;
  identity: SharedPreferenceIdentity;
  operation_id: string;
  installation_id: string;
  key: SharedPreferenceKey;
  expected_version: number;
  value: SharedPreferenceValue;
  resolves: string[];
}

export interface SharedPreferenceResult {
  operation_id: string;
  status: "applied" | "unchanged" | "conflict";
  revision: number;
  entry: SharedPreferenceEntry;
}

/** Every page of one revision, merged. */
export interface SharedPreferenceSnapshot {
  identity: SharedPreferenceIdentity;
  revision: number;
  entries: SharedPreferenceEntry[];
  conflicts: SharedPreferenceOperation[];
}

interface SharedPreferencePage extends SharedPreferenceSnapshot {
  next_cursor: string | null;
}

let fallbackInstallationId: string | null = null;

/** This browser's stable source ID for edits; not an authorization grant. */
export function sharedPreferenceInstallationId(): string {
  try {
    const stored = window.localStorage.getItem(INSTALLATION_ID_STORAGE_KEY);
    if (stored) return stored;
    const created = `web-${randomUUID()}`;
    window.localStorage.setItem(INSTALLATION_ID_STORAGE_KEY, created);
    return created;
  } catch {
    // Storage unavailable (private mode, quota): keep one ID for this page load.
    fallbackInstallationId ??= `web-${randomUUID()}`;
    return fallbackInstallationId;
  }
}

/** Whether two keys name the same preference. */
export function sameSharedPreferenceKey(
  left: SharedPreferenceKey,
  right: SharedPreferenceKey,
): boolean {
  return left.kind === right.kind && JSON.stringify(left.name) === JSON.stringify(right.name);
}

/**
 * Read a complete snapshot, following `next_cursor` across pages.
 *
 * @returns The snapshot, or `null` when the server has not enabled shared
 *   preferences (the route is not mounted).
 */
export async function readSharedPreferences(): Promise<SharedPreferenceSnapshot | null> {
  for (let restarts = 0; ; restarts += 1) {
    // oxlint-disable-next-line no-await-in-loop -- a restart follows a failed traversal
    const result = await readAllPages(restarts < PAGINATION_RESTARTS);
    if (result !== "restart") return result;
  }
}

async function readAllPages(
  canRestart: boolean,
): Promise<SharedPreferenceSnapshot | null | "restart"> {
  const entries: SharedPreferenceEntry[] = [];
  const conflicts: SharedPreferenceOperation[] = [];
  let cursor: string | null = null;
  // Sequential by necessity: each request needs the previous page's cursor.
  /* oxlint-disable no-await-in-loop */
  for (;;) {
    const query = cursor === null ? "" : `?cursor=${encodeURIComponent(cursor)}`;
    const res = await authenticatedFetch(`${SHARED_PATH}${query}`);
    if (res.status === 404 && cursor === null) return null;
    // 409: an edit landed between pages; discard them and start over.
    if (res.status === 409 && cursor !== null && canRestart) return "restart";
    if (!res.ok) throw await apiErrorFromResponse(res);
    const page = (await res.json()) as SharedPreferencePage;
    entries.push(...page.entries);
    conflicts.push(...page.conflicts);
    if (page.next_cursor === null) {
      return { identity: page.identity, revision: page.revision, entries, conflicts };
    }
    cursor = page.next_cursor;
  }
  /* oxlint-enable no-await-in-loop */
}

/**
 * Submit one edit. A request that never got a response is retried once with
 * the same body, so the server replays its receipt instead of applying twice.
 */
export async function applySharedPreference(
  operation: SharedPreferenceOperation,
): Promise<SharedPreferenceResult> {
  const send = () =>
    authenticatedFetch(`${SHARED_PATH}/operations`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(operation),
    });
  let res: Response;
  try {
    res = await send();
  } catch {
    res = await send();
  }
  if (!res.ok) throw await apiErrorFromResponse(res);
  return (await res.json()) as SharedPreferenceResult;
}

/** Whether `error` is the API's 409 (stale version, missing conflict, or reused ID). */
export function isSharedPreferenceConflict(error: unknown): boolean {
  return error instanceof ApiError && error.status === 409;
}
