import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import schema from "../schema";
import { api, internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import {
  makeActivity,
  makeLesson,
  makeParent,
  makeUnit,
  makeWorld,
  type WorldSchool,
  type WorldScholar,
} from "./factories/world";
import { dayStartForDayKey } from "../../shared/institutionDay";
import { insertAssignmentWithSchedule, setSchedule } from "./scheduleFixtures";
import { readSchedule } from "../lib/scheduleStore";

// The parent Homework tab's plan (parents.childHomeworkPlan): every homework
// give that reaches the child, guardian-gated, PLAN ONLY (TRA-574). These pin
// the gate (own child yes; another family's child or another school's child
// no), that finishing work never changes the plan, the week window, and that
// the response carries no status.

const modules = (
  import.meta as ImportMeta & {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("../**/*.ts");

const TIME_ZONE = "Pacific/Honolulu";
const TODAY = "2026-11-04";
const NOW = dayStartForDayKey(TODAY, TIME_ZONE) + 19 * 60 * 60_000;
const dueOn = (dayKey: string) =>
  dayStartForDayKey(dayKey, TIME_ZONE) + (24 * 60 - 1) * 60_000;
/** A give at `hour` o'clock school time on `dayKey`. */
const givenOn = (dayKey: string, hour = 9) =>
  dayStartForDayKey(dayKey, TIME_ZONE) + hour * 60 * 60_000;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
});

type T = ReturnType<typeof convexTest>;

/** Three homework items for `scholar`: one late, one this week, one next. */
async function giveHomework(t: T, school: WorldSchool, scholar: WorldScholar) {
  const unitId = await makeUnit(t, school.teacher, school, {
    subject: "Science",
  });
  const lessonId = await makeLesson(t, unitId);
  const make = (title: string, order: number) =>
    makeActivity(t, lessonId, {
      title,
      kind: "online",
      order,
      systemPrompt: "...",
    });
  const pastDue = await make("Leaf rubbings", 0);
  const thisWeek = await make("Moon journal", 1);
  const nextWeek = await make("Build a sundial", 2);
  const due: Record<string, number> = {
    [pastDue]: dueOn("2026-11-02"),
    [thisWeek]: dueOn("2026-11-05"),
    [nextWeek]: dueOn("2026-11-10"),
  };
  const assignmentId = await t.run((ctx) =>
    insertAssignmentWithSchedule(ctx, {
      teacherId: school.teacher.id,
      unitId,
      scholarIds: [scholar.id],
      startedAt: NOW - 7 * 86_400_000,
      activitySchedule: [pastDue, thisWeek, nextWeek].map((activityId) => ({
        activityId,
        mode: "homework" as const,
        setAt: NOW - 7 * 86_400_000,
        dueAt: due[activityId],
      })),
    }),
  );
  return { unitId, lessonId, assignmentId, pastDue, thisWeek, nextWeek };
}

async function setUp(t: T) {
  const world = await makeWorld(t);
  await t.run(async (ctx) => {
    for (const school of world.schools) {
      await ctx.db.patch(school.id, { timeZone: TIME_ZONE });
    }
  });
  const [schoolA, schoolB] = world.schools;
  const child = schoolA.scholars[0];
  const parent = schoolA.parents[0];
  expect(parent.children.map((c) => c.id)).toEqual([child.id]);
  const work = await giveHomework(t, schoolA, child);
  return { world, schoolA, schoolB, child, parent, work };
}

describe("parents.childHomeworkPlan", () => {
  test("a guardian reads their own child's plan, overdue items included by date", async () => {
    const t = convexTest(schema, modules);
    const { world, parent, child } = await setUp(t);
    const asParent = await world.as.parent(parent);

    const plan = await asParent.query(api.parents.childHomeworkPlan, {
      scholarId: child.id,
    });
    expect(plan.timeZone).toBe(TIME_ZONE);
    expect(plan.items.map((item) => item.title)).toEqual([
      "Leaf rubbings",
      "Moon journal",
      "Build a sundial",
    ]);
    expect(plan.items[0]).toMatchObject({
      subject: "Science",
      dueAt: dueOn("2026-11-02"),
      awayFromBunnyPad: false,
    });
    expect(plan.items[0].teacherName).toBeTruthy();
  });

  test("the response carries no status or completion fields", async () => {
    const t = convexTest(schema, modules);
    const { world, parent, child } = await setUp(t);
    const plan = await (await world.as.parent(parent)).query(
      api.parents.childHomeworkPlan,
      { scholarId: child.id },
    );
    expect(Object.keys(plan).sort()).toEqual(["closures", "items", "timeZone", "trips"]);
    for (const item of plan.items) {
      expect(Object.keys(item).sort()).toEqual([
        "awayFromBunnyPad",
        "dueAt",
        "emoji",
        "key",
        "openUntil",
        "subject",
        "teacherName",
        "title",
      ]);
    }
  });

  // Plan, never status: membership must not depend on completion, so a
  // finished item stays and nothing about the output moves when it's done.
  test("a finished item stays on the plan, and the plan is identical before and after", async () => {
    const t = convexTest(schema, modules);
    const { world, parent, child, work } = await setUp(t);
    const asParent = await world.as.parent(parent);
    const read = () =>
      asParent.query(api.parents.childHomeworkPlan, { scholarId: child.id });

    const before = await read();
    expect(before.items.map((item) => item.title)).toContain("Moon journal");

    const asChild = await world.as.scholar(child);
    await asChild.mutation(api.sessions.create, {
      activityId: work.thisWeek,
      assignmentId: work.assignmentId,
    });
    await t.run((ctx) =>
      ctx.db.insert("activityCompletions", {
        scholarId: child.id,
        activityId: work.thisWeek,
        lessonId: work.lessonId,
        unitId: work.unitId,
        assignmentId: work.assignmentId,
        completedAt: NOW - 60_000,
      }),
    );

    expect(await read()).toEqual(before);

    // The child's own list is unchanged: finished work leaves it.
    const childRows = (
      await asChild.query(api.scholarPlate.activeForMe, {
        includeWebActivities: true,
      })
    ).rows.filter((row) => row.origin === "homework");
    expect(childRows.map((row) => row.title)).not.toContain("Moon journal");
  });

  test("a dated item stays until its week falls before last week", async () => {
    const t = convexTest(schema, modules);
    const { world, schoolA, parent, child } = await setUp(t);
    const unitId = await makeUnit(t, schoolA.teacher, schoolA, {
      subject: "Art",
    });
    const lessonId = await makeLesson(t, unitId);
    const lastWeek = await makeActivity(t, lessonId, {
      title: "Last week's sketch",
      kind: "online",
      order: 0,
      systemPrompt: "...",
    });
    const twoWeeksBack = await makeActivity(t, lessonId, {
      title: "Old sketch",
      kind: "online",
      order: 1,
      systemPrompt: "...",
    });
    await t.run((ctx) =>
      insertAssignmentWithSchedule(ctx, {
        teacherId: schoolA.teacher.id,
        unitId,
        scholarIds: [child.id],
        startedAt: NOW - 21 * 86_400_000,
        activitySchedule: [
          {
            activityId: lastWeek,
            mode: "homework" as const,
            setAt: NOW - 14 * 86_400_000,
            dueAt: dueOn("2026-10-30"),
          },
          {
            activityId: twoWeeksBack,
            mode: "homework" as const,
            setAt: NOW - 21 * 86_400_000,
            dueAt: dueOn("2026-10-23"),
          },
        ],
      }),
    );
      const titles = (
      await (await world.as.parent(parent)).query(
        api.parents.childHomeworkPlan,
        { scholarId: child.id, now: NOW },
      )
    ).items.map((item) => item.title);
    expect(titles).toContain("Last week's sketch");
    expect(titles).not.toContain("Old sketch");

    // The month calendar asks for its first row's Monday: an earlier month
    // shows its homework. A malformed day key never widens anything.
    const read = async (fromDayKey: string) =>
      (
        await (await world.as.parent(parent)).query(
          api.parents.childHomeworkPlan,
          { scholarId: child.id, now: NOW, fromDayKey },
        )
      ).items.map((item) => item.title);
    expect(await read("2026-09-28")).toContain("Old sketch");
    expect(await read("not-a-day")).not.toContain("Old sketch");
    // fromDayKey only widens: a later day never hides last week.
    expect(await read("2026-11-30")).toContain("Last week's sketch");
  });

  // TRA-620: an undated give used to stay forever, so work given in
  // September was read back to a parent in November as this week's homework.
  // It now leaves on the same window, placed by the day it was given.
  test("an undated item stays until the day it was given falls before last week", async () => {
    const t = convexTest(schema, modules);
    const { world, schoolA, parent, child } = await setUp(t);
    const unitId = await makeUnit(t, schoolA.teacher, schoolA, {
      subject: "Reading",
    });
    const lessonId = await makeLesson(t, unitId);
    // Today is Wednesday, Nov 4, so the window opens on last week's Monday,
    // Oct 26.
    const gives: Array<[string, number]> = [
      ["Given this week", givenOn("2026-11-03")],
      ["Given last Monday", givenOn("2026-10-26", 0)],
      // 11pm Sunday in Honolulu is already Monday in UTC: the school's day counts.
      ["Given the Sunday before", givenOn("2026-10-25", 23)],
      ["Given in September", givenOn("2026-09-29")],
    ];
    const activityIds = await Promise.all(
      gives.map(([title], order) =>
        makeActivity(t, lessonId, {
          title,
          kind: "online",
          order,
          systemPrompt: "...",
        }),
      ),
    );
    const assignmentId = await t.run((ctx) =>
      insertAssignmentWithSchedule(ctx, {
        teacherId: schoolA.teacher.id,
        unitId,
        scholarIds: [child.id],
        startedAt: givenOn("2026-09-29"),
        activitySchedule: gives.map(([, setAt], index) => ({
          activityId: activityIds[index],
          mode: "homework" as const,
          setAt,
        })),
      }),
    );
    const asParent = await world.as.parent(parent);
    const read = (fromDayKey?: string) =>
      asParent.query(api.parents.childHomeworkPlan, {
        scholarId: child.id,
        now: NOW,
        ...(fromDayKey ? { fromDayKey } : {}),
      });
    const undatedTitles = (plan: Awaited<ReturnType<typeof read>>) =>
      plan.items.filter((item) => item.dueAt == null).map((item) => item.title);

    const before = await read();
    expect(undatedTitles(before)).toEqual(["Given last Monday", "Given this week"]);

    // The aide reads the same default window.
    const viaAide = await t.query(internal.parents.getChildHomeworkPlan, {
      scholarId: child.id as Id<"users">,
    });
    expect(viaAide!.items).toEqual(before.items);

    // The October calendar asks from Sep 28, the Monday of the week holding
    // Oct 1: the September give is back for that month. A malformed day key
    // never widens anything.
    expect(undatedTitles(await read("2026-09-28"))).toEqual([
      "Given in September",
      "Given last Monday",
      "Given the Sunday before",
      "Given this week",
    ]);
    expect(undatedTitles(await read("not-a-day"))).toEqual(undatedTitles(before));

    // Membership still ignores what the child did: finishing every give,
    // kept or dropped, changes nothing.
    await t.run(async (ctx) => {
      for (const activityId of activityIds) {
        await ctx.db.insert("activityCompletions", {
          scholarId: child.id,
          activityId,
          lessonId,
          unitId,
          assignmentId,
          completedAt: NOW - 60_000,
        });
      }
    });
    expect(await read()).toEqual(before);
  });

  test("closures come back from last week on, from the school's calendar", async () => {
    const t = convexTest(schema, modules);
    const { world, schoolA, parent, child } = await setUp(t);
    await t.run(async (ctx) => {
      await ctx.db.insert("schoolClosures", {
        institutionId: schoolA.id,
        startDayKey: "2026-11-11",
        endDayKey: "2026-11-11",
        label: "Veterans Day",
        kind: "holiday",
      });
      await ctx.db.insert("schoolClosures", {
        institutionId: schoolA.id,
        startDayKey: "2026-10-12",
        endDayKey: "2026-10-16",
        label: "Fall Break",
        kind: "holiday",
      });
    });
    const plan = await (await world.as.parent(parent)).query(
      api.parents.childHomeworkPlan,
      { scholarId: child.id, now: NOW },
    );
    expect(plan.closures.map((c) => c.label)).toEqual(["Veterans Day"]);
  });

  test("the child's field trips come back, not another group's (TRA-601)", async () => {
    const t = convexTest(schema, modules);
    const { world, schoolA, parent, child } = await setUp(t);
    await t.run(async (ctx) => {
      const going = await ctx.db.insert("scholarGroups", {
        teacherId: schoolA.teacher.id,
        institutionId: schoolA.id,
        name: "Honu",
        scholarIds: [child.id],
      });
      const staying = await ctx.db.insert("scholarGroups", {
        teacherId: schoolA.teacher.id,
        institutionId: schoolA.id,
        name: "Manu",
        scholarIds: [],
      });
      const trip = {
        institutionId: schoolA.id,
        dayKey: "2026-11-10",
        startLocal: "09:00",
        endLocal: "12:00",
        createdBy: schoolA.teacher.id,
        updatedAt: NOW,
      };
      await ctx.db.insert("fieldTrips", { ...trip, groupIds: [going], destination: "Kualoa Ranch" });
      await ctx.db.insert("fieldTrips", { ...trip, groupIds: [staying], destination: "Bishop Museum" });
      await ctx.db.insert("fieldTrips", {
        ...trip, groupIds: [going], destination: "Waimānalo Farms", canceledAt: NOW,
      });
    });
    const plan = await (await world.as.parent(parent)).query(
      api.parents.childHomeworkPlan,
      { scholarId: child.id, now: NOW },
    );
    expect(plan.trips).toEqual([
      { dayKey: "2026-11-10", startLocal: "09:00", endLocal: "12:00", destination: "Kualoa Ranch" },
    ]);
  });

  test("another family's child at the same school is refused", async () => {
    const t = convexTest(schema, modules);
    const { world, schoolA, parent } = await setUp(t);
    const sibling = schoolA.scholars[1];
    await giveHomework(t, schoolA, sibling);
    await expect(
      (await world.as.parent(parent)).query(api.parents.childHomeworkPlan, {
        scholarId: sibling.id,
      }),
    ).rejects.toThrow(/not a guardian/);
  });

  test("a guardian at another school is refused", async () => {
    const t = convexTest(schema, modules);
    const { world, schoolB, child } = await setUp(t);
    await expect(
      (await world.as.parent(schoolB.parents[0])).query(
        api.parents.childHomeworkPlan,
        { scholarId: child.id },
      ),
    ).rejects.toThrow(/not a guardian/);
  });

  test("a parent of two children reads each child's own plan", async () => {
    const t = convexTest(schema, modules);
    const { world, schoolA, child } = await setUp(t);
    const sibling = schoolA.scholars[1];
    const parentOfBoth = await makeParent(t, [child, sibling], {
      name: "Two-Kid Parent",
    });
    const asParent = await world.as.parent(parentOfBoth);
    const childPlan = await asParent.query(api.parents.childHomeworkPlan, {
      scholarId: child.id,
    });
    const siblingPlan = await asParent.query(api.parents.childHomeworkPlan, {
      scholarId: sibling.id,
    });
    expect(childPlan.items).toHaveLength(3);
    expect(siblingPlan.items).toEqual([]);
  });

  // Review finding 1: the plate arrives sorted by lastTouched, so a plan that
  // only sorted by deadline let opening one of two same-day items reorder
  // them. Order must not move when the child starts something.
  test("opening an item never reorders the plan", async () => {
    const t = convexTest(schema, modules);
    const { world, schoolA, parent, child } = await setUp(t);
    const unitId = await makeUnit(t, schoolA.teacher, schoolA, {
      subject: "Art",
    });
    const lessonId = await makeLesson(t, unitId);
    const make = (title: string, order: number) =>
      makeActivity(t, lessonId, {
        title,
        kind: "online",
        order,
        systemPrompt: "...",
      });
    const alpha = await make("Alpha sketch", 0);
    const bravo = await make("Bravo sketch", 1);
    const undatedA = await make("Charlie collage", 2);
    const undatedB = await make("Delta collage", 3);
    const sameDue = dueOn("2026-11-06");
    const assignmentId = await t.run((ctx) =>
      insertAssignmentWithSchedule(ctx, {
        teacherId: schoolA.teacher.id,
        unitId,
        scholarIds: [child.id],
        startedAt: NOW - 86_400_000,
        activitySchedule: [
          { activityId: alpha, mode: "homework" as const, setAt: NOW - 60_000, dueAt: sameDue },
          { activityId: bravo, mode: "homework" as const, setAt: NOW - 60_000, dueAt: sameDue },
          { activityId: undatedA, mode: "homework" as const, setAt: NOW - 60_000 },
          { activityId: undatedB, mode: "homework" as const, setAt: NOW - 60_000 },
        ],
      }),
    );
      const asParent = await world.as.parent(parent);
    const titles = async () =>
      (
        await asParent.query(api.parents.childHomeworkPlan, {
          scholarId: child.id,
        })
      ).items
        .map((item) => item.title)
        .filter((title) => /sketch|collage/.test(title));

    const before = await titles();
    expect(before).toEqual([
      "Alpha sketch",
      "Bravo sketch",
      "Charlie collage",
      "Delta collage",
    ]);
    const asChild = await world.as.scholar(child);
    for (const activityId of [bravo, undatedB]) {
      vi.advanceTimersByTime(60_000);
      await asChild.mutation(api.sessions.create, { activityId, assignmentId });
    }
    expect(await titles()).toEqual(before);
  });

  // Review finding 2: plan membership must not depend on whether the child
  // started the work. Re-pushing an activity to another scholar keeps a
  // STARTED copy on the child's own list (lib/homeOrigin.ts startedWorkMode),
  // but the parent plan follows the live push alone.
  test("membership follows the live push, never whether the child started", async () => {
    const t = convexTest(schema, modules);
    const { world, schoolA, schoolB, child, work } = await setUp(t);
    const other = schoolA.scholars[1];
    await t.run((ctx) =>
      ctx.db.patch(work.assignmentId, { scholarIds: [child.id, other.id] }),
    );
    const sibling = await makeParent(t, [other], { name: "Other Parent" });
    const parentOfChild = await makeParent(t, [child], {
      name: "Child Parent",
    });

    // The child starts "Moon journal"; the other scholar never does.
    await (await world.as.scholar(child)).mutation(api.sessions.create, {
      activityId: work.thisWeek,
      assignmentId: work.assignmentId,
    });

    // The teacher re-pushes "Moon journal" to a third scholar only: neither
    // of these two has a live push for it any more.
    const third = schoolB.scholars[0];
    await t.run(async (ctx) => {
      const schedule = await readSchedule(ctx, { _id: work.assignmentId });
      await setSchedule(
        ctx,
        work.assignmentId,
        schedule.map((entry) =>
          entry.activityId === work.thisWeek
            ? { ...entry, scholarIds: [third.id] }
            : entry,
        ),
      );
    });
  
    const planTitles = async (
      parent: Awaited<ReturnType<typeof makeParent>>,
      scholarId: Id<"users">,
    ) =>
      (
        await (await world.as.parent(parent)).query(
          api.parents.childHomeworkPlan,
          { scholarId },
        )
      ).items.map((item) => item.title);

    const started = await planTitles(parentOfChild, child.id);
    const neverStarted = await planTitles(sibling, other.id);
    expect(started).toEqual(neverStarted);
    expect(started).not.toContain("Moon journal");

    // The child's own list is unchanged: their started copy stays on it.
    const childRows = (
      await (await world.as.scholar(child)).query(
        api.scholarPlate.activeForMe,
        { includeWebActivities: true },
      )
    ).rows.filter((row) => row.origin === "homework");
    expect(childRows.map((row) => row.title)).toContain("Moon journal");
  });

  test("the aide's internal read returns the same plan", async () => {
    const t = convexTest(schema, modules);
    const { world, parent, child } = await setUp(t);
    const viaPortal = await (await world.as.parent(parent)).query(
      api.parents.childHomeworkPlan,
      { scholarId: child.id },
    );
    const viaAide = await t.query(internal.parents.getChildHomeworkPlan, {
      scholarId: child.id as Id<"users">,
    });
    expect(viaAide).toEqual({
      timeZone: viaPortal.timeZone,
      items: viaPortal.items,
    });
  });
});
