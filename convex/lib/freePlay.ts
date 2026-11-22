/**
 * "Build it now" on the done screen (TRA-519 B2): carry on building an APP
 * activity's app once the activity is done. The App designer parks
 * off-contract ideas in `sessions.parkingLot` "for later"; after the activity
 * is finished `sessions.startFreePlay` reopens the same session for them, where
 * the scholar makes the rules. Free-play COPIES (`freePlay: true`,
 * `freePlayOf`, TRA-489) are no longer made; old ones keep working.
 *
 * Only an app activity can be the source: free play continues an app that
 * exists. Ideas parked in a writing, slides or map activity stay on its done
 * screen, where "Make it a Quest" is their way forward.
 *
 * ONE eligibility derivation, read by both `startFreePlay` (the gate) and
 * `sessions.getWithMessages` (`freePlayEligible`, which shows the button), so
 * the button is shown exactly when the mutation would succeed.
 */
import type { Doc } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { scholarHasCompletedActivity } from "./workshopPolicy";
import { isAppActivity } from "../../shared/appSurface";

export type FreePlayIneligibleReason =
  | "notOwner"
  | "alreadyFreePlay"
  | "testDrive"
  | "noActivity"
  | "notApp"
  | "emptyLot"
  | "playOnly"
  | "notComplete";

export type FreePlayEligibility =
  | { eligible: true; activity: Doc<"activities"> }
  | { eligible: false; reason: FreePlayIneligibleReason };

/**
 * Whether `caller` may start free play from `session`:
 *  - the caller owns the session (a scholar's own version, never a teacher's
 *    remote-view click) and it is not a rehearsal or already a free-play row;
 *  - the parking lot holds at least one idea (free play is where they go);
 *  - the session's activity is an APP activity (`isAppActivity`: legacy
 *    vibecode, or online with the app marker) — free play builds on its app;
 *  - the activity's editAccess is not `never` — the teacher said play only,
 *    and free play is building;
 *  - the scholar has completed the activity under the session's assignment
 *    (the same signal `editAccess: "afterCompletion"` unlocks on).
 */
export async function resolveFreePlayEligibility(
  ctx: Pick<QueryCtx | MutationCtx, "db">,
  args: {
    session: Doc<"sessions">;
    caller: Pick<Doc<"users">, "_id">;
  },
): Promise<FreePlayEligibility> {
  const { session } = args;
  if (session.userId !== args.caller._id) {
    return { eligible: false, reason: "notOwner" };
  }
  if (session.freePlay === true) {
    return { eligible: false, reason: "alreadyFreePlay" };
  }
  if (session.isTestDrive === true) {
    return { eligible: false, reason: "testDrive" };
  }
  if ((session.parkingLot ?? []).length === 0) {
    return { eligible: false, reason: "emptyLot" };
  }
  const activity = session.activityId
    ? await ctx.db.get(session.activityId)
    : null;
  if (!activity) return { eligible: false, reason: "noActivity" };
  if (!isAppActivity(activity)) return { eligible: false, reason: "notApp" };
  if (activity.editAccess === "never") {
    return { eligible: false, reason: "playOnly" };
  }
  const complete = await scholarHasCompletedActivity(ctx, {
    scholarId: session.userId,
    activityId: activity._id,
    assignmentId: session.assignmentId ?? null,
  });
  if (!complete) return { eligible: false, reason: "notComplete" };
  return { eligible: true, activity };
}

/**
 * Whether the scholar has finished this session's activity: ONE answer for the
 * builder's prompt (the gate counts as met), its tool offer, and the
 * Workshop's done state. The session stamp (`activityCompletedAt`) is set by
 * Finish and send; a teacher's class-wide mark writes only the completions
 * ledger, so the ledger is the fallback.
 */
export async function sessionActivityDone(
  ctx: Pick<QueryCtx | MutationCtx, "db">,
  session: Pick<
    Doc<"sessions">,
    "userId" | "activityId" | "assignmentId" | "activityCompletedAt" | "isTestDrive" | "freePlay"
  >,
): Promise<boolean> {
  if (session.activityCompletedAt != null) return true;
  if (!session.activityId || session.isTestDrive || session.freePlay) {
    return false;
  }
  return await scholarHasCompletedActivity(ctx, {
    scholarId: session.userId,
    activityId: session.activityId,
    assignmentId: session.assignmentId ?? null,
  });
}

/**
 * The parking lot with `idea` moved to the front (the scholar just picked it),
 * matched like every other lot lookup: exact text, ignoring case and spacing.
 * An idea not in the lot, or already first, leaves the order alone.
 */
export function reorderLotFirst<E extends { text: string }>(
  lot: readonly E[] | undefined,
  idea: string | undefined,
): E[] {
  const entries = lot ? [...lot] : [];
  const key = idea?.replace(/\s+/g, " ").trim().toLowerCase();
  if (!key) return entries;
  const index = entries.findIndex(
    (e) => e.text.replace(/\s+/g, " ").trim().toLowerCase() === key,
  );
  if (index <= 0) return entries;
  const [picked] = entries.splice(index, 1);
  return [picked, ...entries];
}
