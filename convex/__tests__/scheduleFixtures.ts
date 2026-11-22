import type { TestConvex } from "convex-test";
import type schema from "../schema";
import { internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import type { ScheduleEntry } from "../lib/pushes";
import {
  loadScheduleRows,
  planScheduleWrites,
  writeSchedule,
} from "../lib/scheduleStore";

// Test fixtures for an assignment's schedule (Linear TRA-13, TRA-575).
//
// The schedule lives only in `pushes` rows (lib/scheduleStore). A fixture that
// wants an assignment with a schedule inserts it with
// `insertAssignmentWithSchedule` (or sets one later with `setSchedule`), which
// stores the entries through the production write path, `writeSchedule`.

type Harness = TestConvex<typeof schema>;

type AssignmentFields = Omit<Doc<"assignments">, "_id" | "_creationTime">;

/** Insert an assignment and store `activitySchedule` as its schedule. */
export async function insertAssignmentWithSchedule(
  ctx: MutationCtx,
  doc: AssignmentFields & { activitySchedule?: ScheduleEntry[] },
): Promise<Id<"assignments">> {
  const { activitySchedule, ...fields } = doc;
  const id = await ctx.db.insert("assignments", fields);
  if (activitySchedule !== undefined) await setSchedule(ctx, id, activitySchedule);
  return id;
}

/** Patch an assignment and store `activitySchedule` as its schedule. */
export async function patchAssignmentWithSchedule(
  ctx: MutationCtx,
  assignmentId: Id<"assignments">,
  patch: Partial<AssignmentFields> & { activitySchedule?: ScheduleEntry[] },
): Promise<void> {
  const { activitySchedule, ...fields } = patch;
  if (Object.keys(fields).length > 0) await ctx.db.patch(assignmentId, fields);
  if (activitySchedule !== undefined) await setSchedule(ctx, assignmentId, activitySchedule);
}

/**
 * Store `entries` as the assignment's whole schedule, through `writeSchedule`.
 *
 * Production always has a primary school, so a schedule always has a school to
 * be filed under. A few legacy fixtures must run with NO institutions at all
 * (adding the default schools changes what they test: learning-community
 * checks start applying). For those, the rows are filed under a temporary
 * non-primary fixture school that is removed again, so the fixture still has
 * no school. Readers match rows by assignment, never by institution.
 */
export async function setSchedule(
  ctx: MutationCtx,
  assignmentId: Id<"assignments">,
  entries: ReadonlyArray<ScheduleEntry>,
): Promise<void> {
  if ((await ctx.db.query("institutions").first()) !== null) {
    await writeSchedule(ctx, assignmentId, entries);
    return;
  }
  const a = (await ctx.db.get(assignmentId))!;
  const fixtureSchool = await ctx.db.insert("institutions", {
    name: "Fixture school (no defaults)",
    slug: "fixture-no-defaults",
    kind: "school",
  });
  const plan = planScheduleWrites(
    a,
    entries,
    await loadScheduleRows(ctx, assignmentId),
  );
  for (const op of plan.ops) {
    if (op.kind === "create") {
      await ctx.db.insert("pushes", {
        institutionId: fixtureSchool,
        ...op.want,
        assignmentId,
        pushedBy: a.teacherId,
        scheduleMirror: true,
      });
    } else if (op.kind === "update") {
      await ctx.db.patch(op.push._id, op.want);
    } else if (op.kind === "close") {
      await ctx.db.patch(op.push._id, {
        clearedAt: Date.now(),
        clearedReason: "teacher",
      });
    } else {
      await ctx.db.patch(op.push._id, { scheduleWithdrawn: undefined });
    }
  }
  await ctx.db.delete(fixtureSchool);
}

/**
 * For a legacy fixture that creates no school at all. Production always has
 * a primary school, and a legacy unstamped roster's schedule is filed under it
 * (lib/scheduleStore). This seeds the real defaults, explicitly, per fixture.
 */
export async function withDefaultSchools<T extends Harness>(t: T): Promise<T> {
  await t.mutation(internal.institutions.ensureDefaults, {});
  return t;
}
