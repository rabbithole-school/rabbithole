/**
 * Shared eligibility gate for the tutor's conversation-completion path
 * (`mark_activity_complete`).
 *
 * An online activity without an advance rubric can be closed out through
 * `mark_activity_complete`; a deliverable rubric records quality but is not
 * itself a completion writer. Two places must agree on WHICH activities may use
 * that path, or they drift:
 *
 *   - tool EXPOSURE — `getSessionContext` builds `conversationCompletionContext`
 *     (gates whether the tool is even offered in http.ts), and
 *   - server ENFORCEMENT — `activityCompletions.markCompleteFromTool`
 *     re-validates the whole gate before writing.
 *
 * Historically both required `activity.lessonId`, which excluded EVERY ad-hoc
 * dispatch by construction: "Dispatch now" creates a lesson-less online
 * activity, so it could never register a completion and its assignment Debrief
 * read zero forever. This is the single source of truth those two callers share.
 */
import type { MutationCtx, QueryCtx } from "../_generated/server";
import type { Doc } from "../_generated/dataModel";

/**
 * Is this activity completable via the conversation-completion path?
 *
 * True when it's an ONLINE activity without an advance rubric that is NOT a test drive
 * (a rehearsal must never write a real completion), AND it is anchored either:
 *   - by a lesson (the original unit-run conversation activity), OR
 *   - by an ad-hoc dispatch: it's lesson-less but the session's assignment is a
 *     `kind: "adHocDispatch"` whose `activitySchedule` references this exact
 *     activity. That anchor is what lets a lesson-less dispatch complete without
 *     letting any orphan lesson-less activity complete.
 *
 * `activity` must be the session's activity (`session.activityId`).
 */
export async function isConversationCompletable(
  ctx: QueryCtx | MutationCtx,
  session: Doc<"sessions">,
  activity: Doc<"activities">,
): Promise<boolean> {
  // Shared base gate — identical for both anchoring shapes.
  if (!isConversationCompletableActivityShape(activity)) return false;
  if (session.isTestDrive) return false;

  // Lesson-anchored: the original conversation activity (current behavior).
  if (activity.lessonId) return true;

  // Lesson-less ad-hoc dispatch: needs an assignment anchor to be completable.
  if (!session.assignmentId || !session.activityId) return false;
  const assignment = await ctx.db.get(session.assignmentId);
  if (!assignment || assignment.kind !== "adHocDispatch") return false;
  const schedule = assignment.activitySchedule ?? [];
  return schedule.some(
    (e) => String(e.activityId) === String(session.activityId),
  );
}

/** Shape-only half of the completion gate for runtimes without a real session. */
export function isConversationCompletableActivityShape(
  activity: Doc<"activities">,
): boolean {
  return (
    activity.kind === "online" && !activity.advanceRubric
  );
}
