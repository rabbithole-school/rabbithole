/**
 * The managed-app allowlist PROJECTION — one home for "what should this
 * iPad's dedicated MDM profile allow, right now?"
 *
 *   desiredAllowlist(device) = baseline(device)
 *                            ∪ { bundleId(app) : app granted-or-pushed to
 *                                this device's scholar right now }
 *                            ∪ { the live ceremony lease's app, if any }
 *
 * The teacher's grant is the ONE authority; the MDM allowlist is an
 * eventually-consistent projection of it. See
 * review/app-access-unification-plan.html §model.
 *
 * ── WHY THE THIRD TERM EXISTS (the composition rule) ──────────────────────
 *
 * Two writers move the same profile until the shipped iPad build stops
 * driving the launch-time unlock ceremony (retirement lane):
 *
 *   • the CEREMONY — `requestUnlock` / `requestLock` in deviceAppUnlock.ts,
 *     driven by the native client's lease state machine, and
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
 *   • a ceremony unlock PATCHes `projected ∪ {the leased app}` — the leased
 *     app is normally already in `projected` (the ceremony refuses an
 *     ungranted tile), so the union is usually a no-op, but it makes the
 *     lease a guaranteed superset member even at a grant/lease race edge;
 *   • a ceremony relock PATCHes `projected` (which for a locked row has no
 *     lease term) instead of bare baseline — so "relock" now means "converge
 *     to the projection", exactly what the plan calls for;
 *   • the projection PATCHes `projected`, and the lease term keeps it from
 *     yanking an app out from under a live handoff.
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
import { grantedAppIdsForScholar, launcherShowsApp } from "./appAudiences";
import {
  MANAGED_NATIVE_APPS,
  managedNativeAppKeyForScheme,
  type ManagedNativeAppKey,
} from "./managedNativeApps";
import { isPushShowing, pushCoversScholar } from "./pushes";
import { groupIdsForScholar } from "./scholarGroupMembership";

type DbCtx = QueryCtx | MutationCtx;

/**
 * The managed-native app keys a scholar is currently GRANTED — the exact
 * generalization of the single-key check the relock gate has always used
 * (`isScholarAuthorizedForAppKey`), answering for every key at once instead
 * of one.
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
 */
export async function grantedManagedAppKeysForScholar(
  ctx: DbCtx,
  scholarId: Id<"users">,
): Promise<Set<ManagedNativeAppKey>> {
  const keys = new Set<ManagedNativeAppKey>();
  const scholar = await ctx.db.get(scholarId);
  if (!scholar) return keys;
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
    const key = managedNativeAppKeyForScheme(app.nativeUrlScheme);
    if (!key || keys.has(key)) continue;
    const link = linkByApp.get(String(app._id));
    if (launcherShowsApp({ link, granted: granted.has(app._id) })) keys.add(key);
  }
  return keys;
}

/**
 * The catalog apps a live `pushes` row is putting in front of this scholar
 * right now — a push whose target is an app and whose audience covers them.
 *
 * A push is the school's other "you may use this, now" authority (a teacher
 * opening a block's app for a group), and it is scholar-VISIBLE: FocusStrip
 * renders a live app push as a tappable "Right now" card. So this is the one
 * home for the question, and it has two consumers that must never disagree:
 *
 *   • the ALLOWLIST projection below, which folds these into the device's
 *     desired bundle set ("granted-OR-pushed"), and
 *   • the ceremony's LAUNCH gate (`requireAuthorizedNativeTile` in
 *     deviceAppUnlock.ts), which must not refuse a tap on a card Rabbithole
 *     itself just rendered.
 *
 * Letting those two drift is precisely the incident this program exists to
 * kill: a visible card whose tap fails closed against a door MDM had already
 * opened. Archived apps are excluded here, matching every other surface.
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
 * That split also means this takes NO clock: "is the card on screen" is a
 * pure function of `setAt` / `clearedAt`, so there is no expiry boundary for a
 * reactive query to go stale across. (The projection still threads a
 * timestamp for the ceremony LEASE, which does expire — see
 * `ceremonyLeaseBundleId`.)
 */
/** Of the assignments these pushes target, the ones whose roster currently
 *  contains this scholar. Mirrors `assignmentIdsForScholar` in pushes.ts. */
async function assignmentIdsCovering(
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

export async function livePushedAppIdsForScholar(
  ctx: DbCtx,
  scholar: Doc<"users">,
): Promise<Set<Id<"externalApps">>> {
  const appIds = new Set<Id<"externalApps">>();
  const institutionId = scholar.institutionId;
  if (!institutionId) return appIds;
  const open = await ctx.db
    .query("pushes")
    .withIndex("by_institution_cleared", (q) =>
      q.eq("institutionId", institutionId).eq("clearedAt", undefined),
    )
    .collect();
  const appPushes = open.filter(
    (p) => p.target.kind === "app" && isPushShowing(p),
  );
  if (appPushes.length === 0) return appIds;
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
    const app = await ctx.db.get(push.target.externalAppId);
    if (!app || app.archived) continue;
    appIds.add(app._id);
  }
  return appIds;
}

/** Does a live push currently show this exact app to this scholar? The launch
 *  gate's half of `livePushedAppIdsForScholar`'s contract. */
export async function livePushShowsAppToScholar(
  ctx: DbCtx,
  scholar: Doc<"users">,
  appId: Id<"externalApps">,
): Promise<boolean> {
  return (await livePushedAppIdsForScholar(ctx, scholar)).has(appId);
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
    const key = managedNativeAppKeyForScheme(app?.nativeUrlScheme);
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
 * The live ceremony lease's bundle id, or null. See the composition rule in
 * this file's header: a live lease is always a member of the projected set,
 * so the two writers can never disagree about what the profile should hold.
 *
 * Expiry mirrors `prepareRequest`'s own notion of a warm lease — the active
 * session failsafe if one is stamped, otherwise the idle expiry.
 */
export function ceremonyLeaseBundleId(
  state: Doc<"deviceAppUnlockStates"> | null,
  nowMs: number,
): string | null {
  if (!state || state.desiredState !== "unlocked" || !state.appKey) return null;
  const failsafeAt = state.activeSessionFailsafeAt ?? state.expiresAt;
  if (failsafeAt !== undefined && failsafeAt <= nowMs) return null;
  return MANAGED_NATIVE_APPS[state.appKey].bundleId;
}

/**
 * The complete allowlist this device's dedicated profile should hold right
 * now. Sorted and deduped so `desired !== applied` is a plain string compare
 * and never re-PATCHes on ordering churn.
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
    state: Doc<"deviceAppUnlockStates"> | null;
    baseline: string[];
    nowMs: number;
  },
): Promise<string[]> {
  const bundles = new Set<string>(args.baseline);

  const owner = await freshDeviceOwner(ctx, {
    claim: args.claim,
    binding: args.binding,
  });
  if (owner) {
    const keys = new Set<ManagedNativeAppKey>([
      ...(await grantedManagedAppKeysForScholar(ctx, owner._id)),
      ...(await pushedManagedAppKeysForScholar(ctx, owner._id)),
    ]);
    for (const key of keys) bundles.add(MANAGED_NATIVE_APPS[key].bundleId);
  }

  const leased = ceremonyLeaseBundleId(args.state, args.nowMs);
  if (leased) bundles.add(leased);

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
