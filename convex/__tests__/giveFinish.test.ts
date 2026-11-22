import { convexTest, type TestConvex } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import schema from "../schema";
import { readSchedule } from "../lib/scheduleStore";
import { api, internal } from "../_generated/api";
import type { ActionCtx } from "../_generated/server";
import type { Doc, Id } from "../_generated/dataModel";
import {
  makeAssignmentTools,
  resolveToolWithLegacyGive,
  startQuestion,
  storedWindowSummary,
} from "../lib/assignmentTools";
import { ConvexError } from "convex/values";
import {
  NOT_YOUR_GIVE,
  START_PASSED_QUESTION,
  applyScheduleActivity,
} from "../assignments";
import { plannedReleaseArgs } from "../../shared/plannedRelease";
import { endedWorkMode } from "../lib/homeOrigin";
import { MISSING_FINISH_QUESTION } from "../lib/giveQuestions";
import { schoolDayEndAt } from "../lib/schoolDays";
import { isOpenUntil, openUntilClosedLine } from "../../shared/openUntil";
import { pickUpRows, yourListRowsForTab } from "../../shared/scholarHomeNow";
import { buildYourList } from "../../shared/homeworkList";
import {
  seedScholarInInstitution,
  seedStaffWithMembership,
  seedTestInstitution,
} from "./institutionTestHelpers";

/**
 * Giving work asks two questions (TRA-571): when does it show up, and when
 * should they finish it. These pin the contract, not the wording:
 *
 *   - a give with no finish (and no explicit legacy mode) is refused with the
 *     question and writes nothing, on every mutation path;
 *   - each finish maps onto the stored activitySchedule entry the same way
 *     (in that class → classFocus ending with the bell block, or the school
 *     day; by a date → homework due at that day's end; end of unit → homework
 *     due at the end of the latest day already scheduled);
 *   - the aide's give tool answers "NOT GIVEN" instead of guessing, writes
 *     nothing until both are answered, routes each target to its write, and
 *     stores the same window when the teacher answered;
 *   - `assignments.create` plans nothing on its own.
 */

const modules = (
  import.meta as ImportMeta & {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("../**/*.ts");

const TIME_ZONE = "Pacific/Honolulu";
// Tuesday 2026-11-10 in Honolulu (UTC-10, no DST).
const TUESDAY = "2026-11-10";
const hst = (dayKey: string, hhmm: string) =>
  Date.parse(`${dayKey}T${hhmm}:00.000-10:00`);
const TUESDAY_8AM = hst(TUESDAY, "08:00");
const TUESDAY_930AM = hst(TUESDAY, "09:30");
// The group's Humanities block: 09:00–10:15 on weekdays.
const BLOCK_END_TUESDAY = hst(TUESDAY, "10:15");

beforeEach(() => {
  // Only the clock is faked; convex-test's own timers keep running.
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(TUESDAY_8AM);
});

afterEach(() => {
  vi.useRealTimers();
});

type T = TestConvex<typeof schema>;

async function withUser(t: T, userId: Id<"users">) {
  const sessionId = await t.run((ctx) =>
    ctx.db.insert("authSessions", {
      userId,
      expirationTime: Date.now() + 3_600_000,
    }),
  );
  return t.withIdentity({
    subject: `${userId}|${sessionId}`,
    issuer: "https://convex.dev",
  });
}

/** A school, a teacher, one scholar, a unit with two activities, and an
 *  empty assignment for that scholar. Optionally a bell schedule. */
async function seedWorld(t: T, opts: { bellSchedule?: boolean } = {}) {
  const institutionId = await seedTestInstitution(t);
  await t.run((ctx) => ctx.db.patch(institutionId, { timeZone: TIME_ZONE }));
  const teacher = await seedStaffWithMembership(t, {
    institutionId,
    name: "Leilani Teacher",
  });
  const scholar = await seedScholarInInstitution(t, {
    institutionId,
    name: "Kaimana Example",
  });
  const { unitId, activityA, activityB } = await t.run(async (ctx) => {
    const unitId = await ctx.db.insert("units", {
      teacherId: teacher,
      institutionId,
      title: "Tide Pools",
      isActive: true,
    });
    const lessonId = await ctx.db.insert("lessons", {
      unitId,
      title: "Observing",
      order: 0,
    });
    const activityA = await ctx.db.insert("activities", {
      lessonId,
      title: "Field notes",
      kind: "online",
      systemPrompt: "...",
      order: 0,
      // Authored as homework: must not make anything homework on its own.
    });
    const activityB = await ctx.db.insert("activities", {
      lessonId,
      title: "Share-out",
      kind: "online",
      systemPrompt: "...",
      order: 1,
    });
    return { unitId, activityA, activityB };
  });
  if (opts.bellSchedule) {
    await t.run(async (ctx) => {
      const periodId = await ctx.db.insert("reportingPeriods", {
        label: "Fall 2026",
        startsAt: hst("2026-08-17", "00:00"),
        endsAt: hst("2026-12-18", "00:00"),
        status: "open",
        institutionId,
      });
      const groupId = await ctx.db.insert("scholarGroups", {
        teacherId: teacher,
        institutionId,
        name: "Honu",
        scholarIds: [scholar],
      });
      const blockId = await ctx.db.insert("scheduleBlocks", {
        periodId,
        key: "blockA",
        label: "Block A",
        startLocal: "09:00",
        endLocal: "10:15",
        weekdays: [1, 2, 3, 4, 5],
        order: 0,
        kind: "class",
      });
      await ctx.db.insert("schedulePlacements", {
        periodId,
        groupId,
        weekday: 2, // Tuesday
        blockId,
        subject: "Humanities",
      });
    });
  }
  const asTeacher = await withUser(t, teacher);
  const assignmentId = await asTeacher.mutation(api.assignments.create, {
    unitId,
    scholarIds: [scholar],
  });
  return {
    institutionId,
    teacher,
    scholar,
    unitId,
    activityA,
    activityB,
    assignmentId,
    asTeacher,
  };
}

async function scheduleOf(t: T, assignmentId: Id<"assignments">) {
  return t.run(async (ctx) => readSchedule(ctx, { _id: assignmentId }));
}

async function entryFor(
  t: T,
  assignmentId: Id<"assignments">,
  activityId: Id<"activities">,
) {
  const entry = (await scheduleOf(t, assignmentId)).find(
    (e) => e.activityId === activityId,
  );
  expect(entry).toBeDefined();
  return entry!;
}

async function counts(t: T) {
  return t.run(async (ctx) => ({
    assignments: (await ctx.db.query("assignments").collect()).length,
    activities: (await ctx.db.query("activities").collect()).length,
    pushes: (await ctx.db.query("pushes").collect()).length,
  }));
}

function actionCtxFor(t: T): ActionCtx {
  return {
    runQuery: (ref: unknown, args: unknown) =>
      (t as unknown as { query: (r: unknown, a: unknown) => Promise<unknown> }).query(ref, args),
    runMutation: (ref: unknown, args: unknown) =>
      (t as unknown as { mutation: (r: unknown, a: unknown) => Promise<unknown> }).mutation(ref, args),
  } as unknown as ActionCtx;
}

async function toolsFor(t: T, callerUserId: Id<"users">) {
  const tools = await makeAssignmentTools(actionCtxFor(t), () => {}, {
    role: "teacher",
    callerUserId,
  });
  return Object.fromEntries(tools.map((tool) => [tool.name, tool])) as Record<
    string,
    { run: (input: unknown) => Promise<string> }
  >;
}

async function pushMirror(t: T, assignmentId: Id<"assignments">) {
  const rows = await t.run((ctx) =>
    ctx.db
      .query("pushes")
      .withIndex("by_assignment", (q) => q.eq("assignmentId", assignmentId))
      .collect(),
  );
  // TRA-580 step 5: every writer stores `timing` as the kind alone.
  for (const row of rows) expect(Object.keys(row.timing)).toEqual(["kind"]);
  return rows;
}

describe("a give with no finish is refused and writes nothing", () => {
  test("pushActivity", async () => {
    const t = convexTest(schema, modules);
    const w = await seedWorld(t);
    const before = await counts(t);
    await expect(
      w.asTeacher.mutation(api.assignments.pushActivity, {
        assignmentId: w.assignmentId,
        activityId: w.activityA,
      }),
    ).rejects.toThrow(MISSING_FINISH_QUESTION);
    expect(await scheduleOf(t, w.assignmentId)).toEqual([]);
    expect(await counts(t)).toEqual(before);
  });

  test("scheduleActivity", async () => {
    const t = convexTest(schema, modules);
    const w = await seedWorld(t);
    const before = await counts(t);
    await expect(
      w.asTeacher.mutation(api.assignments.scheduleActivity, {
        assignmentId: w.assignmentId,
        activityId: w.activityA,
        startsAt: TUESDAY_930AM,
      }),
    ).rejects.toThrow(MISSING_FINISH_QUESTION);
    expect(await scheduleOf(t, w.assignmentId)).toEqual([]);
    expect(await counts(t)).toEqual(before);
  });

  test("assignWork with an activity target", async () => {
    const t = convexTest(schema, modules);
    const w = await seedWorld(t);
    const before = await counts(t);
    await expect(
      w.asTeacher.mutation(api.assignments.assignWork, {
        unitId: w.unitId,
        scholarIds: [w.scholar],
        startsAt: TUESDAY_930AM,
        target: { kind: "activity", activityId: w.activityA },
      }),
    ).rejects.toThrow(MISSING_FINISH_QUESTION);
    expect(await scheduleOf(t, w.assignmentId)).toEqual([]);
    expect(await counts(t)).toEqual(before);
  });

  test("dispatchActivity", async () => {
    const t = convexTest(schema, modules);
    const w = await seedWorld(t);
    const before = await counts(t);
    await expect(
      w.asTeacher.mutation(api.assignments.dispatchActivity, {
        scholarId: w.scholar,
        title: "Sketch the tide line",
      }),
    ).rejects.toThrow(MISSING_FINISH_QUESTION);
    // Neither the ad-hoc activity nor its one-scholar assignment survives.
    expect(await counts(t)).toEqual(before);
  });

  test("aidePushActivityNow", async () => {
    const t = convexTest(schema, modules);
    const w = await seedWorld(t);
    const before = await counts(t);
    await expect(
      t.mutation(internal.assignments.aidePushActivityNow, {
        callerUserId: w.teacher,
        assignmentId: w.assignmentId,
        activityId: w.activityA,
      }),
    ).rejects.toThrow(MISSING_FINISH_QUESTION);
    expect(await scheduleOf(t, w.assignmentId)).toEqual([]);
    expect(await counts(t)).toEqual(before);
  });

  test("aideScheduleActivity", async () => {
    const t = convexTest(schema, modules);
    const w = await seedWorld(t);
    const before = await counts(t);
    await expect(
      t.mutation(internal.assignments.aideScheduleActivity, {
        callerUserId: w.teacher,
        assignmentId: w.assignmentId,
        activityId: w.activityA,
        startsAt: TUESDAY_930AM,
      }),
    ).rejects.toThrow(MISSING_FINISH_QUESTION);
    expect(await scheduleOf(t, w.assignmentId)).toEqual([]);
    expect(await counts(t)).toEqual(before);
  });
});

describe("each finish maps onto the stored entry", () => {
  test("in that class, inside a bell block → classFocus ending with the block", async () => {
    const t = convexTest(schema, modules);
    const w = await seedWorld(t, { bellSchedule: true });
    await w.asTeacher.mutation(api.assignments.scheduleActivity, {
      assignmentId: w.assignmentId,
      activityId: w.activityA,
      startsAt: TUESDAY_930AM,
      finish: { kind: "inClass" },
    });
    const entry = await entryFor(t, w.assignmentId, w.activityA);
    expect(entry.mode).toBe("classFocus");
    expect(entry.startsAt).toBe(TUESDAY_930AM);
    expect(entry.endsAt).toBe(BLOCK_END_TUESDAY);
    expect(entry.dueAt).toBeUndefined();
    expect(entry.setAt).toBeUndefined(); // planned, not live yet
  });

  test("in that class, with no bell schedule → classFocus ending with that school day", async () => {
    const t = convexTest(schema, modules);
    const w = await seedWorld(t);
    await w.asTeacher.mutation(api.assignments.pushActivity, {
      assignmentId: w.assignmentId,
      activityId: w.activityA,
      finish: { kind: "inClass" },
    });
    const entry = await entryFor(t, w.assignmentId, w.activityA);
    expect(entry.mode).toBe("classFocus");
    expect(entry.setAt).toBeDefined(); // live now
    expect(entry.endsAt).toBe(schoolDayEndAt(TUESDAY, TIME_ZONE));
    expect(entry.dueAt).toBeUndefined();
  });

  test("in that class, outside every block → the end of that school day", async () => {
    const t = convexTest(schema, modules);
    const w = await seedWorld(t, { bellSchedule: true });
    // 8:00 is before the 9:00 block starts.
    await w.asTeacher.mutation(api.assignments.pushActivity, {
      assignmentId: w.assignmentId,
      activityId: w.activityA,
      finish: { kind: "inClass" },
    });
    const entry = await entryFor(t, w.assignmentId, w.activityA);
    expect(entry.mode).toBe("classFocus");
    expect(entry.endsAt).toBe(schoolDayEndAt(TUESDAY, TIME_ZONE));
  });

  test("by a date → homework due at the end of that day", async () => {
    const t = convexTest(schema, modules);
    const w = await seedWorld(t);
    await w.asTeacher.mutation(api.assignments.scheduleActivity, {
      assignmentId: w.assignmentId,
      activityId: w.activityA,
      startsAt: TUESDAY_930AM,
      finish: { kind: "by", dayKey: "2026-11-13" },
    });
    const entry = await entryFor(t, w.assignmentId, w.activityA);
    expect(entry.mode).toBe("homework");
    expect(entry.startsAt).toBe(TUESDAY_930AM);
    expect(entry.dueAt).toBe(schoolDayEndAt("2026-11-13", TIME_ZONE));
    expect(entry.endsAt).toBeUndefined();
  });

  test("end of unit → homework due at the end of the latest scheduled day", async () => {
    const t = convexTest(schema, modules);
    const w = await seedWorld(t);
    // Something else in the unit is already planned for Friday.
    await w.asTeacher.mutation(api.assignments.scheduleActivity, {
      assignmentId: w.assignmentId,
      activityId: w.activityB,
      startsAt: hst("2026-11-13", "09:00"),
      finish: { kind: "inClass" },
    });
    await w.asTeacher.mutation(api.assignments.scheduleActivity, {
      assignmentId: w.assignmentId,
      activityId: w.activityA,
      startsAt: TUESDAY_930AM,
      finish: { kind: "endOfUnit" },
    });
    const entry = await entryFor(t, w.assignmentId, w.activityA);
    expect(entry.mode).toBe("homework");
    expect(entry.dueAt).toBe(schoolDayEndAt("2026-11-13", TIME_ZONE));
    // Stored as the kind alone, the due date in the one end field.
    const row = (await pushMirror(t, w.assignmentId)).find(
      (p) => p.target.kind === "activity" && p.target.activityId === w.activityA,
    );
    expect(row).toMatchObject({
      timing: { kind: "homework" },
      endsAt: schoolDayEndAt("2026-11-13", TIME_ZONE),
      afterEnd: "late",
    });
  });

  test("end of unit with nothing else scheduled is refused with a question", async () => {
    const t = convexTest(schema, modules);
    const w = await seedWorld(t);
    await expect(
      w.asTeacher.mutation(api.assignments.scheduleActivity, {
        assignmentId: w.assignmentId,
        activityId: w.activityA,
        startsAt: TUESDAY_930AM,
        finish: { kind: "endOfUnit" },
      }),
    ).rejects.toThrow(/\?$/);
    expect(await scheduleOf(t, w.assignmentId)).toEqual([]);
  });
});

describe("the aide's give tool", () => {
  test("an activity for a named cohort: no start → the start question, no finish → the finish question, nothing written; a date → homework due that day", async () => {
    const t = convexTest(schema, modules);
    const w = await seedWorld(t);
    const tools = await toolsFor(t, w.teacher);
    const input = {
      unitTitle: "Tide Pools",
      activityTitle: "Field notes",
      scholarNames: ["Kaimana Example"],
    };
    const before = await counts(t);

    const noStart = await tools.give.run({ ...input, finish: "2026-11-13" });
    const choices = await t.query(internal.assignments.aideGiveChoices, {
      callerUserId: w.teacher,
      unitId: w.unitId,
      scholarIds: [w.scholar],
      activityId: w.activityA,
    });
    expect(noStart).toBe(startQuestion(choices, "startsNow:true"));
    const noFinish = await tools.give.run({ ...input, startsNow: true });
    expect(noFinish.startsWith("NOT GIVEN")).toBe(true);
    expect(await scheduleOf(t, w.assignmentId)).toEqual([]);
    expect(await counts(t)).toEqual(before);

    const given = JSON.parse(
      await tools.give.run({ ...input, startsNow: true, finish: "2026-11-13" }),
    ) as Record<string, unknown>;
    expect(given).toMatchObject({ ok: true, live: true });
    const assignmentId = given.assignmentId as Id<"assignments">;
    // Same unit + same exact roster → the existing assignment is reused.
    expect(assignmentId).toBe(w.assignmentId);
    const entry = await entryFor(t, assignmentId, w.activityA);
    expect(entry.mode).toBe("homework");
    expect(entry.setAt).toBeDefined();
    expect(entry.dueAt).toBe(schoolDayEndAt("2026-11-13", TIME_ZONE));
    expect(entry.endsAt).toBeUndefined();

    const mirror = (await pushMirror(t, assignmentId)).filter(
      (p) => p.clearedAt === undefined,
    );
    expect(mirror).toHaveLength(1);
    expect(mirror[0].timing).toEqual({ kind: "homework" });
    expect(mirror[0].endsAt).toBe(schoolDayEndAt("2026-11-13", TIME_ZONE));
    expect(mirror[0].afterEnd).toBe("late");
  });

  test("an activity for a NEW roster creates its own assignment", async () => {
    const t = convexTest(schema, modules);
    const w = await seedWorld(t);
    await seedScholarInInstitution(t, {
      institutionId: w.institutionId,
      name: "Noelani Example",
    });
    const tools = await toolsFor(t, w.teacher);

    const given = JSON.parse(
      await tools.give.run({
        unitTitle: "Tide Pools",
        activityTitle: "Share-out",
        scholarNames: ["Kaimana Example", "Noelani Example"],
        startsNow: true,
        finish: "inClass",
      }),
    ) as Record<string, unknown>;
    expect(given).toMatchObject({ ok: true, live: true, created: true, rosterSize: 2 });
    expect(given.assignmentId).not.toBe(w.assignmentId);
    const entry = await entryFor(t, given.assignmentId as Id<"assignments">, w.activityB);
    expect(entry.mode).toBe("classFocus");
    expect(entry.setAt).toBeDefined();
    expect(await scheduleOf(t, w.assignmentId)).toEqual([]);
  });

  test("an activity of an existing assignment, now: no finish → NOT GIVEN; in that class → ends with the bell block", async () => {
    const t = convexTest(schema, modules);
    const w = await seedWorld(t, { bellSchedule: true });
    vi.setSystemTime(TUESDAY_930AM); // inside the Humanities block
    const tools = await toolsFor(t, w.teacher);
    const input = {
      assignmentId: w.assignmentId,
      activityId: w.activityA,
      startsNow: true,
    };

    const asked = await tools.give.run(input);
    expect(asked.startsWith("NOT GIVEN")).toBe(true);
    expect(await scheduleOf(t, w.assignmentId)).toEqual([]);
    expect(await pushMirror(t, w.assignmentId)).toEqual([]);

    const given = JSON.parse(
      await tools.give.run({ ...input, finish: "inClass" }),
    ) as Record<string, unknown>;
    expect(given).toMatchObject({ ok: true, live: true });
    const entry = await entryFor(t, w.assignmentId, w.activityA);
    expect(entry.mode).toBe("classFocus");
    expect(entry.setAt).toBeDefined();
    expect(entry.endsAt).toBe(BLOCK_END_TUESDAY);

    const mirror = (await pushMirror(t, w.assignmentId)).filter(
      (p) => p.clearedAt === undefined,
    );
    expect(mirror).toHaveLength(1);
    expect(mirror[0].timing).toEqual({ kind: "focus" });
    expect(mirror[0].endsAt).toBe(BLOCK_END_TUESDAY);
    expect(mirror[0].afterEnd).toBe("fade");
  });

  test("an activity of an existing assignment, later: no start or no finish → NOT GIVEN; a date → planned homework", async () => {
    const t = convexTest(schema, modules);
    const w = await seedWorld(t);
    const tools = await toolsFor(t, w.teacher);
    const input = { assignmentId: w.assignmentId, activityTitle: "field notes" };

    const noStart = await tools.give.run({ ...input, finish: "2026-11-13" });
    expect(noStart.startsWith("NOT GIVEN")).toBe(true);
    const noFinish = await tools.give.run({
      ...input,
      startsAtMs: TUESDAY_930AM,
    });
    expect(noFinish.startsWith("NOT GIVEN")).toBe(true);
    expect(await scheduleOf(t, w.assignmentId)).toEqual([]);

    const given = JSON.parse(
      await tools.give.run({
        ...input,
        startsAtMs: TUESDAY_930AM,
        finish: "2026-11-13",
      }),
    ) as Record<string, unknown>;
    expect(given).toMatchObject({ ok: true, live: false });
    expect(typeof given.startsAtLabel).toBe("string");
    const entry = await entryFor(t, w.assignmentId, w.activityA);
    expect(entry.mode).toBe("homework");
    expect(entry.startsAt).toBe(TUESDAY_930AM);
    expect(entry.setAt).toBeUndefined(); // planned
    expect(entry.dueAt).toBe(schoolDayEndAt("2026-11-13", TIME_ZONE));
  });

  test("named scholars on an existing assignment can't be planned for later, and nothing is written", async () => {
    const t = convexTest(schema, modules);
    const w = await seedWorld(t);
    const tools = await toolsFor(t, w.teacher);
    const before = await counts(t);

    const res = await tools.give.run({
      assignmentId: w.assignmentId,
      activityId: w.activityA,
      scholarNames: ["Kaimana Example"],
      startsAtMs: TUESDAY_930AM,
      finish: "2026-11-13",
    });
    expect(() => JSON.parse(res)).toThrow();
    expect(await scheduleOf(t, w.assignmentId)).toEqual([]);
    expect(await counts(t)).toEqual(before);
  });

  test("both startsNow and startsAtMs, or no target at all, is refused without a write", async () => {
    const t = convexTest(schema, modules);
    const w = await seedWorld(t);
    const tools = await toolsFor(t, w.teacher);
    const before = await counts(t);

    for (const input of [
      {
        assignmentId: w.assignmentId,
        activityId: w.activityA,
        startsNow: true,
        startsAtMs: TUESDAY_930AM,
        finish: "inClass",
      },
      { scholarNames: ["Kaimana Example"], startsNow: true, finish: "inClass" },
      {
        unitId: w.unitId,
        activityId: w.activityA,
        scholarNames: ["Kaimana Example"],
        startsNow: true,
        finish: "inClass",
      },
    ]) {
      const res = await tools.give.run(input);
      expect(() => JSON.parse(res)).toThrow();
    }
    expect(await counts(t)).toEqual(before);
    expect(await scheduleOf(t, w.assignmentId)).toEqual([]);
  });

  test("one lesson of the unit gives only that lesson's activities, planned for later", async () => {
    const t = convexTest(schema, modules);
    const w = await seedWorld(t);
    const otherActivity = await t.run(async (ctx) => {
      const lessonId = await ctx.db.insert("lessons", {
        unitId: w.unitId,
        title: "Mapping",
        order: 1,
      });
      return ctx.db.insert("activities", {
        lessonId,
        title: "Draw the shoreline",
        kind: "online",
        systemPrompt: "...",
        order: 0,
      });
    });
    const tools = await toolsFor(t, w.teacher);

    const given = JSON.parse(
      await tools.give.run({
        unitTitle: "Tide Pools",
        lessonTitle: "mapping",
        scholarNames: ["Kaimana Example"],
        startsAtMs: TUESDAY_930AM,
        finish: "2026-11-13",
      }),
    ) as Record<string, unknown>;
    expect(given).toMatchObject({ ok: true, live: false, lessonTitle: "Mapping" });
    expect(given.assignmentId).toBe(w.assignmentId);
    const entries = await scheduleOf(t, w.assignmentId);
    expect(entries.map((e) => e.activityId)).toEqual([otherActivity]);
    expect(entries[0].setAt).toBeUndefined(); // planned
    expect(entries[0].startsAt).toBe(TUESDAY_930AM);
  });

  test("a new one-off activity: no finish → NOT GIVEN with nothing written; answered → a one-scholar assignment", async () => {
    const t = convexTest(schema, modules);
    const w = await seedWorld(t);
    const tools = await toolsFor(t, w.teacher);
    const input = {
      newActivity: { title: "Kelp forest wondering" },
      scholarNames: ["Kaimana"],
      startsNow: true,
    };
    const before = await counts(t);

    const asked = await tools.give.run(input);
    expect(asked.startsWith("NOT GIVEN")).toBe(true);
    const noStart = await tools.give.run({
      newActivity: input.newActivity,
      scholarNames: input.scholarNames,
      finish: "inClass",
    });
    expect(noStart.startsWith("NOT GIVEN")).toBe(true);
    expect(await counts(t)).toEqual(before);

    // A group is refused: a new activity goes to one scholar at a time.
    const group = await tools.give.run({
      ...input,
      scholarNames: undefined,
      groupName: "Honu",
      finish: "inClass",
    });
    expect(() => JSON.parse(group)).toThrow();
    expect(await counts(t)).toEqual(before);

    const given = JSON.parse(
      await tools.give.run({ ...input, finish: "inClass" }),
    ) as Record<string, unknown>;
    expect(given).toMatchObject({
      ok: true,
      live: true,
      scholarId: w.scholar,
      scholarName: "Kaimana Example",
    });
    const assignment = (await t.run((ctx) =>
      ctx.db.get(given.assignmentId as Id<"assignments">),
    )) as Doc<"assignments">;
    const schedule = await scheduleOf(t, assignment._id);
    expect(assignment.kind).toBe("adHocDispatch");
    expect(assignment.scholarIds).toEqual([w.scholar]);
    expect(schedule[0].setAt).toBeDefined();
  });
});

test("assignments.create plans nothing", async () => {
  const t = convexTest(schema, modules);
  const w = await seedWorld(t);
  expect(await scheduleOf(t, w.assignmentId)).toEqual([]);
  expect(await pushMirror(t, w.assignmentId)).toEqual([]);
});

// ── Adversarial review of PR #4502 (TRA-571) ─────────────────────────────
//
// Expected instants below are written out in UTC by hand (HST = UTC-10, no
// DST), not computed with the production helpers, so a wrong boundary in
// `schoolDayEndAt` or the bell lookup can't pass by agreeing with itself.
const UTC_TUE_0900 = Date.UTC(2026, 10, 10, 19, 0); // Tue Nov 10, 09:00 HST
const UTC_TUE_1015 = Date.UTC(2026, 10, 10, 20, 15); // 10:15 HST
const UTC_TUE_1130 = Date.UTC(2026, 10, 10, 21, 30); // 11:30 HST
const UTC_TUE_END = Date.UTC(2026, 10, 11, 9, 59, 59, 999); // Tue 23:59:59.999 HST
const UTC_WED_END = Date.UTC(2026, 10, 12, 9, 59, 59, 999);
const UTC_FRI_END = Date.UTC(2026, 10, 14, 9, 59, 59, 999); // Fri Nov 13 end
const UTC_JAN12_1300 = Date.UTC(2027, 0, 12, 23, 0); // Tue Jan 12 2027, 13:00 HST
const UTC_JAN12_1400 = Date.UTC(2027, 0, 13, 0, 0); // 14:00 HST

async function foreignScholar(t: T) {
  const otherSchool = await seedTestInstitution(t, {
    slug: "other-school",
    name: "Other School",
  });
  return seedScholarInInstitution(t, {
    institutionId: otherSchool,
    name: "Makoa Elsewhere",
  });
}

async function bellIds(t: T) {
  return t.run(async (ctx) => {
    const period = (await ctx.db.query("reportingPeriods").collect())[0];
    const group = (await ctx.db.query("scholarGroups").collect())[0];
    const placement = (await ctx.db.query("schedulePlacements").collect())[0];
    return { periodId: period._id, groupId: group._id, placementId: placement._id };
  });
}

/** Narrow a giveChoices result to usable choices (fails the test otherwise). */
function usable<C extends object>(res: C | { refused: string } | null | undefined): C {
  expect(res).not.toBeNull();
  expect(res && "refused" in res).toBe(false);
  return res as C;
}

describe("review #1: give choices authorize every scholar they describe", () => {
  test("an explicit roster with a foreign scholar is refused as a state, not a throw", async () => {
    const t = convexTest(schema, modules);
    const w = await seedWorld(t, { bellSchedule: true });
    const outsider = await foreignScholar(t);
    expect(
      await w.asTeacher.query(api.assignments.giveChoices, {
        assignmentId: w.assignmentId,
        scholarIds: [outsider],
        nowMs: TUESDAY_8AM,
      }),
    ).toEqual({ refused: expect.stringMatching(/roster/) });
    // The assignment's own roster still reads its bell schedule.
    const own = usable(
      await w.asTeacher.query(api.assignments.giveChoices, {
        assignmentId: w.assignmentId,
        nowMs: TUESDAY_8AM,
      }),
    );
    expect(own.blocks.map((b) => b.startsAt)).toContain(UTC_TUE_0900);
  });

  test("a unit give can't name another school's scholar", async () => {
    const t = convexTest(schema, modules);
    const w = await seedWorld(t, { bellSchedule: true });
    const outsider = await foreignScholar(t);
    const res = await w.asTeacher.query(api.assignments.giveChoices, {
      unitId: w.unitId,
      scholarIds: [outsider],
      nowMs: TUESDAY_8AM,
    });
    expect(res && "refused" in res).toBe(true);
  });

  test("the aide's twin reads a foreign or off-roster scholar as no choices", async () => {
    const t = convexTest(schema, modules);
    const w = await seedWorld(t, { bellSchedule: true });
    const outsider = await foreignScholar(t);
    expect(
      await t.query(internal.assignments.aideGiveChoices, {
        callerUserId: w.teacher,
        scholarIds: [outsider],
      }),
    ).toBeNull();
    expect(
      await t.query(internal.assignments.aideGiveChoices, {
        callerUserId: w.teacher,
        assignmentId: w.assignmentId,
        scholarIds: [outsider],
      }),
    ).toBeNull();
  });
});

describe("a real roster can hold a scholar the teacher can't reach (dchar's Give dialog)", () => {
  test("the own roster never throws: choices describe only the reachable scholars", async () => {
    const t = convexTest(schema, modules);
    const w = await seedWorld(t, { bellSchedule: true });
    const outsider = await foreignScholar(t);
    // A transferred scholar still on the roster.
    await t.run((ctx) =>
      ctx.db.patch(w.assignmentId, { scholarIds: [w.scholar, outsider] }),
    );
    const choices = usable(
      await w.asTeacher.query(api.assignments.giveChoices, {
        assignmentId: w.assignmentId,
        nowMs: TUESDAY_8AM,
      }),
    );
    // Computed from the reachable scholar's group (the outsider isn't in
    // it), so the Honu bell schedule is offered — never widened.
    expect(choices.blocks.map((b) => b.startsAt)).toContain(UTC_TUE_0900);
    const aide = await t.query(internal.assignments.aideGiveChoices, {
      callerUserId: w.teacher,
      assignmentId: w.assignmentId,
    });
    expect(aide?.blocks.map((b) => b.startsAt)).toContain(UTC_TUE_0900);
  });

  test("naming the unreachable scholar is still refused, as a state", async () => {
    const t = convexTest(schema, modules);
    const w = await seedWorld(t, { bellSchedule: true });
    const outsider = await foreignScholar(t);
    await t.run((ctx) =>
      ctx.db.patch(w.assignmentId, { scholarIds: [w.scholar, outsider] }),
    );
    const res = await w.asTeacher.query(api.assignments.giveChoices, {
      assignmentId: w.assignmentId,
      scholarIds: [outsider],
      nowMs: TUESDAY_8AM,
    });
    expect(res && "refused" in res).toBe(true);
  });
});

describe("review #2: a legacy mode only counts where it says everything", () => {
  test("class focus with no end gets the bell-block end", async () => {
    vi.setSystemTime(TUESDAY_930AM);
    const t = convexTest(schema, modules);
    const w = await seedWorld(t, { bellSchedule: true });
    await w.asTeacher.mutation(api.assignments.pushActivity, {
      assignmentId: w.assignmentId,
      activityId: w.activityA,
      mode: "classFocus",
    });
    const entry = await entryFor(t, w.assignmentId, w.activityA);
    expect(entry.mode).toBe("classFocus");
    expect(entry.endsAt).toBe(UTC_TUE_1015);
  });

  test("homework with no date is refused, on push and on dispatch", async () => {
    const t = convexTest(schema, modules);
    const w = await seedWorld(t);
    const before = await counts(t);
    await expect(
      w.asTeacher.mutation(api.assignments.pushActivity, {
        assignmentId: w.assignmentId,
        activityId: w.activityA,
        mode: "homework",
      }),
    ).rejects.toThrow(MISSING_FINISH_QUESTION);
    await expect(
      w.asTeacher.mutation(api.assignments.dispatchActivity, {
        scholarId: w.scholar,
        title: "Tide pool question",
        mode: "homework",
      }),
    ).rejects.toThrow(MISSING_FINISH_QUESTION);
    expect(await counts(t)).toEqual(before);
  });
});

describe("reviews #7 and #8: unit gives honor when they show up", () => {
  test("a unit given now goes live; a unit given later is planned with activation jobs", async () => {
    const t = convexTest(schema, modules);
    const w = await seedWorld(t);
    await w.asTeacher.mutation(api.assignments.assignWork, {
      unitId: w.unitId,
      scholarIds: [w.scholar],
      startsAt: Date.now(),
      target: { kind: "unit" },
      finish: { kind: "by", dayKey: "2026-11-13" },
    });
    for (const entry of await scheduleOf(t, w.assignmentId)) {
      expect(entry.setAt).toBe(TUESDAY_8AM);
      expect(entry.dueAt).toBe(UTC_FRI_END);
    }

    const t2 = convexTest(schema, modules);
    const w2 = await seedWorld(t2);
    const tomorrow = TUESDAY_8AM + 24 * 3_600_000;
    await w2.asTeacher.mutation(api.assignments.assignWork, {
      unitId: w2.unitId,
      scholarIds: [w2.scholar],
      startsAt: tomorrow,
      target: { kind: "unit" },
      finish: { kind: "inClass" },
    });
    const planned = await scheduleOf(t2, w2.assignmentId);
    expect(planned).toHaveLength(2);
    for (const entry of planned) {
      expect(entry.setAt).toBeUndefined();
      expect(entry.scheduledFnId).toBeDefined();
      expect(entry.endsAt).toBe(UTC_WED_END);
    }
  });

  test("give for a whole unit asks for the start and the finish, then gives the unit", async () => {
    const t = convexTest(schema, modules);
    const w = await seedWorld(t);
    const tools = await toolsFor(t, w.teacher);
    const base = { unitId: w.unitId, scholarNames: ["Kaimana Example"] };
    const before = await counts(t);

    const noStart = await tools.give.run({ ...base, finish: "2026-11-13" });
    expect(noStart.startsWith("NOT GIVEN")).toBe(true);
    const noFinish = await tools.give.run({ ...base, startsNow: true });
    expect(noFinish.startsWith("NOT GIVEN")).toBe(true);
    expect(await counts(t)).toEqual(before);

    const given = JSON.parse(
      await tools.give.run({
        ...base,
        startsNow: true,
        finish: "2026-11-13",
      }),
    ) as { assignmentId: Id<"assignments"> };
    expect(given.assignmentId).toBe(w.assignmentId); // reused
    const entries = await scheduleOf(t, w.assignmentId);
    expect(entries).toHaveLength(2);
    for (const entry of entries) {
      expect(entry.mode).toBe("homework");
      expect(entry.setAt).toBe(TUESDAY_8AM);
      expect(entry.dueAt).toBe(UTC_FRI_END);
    }
  });
});

describe("review #9: blocks already under way are 'now', never a past start", () => {
  test("at 09:30 the 09:00 class is the current block, not an offered start", async () => {
    vi.setSystemTime(TUESDAY_930AM);
    const t = convexTest(schema, modules);
    const w = await seedWorld(t, { bellSchedule: true });
    const choices = usable(
      await w.asTeacher.query(api.assignments.giveChoices, {
        assignmentId: w.assignmentId,
        nowMs: TUESDAY_930AM,
      }),
    );
    expect(choices.blocks.map((b) => b.startsAt)).not.toContain(UTC_TUE_0900);
    expect(choices.currentBlock?.endsAt).toBe(UTC_TUE_1015);
  });

  test("a start that has clearly passed is refused; a minute-rounded now goes live", async () => {
    vi.setSystemTime(TUESDAY_930AM);
    const t = convexTest(schema, modules);
    const w = await seedWorld(t, { bellSchedule: true });
    await expect(
      w.asTeacher.mutation(api.assignments.scheduleActivity, {
        assignmentId: w.assignmentId,
        activityId: w.activityA,
        startsAt: UTC_TUE_0900,
        finish: { kind: "inClass" },
      }),
    ).rejects.toThrow(START_PASSED_QUESTION);
    await w.asTeacher.mutation(api.assignments.scheduleActivity, {
      assignmentId: w.assignmentId,
      activityId: w.activityA,
      startsAt: TUESDAY_930AM - 30_000,
      finish: { kind: "inClass" },
    });
    const entry = await entryFor(t, w.assignmentId, w.activityA);
    expect(entry.setAt).toBe(TUESDAY_930AM);
    expect(entry.endsAt).toBe(UTC_TUE_1015);
  });
});

describe("review #10: moving a give re-reads its finish at the new time", () => {
  test("an in-class give moved into the 09:00 class ends with that class", async () => {
    const t = convexTest(schema, modules);
    const w = await seedWorld(t, { bellSchedule: true });
    const wednesdayNoon = Date.UTC(2026, 10, 11, 22, 0);
    await w.asTeacher.mutation(api.assignments.scheduleActivity, {
      assignmentId: w.assignmentId,
      activityId: w.activityA,
      startsAt: wednesdayNoon,
      finish: { kind: "inClass" },
    });
    expect((await entryFor(t, w.assignmentId, w.activityA)).endsAt).toBe(
      UTC_WED_END,
    );
    await w.asTeacher.mutation(api.assignments.rescheduleActivity, {
      assignmentId: w.assignmentId,
      activityId: w.activityA,
      startsAt: UTC_TUE_0900,
    });
    const moved = await entryFor(t, w.assignmentId, w.activityA);
    expect(moved.startsAt).toBe(UTC_TUE_0900);
    expect(moved.endsAt).toBe(UTC_TUE_1015);
  });

  test("homework can't be moved to start after it's due", async () => {
    const t = convexTest(schema, modules);
    const w = await seedWorld(t);
    await w.asTeacher.mutation(api.assignments.scheduleActivity, {
      assignmentId: w.assignmentId,
      activityId: w.activityA,
      startsAt: UTC_TUE_0900,
      finish: { kind: "by", dayKey: "2026-11-11" },
    });
    await expect(
      w.asTeacher.mutation(api.assignments.rescheduleActivity, {
        assignmentId: w.assignmentId,
        activityId: w.activityA,
        startsAt: Date.UTC(2026, 10, 13, 19, 0), // Thu, after Wed's due date
      }),
    ).rejects.toThrow(/after it's due/);
    expect((await entryFor(t, w.assignmentId, w.activityA)).startsAt).toBe(
      UTC_TUE_0900,
    );
  });
});

describe("review #11: the bell comes from the right term, double periods included", () => {
  test("a January give reads the spring timetable even while fall is open", async () => {
    const t = convexTest(schema, modules);
    const w = await seedWorld(t, { bellSchedule: true });
    const { groupId } = await bellIds(t);
    await t.run(async (ctx) => {
      const spring = await ctx.db.insert("reportingPeriods", {
        label: "Spring 2027",
        startsAt: Date.UTC(2027, 0, 4, 10, 0),
        endsAt: Date.UTC(2027, 4, 28, 10, 0),
        status: "open",
        institutionId: w.institutionId,
      });
      const blockId = await ctx.db.insert("scheduleBlocks", {
        periodId: spring,
        key: "blockC",
        label: "Block C",
        startLocal: "13:00",
        endLocal: "14:00",
        weekdays: [1, 2, 3, 4, 5],
        order: 0,
        kind: "class",
      });
      await ctx.db.insert("schedulePlacements", {
        periodId: spring,
        groupId,
        weekday: 2,
        blockId,
        subject: "Science",
      });
    });
    await w.asTeacher.mutation(api.assignments.scheduleActivity, {
      assignmentId: w.assignmentId,
      activityId: w.activityA,
      startsAt: UTC_JAN12_1300,
      finish: { kind: "inClass" },
    });
    expect((await entryFor(t, w.assignmentId, w.activityA)).endsAt).toBe(
      UTC_JAN12_1400,
    );
  });

  test("a double period ends with its second block", async () => {
    vi.setSystemTime(TUESDAY_930AM);
    const t = convexTest(schema, modules);
    const w = await seedWorld(t, { bellSchedule: true });
    const { periodId, placementId } = await bellIds(t);
    await t.run(async (ctx) => {
      await ctx.db.insert("scheduleBlocks", {
        periodId,
        key: "blockB",
        label: "Block B",
        startLocal: "10:15",
        endLocal: "11:30",
        weekdays: [1, 2, 3, 4, 5],
        order: 1,
        kind: "class",
      });
      await ctx.db.patch(placementId, { spanBlocks: 2 });
    });
    await w.asTeacher.mutation(api.assignments.pushActivity, {
      assignmentId: w.assignmentId,
      activityId: w.activityA,
      finish: { kind: "inClass" },
    });
    expect((await entryFor(t, w.assignmentId, w.activityA)).endsAt).toBe(
      UTC_TUE_1130,
    );
  });
});

describe("reviews #13 and #14: replies report what's stored, in the tool's own words", () => {
  test("the summary reads the stored due date, not the one asked for", () => {
    const summary = storedWindowSummary(
      {
        mode: "homework",
        setAt: TUESDAY_8AM,
        startsAt: TUESDAY_8AM,
        endsAt: null,
        dueAt: UTC_FRI_END,
      },
      {
        timeZone: TIME_ZONE,
        todayDayKey: "2026-11-10",
        blocks: [],
        currentBlock: null,
        inClass: { endsAt: UTC_TUE_END, blockLabel: null },
        dueDays: [],
        endOfUnit: null,
        closures: [],
      },
    );
    expect(summary.startsWith("Due Fri, Nov 13")).toBe(true);
  });

  test("dispatch's start question names dispatch's own start argument", () => {
    const question = startQuestion(
      {
        timeZone: TIME_ZONE,
        todayDayKey: "2026-11-10",
        blocks: [
          {
            dayKey: "2026-11-10",
            subject: "Humanities",
            startsAt: UTC_TUE_0900,
            endsAt: UTC_TUE_1015,
            label: "Today · Humanities (9:00)",
          },
        ],
        currentBlock: null,
        inClass: { endsAt: UTC_TUE_END, blockLabel: null },
        dueDays: [],
        endOfUnit: null,
        closures: [],
      },
      "live:true",
      "live:false + startsAt",
    );
    expect(question).toContain(`live:false + startsAt:${UTC_TUE_0900}`);
    expect(question).not.toContain("startsAtMs");
  });
});

describe("review #15: ended work is filed by its own give", () => {
  test("homework given by date files as homework even with no authored mode; class time as class", async () => {
    const t = convexTest(schema, modules);
    const w = await seedWorld(t);
    // activityB has no defaultMode; give it as homework.
    await w.asTeacher.mutation(api.assignments.pushActivity, {
      assignmentId: w.assignmentId,
      activityId: w.activityB,
      finish: { kind: "by", dayKey: "2026-11-13" },
    });
    // activityA is authored "homework" but given in class.
    await w.asTeacher.mutation(api.assignments.pushActivity, {
      assignmentId: w.assignmentId,
      activityId: w.activityA,
      finish: { kind: "inClass" },
    });
    for (const activityId of [w.activityA, w.activityB]) {
      await w.asTeacher.mutation(api.assignments.clearActivity, {
        assignmentId: w.assignmentId,
        activityId,
      });
    }
    const modes = await t.run(async (ctx) => ({
      a: await endedWorkMode(ctx, w.assignmentId, w.activityA),
      b: await endedWorkMode(ctx, w.assignmentId, w.activityB),
    }));
    expect(modes).toEqual({ a: "classFocus", b: "homework" });
  });
});

describe("review #5: a give outranks the grid cell it replaces", () => {
  test("giving a linked activity detaches its cell, so reconcile can't undo the answer", async () => {
    const t = convexTest(schema, modules);
    const w = await seedWorld(t, { bellSchedule: true });
    const { placementId } = await bellIds(t);
    await t.run((ctx) =>
      ctx.db.patch(placementId, {
        assignmentId: w.assignmentId,
        activityId: w.activityA,
      }),
    );
    await w.asTeacher.mutation(api.assignments.scheduleActivity, {
      assignmentId: w.assignmentId,
      activityId: w.activityA,
      startsAt: TUESDAY_8AM + 60_000 * 30,
      finish: { kind: "by", dayKey: "2026-11-13" },
    });
    const cell = await t.run((ctx) => ctx.db.get(placementId));
    expect(cell!.activityId).toBeUndefined();
    expect(cell!.assignmentId).toBeUndefined();
    expect(cell!.subject).toBe("Humanities");

    await t.mutation(internal.masterSchedule.autoMaterializeTick, {});
    const entry = await entryFor(t, w.assignmentId, w.activityA);
    expect(entry.mode).toBe("homework");
    expect(entry.dueAt).toBe(UTC_FRI_END);
  });
});

describe("a give outside the grid leaves no empty card in the Homework due row", () => {
  test("a homework-mode class cell goes back to a plain class in its cell", async () => {
    const t = convexTest(schema, modules);
    const w = await seedWorld(t, { bellSchedule: true });
    const { placementId, periodId } = await bellIds(t);
    await t.run((ctx) =>
      ctx.db.patch(placementId, {
        assignmentId: w.assignmentId,
        activityId: w.activityA,
        mode: "homework",
      }),
    );
    await w.asTeacher.mutation(api.assignments.scheduleActivity, {
      assignmentId: w.assignmentId,
      activityId: w.activityA,
      startsAt: TUESDAY_8AM + 60_000 * 30,
      finish: { kind: "by", dayKey: "2026-11-13" },
    });
    const cell = await t.run((ctx) => ctx.db.get(placementId));
    expect(cell!.subject).toBe("Humanities");
    expect(cell!.mode).toBeUndefined();
    const grid = await w.asTeacher.query(api.masterSchedule.grid, {
      periodId,
      weekStartMs: hst("2026-11-09", "00:00"),
    });
    const row = grid!.weekPlacements.find((p) => p._id === placementId);
    expect(row!.railWeekday).toBeNull();
  });

  test("a row in the homework block that carried the work is removed", async () => {
    const t = convexTest(schema, modules);
    const w = await seedWorld(t, { bellSchedule: true });
    const { periodId, groupId } = await bellIds(t);
    const rowId = await t.run(async (ctx) => {
      const blockId = await ctx.db.insert("scheduleBlocks", {
        periodId,
        key: "homework",
        label: "Homework due",
        startLocal: "15:00",
        endLocal: "15:30",
        weekdays: [1, 2, 3, 4, 5],
        order: 9,
        kind: "homework",
      });
      return ctx.db.insert("schedulePlacements", {
        periodId,
        groupId,
        weekday: 4,
        blockId,
        subject: "Field notes",
        assignmentId: w.assignmentId,
        activityId: w.activityA,
        mode: "homework",
      });
    });
    await w.asTeacher.mutation(api.assignments.scheduleActivity, {
      assignmentId: w.assignmentId,
      activityId: w.activityA,
      startsAt: TUESDAY_8AM + 60_000 * 30,
      finish: { kind: "by", dayKey: "2026-11-13" },
    });
    expect(await t.run((ctx) => ctx.db.get(rowId))).toBeNull();
  });
});

describe("only the teacher who gave work can move it", () => {
  test("another teacher's re-give is refused in words", async () => {
    const t = convexTest(schema, modules);
    const w = await seedWorld(t);
    const other = await seedStaffWithMembership(t, {
      institutionId: w.institutionId,
      name: "Other Teacher",
    });
    const asOther = await withUser(t, other);
    const err = await asOther
      .mutation(api.assignments.scheduleActivity, {
        assignmentId: w.assignmentId,
        activityId: w.activityA,
        startsAt: TUESDAY_8AM + 60_000 * 30,
        finish: { kind: "by", dayKey: "2026-11-13" },
      })
      .then(
        () => null,
        (e: unknown) => e,
      );
    expect(err).toBeInstanceOf(ConvexError);
    expect((err as ConvexError<string>).data).toBe(NOT_YOUR_GIVE);
  });
});

// ── Adversarial review round 2 of PR #4502 ───────────────────────────────
const UTC_TUE_0859 = Date.UTC(2026, 10, 10, 18, 59);
const UTC_TUE_0902 = Date.UTC(2026, 10, 10, 19, 2);
const UTC_TUE_1020 = Date.UTC(2026, 10, 10, 20, 20);
const UTC_TUE_1200 = Date.UTC(2026, 10, 10, 22, 0);
const UTC_JAN12_END = Date.UTC(2027, 0, 13, 9, 59, 59, 999);

describe("round 2 #1: an owned roster is still checked for current access", () => {
  test("a teacher who lost her membership can't read her old roster's timetable", async () => {
    const t = convexTest(schema, modules);
    const w = await seedWorld(t, { bellSchedule: true });
    await t.run(async (ctx) => {
      for (const m of await ctx.db.query("memberships").collect()) {
        if (m.userId === w.teacher) await ctx.db.delete(m._id);
      }
    });
    const res = await w.asTeacher.query(api.assignments.giveChoices, {
      assignmentId: w.assignmentId,
      nowMs: TUESDAY_8AM,
    });
    expect(res === null || (res !== undefined && "refused" in res)).toBe(true);
    expect(
      await t.query(internal.assignments.aideGiveChoices, {
        callerUserId: w.teacher,
        assignmentId: w.assignmentId,
      }),
    ).toBeNull();
  });
});

describe("round 2 #4: Run-page answers outrank a linked grid cell too", () => {
  async function linkedPlannedEntry(t: T, w: Awaited<ReturnType<typeof seedWorld>>) {
    const { placementId } = await bellIds(t);
    await t.run(async (ctx) => {
      await ctx.db.patch(placementId, {
        assignmentId: w.assignmentId,
        activityId: w.activityA,
      });
      const a = (await ctx.db.get(w.assignmentId))!;
      // As the grid materializes it: in class, tomorrow's 09:00 block.
      await applyScheduleActivity(ctx, a, {
        activityId: w.activityA,
        mode: "classFocus",
        startsAt: UTC_TUE_0900 + 24 * 3_600_000,
        endsAt: UTC_TUE_1015 + 24 * 3_600_000,
      });
    });
    return placementId;
  }

  test("Start now (plannedReleaseArgs) detaches the cell, so reconcile keeps today's window", async () => {
    vi.setSystemTime(TUESDAY_930AM);
    const t = convexTest(schema, modules);
    const w = await seedWorld(t, { bellSchedule: true });
    const placementId = await linkedPlannedEntry(t, w);
    const planned = await entryFor(t, w.assignmentId, w.activityA);
    await w.asTeacher.mutation(api.assignments.pushActivity, {
      assignmentId: w.assignmentId,
      activityId: w.activityA,
      ...plannedReleaseArgs(
        {
          mode: planned.mode,
          endsAt: planned.endsAt ?? null,
          dueAt: planned.dueAt ?? null,
          scholarIds: planned.scholarIds ?? null,
        },
        Date.now(),
        TIME_ZONE,
      ),
    });
    expect((await t.run((ctx) => ctx.db.get(placementId)))!.activityId).toBeUndefined();
    await t.mutation(internal.masterSchedule.autoMaterializeTick, {});
    const entry = await entryFor(t, w.assignmentId, w.activityA);
    expect(entry.setAt).toBe(TUESDAY_930AM);
    expect(entry.endsAt).toBe(UTC_TUE_1015);
  });

  test("rescheduling a linked entry detaches the cell", async () => {
    const t = convexTest(schema, modules);
    const w = await seedWorld(t, { bellSchedule: true });
    const placementId = await linkedPlannedEntry(t, w);
    await w.asTeacher.mutation(api.assignments.rescheduleActivity, {
      assignmentId: w.assignmentId,
      activityId: w.activityA,
      startsAt: UTC_TUE_0900 + 48 * 3_600_000,
    });
    expect((await t.run((ctx) => ctx.db.get(placementId)))!.activityId).toBeUndefined();
  });
});

describe("round 2 #6: the finish is resolved after the start is settled", () => {
  test("at 09:02, an 08:59 start in class goes live now and ends with the 09:00 class", async () => {
    vi.setSystemTime(UTC_TUE_0902);
    const t = convexTest(schema, modules);
    const w = await seedWorld(t, { bellSchedule: true });
    await w.asTeacher.mutation(api.assignments.scheduleActivity, {
      assignmentId: w.assignmentId,
      activityId: w.activityA,
      startsAt: UTC_TUE_0859,
      finish: { kind: "inClass" },
    });
    const entry = await entryFor(t, w.assignmentId, w.activityA);
    expect(entry.setAt).toBe(UTC_TUE_0902);
    expect(entry.endsAt).toBe(UTC_TUE_1015);
  });
});

describe("round 2 #7: editing live work never stores an expired focus", () => {
  test("at 10:20, live homework re-given in class keeps a future end", async () => {
    vi.setSystemTime(TUESDAY_930AM);
    const t = convexTest(schema, modules);
    const w = await seedWorld(t, { bellSchedule: true });
    await w.asTeacher.mutation(api.assignments.pushActivity, {
      assignmentId: w.assignmentId,
      activityId: w.activityA,
      finish: { kind: "by", dayKey: "2026-11-13" },
    });
    vi.setSystemTime(UTC_TUE_1020);
    await w.asTeacher.mutation(api.assignments.scheduleActivity, {
      assignmentId: w.assignmentId,
      activityId: w.activityA,
      startsAt: TUESDAY_930AM,
      finish: { kind: "inClass" },
    });
    const entry = await entryFor(t, w.assignmentId, w.activityA);
    expect(entry.mode).toBe("classFocus");
    expect(entry.setAt).toBe(TUESDAY_930AM);
    // No class at 10:20, so it ends with the school day — never 10:15.
    expect(entry.endsAt).toBe(UTC_TUE_END);
  });
});

describe("round 2 #8: moved-to-now and late dispatch activate", () => {
  test("rescheduling a planned entry to now makes it live", async () => {
    const t = convexTest(schema, modules);
    const w = await seedWorld(t);
    await w.asTeacher.mutation(api.assignments.scheduleActivity, {
      assignmentId: w.assignmentId,
      activityId: w.activityA,
      startsAt: TUESDAY_8AM + 3_600_000,
      finish: { kind: "by", dayKey: "2026-11-13" },
    });
    await w.asTeacher.mutation(api.assignments.rescheduleActivity, {
      assignmentId: w.assignmentId,
      activityId: w.activityA,
      startsAt: TUESDAY_8AM,
    });
    const entry = await entryFor(t, w.assignmentId, w.activityA);
    expect(entry.setAt).toBe(TUESDAY_8AM);
    expect(entry.dueAt).toBe(UTC_FRI_END);
  });

  test("a dispatch whose start passed during the turn goes live", async () => {
    const t = convexTest(schema, modules);
    const w = await seedWorld(t);
    const res = await w.asTeacher.mutation(api.assignments.dispatchActivity, {
      scholarId: w.scholar,
      title: "Tide pool question",
      live: false,
      startsAt: TUESDAY_8AM - 60_000,
      finish: { kind: "by", dayKey: "2026-11-13" },
    });
    const entry = await entryFor(t, res.assignmentId, res.activityId);
    expect(entry.setAt).toBe(TUESDAY_8AM);
  });
});

describe("round 2 #9 and #10: bell lookup edges", () => {
  test("a date no term covers has no bell schedule: it ends with that day", async () => {
    const t = convexTest(schema, modules);
    const w = await seedWorld(t, { bellSchedule: true });
    await w.asTeacher.mutation(api.assignments.scheduleActivity, {
      assignmentId: w.assignmentId,
      activityId: w.activityA,
      startsAt: Date.UTC(2027, 0, 12, 19, 30), // Tue Jan 12 2027, 09:30 HST
      finish: { kind: "inClass" },
    });
    expect((await entryFor(t, w.assignmentId, w.activityA)).endsAt).toBe(
      UTC_JAN12_END,
    );
  });

  test("a double period ends with the group's override of its second block", async () => {
    vi.setSystemTime(TUESDAY_930AM);
    const t = convexTest(schema, modules);
    const w = await seedWorld(t, { bellSchedule: true });
    const { periodId, groupId, placementId } = await bellIds(t);
    await t.run(async (ctx) => {
      await ctx.db.insert("scheduleBlocks", {
        periodId,
        key: "blockB",
        label: "Block B",
        startLocal: "10:15",
        endLocal: "11:30",
        weekdays: [1, 2, 3, 4, 5],
        order: 1,
        kind: "class",
      });
      await ctx.db.insert("scheduleBlocks", {
        periodId,
        groupId,
        key: "blockB",
        label: "Block B (Honu)",
        startLocal: "10:15",
        endLocal: "12:00",
        weekdays: [1, 2, 3, 4, 5],
        order: 1,
        kind: "class",
      });
      await ctx.db.patch(placementId, { spanBlocks: 2 });
    });
    await w.asTeacher.mutation(api.assignments.pushActivity, {
      assignmentId: w.assignmentId,
      activityId: w.activityA,
      finish: { kind: "inClass" },
    });
    expect((await entryFor(t, w.assignmentId, w.activityA)).endsAt).toBe(
      UTC_TUE_1200,
    );
  });
});

describe("round 2 #11: ended work follows the latest ACTIVATED give", () => {
  test("focus → homework → focus → clear files as class; a planned row doesn't count", async () => {
    const t = convexTest(schema, modules);
    const w = await seedWorld(t);
    const give = async (finish: { kind: "inClass" } | { kind: "by"; dayKey: string }) =>
      w.asTeacher.mutation(api.assignments.pushActivity, {
        assignmentId: w.assignmentId,
        activityId: w.activityA,
        finish,
      });
    vi.setSystemTime(TUESDAY_8AM);
    await give({ kind: "inClass" });
    vi.setSystemTime(TUESDAY_8AM + 60_000);
    await give({ kind: "by", dayKey: "2026-11-13" });
    vi.setSystemTime(TUESDAY_8AM + 120_000);
    await give({ kind: "inClass" });
    vi.setSystemTime(TUESDAY_8AM + 180_000);
    await w.asTeacher.mutation(api.assignments.clearActivity, {
      assignmentId: w.assignmentId,
      activityId: w.activityA,
    });
    // A later homework give that is only PLANNED never reached scholars.
    await w.asTeacher.mutation(api.assignments.scheduleActivity, {
      assignmentId: w.assignmentId,
      activityId: w.activityA,
      startsAt: TUESDAY_8AM + 24 * 3_600_000,
      finish: { kind: "by", dayKey: "2026-11-13" },
    });
    expect(
      await t.run((ctx) => endedWorkMode(ctx, w.assignmentId, w.activityA)),
    ).toBe("classFocus");
  });
});

describe("the give tool surfaces a refused roster as its error, never an empty success", () => {
  test("assignment route: an unreachable named scholar is refused with text and writes nothing; the reachable cohort still gets it", async () => {
    const t = convexTest(schema, modules);
    const w = await seedWorld(t, { bellSchedule: true });
    const outsider = await foreignScholar(t);
    // A transferred scholar still on the roster.
    await t.run((ctx) =>
      ctx.db.patch(w.assignmentId, { scholarIds: [w.scholar, outsider] }),
    );
    const tools = await toolsFor(t, w.teacher);
    const before = await counts(t);

    // Naming the unreachable scholar: a refusal, as text.
    const named = await tools.give.run({
      assignmentId: w.assignmentId,
      activityId: w.activityA,
      scholarId: outsider,
      startsNow: true,
      finish: "2026-11-13",
    });
    expect(() => JSON.parse(named)).toThrow();
    expect(named).toMatch(/Could not give it|Nothing given|NOT GIVEN|can't/i);
    expect(await scheduleOf(t, w.assignmentId)).toEqual([]);
    expect(await counts(t)).toEqual(before);

    // The assignment's own cohort: the question still comes back (never a
    // crash), and an answered give succeeds.
    const noFinish = await tools.give.run({
      assignmentId: w.assignmentId,
      activityId: w.activityA,
      startsNow: true,
    });
    expect(noFinish.startsWith("NOT GIVEN")).toBe(true);
    const given = await tools.give.run({
      assignmentId: w.assignmentId,
      activityId: w.activityA,
      startsNow: true,
      finish: "2026-11-13",
    });
    expect(JSON.parse(given)).toMatchObject({ ok: true, live: true });
  });
});

describe("a finish date that isn't a school day is given, with a note", () => {
  test("give notes a closure date and says nothing for a school day", async () => {
    const t = convexTest(schema, modules);
    const w = await seedWorld(t);
    await t.run((ctx) =>
      ctx.db.insert("schoolClosures", {
        institutionId: w.institutionId,
        startDayKey: "2026-11-11",
        endDayKey: "2026-11-11",
        label: "Veterans Day",
        kind: "holiday",
      }),
    );
    const tools = await toolsFor(t, w.teacher);
    const base = { unitTitle: "Tide Pools", scholarNames: ["Kaimana Example"] };

    const closed = JSON.parse(
      await tools.give.run({
        ...base,
        startsNow: true,
        activityTitle: "Field notes",
        finish: "2026-11-11",
      }),
    ) as { ok: boolean; finish: string };
    expect(closed.ok).toBe(true);
    expect(closed.finish).toContain("no-school day (Veterans Day)");
    // A warning, not a refusal: the give was stored with that due date.
    expect((await entryFor(t, w.assignmentId, w.activityA)).dueAt).toBe(
      schoolDayEndAt("2026-11-11", TIME_ZONE),
    );

    const open = JSON.parse(
      await tools.give.run({
        ...base,
        startsNow: true,
        activityTitle: "Share-out",
        finish: "2026-11-12",
      }),
    ) as { ok: boolean; finish: string };
    expect(open.ok).toBe(true);
    expect(open.finish).not.toContain("Note:");
  });
});

describe("open until a date (stored as class focus that ends on a later day)", () => {
  const SATURDAY = "2026-11-14";

  test("maps onto classFocus ending at the end of that day, which isOpenUntil recognizes", async () => {
    const t = convexTest(schema, modules);
    const w = await seedWorld(t, { bellSchedule: true });
    vi.setSystemTime(TUESDAY_930AM);
    await w.asTeacher.mutation(api.assignments.pushActivity, {
      assignmentId: w.assignmentId,
      activityId: w.activityA,
      finish: { kind: "openUntil", dayKey: SATURDAY },
    });
    const entry = await entryFor(t, w.assignmentId, w.activityA);
    expect(entry.mode).toBe("classFocus");
    expect(entry.endsAt).toBe(schoolDayEndAt(SATURDAY, TIME_ZONE));
    expect(entry.dueAt).toBeUndefined();
    expect(isOpenUntil(entry, TIME_ZONE)).toBe(true);
  });

  test("the same day it shows up is refused with a question and writes nothing", async () => {
    const t = convexTest(schema, modules);
    const w = await seedWorld(t);
    await expect(
      w.asTeacher.mutation(api.assignments.scheduleActivity, {
        assignmentId: w.assignmentId,
        activityId: w.activityA,
        startsAt: TUESDAY_930AM,
        finish: { kind: "openUntil", dayKey: TUESDAY },
      }),
    ).rejects.toThrow(/\?$/);
    expect(await scheduleOf(t, w.assignmentId)).toEqual([]);
  });

  test("give takes finish 'openUntil:YYYY-MM-DD' and stores that window", async () => {
    const t = convexTest(schema, modules);
    const w = await seedWorld(t);
    const tools = await toolsFor(t, w.teacher);
    const given = JSON.parse(
      await tools.give.run({
        unitTitle: "Tide Pools",
        activityTitle: "Field notes",
        scholarNames: ["Kaimana Example"],
        startsNow: true,
        finish: `openUntil:${SATURDAY}`,
      }),
    ) as Record<string, unknown>;
    expect(given).toMatchObject({ ok: true, live: true });
    const entry = await entryFor(t, w.assignmentId, w.activityA);
    expect(entry).toMatchObject({
      mode: "classFocus",
      endsAt: schoolDayEndAt(SATURDAY, TIME_ZONE),
    });
    expect(entry.setAt).toBeDefined();
  });

  test("a cached old give name (assign_activity_now) carries the open-until finish onto give", async () => {
    const t = convexTest(schema, modules);
    const w = await seedWorld(t);
    const list = await makeAssignmentTools(actionCtxFor(t), () => {}, {
      role: "teacher",
      callerUserId: w.teacher,
    });
    const routed = resolveToolWithLegacyGive(list, "assign_activity_now", {
      unitTitle: "Tide Pools",
      activityTitle: "Field notes",
      scholarNames: ["Kaimana Example"],
      finish: `openUntil:${SATURDAY}`,
    })!;
    expect(routed.tool.name).toBe("give");
    await (routed.tool as unknown as { run: (i: unknown) => Promise<string> }).run(
      routed.input,
    );
    const entry = await entryFor(t, w.assignmentId, w.activityA);
    expect(entry).toMatchObject({
      mode: "classFocus",
      endsAt: schoolDayEndAt(SATURDAY, TIME_ZONE),
    });
    expect(entry.setAt).toBeDefined();
  });

  test("a garbled open-until finish gives nothing", async () => {
    const t = convexTest(schema, modules);
    const w = await seedWorld(t);
    const tools = await toolsFor(t, w.teacher);
    await tools.give.run({
      unitTitle: "Tide Pools",
      activityTitle: "Field notes",
      scholarNames: ["Kaimana Example"],
      startsNow: true,
      finish: "openUntil:Saturday",
    });
    expect(await scheduleOf(t, w.assignmentId)).toEqual([]);
  });

  test("the scholar sees it on Your list, not in the class section; it's gone after it closes", async () => {
    const t = convexTest(schema, modules);
    const w = await seedWorld(t, { bellSchedule: true });
    vi.setSystemTime(TUESDAY_930AM);
    // One open-until give and one in-class give, side by side.
    await w.asTeacher.mutation(api.assignments.pushActivity, {
      assignmentId: w.assignmentId,
      activityId: w.activityA,
      finish: { kind: "openUntil", dayKey: SATURDAY },
    });
    await w.asTeacher.mutation(api.assignments.pushActivity, {
      assignmentId: w.assignmentId,
      activityId: w.activityB,
      finish: { kind: "inClass" },
    });
    const asScholar = await withUser(t, w.scholar);

    const focus = await asScholar.query(api.assignments.currentClassFocusForMe, {});
    expect(focus.map((f) => f.activityId)).toEqual([w.activityB]);

    const plate = await asScholar.query(api.scholarPlate.activeForMe, {});
    const openRow = plate.rows.find((r) => r.activityId === w.activityA)!;
    expect(openRow).toMatchObject({
      origin: "classFocus",
      openUntil: schoolDayEndAt(SATURDAY, TIME_ZONE),
      dueAt: null,
    });
    const inClassRow = plate.rows.find((r) => r.activityId === w.activityB)!;
    expect(inClassRow.openUntil).toBeNull();
    const now = Date.now();
    expect(
      yourListRowsForTab(plate.rows, "now", now).map((r) => r.activityId),
    ).toEqual([w.activityA]);
    // Never late, and never Homework: it sits in Open from class (TRA-724).
    const list = buildYourList(yourListRowsForTab(plate.rows, "now", now), {
      nowMs: now,
      timeZone: TIME_ZONE,
    });
    expect(list.homework.isEmpty).toBe(true);
    expect(
      list.openFromClass.sections.map((s) => [s.kind, s.items.map((r) => r.activityId)]),
    ).toEqual([["openFromClass", [w.activityA]]]);

    // Sunday: the unstarted give has left the list.
    vi.setSystemTime(hst("2026-11-15", "09:00"));
    const after = await asScholar.query(api.scholarPlate.activeForMe, {});
    expect(
      yourListRowsForTab(after.rows, "now", Date.now()).map((r) => r.activityId),
    ).toEqual([]);
  });

  test("the parent plan lists it in its closing week, with no status, even after it closes", async () => {
    const t = convexTest(schema, modules);
    const w = await seedWorld(t);
    await w.asTeacher.mutation(api.assignments.pushActivity, {
      assignmentId: w.assignmentId,
      activityId: w.activityA,
      finish: { kind: "openUntil", dayKey: SATURDAY },
    });
    await w.asTeacher.mutation(api.assignments.pushActivity, {
      assignmentId: w.assignmentId,
      activityId: w.activityB,
      finish: { kind: "inClass" },
    });
    const plan = await t.query(internal.parents.getChildHomeworkPlan, {
      scholarId: w.scholar,
    });
    expect(plan!.items).toEqual([
      expect.objectContaining({
        title: "Field notes",
        dueAt: null,
        openUntil: schoolDayEndAt(SATURDAY, TIME_ZONE),
      }),
    ]);
    vi.setSystemTime(hst("2026-11-15", "09:00"));
    const later = await t.query(internal.parents.getChildHomeworkPlan, {
      scholarId: w.scholar,
    });
    expect(later!.items.map((item) => item.title)).toEqual(["Field notes"]);
  });

  test("the Run page's progress carries what the closed line needs", async () => {
    const t = convexTest(schema, modules);
    const w = await seedWorld(t);
    await w.asTeacher.mutation(api.assignments.pushActivity, {
      assignmentId: w.assignmentId,
      activityId: w.activityA,
      finish: { kind: "openUntil", dayKey: SATURDAY },
    });
    await t.run((ctx) =>
      ctx.db.insert("activityCompletions", {
        scholarId: w.scholar,
        activityId: w.activityA,
        assignmentId: w.assignmentId,
        completedAt: Date.now(),
      } as never),
    );
    vi.setSystemTime(hst("2026-11-15", "09:00"));
    const progress = await w.asTeacher.query(api.assignments.activityProgress, {
      assignmentId: w.assignmentId,
    });
    const row = progress!.lessons
      .flatMap((l) => l.activities)
      .find((a) => a.activityId === w.activityA)!;
    expect(
      openUntilClosedLine(row.schedule!, {
        rosterIds: [String(w.scholar)],
        completedScholarIds: row.completedScholarIds,
        nowMs: Date.now(),
        timeZone: TIME_ZONE,
      }),
    ).toBe("Closed Sat · 1 of 1 finished");
  });

  // The scheduled jobs are what used to lose it: the auto-clear at `endsAt`
  // removed the entry, and convex-test only runs scheduled functions when
  // asked. So this test asks, then checks every surface that must keep it.
  test("after its window closes and every scheduled job has run, the Run page and parent plan keep it", async () => {
    const t = convexTest(schema, modules);
    vi.useFakeTimers();
    vi.setSystemTime(TUESDAY_930AM);
    const w = await seedWorld(t, { bellSchedule: true });
    await w.asTeacher.mutation(api.assignments.pushActivity, {
      assignmentId: w.assignmentId,
      activityId: w.activityA,
      finish: { kind: "openUntil", dayKey: SATURDAY },
    });
    // The control: an in-class give still clears with its bell block.
    await w.asTeacher.mutation(api.assignments.pushActivity, {
      assignmentId: w.assignmentId,
      activityId: w.activityB,
      finish: { kind: "inClass" },
    });
    await t.run((ctx) =>
      ctx.db.insert("activityCompletions", {
        scholarId: w.scholar,
        activityId: w.activityA,
        assignmentId: w.assignmentId,
        completedAt: Date.now(),
      } as never),
    );
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    vi.setSystemTime(hst("2026-11-15", "09:00"));

    const schedule = await scheduleOf(t, w.assignmentId);
    expect(schedule.map((e) => e.activityId)).toEqual([w.activityA]);

    const progress = await w.asTeacher.query(api.assignments.activityProgress, {
      assignmentId: w.assignmentId,
    });
    const row = progress!.lessons
      .flatMap((l) => l.activities)
      .find((a) => a.activityId === w.activityA)!;
    expect(row.schedule).toBeTruthy();
    expect(
      openUntilClosedLine(row.schedule!, {
        rosterIds: [String(w.scholar)],
        completedScholarIds: row.completedScholarIds,
        nowMs: Date.now(),
        timeZone: TIME_ZONE,
      }),
    ).toBe("Closed Sat · 1 of 1 finished");

    const plan = await t.query(internal.parents.getChildHomeworkPlan, {
      scholarId: w.scholar,
    });
    expect(plan!.items.map((item) => item.title)).toEqual(["Field notes"]);

    // Closed means closed for everyone else: not on the scholar's list, not
    // in the class section, not a live push on the teacher's side.
    const asScholar = await withUser(t, w.scholar);
    const plate = await asScholar.query(api.scholarPlate.activeForMe, {});
    expect(
      yourListRowsForTab(plate.rows, "now", Date.now()).map((r) => r.activityId),
    ).toEqual([]);
    // Unstarted, so it isn't "Pick up where you left off" either: the row
    // is gone from Home.
    expect(plate.rows.map((r) => r.activityId)).toEqual([]);
    expect(
      await asScholar.query(api.assignments.currentClassFocusForMe, {}),
    ).toEqual([]);
  });

  test("after it closes, a started give is 'Pick up where you left off' and an unstarted one is gone", async () => {
    const t = convexTest(schema, modules);
    vi.useFakeTimers();
    vi.setSystemTime(TUESDAY_930AM);
    const w = await seedWorld(t);
    for (const activityId of [w.activityA, w.activityB]) {
      await w.asTeacher.mutation(api.assignments.pushActivity, {
        assignmentId: w.assignmentId,
        activityId,
        finish: { kind: "openUntil", dayKey: SATURDAY },
      });
    }
    await t.run((ctx) =>
      ctx.db.insert("sessions", {
        userId: w.scholar,
        unitId: w.unitId,
        activityId: w.activityA,
        assignmentId: w.assignmentId,
        title: "Field notes",
        isArchived: false,
        lastMessageAt: Date.now(),
      }),
    );
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    vi.setSystemTime(hst("2026-11-16", "09:00"));
    const asScholar = await withUser(t, w.scholar);
    const plate = await asScholar.query(api.scholarPlate.activeForMe, {});
    const now = Date.now();
    expect(yourListRowsForTab(plate.rows, "now", now)).toEqual([]);
    expect(pickUpRows(plate.rows, [], now).map((r) => r.activityId)).toEqual([
      w.activityA,
    ]);
  });

  test("giving it again after it closes is a fresh give: planned until its start, not open-until", async () => {
    const t = convexTest(schema, modules);
    vi.useFakeTimers();
    vi.setSystemTime(TUESDAY_930AM);
    const w = await seedWorld(t);
    await w.asTeacher.mutation(api.assignments.pushActivity, {
      assignmentId: w.assignmentId,
      activityId: w.activityA,
      finish: { kind: "openUntil", dayKey: SATURDAY },
    });
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    const MONDAY = "2026-11-16";
    vi.setSystemTime(hst(MONDAY, "08:00"));
    await w.asTeacher.mutation(api.assignments.scheduleActivity, {
      assignmentId: w.assignmentId,
      activityId: w.activityA,
      startsAt: hst("2026-11-17", "09:00"),
      finish: { kind: "inClass" },
    });
    const entry = await entryFor(t, w.assignmentId, w.activityA);
    expect(entry.setAt).toBeUndefined();
    expect(isOpenUntil(entry, TIME_ZONE)).toBe(false);
    const asScholar = await withUser(t, w.scholar);
    const plate = await asScholar.query(api.scholarPlate.activeForMe, {});
    expect(plate.rows.map((r) => r.activityId)).toEqual([]);
  });
});

describe("next week's homework (TRA-581)", () => {
  // "Today" is Tuesday 2026-11-10, so next school week is Nov 16–20.
  const input = {
    unitTitle: "Tide Pools",
    activityTitle: "Field notes",
    scholarNames: ["Kaimana Example"],
  };

  test("shows up next Monday, due at the end of next Friday, planned now", async () => {
    const t = convexTest(schema, modules);
    const w = await seedWorld(t);
    const tools = await toolsFor(t, w.teacher);
    const given = JSON.parse(
      await tools.give.run({ ...input, nextWeekHomework: true }),
    ) as Record<string, unknown>;
    expect(given).toMatchObject({ ok: true });
    const entry = await entryFor(t, w.assignmentId, w.activityA);
    expect(entry).toMatchObject({
      mode: "homework",
      startsAt: hst("2026-11-16", "00:00"),
      dueAt: schoolDayEndAt("2026-11-20", TIME_ZONE),
    });
    expect(entry.setAt).toBeUndefined();
  });

  test("a holiday Friday makes it due Thursday; a closed Monday shows it Tuesday", async () => {
    const t = convexTest(schema, modules);
    const w = await seedWorld(t);
    await t.run(async (ctx) => {
      for (const day of ["2026-11-16", "2026-11-20"]) {
        await ctx.db.insert("schoolClosures", {
          institutionId: w.institutionId,
          startDayKey: day,
          endDayKey: day,
          label: "Fictional Holiday",
          kind: "holiday",
        });
      }
    });
    const tools = await toolsFor(t, w.teacher);
    await tools.give.run({ ...input, nextWeekHomework: true });
    expect(await entryFor(t, w.assignmentId, w.activityA)).toMatchObject({
      mode: "homework",
      startsAt: hst("2026-11-17", "00:00"),
      dueAt: schoolDayEndAt("2026-11-19", TIME_ZONE),
    });
  });

  test("a week with no school asks which week and gives nothing", async () => {
    const t = convexTest(schema, modules);
    const w = await seedWorld(t);
    await t.run((ctx) =>
      ctx.db.insert("schoolClosures", {
        institutionId: w.institutionId,
        startDayKey: "2026-11-16",
        endDayKey: "2026-11-20",
        label: "Fictional Break",
        kind: "holiday",
      }),
    );
    const tools = await toolsFor(t, w.teacher);
    const res = await tools.give.run({ ...input, nextWeekHomework: true });
    expect(res.startsWith("NOT GIVEN")).toBe(true);
    expect(await scheduleOf(t, w.assignmentId)).toEqual([]);
  });

  test("refuses a second answer alongside it", async () => {
    const t = convexTest(schema, modules);
    const w = await seedWorld(t);
    const tools = await toolsFor(t, w.teacher);
    const res = await tools.give.run({
      ...input,
      nextWeekHomework: true,
      finish: "2026-11-13",
    });
    expect(res).toMatch(/Nothing given/);
    expect(await scheduleOf(t, w.assignmentId)).toEqual([]);
  });

  test("finish 'thisWeek' is the week's last school day, with closures", async () => {
    const t = convexTest(schema, modules);
    const w = await seedWorld(t);
    await t.run((ctx) =>
      ctx.db.insert("schoolClosures", {
        institutionId: w.institutionId,
        startDayKey: "2026-11-13",
        endDayKey: "2026-11-13",
        label: "Fictional Holiday",
        kind: "holiday",
      }),
    );
    const tools = await toolsFor(t, w.teacher);
    await tools.give.run({ ...input, startsNow: true, finish: "thisWeek" });
    expect(await entryFor(t, w.assignmentId, w.activityA)).toMatchObject({
      mode: "homework",
      dueAt: schoolDayEndAt("2026-11-12", TIME_ZONE),
    });
  });

  test("the finish question offers this week by its label", async () => {
    const t = convexTest(schema, modules);
    const w = await seedWorld(t);
    const tools = await toolsFor(t, w.teacher);
    const res = await tools.give.run({ ...input, startsNow: true });
    expect(res).toContain("By this week (Fri, Nov 13) → finish:'2026-11-13'");
  });

  test("give choices default to the week's last school day, labeled this week", async () => {
    const t = convexTest(schema, modules);
    const w = await seedWorld(t);
    await t.run((ctx) =>
      ctx.db.insert("schoolClosures", {
        institutionId: w.institutionId,
        startDayKey: "2026-11-13",
        endDayKey: "2026-11-13",
        label: "Fictional Holiday",
        kind: "holiday",
      }),
    );
    const choices = await t.query(internal.assignments.aideGiveChoices, {
      callerUserId: w.teacher,
      assignmentId: w.assignmentId,
    });
    expect(choices?.dueDays).toEqual([
      { dayKey: "2026-11-11", label: "Tomorrow", isWeekEnd: false },
      { dayKey: "2026-11-12", label: "This week (Thu, Nov 12)", isWeekEnd: true },
    ]);
  });
});

describe("TRA-638: open-until is read from the give's own start", () => {
  const MONDAY = "2026-11-09";
  const FRIDAY = "2026-11-13";

  test("yesterday's live homework re-given in class today is today's class focus, cleared at the bell", async () => {
    vi.setSystemTime(hst(MONDAY, "09:30"));
    const t = convexTest(schema, modules);
    const w = await seedWorld(t, { bellSchedule: true });
    await w.asTeacher.mutation(api.assignments.pushActivity, {
      assignmentId: w.assignmentId,
      activityId: w.activityA,
      finish: { kind: "by", dayKey: FRIDAY },
    });
    vi.setSystemTime(TUESDAY_930AM);
    await w.asTeacher.mutation(api.assignments.scheduleActivity, {
      assignmentId: w.assignmentId,
      activityId: w.activityA,
      startsAt: TUESDAY_930AM,
      finish: { kind: "inClass" },
    });
    const entry = await entryFor(t, w.assignmentId, w.activityA);
    expect(entry.mode).toBe("classFocus");
    expect(entry.endsAt).toBe(BLOCK_END_TUESDAY);
    // A new class occurrence: live since now, so not "Open until Tue".
    expect(entry.setAt).toBe(TUESDAY_930AM);
    expect(isOpenUntil(entry, TIME_ZONE)).toBe(false);
    // The bell clear job is armed for this occurrence.
    expect(entry.scheduledFnId).toBeDefined();

    const asScholar = await withUser(t, w.scholar);
    const focus = await asScholar.query(api.assignments.currentClassFocusForMe, {});
    expect(focus.map((f) => f.activityId)).toEqual([w.activityA]);
    const plate = await asScholar.query(api.scholarPlate.activeForMe, {});
    expect(plate.rows.find((r) => r.activityId === w.activityA)?.openUntil ?? null).toBeNull();
  });

  test("open-until work re-given open-until keeps its setAt and stays open-until", async () => {
    vi.setSystemTime(hst(MONDAY, "09:30"));
    const t = convexTest(schema, modules);
    const w = await seedWorld(t, { bellSchedule: true });
    await w.asTeacher.mutation(api.assignments.pushActivity, {
      assignmentId: w.assignmentId,
      activityId: w.activityA,
      finish: { kind: "openUntil", dayKey: "2026-11-12" },
    });
    vi.setSystemTime(TUESDAY_930AM);
    await w.asTeacher.mutation(api.assignments.scheduleActivity, {
      assignmentId: w.assignmentId,
      activityId: w.activityA,
      startsAt: TUESDAY_930AM,
      finish: { kind: "openUntil", dayKey: FRIDAY },
    });
    const entry = await entryFor(t, w.assignmentId, w.activityA);
    expect(entry.setAt).toBe(hst(MONDAY, "09:30"));
    expect(isOpenUntil(entry, TIME_ZONE)).toBe(true);
  });

  test("Start now on planned open-until work keeps the chosen day, not today's bell", async () => {
    vi.setSystemTime(TUESDAY_8AM);
    const t = convexTest(schema, modules);
    const w = await seedWorld(t, { bellSchedule: true });
    await w.asTeacher.mutation(api.assignments.scheduleActivity, {
      assignmentId: w.assignmentId,
      activityId: w.activityA,
      startsAt: hst("2026-11-11", "09:00"),
      finish: { kind: "openUntil", dayKey: FRIDAY },
    });
    const planned = await entryFor(t, w.assignmentId, w.activityA);
    vi.setSystemTime(TUESDAY_930AM);
    await w.asTeacher.mutation(api.assignments.pushActivity, {
      assignmentId: w.assignmentId,
      activityId: w.activityA,
      ...plannedReleaseArgs(
        {
          mode: planned.mode,
          startsAt: planned.startsAt ?? null,
          endsAt: planned.endsAt ?? null,
          dueAt: planned.dueAt ?? null,
          scholarIds: planned.scholarIds ?? null,
        },
        Date.now(),
        TIME_ZONE,
      ),
    });
    const entry = await entryFor(t, w.assignmentId, w.activityA);
    expect(entry.setAt).toBe(TUESDAY_930AM);
    expect(entry.endsAt).toBe(schoolDayEndAt(FRIDAY, TIME_ZONE));
    expect(isOpenUntil(entry, TIME_ZONE)).toBe(true);
  });
});
