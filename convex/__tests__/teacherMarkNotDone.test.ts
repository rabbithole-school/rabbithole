// The app-session "Mark not done" (components/vibecode/VibecodeWorkshop.tsx)
// calls activityCompletions.unmarkComplete with the SESSION, not the
// assignment. That path is open to any teacher with access to the scholar, so
// a teacher who doesn't own the assignment can reopen a scholar's finished app
// activity (2026-11-04: the Run page's undo chip is owner-only, and a one-tap
// send had marked a blank app done). A teacher at another school is refused.
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "../schema";
import { api } from "../_generated/api";
import {
  makeActivity,
  makeLesson,
  makeUnit,
  makeWorld,
} from "./factories/world";
import { insertAssignmentWithSchedule } from "./scheduleFixtures";

const modules = (
  import.meta as ImportMeta & {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("../**/*.ts");

async function seedFinishedAppActivity(t: ReturnType<typeof convexTest>) {
  const world = await makeWorld(t, {
    scholarsPerSchool: 1,
    parentsPerSchool: 0,
    includePlatformAdmin: false,
  });
  const school = world.schools[0];
  const scholar = school.scholars[0];
  // The assignment belongs to the school admin, not the teacher who undoes.
  const unitId = await makeUnit(t, school.admin, school);
  const lessonId = await makeLesson(t, unitId);
  const activityId = await makeActivity(t, lessonId, { title: "Build my world" });
  const sessionId = await t.run(async (ctx) => {
    const assignmentId = await insertAssignmentWithSchedule(ctx, {
      teacherId: school.admin.id,
      unitId,
      scholarIds: [scholar.id],
      startedAt: Date.now(),
      activitySchedule: [
        {
          activityId,
          mode: "classFocus",
          setAt: Date.now(),
          startsAt: Date.now(),
        },
      ],
    });
    return ctx.db.insert("sessions", {
      userId: scholar.id,
      institutionId: school.id,
      unitId,
      lessonId,
      activityId,
      assignmentId,
      title: "Build my world",
      isArchived: false,
    });
  });
  const asScholar = await world.as.scholar(scholar);
  await asScholar.mutation(api.activityCompletions.markComplete, {
    activityId,
    sessionId,
  });
  return { world, school, scholar, activityId, sessionId };
}

describe("a teacher marks a scholar's app activity not done", () => {
  test("a teacher at the scholar's school can, without owning the assignment", async () => {
    const t = convexTest(schema, modules);
    const { world, school, scholar, activityId, sessionId } =
      await seedFinishedAppActivity(t);
    const before = await t.run((ctx) => ctx.db.get(sessionId));
    expect(before?.activityCompletedAt).toBeDefined();

    const asTeacher = await world.as.staffOf(school);
    await asTeacher.mutation(api.activityCompletions.unmarkComplete, {
      activityId,
      scholarId: scholar.id,
      sessionId,
    });

    const { session, completions } = await t.run(async (ctx) => ({
      session: await ctx.db.get(sessionId),
      completions: await ctx.db
        .query("activityCompletions")
        .withIndex("by_scholar_activity", (q) =>
          q.eq("scholarId", scholar.id).eq("activityId", activityId),
        )
        .collect(),
    }));
    expect(session?.activityCompletedAt).toBeUndefined();
    expect(completions).toHaveLength(0);
  });

  test("a teacher at another school is refused", async () => {
    const t = convexTest(schema, modules);
    const { world, scholar, activityId, sessionId } =
      await seedFinishedAppActivity(t);
    const asOtherTeacher = await world.as.staffOf(world.schools[1]);
    await expect(
      asOtherTeacher.mutation(api.activityCompletions.unmarkComplete, {
        activityId,
        scholarId: scholar.id,
        sessionId,
      }),
    ).rejects.toThrow(/not in your current context/);
    const session = await t.run((ctx) => ctx.db.get(sessionId));
    expect(session?.activityCompletedAt).toBeDefined();
  });
  test("marking an older session not done clears THAT session", async () => {
    // A completion row follows the scholar's latest finish of the activity,
    // so it can point at a newer session than the one the teacher has open.
    const t = convexTest(schema, modules);
    const { world, school, scholar, activityId, sessionId } =
      await seedFinishedAppActivity(t);
    const newerSessionId = await t.run(async (ctx) => {
      const older = await ctx.db.get(sessionId);
      return ctx.db.insert("sessions", {
        userId: scholar.id,
        institutionId: school.id,
        unitId: older!.unitId,
        lessonId: older!.lessonId,
        activityId,
        assignmentId: older!.assignmentId,
        title: "Build my world, take two",
        isArchived: false,
      });
    });
    const asScholar = await world.as.scholar(scholar);
    await asScholar.mutation(api.activityCompletions.markComplete, {
      activityId,
      sessionId: newerSessionId,
    });

    const asTeacher = await world.as.staffOf(school);
    await asTeacher.mutation(api.activityCompletions.unmarkComplete, {
      activityId,
      scholarId: scholar.id,
      sessionId,
    });

    const older = await t.run((ctx) => ctx.db.get(sessionId));
    expect(older?.activityCompletedAt).toBeUndefined();
  });
});
