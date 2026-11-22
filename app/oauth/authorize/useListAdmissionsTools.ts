import { useCallback } from "react";

/** The admissions tool list the consent screen names. This copy ships no
 *  admissions toolset, so the list is always empty. A deployment that adds
 *  one returns its MCP list action here, as /api/mcp does. */
export function useListAdmissionsTools(): (
  args: Record<string, never>,
) => Promise<{ name: string }[]> {
  return useCallback(async () => [], []);
}
