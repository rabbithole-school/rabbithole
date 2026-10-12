/**
 * A token bucket over the `authRateLimits` table that @convex-dev/auth already
 * ships (`identifier`, `attemptsLeft`, `lastAttemptTime`), with the same
 * refill rule as the library's own failed-sign-in limiter
 * (node_modules/@convex-dev/auth/.../implementation/rateLimit.js): the
 * bucket holds `max` tokens and refills continuously at `max` per `windowMs`.
 *
 * Callers namespace `identifier` with a prefix ("magic-link-request:…") so a
 * bucket never collides with the library's per-email failed-verification
 * rows.
 *
 * Runs in a mutation, so concurrent takes serialize; there is no race.
 */
import type { MutationCtx } from "../_generated/server";

export async function takeRateToken(
  ctx: MutationCtx,
  identifier: string,
  limit: { max: number; windowMs: number },
  now = Date.now(),
): Promise<boolean> {
  const row = await ctx.db
    .query("authRateLimits")
    .withIndex("identifier", (q) => q.eq("identifier", identifier))
    .unique();
  if (!row) {
    await ctx.db.insert("authRateLimits", {
      identifier,
      attemptsLeft: limit.max - 1,
      lastAttemptTime: now,
    });
    return true;
  }
  const elapsed = Math.max(0, now - row.lastAttemptTime);
  const available = Math.min(
    limit.max,
    row.attemptsLeft + (elapsed * limit.max) / limit.windowMs,
  );
  if (available < 1) return false;
  await ctx.db.patch(row._id, {
    attemptsLeft: available - 1,
    lastAttemptTime: now,
  });
  return true;
}
