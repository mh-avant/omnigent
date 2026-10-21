import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { SettingsGroup } from "@/components/SettingsGroup";
import { SettingsLabel } from "@/components/SettingsLabel";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import {
  CHAT_FEATURE_DEFAULT_QUERY_KEY,
  useChatFeatureCatalog,
  useChatFeatureDefault,
} from "@/hooks/useChatFeaturePreferences";
import { type ChatFeatureDefinition, withChatFeature } from "@/lib/chatFeatures";
import { effectiveChatFeatureDefault, saveChatFeatureDefault } from "@/lib/chatFeaturesApi";

export const SHARED_PREFERENCES_REQUIRED_NOTE =
  "New sessions start with every feature. Saving a default needs shared preferences enabled on the server.";

/** A saved value as the user reads it, e.g. "Run suggested commands". */
function describeChatFeatures(
  value: readonly string[] | null,
  catalog: readonly ChatFeatureDefinition[],
): string {
  if (value === null) return "Every feature";
  if (value.length === 0) return "None";
  return value
    .map((key) => catalog.find((feature) => feature.key === key)?.title ?? key)
    .join(", ");
}

/** The chat features new sessions start with, saved per user in shared preferences. */
export function ChatFeaturesSettingsGroup() {
  const queryClient = useQueryClient();
  const catalogQuery = useChatFeatureCatalog();
  const defaultQuery = useChatFeatureDefault();
  const [saving, setSaving] = useState(false);
  const [saveFailed, setSaveFailed] = useState(false);
  const catalog = catalogQuery.data;
  const current = defaultQuery.data;

  const save = async (value: string[] | null) => {
    if (!current) return;
    setSaving(true);
    setSaveFailed(false);
    try {
      const saved = await saveChatFeatureDefault(value, current);
      queryClient.setQueryData(CHAT_FEATURE_DEFAULT_QUERY_KEY, saved);
    } catch {
      setSaveFailed(true);
      void queryClient.invalidateQueries({ queryKey: CHAT_FEATURE_DEFAULT_QUERY_KEY });
    } finally {
      setSaving(false);
    }
  };

  if (!catalog || (!current && !defaultQuery.isError)) {
    return (
      <SettingsGroup title="Chat features" testId="settings-group-chat-features">
        <p className="text-sm text-muted-foreground">
          {catalogQuery.isError ? "Chat features are unavailable." : "Loading chat features…"}
        </p>
      </SettingsGroup>
    );
  }

  const supported = current?.supported ?? false;
  const saved = current?.saved ?? null;
  const enabled = effectiveChatFeatureDefault(saved, catalog);
  // Toggle from the stored keys so ones this build doesn't know survive the save.
  const toggle = (key: string, on: boolean) =>
    void save(withChatFeature(saved ?? enabled, key, on, catalog));
  const conflicts = current?.conflicts ?? [];

  return (
    <SettingsGroup title="Chat features" testId="settings-group-chat-features">
      <div>
        <p className="text-sm text-muted-foreground">
          New sessions start with these on. Change them for one session from its configure menu.
        </p>
        {!supported && (
          <p
            className="mt-2 text-sm text-muted-foreground"
            role="note"
            data-testid="chat-features-shared-preferences-required"
          >
            {defaultQuery.isError
              ? "Couldn't load your saved default. New sessions use it if one is saved."
              : SHARED_PREFERENCES_REQUIRED_NOTE}
          </p>
        )}
        {conflicts.length > 0 && (
          <div
            className="mt-3 rounded-md border border-border p-3 text-sm"
            role="status"
            data-testid="chat-features-conflicts"
          >
            <p>Another device saved a different default at the same time. Keep one:</p>
            <ChatFeatureChoice
              label={`Current: ${describeChatFeatures(saved, catalog)}`}
              disabled={saving}
              onKeep={() => void save(saved)}
              testId="chat-features-keep-current"
            />
            {conflicts.map((conflict) => (
              <ChatFeatureChoice
                key={conflict.operationId}
                label={`Other: ${describeChatFeatures(conflict.value, catalog)}`}
                disabled={saving}
                onKeep={() => void save(conflict.value)}
                testId={`chat-features-keep-${conflict.operationId}`}
              />
            ))}
          </div>
        )}
        {catalog.map((feature) => (
          <div key={feature.key} className="mt-4 border-t border-border pt-4">
            <ChatFeatureRow
              featureKey={feature.key}
              title={feature.title}
              description={feature.description}
              checked={enabled.includes(feature.key)}
              disabled={saving || !supported}
              onCheckedChange={(on) => toggle(feature.key, on)}
            />
          </div>
        ))}
        {saveFailed && (
          <span role="alert" className="mt-2 block text-sm text-destructive">
            Couldn&apos;t save your chat features. Your previous setting is unchanged.
          </span>
        )}
      </div>
    </SettingsGroup>
  );
}

function ChatFeatureChoice({
  label,
  disabled,
  onKeep,
  testId,
}: {
  label: string;
  disabled: boolean;
  onKeep: () => void;
  testId: string;
}) {
  return (
    <div className="mt-2 flex items-center justify-between gap-4">
      <span>{label}</span>
      <Button
        variant="outline"
        size="sm"
        disabled={disabled}
        onClick={onKeep}
        data-testid={testId}
        componentId="settings.general.chat_features.keep"
      >
        Keep
      </Button>
    </div>
  );
}

function ChatFeatureRow({
  featureKey,
  title,
  description,
  checked,
  disabled,
  onCheckedChange,
}: {
  featureKey: string;
  title: string;
  description: string;
  checked: boolean;
  disabled: boolean;
  onCheckedChange: (checked: boolean) => void;
}) {
  const labelId = `chat-feature-${featureKey}-label`;
  const descriptionId = `chat-feature-${featureKey}-description`;
  return (
    <div className="flex items-start justify-between gap-6">
      <SettingsLabel
        label={title}
        labelId={labelId}
        descriptionId={descriptionId}
        className="flex-1"
        description={description}
        descriptionClassName="text-ui"
      />
      <Switch
        aria-labelledby={labelId}
        aria-describedby={descriptionId}
        checked={checked}
        disabled={disabled}
        onCheckedChange={onCheckedChange}
        data-testid={`chat-feature-toggle-${featureKey}`}
        className="mt-0.5 shrink-0"
        componentId={`settings.general.chat_feature.${featureKey}`}
      />
    </div>
  );
}
