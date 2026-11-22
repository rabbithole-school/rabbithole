// Tool search for the staff aide: rarely used tools stay out of the prompt
// until the model searches for them.
//
// The aide carries well over a hundred tools. Most turns need a handful, and a
// long list of look-alike schedule editors pulls the model toward the wrong
// one (a "give this homework" request reaching for `place_class`). Anthropic's
// tool search lets us keep those tools callable while leaving their schemas
// out of context: each one is sent with `defer_loading: true`, and the server
// tool `tool_search_tool_bm25` loads a deferred schema only when the model
// searches for it.
//
// Caching: deferred schemas are not rendered into the prompt prefix, and a
// search appends the loaded schema to the conversation rather than changing
// `tools`, so the tools → system prefix is byte-identical turn to turn. The
// list below is a fixed constant and `withToolSearch` preserves tool order, so
// nothing here can make the prefix vary.
//
// Runs only in the aide loops (`aideStream.ts`). The MCP connector lists its
// own tools and MCP clients choose their own loading, so it is untouched.

import type { AideTool, AideTools } from "./aideStream";

/**
 * Tools the aide sends with `defer_loading: true`. One list, so the reason for
 * each family lives in one place.
 *
 * - Weekly timetable editors (`place_class`, `move_class`, `shift_class`,
 *   `update_class`, `remove_class`, `reassign_teacher`) and the bell-schedule
 *   editors (`create_schedule_block`, `update_schedule_block`,
 *   `remove_schedule_block`): prod data from 2026-11-08 shows the timetable and
 *   bell schedule are edited only at term setup (2 edits since August). They
 *   stay available for that, and stay out of the way of `give` the rest of
 *   the year.
 * - `dismiss_flag`: clears a master-schedule conflict flag, which only comes
 *   up while someone is already editing the timetable.
 *
 * Deliberately NOT deferred: `give`, `get_schedule`, `clear_activity`,
 * `get_master_schedule`, `list_terms`, scholar reads and curriculum tools.
 * Those are everyday tools, and the read tools are how the model finds out a
 * schedule edit is needed in the first place.
 *
 * A name with no matching tool is ignored, so a tool can be removed elsewhere
 * without breaking this list.
 */
export const AIDE_DEFERRED_TOOLS: ReadonlySet<string> = new Set([
  "place_class",
  "move_class",
  "shift_class",
  "update_class",
  "remove_class",
  "reassign_teacher",
  "dismiss_flag",
  "create_schedule_block",
  "update_schedule_block",
  "remove_schedule_block",
]);

/** The server-side search tool. Never deferred itself (the API 400s). */
export const AIDE_TOOL_SEARCH_TOOL = {
  type: "tool_search_tool_bm25_20251119",
  name: "tool_search_tool_bm25",
} as const;

function toolName(tool: AideTools[number]): string | undefined {
  return "name" in tool ? (tool as AideTool).name : undefined;
}

/**
 * Mark the deferred tools and add the search tool. Returns `tools` unchanged
 * when none of them is present (the parent aide, unit designer, bake loop), so
 * those requests stay byte-identical, and when deferring would leave no loaded
 * tool, which the API rejects with a 400.
 */
export function withToolSearch(
  tools: AideTools,
  deferred: ReadonlySet<string> = AIDE_DEFERRED_TOOLS,
): AideTools {
  const isDeferred = (tool: AideTools[number]) => {
    const name = toolName(tool);
    return name !== undefined && deferred.has(name);
  };
  const deferredCount = tools.filter(isDeferred).length;
  if (deferredCount === 0 || deferredCount === tools.length) return tools;
  if (tools.some((tool) => toolName(tool) === AIDE_TOOL_SEARCH_TOOL.name)) {
    return tools;
  }
  return [
    ...tools.map((tool) =>
      isDeferred(tool) ? { ...tool, defer_loading: true } : tool,
    ),
    AIDE_TOOL_SEARCH_TOOL,
  ] as AideTools;
}
