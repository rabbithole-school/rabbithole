// Shared "who does a catalog app currently reach, and is that reach contained
// inside my institution lens" logic for the `externalApps` catalog.
//
// This is security-critical and was mutation-tested (#2456). It was extracted
// VERBATIM from convex/customApps.ts (`liveReachOfApp` / `appIsWithinLens`) so a
// SECOND consumer — the catalog write gate in convex/externalApps.ts
// (coreUpdateApp / coreSetArchived) — can share exactly the same reach
// containment rule instead of re-deriving it and drifting. The reach
// computation was always keyed on `externalAppId`, so it generalizes cleanly
// from a `customApps` row to a bare `Id<"externalApps">`.
//
// The doctrine: you may mutate a catalog app iff every scholar it CURRENTLY
// REACHES is inside your institution lens — or it reaches nobody and you created
// it. See review/external-apps-launcher.html and the #2456 write-up.

import type { MutationCtx } from "../_generated/server";
import type { Id } from "../_generated/dataModel";
import { ROLES } from "./roles";

/** Every scholar the app can currently reach, via live grants (never install
 *  intent — intent goes stale the moment another tool widens access via
 *  scholarApps/appAudiences without touching installScholarIds/installGroupIds).
 *  Only ids resolving to a LIVE scholar doc are counted, so a deleted or
 *  role-changed grantee contributes nothing (a stale id must not cause a
 *  permanent false not_found). */
export async function liveReachOfExternalApp(
  ctx: MutationCtx,
  appId: Id<"externalApps">,
): Promise<Set<Id<"users">>> {
  const reach = new Set<Id<"users">>();

  const addScholar = async (id: Id<"users">) => {
    const member = await ctx.db.get(id);
    if (member && member.role === ROLES.SCHOLAR) reach.add(id);
  };

  // Direct per-scholar grants.
  const direct = await ctx.db
    .query("scholarApps")
    .withIndex("by_app", (q) => q.eq("appId", appId))
    .collect();
  for (const row of direct) {
    if (row.enabled !== true) continue;
    // Mirror the launcher's rule (scholarApps.ts listForScholar): a
    // `grant`-source row is visibility-NEUTRAL — it exists only to park a
    // credential for an audience grant and never shows a tile on its own.
    // Counting it would inflate reach with scholars whose audience grant was
    // since removed (the row is retained on purpose), producing a false
    // not_found for a legitimate teacher. The audience branch below is what
    // makes those scholars reachable, and only while the grant is live.
    if (row.source !== "manual" && row.source !== "default") continue;
    await addScholar(row.scholarId);
  }

  // Bulk audience grants (group + institution), mirroring resolveAudienceMeta's
  // index usage in appAudiences.ts.
  const audiences = await ctx.db
    .query("appAudiences")
    .withIndex("by_app", (q) => q.eq("appId", appId))
    .collect();
  for (const grant of audiences) {
    if (grant.enabled !== true) continue;
    if (grant.audienceKind === "group") {
      const gid = ctx.db.normalizeId("scholarGroups", grant.audienceId);
      if (!gid) continue; // an unresolvable id contributes nothing
      const group = await ctx.db.get(gid);
      if (!group) continue;
      for (const id of group.scholarIds) await addScholar(id);
    } else {
      const iid = ctx.db.normalizeId("institutions", grant.audienceId);
      if (!iid) continue;
      const inst = await ctx.db.get(iid);
      if (!inst) continue;
      const members = await ctx.db
        .query("users")
        .withIndex("by_institution", (q) => q.eq("institutionId", iid))
        .collect();
      for (const m of members) {
        if (m.role === ROLES.SCHOLAR) reach.add(m._id);
      }
    }
  }
  return reach;
}

/** Whether a catalog app falls within the caller's institution scholar lens —
 * the read-side mirror of assertTargetsWithinLens' write-side doctrine. Fail
 * CLOSED: an app the lens cannot see must be invisible to the name scan, not
 * merely un-patched. `allowed === undefined` means the lens was resolved and
 * found the caller unrestricted (a platform admin). Reachability is derived
 * from LIVE grants, not install intent — intent goes stale the moment another
 * tool widens access, and reading it was a cross-tenant hole.
 *
 * `appId === undefined` means a coded app with no catalog row yet: it has no
 * grants and reaches nobody, so it collapses to the zero-reach/creator clause. */
export async function externalAppWithinLens(
  ctx: MutationCtx,
  appId: Id<"externalApps"> | undefined,
  createdBy: Id<"users"> | undefined,
  callerUserId: Id<"users">,
  allowed: Set<Id<"users">> | undefined,
): Promise<boolean> {
  // (a) Unrestricted caller (lens resolved) sees everything.
  if (allowed === undefined) return true;
  const reachable = appId
    ? await liveReachOfExternalApp(ctx, appId)
    : new Set<Id<"users">>();
  // (b) Creator access, NARROWED to zero-reach apps. This clause exists only so
  // an app that reaches no child is still updatable by the person who made it —
  // without it a zero-grant app would be unupdatable by anyone. Once children
  // can reach the app, containment in the CURRENT lens is required and there is
  // no creator bypass. (Andy accepted the broader "creator keeps rights across
  // an institution move" residual on 2026-08-18, but the live-grant rewrite made
  // it unnecessary, so we bound creator access to zero-reach here.)
  if (reachable.size === 0) return createdBy === callerUserId;
  // (c) Otherwise every reachable scholar must be within the lens.
  for (const id of reachable) {
    if (!allowed.has(id)) return false;
  }
  return true;
}
