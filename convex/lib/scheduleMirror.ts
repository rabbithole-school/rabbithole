/**
 * MIGRATION SCAFFOLDING — mirrors `assignments.activitySchedule` into
 * `pushes` so the two can be compared before any reader switches over.
 * Deleted, with `activitySchedule` itself, at the end of
 * TODO.html#pushes-migrate-activity-schedule.
 *
 * Every write into `activitySchedule` funnels through a handful of `apply*`
 * helpers in assignments.ts. Each one calls `syncScheduleMirror` for the
 * activity it just touched, so the mirror cannot drift: there is no second
 * place a schedule entry can be written from.
 *
 * The derivation itself lives in lib/pushes.ts and is pure, so the
 * comparison test can exercise it without a database. This file only does
 * the reads and writes.
 */

import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { pushFieldsFromScheduleEntry, type ScheduleEntry } from "./pushes";

/**
 * The mirror row for one (assignment, activity, mode), if there is one.
 *
 * Scoped by `scheduleMirror` so a genuine push is never mistaken for a
 * mirror: makeFocus takes an optional assignmentId, so a teacher featuring
 * an activity can produce the very same (assignmentId, activityId) pair.
 *
 * Keyed on `blocking` as well because a schedule entry has no id of its
 * own, and activity alone is not unique: the seed carries an activity set
 * as homework now AND planned as a class focus later. The write paths
 * dedupe by activity so production should never have that, but collapsing
 * the two here would silently drop one, and `blocking` maps exactly onto
 * `mode` (classFocus blocks, homework does not).
 */
async function findMirror(
  ctx: MutationCtx,
  assignmentId: Id<"assignments">,
  activityId: Id<"activities">,
  blocking: boolean,
): Promise<Doc<"pushes"> | null> {
  const rows = await ctx.db
    .query("pushes")
    .withIndex("by_assignment", (q) => q.eq("assignmentId", assignmentId))
    .collect();
  return (
    rows.find(
      (p) =>
        p.scheduleMirror === true &&
        p.clearedAt === undefined &&
        p.blocking === blocking &&
        p.target.kind === "activity" &&
        p.target.activityId === activityId,
    ) ?? null
  );
}

/**
 * Which school this mirror belongs to.
 *
 * NOT the teacher's user doc: `users.institutionId` is scholars-only, so
 * reading it for a teacher silently yields undefined — which is exactly
 * the bug the drift counter caught, where the whole backfill wrote nothing.
 *
 * The roster is the right source. A push is matched against the SCHOLAR's
 * institution (pushCoversScholar), and `assignments` carries no institution
 * of its own, so taking it from the scholars the assignment already targets
 * is both faithful and impossible to mis-scope. Staff membership is the
 * fallback for an empty roster.
 */
async function institutionForAssignment(
  ctx: MutationCtx,
  a: Doc<"assignments">,
): Promise<Id<"institutions"> | null> {
  for (const scholarId of a.scholarIds) {
    const scholar = await ctx.db.get(scholarId);
    if (scholar?.institutionId) return scholar.institutionId;
  }
  const membership = await ctx.db
    .query("memberships")
    .withIndex("by_user", (q) => q.eq("userId", a.teacherId))
    .first();
  return membership?.institutionId ?? null;
}

/** Close every open mirror for an activity, whatever its mode. */
async function clearMirrorsForActivity(
  ctx: MutationCtx,
  a: Doc<"assignments">,
  activityId: Id<"activities">,
  clearedReason: "teacher" | "expired" | "superseded",
): Promise<void> {
  for (const blocking of [true, false]) {
    const existing = await findMirror(ctx, a._id, activityId, blocking);
    if (!existing) continue;
    await ctx.db.patch(existing._id, {
      clearedAt: Date.now(),
      clearedReason,
      scheduledFnId: undefined,
    });
  }
}

/**
 * Bring the mirror in line with `entry` — the schedule entry for this
 * activity AFTER the write, or null when the write removed it.
 *
 * `a` must be the assignment doc as it was READ, not re-fetched: the caller
 * has already patched `activitySchedule`, and everything this needs from the
 * assignment (`_id`, `teacherId`, and its roster) is unaffected by that patch.
 */
export async function syncScheduleMirror(
  ctx: MutationCtx,
  a: Doc<"assignments">,
  activityId: Id<"activities">,
  entry: ScheduleEntry | null,
  // Why the entry went away. `activitySchedule` cannot record this — it
  // deletes — which is exactly what the new table exists to fix, so it is
  // worth carrying through the mirror rather than flattening every removal
  // to "teacher".
  clearedReason: "teacher" | "expired" | "superseded" = "teacher",
): Promise<void> {
  if (!entry) {
    // The entry is gone. `activitySchedule` deletes outright; `pushes`
    // closes softly and keeps the record, which is the point of the new
    // table — so this is a clear, not a delete. Every removal path filters
    // by activityId alone, so both modes go together.
    await clearMirrorsForActivity(ctx, a, activityId, clearedReason);
    return;
  }

  const fields = pushFieldsFromScheduleEntry(a, entry);
  const existing = await findMirror(ctx, a._id, activityId, fields.blocking);
  const lifecycle = {
    setAt: entry.setAt,
    startsAt: entry.startsAt,
    // Deliberately NOT mirrored. The activation and auto-clear jobs are
    // owned by assignments.ts and act on `activitySchedule`; copying their
    // ids here would invite a second cancel path that could stop a job the
    // real schedule still depends on. The mirror's liveness is recomputed
    // at read time anyway (isPushLive re-checks the window).
    scheduledFnId: undefined,
  };

  if (existing) {
    await ctx.db.patch(existing._id, { ...fields, ...lifecycle });
    return;
  }

  // The teacher who owns the assignment, matching how the plate already
  // attributes a class-focus card (scholarPlate reads a.teacherId).
  const institutionId = await institutionForAssignment(ctx, a);
  if (!institutionId) {
    // Skip, loudly in the logs — but NEVER throw. This is a bookkeeping copy
    // riding along inside somebody else's mutation: a teacher setting a class
    // focus, a scholar being enrolled, the master schedule placing a class. If
    // the copy throws, the whole transaction rolls back and the teaching
    // action itself fails. An assignment with no resolvable school is still a
    // data problem worth surfacing, so it is counted as DRIFT by the backfill's
    // reconciliation report (`migrations:countSchedulePushMirrorDrift`), which is the
    // right place to notice it — not at the expense of the write in progress.
    console.warn(
      `[scheduleMirror] skipped assignment ${a._id}: ` +
        `no institution on its roster or its teacher's memberships.`,
    );
    return;
  }

  await ctx.db.insert("pushes", {
    institutionId,
    ...fields,
    ...lifecycle,
    assignmentId: a._id,
    pushedBy: a.teacherId,
    scheduleMirror: true,
  });
}

/**
 * The whole-schedule form, for a write that can touch many entries at once
 * (a roster change prunes or drops per-activity targeting across the board).
 *
 * `next` is the schedule as written. Any mirror with no matching entry in
 * `next` is cleared. Keyed on (activity, mode) throughout, for the same
 * reason findMirror is: a schedule entry has no id of its own.
 */
export async function syncScheduleMirrorAll(
  ctx: MutationCtx,
  a: Doc<"assignments">,
  next: ReadonlyArray<ScheduleEntry>,
): Promise<void> {
  const key = (activityId: Id<"activities">, blocking: boolean) =>
    `${activityId}:${blocking}`;

  const wanted = new Map<string, ScheduleEntry>();
  for (const entry of next) {
    wanted.set(key(entry.activityId, entry.mode === "classFocus"), entry);
  }

  const mirrors = await ctx.db
    .query("pushes")
    .withIndex("by_assignment", (q) => q.eq("assignmentId", a._id))
    .collect();

  for (const push of mirrors) {
    if (push.scheduleMirror !== true) continue;
    if (push.clearedAt !== undefined) continue;
    if (push.target.kind !== "activity") continue;
    if (wanted.has(key(push.target.activityId, push.blocking))) continue;
    // Live mirror, no matching entry: the teacher took it off the schedule.
    await ctx.db.patch(push._id, {
      clearedAt: Date.now(),
      clearedReason: "teacher",
      scheduledFnId: undefined,
    });
  }

  // Upsert everything still on the schedule. syncScheduleMirror finds its
  // own row by (activity, mode), so this both updates and creates.
  for (const entry of next) {
    await syncScheduleMirror(ctx, a, entry.activityId, entry);
  }
}
