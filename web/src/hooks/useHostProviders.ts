import { useQuery } from "@tanstack/react-query";
import { authenticatedFetch } from "@/lib/identity";

/** A provider a host can run a harness on; never carries credentials. */
export interface HostProvider {
  name: string;
  kind: string;
  /** Where it authenticates, e.g. "claude CLI login (~/.claude-max2)". */
  label: string;
  /** Sessions use it when none is chosen. */
  default: boolean;
  /** False when a subscription account is not signed in on the host. */
  ready: boolean;
  /**
   * Providers sharing a non-null group can swap in place within a running
   * session; absent (older hosts) reads as `null`, i.e. no in-place switch.
   */
  switch_group?: string | null;
}

/** Providers the selected host can run `harness` on, for the Account menu section. */
export function useHostProviders(hostId: string | null, harness: string | null) {
  return useQuery({
    queryKey: ["host-providers", hostId, harness],
    queryFn: async (): Promise<HostProvider[]> => {
      const res = await authenticatedFetch(
        `/v1/hosts/${encodeURIComponent(hostId as string)}/providers?harness=${encodeURIComponent(harness as string)}`,
      );
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
      const body = (await res.json()) as { providers?: HostProvider[] };
      return body.providers ?? [];
    },
    enabled: hostId !== null && harness !== null,
    staleTime: 30_000,
  });
}
