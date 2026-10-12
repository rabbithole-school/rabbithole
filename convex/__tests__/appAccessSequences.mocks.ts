// The two module wrappers every appAccessSequences spec installs with
// `vi.mock` (see appAccessSequences.harness.ts). They live apart from the
// harness because a mock factory runs while the harness's own imports are
// still resolving, and the harness imports the very modules these wrap. Only
// type imports here, so a factory can load this file without a cycle.

import type { QueryCtx } from "../_generated/server";
import type * as DeviceAppProjection from "../lib/deviceAppProjection";
import type * as DeviceAppUnlockScheduling from "../lib/deviceAppUnlockScheduling";

export type ProjectionArgs = Parameters<typeof DeviceAppProjection.projectedBundleIdsForClaim>[1];
export type ProjectionWatcher = (ctx: Pick<QueryCtx, "db">, args: ProjectionArgs, bundles: string[]) => Promise<void>;

/** Set on each wrapped module, so the harness can prove its spec installed both. */
export const WRAPPED = "__appAccessSequencesWrapped";

/**
 * Every derivation of a device's target set goes through
 * projectedBundleIdsForClaim. The wrapper only watches it (reading, in the same
 * transaction, whose iPad it is and what lease its row holds): it is how the
 * explorer would see the projector derive a set from a stale lease even when
 * no request is sent.
 */
export function watchProjections(actual: typeof DeviceAppProjection) {
  return {
    ...actual,
    [WRAPPED]: true,
    projectedBundleIdsForClaim: async (...call: Parameters<typeof actual.projectedBundleIdsForClaim>) => {
      const bundles = await actual.projectedBundleIdsForClaim(...call);
      const watch = (globalThis as { __appAccessProjectionWatcher?: ProjectionWatcher }).__appAccessProjectionWatcher;
      await watch?.(call[0], call[1], bundles);
      return bundles;
    },
  };
}

/**
 * APP_ACCESS_SEQ_KICKS=off: every mutation-site kick becomes a no-op, so the
 * cron cadence alone must converge the device. Otherwise the module is
 * untouched.
 */
export function kicksUnlessOff(actual: typeof DeviceAppUnlockScheduling) {
  if (process.env.APP_ACCESS_SEQ_KICKS !== "off") return { ...actual, [WRAPPED]: true };
  const off = async () => undefined;
  return {
    ...actual,
    [WRAPPED]: true,
    scheduleClaimDecommissionLock: off,
    scheduleClaimDecommissionLocksForScholar: off,
    scheduleUnlockRevocationCheck: off,
    scheduleUnlockRevocationCheckForKey: off,
    schedulePushProjectionRefresh: off,
    scheduleDeviceOwnershipRefresh: off,
    markInstitutionDevicesDirty: async () => false,
  };
}
