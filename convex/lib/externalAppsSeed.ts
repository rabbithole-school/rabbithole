// Shared helper for seeding a scholar's default External Apps.
//
// Called from every scholar-creation path (users.createScholar /
// adminCreateUser / registerWithCode) and from the one-shot backfill, so
// "every new scholar gets the default apps" holds no matter how the
// account was made. Plain async helper (not a Convex function) so it can
// run inside any mutation handler. Idempotent.
//
// NOTE: as of the prior default provider's retirement there are currently NO default
// apps (it is no longer flagged `defaultForNewScholars`), so
// this is a no-op until some future app is flagged default.
//
// See review/external-apps-launcher.html §3.

import type { MutationCtx } from "../_generated/server";
import type { Id } from "../_generated/dataModel";

/**
 * Link every non-archived `defaultForNewScholars` catalog app to the
 * scholar that isn't already linked. Returns how many were added.
 */
export async function seedDefaultAppsForScholar(
  ctx: MutationCtx,
  scholarId: Id<"users">,
  addedBy?: Id<"users">,
): Promise<number> {
  const defaults = await ctx.db
    .query("externalApps")
    .withIndex("by_default", (q) => q.eq("defaultForNewScholars", true))
    .collect();
  let added = 0;
  for (const app of defaults) {
    if (app.archived) continue;
    const existing = await ctx.db
      .query("scholarApps")
      .withIndex("by_scholar_app", (q) =>
        q.eq("scholarId", scholarId).eq("appId", app._id),
      )
      .first();
    if (existing) continue;
    await ctx.db.insert("scholarApps", {
      scholarId,
      appId: app._id,
      enabled: true,
      source: "default",
      addedBy,
    });
    added++;
  }
  return added;
}
