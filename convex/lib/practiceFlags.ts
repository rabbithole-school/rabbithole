/**
 * The practice-flag read model: the one place a query asks "which of this
 * scholar's nodes carry an open practice flag (the orange "Check in")?".
 *
 * Today a flag opens only on a recurring classified error pattern
 * (lib/practice/errorFlags.ts). Every reader — the math-skills matrix, the
 * skills map, the node drawer, Teacher Today, the knowledge-state read,
 * auto-remediation — sits behind this function (or `practiceFlagsFromEvents`
 * over rows it already holds), so a second opener lands in one place and
 * every surface renders it the same way.
 *
 * TEACHER-ONLY: callers gate on staff before calling; never surface to a
 * scholar or parent.
 */

import type { Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import {
  ERROR_FLAG_WINDOW_MS,
  practiceFlagsFromEvents,
  type OpenPracticeFlag,
} from "./practice/errorFlags";

/**
 * The scholar's open practice flags, most recently reinforced first. Narrow
 * with `domain` and/or `nodeKey`; with neither, every domain is read.
 */
export async function openPracticeFlags(
  ctx: QueryCtx | MutationCtx,
  scholarId: Id<"users">,
  scope: { domain?: string; nodeKey?: string },
  now: number,
): Promise<OpenPracticeFlag[]> {
  const { domain, nodeKey } = scope;
  const events =
    nodeKey !== undefined
      ? (
          await ctx.db
            .query("practiceErrorEvents")
            .withIndex("by_scholar_node", (q) =>
              q.eq("scholarId", scholarId).eq("nodeKey", nodeKey),
            )
            .collect()
        ).filter((e) => domain === undefined || e.domain === domain)
      : domain !== undefined
        ? await ctx.db
            .query("practiceErrorEvents")
            .withIndex("by_scholar_domain_createdAt", (q) =>
              q
                .eq("scholarId", scholarId)
                .eq("domain", domain)
                .gte("createdAt", now - ERROR_FLAG_WINDOW_MS),
            )
            .collect()
        : await ctx.db
            .query("practiceErrorEvents")
            .withIndex("by_scholar", (q) => q.eq("scholarId", scholarId))
            .collect();
  return practiceFlagsFromEvents(events, now);
}
