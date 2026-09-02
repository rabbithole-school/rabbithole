/**
 * LLM spend circuit breaker — a backstop for PUBLIC non-prod deployments.
 *
 * The rhtest staging server is public and `/dev-login` lets anyone sign in as a
 * scholar or teacher, so a stranger could sit on the tutor chat and burn real
 * Anthropic tokens. This caps that: when AI spend in the trailing window exceeds
 * a dollar budget, the expensive HTTP entry points refuse further calls with a
 * friendly 429 until the window rolls off (the nightly db:reset also wipes
 * `usageEvents`, so the running total zeroes out every night anyway).
 *
 * INERT UNLESS `LLM_DAILY_BUDGET_USD` IS SET. Production has
 * no such env var, so this never throttles real students/teachers — the guard
 * short-circuits to "allowed" the moment the cap is absent or unparseable.
 *
 * Spend is derived from the SAME `usageEvents` rows + `PRICING` rate card the
 * weekly cost report uses (convex/lib/usageReport.ts), so the cap is real
 * dollars, not a token proxy. Caveat: `usageEvents` is written fire-and-forget
 * AFTER each call completes, so the running total lags by the in-flight calls —
 * fine for a sustained-abuse backstop (a burst can overshoot by a few calls,
 * not by thousands of dollars).
 *
 * Enforced at the three logged-in-rando-reachable cost paths in http.ts:
 *   • /project-stream  (the tutor chat — the dominant cost)
 *   • /aide-stream     (the staff aide + Curriculum Bot)
 *   • /analyze         (observer analysis)
 */
import { internalQuery } from "./_generated/server";
import type { ActionCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import { costOf } from "./lib/usageReport";

// Trailing window the cap is measured over. A rolling 24h (rather than
// "since midnight") bounds spend across any 24h span, robust to a skipped
// nightly reset.
const WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * The configured daily budget in USD, or `null` when disabled. `null` (env var
 * unset / non-positive / unparseable) means "no circuit breaker" — the state on
 * prod and normal dev deployments.
 */
export function llmBudgetUsd(): number | null {
  const raw = process.env.LLM_DAILY_BUDGET_USD;
  if (!raw) return null;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * Total AI spend (USD) recorded in the trailing window, priced with the same
 * rate card as the cost report. Only ever called when the budget is enabled, so
 * on prod this query is never invoked; on the test server `usageEvents` is small
 * (wiped nightly), so the scan is cheap.
 */
export const spendInWindowUsd = internalQuery({
  args: {},
  handler: async (ctx): Promise<number> => {
    const since = Date.now() - WINDOW_MS;
    const rows = await ctx.db
      .query("usageEvents")
      .withIndex("by_createdAt", (q) => q.gte("createdAt", since))
      .collect();
    let cost = 0;
    for (const row of rows) cost += costOf(row.model, row);
    return cost;
  },
});

/**
 * The guard the HTTP entry points call before doing any LLM work. Returns the
 * exceeded cap (a positive USD number) when spending should be blocked, or
 * `null` when the call is allowed (budget disabled, or still under the cap).
 */
export async function llmBudgetExceeded(
  ctx: ActionCtx,
): Promise<number | null> {
  const cap = llmBudgetUsd();
  if (cap === null) return null; // disabled → always allowed (prod path)
  const spent = await ctx.runQuery(internal.llmBudget.spendInWindowUsd, {});
  return spent >= cap ? cap : null;
}

/** Friendly message shown when the breaker trips. */
export function llmBudgetMessage(cap: number): string {
  return (
    `This test server has hit its AI spending cap (about $${cap} per day) and ` +
    `has paused AI replies to keep costs in check. It resets automatically — ` +
    `try again later.`
  );
}
