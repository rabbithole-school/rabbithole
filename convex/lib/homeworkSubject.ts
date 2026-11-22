// The subject a piece of given work is labeled with (TRA-581): ONE resolver
// for the teacher's Homework planner, the family Homework tab and the family
// Portfolio's subject groups, so a give reads the same everywhere
// (product-taste T1).
//
// ONE rule on every screen (TRA-721, the scholar's list included): the give's
// class (`pushes.classId`, its `classes` row's subject), then the unit's
// subject. The unit is found through the activity's lesson, or, for work that
// isn't an activity, the assignment's unit. The timetable placement is not a
// step: a give gets its class when it is made, and a placement's subject is
// a different answer to the same question. A LABEL may finally fall back to the unit's title; a subject GROUP
// may not, because a unit title is not a subject.
//
// A give's class is the FIRST schedule row's class for its (activity, mode)
// (`firstClassIdByWork`), so every surface picks the same row.

import type { Doc, Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";

/**
 * The subject a piece of work is LABELED with, for a person to read: the
 * filed class's subject, then the unit's subject, then the unit or assignment
 * title (TRA-721: the order every screen uses, lib/homeworkSubject.ts).
 * Unlike `resolveScholarWorkSubject` (which decides a subject TAB and may answer null so the row lands under Other), this always
 * names something when anything is known. Kept for callers that have only
 * the raw candidates; the screens use `homeworkSubjectLabel`.
 */
export function workSubjectLabel(
  ...candidates: Array<string | null | undefined>
): string | null {
  for (const candidate of candidates) {
    const trimmed = candidate?.trim();
    if (trimmed) return trimmed;
  }
  return null;
}

/** `${activityId}|${mode}` — one give of an assignment's activity. */
export function scheduleWorkKey(
  activityId: Id<"activities">,
  mode: "homework" | "classFocus",
): string {
  return `${activityId}|${mode}`;
}

/** The class each give names: the first schedule row (by creation) for each
 *  (activity, mode), even when that row names no class. */
export function firstClassIdByWork(
  rows: Doc<"pushes">[],
): Map<string, Id<"classes"> | undefined> {
  const classIds = new Map<string, Id<"classes"> | undefined>();
  for (const push of [...rows].sort(
    (x, y) => x._creationTime - y._creationTime,
  )) {
    if (push.target.kind !== "activity") continue;
    const mode = push.timing.kind === "homework" ? "homework" : "classFocus";
    const key = scheduleWorkKey(push.target.activityId, mode);
    if (!classIds.has(key)) classIds.set(key, push.classId);
  }
  return classIds;
}

type WorkSubjectArgs = {
  classId?: Id<"classes"> | null;
  activityId?: Id<"activities"> | null;
  /** The unit for work that isn't an activity (an app, link or resource). */
  unitId?: Id<"units"> | null;
};

async function workSubjectSources(
  ctx: Pick<QueryCtx, "db">,
  args: WorkSubjectArgs,
): Promise<{
  classSubject: string | null;
  unit: Doc<"units"> | null;
}> {
  const cls = args.classId ? await ctx.db.get(args.classId) : null;
  let unitId = args.unitId ?? null;
  if (args.activityId) {
    const activity = await ctx.db.get(args.activityId);
    const lesson = activity?.lessonId ? await ctx.db.get(activity.lessonId) : null;
    unitId = lesson?.unitId ?? unitId;
  }
  const unit = unitId ? await ctx.db.get(unitId) : null;
  return {
    classSubject: cls?.subject ?? null,
    unit,
  };
}

export async function homeworkSubjectLabel(
  ctx: Pick<QueryCtx, "db">,
  args: WorkSubjectArgs,
): Promise<string | null> {
  const { classSubject, unit } = await workSubjectSources(
    ctx,
    args,
  );
  return workSubjectLabel(classSubject, unit?.subject, unit?.title);
}

/** The subject itself — the same chain as `homeworkSubjectLabel` without the
 *  unit-title fallback. Null when nobody recorded a subject for the work. */
export async function workSubjectName(
  ctx: Pick<QueryCtx, "db">,
  args: WorkSubjectArgs,
): Promise<string | null> {
  const { classSubject, unit } = await workSubjectSources(
    ctx,
    args,
  );
  return workSubjectLabel(classSubject, unit?.subject);
}
