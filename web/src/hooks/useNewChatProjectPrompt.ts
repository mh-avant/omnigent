import { useCallback } from "react";

import { useProjects } from "@/hooks/useConversations";
import { readNewChatProjectPromptEnabled } from "@/lib/newChatProjectPromptPreferences";

/**
 * Returns a check for whether starting a new session should first ask for a
 * project: at least one project exists and the prompt isn't turned off in
 * Settings. The preference is read at call time so a toggle applies at once.
 */
export function useShouldPromptForProject(): () => boolean {
  const { data: projects = [] } = useProjects();
  const hasProjects = projects.length > 0;
  return useCallback(() => hasProjects && readNewChatProjectPromptEnabled(), [hasProjects]);
}
