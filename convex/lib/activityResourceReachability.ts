import type { Doc, Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import {
  isMaterialActivityResource,
  type MaterialActivityResource,
} from "./activityPresentationResources";

type ResourceReadCtx = Pick<QueryCtx, "db">;

export type ReachableActivityResources = {
  owned: MaterialActivityResource[];
  referenced: MaterialActivityResource[];
  all: MaterialActivityResource[];
  invalidReferencedResourceIds: Id<"activityResources">[];
};

async function unitIdForActivity(
  ctx: ResourceReadCtx,
  activity: Doc<"activities">,
): Promise<Id<"units"> | null> {
  if (!activity.lessonId) return null;
  const lesson = await ctx.db.get(activity.lessonId);
  return lesson?.unitId ?? null;
}

/**
 * The single definition of resources reachable from an activity.
 *
 * Reads omit invalid pointers. Writers pass the proposed ids and reject when
 * `invalidReferencedResourceIds` is non-empty.
 */
export async function resolveReachableActivityResources(
  ctx: ResourceReadCtx,
  activityId: Id<"activities">,
  proposedReferencedResourceIds?: Id<"activityResources">[],
): Promise<ReachableActivityResources> {
  const activity = await ctx.db.get(activityId);
  if (!activity) {
    return {
      owned: [],
      referenced: [],
      all: [],
      invalidReferencedResourceIds: proposedReferencedResourceIds ?? [],
    };
  }

  const owned = (
    await ctx.db
      .query("activityResources")
      .withIndex("by_activity", (query) => query.eq("activityId", activityId))
      .collect()
  )
    .filter(isMaterialActivityResource)
    .sort((a, b) => a.order - b.order);

  const targetUnitId = await unitIdForActivity(ctx, activity);
  const referencedIds =
    proposedReferencedResourceIds ?? activity.referencedResourceIds ?? [];
  const referenced: MaterialActivityResource[] = [];
  const invalidReferencedResourceIds: Id<"activityResources">[] = [];
  const seen = new Set<string>();
  const ownerUnitCache = new Map<string, Id<"units"> | null>();

  for (const resourceId of referencedIds) {
    const key = String(resourceId);
    if (seen.has(key)) {
      invalidReferencedResourceIds.push(resourceId);
      continue;
    }
    seen.add(key);

    const resource = await ctx.db.get(resourceId);
    if (
      !targetUnitId ||
      !resource ||
      resource.activityId === activityId ||
      !isMaterialActivityResource(resource)
    ) {
      invalidReferencedResourceIds.push(resourceId);
      continue;
    }

    const ownerKey = String(resource.activityId);
    let ownerUnitId = ownerUnitCache.get(ownerKey);
    if (ownerUnitId === undefined) {
      const ownerActivity = await ctx.db.get(resource.activityId);
      ownerUnitId = ownerActivity
        ? await unitIdForActivity(ctx, ownerActivity)
        : null;
      ownerUnitCache.set(ownerKey, ownerUnitId);
    }
    if (ownerUnitId !== targetUnitId) {
      invalidReferencedResourceIds.push(resourceId);
      continue;
    }
    referenced.push(resource);
  }

  return {
    owned,
    referenced,
    all: [...owned, ...referenced],
    invalidReferencedResourceIds,
  };
}

/**
 * An offline homework card is usable when it has written instructions or at
 * least one scholar-safe material reachable from its activity. Instructions
 * are the scholar-facing `scholarDescription` — the teacher-facing
 * `description` never reaches a scholar, so it can't make a card readable.
 */
export async function hasReadableOfflineHomeworkContent(
  ctx: ResourceReadCtx,
  activity: Doc<"activities">,
): Promise<boolean> {
  return (
    !!activity.scholarDescription?.trim() ||
    (await resolveReachableActivityResources(ctx, activity._id)).all.length > 0
  );
}
