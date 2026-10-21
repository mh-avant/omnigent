import type { QueryClient } from "@tanstack/react-query";
import {
  CHAT_FEATURE_CATALOG_QUERY_KEY,
  CHAT_FEATURE_DEFAULT_QUERY_KEY,
} from "@/hooks/useChatFeaturePreferences";
import type { ChatFeatureDefinition } from "@/lib/chatFeatures";
import { type ChatFeatureDefault, UNSUPPORTED_CHAT_FEATURE_DEFAULT } from "@/lib/chatFeaturesApi";

export const RUN_COMMANDS_DEFINITION: ChatFeatureDefinition = {
  key: "run_commands",
  title: "Run suggested commands",
  description: "Run",
};

export interface ChatFeatureSeed {
  catalog?: ChatFeatureDefinition[];
  saved?: ChatFeatureDefault;
}

/** An empty catalog: the Chat features menu section stays hidden. */
export const NO_CHAT_FEATURE_PREFERENCES: ChatFeatureSeed = {};

/** A saved default, as a server with shared preferences reports it. */
export function savedChatFeatureDefault(saved: string[] | null): ChatFeatureDefault {
  return {
    supported: true,
    saved,
    version: saved === null ? 0 : 1,
    conflicts: [],
    identity: { authority_id: "test", user_id: "local", workspace_id: "0" },
  };
}

/** Seed the catalog and default so opening a menu issues no request. */
export function seedChatFeaturePreferences(
  client: QueryClient,
  { catalog = [], saved = UNSUPPORTED_CHAT_FEATURE_DEFAULT }: ChatFeatureSeed = {},
): void {
  client.setQueryData(CHAT_FEATURE_CATALOG_QUERY_KEY, catalog);
  client.setQueryData(CHAT_FEATURE_DEFAULT_QUERY_KEY, saved);
}
