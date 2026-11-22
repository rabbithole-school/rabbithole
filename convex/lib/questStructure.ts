// Guards that keep a Quest proposal's structure in the shape approval expects
// (TRA-685, convex/questProposals.ts). One guard per writer:
//
//  - A waiting or declined proposal holds no lessons or activities, and no
//    session or seed may open onto it: approval creates its one activity.
//  - A scholar's own unit never gains a NEW app activity through a scholar's
//    writer (create, copy, move, change to an app). Approval is the one writer
//    that gives a scholar's Quest an app activity, so the builder opens there
//    and nowhere else. App activities a Quest already holds keep working;
//    teachers' writes are unchanged.
//
// Kept apart from lib/questApproval.ts, which schema.ts imports and so stays
// free of everything but the validator.

import { ConvexError } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import { isAppActivity } from "../../shared/appSurface";
import { SCHOLAR_LED_APP_BUILDING } from "../../shared/missionCopy";
import { isUnansweredOrDeclinedProposal } from "./questApproval";

export const QUEST_HAS_NO_APP_STEPS =
  "A Quest has no app-building steps: apps are built in activities a teacher assigns.";

const PROPOSAL_TAKES_NO_STRUCTURE =
  "This Quest is waiting for a teacher's yes. Its activity comes with the approval.";

const PROPOSAL_NOT_OPEN = "This Quest isn't open yet: it is waiting for a teacher's yes.";

/** No lesson or activity enters a proposal that is waiting or declined. */
export function assertProposalTakesNoStructure(
  unit: Pick<Doc<"units">, "questApproval"> | null | undefined,
): void {
  if (isUnansweredOrDeclinedProposal(unit)) {
    throw new ConvexError(PROPOSAL_TAKES_NO_STRUCTURE);
  }
}

/** Nothing opens onto a proposal that is waiting or declined: no session,
 *  no star, no offer, no badge. */
export function assertProposalIsOpen(
  unit: Pick<Doc<"units">, "questApproval"> | null | undefined,
): void {
  if (isUnansweredOrDeclinedProposal(unit)) {
    throw new ConvexError(PROPOSAL_NOT_OPEN);
  }
}

/** An approved (or any proposed) Quest is its proposer's: nobody else's
 *  session opens on it, no seed for anyone else points at it. A teacher's
 *  rehearsal is the caller's to exempt. */
export function assertProposedQuestIsOwn(
  unit: Pick<Doc<"units">, "questApproval" | "authorScholarId"> | null | undefined,
  ownerUserId: Id<"users">,
): void {
  if (unit?.questApproval && unit.authorScholarId !== ownerUserId) {
    throw new ConvexError(
      "This Quest belongs to the scholar who proposed it. You can propose your own version.",
    );
  }
}

/** Assigning or pushing a unit: a proposal not yet approved reaches nobody,
 *  and an approved one only its proposer. */
export function assertProposedQuestRecipients(
  unit: Pick<Doc<"units">, "questApproval" | "authorScholarId"> | null | undefined,
  recipientIds: ReadonlyArray<Id<"users">>,
): void {
  assertProposalIsOpen(unit);
  for (const recipientId of recipientIds) {
    assertProposedQuestIsOwn(unit, recipientId);
  }
}

/**
 * Does the session's activity really sit in the session's lesson and unit,
 * where a proposed Quest is involved? The runtime half of the anchor rule
 * session writers enforce, read by the app-creation gate (lib/mission.ts
 * mayCreateAppInSession). Only a session whose unit, or whose activity's
 * unit, carries a `questApproval` is checked; every other session is as it
 * was (a teacher may move a lesson between ordinary units, and its sessions
 * keep building). Nobody moves a lesson into or out of a proposed Quest
 * (assertNotRelocatingProposedQuestLesson), so this can't strand one.
 */
export async function sessionAnchorsAgree(
  ctx: Pick<QueryCtx, "db">,
  session: Pick<Doc<"sessions">, "unitId" | "lessonId">,
  activity: Pick<Doc<"activities">, "lessonId"> | null | undefined,
): Promise<boolean> {
  if (!activity) return true;
  const sessionUnit = session.unitId ? await ctx.db.get(session.unitId) : null;
  const lesson = activity.lessonId ? await ctx.db.get(activity.lessonId) : null;
  const activityUnit = lesson ? await ctx.db.get(lesson.unitId) : null;
  if (!sessionUnit?.questApproval && !activityUnit?.questApproval) return true;
  if (!lesson) return false;
  if (session.lessonId && session.lessonId !== lesson._id) return false;
  return !session.unitId || lesson.unitId === session.unitId;
}

/** An approved Quest's maker activity, seen by its own scholar: its kind,
 *  brief and contract stay as the advisor approved them. Teachers' edits are
 *  unchanged. */
export function assertMakerActivityUnchanged(
  unit: Pick<Doc<"units">, "questApproval" | "authorScholarId">,
  activityId: Id<"activities">,
  userId: Id<"users">,
): void {
  if (
    unit.questApproval?.activityId === activityId &&
    unit.authorScholarId === userId
  ) {
    throw new ConvexError(
      "This Quest's activity is the one your teacher approved: its kind and instructions stay as they are.",
    );
  }
}

/** Nobody, scholar or teacher, moves a lesson into or out of a proposed
 *  Quest: its one activity stays where the approval put it, so its sessions'
 *  anchors always agree. */
export function assertNotRelocatingProposedQuestLesson(
  units: ReadonlyArray<Pick<Doc<"units">, "questApproval"> | null | undefined>,
): void {
  if (units.some((u) => u?.questApproval)) {
    throw new ConvexError("A proposed Quest's lessons stay where they are.");
  }
}

/**
 * While SCHOLAR_LED_APP_BUILDING is off, a scholar's writer puts no app
 * activity into a unit that scholar owns: not a new one, not a copy, not one
 * moved in from elsewhere. `incoming` is what the write would add (the new
 * activity's shape, or every activity of a lesson being copied or moved).
 */
export function assertNotOwnQuestAppStep(
  unit: Pick<Doc<"units">, "authorScholarId">,
  userId: Id<"users">,
  incoming: ReadonlyArray<Parameters<typeof isAppActivity>[0]> = [
    { kind: "online", appActivity: true },
  ],
): void {
  if (SCHOLAR_LED_APP_BUILDING || unit.authorScholarId !== userId) return;
  if (incoming.some((activity) => isAppActivity(activity))) {
    throw new Error(QUEST_HAS_NO_APP_STEPS);
  }
}
