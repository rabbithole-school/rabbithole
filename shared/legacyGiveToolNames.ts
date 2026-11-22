/**
 * The five aide verbs that folded into `give` (TRA-573). An MCP client lists
 * tools once and may call a name it listed before the fold; both the HTTP
 * connector (app/api/mcp/toolRoute.ts) and the Convex dispatcher
 * (convex/lib/assignmentTools.ts resolveToolWithLegacyGive) map such a call
 * onto `give`, so it gets give's questions and can never bypass them.
 *
 * Compatibility for long-lived MCP clients; remove after 2026-12-01.
 */
export const LEGACY_GIVE_TOOL_NAMES = [
  "assign_activity_now",
  "push_activity_now",
  "schedule_activity",
  "dispatch_activity",
  "assign_unit",
] as const;

export function isLegacyGiveToolName(name: string): boolean {
  return (LEGACY_GIVE_TOOL_NAMES as ReadonlyArray<string>).includes(name);
}
