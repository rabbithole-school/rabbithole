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

import type { QueryCtx } from "../_generated/server";
import type { Doc, Id } from "../_generated/dataModel";
import { ROLES } from "./roles";
import { openAppPushesForInstitution } from "./deviceAppProjection";
import { isPushShowing } from "./pushes";

type ExternalAppReadCtx = { db: QueryCtx["db"] };

/** Every scholar the app can currently reach, via live grants (never install
 *  intent — intent goes stale the moment another tool widens access via
 *  scholarApps/appAudiences without touching installScholarIds/installGroupIds).
 *  Only ids resolving to a LIVE scholar doc are counted, so a deleted or
 *  role-changed grantee contributes nothing (a stale id must not cause a
 *  permanent false not_found). */
export async function liveReachOfExternalApp(
  ctx: ExternalAppReadCtx,
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

/**
 * Every scholar whose iPad may currently hold the app: `liveReachOfExternalApp`
 * (grants) plus the audience of every SHOWING app push for it. Used ONLY to
 * choose whose devices to re-mark when the app is archived or its managed
 * identity changes (TRA-435) — a scholar whose only route is a teacher's focus
 * or a schedule block's push has the app in the allowlist with no grant at all.
 *
 * Never use this for tenancy (`externalAppWithinLens`, the catalog write
 * gate): a push writer does not check which school's app it pushes, and push
 * reach follows the bell schedule, so another school's live push would hand it
 * edit rights to an app this school depends on. Re-marking an extra device is
 * harmless; widening who may edit is not.
 *
 * Pushes are read through the one push reader (`openAppPushesForInstitution`)
 * and judged by `isPushShowing`, the test the scholar's tile uses, so a stale
 * open row from a past day reaches nobody. `nowMs` comes from the calling
 * mutation (T11). A push never crosses a school, so each audience is bounded
 * to the push's own.
 */
export async function deviceReachOfExternalApp(
  ctx: ExternalAppReadCtx,
  appId: Id<"externalApps">,
  nowMs: number,
): Promise<Set<Id<"users">>> {
  const reach = await liveReachOfExternalApp(ctx, appId);
  for (const institution of await ctx.db.query("institutions").collect()) {
    const { pushes, clock } = await openAppPushesForInstitution(ctx, institution._id, nowMs);
    for (const push of pushes) {
      if (push.target.kind !== "app" || push.target.externalAppId !== appId) continue;
      if (!isPushShowing(push, clock)) continue;
      await addPushAudience(ctx, push, reach);
    }
  }
  return reach;
}

/** Add every live scholar a push's audience covers, inside the push's school
 *  (the boundary `pushCoversScholar` enforces). */
async function addPushAudience(
  ctx: ExternalAppReadCtx,
  push: Doc<"pushes">,
  reach: Set<Id<"users">>,
): Promise<void> {
  const addIfOwnSchool = async (id: Id<"users">) => {
    const member = await ctx.db.get(id);
    if (
      member &&
      member.role === ROLES.SCHOLAR &&
      member.institutionId === push.institutionId
    ) {
      reach.add(id);
    }
  };
  const audience = push.audience;
  switch (audience.kind) {
    case "institution": {
      const members = await ctx.db
        .query("users")
        .withIndex("by_institution", (q) => q.eq("institutionId", push.institutionId))
        .collect();
      for (const m of members) if (m.role === ROLES.SCHOLAR) reach.add(m._id);
      return;
    }
    case "group": {
      const group = await ctx.db.get(audience.groupId);
      for (const id of group?.scholarIds ?? []) await addIfOwnSchool(id);
      return;
    }
    case "scholars":
      for (const id of audience.scholarIds) await addIfOwnSchool(id);
      return;
    case "assignment": {
      const assignment = await ctx.db.get(audience.assignmentId);
      for (const id of assignment?.scholarIds ?? []) await addIfOwnSchool(id);
      return;
    }
  }
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
  ctx: ExternalAppReadCtx,
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
