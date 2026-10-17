/**
 * LEARN BEFORE YOU BUILD (TRA-519 B6), the server half. In a scholar's own
 * Quest an app activity (the build step) is locked until the nearest preceding
 * learning step is complete. The pure rule lives in `lib/mission.ts`
 * (`questBuildLock`); this module feeds it the unit's real activity order and
 * the scholar's real completions, so the unit read (`units.get`) that draws the
 * locked row and the session-opening paths that refuse it can never disagree.
 *
 * "Complete" is the existing per-activity reader, `scholarHasCompletedActivity`
 * (activityCompletions, assignment-blind for a Quest): a rubric pass, the
 * tutor's mark_activity_complete, or a teacher marking it. No new assessment.
 */
import { ConvexError } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { isAppActivity } from "../../shared/appSurface";
import { questBuildLockLabel } from "../../shared/missionCopy";
import {
  isQuestUnit,
  lockedQuestBuildTitle,
  questBuildLock,
  type QuestBuildLock,
} from "./mission";
import {
  computeChoicePlan,
  orderedLaunchableActivitiesForUnit,
  questOnlineProgressForScholar,
} from "./scholarReads";
import { isTeacherRole } from "./roles";
import { scholarHasCompletedActivity } from "./workshopPolicy";

type LockCtx = QueryCtx | MutationCtx;

/** The unit's live activities in scholar-visible order (lesson order, then
 * activity order; archived dropped). */
export async function orderedQuestActivities(
  ctx: LockCtx,
  unitId: Id<"units">,
  scholarId: Id<"users">,
): Promise<Doc<"activities">[]> {
  const items = await orderedLaunchableActivitiesForUnit(
    ctx,
    unitId,
    null,
    scholarId,
  );
  return items.map((i) => i.activity);
}

/**
 * The lock's inputs for one scholar's Quest: its activities in order, and the
 * ids that count as DONE for the lock. A completed activity is done; so is
 * every option of a SATISFIED choice lesson (`computeChoicePlan`: the scholar
 * finished `pickCount` of its options), so a build step after a choice lesson
 * unlocks once the choice is made, however many options were left unpicked.
 */
async function questLockInputs(
  ctx: LockCtx,
  unitId: Id<"units">,
  scholarId: Id<"users">,
): Promise<{
  ordered: Doc<"activities">[];
  done: Set<string>;
  started: Set<string>;
}> {
  const items = await orderedLaunchableActivitiesForUnit(
    ctx,
    unitId,
    null,
    scholarId,
  );
  const done = new Set<string>();
  for (const { activity } of items) {
    if (isAppActivity(activity)) continue;
    if (
      await scholarHasCompletedActivity(ctx, {
        scholarId,
        activityId: activity._id,
        assignmentId: null,
      })
    ) {
      done.add(String(activity._id));
    }
  }
  const plan = computeChoicePlan(items, done);
  for (const { activity, lesson } of items) {
    if (plan.choiceByLesson.get(String(lesson._id))?.satisfied) {
      done.add(String(activity._id));
    }
  }
  // Build steps the scholar already has a session on (made before the lock
  // existed, or before a teacher un-marked the learning step) stay open, so
  // the lock never takes away work they have (TRA-519 B6 migration).
  const started = new Set<string>();
  for (const { activity } of items) {
    if (!isAppActivity(activity)) continue;
    const mine = await ctx.db
      .query("sessions")
      .withIndex("by_activity", (q) => q.eq("activityId", activity._id))
      .filter((q) =>
        q.and(q.eq(q.field("userId"), scholarId), q.neq(q.field("isTestDrive"), true)),
      )
      .first();
    if (mine) started.add(String(activity._id));
  }
  return { ordered: items.map((i) => i.activity), done, started };
}

/**
 * The lock on every app activity of a scholar's own Quest, keyed by activity
 * id (present only while locked). Empty for a teacher's unit, for a viewer who
 * is not the Quest's author, and for a Quest with no app activity.
 */
export async function questBuildLocksFor(
  ctx: LockCtx,
  args: { unit: Doc<"units">; scholarId: Id<"users"> },
): Promise<Record<string, { prerequisiteTitle: string; prerequisiteId: string }>> {
  const { unit, scholarId } = args;
  if (!isQuestUnit(unit) || unit.authorScholarId !== scholarId) return {};
  const { ordered, done, started } = await questLockInputs(ctx, unit._id, scholarId);
  const apps = ordered.filter((a) => isAppActivity(a));
  if (apps.length === 0) return {};
  const locks: Record<string, { prerequisiteTitle: string; prerequisiteId: string }> = {};
  for (const app of apps) {
    const lock = questBuildLock(unit, ordered, app._id, (id) => done.has(String(id)), (id) => started.has(String(id)));
    if (lock.locked) {
      locks[String(app._id)] = {
        prerequisiteTitle: lock.prerequisiteTitle,
        prerequisiteId: String(lock.prerequisiteId),
      };
    }
  }
  return locks;
}

/**
 * The title of a locked build step in this scholar's own Quest, or null (B6):
 * the first locked build step after `fromActivityId`, else the first one
 * anywhere (`lockedQuestBuildTitle`). Read by prompt assembly to drop
 * `create_code` and give the unlock framing in the Quest's learning steps and
 * planning chat. Same order and completions as the lock itself.
 */
export async function lockedQuestBuildTitleFor(
  ctx: LockCtx,
  args: {
    unit: Doc<"units">;
    scholarId: Id<"users">;
    fromActivityId: Id<"activities"> | null;
  },
): Promise<string | null> {
  const { unit, scholarId } = args;
  if (!isQuestUnit(unit) || unit.authorScholarId !== scholarId) return null;
  const { ordered, done, started } = await questLockInputs(ctx, unit._id, scholarId);
  if (!ordered.some((a) => isAppActivity(a))) return null;
  return lockedQuestBuildTitle(
    unit,
    ordered,
    args.fromActivityId,
    (id) => done.has(String(id)),
    (id) => started.has(String(id)),
  );
}

/**
 * The title of this Quest's first build step when it is OPEN (no build step is
 * locked), or null. A Quest's app is built in its build step: once that step
 * opens, the other sessions point the scholar there instead of building here
 * (TRA-519 B6). Same inputs as the lock.
 */
export async function openQuestBuildTitleFor(
  ctx: LockCtx,
  args: { unit: Doc<"units">; scholarId: Id<"users"> },
): Promise<string | null> {
  const { unit, scholarId } = args;
  if (!isQuestUnit(unit) || unit.authorScholarId !== scholarId) return null;
  const { ordered } = await questLockInputs(ctx, unit._id, scholarId);
  const build = ordered.find((a) => isAppActivity(a));
  return build ? (build.title ?? "the build step") : null;
}

/** The lock state of ONE activity, for the session-opening paths. */
export async function questBuildLockFor(
  ctx: LockCtx,
  args: {
    unit: Doc<"units"> | null | undefined;
    activity: Doc<"activities">;
    scholarId: Id<"users">;
  },
): Promise<QuestBuildLock> {
  const { unit, activity, scholarId } = args;
  if (
    !unit ||
    !isQuestUnit(unit) ||
    unit.authorScholarId !== scholarId ||
    !isAppActivity(activity)
  ) {
    return { locked: false };
  }
  const { ordered, done, started } = await questLockInputs(ctx, unit._id, scholarId);
  return questBuildLock(
    unit,
    ordered,
    activity._id,
    (id) => done.has(String(id)),
    (id) => started.has(String(id)),
  );
}

/**
 * B6 badge moment: may this scholar append a build step to their Quest now?
 * The viewer is the Quest's author, every learning step is complete (the same
 * assignment-blind ledger and threshold the Quest's finish state and badge
 * read — `questOnlineProgressForScholar`, which counts non-app online steps),
 * and the Quest has no app activity yet. "Offered once per Quest": appending
 * the step makes this false for good.
 */
export async function canUnlockQuestBuild(
  ctx: LockCtx,
  args: { unit: Doc<"units">; scholarId: Id<"users"> },
): Promise<boolean> {
  const { unit, scholarId } = args;
  if (!isQuestUnit(unit) || unit.authorScholarId !== scholarId) return false;
  const ordered = await orderedQuestActivities(ctx, unit._id, scholarId);
  if (ordered.some((a) => isAppActivity(a))) return false;
  const progress = await questOnlineProgressForScholar(ctx, scholarId, unit._id);
  return progress.totalOnline > 0 && progress.completedOnline >= progress.totalOnline;
}

/**
 * Refuse to open a session on a locked Quest build step. The error text is the
 * scholar-facing lock label (shared with the locked row on web and native), so
 * a client that surfaces the message says exactly what the row said.
 */
export async function assertQuestBuildStepUnlocked(
  ctx: LockCtx,
  args: {
    unit: Doc<"units"> | null | undefined;
    activity: Doc<"activities"> | null | undefined;
    scholarId: Id<"users">;
  },
): Promise<void> {
  if (!args.activity) return;
  const lock = await questBuildLockFor(ctx, {
    unit: args.unit,
    activity: args.activity,
    scholarId: args.scholarId,
  });
  // A ConvexError so the sentence survives production redaction and the
  // client can show it (serverErrorMessage).
  if (lock.locked) {
    throw new ConvexError(questBuildLockLabel(lock.prerequisiteTitle));
  }
}

/**
 * The same refusal on every TURN of an existing session (B6): a build-step
 * session opened before the lock applied (or before a teacher un-marked its
 * learning step) cannot be messaged while the step is locked. The unit is the
 * activity's own (activity → lesson → unit). Staff turns (a teacher in remote
 * mode, a rehearsal) and free play (it follows the build step's own
 * completion) are never blocked.
 */
export async function sessionBuildStepLock(
  ctx: LockCtx,
  args: { session: Doc<"sessions">; callerRole: Doc<"users">["role"] },
): Promise<QuestBuildLock> {
  const { session } = args;
  if (
    session.isTestDrive ||
    session.freePlay ||
    !session.activityId ||
    isTeacherRole(args.callerRole)
  ) {
    return { locked: false };
  }
  const activity = await ctx.db.get(session.activityId);
  if (!activity || !isAppActivity(activity)) return { locked: false };
  const lesson = activity.lessonId ? await ctx.db.get(activity.lessonId) : null;
  return await questBuildLockFor(ctx, {
    unit: lesson ? await ctx.db.get(lesson.unitId) : null,
    activity,
    scholarId: session.userId,
  });
}

/** `sessionBuildStepLock`, refusing with the lock sentence (a ConvexError). */
export async function assertSessionBuildStepUnlocked(
  ctx: LockCtx,
  args: { session: Doc<"sessions">; callerRole: Doc<"users">["role"] },
): Promise<void> {
  const lock = await sessionBuildStepLock(ctx, args);
  if (lock.locked) {
    throw new ConvexError(questBuildLockLabel(lock.prerequisiteTitle));
  }
}
