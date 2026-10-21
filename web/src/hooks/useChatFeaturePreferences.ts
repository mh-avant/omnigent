import { useQuery } from "@tanstack/react-query";
import type { ChatFeatureDefinition } from "@/lib/chatFeatures";
import {
  type ChatFeatureDefault,
  getChatFeatureCatalog,
  getChatFeatureDefault,
} from "@/lib/chatFeaturesApi";

export const CHAT_FEATURE_CATALOG_QUERY_KEY = ["chat-features", "catalog"];
/** Shared cache key, so a saved default reaches every open surface. */
export const CHAT_FEATURE_DEFAULT_QUERY_KEY = ["preferences", "shared", "chat_features"];

/** Every chat feature a session can enable. */
export function useChatFeatureCatalog() {
  return useQuery<ChatFeatureDefinition[]>({
    queryKey: CHAT_FEATURE_CATALOG_QUERY_KEY,
    queryFn: getChatFeatureCatalog,
    staleTime: Number.POSITIVE_INFINITY,
  });
}

/** The user's saved default chat features, from shared preferences. */
export function useChatFeatureDefault() {
  return useQuery<ChatFeatureDefault>({
    queryKey: CHAT_FEATURE_DEFAULT_QUERY_KEY,
    queryFn: getChatFeatureDefault,
    staleTime: 30_000,
  });
}
