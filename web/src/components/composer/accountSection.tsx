/**
 * Build the "Account" section of the harness menu: which of the host's
 * providers (e.g. one of several Claude subscriptions) a session runs on.
 *
 * Shared by the new-session dialog (picks the account a session starts on) and
 * the in-session composer (switches a running session), so both list the same
 * rows, labels and disabled states.
 */
import type { HostProvider } from "@/hooks/useHostProviders";
import type { ComposerConfigSection } from "./ComposerConfigSections";

export const SEPARATE_LOGIN_HINT = "Separate login — start a new session";

/** The provider a session runs on: its override, else the host default. */
export function currentProvider(
  providers: readonly HostProvider[],
  override: string | null | undefined,
): HostProvider | undefined {
  return override != null
    ? providers.find((p) => p.name === override)
    : providers.find((p) => p.default);
}

/**
 * Why a running session can't move onto `provider` in place, or `undefined`
 * when it can. Only providers sharing the current one's switch group share a
 * login and conversation store.
 */
export function inPlaceSwitchBlocked(
  provider: HostProvider,
  current: HostProvider | undefined,
): string | undefined {
  if (provider === current) return undefined;
  const group = current?.switch_group ?? null;
  return group !== null && provider.switch_group === group ? undefined : SEPARATE_LOGIN_HINT;
}

export function buildAccountSection({
  providers,
  value,
  testIdPrefix,
  onSelect,
  disabled = false,
  blockedReason,
}: {
  providers: readonly HostProvider[];
  /** The chosen provider name; `null` = the host default. */
  value: string | null;
  /** e.g. `new-chat-landing-agent` or `composer-agent`. */
  testIdPrefix: string;
  /** Called with the picked provider name, or `null` for the host default. */
  onSelect: (name: string | null) => void;
  disabled?: boolean;
  /** Extra reason a ready row can't be picked (shown as its hint). */
  blockedReason?: (provider: HostProvider) => string | undefined;
}): ComposerConfigSection | undefined {
  if (providers.length < 2) return undefined;
  const selected = currentProvider(providers, value);
  const ordered = [...providers.filter((p) => p.default), ...providers.filter((p) => !p.default)];
  return {
    testId: `${testIdPrefix}-accounts`,
    header: "Account",
    choices: ordered.map((provider) => {
      const checked = provider === selected;
      const blocked = provider.ready ? blockedReason?.(provider) : undefined;
      const hint = !provider.ready
        ? `${provider.label} · not signed in`
        : (blocked ?? provider.label);
      return {
        key: provider.name,
        label: (
          <span className="flex min-w-0 flex-col">
            <span className="truncate">
              {provider.default ? `Default (${provider.name})` : provider.name}
            </span>
            <span className="truncate text-xs text-muted-foreground">{hint}</span>
          </span>
        ),
        checked,
        disabled: disabled || !provider.ready || blocked !== undefined,
        onSelect: checked ? undefined : () => onSelect(provider.default ? null : provider.name),
        testId: `${testIdPrefix}-account-${provider.name}`,
        title: blocked ? `${provider.label} · ${blocked}` : hint,
        className: "whitespace-normal [&>span:last-child]:min-w-0",
        data: { "data-provider": provider.name },
      };
    }),
  };
}
