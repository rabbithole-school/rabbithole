// Does a scholar already have a stored PIN? One probe, one truth.
//
// Scholars sign in with a username + PIN, backed by a Convex-Auth `authAccounts`
// row for the `password` provider (the redeem action writes the hashed PIN
// there — see convex/enrollment.ts). Presence of that row is the ONLY fact the
// UI needs to decide whether the school leader is about to "Create PIN" (no
// credential yet) or "Reset PIN" (they already have one).
//
// Returns a BOOLEAN only — never the secret. Indexed single-row lookup
// (`userIdAndProvider`), so it's cheap to fold into a per-scholar roster map.
// Deliberately the SAME probe `enrollment.prepareScholarForEnroll` uses to
// choose create-vs-modify, so the button label can never drift from what
// redeeming the link actually does.

import type { QueryCtx, MutationCtx } from "../_generated/server";
import type { Id } from "../_generated/dataModel";

export async function scholarHasPasswordCredential(
  ctx: QueryCtx | MutationCtx,
  userId: Id<"users">,
): Promise<boolean> {
  const account = await ctx.db
    .query("authAccounts")
    .withIndex("userIdAndProvider", (q) =>
      q.eq("userId", userId).eq("provider", "password"),
    )
    .first();
  return account !== null;
}
