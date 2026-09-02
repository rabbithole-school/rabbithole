// Shared resolver for BULK External-App grants (appAudiences). An audience is a
// scholarGroup or an institution; a grant is a join from a catalog app to one of
// those. A scholar's launcher is the read-time UNION of every enabled grant that
// covers them (their institution + each group they're in) plus their direct
// `scholarApps` rows. Nothing is fanned out into per-scholar rows, so membership
// churn resolves automatically. See review/bulk-external-apps-plan.html §4–5.

import type { Doc, Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import { scholarInstitutionId } from "./scholarEnrollment";

/** Per-app provenance for one scholar — which groups grant it, and whether it's
 *  granted school-wide. Derived at read time, never stored (so it can't go stale
 *  on membership churn). */
export type ScholarGrantProvenance = {
  groups: { id: Id<"scholarGroups">; name: string; emoji: string | null }[];
  institution: boolean;
};

/**
 * The externalApp ids GRANTED to a scholar via audiences: every enabled
 * `appAudiences` row targeting their institution or any scholarGroup they
 * belong to. Lean (ids only) — the launcher unions this with the scholar's
 * direct `scholarApps` rows.
 */
export async function grantedAppIdsForScholar(
  ctx: QueryCtx,
  scholar: Doc<"users">,
): Promise<Set<Id<"externalApps">>> {
  const granted = new Set<Id<"externalApps">>();

  // Institution grant (a learner has exactly one scholar membership).
  const institutionId = await scholarInstitutionId(ctx, scholar._id);
  if (institutionId) {
    const instId = String(institutionId);
    const instGrants = await ctx.db
      .query("appAudiences")
      .withIndex("by_audience", (q) =>
        q.eq("audienceKind", "institution").eq("audienceId", instId),
      )
      .collect();
    for (const g of instGrants) if (g.enabled) granted.add(g.appId);
  }

  // Group grants — a scholar may be in several pods. `scholarGroups.scholarIds`
  // is an array (no index), so scan every group and keep the ones they're in;
  // group counts are small (teacher pods) and Convex keeps this live as
  // membership changes.
  const groups = await ctx.db.query("scholarGroups").collect();
  for (const grp of groups) {
    if (!grp.scholarIds.includes(scholar._id)) continue;
    const groupGrants = await ctx.db
      .query("appAudiences")
      .withIndex("by_audience", (q) =>
        q.eq("audienceKind", "group").eq("audienceId", String(grp._id)),
      )
      .collect();
    for (const g of groupGrants) if (g.enabled) granted.add(g.appId);
  }

  return granted;
}

/**
 * Full per-app grant provenance for one scholar (which groups grant each app,
 * and whether it's granted school-wide), for the teacher panel's "via Geckos" /
 * "School-wide" labels. Keyed by `String(appId)`.
 */
export async function grantProvenanceForScholar(
  ctx: QueryCtx,
  scholar: Doc<"users">,
): Promise<Map<string, ScholarGrantProvenance>> {
  const out = new Map<string, ScholarGrantProvenance>();
  const ensure = (appId: Id<"externalApps">): ScholarGrantProvenance => {
    const key = String(appId);
    let entry = out.get(key);
    if (!entry) {
      entry = { groups: [], institution: false };
      out.set(key, entry);
    }
    return entry;
  };

  const institutionId = await scholarInstitutionId(ctx, scholar._id);
  if (institutionId) {
    const instGrants = await ctx.db
      .query("appAudiences")
      .withIndex("by_audience", (q) =>
        q
          .eq("audienceKind", "institution")
          .eq("audienceId", String(institutionId)),
      )
      .collect();
    for (const g of instGrants) if (g.enabled) ensure(g.appId).institution = true;
  }

  const groups = await ctx.db.query("scholarGroups").collect();
  for (const grp of groups) {
    if (!grp.scholarIds.includes(scholar._id)) continue;
    const groupGrants = await ctx.db
      .query("appAudiences")
      .withIndex("by_audience", (q) =>
        q.eq("audienceKind", "group").eq("audienceId", String(grp._id)),
      )
      .collect();
    for (const g of groupGrants) {
      if (!g.enabled) continue;
      ensure(g.appId).groups.push({
        id: grp._id,
        name: grp.name,
        emoji: grp.emoji ?? null,
      });
    }
  }

  return out;
}

/**
 * Is this app on the scholar's launcher — i.e. may they OPEN it?
 *
 * ONE home for that rule. `listForLauncher` renders it, and the two launch-time
 * gates (`webActivitySessions.start`, `scholarApps.credentialsForApp`) enforce
 * it, so "I can see the tile" and "I can open the tile" cannot drift apart.
 * They did: both gates predated bulk grants and keyed off a per-scholar
 * `scholarApps` row alone, so an app a scholar gets ONLY through an
 * `appAudiences` grant — the normal case now, since a grant is never fanned out
 * into per-scholar rows — launched with `App not available to you` (no session,
 * no capture, no saved-login autofill) while its tile sat on the launcher.
 *
 * A `source:"grant"` row is visibility-NEUTRAL (§5): it exists only to park a
 * credential, so it never shows a tile on its own and never authorises a launch
 * on its own — the live grant does both.
 */
export function launcherShowsApp(args: {
  link: Pick<Doc<"scholarApps">, "enabled" | "source"> | null | undefined;
  granted: boolean;
}): boolean {
  if (args.granted) return true;
  const { link } = args;
  return (
    !!link && link.enabled && (link.source === "manual" || link.source === "default")
  );
}

/**
 * Does an enabled grant cover this scholar for this app? Used by setCredentials
 * to decide whether to lazily materialise a `source:"grant"` scholarApps row so
 * a per-scholar login can be parked for a group-granted app.
 */
export async function scholarHasGrantForApp(
  ctx: QueryCtx,
  scholar: Doc<"users">,
  appId: Id<"externalApps">,
): Promise<boolean> {
  const granted = await grantedAppIdsForScholar(ctx, scholar);
  return granted.has(appId);
}
