import { randomToken } from "./oauthCrypto";
import type { Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";

/**
 * Clear a claim's scholar assignment. `previousGeneration` is the claim's
 * CURRENT `claimGeneration` (undefined treated as 0) — bumped here because
 * `scholarId` is genuinely changing (to absent). The active-unlock
 * reconciler's atomic gate compares this against the generation it stamped
 * onto any deviceAppUnlockStates row at unlock time, so a stale reconcile
 * task can never mistake a fresh new owner's valid unlock for the departed
 * owner's stale one.
 */
export function unassignedManagedClaimPatch(
  now: number,
  previousGeneration?: number,
) {
  return {
    scholarId: undefined,
    claimTokenHash: undefined,
    pendingClaimTokenHash: undefined,
    pendingClaimIssuedAt: undefined,
    pendingRotationCount: undefined,
    pendingSimplemdmPushedAt: undefined,
    claimState: "unassigned" as const,
    updatedAt: now,
    firstClaimedAt: undefined,
    lastClaimedAt: undefined,
    claimCount: 0,
    lastDeviceId: undefined,
    revokedAt: undefined,
    revokedBy: undefined,
    simplemdmPushedAt: undefined,
    claimGeneration: (previousGeneration ?? 0) + 1,
  };
}

/**
 * Invalidate a claim's credential without removing it from the roster:
 * overwrite the token hash with an unmatchable value (belt-and-braces on top
 * of the `claimState` check), clear any in-flight rotation, and bump
 * `claimGeneration` — this is a real boundary change (the credential can
 * never be redeemed again), so it must invalidate the atomic reconciler
 * gate's notion of "the current generation" exactly like unassignment does.
 * `previousGeneration` is the claim's CURRENT `claimGeneration` (undefined
 * treated as 0).
 */
export function revokedManagedClaimPatch(
  now: number,
  previousGeneration: number | undefined,
  revokedBy: Id<"users">,
) {
  return {
    claimTokenHash: `revoked:${randomToken(16)}`,
    pendingClaimTokenHash: undefined,
    pendingClaimIssuedAt: undefined,
    pendingRotationCount: undefined,
    pendingSimplemdmPushedAt: undefined,
    claimState: "revoked" as const,
    updatedAt: now,
    revokedAt: now,
    revokedBy,
    lastDeviceId: undefined,
    simplemdmPushedAt: undefined,
    claimGeneration: (previousGeneration ?? 0) + 1,
  };
}

/**
 * A single, plain `auditLog` insert shared by every managed-claim state
 * transition (assign/rotate/unassign/revoke/remove and the managed-device
 * remote sign-out decommission in devicePairing.ts). Kept in this neutral
 * module — not in managedDeviceClaims.ts or devicePairing.ts — because those
 * two files import from each other in one direction (managedDeviceClaims.ts
 * → devicePairing.ts) and a shared decommission helper needs to be callable
 * from both without introducing a cycle.
 */
export async function auditManagedClaim(
  ctx: MutationCtx,
  actorUserId: Id<"users">,
  action: string,
  targetUserId: Id<"users">,
  detail: string,
): Promise<void> {
  await ctx.db.insert("auditLog", {
    actorUserId,
    action,
    targetUserId,
    at: Date.now(),
    detail,
  });
}
