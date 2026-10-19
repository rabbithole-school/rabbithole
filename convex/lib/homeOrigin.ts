// Where a session sits on the scholar Home — one rule shared by the active
// plate (scholarPlate.activeForMe) and the Archived list
// (sessions.finishedForScholar), so a session never changes tab when it is
// archived (review/home-finished-filter.html).

import type { Doc, Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import { isAppActivity } from "../../shared/appSurface";
import { sessionHasCodeArtifact } from "./teacherArchive";

/**
 * The mode assigned work runs in for this scholar: the last live pushed entry
 * for the activity wins; with none live, the first expired one; a self-paced
 * assignment with no push reads as class focus. `undefined` when the
 * assignment is archived, doesn't include the scholar, or never pushed the
 * activity to them.
 */
export function assignedWorkMode(
  assignment: Doc<"assignments"> | null | undefined,
  activityId: Id<"activities">,
  scholarId: Id<"users">,
  now: number,
): "classFocus" | "homework" | undefined {
  if (
    !assignment ||
    assignment.archivedAt ||
    !assignment.scholarIds.some((id) => String(id) === String(scholarId))
  ) {
    return undefined;
  }
  let live: "classFocus" | "homework" | undefined;
  let firstExpired: "classFocus" | "homework" | undefined;
  for (const entry of assignment.activitySchedule ?? []) {
    // Planned-but-never-pushed entries are invisible to scholars.
    if (entry.setAt == null) continue;
    if (String(entry.activityId) !== String(activityId)) continue;
    // Per-scholar targeting: absent/empty scholarIds = cohort-wide.
    if (
      entry.scholarIds != null &&
      entry.scholarIds.length > 0 &&
      !entry.scholarIds.some((id) => String(id) === String(scholarId))
    ) {
      continue;
    }
    const expired = entry.endsAt != null && entry.endsAt <= now;
    if (!expired) live = entry.mode;
    else firstExpired ??= entry.mode;
  }
  return live ?? firstExpired ?? (assignment.selfPaced ? "classFocus" : undefined);
}

/**
 * Does this session hold an app the scholar built? Only a session that could
 * hold one is probed for its code artifact: an app activity's session, or an
 * activity-less one (a free build or an open exploration). An ordinary
 * activity's chat is never probed, so its code writes don't re-run the hot
 * plate query. Decided from the activity, never the session's builder mode
 * (TRA-519, convex/__tests__/noRawAppKindChecks.test.ts).
 */
export async function isBuiltAppSession(
  ctx: Pick<QueryCtx, "db">,
  session: Pick<Doc<"sessions">, "_id" | "activityId">,
  activity: Pick<Doc<"activities">, "kind" | "appActivity"> | null,
): Promise<boolean> {
  return (
    couldHoldBuiltApp(session, activity) &&
    (await sessionHasCodeArtifact(ctx, session._id))
  );
}

/** The no-read half of isBuiltAppSession: could this session hold an app the
 *  scholar built? A caller that reads the artifact itself (the teacher Apps
 *  page) asks this first, so it never reads one twice. */
export function couldHoldBuiltApp(
  session: Pick<Doc<"sessions">, "activityId">,
  activity: Pick<Doc<"activities">, "kind" | "appActivity"> | null,
): boolean {
  return !session.activityId || isAppActivity(activity);
}
