import { convexTest } from "convex-test";
import { placeCard, updateCard } from "./legacyCards";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import schema from "../schema";
import { api, internal } from "../_generated/api";
import type { Doc } from "../_generated/dataModel";
import {
  classMeetingForGive,
  syncClassesForGroupPeriod,
  syncClassesForPlacements,
} from "../lib/classLink";
import { readSchedule, writeSchedule } from "../lib/scheduleStore";
import { reconcilePlacementById, reconcilePlacementsById } from "../masterSchedule";
import { coreAssignWork } from "../assignments";
import { makeActivity, makeLesson, makeUnit, makeWorld } from "./factories/world";

const modules = (
  import.meta as ImportMeta & {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("../**/*.ts");

const timeZone = "Pacific/Honolulu";
const dayKey = "2026-11-10";
const at = (clock: string, day = dayKey) =>
  Date.parse(`${day}T${clock}:00-10:00`);
const dayEnd = (day = dayKey) =>
  Date.parse(`${day}T23:59:59.999-10:00`);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(at("08:00"));
});
afterEach(() => vi.useRealTimers());

async function setup() {
  const t = convexTest(schema, modules);
  const world = await makeWorld(t, { parentsPerSchool: 0 });
  const school = world.schools[0];
  const teacher = await world.as.staffOf(school);
  const admin = await world.as.staffOf(school, "school_admin");
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
    const blockId = await ctx.db.insert("scheduleBlocks", {
      periodId,
      key: "morning",
      label: "Morning",
      startLocal: "09:00",
      endLocal: "10:15",
      weekdays: [1, 2, 3, 4, 5],
      order: 0,
    });
    const appId = await ctx.db.insert("externalApps", {
      name: "Fixture drawing app",
      webUrl: "https://example.com/draw",
    });
    return { groupId, periodId, blockId, appId };
  });
  const assignmentId = await teacher.mutation(api.assignments.create, {
    unitId,
    scholarIds: school.scholars.map((s) => s.id),
  });
  const placementArgs = {
    periodId: ids.periodId,
    groupId: ids.groupId,
    blockId: ids.blockId,
    weekday: 2,
    subject: "Humanities",
    teacherId: school.teacher.id,
  };
  const placementId = await teacher.mutation(api.masterSchedule.placeClass, placementArgs);
  const classes = () => t.run((ctx) => ctx.db.query("classes").collect());
  const [cls] = await classes();
  const pushes = async () => {
    const rows = await t.run((ctx) => ctx.db.query("pushes").collect());
    // TRA-580 step 5: every writer stores `timing` as the kind alone.
    for (const row of rows) expect(Object.keys(row.timing)).toEqual(["kind"]);
    return rows;
  };
  return {
    t, world, school, teacher, admin, activityId, unitId, lessonId, assignmentId, ...ids,
    placementArgs, placementId, cls, classes, pushes,
  };
}

describe("dual-written gives", () => {
  test("empty scholar selection links using the assignment's whole cohort", async () => {
    const w = await setup();
    await w.t.run((ctx) => writeSchedule(ctx, w.assignmentId, [{
      activityId: w.activityId, mode: "classFocus",
      startsAt: at("09:30"), endsAt: at("10:15"), scholarIds: [],
    }]));
    expect(await w.pushes()).toEqual([expect.objectContaining({
      audience: { kind: "scholars", scholarIds: [] }, classId: w.cls._id, dayKey,
    })]);
  });

  test("job edits and scheduled activation retain an archived class link", async () => {
    const w = await setup();
    await w.teacher.mutation(api.assignments.scheduleActivity, {
      assignmentId: w.assignmentId, activityId: w.activityId,
      startsAt: at("09:30"), finish: { kind: "inClass" },
    });
    await w.teacher.mutation(api.masterSchedule.removePlacement, { placementId: w.placementId });
    expect((await w.classes())[0]).toMatchObject({
      archivedAt: at("08:00"), meetings: w.cls.meetings,
    });
    await w.t.run(async (ctx) => {
      const entries = await readSchedule(ctx, { _id: w.assignmentId });
      await writeSchedule(ctx, w.assignmentId, entries.map((entry) => ({
        ...entry, scheduledFnId: undefined,
      })));
    });
    expect((await w.pushes())[0]).toMatchObject({
      classId: w.cls._id, dayKey, endsAt: at("10:15"),
    });
    vi.setSystemTime(at("09:30"));
    await w.t.mutation(internal.assignments.activateScheduledActivity, {
      assignmentId: w.assignmentId, activityId: w.activityId,
    });
    expect((await w.pushes())[0]).toMatchObject({
      classId: w.cls._id, dayKey, setAt: at("09:30"),
    });
    await w.t.run(async (ctx) => {
      const entries = await readSchedule(ctx, { _id: w.assignmentId });
      await writeSchedule(ctx, w.assignmentId, entries.map((entry) => ({
        ...entry, scholarIds: [w.school.scholars[0].id],
      })));
    });
    expect((await w.pushes())[0].classId).toBeUndefined();
  });

  test("extending only an assignment's end keeps its archived class and meeting", async () => {
    const w = await setup();
    vi.setSystemTime(at("09:30"));
    await w.teacher.mutation(api.assignments.pushActivity, {
      assignmentId: w.assignmentId, activityId: w.activityId, finish: { kind: "inClass" },
    });
    const [before] = await w.pushes();
    await w.teacher.mutation(api.masterSchedule.removePlacement, { placementId: w.placementId });
    expect((await w.classes())[0].archivedAt).toBeDefined();
    await w.teacher.mutation(api.assignments.scheduleActivity, {
      assignmentId: w.assignmentId, activityId: w.activityId,
      startsAt: at("09:30"), mode: "classFocus", endsAt: at("10:30"),
    });
    expect(await w.pushes()).toEqual([expect.objectContaining({
      _id: before._id, startsAt: before.startsAt, setAt: before.setAt,
      timing: { kind: "focus" },
      endsAt: at("10:30"), afterEnd: "fade", classId: w.cls._id, dayKey,
    })]);
  });

  test("delayed until-cleared activation uses the live day end but retains its planned meeting", async () => {
    const w = await setup();
    await w.t.run((ctx) => writeSchedule(ctx, w.assignmentId, [{
      activityId: w.activityId, mode: "classFocus", startsAt: at("09:30"),
    }]));
    const [before] = await w.pushes();
    expect(before).toMatchObject({
      timing: { kind: "untilCleared" }, endsAt: dayEnd(), classId: w.cls._id, dayKey,
    });
    await w.teacher.mutation(api.masterSchedule.removePlacement, { placementId: w.placementId });
    vi.setSystemTime(at("09:30", "2026-11-11"));
    await w.t.mutation(internal.assignments.activateScheduledActivity, {
      assignmentId: w.assignmentId, activityId: w.activityId,
    });
    expect(await w.pushes()).toEqual([expect.objectContaining({
      _id: before._id, startsAt: before.startsAt, setAt: at("09:30", "2026-11-11"),
      endsAt: dayEnd("2026-11-11"), afterEnd: "fade", classId: w.cls._id, dayKey,
    })]);
  });

  test("app activation and end-only retiming retain an archived link; moving its start recomputes", async () => {
    const w = await setup();
    await w.teacher.mutation(api.masterSchedule.updatePlacement, {
      placementId: w.placementId, externalAppId: w.appId,
    });
    const [planned] = await w.pushes();
    // The app still has its window, but no longer supplies a recurring class meeting.
    await w.teacher.mutation(api.masterSchedule.updatePlacement, {
      placementId: w.placementId, mode: "homework",
    });
    expect((await w.classes())[0].archivedAt).toBeDefined();
    vi.setSystemTime(at("08:45"));
    await w.t.mutation(internal.masterSchedule.activatePlacementAppPush, {
      placementId: w.placementId, pushId: planned._id,
    });
    await w.admin.mutation(api.masterSchedule.updateBlock, {
      blockId: w.blockId, endLocal: "10:30",
    });
    expect((await w.pushes())[0]).toMatchObject({
      classId: w.cls._id, dayKey, setAt: at("08:45"), endsAt: at("10:40"),
    });
    await w.admin.mutation(api.masterSchedule.updateBlock, {
      blockId: w.blockId, startLocal: "09:15",
    });
    expect((await w.pushes())[0].classId).toBeUndefined();
    expect((await w.pushes())[0].dayKey).toBeUndefined();
  });

  test.each(["live", "planned"] as const)(
    "whole-unit %s giving reuses school lookup reads as the activity count grows", async (mode) => {
      const w = await setup();
      if (mode === "live") vi.setSystemTime(at("09:30"));
      const give = () => w.t.run(async (ctx) => {
        const queries = vi.spyOn(ctx.db, "query");
        try {
          await coreAssignWork(ctx, {
            unitId: w.unitId, teacherId: w.school.teacher.id,
            scholarIds: w.school.scholars.map((s) => s.id),
            startsAt: at("09:30"), target: { kind: "unit" }, finish: { kind: "inClass" },
          });
          return Object.fromEntries(
            ["scholarGroups", "reportingPeriods", "schoolClosures", "scheduleBlocks", "classes"]
              .map((table) => [table, queries.mock.calls.filter(([name]) => name === table).length]),
          );
        } finally {
          queries.mockRestore();
        }
      });
      const single = await give();
      await makeActivity(w.t, w.lessonId);
      await makeActivity(w.t, w.lessonId);
      expect(await give()).toEqual(single);
      expect(single).toMatchObject({
        scholarGroups: 2, reportingPeriods: 2, schoolClosures: 2,
        scheduleBlocks: 1, classes: 1,
      });
      expect(await w.pushes()).toHaveLength(3);
      for (const push of await w.pushes()) {
        expect(push).toMatchObject({ classId: w.cls._id, dayKey });
      }
    },
  );

  test("an app reconciliation batch caches school lookups across placements", async () => {
    const w = await setup();
    const entries = await w.t.run(async (ctx) => {
      await ctx.db.patch(w.placementId, { externalAppId: w.appId });
      const entries = [{ id: w.placementId }];
      for (const weekday of [3, 4]) {
        entries.push({ id: await ctx.db.insert("schedulePlacements", {
          ...w.placementArgs, weekday, externalAppId: w.appId,
        }) });
      }
      return entries;
    });
    await w.t.run(async (ctx) => {
      const queries = vi.spyOn(ctx.db, "query");
      try {
        await reconcilePlacementsById(ctx, entries);
        for (const table of ["scholarGroups", "reportingPeriods", "schoolClosures"]) {
          expect(queries.mock.calls.filter(([name]) => name === table)).toHaveLength(2);
        }
      } finally {
        queries.mockRestore();
      }
    });
    expect(await w.pushes()).toHaveLength(3);
    expect((await w.pushes()).map((push) => push.dayKey).sort())
      .toEqual(["2026-11-10", "2026-11-11", "2026-11-12"]);
    for (const push of await w.pushes()) expect(push.classId).toBe(w.cls._id);
  });

  test("one app reconciliation batch keeps each school's classes and timezone separate", async () => {
    const w = await setup();
    const other = w.world.schools[1];
    const foreign = await w.t.run(async (ctx) => {
      await ctx.db.patch(w.placementId, { externalAppId: w.appId });
      await ctx.db.patch(other.id, { timeZone: "UTC" });
      const periodId = await ctx.db.insert("reportingPeriods", {
        institutionId: other.id, label: "Other term", status: "open",
        startsAt: at("00:00", "2026-08-01"), endsAt: at("00:00", "2026-12-01"),
      });
      const groupId = await ctx.db.insert("scholarGroups", {
        institutionId: other.id, teacherId: other.teacher.id, name: "Other group",
        scholarIds: other.scholars.map((s) => s.id),
      });
      const blockId = await ctx.db.insert("scheduleBlocks", {
        periodId, key: "morning", label: "Other morning", weekdays: [2],
        startLocal: "20:00", endLocal: "21:00", order: 0,
      });
      const placementId = await ctx.db.insert("schedulePlacements", {
        periodId, groupId, blockId, subject: "Humanities", weekday: 2,
        externalAppId: w.appId,
      });
      return { placementId, periodId, groupId };
    });
    await w.t.run((ctx) => reconcilePlacementsById(ctx, [
      { id: w.placementId }, { id: foreign.placementId },
    ]));
    const cls = (await w.classes()).find((row) => row.groupId === foreign.groupId)!;
    expect(await w.pushes()).toEqual(expect.arrayContaining([
      expect.objectContaining({
        institutionId: w.school.id, classId: w.cls._id, dayKey,
        startsAt: at("08:45"), endsAt: at("10:25"),
      }),
      expect.objectContaining({
        institutionId: other.id, classId: cls._id, dayKey,
        startsAt: Date.parse(`${dayKey}T19:45:00Z`),
        endsAt: Date.parse(`${dayKey}T21:10:00Z`),
      }),
    ]));
  });

  test("whole-unit giving invalidates cached classes when detaching later activities changes meetings", async () => {
    const w = await setup();
    const second = await makeActivity(w.t, w.lessonId, { order: 1 });
    await w.t.run((ctx) => ctx.db.insert("schedulePlacements", {
      ...w.placementArgs, subject: "Science", mode: "homework",
      activityId: second, assignmentId: w.assignmentId,
    }));
    await w.teacher.mutation(api.assignments.assignWork, {
      unitId: w.unitId, scholarIds: w.school.scholars.map((s) => s.id),
      target: { kind: "unit" }, startsAt: at("09:30"), finish: { kind: "inClass" },
    });
    const pushes = await w.pushes();
    expect(pushes.find((p) => p.target.kind === "activity" && p.target.activityId === w.activityId))
      .toMatchObject({ classId: w.cls._id, dayKey });
    const secondPush = pushes.find((p) => p.target.kind === "activity" && p.target.activityId === second)!;
    expect(secondPush.classId).toBeUndefined();
    expect(secondPush.dayKey).toBeUndefined();
    expect(await w.classes()).toHaveLength(2);
  });

  test("in-class assignment give keeps the old window and writes the meeting and fade", async () => {
    const w = await setup();
    vi.setSystemTime(at("09:30"));
    await w.teacher.mutation(api.assignments.pushActivity, {
      assignmentId: w.assignmentId, activityId: w.activityId,
      finish: { kind: "inClass" },
    });
    expect(await w.pushes()).toEqual([expect.objectContaining({
      classId: w.cls._id, dayKey,
      timing: { kind: "focus" },
      endsAt: at("10:15"), afterEnd: "fade",
    })]);
  });

  test("by-date outside class writes late, with no class or meeting day", async () => {
    const w = await setup();
    await w.teacher.mutation(api.assignments.pushActivity, {
      assignmentId: w.assignmentId, activityId: w.activityId,
      finish: { kind: "by", dayKey: "2026-11-13" },
    });
    const [push] = await w.pushes();
    expect(push).toMatchObject({
      timing: { kind: "homework" },
      endsAt: dayEnd("2026-11-13"), afterEnd: "late",
    });
    expect(push.classId).toBeUndefined();
    expect(push.dayKey).toBeUndefined();
  });

  test("open-until keeps its later-day end and fades", async () => {
    const w = await setup();
    await w.teacher.mutation(api.assignments.pushActivity, {
      assignmentId: w.assignmentId, activityId: w.activityId,
      finish: { kind: "openUntil", dayKey: "2026-11-13" },
    });
    expect(await w.pushes()).toEqual([expect.objectContaining({
      timing: { kind: "openUntil" },
      endsAt: dayEnd("2026-11-13"), afterEnd: "fade",
    })]);
  });

  test.each(["group", "scholars"] as const)("ad-hoc app give to %s links its meeting; clearing preserves it", async (kind) => {
    const w = await setup();
    vi.setSystemTime(at("09:30"));
    const pushId = await w.teacher.mutation(api.pushes.makeFocus, {
      target: { kind: "app", externalAppId: w.appId },
      ...(kind === "group" ? { groupId: w.groupId } :
        { scholarIds: w.school.scholars.map((s) => s.id) }),
      durationMin: 20,
    });
    const before = await w.t.run((ctx) => ctx.db.get(pushId));
    expect(before).toMatchObject({
      classId: w.cls._id, dayKey, endsAt: at("09:50"), afterEnd: "fade",
    });
    await w.teacher.mutation(api.pushes.clearPush, { pushId });
    expect(await w.t.run((ctx) => ctx.db.get(pushId))).toMatchObject({
      classId: w.cls._id, dayKey, endsAt: at("09:50"), afterEnd: "fade",
      clearedReason: "teacher",
    });
  });

  test("two matching classes do not guess a class, even in one group", async () => {
    const w = await setup();
    await w.teacher.mutation(api.masterSchedule.placeClass, {
      ...w.placementArgs, subject: "Science",
    });
    vi.setSystemTime(at("09:30"));
    await w.teacher.mutation(api.pushes.makeFocus, {
      target: { kind: "app", externalAppId: w.appId }, groupId: w.groupId,
    });
    const [push] = await w.pushes();
    expect(push.afterEnd).toBe("fade");
    expect(push.classId).toBeUndefined();
    expect(push.dayKey).toBeUndefined();
  });

  test("planned start and timing changes recompute and remove stale meeting links", async () => {
    const w = await setup();
    await w.teacher.mutation(api.assignments.scheduleActivity, {
      assignmentId: w.assignmentId, activityId: w.activityId,
      startsAt: at("09:30"), finish: { kind: "inClass" },
    });
    const [before] = await w.pushes();
    expect(before).toMatchObject({
      classId: w.cls._id, dayKey, endsAt: at("10:15"), afterEnd: "fade",
    });
    expect(before.setAt).toBeUndefined();
    await w.teacher.mutation(api.assignments.scheduleActivity, {
      assignmentId: w.assignmentId, activityId: w.activityId,
      startsAt: at("11:00"),
      finish: { kind: "openUntil", dayKey: "2026-11-13" },
    });
    const [after] = await w.pushes();
    expect(after._id).toBe(before._id);
    expect(after).toMatchObject({ endsAt: dayEnd("2026-11-13"), afterEnd: "fade" });
    expect(after.classId).toBeUndefined();
    expect(after.dayKey).toBeUndefined();
  });

  test("until-cleared uses the planned or live school day; undated homework has no end", async () => {
    const w = await setup();
    await w.t.run((ctx) => writeSchedule(ctx, w.assignmentId, [{
      activityId: w.activityId, mode: "classFocus", startsAt: at("09:00"),
    }]));
    let [push] = await w.pushes();
    expect(push).toMatchObject({
      timing: { kind: "untilCleared" }, endsAt: dayEnd(), afterEnd: "fade",
      classId: w.cls._id, dayKey,
    });
    await w.t.run((ctx) => writeSchedule(ctx, w.assignmentId, [{
      activityId: w.activityId, mode: "classFocus", setAt: at("09:00", "2026-11-11"),
    }]));
    [push] = await w.pushes();
    expect(push.endsAt).toBe(dayEnd("2026-11-11"));
    expect(push.classId).toBeUndefined();
    await w.t.run((ctx) => writeSchedule(ctx, w.assignmentId, [{
      activityId: w.activityId, mode: "classFocus",
    }, {
      activityId: w.activityId, mode: "homework",
    }]));
    const rows = await w.pushes();
    expect(rows.find((row) => row.blocking)).toMatchObject({ afterEnd: "fade" });
    expect(rows.find((row) => row.blocking)?.endsAt).toBeUndefined();
    expect(rows.find((row) => !row.blocking)).toMatchObject({ afterEnd: "late" });
    expect(rows.find((row) => !row.blocking)?.endsAt).toBeUndefined();
  });

  test("withdrawal preserves the end and meeting rather than treating the close as a new give", async () => {
    const w = await setup();
    vi.setSystemTime(at("09:30"));
    await w.teacher.mutation(api.assignments.pushActivity, {
      assignmentId: w.assignmentId, activityId: w.activityId,
      finish: { kind: "by", dayKey: "2026-11-13" },
    });
    expect((await w.pushes())[0]).toMatchObject({
      classId: w.cls._id, afterEnd: "late",
    });
    expect((await w.pushes())[0].dayKey).toBeUndefined();
    await w.t.run(async (ctx) => {
      const entries = await readSchedule(ctx, { _id: w.assignmentId });
      await writeSchedule(ctx, w.assignmentId, entries.map((entry) => ({
        ...entry, endsAt: at("09:40"),
      })));
    });
    expect(await w.pushes()).toEqual([expect.objectContaining({
      clearedAt: at("09:40"), endsAt: dayEnd("2026-11-13"),
      afterEnd: "late", classId: w.cls._id,
    })]);
    expect((await w.pushes())[0].dayKey).toBeUndefined();
  });

  test("editing withdrawn homework's due date refreshes its end and keeps its archived class link", async () => {
    const w = await setup();
    const entry = {
      activityId: w.activityId, mode: "homework" as const,
      startsAt: at("09:30"), setAt: at("09:30"), dueAt: dayEnd("2026-11-13"),
      endsAt: at("09:40"),
    };
    await w.t.run((ctx) => writeSchedule(ctx, w.assignmentId, [entry]));
    const [before] = await w.pushes();
    expect(before).toMatchObject({ classId: w.cls._id, clearedAt: at("09:40") });
    await w.teacher.mutation(api.masterSchedule.removePlacement, { placementId: w.placementId });
    await w.t.run((ctx) => writeSchedule(ctx, w.assignmentId, [{
      ...entry, dueAt: dayEnd("2026-11-16"),
    }]));
    const [after] = await w.pushes();
    expect(after).toMatchObject({
      _id: before._id, clearedAt: before.clearedAt, scheduleWithdrawn: true,
      timing: { kind: "homework" },
      endsAt: dayEnd("2026-11-16"), afterEnd: "late",
    });
    expect(after.classId).toBe(w.cls._id);
    expect(after.dayKey).toBeUndefined();
  });

  test("rescheduling withdrawn homework outside its meeting clears the stale class link", async () => {
    const w = await setup();
    await w.t.run((ctx) => writeSchedule(ctx, w.assignmentId, [{
      activityId: w.activityId, mode: "homework",
      startsAt: at("09:30"), setAt: at("09:30"), dueAt: dayEnd("2026-11-13"),
      endsAt: at("09:40"),
    }]));
    const [before] = await w.pushes();
    expect(before.classId).toBe(w.cls._id);
    await w.teacher.mutation(api.assignments.rescheduleActivity, {
      assignmentId: w.assignmentId, activityId: w.activityId, startsAt: at("11:00"),
    });
    const [after] = await w.pushes();
    expect(after).toMatchObject({
      _id: before._id, clearedAt: before.clearedAt, startsAt: at("11:00"),
      endsAt: dayEnd("2026-11-13"), afterEnd: "late", scheduleWithdrawn: true,
    });
    expect(after.classId).toBeUndefined();
    expect(after.dayKey).toBeUndefined();
  });

  test("scheduled app links the bell meeting, not the preceding early-access window, and retimes", async () => {
    const w = await setup();
    const previousBlock = await w.admin.mutation(api.masterSchedule.createBlock, {
      periodId: w.periodId, label: "Earlier", startLocal: "08:00",
      endLocal: "09:00", weekdays: [2],
    });
    await w.teacher.mutation(api.masterSchedule.placeClass, {
      ...w.placementArgs, blockId: previousBlock, subject: "Science",
    });
    await w.teacher.mutation(api.masterSchedule.updatePlacement, {
      placementId: w.placementId, externalAppId: w.appId,
    });
    const [before] = await w.pushes();
    expect(before).toMatchObject({
      startsAt: at("08:45"), endsAt: at("10:25"),
      afterEnd: "fade", classId: w.cls._id, dayKey,
    });
    await w.admin.mutation(api.masterSchedule.updateBlock, {
      blockId: w.blockId, startLocal: "09:15", endLocal: "10:30",
    });
    const [after] = await w.pushes();
    expect(after).toMatchObject({
      _id: before._id, startsAt: at("09:00"), endsAt: at("10:40"),
      timing: { kind: "focus" },
      afterEnd: "fade", classId: w.cls._id, dayKey,
    });
  });
});

describe("class records follow recurring placements", () => {
  test.each(["lesson", "internal-lesson", "unit"] as const)(
    "%s deletion retains both meetings across separate activity cascades", async (kind) => {
      const w = await setup();
      const secondLesson = kind === "unit" ? await makeLesson(w.t, w.unitId) : w.lessonId;
      const secondActivity = await makeActivity(w.t, secondLesson);
      await w.t.run(async (ctx) => {
        await ctx.db.patch(w.placementId, { activityId: w.activityId });
        await ctx.db.insert("schedulePlacements", {
          ...w.placementArgs, weekday: 3, activityId: secondActivity,
        });
        await syncClassesForGroupPeriod(ctx, w.periodId, w.groupId);
        // Unit deletion refuses any assignment; this fixture's empty one has no work.
        if (kind === "unit") await ctx.db.delete(w.assignmentId);
      });
      const [before] = await w.classes();
      expect(before.meetings).toHaveLength(2);
      if (kind === "lesson") {
        await w.teacher.mutation(api.lessons.remove, { id: w.lessonId });
      } else if (kind === "internal-lesson") {
        await w.t.mutation(internal.curriculumAssistant.deleteLessonInternal, { lessonId: w.lessonId });
      } else {
        await w.teacher.mutation(api.units.remove, { id: w.unitId });
      }
      expect(await w.classes()).toEqual([{ ...before, archivedAt: at("08:00") }]);
      expect(await w.t.run((ctx) => ctx.db.query("schedulePlacements").collect())).toEqual([]);
      expect(await w.t.run((ctx) => ctx.db.get(w.activityId))).toBeNull();
      expect(await w.t.run((ctx) => ctx.db.get(secondActivity))).toBeNull();
    },
  );

  test("group removal retains both meetings across orphan-handout cleanup", async () => {
    const w = await setup();
    const handouts = await w.t.run(async (ctx) => {
      const activityIds = [];
      for (const weekday of [2, 3]) {
        const activityId = await ctx.db.insert("activities", {
          title: `Fixture handout ${weekday}`, kind: "offline", order: weekday,
          scholarDescription: "Record an observation.",
        });
        const assignmentId = await ctx.db.insert("assignments", {
          teacherId: w.school.teacher.id, scholarGroupId: w.groupId,
          scholarIds: w.school.scholars.map((s) => s.id),
          kind: "adHocDispatch", startedAt: at("08:00"),
        });
        await writeSchedule(ctx, assignmentId, [{
          activityId, mode: "classFocus", startsAt: at("09:00"),
        }]);
        if (weekday === 2) {
          await ctx.db.patch(w.placementId, { activityId, assignmentId });
        } else {
          await ctx.db.insert("schedulePlacements", {
            ...w.placementArgs, weekday, activityId, assignmentId,
          });
        }
        activityIds.push(activityId);
      }
      await syncClassesForGroupPeriod(ctx, w.periodId, w.groupId);
      return activityIds;
    });
    const [before] = await w.classes();
    expect(before.meetings).toHaveLength(2);
    await w.admin.mutation(api.scholarGroups.remove, { groupId: w.groupId });
    expect(await w.classes()).toEqual([{ ...before, archivedAt: at("08:00") }]);
    for (const activityId of handouts) {
      expect(await w.t.run((ctx) => ctx.db.get(activityId))).toBeNull();
    }
    expect(await w.t.run((ctx) => ctx.db.get(w.groupId))).toBeNull();
  });

  test.each(["cron", "block-edit"] as const)(
    "%s reconciliation retains both meetings when an app is archived", async (path) => {
      const w = await setup();
      await w.teacher.mutation(api.masterSchedule.updatePlacement, {
        placementId: w.placementId, externalAppId: w.appId,
      });
      await w.teacher.mutation(api.masterSchedule.placeClass, {
        ...w.placementArgs, weekday: 3, externalAppId: w.appId,
      });
      const [before] = await w.classes();
      expect(before.meetings).toHaveLength(2);
      const asPlatformAdmin = await w.world.as.platformAdmin();
      await asPlatformAdmin.mutation(api.externalApps.setCatalogAppArchived, {
        appId: w.appId, archived: true,
      });
      if (path === "cron") {
        await w.t.mutation(internal.masterSchedule.autoMaterializeTick, {});
      } else {
        await w.admin.mutation(api.masterSchedule.updateBlock, {
          blockId: w.blockId, endLocal: "10:30",
        });
      }
      expect(await w.classes()).toEqual([{ ...before, archivedAt: at("08:00") }]);
      expect(await w.t.run((ctx) => ctx.db.query("schedulePlacements").collect())).toEqual([]);
      expect(await w.pushes()).toHaveLength(2);
      for (const push of await w.pushes()) {
        expect(push).toMatchObject({ classId: before._id, clearedReason: "expired" });
      }
    },
  );

  test("archiving one activity retains both meetings of its archived class", async () => {
    const w = await setup();
    await updateCard(w.teacher, {
      placementId: w.placementId, assignmentId: w.assignmentId, activityId: w.activityId,
    });
    await placeCard(w.teacher, {
      ...w.placementArgs, weekday: 3, assignmentId: w.assignmentId, activityId: w.activityId,
    });
    const [before] = await w.classes();
    expect(before.meetings).toHaveLength(2);
    await w.teacher.mutation(api.activities.setArchived, { id: w.activityId, archived: true });
    expect(await w.classes()).toEqual([{ ...before, archivedAt: at("08:00") }]);
    expect(await w.t.run((ctx) => ctx.db.query("schedulePlacements").collect())).toEqual([]);
  });

  test("many-group sync reads blocks once per period and no blocks for emptied groups", async () => {
    const w = await setup();
    await w.t.run(async (ctx) => {
      const placements: Doc<"schedulePlacements">[] = [];
      for (let term = 0; term < 2; term++) {
        const periodId = await ctx.db.insert("reportingPeriods", {
          institutionId: w.school.id, label: `Fixture term ${term}`,
          startsAt: at("00:00"), endsAt: at("00:00", "2026-12-01"), status: "writing",
        });
        const blockId = await ctx.db.insert("scheduleBlocks", {
          periodId, key: "morning", label: "Morning", startLocal: "09:00",
          endLocal: "10:15", weekdays: [2, 3], order: 0,
        });
        for (let group = 0; group < 12; group++) {
          const groupId = await ctx.db.insert("scholarGroups", {
            institutionId: w.school.id, teacherId: w.school.teacher.id,
            name: `Fixture group ${term}-${group}`, scholarIds: [],
          });
          for (const weekday of [2, 3]) {
            const id = await ctx.db.insert("schedulePlacements", {
              periodId, groupId, blockId, weekday, subject: "Science",
            });
            placements.push((await ctx.db.get(id))!);
          }
        }
      }
      const queries = vi.spyOn(ctx.db, "query");
      try {
        await syncClassesForPlacements(ctx, placements);
        expect(queries.mock.calls.filter(([table]) => table === "scheduleBlocks")).toHaveLength(2);
        for (const p of placements) await ctx.db.delete(p._id);
        queries.mockClear();
        await syncClassesForPlacements(ctx, placements);
        expect(queries.mock.calls.filter(([table]) => table === "scheduleBlocks")).toHaveLength(0);
      } finally {
        queries.mockRestore();
      }
      const classes = (await ctx.db.query("classes").collect()).filter((cls) => cls._id !== w.cls._id);
      expect(classes).toHaveLength(24);
      for (const cls of classes) {
        expect(cls.archivedAt).toBe(at("08:00"));
        expect(cls.meetings).toHaveLength(2);
      }
    });
  });

  test("place, move, remove, and re-place preserve class identity and archive idempotently", async () => {
    const w = await setup();
    expect(w.cls).toMatchObject({
      institutionId: w.school.id, periodId: w.periodId, groupId: w.groupId,
      subjectKey: "humanities", teacherId: w.school.teacher.id,
      meetings: [{ weekday: 2, blockId: w.blockId }],
    });
    expect(await w.teacher.mutation(api.masterSchedule.placeClass, w.placementArgs))
      .toBe(w.placementId);
    expect(await w.classes()).toEqual([w.cls]);
    await w.teacher.mutation(api.masterSchedule.movePlacement, {
      placementId: w.placementId, blockId: w.blockId, weekday: 3,
    });
    expect(await w.classes()).toEqual([expect.objectContaining({
      _id: w.cls._id, meetings: [{ weekday: 3, blockId: w.blockId }],
    })]);
    await w.teacher.mutation(api.masterSchedule.removePlacement, { placementId: w.placementId });
    const [archived] = await w.classes();
    expect(archived.meetings).toEqual([{ weekday: 3, blockId: w.blockId }]);
    expect(archived.archivedAt).toBe(at("08:00"));
    vi.setSystemTime(at("08:01"));
    await w.t.run((ctx) => syncClassesForGroupPeriod(ctx, w.periodId, w.groupId));
    expect(await w.classes()).toEqual([archived]);
    await w.teacher.mutation(api.masterSchedule.placeClass, w.placementArgs);
    const [restored] = await w.classes();
    expect(restored._id).toBe(w.cls._id);
    expect(restored.archivedAt).toBeUndefined();
    expect(restored.meetings).toEqual(w.cls.meetings);
  });

  test("subject, teacher agreement, and unique recurring apps follow updates", async () => {
    const w = await setup();
    const second = await w.teacher.mutation(api.masterSchedule.placeClass, {
      ...w.placementArgs, weekday: 3, subject: " humanities ",
      externalAppId: w.appId,
    });
    let [cls] = await w.classes();
    expect(cls.meetings).toHaveLength(2);
    expect(cls.externalAppId).toBe(w.appId);
    await w.teacher.mutation(api.masterSchedule.updatePlacement, {
      placementId: second, teacherId: w.school.admin.id,
    });
    [cls] = await w.classes();
    expect(cls.teacherId).toBeUndefined();
    await w.teacher.mutation(api.masterSchedule.reassignTeacher, {
      periodId: w.periodId, fromTeacherId: w.school.admin.id,
      toTeacherId: w.school.teacher.id,
    });
    expect((await w.classes())[0].teacherId).toBe(w.school.teacher.id);
    const otherAppId = await w.t.run((ctx) => ctx.db.insert("externalApps", {
      name: "Fixture notebook", webUrl: "https://example.com/notebook",
    }));
    await w.teacher.mutation(api.masterSchedule.updatePlacement, {
      placementId: w.placementId, externalAppId: otherAppId,
    });
    expect((await w.classes())[0].externalAppId).toBeUndefined();
    await w.teacher.mutation(api.masterSchedule.updatePlacement, {
      placementId: second, subject: "Science",
    });
    expect(await w.classes()).toEqual(expect.arrayContaining([
      expect.objectContaining({ subjectKey: "humanities", externalAppId: otherAppId }),
      expect.objectContaining({ subjectKey: "science", externalAppId: w.appId }),
    ]));
  });

  test("shelf and homework transitions retire meetings; concrete rows never add them", async () => {
    const w = await setup();
    await w.t.run(async (ctx) => {
      const placementId = await ctx.db.insert("schedulePlacements", {
        ...w.placementArgs, subject: "Concrete",
        weekStartMs: at("00:00", "2026-11-09"),
      });
      await reconcilePlacementById(ctx, placementId);
    });
    expect(await w.classes()).toHaveLength(1);
    await w.teacher.mutation(api.masterSchedule.movePlacement, {
      placementId: w.placementId, weekday: null, blockId: null,
    });
    expect((await w.classes())[0].archivedAt).toBeDefined();
    await w.teacher.mutation(api.masterSchedule.movePlacement, {
      placementId: w.placementId, weekday: 2, blockId: w.blockId,
    });
    expect((await w.classes())[0].archivedAt).toBeUndefined();
    await w.teacher.mutation(api.masterSchedule.updatePlacement, {
      placementId: w.placementId, mode: "homework",
    });
    expect((await w.classes())[0].archivedAt).toBeDefined();
    await w.teacher.mutation(api.masterSchedule.updatePlacement, {
      placementId: w.placementId, mode: "classFocus",
    });
    expect((await w.classes())[0].archivedAt).toBeUndefined();
  });

  test("block weekdays and removal update or archive the class", async () => {
    const w = await setup();
    await w.admin.mutation(api.masterSchedule.updateBlock, {
      blockId: w.blockId, weekdays: [1, 3],
    });
    expect((await w.classes())[0].archivedAt).toBeDefined();
    await w.admin.mutation(api.masterSchedule.updateBlock, {
      blockId: w.blockId, weekdays: [2, 3],
    });
    expect((await w.classes())[0].archivedAt).toBeUndefined();
    await w.admin.mutation(api.masterSchedule.removeBlock, { blockId: w.blockId });
    expect((await w.classes())[0]).toMatchObject({ meetings: w.cls.meetings, archivedAt: at("08:00") });
  });

  test.each(["assignment", "group"] as const)("%s removal archives its recurring meetings", async (kind) => {
    const w = await setup();
    if (kind === "assignment") {
      await updateCard(w.teacher, {
        placementId: w.placementId, assignmentId: w.assignmentId, activityId: w.activityId,
      });
      await w.teacher.mutation(api.assignments.archive, { assignmentId: w.assignmentId });
    } else {
      await w.admin.mutation(api.scholarGroups.remove, { groupId: w.groupId });
    }
    expect(await w.classes()).toEqual([expect.objectContaining({
      _id: w.cls._id, meetings: w.cls.meetings, archivedAt: at("08:00"),
    })]);
  });

  test("term copies create class records and term teardown archives without deleting them", async () => {
    const w = await setup();
    const copy = await w.t.mutation(internal.adminTermTools.createTestTerm, {
      fromPeriodLabel: "Fall", label: "Fixture spring",
      startsAt: at("00:00", "2027-01-01"), endsAt: at("00:00", "2027-06-01"),
      groupName: "Tide pool group",
    });
    const copiedClass = (await w.classes()).find((cls) => cls.periodId === copy.periodId)!;
    expect(copiedClass).toMatchObject({
      groupId: w.groupId, subjectKey: "humanities",
      teacherId: w.school.teacher.id,
    });
    expect(copiedClass.meetings).toHaveLength(1);
    expect(copiedClass.meetings[0].blockId).not.toBe(w.blockId);
    await w.t.mutation(internal.adminTermTools.endTestTerm, {
      label: "Fixture spring", expectSourceLabel: "Fall", deleteRows: true,
    });
    expect(await w.classes()).toEqual(expect.arrayContaining([
      w.cls,
      expect.objectContaining({
        _id: copiedClass._id, meetings: copiedClass.meetings, archivedAt: at("08:00"),
      }),
    ]));
  });

  test("sync archives a class if its group was already removed by a cascade", async () => {
    const w = await setup();
    await w.t.run(async (ctx) => {
      await ctx.db.delete(w.placementId);
      await ctx.db.delete(w.groupId);
      await syncClassesForGroupPeriod(ctx, w.periodId, w.groupId);
    });
    expect(await w.classes()).toEqual([expect.objectContaining({
      _id: w.cls._id, meetings: w.cls.meetings, archivedAt: at("08:00"),
    })]);
  });

  test("dev timetable replacement and skip-existing seeding keep classes in step", async () => {
    const w = await setup();
    await w.t.mutation(internal.seedMasterSchedule.seedSample, { force: true });
    const classes = await w.classes();
    expect(classes.find((cls) => cls._id === w.cls._id)?.archivedAt).toBeDefined();
    expect(classes.some((cls) => cls.archivedAt === undefined &&
      cls.subjectKey === "math workshop" && cls.meetings.length > 0)).toBe(true);
    await w.t.mutation(internal.seedMasterSchedule.seedSample, {});
    expect(await w.classes()).toEqual(classes);
  });
});

describe("a chosen homework class is stored, not inferred (TRA-581)", () => {
  // The fixture class meets Tuesdays 09:00–10:15; 2026-11-10 is a Tuesday.
  const nextMonday = at("00:00", "2026-11-16");
  const wed1pm = at("13:00", "2026-11-11");

  async function homeworkRow(w: Awaited<ReturnType<typeof setup>>) {
    const rows = await w.pushes();
    expect(rows).toHaveLength(1);
    return rows[0];
  }

  /** "Start it now": the stored entry, made live at the current time. */
  async function startNow(w: Awaited<ReturnType<typeof setup>>, now: number) {
    await w.t.run(async (ctx) => {
      const entries = await readSchedule(ctx, { _id: w.assignmentId });
      await writeSchedule(ctx, w.assignmentId, entries.map((entry) => ({
        ...entry, startsAt: now, setAt: now,
      })));
    });
  }

  test("given during its own class, a chosen class survives a second move", async () => {
    const w = await setup();
    await w.t.run((ctx) => writeSchedule(ctx, w.assignmentId, [{
      activityId: w.activityId, mode: "homework", startsAt: at("09:30"),
      dueAt: dayEnd("2026-11-13"), homeworkClassId: w.cls._id,
    }]));
    expect(await homeworkRow(w)).toMatchObject({ classId: w.cls._id, classSource: "chosen" });
    await w.teacher.mutation(api.assignments.rescheduleActivity, {
      assignmentId: w.assignmentId, activityId: w.activityId, startsAt: wed1pm,
    });
    expect(await homeworkRow(w)).toMatchObject({
      startsAt: wed1pm, classId: w.cls._id, classSource: "chosen",
    });
  });

  test("next week's homework, started now during its class, then moved again keeps it", async () => {
    const w = await setup();
    await w.t.run((ctx) => writeSchedule(ctx, w.assignmentId, [{
      activityId: w.activityId, mode: "homework", startsAt: nextMonday,
      dueAt: dayEnd("2026-11-20"), homeworkClassId: w.cls._id,
    }]));
    vi.setSystemTime(at("09:30"));
    await startNow(w, at("09:30"));
    expect(await homeworkRow(w)).toMatchObject({
      setAt: at("09:30"), classId: w.cls._id, classSource: "chosen",
    });
    await w.teacher.mutation(api.assignments.rescheduleActivity, {
      assignmentId: w.assignmentId, activityId: w.activityId, startsAt: wed1pm,
    });
    expect(await homeworkRow(w)).toMatchObject({ classId: w.cls._id, classSource: "chosen" });
  });

  test("a meeting-derived class still moves with the meeting", async () => {
    const w = await setup();
    const scienceId = await w.teacher.mutation(api.masterSchedule.placeClass, {
      ...w.placementArgs, weekday: 3, subject: "Science",
    });
    expect(scienceId).toBeTruthy();
    const science = (await w.classes()).find((c) => c._id !== w.cls._id)!;
    await w.t.run((ctx) => writeSchedule(ctx, w.assignmentId, [{
      activityId: w.activityId, mode: "homework", startsAt: at("09:30"),
      dueAt: dayEnd("2026-11-13"),
    }]));
    expect(await homeworkRow(w)).toMatchObject({ classId: w.cls._id, classSource: "meeting" });
    await w.teacher.mutation(api.assignments.rescheduleActivity, {
      assignmentId: w.assignmentId, activityId: w.activityId,
      startsAt: at("09:30", "2026-11-11"),
    });
    expect(await homeworkRow(w)).toMatchObject({ classId: science._id, classSource: "meeting" });
    await w.teacher.mutation(api.assignments.rescheduleActivity, {
      assignmentId: w.assignmentId, activityId: w.activityId, startsAt: wed1pm,
    });
    const moved = await homeworkRow(w);
    expect(moved.classId).toBeUndefined();
    expect(moved.classSource).toBeUndefined();
  });

  test("a chosen class that no longer passes the class checks drops on the next move", async () => {
    const w = await setup();
    await w.t.run((ctx) => writeSchedule(ctx, w.assignmentId, [{
      activityId: w.activityId, mode: "homework", startsAt: at("09:30"),
      dueAt: dayEnd("2026-11-13"), homeworkClassId: w.cls._id,
    }]));
    await w.teacher.mutation(api.masterSchedule.removePlacement, { placementId: w.placementId });
    await w.teacher.mutation(api.assignments.rescheduleActivity, {
      assignmentId: w.assignmentId, activityId: w.activityId, startsAt: wed1pm,
    });
    const moved = await homeworkRow(w);
    expect(moved.classId).toBeUndefined();
    expect(moved.classSource).toBeUndefined();
  });

  test("a row written before the marker is still inferred as chosen off its meeting", async () => {
    const w = await setup();
    await w.t.run((ctx) => writeSchedule(ctx, w.assignmentId, [{
      activityId: w.activityId, mode: "homework", startsAt: nextMonday,
      dueAt: dayEnd("2026-11-20"), homeworkClassId: w.cls._id,
    }]));
    const before = await homeworkRow(w);
    await w.t.run((ctx) => ctx.db.patch(before._id, { classSource: undefined }));
    await w.teacher.mutation(api.assignments.rescheduleActivity, {
      assignmentId: w.assignmentId, activityId: w.activityId, startsAt: wed1pm,
    });
    expect(await homeworkRow(w)).toMatchObject({ classId: w.cls._id, classSource: "chosen" });
  });
});

describe("meeting resolution boundaries", () => {
  test.each(["recess", "lunch", "prep", "homework"] as const)(
    "%s blocks neither create classes nor match stale class records", async (kind) => {
      const w = await setup();
      const blockId = await w.admin.mutation(api.masterSchedule.createBlock, {
        periodId: w.periodId, label: "Not class time", startLocal: "11:00",
        endLocal: "11:30", weekdays: [2], kind,
      });
      await w.teacher.mutation(api.masterSchedule.placeClass, {
        ...w.placementArgs, blockId, subject: "Recess duty",
        ...(kind === "homework" ? { mode: "homework" as const } : {}),
      });
      expect(await w.classes()).toEqual([w.cls]);
      await w.t.run((ctx) => ctx.db.insert("classes", {
        institutionId: w.school.id, periodId: w.periodId, groupId: w.groupId,
        subject: "Recess duty", subjectKey: "recess duty",
        meetings: [{ weekday: 2, blockId }],
      }));
      vi.setSystemTime(at("11:10"));
      await w.teacher.mutation(api.pushes.makeFocus, {
        target: { kind: "app", externalAppId: w.appId }, groupId: w.groupId,
      });
      expect((await w.pushes())[0].classId).toBeUndefined();
      expect((await w.pushes())[0].dayKey).toBeUndefined();
    },
  );

  test("changing a class block to recess archives its class and keeps its last meetings", async () => {
    const w = await setup();
    await w.admin.mutation(api.masterSchedule.updateBlock, {
      blockId: w.blockId, kind: "recess",
    });
    expect(await w.classes()).toEqual([{ ...w.cls, archivedAt: at("08:00") }]);
    await w.admin.mutation(api.masterSchedule.updateBlock, {
      blockId: w.blockId, kind: "class",
    });
    expect(await w.classes()).toEqual([w.cls]);
  });

  test("two non-overlapping meetings of one class on a weekday are ambiguous", async () => {
    const w = await setup();
    const afternoon = await w.admin.mutation(api.masterSchedule.createBlock, {
      periodId: w.periodId, label: "Afternoon", startLocal: "13:00",
      endLocal: "14:00", weekdays: [2], kind: "class",
    });
    await w.teacher.mutation(api.masterSchedule.placeClass, {
      ...w.placementArgs, blockId: afternoon,
    });
    expect((await w.classes())[0].meetings).toHaveLength(2);
    vi.setSystemTime(at("09:30"));
    await w.teacher.mutation(api.assignments.pushActivity, {
      assignmentId: w.assignmentId, activityId: w.activityId,
      finish: { kind: "inClass" },
    });
    expect((await w.pushes())[0].classId).toBeUndefined();
    expect((await w.pushes())[0].dayKey).toBeUndefined();
  });

  test.each(["school", "global", "other-school"] as const)(
    "%s holiday is scoped correctly when linking a give", async (scope) => {
      const w = await setup();
      await w.t.run((ctx) => ctx.db.insert("schoolClosures", {
        institutionId: scope === "global" ? undefined :
          scope === "school" ? w.school.id : w.world.schools[1].id,
        startDayKey: dayKey, endDayKey: dayKey, label: "Fixture holiday", kind: "holiday",
      }));
      vi.setSystemTime(at("09:30"));
      await w.teacher.mutation(api.pushes.makeFocus, {
        target: { kind: "app", externalAppId: w.appId }, groupId: w.groupId,
      });
      const [push] = await w.pushes();
      expect(push.classId).toBe(scope === "other-school" ? w.cls._id : undefined);
      expect(push.dayKey).toBe(scope === "other-school" ? dayKey : undefined);
    },
  );

  test("a roster shared by two meeting groups is ambiguous, but a named group is not", async () => {
    const w = await setup();
    const otherGroup = await w.t.run((ctx) => ctx.db.insert("scholarGroups", {
      institutionId: w.school.id, teacherId: w.school.teacher.id,
      name: "Second fixture group", scholarIds: w.school.scholars.map((s) => s.id),
    }));
    await w.teacher.mutation(api.masterSchedule.placeClass, {
      ...w.placementArgs, groupId: otherGroup,
    });
    vi.setSystemTime(at("09:30"));
    await w.teacher.mutation(api.assignments.pushActivity, {
      assignmentId: w.assignmentId, activityId: w.activityId,
      finish: { kind: "inClass" },
    });
    expect((await w.pushes())[0].classId).toBeUndefined();
    const pushId = await w.teacher.mutation(api.pushes.makeFocus, {
      target: { kind: "app", externalAppId: w.appId }, groupId: w.groupId,
    });
    expect(await w.t.run((ctx) => ctx.db.get(pushId))).toMatchObject({
      classId: w.cls._id, dayKey,
    });
  });

  test("the covering term wins over the open term and missing or overlapping terms never guess", async () => {
    const w = await setup();
    const spring = await w.t.run(async (ctx) => {
      const periodId = await ctx.db.insert("reportingPeriods", {
        institutionId: w.school.id, label: "Spring", status: "writing",
        startsAt: at("00:00", "2027-01-01"), endsAt: at("00:00", "2027-06-01"),
      });
      const blockId = await ctx.db.insert("scheduleBlocks", {
        periodId, key: "spring", label: "Spring", startLocal: "09:00",
        endLocal: "10:00", weekdays: [2], order: 0,
      });
      return { periodId, blockId };
    });
    await w.teacher.mutation(api.masterSchedule.placeClass, {
      ...w.placementArgs, ...spring,
    });
    const springClass = (await w.classes()).find((cls) => cls.periodId === spring.periodId)!;
    const lookup = () => w.t.run((ctx) => classMeetingForGive(ctx, {
      institutionId: w.school.id, groupIds: [w.groupId],
      at: at("09:30", "2027-01-05"), timeZone,
    }));
    expect(await lookup()).toEqual({ classId: springClass._id, dayKey: "2027-01-05" });
    await w.t.run((ctx) => ctx.db.insert("reportingPeriods", {
      institutionId: w.school.id, label: "Overlapping fixture", status: "open",
      startsAt: at("00:00", "2027-01-01"), endsAt: at("00:00", "2027-06-01"),
    }));
    expect(await lookup()).toBeNull();
  });

  test("another school's group is never linked, even if its roster contains local scholars", async () => {
    const w = await setup();
    const foreign = w.world.schools[1];
    const foreignGroup = await w.t.run(async (ctx) => {
      const groupId = await ctx.db.insert("scholarGroups", {
        institutionId: foreign.id, teacherId: foreign.teacher.id,
        name: "Foreign fixture", scholarIds: w.school.scholars.map((s) => s.id),
      });
      await ctx.db.insert("classes", {
        institutionId: foreign.id, periodId: w.periodId, groupId,
        subject: "Science", subjectKey: "science",
        meetings: [{ weekday: 2, blockId: w.blockId }],
      });
      return groupId;
    });
    const lookup = (groupIds: Doc<"scholarGroups">["_id"][]) =>
      w.t.run((ctx) => classMeetingForGive(ctx, {
        institutionId: w.school.id, groupIds, at: at("09:30"), timeZone,
      }));
    expect(await lookup([foreignGroup])).toBeNull();
    expect(await lookup([w.groupId, foreignGroup])).toEqual({ classId: w.cls._id, dayKey });
    await w.teacher.mutation(api.masterSchedule.removePlacement, { placementId: w.placementId });
    vi.setSystemTime(at("09:30"));
    await w.teacher.mutation(api.assignments.pushActivity, {
      assignmentId: w.assignmentId, activityId: w.activityId,
      finish: { kind: "inClass" },
    });
    expect((await w.pushes())[0].classId).toBeUndefined();
  });

  test("a mixed roster, institution audience, and time beyond the term stay unlinked", async () => {
    const w = await setup();
    vi.setSystemTime(at("09:30"));
    await w.teacher.mutation(api.pushes.makeFocus, {
      target: { kind: "app", externalAppId: w.appId },
    });
    await w.t.run((ctx) => ctx.db.patch(w.groupId, {
      scholarIds: [w.school.scholars[0].id],
    }));
    await w.teacher.mutation(api.assignments.pushActivity, {
      assignmentId: w.assignmentId, activityId: w.activityId,
      finish: { kind: "inClass" },
    });
    for (const push of await w.pushes()) {
      expect(push.classId).toBeUndefined();
      expect(push.dayKey).toBeUndefined();
    }
    expect(await w.t.run((ctx) => classMeetingForGive(ctx, {
      institutionId: w.school.id, groupIds: [w.groupId],
      at: at("09:30", "2027-01-05"), timeZone,
    }))).toBeNull();
  });
});
