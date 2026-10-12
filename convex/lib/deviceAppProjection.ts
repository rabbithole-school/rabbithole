/**
 * The managed-app allowlist PROJECTION — one home for "what should this
 * iPad's dedicated MDM profile allow, right now?"
 *
 *   desiredAllowlist(device) = baseline(device)
 *                            ∪ { bundleId(app) : app granted-or-pushed to
 *                                this device's fresh owner right now }
 *
 * The teacher's grant is the ONE authority; the MDM allowlist is an
 * eventually-consistent projection of it. See
 * review/app-access-unification-plan.html §model.
 *
 * ── THE COMPOSITION RULE (two writers, one profile) ───────────────────────
 *
 * Two writers move the same profile for as long as the launch-time unlock
 * ceremony's endpoints exist (the deviceAppUnlock.ts header says which iPad
 * builds still drive them):
 *
 *   • the CEREMONY — `requestUnlock` / `requestLock` in deviceAppUnlock.ts,
 *     driven by an older native client's lease state machine, and
 *   • the PROJECTION — the reconciler in the same file, driven by grants.
 *
 * If they computed different targets they would fight: the projection would
 * strip an app the ceremony just leased, and the ceremony's relock would
 * strip every granted app back to bare baseline. Neither is acceptable while
 * both are live.
 *
 * The fix is that there is exactly ONE target set, computed here, and BOTH
 * writers send it:
 *
 *   • a ceremony unlock PATCHes `projected ∪ {the leased app}`, and the union
 *     adds nothing: its launch gate authorizes the app for the same owner, by
 *     the same granted-or-pushed rule, in the same transaction, so the app is
 *     already in `projected`;
 *   • a ceremony relock PATCHes `projected` instead of bare baseline — so
 *     "relock" now means "converge to the projection", exactly what the plan
 *     calls for;
 *   • the projection PATCHes `projected`.
 *
 * The set reads no lease, and needs no lease term to keep from yanking an
 * app out from under a live handoff: the relock gate keeps a lease open only
 * while its app is in `authorizedManagedAppKeysForClaim`, the set projected
 * here. A lease the gate would keep is already a member; one it would close
 * (an older claim generation, an app its owner may no longer open, an expired
 * lease) adds nothing. So the projection agrees with the gate whichever runs
 * first, with or without a revocation kick. A lease term that checked
 * neither generation nor authorization once let a pass that ran before the
 * gate project a reassigned iPad from the previous scholar's lease (TRA-433).
 *
 * Mutual exclusion between the two writers is the pre-existing
 * `deviceAppUnlockStates.operationToken` lease: whoever holds it owns the
 * next whole-profile PATCH, and the other defers. Nothing here bypasses it.
 *
 * ── WHAT THIS MODULE DELIBERATELY DOES NOT DO ─────────────────────────────
 *
 * It never validates or constructs the baseline (that is
 * `validateBaseline` / `patchProfile` in deviceAppUnlock.ts, whose safety
 * core is untouched) and it never writes. It is a pure read-side derivation
 * so it can be called from inside the same transaction that acquires the
 * operation token — a projected set is never computed in one transaction and
 * spent in another.
 */
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { ROLES } from "./roles";
import {
  grantedAppIdsForScholar,
  grantProvenanceForScholar,
  launcherShowsApp,
} from "./appAudiences";
import {
  MANAGED_NATIVE_APPS,
  managedNativeAppKeyForApp,
  type ManagedNativeAppKey,
} from "./managedNativeApps";
import {
  isPushShowing,
  liveUntil,
  pushCoversScholar,
  pushExpiresAt,
  type FocusClock,
} from "./pushes";
import { groupIdsForScholar } from "./scholarGroupMembership";
import { timeZoneForInstitution } from "./institutionTime";
import { dayKeyForTimezone } from "../../shared/institutionDay";

type DbCtx = QueryCtx | MutationCtx;

/** Whether a catalog app still exists and is not archived — the one
 *  predicate every scholar-facing "what's live/pushed" read must apply so
 *  an archive can't leave two surfaces disagreeing about whether the app is
 *  still authorized. `livePushedAppIdsForScholar` below applies it to the
 *  PUSHED half only: `launcherShowsApp`'s standing half (direct row, grant)
 *  never reads the catalog, so a reader gating on `launcherShowsApp` must
 *  apply this too (TRA-425). A per-app gate gets both from
 *  `scholarAppAccess`, below, instead of pairing them by hand.
 *  `pushes.livePushesForMe` imports it for the "Right now" card rather than
 *  restating it. */
export function catalogAppIsVisible(
  app: Doc<"externalApps"> | null,
): app is Doc<"externalApps"> {
  return !!app && !app.archived;
}

/**
 * The managed-native app keys a scholar is currently GRANTED — the exact
 * generalization of the single-key check the relock gate used to make per
 * lease, answering for every key at once instead of one (the gate now reads
 * this set through `authorizedManagedAppKeysForClaim`).
 *
 * Same predicate, same sources, same order of precedence: for every
 * non-archived catalog app whose `nativeUrlScheme` maps to a managed key,
 * ask `launcherShowsApp` with the scholar's direct `scholarApps` row and
 * whether any enabled audience grant covers them. "I can see the tile" and
 * "the bundle id is in my iPad's allowlist" therefore cannot drift apart,
 * which is the entire point of the inversion.
 *
 * The one deliberate difference from the old per-key helper is efficiency:
 * `grantedAppIdsForScholar` is resolved ONCE per scholar rather than once
 * per candidate app (the old `scholarHasGrantForApp` call re-scanned every
 * group per app). The verdict is identical — `scholarHasGrantForApp` is
 * literally `grantedAppIdsForScholar(...).has(appId)`.
 *
 * These are the keys of `managedAppGrantsForScholar`, below, which also says
 * when each grant ends.
 */
export async function grantedManagedAppKeysForScholar(
  ctx: DbCtx,
  scholarId: Id<"users">,
): Promise<Set<ManagedNativeAppKey>> {
  return new Set((await managedAppGrantsForScholar(ctx, scholarId)).keys());
}

/**
 * The managed-native apps a scholar is currently GRANTED, each with when that
 * grant ends on its own. `endsAt` is the `expiresAt` of a direct add opened
 * for a day or until a date (TRA-444); it is null when a standing authority
 * covers the key (an audience grant, or a direct add with no end). The
 * projector and the relock gate need only the keys
 * (`grantedManagedAppKeysForScholar`); the device console also says when the
 * access it reports will end.
 *
 * Judged at the server clock, like the pushed half, so a direct add stops
 * counting at its `expiresAt` whether or not its expiry job has run yet.
 */
export async function managedAppGrantsForScholar(
  ctx: DbCtx,
  scholarId: Id<"users">,
): Promise<Map<ManagedNativeAppKey, { endsAt: number | null }>> {
  const grants = new Map<ManagedNativeAppKey, { endsAt: number | null }>();
  const scholar = await ctx.db.get(scholarId);
  if (!scholar) return grants;
  const nowMs = Date.now();
  const granted = await grantedAppIdsForScholar(ctx as QueryCtx, scholar);
  // The scholar's direct rows are read ONCE, by scholar, rather than once per
  // candidate catalog app. This runs on a fleet-wide cron — every bound device,
  // every tick — so a per-app indexed lookup multiplied the read count by the
  // size of the catalog for no benefit: `by_scholar_app` is a prefix extension
  // of `by_scholar`, so the same rows come back in one query. Keyed by
  // `String(appId)` to match how the launcher dedupes.
  const links = await ctx.db
    .query("scholarApps")
    .withIndex("by_scholar", (q) => q.eq("scholarId", scholarId))
    .collect();
  // First-wins, matching the `.first()` on `by_scholar_app` this replaces:
  // both indexes order by `_creationTime` within a scholar, so the earliest
  // row is the one the old lookup returned. (A duplicate cannot arise anyway —
  // `coreAddToScholar` re-enables an existing row rather than inserting a
  // second — but the verdict should not depend on that holding.)
  const linkByApp = new Map<string, Doc<"scholarApps">>();
  for (const link of links) {
    const key = String(link.appId);
    if (!linkByApp.has(key)) linkByApp.set(key, link);
  }
  const apps = await ctx.db.query("externalApps").collect();
  for (const app of apps) {
    if (app.archived) continue;
    const key = managedNativeAppKeyForApp(app);
    if (!key) continue;
    const link = linkByApp.get(String(app._id));
    const byAudience = granted.has(app._id);
    // `pushed: false` is deliberate and load-bearing: this helper answers the
    // GRANTED half only, and every caller unions it with
    // `pushedManagedAppKeysForScholar`. Folding pushes in here would
    // double-count them and make the granted/pushed split unreadable.
    if (!launcherShowsApp({ link, granted: byAudience, pushed: false, nowMs })) continue;
    // With no audience grant, the grant rests on the direct add alone, so it
    // ends when that add does.
    const endsAt = byAudience || link?.expiresAt === undefined ? null : link.expiresAt;
    // Two catalog rows can stand for one managed app. The key is granted
    // until the later of their ends, and has no end if either has none.
    const prior = grants.get(key);
    grants.set(key, {
      endsAt:
        prior === undefined
          ? endsAt
          : prior.endsAt === null || endsAt === null
            ? null
            : Math.max(prior.endsAt, endsAt),
    });
  }
  return grants;
}

/**
 * An institution's OPEN app pushes, and the institution clock that
 * `isPushShowing` judges them by at `nowMs` — the one source for "is this app
 * pushed". Both writers land here: a teacher's `makeFocus` (pushes.createFocus)
 * and the master-schedule materializer (a row stamped `schedulePlacementId`).
 *
 * The scholar's term (`livePushedAppIdsForScholar`, below: the tile, the
 * launch gates, the allowlist) and the staff read of "who can use this app"
 * (`appAudiences.aideGetAppAccess`) both start here and both judge with
 * `isPushShowing`. The staff read once found pushes only through
 * `schedulePlacements` and judged them with its own window test, so a
 * teacher's push, or a block's push running past its window, put the app on a
 * tile while that read reported nobody could use it (TRA-426).
 */
export async function openAppPushesForInstitution(
  ctx: DbCtx,
  institutionId: Id<"institutions">,
  nowMs: number,
): Promise<{ pushes: Doc<"pushes">[]; clock: FocusClock }> {
  const open = await ctx.db
    .query("pushes")
    .withIndex("by_institution_cleared", (q) =>
      q.eq("institutionId", institutionId).eq("clearedAt", undefined),
    )
    .collect();
  const timeZone = await timeZoneForInstitution(ctx, institutionId);
  return {
    pushes: open.filter((p) => p.target.kind === "app"),
    clock: { nowMs, todayDayKey: dayKeyForTimezone(nowMs, timeZone), timeZone },
  };
}

/** Of the assignments these pushes target, the ones whose roster currently
 *  contains this scholar: the `assignment` half of a push audience, shared by
 *  every scholar read of pushes (here, and the Now card in pushes.ts).
 *
 *  Driven by the candidate pushes rather than by scanning the scholar's
 *  assignments: `assignments.scholarIds` is an array with no index, and the
 *  table is a growing historical record, while the set of OPEN pushes is small
 *  and bounded by the school day. Tenancy needs no check here: `assignments`
 *  carries no institutionId, but the push itself is institution-stamped
 *  (`pushCoversScholar` refuses a cross-school push), and matching requires
 *  this scholar to be on the roster. */
export async function assignmentIdsCovering(
  ctx: DbCtx,
  scholar: Doc<"users">,
  candidates: ReadonlyArray<Doc<"pushes">>,
): Promise<Id<"assignments">[]> {
  const referenced = new Map<string, Id<"assignments">>();
  for (const push of candidates) {
    if (push.audience.kind === "assignment") {
      referenced.set(
        String(push.audience.assignmentId),
        push.audience.assignmentId,
      );
    }
  }
  if (referenced.size === 0) return [];
  const assignments = await Promise.all(
    [...referenced.values()].map((id) => ctx.db.get(id)),
  );
  return assignments
    .filter(
      (a): a is Doc<"assignments"> =>
        a !== null && a.scholarIds.some((id) => String(id) === String(scholar._id)),
    )
    .map((a) => a._id);
}

/**
 * The live pushes putting each catalog app in front of this scholar right
 * now, grouped by app, and the institution clock they were judged at — the
 * one push lookup behind both readers of a scholar's PUSHED authority,
 * `livePushedAppIdsForScholar` and `scholarAppAccess` below.
 *
 * A push is the school's other "you may use this, now" authority (a teacher
 * opening a block's app for a group), and it is scholar-VISIBLE: FocusStrip
 * renders a live app push as a tappable "Right now" card. So this is the one
 * home for the question, and its consumers must never disagree:
 *
 *   • the ALLOWLIST projection below, which folds these into the device's
 *     desired bundle set ("granted-OR-pushed"), and
 *   • the LAUNCH gates, through `scholarAppAccess` below (the native tap, the
 *     web launch and the autofill), which must not refuse a tap on a card
 *     Rabbithole itself just rendered.
 *
 * Letting those two drift is precisely the incident this program exists to
 * kill: a visible card whose tap fails closed against a door MDM had already
 * opened.
 *
 * WHICH liveness: `isPushShowing`, not `isPushBlocking`. Those came apart
 * upstream — a focus that has run past its `endsAt` but that nobody has
 * wrapped keeps its LABEL (it is still the card on the scholar's plate, with
 * Extend / Wrap offered to the teacher) while losing its WALL. Since the card
 * is still on screen and still tappable, the bundle must still be in the
 * allowlist: gating this on the window instead would put a visible card in
 * front of a scholar whose tap fails, which is the exact defect this whole
 * program exists to remove. An overrun focus therefore keeps its app until a
 * human or the clear job ends it, which is also what the teacher's surface
 * says is happening.
 *
 * Catalog visibility is NOT applied here: each consumer applies
 * `catalogAppIsVisible` to the apps it reads, so a gate asking about one app
 * loads that app's document alone. `clock` is null only for a scholar with no
 * institution, who has no pushes.
 *
 * CLOCK: every push is judged at `nowMs`, and it is returned in `clock`, so a
 * consumer that also needs the time (`scholarAppAccessAt`'s `until`) uses the
 * same instant. `nowMs` is always the SERVER's clock: `livePushedAppIdsForScholar`
 * and `scholarAppAccess` read it themselves, and `scholarAppAccessAt` takes it
 * from server code. A public function's clock argument is the client's, and a
 * gate judged at it would open an app at whatever time the client names (the
 * #4057 review), so none ever reaches here. Do not read that as "push
 * visibility is time-independent": `isFocusShowing` is day-scoped, so an
 * uncleared push stops showing at the institution-local day boundary with no
 * database write. A REACTIVE consumer (`scholarApps.listForLauncher`,
 * `scholarApps.credentialsForApp`, `managedDeviceClaims.listManagedDevices`)
 * must therefore thread the minute-rounded `now` cache-buster to re-run at
 * all, never as a time authority; the fleet cron and the mutation-time gates
 * do not subscribe and need none.
 */
async function livePushesByAppForScholar(
  ctx: DbCtx,
  scholar: Doc<"users">,
  nowMs: number,
): Promise<{
  byApp: Map<Id<"externalApps">, Doc<"pushes">[]>;
  clock: FocusClock | null;
}> {
  const byApp = new Map<Id<"externalApps">, Doc<"pushes">[]>();
  const institutionId = scholar.institutionId;
  if (!institutionId) return { byApp, clock: null };
  const { pushes: open, clock } = await openAppPushesForInstitution(
    ctx,
    institutionId,
    nowMs,
  );
  const appPushes = open.filter((p) => isPushShowing(p, clock));
  if (appPushes.length === 0) return { byApp, clock };
  const audience = {
    scholarId: scholar._id,
    institutionId,
    groupIds: await groupIdsForScholar(ctx as QueryCtx, scholar),
    // Only the assignments the candidate pushes actually reference, resolved
    // the same bounded way `pushes.ts` does — `assignments.scholarIds` is an
    // array with no index, and the table is a growing historical record.
    assignmentIds: await assignmentIdsCovering(ctx, scholar, appPushes),
  };
  for (const push of appPushes) {
    if (push.target.kind !== "app") continue;
    if (!pushCoversScholar(push, audience)) continue;
    const forApp = byApp.get(push.target.externalAppId);
    if (forApp) forApp.push(push);
    else byApp.set(push.target.externalAppId, [push]);
  }
  return { byApp, clock };
}

/**
 * The catalog apps a live push is putting in front of this scholar right now:
 * the apps `livePushesByAppForScholar` groups, less any archived since,
 * matching every other surface. The tile and the allowlist projection's
 * pushed half read this set, at the server clock.
 */
export async function livePushedAppIdsForScholar(
  ctx: DbCtx,
  scholar: Doc<"users">,
): Promise<Set<Id<"externalApps">>> {
  const appIds = new Set<Id<"externalApps">>();
  const { byApp } = await livePushesByAppForScholar(ctx, scholar, Date.now());
  // Grouped BEFORE loading documents: two pushes can target the same app (a
  // re-push, or overlapping audiences), and this runs on every scholar's
  // home-screen subscription as well as the fleet cron, so each app's
  // document is read once.
  for (const appId of byApp.keys()) {
    const app = await ctx.db.get(appId);
    if (!catalogAppIsVisible(app)) continue;
    appIds.add(app._id);
  }
  return appIds;
}

/**
 * One route that lets a scholar open a catalog app right now, and when it is
 * expected to end (`until`, null when it has no end of its own).
 *
 *   • `direct`: the scholar's own `scholarApps` row, when it would show the
 *     tile by itself (enabled, not a grant-parked login, and not past its
 *     end): `source` "manual" when staff added it for them, "default" when it
 *     was seeded because the app is a default for every new scholar. `until`
 *     is the end of an add opened for a day or until a date (TRA-444), null
 *     for a standing add, which only a staff edit removes.
 *   • `grant`: an enabled `appAudiences` grant to their school or to a group
 *     whose roster holds them. No end of its own today; a grant that carried
 *     an expiry would put it in `until`, and `accessEndsAt` already treats
 *     every route alike.
 *   • `push`: a live push covering them. `until` is `liveUntil`'s EXPECTED
 *     end: its window's close while that is ahead (the scheduled auto-clear's
 *     time), else the institution-local midnight; `overrun` says its window
 *     has closed with nothing cleared yet. A homework push has no end.
 *
 * `groupName` is the group's own name, unfiltered: the grant scan reads every
 * school's groups (`grantProvenanceForScholar`, the tile's rule), so a staff
 * reader must check the group against the caller's schools before showing it
 * (`appAudiences.aideGetAppAccess` does).
 */
export type AppAuthority =
  | {
      kind: "direct";
      scholarAppId: Id<"scholarApps">;
      source: "manual" | "default";
      until: number | null;
    }
  | { kind: "grant"; audience: "institution"; until: number | null }
  | {
      kind: "grant";
      audience: "group";
      groupId: Id<"scholarGroups">;
      groupName: string;
      until: number | null;
    }
  | {
      kind: "push";
      pushId: Id<"pushes">;
      source: "schedule" | "teacher";
      until: number | null;
      overrun: boolean;
    };

type App = Doc<"externalApps">;
type Link = Doc<"scholarApps"> | null;
export type ScholarAppAccess =
  | { allowed: true; denied: null; app: App; link: Link; via: AppAuthority[]; until: number | null }
  | { allowed: false; denied: "missing"; app: null; link: Link; via: []; until: null }
  | { allowed: false; denied: "archived" | "no-authority"; app: App; link: Link; via: []; until: null };

/**
 * May this scholar open this catalog app right now, through what, and until
 * when? The per-app check the three launch gates share — the saved-login
 * autofill (`scholarApps.credentialsForApp`), the web launch
 * (`webActivitySessions.start`) and the native tap
 * (`deviceAppUnlock.requireAuthorizedNativeTile`) — so no gate composes the
 * rule by hand. Each gate once did, and each copy could drop a term: three of
 * five readers forgot the push (TRA-333), and the autofill forgot the catalog
 * check (TRA-425). The staff read of one scholar's access
 * (`appAudiences.aideGetAppAccess` with a `scholar`, TRA-445) reads the same
 * answer, so what staff are told cannot drift from what the gates do.
 *
 * `allowed` is exactly the tile's rule: `catalogAppIsVisible(app)` and
 * `launcherShowsApp` over the scholar's direct row, their grants and their
 * live pushes. `denied` names the first condition that failed, in the order
 * the gates word their refusals: the app is gone, then archived, then nothing
 * covers the scholar. A gate with a condition of its own (a web URL, a managed
 * scheme) checks it between "archived" and "no-authority". `link` is the
 * scholar's own row for the app, where the autofill finds a saved login.
 *
 * `via` lists every route holding now (`AppAuthority`), and is non-empty
 * exactly when `allowed`. `until` is when access is EXPECTED to end: null
 * while any route has no end of its own, otherwise the latest route's end
 * (`accessEndsAt`). It is an expectation, not a promise: a push's end is its
 * scheduled auto-clear, and if that is late the push keeps showing, as an
 * overrun, until midnight — which a later read then reports.
 *
 * No clock argument: pushes and a direct add's end (TRA-444) are judged at
 * the server clock, read here, never at a client's. A SUBSCRIBED caller
 * still threads the minute-rounded `now` cache-buster (see
 * `scholarApps.credentialsForApp`), because both change with the clock alone.
 *
 * TENANCY is inherited, not decided here: a grant resolves as
 * `grantProvenanceForScholar` does (the scholar's school, and every group
 * whose roster holds them, in any school), a push as `pushCoversScholar` does
 * (never across schools).
 */
export async function scholarAppAccess(
  ctx: DbCtx,
  scholar: Doc<"users">,
  appId: Id<"externalApps">,
): Promise<ScholarAppAccess> {
  return await scholarAppAccessAt(ctx, scholar, appId, Date.now());
}

/**
 * `scholarAppAccess`, judged at `serverNowMs`: for a staff READ that must
 * judge everything it returns at one instant. Its one caller is
 * `appAudiences.aideGetAppAccess`, an internal query whose action takes
 * `Date.now()` and judges its app-wide push list at the same instant, so the
 * two halves of one answer cannot disagree about whether a push has run over.
 *
 * `serverNowMs` must be the SERVER's clock, taken by server code (an action).
 * Never pass a public function's argument: that is the client's clock, and a
 * gate judged at it would open an app at whatever time the client names (the
 * #4057 review). The launch gates call `scholarAppAccess`, which takes no
 * clock at all.
 */
export async function scholarAppAccessAt(
  ctx: DbCtx,
  scholar: Doc<"users">,
  appId: Id<"externalApps">,
  serverNowMs: number,
): Promise<ScholarAppAccess> {
  const app = await ctx.db.get(appId);
  const link = await ctx.db
    .query("scholarApps")
    .withIndex("by_scholar_app", (q) => q.eq("scholarId", scholar._id).eq("appId", appId))
    .first();
  if (!app) return { allowed: false, denied: "missing", app: null, link, via: [], until: null };
  if (!catalogAppIsVisible(app)) {
    return { allowed: false, denied: "archived", app, link, via: [], until: null };
  }
  // The same reads as `scholarHasGrantForApp` (`grantedAppIdsForScholar`),
  // kept per group so the answer can say which: an entry exists exactly when
  // an enabled grant covers the scholar.
  const grants = (await grantProvenanceForScholar(ctx as QueryCtx, scholar)).get(String(appId));
  const { byApp, clock } = await livePushesByAppForScholar(ctx, scholar, serverNowMs);
  const pushes = byApp.get(appId) ?? [];
  if (
    !launcherShowsApp({
      link,
      granted: grants !== undefined,
      pushed: pushes.length > 0,
      nowMs: serverNowMs,
    })
  ) {
    return { allowed: false, denied: "no-authority", app, link, via: [], until: null };
  }

  const via: AppAuthority[] = [];
  // The direct row counts exactly when it would show the tile on its own,
  // which also narrows its `source` to "manual" or "default" and drops an
  // add past its end.
  if (
    link &&
    link.source !== "grant" &&
    launcherShowsApp({ link, granted: false, pushed: false, nowMs: serverNowMs })
  ) {
    via.push({
      kind: "direct",
      scholarAppId: link._id,
      source: link.source,
      until: link.expiresAt ?? null,
    });
  }
  if (grants?.institution) via.push({ kind: "grant", audience: "institution", until: null });
  for (const group of grants?.groups ?? []) {
    via.push({
      kind: "grant",
      audience: "group",
      groupId: group.id,
      groupName: group.name,
      until: null,
    });
  }
  if (clock) {
    for (const push of pushes) {
      const endsAt = pushExpiresAt(push.timing);
      via.push({
        kind: "push",
        pushId: push._id,
        source: push.schedulePlacementId ? "schedule" : "teacher",
        until: liveUntil(push, clock),
        overrun: endsAt !== null && endsAt <= clock.nowMs,
      });
    }
  }
  return { allowed: true, denied: null, app, link, via, until: accessEndsAt(via) };
}

/** When access through `via` is expected to end: null while any route has no
 *  end of its own, else the latest route's end (access lasts while any route
 *  holds). Every route is read alike, so a route kind that gains an end needs
 *  no change here. */
function accessEndsAt(via: readonly AppAuthority[]): number | null {
  let latest: number | null = null;
  for (const authority of via) {
    if (authority.until === null) return null;
    latest = latest === null ? authority.until : Math.max(latest, authority.until);
  }
  return latest;
}

/** The managed-native app keys a scholar is currently PUSHED. */
export async function pushedManagedAppKeysForScholar(
  ctx: DbCtx,
  scholarId: Id<"users">,
): Promise<Set<ManagedNativeAppKey>> {
  const keys = new Set<ManagedNativeAppKey>();
  const scholar = await ctx.db.get(scholarId);
  if (!scholar) return keys;
  for (const appId of await livePushedAppIdsForScholar(ctx, scholar)) {
    const app = await ctx.db.get(appId);
    const key = managedNativeAppKeyForApp(app ?? {});
    if (key) keys.add(key);
  }
  return keys;
}

/**
 * The ONE "whose iPad is this, right now?" derivation — shared by the
 * allowlist projector and the ceremony's relock gate so they can never
 * disagree about who a device belongs to.
 *
 * EVERY link in the chain must still agree: the claim is live and assigned,
 * its institution and serial match the binding, the scholar exists and is
 * still a scholar at that institution, and a CURRENT `pairedDevices` row ties
 * this exact claim to that scholar, that institution, and that physical
 * device. The last link is the one a projector is tempted to skip and must
 * not: a manual re-pair or a claim takeover rewrites `pairedDevices` without
 * necessarily touching the claim, so a chain that stopped at the claim would
 * keep projecting the DEPARTED scholar's grants onto the serial — and the
 * relock path, which converges to the projection, would keep reapplying them.
 *
 * Any break returns null, and every caller reads that as "project the bare
 * baseline" / "close the lease" — never as "keep what was there".
 *
 * The relock gate layers ONE extra check on top of this (`claimGeneration`
 * matching the value stamped on the state row at unlock time), because it is
 * asking a different question: not "whose iPad is this" but "is the lease I
 * am holding still the same lease". The projection deliberately omits that:
 * pinning a generation would freeze a reassigned iPad on the departed
 * scholar's allowlist until someone happened to run a ceremony, which is the
 * failure mode the inversion exists to kill.
 */
export async function freshDeviceOwner(
  ctx: DbCtx,
  args: {
    claim: Doc<"managedDeviceClaims"> | null;
    binding: Doc<"deviceAppUnlockBindings"> | null;
  },
): Promise<Doc<"users"> | null> {
  const { claim, binding } = args;
  if (!claim || claim.claimState !== "claimed" || !claim.scholarId) return null;
  if (!binding) return null;
  if (claim.institutionId !== binding.institutionId) return null;
  if (claim.serial !== binding.serial) return null;

  const scholar = await ctx.db.get(claim.scholarId);
  if (!scholar) return null;
  if (scholar.role !== ROLES.SCHOLAR) return null;
  if (scholar.institutionId !== claim.institutionId) return null;

  if (claim.lastDeviceId === undefined) return null;
  const paired = await ctx.db
    .query("pairedDevices")
    .withIndex("by_device", (q) =>
      q.eq("institutionId", claim.institutionId).eq("deviceId", claim.lastDeviceId!),
    )
    .unique();
  if (
    !paired ||
    paired.managedDeviceClaimId !== claim._id ||
    paired.scholarId !== claim.scholarId ||
    paired.institutionId !== claim.institutionId
  ) {
    return null;
  }
  return scholar;
}

/**
 * The managed app keys this device's fresh owner may open right now: the
 * keys granted or pushed to the scholar `freshDeviceOwner` names, and none
 * when the device has no fresh owner.
 *
 * This is the one answer to "may this iPad open app K now?", and it has two
 * consumers that must never disagree:
 *
 *   • the PROJECTION allowlists exactly these keys (plus the baseline), and
 *   • the RELOCK GATE (`prepareReconcileLock`) keeps an unlock lease open only
 *     while its app is one of them, the lease was minted under the claim's
 *     current generation, and it has not expired.
 *
 * Granted-OR-PUSHED, deliberately, on both sides. The gate decides whether to
 * force-close a lease, so it must ask the question a fresh request is asked:
 * the launch gate (`requireAuthorizedNativeTile`) accepts a live push card's
 * tap, and a grants-only relock would close that lease under a tap the launch
 * gate re-authorizes, a relock/re-unlock loop for the length of the focus.
 */
export async function authorizedManagedAppKeysForClaim(
  ctx: DbCtx,
  args: {
    claim: Doc<"managedDeviceClaims"> | null;
    binding: Doc<"deviceAppUnlockBindings"> | null;
  },
): Promise<Set<ManagedNativeAppKey>> {
  const owner = await freshDeviceOwner(ctx, args);
  if (!owner) return new Set();
  return new Set([
    ...(await grantedManagedAppKeysForScholar(ctx, owner._id)),
    ...(await pushedManagedAppKeysForScholar(ctx, owner._id)),
  ]);
}

/**
 * The complete allowlist this device's dedicated profile should hold right
 * now. Sorted and deduped so `desired !== applied` is a plain string compare
 * and never re-PATCHes on ordering churn.
 *
 * It reads no unlock lease: see the composition rule in this file's header.
 *
 * `baseline` is passed in already validated by the caller (deviceAppUnlock.ts
 * owns `validateBaseline`), so this module never has to be trusted with the
 * "never strand a device away from Rabbithole or Settings" invariant.
 */
export async function projectedBundleIdsForClaim(
  ctx: DbCtx,
  args: {
    claim: Doc<"managedDeviceClaims"> | null;
    binding: Doc<"deviceAppUnlockBindings">;
    baseline: string[];
  },
): Promise<string[]> {
  const bundles = new Set<string>(args.baseline);
  const keys = await authorizedManagedAppKeysForClaim(ctx, {
    claim: args.claim,
    binding: args.binding,
  });
  for (const key of keys) bundles.add(MANAGED_NATIVE_APPS[key].bundleId);
  return [...bundles].sort();
}

// ── The VERIFY BARRIER: a time fence, not a flag ──────────────────────────
//
// `projectionVerifyNeeded` records that a writer could not prove what landed.
// On its own it is unsound, because a later SUCCESS erases it while the
// uncertainty is still outstanding:
//
//   P  PATCHes [baseline, SPIKE] — transport times out, outcome unknown
//   ·  the SPIKE grant is revoked
//   P2 PATCHes [baseline] — succeeds, and clears the flag with a fresh
//      `projectionVerifiedAt`
//   P  finally reaches SimpleMDM and lands, restoring SPIKE
//   ⇒ the profile holds a revoked app and is TRUSTED for a full interval
//
// Preemption is the same shape (the preemptor's own record clears the flag).
// The fix is a fence in TIME rather than a boolean: an uncertain operation
// records the latest moment its write could still be applied, and the flag may
// be cleared only by a live read performed after that moment.

/**
 * How long after an operation started its write might still be applied
 * server-side. Deliberately generous: this is not a request timeout but the
 * window in which a write the CLIENT already gave up on (an aborted fetch, a
 * dead action) can still be accepted and applied by SimpleMDM. Erring long
 * costs an extra live read; erring short reinstates the exact bug the barrier
 * exists to prevent.
 */
export const MAX_PATCH_LANDING_MS = 10 * 60 * 1_000;

/**
 * The fields to stamp when an operation's outcome is UNCERTAIN — a failed or
 * timed-out PATCH, a record under a lost token, an action that died, or a
 * preemption. Concurrent uncertain operations keep the MAXIMUM barrier, so the
 * fence only ever moves later.
 */
export function uncertainProjectionWrite(
  state: { projectionVerifyBarrierAt?: number },
  operationStartedAt: number,
): {
  projectionVerifyNeeded: true;
  projectionVerifiedAt: undefined;
  projectionVerifyBarrierAt: number;
} {
  return {
    projectionVerifyNeeded: true,
    projectionVerifiedAt: undefined,
    projectionVerifyBarrierAt: Math.max(
      state.projectionVerifyBarrierAt ?? 0,
      operationStartedAt + MAX_PATCH_LANDING_MS,
    ),
  };
}

/**
 * Whether an operation that just finished may clear the verify flag.
 *
 * THE RULE: only a LIVE PROFILE READ performed strictly after the barrier
 * clears it. A write succeeding proves nothing about a different write that
 * may still be in flight, and a read taken before the barrier can be
 * invalidated by that write landing afterwards.
 *
 * Pure on purpose — this is the one piece of the verify authority whose
 * correctness is a statement about time rather than about the database, so it
 * is unit-tested directly.
 */
export function resolveProjectionTrust(args: {
  now: number;
  barrierAt: number | undefined;
  /** Did this operation actually read the device's live allowlist? */
  verifiedByLiveRead: boolean;
}): {
  projectionVerifyNeeded: boolean;
  projectionVerifiedAt: number | undefined;
  projectionVerifyBarrierAt: number | undefined;
} {
  const barrierPassed =
    args.barrierAt === undefined || args.now > args.barrierAt;
  if (args.verifiedByLiveRead && barrierPassed) {
    return {
      projectionVerifyNeeded: false,
      projectionVerifiedAt: args.now,
      projectionVerifyBarrierAt: undefined,
    };
  }
  // Still uncertain. The row keeps re-reading the live profile on every pass —
  // correcting the device each time — until the barrier elapses.
  return {
    projectionVerifyNeeded: true,
    projectionVerifiedAt: undefined,
    projectionVerifyBarrierAt: args.barrierAt,
  };
}

/** Has this device's profile drifted from what the projection wants?
 *  "Never projected" (`applied === undefined`) counts as drift, so a freshly
 *  bound iPad converges on the reconciler's next tick rather than waiting for
 *  a grant to change. */
export function projectionHasDrifted(
  desired: string[],
  applied: string[] | undefined,
): boolean {
  if (applied === undefined) return true;
  if (applied.length !== desired.length) return true;
  const sortedApplied = [...applied].sort();
  return sortedApplied.some((bundleId, i) => bundleId !== desired[i]);
}
