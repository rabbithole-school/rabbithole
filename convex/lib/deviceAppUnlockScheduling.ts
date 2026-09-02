import { makeFunctionReference } from "convex/server";
import type { Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import {
  managedNativeAppKeyForScheme,
  type ManagedNativeAppKey,
} from "./managedNativeApps";

/**
 * Managed-device revocation nudges shared by enrollment and catalog mutations.
 *
 * These hooks only reduce latency. The periodic reconciler remains the
 * correctness mechanism: it re-derives every bound device's allowlist from
 * current data and converges it even when a mutation never calls one of
 * these.
 *
 * ── WHAT THESE NOW MEAN (app-access unification, lane C) ──────────────────
 *
 * The pre-existing SIGNATURES are unchanged, so none of the call sites that
 * already existed had to be touched. What moved is the SEMANTICS, one level
 * up: "mark this device's unlock due for a revocation recheck" became "mark
 * this device's allowlist PROJECTION dirty". That is a strict widening —
 *
 *   • before, a hook was a no-op unless the device happened to hold an active
 *     lease for the specific app whose grant changed. A grant change that
 *     ADDED access, or that touched a device with no lease, nudged nothing
 *     and waited out the cron;
 *   • now any grant/roster/claim change on an unlock-mediated device makes
 *     its whole projected set due immediately, in both directions.
 *
 * The lease-model `nextRecheckAt` stamp is still written for a row that is
 * actively unlocked, so the ceremony's own revocation gate
 * (`prepareReconcileLock`) keeps firing exactly as promptly as it did.
 *
 * The widening did add call sites and helpers, because the lease model only
 * ever needed to CLOSE access: every opening edge (a grant given, a tile
 * re-enabled, a group joined, an app un-archived, a claim first exchanged)
 * previously nudged nothing. Those now call in too, and
 * `schedulePushProjectionRefresh` / `scheduleDeviceOwnershipRefresh` /
 * `markInstitutionDevicesDirty` are new entry points for edges that move a
 * device's allowlist without touching any grant.
 *
 * Deliberately still a latency-only mechanism: no hook decides what the
 * allowlist should contain, and a missed or bypassed hook can only delay
 * convergence to the next 5-minute cron tick.
 */
export type RevocationSchedulerCtx = Pick<MutationCtx, "db" | "scheduler">;

const reconcileActiveUnlocksRef = makeFunctionReference<
  "action",
  { nowMs?: number },
  {
    considered: number;
    locked: number;
    authorized: number;
    failed: number;
    projected: number;
    projectionFailed: number;
  }
>("deviceAppUnlock:reconcileActiveUnlocks");

/**
 * Mark one claim's projection dirty (and, if it holds a live lease, its
 * lease recheck too).
 *
 * Returns whether this claim is unlock-mediated AT ALL — i.e. whether it has
 * a dedicated-profile binding. That, not the presence of a state row, is what
 * decides whether kicking the reconciler can accomplish anything: the
 * projection scan enumerates BINDINGS, so a bound device with no state row
 * yet is still converged by a kick, while an unbound device (the fleet's
 * normal, group-profile case) has nothing to converge and must not spend a
 * scheduled action.
 */
async function markClaimUnlockDueNow(
  ctx: RevocationSchedulerCtx,
  managedDeviceClaimId: Id<"managedDeviceClaims">,
): Promise<boolean> {
  const state = await ctx.db
    .query("deviceAppUnlockStates")
    .withIndex("by_managed_device", (q) =>
      q.eq("managedDeviceClaimId", managedDeviceClaimId),
    )
    .unique();
  if (state) {
    await ctx.db.patch(state._id, {
      projectionDueAt: 0,
      // Only an actively-unlocked row is gate-checked by the lease
      // reconciler; stamping a locked row would be inert noise.
      ...(state.desiredState === "unlocked" ? { nextRecheckAt: 0 } : {}),
    });
  }
  const binding = await ctx.db
    .query("deviceAppUnlockBindings")
    .withIndex("by_managed_device", (q) =>
      q.eq("managedDeviceClaimId", managedDeviceClaimId),
    )
    .unique();
  return binding !== null;
}

async function kickReconciler(ctx: RevocationSchedulerCtx): Promise<void> {
  await ctx.scheduler.runAfter(0, reconcileActiveUnlocksRef, {});
}

/** Mark every claimed managed device belonging to these scholars dirty. */
async function markScholarsDirty(
  ctx: RevocationSchedulerCtx,
  scholarIds: Id<"users">[],
): Promise<boolean> {
  let markedAny = false;
  for (const scholarId of scholarIds) {
    const claims = await ctx.db
      .query("managedDeviceClaims")
      .withIndex("by_scholar", (q) => q.eq("scholarId", scholarId))
      .filter((q) => q.eq(q.field("claimState"), "claimed"))
      .collect();
    for (const claim of claims) {
      if (await markClaimUnlockDueNow(ctx, claim._id)) markedAny = true;
    }
  }
  return markedAny;
}

/**
 * Recheck a claim before it is revoked, deleted, or unassigned. This must run
 * before invalidating the claim so the durable state patch is recorded in the
 * same mutation regardless of what happens to the claim row afterward.
 */
export async function scheduleClaimDecommissionLock(
  ctx: RevocationSchedulerCtx,
  managedDeviceClaimId: Id<"managedDeviceClaims">,
): Promise<void> {
  await markClaimUnlockDueNow(ctx, managedDeviceClaimId);
  await kickReconciler(ctx);
}

/**
 * Recheck every managed-device claim owned by a scholar before deleting the
 * scholar. A scholar with no managed devices is a no-op.
 */
export async function scheduleClaimDecommissionLocksForScholar(
  ctx: RevocationSchedulerCtx,
  scholarId: Id<"users">,
): Promise<void> {
  const claims = await ctx.db
    .query("managedDeviceClaims")
    .withIndex("by_scholar", (q) => q.eq("scholarId", scholarId))
    .collect();
  let markedAny = false;
  for (const claim of claims) {
    if (await markClaimUnlockDueNow(ctx, claim._id)) markedAny = true;
  }
  if (markedAny) await kickReconciler(ctx);
}

/**
 * Recheck managed devices whose scholar access to an app may have changed.
 * Plain web apps are a no-op — an app with no managed native scheme can never
 * enter a device allowlist, in either direction. The reconciler still derives
 * the final set from scratch; this only decides whether it is worth waking.
 */
export async function scheduleUnlockRevocationCheck(
  ctx: RevocationSchedulerCtx,
  args: { externalAppId: Id<"externalApps">; scholarIds: Id<"users">[] },
): Promise<void> {
  if (args.scholarIds.length === 0) return;
  const app = await ctx.db.get(args.externalAppId);
  const appKey = managedNativeAppKeyForScheme(app?.nativeUrlScheme);
  if (!appKey) return;
  await scheduleUnlockRevocationCheckForKey(ctx, {
    appKey,
    scholarIds: args.scholarIds,
  });
}

/**
 * Recheck managed devices for an app key named by the caller rather than read
 * back off the catalog row. Use this when a scheme change means the row no
 * longer names the key you care about — the OLD key on the way out, and the
 * NEW one on the way in.
 *
 * `appKey` is now only a "is this worth waking the reconciler for" filter:
 * the projection recomputes the device's WHOLE managed set, so a device is
 * marked dirty regardless of which key it happens to hold a lease for. Before
 * the inversion this filtered on `state.appKey === args.appKey`, which is
 * precisely why an ADDED grant never nudged anything.
 */
export async function scheduleUnlockRevocationCheckForKey(
  ctx: RevocationSchedulerCtx,
  args: { appKey: ManagedNativeAppKey; scholarIds: Id<"users">[] },
): Promise<void> {
  if (args.scholarIds.length === 0) return;
  if (await markScholarsDirty(ctx, args.scholarIds)) await kickReconciler(ctx);
}

/**
 * Recheck managed devices whose scholars are covered by a push that just
 * started or stopped.
 *
 * A live `pushes` row targeting a managed catalog app is the second half of
 * the plan's "granted-OR-pushed" predicate, so its start and its clear are
 * both allowlist edges. The audience is resolved to concrete scholars here
 * rather than in the projector, which reads membership live.
 *
 * Every audience marks its devices dirty, school-wide included. A bare kick
 * is NOT enough for any of them: the projection scan only returns rows whose
 * `projectionDueAt` has elapsed, so a device projected minutes ago is filtered
 * straight back out and the push waits a full interval — worst on the
 * school-wide audience, which is the one most likely to be a whole class
 * starting a block. A group or assignment audience walks its roster; a
 * school-wide one marks that school's bound devices directly, since there is
 * no roster to walk and the count is bounded by provisioned hardware rather
 * than by enrolment.
 */
export async function schedulePushProjectionRefresh(
  ctx: RevocationSchedulerCtx,
  pushId: Id<"pushes">,
): Promise<void> {
  const push = await ctx.db.get(pushId);
  if (!push || push.target.kind !== "app") return;
  const app = await ctx.db.get(push.target.externalAppId);
  if (!managedNativeAppKeyForScheme(app?.nativeUrlScheme)) return;

  const audience = push.audience;
  if (audience.kind === "scholars") {
    if (await markScholarsDirty(ctx, audience.scholarIds)) {
      await kickReconciler(ctx);
    }
    return;
  }
  if (audience.kind === "group") {
    const group = await ctx.db.get(audience.groupId);
    if (group && (await markScholarsDirty(ctx, group.scholarIds))) {
      await kickReconciler(ctx);
    }
    return;
  }
  if (audience.kind === "assignment") {
    // An assignment's roster IS a stored snapshot (unlike a group's live
    // membership), so it can be walked directly.
    const assignment = await ctx.db.get(audience.assignmentId);
    if (assignment && (await markScholarsDirty(ctx, assignment.scholarIds))) {
      await kickReconciler(ctx);
    }
    return;
  }
  // School-wide. Kicking the reconciler alone accomplishes NOTHING: its scan
  // only returns rows whose `projectionDueAt` has elapsed, so a device
  // projected minutes ago is filtered straight back out and the push waits a
  // full interval — on the one audience most likely to be a whole class
  // starting a block. Mark the school's bound devices dirty directly. There is
  // no per-scholar walk to do here, and a school's bound devices number in the
  // dozens (one row per physically provisioned iPad), so this is bounded by
  // hardware rather than by roster size.
  if (await markInstitutionDevicesDirty(ctx, push.institutionId)) {
    await kickReconciler(ctx);
  }
}

/**
 * Mark every unlock-mediated iPad in one school dirty. Used where an audience
 * has no scholar list to walk (a school-wide push) — the projector re-derives
 * each device's owner and set from scratch regardless.
 */
export async function markInstitutionDevicesDirty(
  ctx: RevocationSchedulerCtx,
  institutionId: Id<"institutions">,
): Promise<boolean> {
  const bindings = await ctx.db
    .query("deviceAppUnlockBindings")
    .withIndex("by_institution", (q) => q.eq("institutionId", institutionId))
    .collect();
  let markedAny = false;
  for (const binding of bindings) {
    if (await markClaimUnlockDueNow(ctx, binding.managedDeviceClaimId)) {
      markedAny = true;
    }
  }
  return markedAny;
}

/**
 * Mark one claim's projection dirty from a non-grant edge — a claim exchange,
 * a re-pair, anything that changes WHOSE iPad a serial is without changing any
 * grant. The projection's owner derivation reads `pairedDevices`, so those
 * edges move a device's whole allowlist even though no audience row moved.
 */
export async function scheduleDeviceOwnershipRefresh(
  ctx: RevocationSchedulerCtx,
  managedDeviceClaimId: Id<"managedDeviceClaims">,
): Promise<void> {
  if (await markClaimUnlockDueNow(ctx, managedDeviceClaimId)) {
    await kickReconciler(ctx);
  }
}
