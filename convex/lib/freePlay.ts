/**
 * FREE PLAY (TRA-489): the scholar's own version of a vibecode app after the
 * assignment version is done. The App designer parks off-contract ideas in
 * `sessions.parkingLot` "for Free play"; `sessions.startFreePlay` makes that
 * real by opening a contract-free copy of the app (a new session with
 * `freePlay: true`, `freePlayOf` = the assignment session).
 *
 * ONE eligibility derivation, read by both `startFreePlay` (the gate) and
 * `sessions.getWithMessages` (`freePlayEligible`, which shows the button), so
 * the button is shown exactly when the mutation would succeed.
 */
import type { Doc } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { scholarHasCompletedActivity } from "./workshopPolicy";

export type FreePlayIneligibleReason =
  | "notOwner"
  | "notVibecode"
  | "alreadyFreePlay"
  | "testDrive"
  | "noActivity"
  | "emptyLot"
  | "playOnly"
  | "notComplete";

export type FreePlayEligibility =
  | { eligible: true; activity: Doc<"activities"> }
  | { eligible: false; reason: FreePlayIneligibleReason };

/**
 * Whether `caller` may start free play from `session`:
 *  - the caller owns the session (a scholar's own version, never a teacher's
 *    remote-view click), and it is a real vibecode session for an activity —
 *    not a rehearsal, not already a free-play session;
 *  - the parking lot holds at least one idea (free play is where they go);
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
  if (session.sessionMode !== "vibecode") {
    return { eligible: false, reason: "notVibecode" };
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
  if (!activity || activity.kind !== "vibecode") {
    return { eligible: false, reason: "noActivity" };
  }
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

/** The free-play session's title: "<activity title>: Free play". */
export function freePlayTitle(activityTitle: string): string {
  return `${activityTitle.trim() || "My app"}: Free play`;
}
