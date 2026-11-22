// The aide's class-planning writes (TRA-582) through the real give and
// reschedule writers: gives land on the class meetings, linked to the class
// and day; confirmation is enforced by the server (a stored plan, a later
// turn, the same person and place, once); a plan with a problem writes
// nothing; a plan never gives into an assignment shared with another group;
// moves cover homework and skip closures; another school's teacher is refused.
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import schema from "../schema";
import { api, internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import type { GiveFinish } from "../lib/giveWindow";
import { coreAssignWork } from "../assignments";
import { writeSchedule } from "../lib/scheduleStore";
import { makeActivity, makeLesson, makeUnit, makeWorld } from "./factories/world";

const modules = (
  import.meta as ImportMeta & {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("../**/*.ts");

const timeZone = "Pacific/Honolulu";
const at = (day: string, clock: string) => Date.parse(`${day}T${clock}:00-10:00`);
const inClass: GiveFinish = { kind: "inClass" };

// "Today" is Tue 2026-11-10, 8:00, before class.
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(at("2026-11-10", "08:00"));
});
afterEach(() => vi.useRealTimers());

type Item = { activityId: Id<"activities">; dayKey: string; finish: GiveFinish; stack?: boolean; block?: string };

async function setup() {
  const t = convexTest(schema, modules);
  const world = await makeWorld(t, { parentsPerSchool: 0, scholarsPerSchool: 4 });
  const school = world.schools[0];
  const teacher = await world.as.staffOf(school);
  const unitId = await makeUnit(t, school.teacher, school, { title: "Island Maps" });
  const lessonId = await makeLesson(t, unitId);
  const titles = ["Reading the coast", "Wind and wave", "Drawing our island", "Sharing maps"];
  const activityIds: Id<"activities">[] = [];
  for (const [order, title] of titles.entries()) {
    activityIds.push(await makeActivity(t, lessonId, { title, order }));
  }
  const scholarIds = school.scholars.map((s) => s.id);
  const ids = await t.run(async (ctx) => {
    await ctx.db.patch(school.id, { timeZone });
    const groupId = await ctx.db.insert("scholarGroups", {
      institutionId: school.id,
      teacherId: school.teacher.id,
      name: "Reef group",
      scholarIds,
    });
    const periodId = await ctx.db.insert("reportingPeriods", {
      institutionId: school.id,
      label: "Fall",
      startsAt: at("2026-08-01", "00:00"),
      endsAt: at("2026-12-20", "00:00"),
      status: "open",
    });
    const blockId = await ctx.db.insert("scheduleBlocks", {
      periodId, key: "morning", label: "Morning",
      startLocal: "09:00", endLocal: "10:15", weekdays: [1, 2, 3, 4, 5], order: 0,
    });
    await ctx.db.insert("schoolClosures", {
      institutionId: school.id, startDayKey: "2026-11-13", endDayKey: "2026-11-13",
      label: "Staff day", kind: "staffOnly",
    });
    return { groupId, periodId, blockId };
  });
  // Humanities meets Mon, Tue, Thu, Fri; not Wednesday.
  for (const weekday of [1, 2, 4, 5]) {
    await teacher.mutation(api.masterSchedule.placeClass, {
      periodId: ids.periodId, groupId: ids.groupId, blockId: ids.blockId,
      weekday, subject: "Humanities", teacherId: school.teacher.id,
    });
  }
  const [cls] = await t.run((ctx) => ctx.db.query("classes").collect());
  const callerUserId = school.teacher.id;
  const scope = (turn: number, over: Partial<{ callerUserId: Id<"users">; surface: "app" | "slack"; slackChannelId: string; slackThreadTs: string }> = {}) => ({
    callerUserId, surface: "app" as const, turn, ...over,
  });
  const payload = (items: Item[], members = scholarIds) => ({
    groupId: ids.groupId, subject: "Humanities", unitId, scholarIds: members, items,
  });
  /** Plan at `turn`, then confirm at `turn + 1`. */
  const give = async (items: Item[], turn = 1, members = scholarIds) => {
    const planned = await t.mutation(internal.classPlans.planClassGivesWrite, {
      scope: scope(turn), payload: payload(items, members),
    });
    if (!planned.plan.ok || !planned.confirmationId) {
      throw new Error(`not plannable: ${JSON.stringify(planned.plan)}`);
    }
    return await t.mutation(internal.classPlans.commitClassGives, {
      scope: scope(turn + 1), payload: payload(items, members),
    });
  };
  const movePayload = (fromDayKey: string, throughDayKey: string, byMeetings: number, stack?: boolean) => ({
    groupId: ids.groupId, subject: "Humanities", fromDayKey, throughDayKey, byMeetings,
    ...(stack ? { stack } : {}),
  });
  const read = (members = scholarIds) =>
    t.query(internal.classPlans.aideClassDays, {
      callerUserId, groupId: ids.groupId, subject: "Humanities", unitId, scholarIds: members, now: Date.now(),
    });
  const schedulePushes = () =>
    t.run(async (ctx) =>
      (await ctx.db.query("pushes").collect()).filter(
        (p) => p.scheduleMirror === true && p.clearedAt === undefined,
      ),
    );
  const pushFor = async (activityId: Id<"activities">) =>
    (await schedulePushes()).filter((p) => p.target.kind === "activity" && p.target.activityId === activityId);
  return {
    t, world, school, unitId, activityIds, cls, scholarIds, callerUserId, scope, payload, give,
    movePayload, read, schedulePushes, pushFor, ...ids,
  };
}

describe("aideClassDays", () => {
  test("reads the class's meetings with closures and the unit's progress", async () => {
    const w = await setup();
    const res = await w.t.query(internal.classPlans.aideClassDays, {
      callerUserId: w.callerUserId, groupId: w.groupId, subject: "Humanities", unitId: w.unitId,
      scholarIds: w.scholarIds, fromDayKey: "2026-11-10", throughDayKey: "2026-11-17", now: Date.now(),
    });
    if (!res.ok) throw new Error(res.message);
    expect(res.meetings.map((m) => m.dayKey)).toEqual([
      "2026-11-10", "2026-11-12", "2026-11-16", "2026-11-17",
    ]);
    expect(res.closed).toEqual([{ dayKey: "2026-11-13", label: "Staff day" }]);
    expect(res.unit?.assignmentId).toBeNull();
    expect(res.unit?.activities.map((a) => a.given)).toEqual([null, null, null, null]);
  });

  test("a wrong subject is answered with the group's classes", async () => {
    const w = await setup();
    const res = await w.t.query(internal.classPlans.aideClassDays, {
      callerUserId: w.callerUserId, groupId: w.groupId, subject: "Science", scholarIds: w.scholarIds, now: Date.now(),
    });
    expect(res).toEqual({ ok: false, message: "Reef group has no Science class. Its classes: Humanities." });
  });

  test("another school's teacher is refused", async () => {
    const w = await setup();
    await expect(
      w.t.query(internal.classPlans.aideClassDays, {
        callerUserId: w.world.schools[1].teacher.id, groupId: w.groupId, subject: "Humanities",
        scholarIds: w.scholarIds, now: Date.now(),
      }),
    ).rejects.toThrow(/Forbidden/);
  });
});

describe("give_class_days: two-phase writes", () => {
  test("a plan writes nothing; its confirmation gives each activity at its meeting, linked to the class", async () => {
    const w = await setup();
    const days = ["2026-11-10", "2026-11-12", "2026-11-16", "2026-11-17"];
    const items = w.activityIds.map((activityId, i) => ({ activityId, dayKey: days[i], finish: inClass }));
    const planned = await w.t.mutation(internal.classPlans.planClassGivesWrite, {
      scope: w.scope(1), payload: w.payload(items),
    });
    expect(planned.confirmationId).not.toBeNull();
    expect(await w.schedulePushes()).toEqual([]);

    const res = await w.t.mutation(internal.classPlans.commitClassGives, {
      scope: w.scope(2), confirmationId: String(planned.confirmationId),
    });
    expect(res.created).toBe(true);
    expect(res.given.map((g) => [g.title, g.dayKey, g.linkedToClass, g.live])).toEqual([
      ["Reading the coast", "2026-11-10", true, false],
      ["Wind and wave", "2026-11-12", true, false],
      ["Drawing our island", "2026-11-16", true, false],
      ["Sharing maps", "2026-11-17", true, false],
    ]);
    for (const [i, day] of days.entries()) {
      expect((await w.pushFor(w.activityIds[i]))[0]).toMatchObject({
        classId: w.cls._id, dayKey: day, startsAt: at(day, "09:00"), endsAt: at(day, "10:15"),
        assignmentId: res.assignmentId,
      });
    }
    const after = await w.read();
    if (!after.ok) throw new Error(after.message);
    expect(after.unit?.activities.map((a) => a.given)).toEqual(
      days.map((dayKey) => ({ state: "planned", dayKey, sameAssignment: true })),
    );
  });

  test("the server refuses a confirmation in the same turn, by someone else, with other gives, twice, or after expiry", async () => {
    const w = await setup();
    const items = [{ activityId: w.activityIds[0], dayKey: "2026-11-12", finish: inClass }];
    await w.t.mutation(internal.classPlans.planClassGivesWrite, { scope: w.scope(5), payload: w.payload(items) });
    const commit = (scope: ReturnType<typeof w.scope>, items2 = items) =>
      w.t.mutation(internal.classPlans.commitClassGives, { scope, payload: w.payload(items2) });

    await expect(commit(w.scope(5))).rejects.toThrow(/hasn't replied since this plan was made/);
    await expect(commit(w.scope(6, { callerUserId: w.school.admin.id }))).rejects.toThrow(/Nothing is planned here/);
    await expect(
      commit(w.scope(6), [{ activityId: w.activityIds[1], dayKey: "2026-11-12", finish: inClass }]),
    ).rejects.toThrow(/aren't the gives that were planned/);
    await expect(commit(w.scope(6, { surface: "slack", slackChannelId: "C1", slackThreadTs: "1.0" }))).rejects.toThrow(
      /Nothing is planned here/,
    );
    expect(await w.schedulePushes()).toEqual([]);

    await commit(w.scope(6));
    expect(await w.pushFor(w.activityIds[0])).toHaveLength(1);
    await expect(commit(w.scope(7))).rejects.toThrow(/Nothing is planned here/);

    await w.t.mutation(internal.classPlans.planClassGivesWrite, {
      scope: w.scope(8), payload: w.payload([{ activityId: w.activityIds[1], dayKey: "2026-11-16", finish: inClass }]),
    });
    vi.setSystemTime(at("2026-11-10", "08:16"));
    await expect(
      w.t.mutation(internal.classPlans.commitClassGives, { scope: w.scope(9) }),
    ).rejects.toThrow(/Nothing is planned here|expired/);
  });

  test("a confirmation is refused when the class's schedule changed since the plan was shown", async () => {
    const w = await setup();
    const items = [{ activityId: w.activityIds[1], dayKey: "2026-11-16", finish: inClass }];
    await w.t.mutation(internal.classPlans.planClassGivesWrite, { scope: w.scope(1), payload: w.payload(items) });
    // Meanwhile the unit is given to this group by another path: the plan's
    // gives would now land on that assignment, not a new one.
    await w.t.run((ctx) =>
      coreAssignWork(ctx, {
        teacherId: w.callerUserId, unitId: w.unitId, scholarIds: w.scholarIds,
        startsAt: at("2026-11-12", "09:00"),
        target: { kind: "activity", activityId: w.activityIds[0] }, finish: inClass,
      }),
    );
    await expect(
      w.t.mutation(internal.classPlans.commitClassGives, { scope: w.scope(2) }),
    ).rejects.toThrow(/schedule changed since this plan was shown/);
    expect(await w.pushFor(w.activityIds[1])).toEqual([]);
  });

  test("a plan with a closed or non-meeting day can't be confirmed", async () => {
    const w = await setup();
    const items = [
      { activityId: w.activityIds[0], dayKey: "2026-11-10", finish: inClass },
      { activityId: w.activityIds[1], dayKey: "2026-11-11", finish: inClass }, // Wednesday
      { activityId: w.activityIds[2], dayKey: "2026-11-13", finish: inClass }, // closed
    ];
    const planned = await w.t.mutation(internal.classPlans.planClassGivesWrite, {
      scope: w.scope(1), payload: w.payload(items),
    });
    if (!planned.plan.ok) throw new Error(planned.plan.message);
    expect(planned.plan.rows.map((r) => r.problem)).toEqual([
      null, "Humanities doesn't meet that day.", "No school that day (Staff day).",
    ]);
    expect(planned.confirmationId).toBeNull();
    await expect(
      w.t.mutation(internal.classPlans.commitClassGives, { scope: w.scope(2) }),
    ).rejects.toThrow(/Nothing is planned here/);
    expect(await w.schedulePushes()).toEqual([]);
  });

  test("an activity outside the unit is refused", async () => {
    const w = await setup();
    const otherUnit = await makeUnit(w.t, w.school.teacher, w.school);
    const stray = await makeActivity(w.t, await makeLesson(w.t, otherUnit));
    const planned = await w.t.mutation(internal.classPlans.planClassGivesWrite, {
      scope: w.scope(1), payload: w.payload([{ activityId: stray, dayKey: "2026-11-12", finish: inClass }]),
    });
    if (!planned.plan.ok) throw new Error(planned.plan.message);
    expect(planned.plan.rows[0].problem).toBe("Not an activity of Island Maps.");
    expect(planned.confirmationId).toBeNull();
  });

  test("stacking two activities on one meeting, or on a meeting that holds the unit's work, needs stack", async () => {
    const w = await setup();
    await w.give([{ activityId: w.activityIds[0], dayKey: "2026-11-12", finish: inClass }]);
    const planned = await w.t.mutation(internal.classPlans.planClassGivesWrite, {
      scope: w.scope(3),
      payload: w.payload([
        { activityId: w.activityIds[1], dayKey: "2026-11-16", finish: inClass },
        { activityId: w.activityIds[2], dayKey: "2026-11-16", finish: inClass },
        { activityId: w.activityIds[3], dayKey: "2026-11-12", finish: inClass },
      ]),
    });
    if (!planned.plan.ok) throw new Error(planned.plan.message);
    expect(planned.plan.rows.map((r) => r.problem)).toEqual([
      null,
      expect.stringMatching(/already has Wind and wave in this plan/),
      expect.stringMatching(/already holds Reading the coast from this unit/),
    ]);
    expect(planned.confirmationId).toBeNull();

    const res = await w.give([
      { activityId: w.activityIds[1], dayKey: "2026-11-16", finish: inClass },
      { activityId: w.activityIds[2], dayKey: "2026-11-16", finish: inClass, stack: true },
    ], 5);
    expect(res.given.map((g) => g.dayKey)).toEqual(["2026-11-16", "2026-11-16"]);
  });
});

describe("a plan never gives into an assignment shared with another group", () => {
  test("another group's narrowed give on a shared assignment is neither counted nor overwritten", async () => {
    const w = await setup();
    const groupA = w.scholarIds.slice(0, 2);
    const groupB = w.scholarIds.slice(2);
    await w.t.run((ctx) => ctx.db.patch(w.groupId, { scholarIds: groupA }));
    // One assignment for both groups; group B has "Reading the coast" Nov 12.
    const shared = await w.t.run(async (ctx) =>
      (await coreAssignWork(ctx, {
        teacherId: w.callerUserId, unitId: w.unitId, scholarIds: w.scholarIds,
        startsAt: at("2026-11-12", "09:00"),
        target: { kind: "activity", activityId: w.activityIds[0], scholarIds: groupB }, finish: inClass,
      })).assignmentId,
    );

    const read = await w.read(groupA);
    if (!read.ok) throw new Error(read.message);
    expect(read.unit?.activities[0].given).toBeNull();
    expect(read.unit?.assignmentId).toBeNull();
    expect(read.unit?.sharedRunning).toEqual({ otherScholars: groupB.length });

    const res = await w.give([{ activityId: w.activityIds[0], dayKey: "2026-11-16", finish: inClass }], 1, groupA);
    expect(res.created).toBe(true);
    expect(res.assignmentId).not.toBe(shared);
    const rows = await w.pushFor(w.activityIds[0]);
    expect(rows.map((r) => [r.assignmentId, r.startsAt])).toEqual(
      expect.arrayContaining([
        [shared, at("2026-11-12", "09:00")],
        [res.assignmentId, at("2026-11-16", "09:00")],
      ]),
    );
  });
});

describe("move_class_days writes", () => {
  test("pushes every planned give back one class meeting, skipping the closure", async () => {
    const w = await setup();
    const days = ["2026-11-10", "2026-11-12", "2026-11-16"];
    await w.give(days.map((dayKey, i) => ({ activityId: w.activityIds[i], dayKey, finish: inClass })));
    const planned = await w.t.mutation(internal.classPlans.planClassMoveWrite, {
      scope: w.scope(3), payload: w.movePayload("2026-11-10", "2026-12-31", 1),
    });
    if (!planned.plan.ok) throw new Error(planned.plan.message);
    expect(planned.plan.rows.map((r) => [r.fromDayKey, r.to?.dayKey, r.problem])).toEqual([
      ["2026-11-10", "2026-11-12", null],
      ["2026-11-12", "2026-11-16", null], // Fri 11-13 is closed
      ["2026-11-16", "2026-11-17", null],
    ]);
    await expect(
      w.t.mutation(internal.classPlans.commitClassMove, { scope: w.scope(3) }),
    ).rejects.toThrow(/hasn't replied/);
    const res = await w.t.mutation(internal.classPlans.commitClassMove, { scope: w.scope(4) });
    expect(res.moved.map((m) => [m.fromDayKey, m.toDayKey, m.linked])).toEqual([
      ["2026-11-10", "2026-11-12", true],
      ["2026-11-12", "2026-11-16", true],
      ["2026-11-16", "2026-11-17", true],
    ]);
    for (const [i, day] of ["2026-11-12", "2026-11-16", "2026-11-17"].entries()) {
      expect((await w.pushFor(w.activityIds[i]))[0]).toMatchObject({
        classId: w.cls._id, dayKey: day, startsAt: at(day, "09:00"), endsAt: at(day, "10:15"),
      });
    }
  });

  test("homework given in class moves too, keeping its due date", async () => {
    const w = await setup();
    await w.give([{ activityId: w.activityIds[0], dayKey: "2026-11-12", finish: { kind: "by", dayKey: "2026-11-20" } }]);
    const [before] = await w.pushFor(w.activityIds[0]);
    expect(before).toMatchObject({ classId: w.cls._id, timing: { kind: "homework" } });
    expect(before.dayKey).toBeUndefined(); // homework links to the class, not a day

    const planned = await w.t.mutation(internal.classPlans.planClassMoveWrite, {
      scope: w.scope(3), payload: w.movePayload("2026-11-10", "2026-11-30", 1),
    });
    if (!planned.plan.ok) throw new Error(planned.plan.message);
    expect(planned.plan.rows.map((r) => [r.title, r.homework, r.to?.dayKey])).toEqual([
      ["Reading the coast", true, "2026-11-16"],
    ]);
    await w.t.mutation(internal.classPlans.commitClassMove, { scope: w.scope(4) });
    const [after] = await w.pushFor(w.activityIds[0]);
    expect(after).toMatchObject({
      classId: w.cls._id, startsAt: at("2026-11-16", "09:00"), endsAt: before.endsAt,
    });
  });

  test("a move onto a meeting holding work that isn't moving needs stack", async () => {
    const w = await setup();
    await w.give([
      { activityId: w.activityIds[0], dayKey: "2026-11-10", finish: inClass },
      { activityId: w.activityIds[1], dayKey: "2026-11-12", finish: inClass },
    ]);
    const planned = await w.t.mutation(internal.classPlans.planClassMoveWrite, {
      scope: w.scope(3), payload: w.movePayload("2026-11-10", "2026-11-10", 1),
    });
    if (!planned.plan.ok) throw new Error(planned.plan.message);
    expect(planned.plan.rows[0].problem).toMatch(/already has Wind and wave/);
    expect(planned.confirmationId).toBeNull();

    const stacked = await w.t.mutation(internal.classPlans.planClassMoveWrite, {
      scope: w.scope(5), payload: w.movePayload("2026-11-10", "2026-11-10", 1, true),
    });
    expect(stacked.confirmationId).not.toBeNull();
  });

  test("another subject's work drawn in a meeting's slot takes that meeting (TRA-725)", async () => {
    const w = await setup();
    // A Science class on Wednesdays, and Science work scheduled into
    // Thursday's Humanities slot: filed under Science, drawn in that slot.
    const teacher = await w.world.as.staffOf(w.school);
    await teacher.mutation(api.masterSchedule.placeClass, {
      periodId: w.periodId, groupId: w.groupId, blockId: w.blockId,
      weekday: 3, subject: "Science", teacherId: w.school.teacher.id,
    });
    const scienceUnit = await makeUnit(w.t, w.school.teacher, w.school, {
      title: "Tides", subject: "Science",
    });
    const tideActivity = await makeActivity(w.t, await makeLesson(w.t, scienceUnit), { title: "Tide tables" });
    const scienceAssignment = await teacher.mutation(api.assignments.create, {
      unitId: scienceUnit, scholarIds: w.scholarIds,
    });
    await w.t.run((ctx) => writeSchedule(ctx, scienceAssignment, [{
      activityId: tideActivity, mode: "classFocus",
      startsAt: at("2026-11-12", "09:00"), endsAt: at("2026-11-12", "10:15"), scholarIds: [],
    }]));
    const science = (await w.t.run((ctx) => ctx.db.query("classes").collect()))
      .find((c) => c.subject === "Science")!;
    expect((await w.pushFor(tideActivity))[0]).toMatchObject({
      classId: science._id, dayKey: "2026-11-12",
    });

    await w.give([{ activityId: w.activityIds[0], dayKey: "2026-11-10", finish: inClass }]);
    const planned = await w.t.mutation(internal.classPlans.planClassMoveWrite, {
      scope: w.scope(3), payload: w.movePayload("2026-11-10", "2026-11-10", 1),
    });
    if (!planned.plan.ok) throw new Error(planned.plan.message);
    expect(planned.plan.rows[0]).toMatchObject({ to: { dayKey: "2026-11-12" } });
    expect(planned.plan.rows[0].problem).toMatch(/already has Tide tables/);
  });

  test("a double period: an unlinked give stays put, is listed, and its meeting isn't free", async () => {
    const w = await setup();
    // Thursday gets a second Humanities meeting, so a give there can't be
    // tied to one meeting and the schedule store leaves it unlinked.
    const afternoon = await w.t.run((ctx) =>
      ctx.db.insert("scheduleBlocks", {
        periodId: w.periodId, key: "afternoon", label: "Afternoon",
        startLocal: "13:00", endLocal: "14:00", weekdays: [1, 2, 3, 4, 5], order: 1,
      }),
    );
    const teacher = await w.world.as.staffOf(w.school);
    await teacher.mutation(api.masterSchedule.placeClass, {
      periodId: w.periodId, groupId: w.groupId, blockId: afternoon,
      weekday: 4, subject: "Humanities", teacherId: w.school.teacher.id,
    });
    const res = await w.give([
      { activityId: w.activityIds[0], dayKey: "2026-11-10", finish: inClass },
      { activityId: w.activityIds[1], dayKey: "2026-11-12", block: "Morning", finish: inClass },
    ]);
    expect(res.given.map((g) => [g.dayKey, g.linkedToClass])).toEqual([
      ["2026-11-10", true],
      ["2026-11-12", false],
    ]);

    const planned = await w.t.mutation(internal.classPlans.planClassMoveWrite, {
      scope: w.scope(3), payload: w.movePayload("2026-11-10", "2026-11-12", 1),
    });
    if (!planned.plan.ok) throw new Error(planned.plan.message);
    // "Reading the coast" would land on Thursday morning, which holds "Wind and wave".
    expect(planned.plan.rows.map((r) => [r.title, r.to?.dayKey, r.to?.blockLabel])).toEqual([
      ["Reading the coast", "2026-11-12", "Morning"],
    ]);
    expect(planned.plan.rows[0].problem).toMatch(/already has Wind and wave/);
    expect(planned.plan.leftAlone).toEqual([
      { title: "Wind and wave", dayKey: "2026-11-12", reason: "not tied to one class meeting; move it on its own" },
    ]);
    expect(planned.confirmationId).toBeNull();
  });

  test("homework given outside a meeting is listed and left where it is", async () => {
    const w = await setup();
    await w.give([{ activityId: w.activityIds[0], dayKey: "2026-11-10", finish: inClass }]);
    // Given at 13:00 Thursday: no class meets then, so it carries no class link.
    await w.t.run((ctx) =>
      coreAssignWork(ctx, {
        teacherId: w.callerUserId, unitId: w.unitId, scholarIds: w.scholarIds,
        startsAt: at("2026-11-12", "13:00"),
        target: { kind: "activity", activityId: w.activityIds[1] },
        finish: { kind: "by", dayKey: "2026-11-20" },
      }),
    );
    const [homework] = await w.pushFor(w.activityIds[1]);
    expect(homework.classId).toBeUndefined();

    const planned = await w.t.mutation(internal.classPlans.planClassMoveWrite, {
      scope: w.scope(3), payload: w.movePayload("2026-11-10", "2026-11-30", 1),
    });
    if (!planned.plan.ok) throw new Error(planned.plan.message);
    expect(planned.plan.rows.map((r) => [r.title, r.to?.dayKey, r.problem])).toEqual([
      ["Reading the coast", "2026-11-12", null],
    ]);
    expect(planned.plan.leftAlone).toEqual([
      { title: "Wind and wave", dayKey: "2026-11-12", reason: "not tied to one class meeting; move it on its own" },
    ]);
    await w.t.mutation(internal.classPlans.commitClassMove, { scope: w.scope(4) });
    expect((await w.pushFor(w.activityIds[1]))[0].startsAt).toBe(at("2026-11-12", "13:00"));
  });

  test("live work stays put", async () => {
    const w = await setup();
    await w.give([{ activityId: w.activityIds[0], dayKey: "2026-11-10", finish: inClass }]);
    vi.setSystemTime(at("2026-11-10", "09:05"));
    const [push] = await w.schedulePushes();
    await w.t.mutation(internal.assignments.activateScheduledActivity, {
      assignmentId: push.assignmentId!, activityId: w.activityIds[0],
    });
    const planned = await w.t.mutation(internal.classPlans.planClassMoveWrite, {
      scope: w.scope(3), payload: w.movePayload("2026-11-10", "2026-11-30", 1),
    });
    if (!planned.plan.ok) throw new Error(planned.plan.message);
    expect(planned.plan.rows).toEqual([]);
    expect(planned.plan.leftAlone).toEqual([
      { title: "Reading the coast", dayKey: "2026-11-10", reason: "already live" },
    ]);
    expect(planned.confirmationId).toBeNull();
  });
});
