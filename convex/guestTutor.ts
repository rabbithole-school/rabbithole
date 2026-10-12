/**
 * Guest mode's ONLY database surface: the rate-limit counters behind the
 * unauthenticated "try it" exchange (`app/embed/try`, `POST
 * /guest-tutor-stream`). Policy, topics, and the origin allowlist live in
 * `lib/guestTutor.ts`; this file is just the counting.
 *
 * Everything here is internal — an unauthenticated visitor should not be able
 * to reach the Convex client API at all. The HTTP action is the whole front
 * door.
 *
 * ⚠️ `claimGuestTurn` runs on EVERY request, not once per conversation. The
 * first version of this file claimed a slot only on the opening turn, and
 * because the conversation lives in the client, a caller who never sent an
 * empty transcript skipped every cap — a free LLM proxy behind a spoofable
 * header. If you are tempted to make this cheaper by skipping continuations,
 * that is the bug you are re-introducing.
 *
 * The other invariants that make guest mode safe to expose: it reads NO
 * scholar data and writes no scholar table, and it stores no message text —
 * not the guest's, not the tutor's. A row here is a salted IP hash (or the
 * literal `global`), a window start, and two integers.
 */

import { v } from "convex/values";
import { internalMutation, type MutationCtx } from "./_generated/server";
import {
  GUEST_GLOBAL_SCOPE,
  GUEST_GLOBAL_WINDOW_MS,
  GUEST_IP_WINDOW_MS,
  GUEST_ROW_TTL_MS,
  GUEST_SESSIONS_PER_DAY_GLOBAL,
  GUEST_SESSIONS_PER_IP_PER_HOUR,
  GUEST_TURNS_PER_DAY_GLOBAL,
  GUEST_TURNS_PER_IP_PER_HOUR,
} from "./lib/guestTutor";

/**
 * The live counter row for one scope, or null when its window has rolled.
 *
 * A window is a fixed-length bucket anchored at its first request, not a
 * sliding count: one indexed lookup instead of a scan. Two honest costs of
 * that choice, both acceptable for a marketing demo but neither invisible:
 *
 *  - A visitor's allowance refills at a slightly arbitrary minute.
 *  - A caller can burst across a boundary — 32 requests at 59:59 and 32 more
 *    at 00:01. The cap is a blast-radius bound on a bad hour, not a rate
 *    guarantee, and 2x a few dollars is still a few dollars. If that ever
 *    stops being true, a sliding window is the fix, not a smaller number.
 *
 * Concurrency: two simultaneous first-of-window requests for one scope can
 * both read null and both insert, orphaning one count for the rest of the
 * window. Convex mutations are serializable, so OCC should make them conflict
 * and retry rather than interleave; the failure mode if it ever did would be
 * one window counting slightly low, never a cap that stops applying.
 */
async function currentWindow(
  ctx: MutationCtx,
  scope: string,
  nowMs: number,
  windowMs: number,
) {
  const row = await ctx.db
    .query("guestTutorRateLimits")
    .withIndex("by_scope_window", (q) => q.eq("scope", scope))
    .order("desc")
    .first();
  return row && row.windowStartedAt > nowMs - windowMs ? row : null;
}

/**
 * Count this request against the per-IP and global caps, and refuse it if
 * either is spent. Atomic: Convex mutations are serializable, so two visitors
 * racing the last slot of the day cannot both win.
 *
 * `isOpening` distinguishes the two counters. `exchanges` is the number a
 * human recognises ("three tries an hour"); `turns` counts REQUESTS and is the
 * one that actually bounds cost, because a client cannot dodge it by
 * misreporting what kind of turn this is.
 *
 * Returns the reason on refusal so the caller can log which cap bit; the
 * visitor is told the same neutral sentence either way.
 */
export const claimGuestTurn = internalMutation({
  args: {
    ipHash: v.string(),
    topic: v.string(),
    isOpening: v.boolean(),
    nowMs: v.number(),
  },
  returns: v.union(
    v.object({ ok: v.literal(true) }),
    v.object({
      ok: v.literal(false),
      reason: v.union(
        v.literal("ip_exchanges"),
        v.literal("ip_turns"),
        v.literal("global_exchanges"),
        v.literal("global_turns"),
      ),
    }),
  ),
  handler: async (ctx, args) => {
    const ipRow = await currentWindow(
      ctx,
      args.ipHash,
      args.nowMs,
      GUEST_IP_WINDOW_MS,
    );
    if (ipRow) {
      if (ipRow.turns >= GUEST_TURNS_PER_IP_PER_HOUR) {
        return { ok: false as const, reason: "ip_turns" as const };
      }
      if (args.isOpening && ipRow.exchanges >= GUEST_SESSIONS_PER_IP_PER_HOUR) {
        return { ok: false as const, reason: "ip_exchanges" as const };
      }
    }

    const globalRow = await currentWindow(
      ctx,
      GUEST_GLOBAL_SCOPE,
      args.nowMs,
      GUEST_GLOBAL_WINDOW_MS,
    );
    if (globalRow) {
      if (globalRow.turns >= GUEST_TURNS_PER_DAY_GLOBAL) {
        return { ok: false as const, reason: "global_turns" as const };
      }
      if (
        args.isOpening &&
        globalRow.exchanges >= GUEST_SESSIONS_PER_DAY_GLOBAL
      ) {
        return { ok: false as const, reason: "global_exchanges" as const };
      }
    }

    // Both caps have room: charge the request to each window, opening a fresh
    // one where the last has rolled.
    const bump = async (
      row: typeof ipRow,
      scope: string,
      topic: string | undefined,
    ) => {
      if (row) {
        await ctx.db.patch(row._id, {
          turns: row.turns + 1,
          exchanges: row.exchanges + (args.isOpening ? 1 : 0),
        });
        return;
      }
      await ctx.db.insert("guestTutorRateLimits", {
        scope,
        windowStartedAt: args.nowMs,
        turns: 1,
        exchanges: args.isOpening ? 1 : 0,
        ...(topic ? { topic } : {}),
      });
    };
    await bump(ipRow, args.ipHash, args.topic);
    await bump(globalRow, GUEST_GLOBAL_SCOPE, undefined);
    return { ok: true as const };
  },
});

/**
 * Delete counter rows past their window. Run daily (`convex/crons.ts`).
 *
 * A row older than GUEST_ROW_TTL_MS cannot influence any decision, so keeping
 * it would be retention for its own sake — and the promise guest mode makes is
 * that nothing outlives the exchange but a day of counters. Capped per run so
 * one tick can never be an unbounded delete; the cron catches up tomorrow.
 */
export const purgeGuestRateLimits = internalMutation({
  args: { nowMs: v.optional(v.number()) },
  returns: v.object({ deleted: v.number() }),
  handler: async (ctx, args) => {
    const now = args.nowMs ?? Date.now();
    const stale = await ctx.db
      .query("guestTutorRateLimits")
      .withIndex("by_window", (q) =>
        q.lt("windowStartedAt", now - GUEST_ROW_TTL_MS),
      )
      .take(2000);
    for (const row of stale) {
      await ctx.db.delete(row._id);
    }
    return { deleted: stale.length };
  },
});
