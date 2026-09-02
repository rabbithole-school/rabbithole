/**
 * Shared revocation-recheck primitive for direct scholarGroups roster writes.
 *
 * A scholarGroup's roster is the ONLY membership check `appAudiences` group
 * grants resolve against at read time (lib/appAudiences.ts). ANY code path
 * that removes a scholar id from `scholarGroups.scholarIds` — or deletes the
 * group outright — can therefore silently revoke their sole route to a
 * managed-native tile's authorization without anything ever telling a
 * currently-unlocked device to close.
 *
 * This lives in its own module (not `convex/scholarGroups.ts`) specifically
 * so that call sites OUTSIDE scholarGroups.ts — enrollment transfer
 * (`lib/scholarEnrollment.ts`), scholar deletion (`adminCloneScholar.ts`) —
 * can reuse the exact same primitive `scholarGroups.ts` itself uses
 * (setScholars/removeScholar/remove), rather than re-deriving the app-list +
 * recheck logic (or worse, silently omitting it). Importing this from
 * `lib/scholarEnrollment.ts` directly would form an import cycle, since
 * `scholarGroups.ts` already imports from `lib/scholarEnrollment.ts`.
 *
 * Call this for every scholar who just lost roster membership so the same
 * force-close path teacher-direct revokes use
 * (scheduleUnlockRevocationCheck → closeRevokedUnlocks) also covers group
 * roster churn, no matter which module performed the write.
 */
import type { Id } from "../_generated/dataModel";
import {
  scheduleUnlockRevocationCheck,
  type RevocationSchedulerCtx,
} from "./deviceAppUnlockScheduling";
import { isPushShowing } from "./pushes";
import { primaryInstitutionId } from "./primaryInstitution";

/**
 * Every catalog app this group currently puts on its members' devices —
 * through a bulk `appAudiences` grant, AND through any live `pushes` row
 * targeting the group.
 *
 * The push half matters because the allowlist projection's predicate is
 * "granted-OR-pushed": a scholar leaving a group mid-block loses a
 * push-derived bundle exactly as surely as a grant-derived one, and a scholar
 * joining gains it. Consulting only `appAudiences` here left the push half of
 * the predicate with no roster hook at all.
 *
 * `scheduleUnlockRevocationCheck` no-ops for a non-managed app, so neither
 * source needs to pre-filter by scheme.
 */
async function appIdsReachingGroup(
  ctx: RevocationSchedulerCtx,
  groupId: Id<"scholarGroups">,
): Promise<Id<"externalApps">[]> {
  const grants = await ctx.db
    .query("appAudiences")
    .withIndex("by_audience", (q) =>
      q.eq("audienceKind", "group").eq("audienceId", String(groupId)),
    )
    .collect();
  const appIds = new Set<Id<"externalApps">>(
    grants.filter((g) => g.enabled).map((g) => g.appId),
  );

  const group = await ctx.db.get(groupId);
  // A legacy group predating institution stamping belongs to the PRIMARY
  // school — the same rule `institutionIdInLens` and `groupIdsForScholar`
  // apply. Resolving it matters: skipping the push scan for those groups left
  // roster churn blind to live group-targeted pushes on exactly the school
  // whose devices are unlock-mediated today.
  const groupInstitutionId =
    group?.institutionId ??
    (group ? await primaryInstitutionId(ctx) : undefined);
  if (groupInstitutionId) {
    const open = await ctx.db
      .query("pushes")
      .withIndex("by_institution_cleared", (q) =>
        q.eq("institutionId", groupInstitutionId).eq("clearedAt", undefined),
      )
      .collect();
    for (const push of open) {
      if (push.target.kind !== "app") continue;
      if (push.audience.kind !== "group") continue;
      if (push.audience.groupId !== groupId) continue;
      if (!isPushShowing(push)) continue;
      appIds.add(push.target.externalAppId);
    }
  }
  return [...appIds];
}

/**
 * Nudge the projection for scholars whose membership of this group just
 * changed — in EITHER direction. Leaving drops every group-derived app from
 * the device's allowlist; joining adds them. (The function kept its
 * revocation-era name at its ~6 call sites; the semantics are now symmetric,
 * matching `deviceAppUnlockScheduling.ts`.)
 */
export async function recheckUnlocksForRemovedMembers(
  ctx: RevocationSchedulerCtx,
  groupId: Id<"scholarGroups">,
  changedScholarIds: Id<"users">[],
): Promise<void> {
  if (changedScholarIds.length === 0) return;
  const appIds = await appIdsReachingGroup(ctx, groupId);
  for (const appId of appIds) {
    await scheduleUnlockRevocationCheck(ctx, {
      externalAppId: appId,
      scholarIds: changedScholarIds,
    });
  }
}
