/**
 * THE assignment schedule store (Linear TRA-13).
 *
 * An assignment's per-activity schedule lives in `pushes`: one row per
 * (activity, mode), marked `scheduleMirror: true` (`isScheduleRow` in
 * lib/pushes). There is no other copy.
 *
 * WRITES. Every change to a schedule goes through `writeSchedule`: the caller
 * reads the schedule with `readSchedule`, computes the next one in the entry
 * shape it always used, and hands it here. `planScheduleWrites` diffs it
 * against the stored rows. Deleting an assignment closes its rows with
 * `closeScheduleForAssignment`.
 *
 * READS. `readSchedule` is the ONE way to get an assignment's schedule.
 *
 * The entry <-> row derivation lives in lib/pushes.ts and is pure.
 */

import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { primaryInstitutionId } from "./primaryInstitution";
import {
  classFieldsForPush, classLinkInputsChanged, endFieldsForPush, homeworkClassFields,
  unitSubjectForWork,
  loadClassLinkData, type ClassLinkReadCache,
} from "./classLink";
import { GiveQuestionError } from "./giveQuestionError";
import { isOpenUntilByDate } from "../../shared/openUntil";
import {
  isOpenUntilKind,
  isScheduleRow,
  isWithdrawnHomeworkEntry,
  assertPushAllowed,
  pushFieldsFromScheduleEntry,
  scheduleEntryFromPush,
  scheduleEntryKey,
  type ScheduleEntry,
} from "./pushes";

// ───────────────────────────── reads ─────────────────────────────

/** Any ctx that can read the database. */
export type ScheduleReadCtx = { db: QueryCtx["db"] };

/**
 * Every schedule row that stands for a current entry: the open ones plus the
 * closed withdrawn-homework ones. Two indexed reads; neither scans the
 * assignment's cleared history.
 */
export async function loadScheduleRows(
  ctx: { db: QueryCtx["db"] },
  assignmentId: Id<"assignments">,
): Promise<Doc<"pushes">[]> {
  const open = await ctx.db
    .query("pushes")
    .withIndex("by_assignment_cleared", (q) =>
      q.eq("assignmentId", assignmentId).eq("clearedAt", undefined),
    )
    .collect();
  const withdrawn = await ctx.db
    .query("pushes")
    .withIndex("by_assignment_withdrawn", (q) =>
      q.eq("assignmentId", assignmentId).eq("scheduleWithdrawn", true),
    )
    .collect();
  return [...open, ...withdrawn].filter(isScheduleRow);
}

/** A per-request memo for `readSchedule`, for readers that revisit assignments
 *  (concurrent readers share one pending read). */
export type ScheduleCache = Map<string, Promise<ScheduleEntry[]>>;

/**
 * An assignment's schedule, in the entry shape every reader and writer uses,
 * one entry per (activity, mode).
 *
 * ORDER (the one rule; readers that take the first match rely on it to pick
 * "the one that counts"): MOST RECENTLY ACTIVATED FIRST.
 *   1. Live entries (`setAt` stamped) come before planned ones, newest
 *      `setAt` first: the latest thing a teacher put in front of scholars is
 *      the one that counts.
 *   2. Then planned entries, soonest planned start (`startsAt`) first, the
 *      agenda's order; an undated planned entry comes after every dated one.
 *   3. Ties: the row created first, then the row id, so the order is total
 *      and the same on every read. A whole unit given at once activates
 *      together, so this keeps it in unit order.
 * Readers that pick one entry for an activity apply this rule; lib/homeOrigin
 * `decidingMode` adds two refinements (a live entry beats an expired one, and
 * a `setAt` tie goes to homework).
 */
export async function readSchedule(
  ctx: ScheduleReadCtx,
  a: Pick<Doc<"assignments">, "_id">,
  cache?: ScheduleCache,
  /** The assignment's `loadScheduleRows`, when the caller already holds them
   *  (saves a second read of the same rows). */
  rows?: Doc<"pushes">[],
): Promise<ScheduleEntry[]> {
  if (!cache) return readScheduleUncached(ctx, a._id, rows);
  const memoKey = String(a._id);
  let pending = cache.get(memoKey);
  if (!pending) {
    pending = readScheduleUncached(ctx, a._id, rows);
    cache.set(memoKey, pending);
  }
  return pending;
}

async function readScheduleUncached(
  ctx: ScheduleReadCtx,
  assignmentId: Id<"assignments">,
  loaded?: Doc<"pushes">[],
): Promise<ScheduleEntry[]> {
  const rows = [...(loaded ?? (await loadScheduleRows(ctx, assignmentId)))];
  rows.sort((x, y) => x._creationTime - y._creationTime);
  const byKey = new Map<string, ScheduleOrderItem>();
  for (const push of rows) {
    const entry = scheduleEntryFromPush(push);
    if (!entry) continue;
    const key = scheduleEntryKey(entry.activityId, entry.mode);
    if (!byKey.has(key)) {
      byKey.set(key, { entry, created: push._creationTime, id: push._id });
    }
  }
  return [...byKey.values()].sort(compareScheduleOrder).map((x) => x.entry);
}

/** An entry plus the row facts the `readSchedule` order needs. */
export type ScheduleOrderItem = {
  entry: ScheduleEntry;
  created: number;
  id: string;
};

/** The `readSchedule` order; see its doc comment. */
export function compareScheduleOrder(
  x: ScheduleOrderItem,
  y: ScheduleOrderItem,
): number {
  // An absent value sorts after every present one.
  const present = (a: number | undefined, b: number | undefined) =>
    a === b ? 0 : a === undefined ? 1 : b === undefined ? -1 : null;
  const newestFirst = (a: number | undefined, b: number | undefined) =>
    present(a, b) ?? b! - a!;
  const soonestFirst = (a: number | undefined, b: number | undefined) =>
    present(a, b) ?? a! - b!;
  const live = x.entry.setAt != null; // both, once setAt compares equal
  return (
    newestFirst(x.entry.setAt, y.entry.setAt) ||
    (live ? 0 : soonestFirst(x.entry.startsAt, y.entry.startsAt)) ||
    x.created - y.created ||
    (x.id < y.id ? -1 : x.id > y.id ? 1 : 0)
  );
}

/**
 * Is this activity on any assignment's schedule (planned, live, or withdrawn
 * homework)?
 */

export async function anyScheduleReferencesActivity(
  ctx: ScheduleReadCtx,
  activityId: Id<"activities">,
): Promise<boolean> {
  return (await assignmentsSchedulingActivity(ctx, activityId)).length > 0;
}

/**
 * The assignments whose schedule includes this activity: its open rows plus
 * its withdrawn-homework rows, two indexed reads that never scan history.
 */
export async function assignmentsSchedulingActivity(
  ctx: ScheduleReadCtx,
  activityId: Id<"activities">,
): Promise<Id<"assignments">[]> {
  const open = await ctx.db
    .query("pushes")
    .withIndex("by_target_activity_cleared", (q) =>
      q.eq("target.activityId", activityId).eq("clearedAt", undefined),
    )
    .collect();
  const withdrawn = await ctx.db
    .query("pushes")
    .withIndex("by_target_activity_withdrawn", (q) =>
      q.eq("target.activityId", activityId).eq("scheduleWithdrawn", true),
    )
    .collect();
  const ids = new Map<string, Id<"assignments">>();
  for (const p of [...open, ...withdrawn]) {
    if (!isScheduleRow(p) || p.assignmentId === undefined) continue;
    ids.set(String(p.assignmentId), p.assignmentId);
  }
  return [...ids.values()];
}


// ───────────────────────────── writes ─────────────────────────────

/** The stored shape the row for `entry` must have (minus identity fields). */
function desiredRow(a: Doc<"assignments">, entry: ScheduleEntry) {
  const withdrawn = isWithdrawnHomeworkEntry(entry);
  const fields = pushFieldsFromScheduleEntry(a, entry);
  // The write boundary every push writer shares (TRA-336). A schedule entry
  // is always an activity, so today this only re-checks blocking; it keeps a
  // future non-activity mapping from writing an app give that never ends.
  assertPushAllowed(fields);
  return {
    ...fields,
    setAt: entry.setAt,
    startsAt: entry.startsAt,
    // The pending activation / auto-clear job, so reschedule and clear can
    // cancel it.
    scheduledFnId: entry.scheduledFnId,
    clearedAt: withdrawn ? entry.endsAt : undefined,
    clearedReason: withdrawn ? ("teacher" as const) : undefined,
    scheduleWithdrawn: withdrawn ? true : undefined,
    // Homework given for a named class: compared and stamped only when the
    // entry names one, so an unnamed rewrite leaves the derived link alone.
    ...(entry.mode === "homework" && entry.homeworkClassId
      ? { classId: entry.homeworkClassId, classSource: "chosen" as const }
      : {}),
  };
}

/**
 * Homework's class link found from the meeting at its start, marked as such
 * so a later move derives it again (TRA-581). No class, no marker.
 */
function meetingLink<T extends { classId: Id<"classes"> | undefined }>(
  fields: T,
): T & { classSource: "meeting" | undefined } {
  return { ...fields, classSource: fields.classId ? "meeting" : undefined };
}

/**
 * Was this homework row's class chosen (by the teacher or the aide's class
 * pick) rather than found from a meeting? Stored since TRA-581's follow-up.
 * Older rows carry no marker, so for them it is inferred as before: chosen
 * when a meeting at the row's current start would NOT give that class.
 */
async function homeworkClassWasChosen(
  ctx: MutationCtx,
  push: Doc<"pushes">,
  cohortRoster: readonly Id<"users">[],
  cache: ClassLinkReadCache,
): Promise<boolean> {
  if (push.timing.kind !== "homework" || !push.classId) return false;
  if (push.classSource !== undefined) return push.classSource === "chosen";
  const { timeZone } = await loadClassLinkData(ctx, push.institutionId, cache);
  const meeting = await classFieldsForPush(ctx, {
    institutionId: push.institutionId,
    audience: push.audience,
    at: push.startsAt ?? push.setAt,
    timeZone,
    timingKind: "homework",
    cohortRoster,
  }, cache);
  return meeting.classId !== push.classId;
}

type DesiredRow = ReturnType<typeof desiredRow>;

/** Recursive key sort, dropping undefined, for a stored-vs-wanted compare. */
function canonical(value: unknown): string {
  return JSON.stringify(value, (_k, v) =>
    v && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(
          Object.entries(v as Record<string, unknown>)
            .filter(([, x]) => x !== undefined)
            .sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0)),
        )
      : v,
  );
}

function rowMatches(existing: Doc<"pushes">, want: DesiredRow, kindUnsaid: boolean): boolean {
  return (Object.keys(want) as Array<keyof DesiredRow>).every((k) =>
    k === "timing" && kindUnsaid && want.timing.kind === "focus" && isOpenUntilKind(existing)
      // A writer that didn't say leaves an `openUntil` row's kind alone.
      ? true
      : canonical(existing[k]) === canonical(want[k]),
  );
}

/**
 * Is this the timed focus of an entry that didn't give the teacher's finish
 * (`openUntilKind` absent: a seed, a dev tool, an older client's raw
 * mode/endsAt)? Every give path says (TRA-726 step 2).
 */
function kindUnsaidFor(entry: ScheduleEntry): boolean {
  return entry.mode === "classFocus" && entry.endsAt !== undefined &&
    entry.openUntilKind === undefined;
}

/**
 * The timing kind a row is stored with. The entry's own answer when it gave
 * one. When it didn't, the dates decide, as every reader did before the kind
 * existed: a focus ending on a later school day than it starts is stored as
 * `openUntil`, and the store logs it so a writer that still doesn't say shows
 * up in the logs (TRA-726; retired with the date guess in step 3).
 */
export function storedKind(
  want: Pick<DesiredRow, "timing" | "setAt" | "startsAt"> & { endsAt?: number },
  kindUnsaid: boolean,
  timeZone: string,
): DesiredRow["timing"]["kind"] {
  if (!kindUnsaid || want.timing.kind !== "focus") return want.timing.kind;
  const byDate = isOpenUntilByDate(
    { mode: "classFocus", setAt: want.setAt, startsAt: want.startsAt, endsAt: want.endsAt },
    timeZone,
  );
  if (!byDate) return "focus";
  console.warn(
    "[TRA-726] a schedule write gave no finish for a focus that ends on a later day; stored as openUntil by its dates",
  );
  return "openUntil";
}

function rowKey(push: Doc<"pushes">): string | null {
  if (push.target.kind !== "activity") return null;
  return scheduleEntryKey(
    push.target.activityId,
    push.blocking ? "classFocus" : "homework",
  );
}

export type ScheduleRowOp =
  | { kind: "create"; want: DesiredRow; kindUnsaid: boolean }
  | { kind: "update"; push: Doc<"pushes">; want: DesiredRow; kindUnsaid: boolean }
  | { kind: "close"; push: Doc<"pushes"> }
  | { kind: "retire"; push: Doc<"pushes"> };

export type ScheduleWritePlan = {
  ops: ScheduleRowOp[];
  /** Same (activity, mode) entries beyond the first; stored as one. */
  duplicateEntries: number;
};

/**
 * THE diff between a schedule and its rows. Pure.
 * Every write uses it, so there is exactly one rule:
 *
 *  - one row per (activity, mode); the FIRST entry for a key wins,
 *    which is the entry every reader's `.find` returns;
 *  - an open row whose entry is gone is CLOSED (rows are never deleted);
 *  - a withdrawn row whose entry is gone is RETIRED (marker removed);
 *  - an entry becoming withdrawn closes its open row in place;
 *  - a withdrawn entry given again gets a fresh open row.
 *
 * `onlyActivityId` limits the diff to one activity's keys.
 */
export function planScheduleWrites(
  a: Doc<"assignments">,
  schedule: ReadonlyArray<ScheduleEntry>,
  rows: ReadonlyArray<Doc<"pushes">>,
  onlyActivityId?: Id<"activities">,
): ScheduleWritePlan {
  const inScope = (activityId: Id<"activities">) =>
    onlyActivityId === undefined || activityId === onlyActivityId;

  const wanted = new Map<string, ScheduleEntry>();
  let duplicateEntries = 0;
  for (const entry of schedule) {
    if (!inScope(entry.activityId)) continue;
    const key = scheduleEntryKey(entry.activityId, entry.mode);
    if (wanted.has(key)) {
      duplicateEntries += 1;
      continue;
    }
    wanted.set(key, entry);
  }

  const ops: ScheduleRowOp[] = [];
  const existingByKey = new Map<string, Doc<"pushes">>();
  const sorted = [...rows].sort((x, y) => x._creationTime - y._creationTime);
  for (const push of sorted) {
    if (push.target.kind !== "activity" || !inScope(push.target.activityId)) {
      continue;
    }
    const key = rowKey(push)!;
    const retireOrClose = (): ScheduleRowOp =>
      push.clearedAt === undefined
        ? { kind: "close", push }
        : { kind: "retire", push };
    const entry = wanted.get(key);
    if (!entry || existingByKey.has(key)) {
      // No entry, or a second row for one key.
      ops.push(retireOrClose());
      continue;
    }
    // A withdrawn row cannot become live again: the entry was re-given.
    if (push.scheduleWithdrawn === true && !isWithdrawnHomeworkEntry(entry)) {
      ops.push({ kind: "retire", push });
      continue;
    }
    existingByKey.set(key, push);
  }

  for (const [key, entry] of wanted) {
    const want = desiredRow(a, entry);
    const kindUnsaid = kindUnsaidFor(entry);
    const existing = existingByKey.get(key);
    if (!existing) ops.push({ kind: "create", want, kindUnsaid });
    else if (!rowMatches(existing, want, kindUnsaid)) {
      ops.push({ kind: "update", push: existing, want, kindUnsaid });
    }
  }
  return { ops, duplicateEntries };
}

/**
 * Which school a row belongs to: the roster's, else the teacher's
 * membership, else (a legacy roster with no school) the primary school.
 * NOT the teacher's user doc: `users.institutionId` is scholars-only.
 * `readSchedule` matches by assignment, never by institution, so the last
 * resort is bookkeeping only.
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
  if (membership?.institutionId) return membership.institutionId;
  return await primaryInstitutionId(ctx);
}

export type ScheduleWriteCounts = {
  created: number;
  updated: number;
  cleared: number;
  skipped: number;
  duplicateEntries: number;
};

async function applyPlan(
  ctx: MutationCtx,
  a: Doc<"assignments">,
  plan: ScheduleWritePlan,
  clearedReason: "teacher" | "expired" | "superseded",
  classLinkCache: ClassLinkReadCache,
): Promise<ScheduleWriteCounts> {
  const counts: ScheduleWriteCounts = {
    created: 0,
    updated: 0,
    cleared: 0,
    skipped: 0,
    duplicateEntries: plan.duplicateEntries,
  };
  let institutionId: Id<"institutions"> | null | undefined;
  for (const op of plan.ops) {
    if (op.kind === "close") {
      await ctx.db.patch(op.push._id, {
        clearedAt: Date.now(),
        clearedReason,
        scheduledFnId: undefined,
      });
      counts.cleared += 1;
    } else if (op.kind === "retire") {
      await ctx.db.patch(op.push._id, { scheduleWithdrawn: undefined });
      counts.cleared += 1;
    } else if (op.kind === "update") {
      const linkChanged = classLinkInputsChanged(op.push, op.want);
      // The stored kind: the entry's answer, or for an entry that didn't say,
      // the row's own `openUntil` while its end stays put, else the dates
      // (`storedKind`, TRA-726).
      const timing: DesiredRow["timing"] =
        !op.kindUnsaid || op.want.timing.kind !== "focus"
          ? op.want.timing
          : isOpenUntilKind(op.push) && op.push.endsAt === op.want.endsAt
            ? { kind: "openUntil" }
            : {
                kind: storedKind(
                  op.want, true,
                  (await loadClassLinkData(ctx, op.push.institutionId, classLinkCache)).timeZone,
                ),
              };
      // Kind + end (`timing` holds only the kind). An untimed focus's end
      // follows its start, so a moved start is a change.
      const endChanged = op.push.timing.kind !== timing.kind ||
        op.push.afterEnd !== op.want.afterEnd ||
        ("endsAt" in op.want && op.push.endsAt !== op.want.endsAt) ||
        op.push.startsAt !== op.want.startsAt || op.push.setAt !== op.want.setAt;
      // Homework filed under a CHOSEN class keeps it when it moves (TRA-581):
      // a reschedule, "start now" or a narrowed audience doesn't re-file it
      // under whatever class meets at the new time. The entry's named class
      // wins; else the row's own class when the row says it was chosen (an
      // older row without the marker: inferred), re-checked and dropped if it
      // no longer passes the class checks. A meeting-derived link is derived
      // again: moved out of its meeting, it clears.
      const isHomework = op.want.timing.kind === "homework";
      let namedClass = isHomework ? op.want.classId : undefined;
      let derived: Partial<Doc<"pushes">> = {};
      if (namedClass) {
        derived = {
          ...await homeworkClassFields(ctx, {
            institutionId: op.push.institutionId,
            classId: namedClass,
            audience: op.want.audience,
            at: op.want.startsAt ?? op.want.setAt,
            cohortRoster: a.scholarIds,
          }, classLinkCache),
          classSource: "chosen",
        };
      } else if (
        isHomework && linkChanged && op.push.classId &&
        await homeworkClassWasChosen(ctx, op.push, a.scholarIds, classLinkCache)
      ) {
        const kept = await homeworkClassFields(ctx, {
          institutionId: op.push.institutionId,
          classId: op.push.classId,
          audience: op.want.audience,
          at: op.want.startsAt ?? op.want.setAt,
          cohortRoster: a.scholarIds,
        }, classLinkCache).catch((error: unknown) => {
          if (error instanceof GiveQuestionError) return null;
          throw error;
        });
        if (kept) {
          derived = { ...kept, classSource: "chosen" };
          namedClass = kept.classId;
        }
      }
      if (endChanged || (linkChanged && !namedClass)) {
        const { timeZone } = await loadClassLinkData(ctx, op.push.institutionId, classLinkCache);
        let relinked: Partial<Doc<"pushes">> = {};
        if (linkChanged && !namedClass) {
          const fields = await classFieldsForPush(ctx, {
            institutionId: op.push.institutionId,
            audience: op.want.audience,
            at: op.want.startsAt ?? op.want.setAt,
            timeZone,
            timingKind: op.want.timing.kind,
            cohortRoster: a.scholarIds,
            unitSubject: await unitSubjectForWork(ctx, { assignmentId: a._id }),
          }, classLinkCache);
          relinked = isHomework ? meetingLink(fields) : fields;
        }
        derived = {
          ...(endChanged ? endFieldsForPush(
            op.want.timing.kind, op.want.endsAt, op.want.setAt, op.want.startsAt, timeZone,
          ) : {}),
          ...derived,
          ...relinked,
        };
      }
      await ctx.db.patch(op.push._id, {
        ...op.want,
        ...derived,
        timing,
      });
      counts.updated += 1;
    } else {
      institutionId ??= await institutionForAssignment(ctx, a);
      if (!institutionId) {
        // This is the store now, not a copy: refusing beats a give that
        // silently never happened.
        throw new Error(
          `Can't schedule work on assignment ${a._id}: it belongs to no school.`,
        );
      }
      const { timeZone } = await loadClassLinkData(ctx, institutionId, classLinkCache);
      await ctx.db.insert("pushes", {
        institutionId,
        ...op.want,
        timing: { kind: storedKind(op.want, op.kindUnsaid, timeZone) },
        ...endFieldsForPush(
          op.want.timing.kind, op.want.endsAt, op.want.setAt, op.want.startsAt,
          timeZone,
        ),
        ...await (async () => {
          const isHomework = op.want.timing.kind === "homework";
          if (isHomework && op.want.classId) {
            return {
              ...await homeworkClassFields(ctx, {
                institutionId,
                classId: op.want.classId,
                audience: op.want.audience,
                at: op.want.startsAt ?? op.want.setAt,
                cohortRoster: a.scholarIds,
              }, classLinkCache),
              classSource: "chosen" as const,
            };
          }
          const fields = await classFieldsForPush(ctx, {
            institutionId,
            audience: op.want.audience,
            at: op.want.startsAt ?? op.want.setAt,
            timeZone,
            timingKind: op.want.timing.kind,
            cohortRoster: a.scholarIds,
            unitSubject: await unitSubjectForWork(ctx, { assignmentId: a._id }),
          }, classLinkCache);
          return isHomework ? meetingLink(fields) : fields;
        })(),
        assignmentId: a._id,
        // The assignment's teacher, as the plate attributes a class focus.
        pushedBy: a.teacherId,
        // The schedule-row marker (`isScheduleRow`). Kept through TRA-575 so
        // #4506's rollback, whose rebuild reads only flagged rows, stays valid.
        scheduleMirror: true,
      });
      counts.created += 1;
    }
  }
  return counts;
}

/**
 * Store an assignment's schedule. `next` is the WHOLE schedule as the caller
 * wants it (normally `readSchedule` plus the caller's change). With
 * `activityId`, only that activity's rows are touched.
 *
 * `clearedReason` says why an entry that went away went away (an auto-clear
 * job passes "expired").
 */
export async function writeSchedule(
  ctx: MutationCtx,
  assignment: Doc<"assignments"> | Id<"assignments">,
  next: ReadonlyArray<ScheduleEntry>,
  opts: {
    activityId?: Id<"activities">;
    clearedReason?: "teacher" | "expired" | "superseded";
    classLinkCache?: ClassLinkReadCache;
  } = {},
): Promise<ScheduleWriteCounts> {
  const a =
    typeof assignment === "string" ? await ctx.db.get(assignment) : assignment;
  if (!a) throw new Error(`Assignment ${String(assignment)} not found.`);
  const rows = await loadScheduleRows(ctx, a._id);
  return applyPlan(
    ctx,
    a,
    planScheduleWrites(a, next, rows, opts.activityId),
    opts.clearedReason ?? "teacher",
    opts.classLinkCache ?? new Map(),
  );
}

/**
 * Close every schedule row of an assignment that is being DELETED, and cancel
 * its pending jobs. Reads would no longer find the rows (they are looked up
 * by assignment), but an open row still counts in institution-wide push reads.
 */
export async function closeScheduleForAssignment(
  ctx: MutationCtx,
  assignmentId: Id<"assignments">,
): Promise<void> {
  for (const push of await loadScheduleRows(ctx, assignmentId)) {
    if (push.scheduledFnId) await ctx.scheduler.cancel(push.scheduledFnId);
    await ctx.db.patch(push._id, {
      ...(push.clearedAt === undefined
        ? { clearedAt: Date.now(), clearedReason: "teacher" as const }
        : {}),
      scheduleWithdrawn: undefined,
      scheduledFnId: undefined,
    });
  }
}
