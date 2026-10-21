import { useEffect, useMemo, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { newSessionLabels } from "@/lib/sessionLabels";
import { overlayLabelsIntoCaches } from "@/lib/sessionListCache";
import { updateSession } from "@/lib/sessionsApi";

/**
 * Set or delete a session's user labels via `PATCH /v1/sessions/{id}`. A
 * `null` value deletes that label. The server-confirmed label map is then
 * painted onto every cache that renders the session.
 *
 * @param sessionId - The session to edit, e.g. `"conv_abc123"`.
 */
export function useUpdateSessionLabels(sessionId: string | null | undefined) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (changes: Record<string, string | null>) => {
      if (!sessionId) throw new Error("No session selected");
      return updateSession(sessionId, { labels: changes });
    },
    onSuccess: (updated) => overlayLabelsIntoCaches(queryClient, updated.id, updated.labels ?? {}),
  });
}

/**
 * Labels for a session not created yet: the project's defaults plus this
 * session's edits. Removing a default only leaves it off this session.
 *
 * @param projectDefaults - The selected project's default labels, `{}` without one.
 * @param projectName - The selected project; switching it forgets removed defaults.
 */
export function useNewSessionLabels(projectDefaults: Record<string, string>, projectName: string) {
  const [edits, setEdits] = useState<Record<string, string | null>>({});
  useEffect(() => {
    setEdits((prev) => Object.fromEntries(Object.entries(prev).filter(([, v]) => v !== null)));
  }, [projectName]);
  const resolved = useMemo(
    () => newSessionLabels(projectDefaults, edits),
    [projectDefaults, edits],
  );
  return {
    ...resolved,
    setLabel: (key: string, value: string) => setEdits((prev) => ({ ...prev, [key]: value })),
    removeLabel: (key: string) =>
      setEdits((prev) => {
        const rest = Object.fromEntries(Object.entries(prev).filter(([k]) => k !== key));
        return key in projectDefaults ? { ...rest, [key]: null } : rest;
      }),
    reset: () => setEdits({}),
  };
}
