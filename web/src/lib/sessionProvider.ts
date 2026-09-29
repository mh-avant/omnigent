import type { HostProvider } from "@/hooks/useHostProviders";

export interface SessionProviderChoice {
  /** `provider_override` to send; `null` runs on the host's default. */
  override: string | null;
  /** Why the project's default account is not used, shown under the composer. */
  projectFallback: string | null;
}

/**
 * Resolve the account a new session runs on. The user's pick wins; otherwise a
 * project's default account applies where the host can run the harness on it,
 * and falls back to the host default with a visible reason where it can't.
 */
export function resolveSessionProvider({
  userPick,
  projectProvider,
  providers,
  accountsApply,
}: {
  /** `undefined` = no pick yet; `null` = the user picked the host default. */
  userPick: string | null | undefined;
  /** The project's stored `provider`, if any. */
  projectProvider: string | undefined;
  /** The host's providers for the harness; `undefined` until listed. */
  providers: HostProvider[] | undefined;
  /** False for a sandbox or a routed harness, where host accounts don't apply. */
  accountsApply: boolean;
}): SessionProviderChoice {
  const project = userPick === undefined ? projectProvider?.trim() || null : null;
  if (!accountsApply) {
    return {
      override: null,
      projectFallback: project
        ? `Project account "${project}" doesn't apply to sandbox or routed sessions; using the default account.`
        : null,
    };
  }
  if (userPick !== undefined) {
    // A pick from another host or harness family no longer applies.
    const valid = providers?.some((p) => p.name === userPick && !p.default) ?? false;
    return { override: valid ? userPick : null, projectFallback: null };
  }
  if (project === null) return { override: null, projectFallback: null };
  // Not listed yet: send the project's account and let the host reject it loudly.
  if (providers === undefined) return { override: project, projectFallback: null };
  const match = providers.find((p) => p.name === project);
  if (!match) {
    return {
      override: null,
      projectFallback: `Project account "${project}" isn't available for this harness on this host; using the default account.`,
    };
  }
  if (!match.ready) {
    return {
      override: null,
      projectFallback: `Project account "${project}" isn't signed in on this host; using the default account.`,
    };
  }
  return { override: match.default ? null : match.name, projectFallback: null };
}
