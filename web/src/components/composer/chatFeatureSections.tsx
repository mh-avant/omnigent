/**
 * The "Chat features" checkbox section of the shared
 * {@link ComposerConfigSections} menu, used by the landing dialog and the
 * in-session composer.
 */
import { DropdownMenuSeparator } from "@/components/ui/dropdown-menu";
import { useChatFeatureCatalog, useChatFeatureDefault } from "@/hooks/useChatFeaturePreferences";
import { type ChatFeatureDefinition, withChatFeature } from "@/lib/chatFeatures";
import { effectiveChatFeatureDefault } from "@/lib/chatFeaturesApi";
import { type ComposerConfigSection, ComposerConfigSections } from "./ComposerConfigSections";

/** Shown under the header for harnesses that read instructions at launch. */
export const CHAT_FEATURES_RESTART_NOTE = "Applies to the agent after the session restarts.";

export function buildChatFeatureSections({
  catalog,
  enabled,
  testIdPrefix,
  onChange,
  showRestartNote = false,
  disabled = false,
}: {
  /** The server's feature catalog; an empty one renders no section. */
  catalog: readonly ChatFeatureDefinition[];
  /** The feature keys currently on. */
  enabled: readonly string[];
  /** e.g. `new-chat-landing-agent` or `composer-agent`. */
  testIdPrefix: string;
  /** Called with the full enabled set, in catalog order, after a toggle. */
  onChange: (enabled: string[]) => void;
  showRestartNote?: boolean;
  disabled?: boolean;
}): ComposerConfigSection[] {
  if (catalog.length === 0) return [];
  return [
    {
      testId: `${testIdPrefix}-chat-features`,
      header: "Chat features",
      leading: showRestartNote ? (
        <div className="px-2 py-1 text-xs text-muted-foreground" role="note">
          {CHAT_FEATURES_RESTART_NOTE}
        </div>
      ) : undefined,
      choices: catalog.map((feature) => {
        const checked = enabled.includes(feature.key);
        return {
          key: feature.key,
          label: feature.title,
          title: feature.description,
          checked,
          disabled,
          onSelect: () => onChange(withChatFeature(enabled, feature.key, !checked, catalog)),
          testId: `${testIdPrefix}-chat-feature-${feature.key}`,
        };
      }),
    },
  ];
}

/**
 * The Chat features section of the new-chat menu, pre-checked from the user's
 * saved default (every feature when none is saved or the server can't store
 * one). It loads that default only once the menu opens.
 */
export function NewChatFeatureSection({
  picked,
  onChange,
  testIdPrefix,
}: {
  /** The user's pick, or null to show the saved default. */
  picked: readonly string[] | null;
  onChange: (enabled: string[]) => void;
  testIdPrefix: string;
}) {
  const catalog = useChatFeatureCatalog().data ?? [];
  const saved = useChatFeatureDefault().data?.saved ?? null;
  const sections = buildChatFeatureSections({
    catalog,
    enabled: picked ?? effectiveChatFeatureDefault(saved, catalog),
    testIdPrefix,
    onChange,
  });
  if (sections.length === 0) return null;
  return (
    <>
      <DropdownMenuSeparator />
      <ComposerConfigSections extra={sections} />
    </>
  );
}
