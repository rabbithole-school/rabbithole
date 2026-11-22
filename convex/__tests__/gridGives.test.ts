// The teacher grid draws gives (TRA-582): linked gives in their class
// meeting's cell, unlinked ones in the All day row or the Other times strip.
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import schema from "../schema";
import { api } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import { coversSchoolDay, giveState, groupsForAudience } from "../lib/gridGives";
import { makeActivity, makeLesson, makeUnit, makeWorld } from "./factories/world";

const modules = (
  import.meta as ImportMeta & {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("../**/*.ts");

const timeZone = "Pacific/Honolulu";
const tuesday = "2026-11-10";
const at = (clock: string, day = tuesday) =>
  Date.parse(`${day}T${clock}:00-10:00`);
const weekStartMs = at("00:00", "2026-11-09");

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(at("07:00", "2026-11-09"));
});
afterEach(() => vi.useRealTimers());

async function setup() {
  const t = convexTest(schema, modules);
  const world = await makeWorld(t, { schools: 1, parentsPerSchool: 0 });
  const school = world.schools[0];
  const teacher = await world.as.staffOf(school);
  const unitId = await makeUnit(t, school.teacher, school);
  const lessonId = await makeLesson(t, unitId);
  const activityId = await makeActivity(t, lessonId);
  const ids = await t.run(async (ctx) => {
    await ctx.db.patch(school.id, { timeZone });
    const groupId = await ctx.db.insert("scholarGroups", {
      institutionId: school.id,
      teacherId: school.teacher.id,
      name: "Tide pool group",
      scholarIds: school.scholars.map((s) => s.id),
    });
    const periodId = await ctx.db.insert("reportingPeriods", {
      institutionId: school.id,
      label: "Fall",
      startsAt: at("00:00", "2026-08-01"),
      endsAt: at("00:00", "2026-12-20"),
      status: "open",
    });
    const morning = await ctx.db.insert("scheduleBlocks", {
      periodId, key: "morning", label: "Morning",
      startLocal: "09:00", endLocal: "10:15", weekdays: [1, 2, 3, 4, 5], order: 0,
    });
    const afternoon = await ctx.db.insert("scheduleBlocks", {
      periodId, key: "afternoon", label: "Afternoon",
      startLocal: "13:00", endLocal: "14:30", weekdays: [1, 2, 3, 4, 5], order: 1,
    });
    return { groupId, periodId, morning, afternoon };
  });
  const assignmentId = await teacher.mutation(api.assignments.create, {
    unitId,
    scholarIds: school.scholars.map((s) => s.id),
  });
  const placementId = await teacher.mutation(api.masterSchedule.placeClass, {
    periodId: ids.periodId,
    groupId: ids.groupId,
    blockId: ids.morning,
    weekday: 2,
    subject: "Humanities",
    teacherId: school.teacher.id,
  });
  const grid = () =>
    teacher.query(api.masterSchedule.grid, { periodId: ids.periodId, weekStartMs });
  const insertPush = (fields: Partial<Doc<"pushes">>) =>
    t.run((ctx) =>
      ctx.db.insert("pushes", {
        institutionId: school.id,
        target: { kind: "link", url: "https://example.com/tide", title: "Tide chart" },
        audience: { kind: "group", groupId: ids.groupId },
        timing: { kind: "focus" },
        blocking: false,
        pushedBy: school.teacher.id,
        afterEnd: "fade",
        ...fields,
      }),
    );
  return {
    t, school, teacher, unitId, activityId, assignmentId, placementId, grid, insertPush, ...ids,
  };
}

describe("grid gives", () => {
  test("a give to a class meeting lands in that class's cell", async () => {
    const w = await setup();
    await w.teacher.mutation(api.assignments.scheduleActivity, {
      assignmentId: w.assignmentId,
      activityId: w.activityId,
      startsAt: at("09:30"),
      finish: { kind: "inClass" },
    });
    const { gives } = await w.grid();
    expect(gives).toEqual([
      expect.objectContaining({
        place: "class",
        weekday: 2,
        dayKey: tuesday,
        blockId: w.morning,
        groupId: w.groupId,
        subject: "Humanities",
        assignmentId: w.assignmentId,
        activityId: w.activityId,
        state: "planned",
        linkState: "planned",
      }),
    ]);
  });

  test("an open-until give says when it closes on its card, and is not Homework due (TRA-724)", async () => {
    const w = await setup();
    await w.teacher.mutation(api.assignments.scheduleActivity, {
      assignmentId: w.assignmentId,
      activityId: w.activityId,
      startsAt: at("09:30"),
      finish: { kind: "openUntil", dayKey: "2026-11-12" },
    });
    const grid = await w.grid();
    expect(grid.gives).toEqual([
      expect.objectContaining({
        weekday: 2,
        activityId: w.activityId,
        openUntilLabel: "Open until Thu",
      }),
    ]);
    expect(grid.homeworkDue).toEqual([]);
  });

  describe("an open-until window that runs into later weeks (TRA-724)", () => {
    // The end of a school-local day, the way giveWindow stores "open until".
    const endOf = (day: string) => at("00:00", day) + 24 * 60 * 60 * 1000;
    const gridFor = (w: Awaited<ReturnType<typeof setup>>, monday: string) =>
      w.teacher.query(api.masterSchedule.grid, {
        periodId: w.periodId,
        weekStartMs: at("00:00", monday),
      });
    const drawn = async (
      w: Awaited<ReturnType<typeof setup>>,
      monday: string,
      pushId: string,
    ) =>
      (await gridFor(w, monday)).gives
        .filter((g) => String(g.pushId) === pushId)
        .map((g) => ({
          place: g.place,
          dayKey: g.dayKey,
          label: g.openUntilLabel,
          movable: g.movable,
          carried: g.carried,
        }));

    test("given Thursday, open until next Tuesday: once in each week, in the class's cell next week", async () => {
      const w = await setup();
      const classId = await w.t.run(async (ctx) =>
        (await ctx.db.query("classes").collect()).find((c) => c.groupId === w.groupId)!._id);
      const pushId = String(
        await w.insertPush({
          classId,
          dayKey: "2026-11-12",
          setAt: at("09:30", "2026-11-12"),
          startsAt: at("09:30", "2026-11-12"),
          endsAt: endOf("2026-11-17"),
        }),
      );
      // Its start week: Thursday, where its class doesn't meet.
      expect(await drawn(w, "2026-11-09", pushId)).toEqual([
        { place: "other", dayKey: "2026-11-12", label: "Open until Tue", movable: false, carried: false },
      ]);
      // The next week: Tuesday, its closing day, in its class's cell.
      expect(await drawn(w, "2026-11-16", pushId)).toEqual([
        { place: "class", dayKey: "2026-11-17", label: "Open until Tue", movable: false, carried: true },
      ]);
      expect((await gridFor(w, "2026-11-16")).homeworkDue).toEqual([]);
    });

    test("a three-week window is drawn once per week", async () => {
      const w = await setup();
      const pushId = String(
        await w.insertPush({
          setAt: at("08:00", "2026-11-11"),
          startsAt: at("08:00", "2026-11-11"),
          endsAt: endOf("2026-11-25"),
        }),
      );
      expect((await drawn(w, "2026-11-09", pushId)).map((g) => g.dayKey)).toEqual(["2026-11-11"]);
      // The middle week: Friday, since it closes in a later week.
      expect(await drawn(w, "2026-11-16", pushId)).toEqual([
        { place: "allDay", dayKey: "2026-11-20", label: "Open until Wed", movable: false, carried: true },
      ]);
      expect((await drawn(w, "2026-11-23", pushId)).map((g) => g.dayKey)).toEqual(["2026-11-25"]);
      expect(await drawn(w, "2026-11-30", pushId)).toEqual([]);
    });

    test("filed to a class that doesn't meet on its closing day: All day in the later week", async () => {
      const w = await setup();
      const classId = await w.t.run(async (ctx) =>
        (await ctx.db.query("classes").collect()).find((c) => c.groupId === w.groupId)!._id);
      // Humanities meets Tuesdays only; this closes on Wednesday.
      const pushId = String(
        await w.insertPush({
          classId,
          dayKey: "2026-11-10",
          setAt: at("09:30", "2026-11-10"),
          startsAt: at("09:30", "2026-11-10"),
          endsAt: endOf("2026-11-18"),
        }),
      );
      expect(await drawn(w, "2026-11-16", pushId)).toEqual([
        { place: "allDay", dayKey: "2026-11-18", label: "Open until Wed", movable: false, carried: true },
      ]);
    });

    test("a closing day that is closed moves back to the last open day; a fully closed week draws nothing", async () => {
      const w = await setup();
      const pushId = String(
        await w.insertPush({
          setAt: at("08:00", "2026-11-11"),
          startsAt: at("08:00", "2026-11-11"),
          endsAt: endOf("2026-11-25"),
        }),
      );
      await w.t.run(async (ctx) => {
        // Closes Wednesday Nov 25, a holiday, with Tuesday closed too.
        await ctx.db.insert("schoolClosures", {
          institutionId: w.school.id,
          startDayKey: "2026-11-24",
          endDayKey: "2026-11-25",
          label: "Break",
          kind: "holiday",
        });
        // The whole middle week closed.
        await ctx.db.insert("schoolClosures", {
          institutionId: w.school.id,
          startDayKey: "2026-11-16",
          endDayKey: "2026-11-20",
          label: "Fall Break",
          kind: "holiday",
        });
      });
      expect(await drawn(w, "2026-11-16", pushId)).toEqual([]);
      expect((await drawn(w, "2026-11-23", pushId)).map((g) => g.dayKey)).toEqual(["2026-11-23"]);
    });

    test("a give cleared mid-window is drawn in its start week only", async () => {
      const w = await setup();
      const pushId = String(
        await w.insertPush({
          setAt: at("08:00", "2026-11-11"),
          startsAt: at("08:00", "2026-11-11"),
          endsAt: endOf("2026-11-25"),
          clearedAt: at("10:00", "2026-11-13"),
          clearedReason: "teacher",
        }),
      );
      expect((await drawn(w, "2026-11-09", pushId)).map((g) => g.dayKey)).toEqual(["2026-11-11"]);
      expect(await drawn(w, "2026-11-16", pushId)).toEqual([]);
      expect(await drawn(w, "2026-11-23", pushId)).toEqual([]);
    });

    test("a window that opens and closes in one week is drawn once", async () => {
      const w = await setup();
      const pushId = String(
        await w.insertPush({
          setAt: at("08:00", "2026-11-10"),
          startsAt: at("08:00", "2026-11-10"),
          endsAt: endOf("2026-11-12"),
        }),
      );
      expect((await drawn(w, "2026-11-09", pushId)).map((g) => g.dayKey)).toEqual(["2026-11-10"]);
      expect(await drawn(w, "2026-11-16", pushId)).toEqual([]);
    });
  });

  test("readers that don't draw gives can skip them", async () => {
    const w = await setup();
    await w.insertPush({ startsAt: at("11:00"), endsAt: at("11:30") });
    expect((await w.grid()).gives).toHaveLength(1);
    const skipped = await w.teacher.query(api.masterSchedule.grid, {
      periodId: w.periodId, weekStartMs, skipGives: true,
    });
    expect(skipped.gives).toEqual([]);
    expect(skipped.classMeetings).toEqual([]);
  });

  test("unlinked gives split into All day and Other times", async () => {
    const w = await setup();
    // 08:00 → 15:00 covers Tuesday's 09:00–14:30 school day.
    await w.insertPush({ startsAt: at("08:00"), endsAt: at("15:00"), afterEnd: "fade" });
    // 11:00 → 11:30 falls between classes.
    await w.insertPush({
      startsAt: at("11:00"), endsAt: at("11:30"), afterEnd: "fade",
      setAt: at("11:00"), target: { kind: "link", url: "https://example.com/x", title: "Snack video" },
    });
    // Homework is the Homework due row's, never drawn here.
    await w.insertPush({ startsAt: at("11:00"), timing: { kind: "homework" }, afterEnd: "late" });
    // Next week: not this grid's.
    await w.insertPush({ startsAt: at("11:00", "2026-11-17"), endsAt: at("11:30", "2026-11-17") });
    const { gives } = await w.grid();
    expect(gives.map((g) => [g.place, g.activityTitle, g.weekday, g.state])).toEqual(
      expect.arrayContaining([
        ["allDay", "Tide chart", 2, "planned"],
        ["other", "Snack video", 2, "live"],
      ]),
    );
    expect(gives).toHaveLength(2);
  });

  test("a cancelled plan and a superseded row are not drawn; an ended give is", async () => {
    const w = await setup();
    await w.insertPush({ startsAt: at("11:00"), endsAt: at("11:30"), clearedAt: at("10:00"), clearedReason: "teacher" });
    await w.insertPush({
      startsAt: at("11:00"), setAt: at("11:00"), endsAt: at("11:30"),
      clearedAt: at("11:30"), clearedReason: "superseded",
    });
    await w.insertPush({
      startsAt: at("11:00"), setAt: at("11:00"), endsAt: at("11:30"),
      clearedAt: at("11:30"), clearedReason: "expired",
    });
    const { gives } = await w.grid();
    expect(gives).toEqual([
      expect.objectContaining({ place: "other", state: "finished", closedLabel: "Ended" }),
    ]);
  });

  test("an archived class's gives move to Other times, still named", async () => {
    const w = await setup();
    await w.teacher.mutation(api.assignments.scheduleActivity, {
      assignmentId: w.assignmentId,
      activityId: w.activityId,
      startsAt: at("09:30"),
      finish: { kind: "inClass" },
    });
    // The group keeps another class on the grid.
    await w.teacher.mutation(api.masterSchedule.placeClass, {
      periodId: w.periodId, groupId: w.groupId, blockId: w.afternoon, weekday: 4,
      subject: "Science", teacherId: w.school.teacher.id,
    });
    // Removing Humanities' only placement archives the class; its slot may
    // hold another class now.
    await w.teacher.mutation(api.masterSchedule.removePlacement, { placementId: w.placementId });
    expect((await w.grid()).gives).toEqual([
      expect.objectContaining({
        place: "other", weekday: 2, subject: "Humanities", blockId: null,
      }),
    ]);
  });

  test("the teacher grid draws the give an activity card stands for (cards retired)", async () => {
    const w = await setup();
    await w.t.run((ctx) =>
      ctx.db.insert("schedulePlacements", {
        periodId: w.periodId, groupId: w.groupId, weekday: 2, blockId: w.afternoon,
        subject: "Science", assignmentId: w.assignmentId, activityId: w.activityId,
        weekStartMs,
      }),
    );
    // Unlinked (Other times) give of the same assignment + activity that day.
    await w.insertPush({
      startsAt: at("11:00"), endsAt: at("11:30"), assignmentId: w.assignmentId,
      target: { kind: "activity", activityId: w.activityId },
    });
    expect((await w.grid()).gives).toEqual([
      expect.objectContaining({ place: "other", activityId: w.activityId }),
    ]);
  });
});

describe("gridGives helpers", () => {
  const blocks = [
    { startLocal: "09:00", endLocal: "10:15", weekdays: [1, 2, 3, 4, 5] },
    { startLocal: "13:00", endLocal: "14:30", weekdays: [1, 2, 3, 4, 5] },
  ];

  test("covers the school day only from its first class through its last", () => {
    expect(coversSchoolDay({ startsAt: at("09:00"), endsAt: at("14:30") }, tuesday, blocks, timeZone)).toBe(true);
    expect(coversSchoolDay({ startsAt: at("08:00"), endsAt: null }, tuesday, blocks, timeZone)).toBe(true);
    expect(coversSchoolDay({ startsAt: at("09:01"), endsAt: null }, tuesday, blocks, timeZone)).toBe(false);
    expect(coversSchoolDay({ startsAt: at("08:00"), endsAt: at("14:29") }, tuesday, blocks, timeZone)).toBe(false);
    // Saturday has no class blocks: nothing to cover.
    expect(coversSchoolDay({ startsAt: at("08:00", "2026-11-14"), endsAt: null }, "2026-11-14", blocks, timeZone)).toBe(false);
  });

  test("give state", () => {
    expect(giveState({})).toBe("planned");
    expect(giveState({ setAt: 1 })).toBe("live");
    expect(giveState({ setAt: 1, clearedAt: 2 })).toBe("finished");
    expect(giveState({ clearedAt: 2 })).toBeNull();
    expect(giveState({ setAt: 1, clearedAt: 2, clearedReason: "superseded" })).toBeNull();
  });

  test("audience reaches a group only when the whole roster is in it", () => {
    const a = "a" as Id<"users">;
    const b = "b" as Id<"users">;
    const g1 = { _id: "g1" as Id<"scholarGroups">, scholarIds: [a, b] };
    const g2 = { _id: "g2" as Id<"scholarGroups">, scholarIds: [b] };
    expect(groupsForAudience({ kind: "institution" }, [g1, g2], null)).toEqual(["g1", "g2"]);
    expect(groupsForAudience({ kind: "scholars", scholarIds: [b] }, [g1, g2], null)).toEqual(["g1", "g2"]);
    expect(groupsForAudience({ kind: "scholars", scholarIds: [a, b] }, [g1, g2], null)).toEqual(["g1"]);
    expect(groupsForAudience({ kind: "group", groupId: g2._id }, [g1], null)).toEqual([]);
  });
});
