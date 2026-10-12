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
 * ONE home for that rule. `listForLauncher` renders it, and the launch-time
 * gates (`webActivitySessions.start`, `scholarApps.credentialsForApp`,
 * `deviceAppUnlock.requireAuthorizedNativeTile`) enforce it, so "I can see the
 * tile" and "I can open the tile" cannot drift apart.
 * They did: both web gates predated bulk grants and keyed off a per-scholar
 * `scholarApps` row alone, so an app a scholar gets ONLY through an
 * `appAudiences` grant — the normal case now, since a grant is never fanned out
 * into per-scholar rows — launched with `App not available to you` (no session,
 * no capture, no saved-login autofill) while its tile sat on the launcher.
 *
 * A `source:"grant"` row is visibility-NEUTRAL (§5): it exists only to park a
 * credential, so it never shows a tile on its own and never authorises a launch
 * on its own — the live grant does both.
 *
 * ── THE THREE AUTHORITIES, AND WHY `pushed` IS REQUIRED ───────────────────
 *
 * A scholar may reach an app because of a direct row, a standing audience
 * GRANT, or a live PUSH (a teacher opening a block's app for the class —
 * `livePushedAppIdsForScholar`). The push is an authority in its own right:
 * a block-scoped `schedulePlacements` push is the school's NORMAL way to put
 * a managed native app in front of a class (the 2026-09-02 ruling), and a
 * standing grant is the outlier we deliberately delete.
 *
 * `pushed` is a REQUIRED argument rather than one defaulting to `false`
 * because the push term used to be each caller's job to remember with a local
 * `||`, and three of the five call sites forgot: the launcher tile, the web
 * launch gate, and the credential autofill all answered "no" for an app a
 * live push was showing. Only the native launch gate had it. That asymmetry
 * was invisible for a month because Photography also carried a standing group
 * grant, which made the tile appear for a reason unrelated to the push; when
 * the grant was (correctly) deleted on 2026-09-15 the class lost its tile
 * mid-lesson on 2026-09-17 while the Now card — the one surface that DID
 * consult the push — kept working, and the iPad's MDM allowlist (which unions
 * granted-or-pushed) kept the bundle open the whole time.
 *
 * Requiring the argument means a new consumer cannot reproduce that by
 * omission: it must answer the push question or fail to compile. The one
 * caller that passes a literal `false` is `grantedManagedAppKeysForScholar`,
 * which is the GRANTED half of a union whose caller adds the pushed half.
 *
 * ── CLOCK: a pushed answer IS time-dependent, so a reactive caller needs a
 * cache-buster ────────────────────────────────────────────────────────────
 *
 * This predicate itself is pure — the caller supplies `pushed`. But resolving
 * `pushed` is NOT clock-free, and an earlier draft of this comment claimed it
 * was. `isPushShowing` -> `isFocusShowing` shows a focus while `setAt` is
 * TODAY **or** `endsAt` is still future (shared/focusShowing.ts), so an
 * uncleared push stops showing at the institution-local DAY boundary with no
 * database write. A reactive Convex query has nothing to invalidate on there
 * (`Date.now()` is not a dependency), so every reactive consumer threads the
 * minute-rounded `now` cache-buster that `pushes.livePushesForMe` established
 * — `scholarApps.listForLauncher`, `scholarApps.credentialsForApp` and
 * `managedDeviceClaims.listManagedDevices` (the staff device table's
 * reachable-apps column) all do. A
 * MUTATION gate (`webActivitySessions.start`,
 * `deviceAppUnlock.requireAuthorizedNativeTile`) runs fresh and needs none,
 * and the fleet projection is driven by a cron rather than a subscription,
 * which is why `lib/deviceAppProjection.ts` legitimately takes no clock —
 * do not generalize that to a reactive surface, as this comment once did.
 *
 * What is deliberately NOT gated: an OVERRUN focus (past `endsAt`, same day,
 * uncleared) keeps showing. That is the documented ruling — the card is still
 * on the scholar's plate with Extend/Wrap offered to the teacher, so the tile,
 * the launch gates and the allowlist must agree with it rather than fail
 * closed under a visible affordance. `autoClearPush` stamps `clearedAt` at the
 * window's end (plus the #3849 grace), which is what actually ends it.
 *
 * ── `nowMs`: a direct add can END (TRA-444) ────────────────────────────────
 *
 * The direct-row term is clocked too: a row opened "all day today" or "until"
 * a date carries `expiresAt` and grants nothing from that instant on
 * (`directLinkGrantsApp`). `nowMs` is required for the same reason `pushed`
 * is: a caller that omitted it would keep an ended grant open, which is the
 * never-ending grant the ruling exists to prevent. Pass the SERVER clock, as
 * the push term does; a subscribed caller re-arms on its minute-rounded `now`
 * argument, and `scholarApps.expireDirectGrant`'s write at `expiresAt`
 * invalidates every subscription that read the row.
 */
export function launcherShowsApp(args: {
  link:
    | Pick<Doc<"scholarApps">, "enabled" | "source" | "expiresAt">
    | null
    | undefined;
  granted: boolean;
  /** Is a live push showing this app to this scholar right now? */
  pushed: boolean;
  /** The server clock the direct row's end is judged at. */
  nowMs: number;
}): boolean {
  // An authority-level "use this, now" (grant or push) outranks a disabled
  // direct row, exactly as `granted` always has.
  if (args.granted || args.pushed) return true;
  return directLinkGrantsApp(args.link, args.nowMs);
}

/**
 * Does the scholar's own `scholarApps` row give them the app at `nowMs`?
 *
 * A DIRECT add (`manual` or `default`), switched on, and not past its end. A
 * `grant` row is visibility-neutral: it parks a login for an audience grant
 * and never grants on its own (§5).
 *
 * `expiresAt` is the one clock on the row (TRA-444). A row past it is ABSENT
 * here, from its first millisecond, whether or not `expireDirectGrant` has
 * deleted it yet. The tile, the launch gates, the autofill, the allowlist and
 * the device console reach this through `launcherShowsApp`; the scholar's
 * Apps panel (`scholarApps.listForScholar`) drops an ended row with
 * `directLinkHasEnded`. Reads that only list rows — `enablementForApp`,
 * `coreListAppsWithAudiences` and the aide's `coreGetAppAccess` in
 * convex/appAudiences.ts, and `liveReachOfExternalApp` — decide no access,
 * and agree once the expiry has removed the row.
 */
function directLinkGrantsApp(
  link: Pick<Doc<"scholarApps">, "enabled" | "source" | "expiresAt"> | null | undefined,
  nowMs: number,
): boolean {
  if (!link || !link.enabled) return false;
  if (link.source !== "manual" && link.source !== "default") return false;
  return !directLinkHasEnded(link, nowMs);
}

/** Has this row reached its end? Separate from being switched off: the
 *  scholar's Apps panel still lists a switched-off add (to switch back on),
 *  but never one that has ended. */
export function directLinkHasEnded(
  link: Pick<Doc<"scholarApps">, "expiresAt">,
  nowMs: number,
): boolean {
  return link.expiresAt !== undefined && nowMs >= link.expiresAt;
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
