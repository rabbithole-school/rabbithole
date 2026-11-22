// The grid's actions are give actions (TRA-582): give to a class meeting,
// move a planned give between this group's meetings, to the All day row or to
// the Homework due row, and "Up next" derived from what the class was given.
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import schema from "../schema";
import { api, internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import {
  identityFor,
  makeActivity,
  makeLesson,
  makeStaff,
  makeUnit,
  makeWorld,
} from "./factories/world";
import {
  CLASS_ALREADY_MET,
  LINK_MISMATCH,
  NOT_THIS_GROUP,
  NO_MEETING_THAT_DAY,
  ONLY_PLANNED_MOVES,
  OUTSIDE_TERM,
} from "../gridGiveActions";
import { NOT_YOUR_GIVE } from "../assignments";
import { NOT_A_PRACTICE_SKILL } from "../lib/skillPractice";
import { WHOLE_NUMBER_ARITHMETIC_DOMAIN } from "../seed/wholeNumberArithmeticGraph";
import { dayEndForDayKey } from "../../shared/institutionDay";
import { isOpenUntil } from "../../shared/openUntil";
import { writeSchedule } from "../lib/scheduleStore";
import { coreGrid } from "../masterSchedule";
import { gridGivesFor } from "../lib/gridGives";

const modules = (
  import.meta as ImportMeta & {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("../**/*.ts");

const timeZone = "Pacific/Honolulu";
const monday = "2026-11-09";
const tuesday = "2026-11-10";
const thursday = "2026-11-12";
const at = (clock: string, day = tuesday) =>
  Date.parse(`${day}T${clock}:00-10:00`);
const weekStartMs = at("00:00", monday);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(at("07:00", monday));
});
afterEach(() => vi.useRealTimers());

async function setup() {
  const t = convexTest(schema, modules);
  const world = await makeWorld(t, { schools: 1, parentsPerSchool: 0 });
  const school = world.schools[0];
  const teacher = await world.as.staffOf(school);
  const otherTeacher = await world.as.staffOf(school, "school_admin");
  const unitId = await makeUnit(t, school.teacher, school, { title: "Tide pools" });
  const lessonId = await makeLesson(t, unitId);
  const first = await makeActivity(t, lessonId, { title: "Map the pool", order: 0 });
  const second = await makeActivity(t, lessonId, { title: "Count the snails", order: 1 });
  const ids = await t.run(async (ctx) => {
    await ctx.db.patch(school.id, { timeZone });
    const groupId = await ctx.db.insert("scholarGroups", {
      institutionId: school.id,
      teacherId: school.teacher.id,
      name: "Tide pool group",
      scholarIds: school.scholars.map((s) => s.id),
    });
    const otherGroupId = await ctx.db.insert("scholarGroups", {
      institutionId: school.id,
      teacherId: school.teacher.id,
      name: "Reef group",
      scholarIds: [school.scholars[0].id],
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
    return { groupId, otherGroupId, periodId, morning, afternoon };
  });
  const place = (groupId: Id<"scholarGroups">, blockId: Id<"scheduleBlocks">, weekday: number, subject: string) =>
    teacher.mutation(api.masterSchedule.placeClass, {
      periodId: ids.periodId, groupId, blockId, weekday, subject,
      teacherId: school.teacher.id,
    });
  await place(ids.groupId, ids.morning, 1, "Humanities");
  await place(ids.groupId, ids.morning, 2, "Humanities");
  await place(ids.groupId, ids.afternoon, 4, "Science");
  await place(ids.otherGroupId, ids.afternoon, 2, "Reef studies");
  const classes = await t.run((ctx) => ctx.db.query("classes").collect());
  const classFor = (subject: string) => classes.find((c) => c.subject === subject)!._id;
  const grid = () =>
    teacher.query(api.masterSchedule.grid, { periodId: ids.periodId, weekStartMs });
  const pushes = () => t.run((ctx) => ctx.db.query("pushes").collect());
  return {
    t, school, teacher, otherTeacher, unitId, first, second, grid, pushes, classFor, ...ids,
  };
}

describe("giveToClass", () => {
  test("gives to that class's meeting, finishing in class, and Up next moves on", async () => {
    const w = await setup();
    const humanities = w.classFor("Humanities");
    // Nothing given yet: no unit, no Up next.
    expect((await w.grid()).classMeetings.every((m) => m.upNext === null)).toBe(true);

    await w.teacher.mutation(api.gridGiveActions.giveToClass, {
      classId: humanities, dayKey: tuesday, work: { kind: "activity", activityId: w.first },
    });
    const [push] = await w.pushes();
    expect(push).toMatchObject({
      classId: humanities, dayKey: tuesday,
      startsAt: at("09:00"), endsAt: at("10:15"), afterEnd: "fade",
    });
    expect(push.setAt).toBeUndefined();

    const grid = await w.grid();
    expect(grid.gives).toEqual([
      expect.objectContaining({ place: "class", weekday: 2, activityId: w.first, movable: true }),
    ]);
    const meeting = grid.classMeetings.find((m) => m.classId === humanities && m.weekday === 1);
    expect(meeting?.upNext).toMatchObject({ activityId: w.second, unitTitle: "Tide pools" });
  });

  test("refuses a meeting that has ended and a day the class doesn't meet", async () => {
    const w = await setup();
    vi.setSystemTime(at("11:00", monday));
    await expect(
      w.teacher.mutation(api.gridGiveActions.giveToClass, {
        classId: w.classFor("Humanities"), dayKey: monday, work: { kind: "activity", activityId: w.first },
      }),
    ).rejects.toThrow(CLASS_ALREADY_MET);
    await expect(
      w.teacher.mutation(api.gridGiveActions.giveToClass, {
        classId: w.classFor("Humanities"), dayKey: thursday, work: { kind: "activity", activityId: w.first },
      }),
    ).rejects.toThrow(NO_MEETING_THAT_DAY);
  });

  test("a class under way gets the work now", async () => {
    const w = await setup();
    vi.setSystemTime(at("09:20", monday));
    await w.teacher.mutation(api.gridGiveActions.giveToClass, {
      classId: w.classFor("Humanities"), dayKey: monday, work: { kind: "activity", activityId: w.first },
    });
    const [push] = await w.pushes();
    expect(push).toMatchObject({ setAt: at("09:20", monday), endsAt: at("10:15", monday) });
  });
});

describe("moveGive", () => {
  async function planned() {
    const w = await setup();
    await w.teacher.mutation(api.gridGiveActions.giveToClass, {
      classId: w.classFor("Humanities"), dayKey: tuesday, work: { kind: "activity", activityId: w.first },
    });
    const [push] = await w.pushes();
    return { ...w, pushId: push._id };
  }

  test("onto another class of the group: re-timed to that meeting and relinked", async () => {
    const w = await planned();
    await w.teacher.mutation(api.gridGiveActions.moveGive, {
      pushId: w.pushId,
      to: { kind: "class", classId: w.classFor("Science"), dayKey: thursday },
    });
    const open = (await w.pushes()).filter((p) => p.clearedAt === undefined);
    expect(open).toEqual([
      expect.objectContaining({
        classId: w.classFor("Science"), dayKey: thursday,
        startsAt: at("13:00", thursday), endsAt: at("14:30", thursday),
      }),
    ]);
  });

  test("onto the All day row: no class, covers the day", async () => {
    const w = await planned();
    await w.teacher.mutation(api.gridGiveActions.moveGive, {
      pushId: w.pushId, to: { kind: "allDay", dayKey: thursday },
    });
    const open = (await w.pushes()).filter((p) => p.clearedAt === undefined);
    expect(open).toHaveLength(1);
    expect(open[0].classId).toBeUndefined();
    expect(open[0].startsAt).toBe(at("00:00", thursday));
    expect((await w.grid()).gives).toEqual([
      expect.objectContaining({ place: "allDay", weekday: 4 }),
    ]);
  });

  test("onto the Homework due row: due that day, still shows up when planned", async () => {
    const w = await planned();
    await w.teacher.mutation(api.gridGiveActions.moveGive, {
      pushId: w.pushId, to: { kind: "homework", dayKey: thursday },
    });
    const open = (await w.pushes()).filter((p) => p.clearedAt === undefined);
    expect(open).toEqual([
      expect.objectContaining({
        timing: { kind: "homework" }, afterEnd: "late", startsAt: at("09:00"),
      }),
    ]);
    expect(open[0].endsAt).toBeGreaterThan(at("14:30", thursday));
  });

  describe("a planned open-until give keeps its closing day", () => {
    async function openUntil(closeDay: string) {
      const w = await setup();
      const assignmentId = await w.teacher.mutation(api.assignments.create, {
        unitId: w.unitId, scholarIds: w.school.scholars.map((s) => s.id),
      });
      await w.teacher.mutation(api.assignments.scheduleActivity, {
        assignmentId,
        activityId: w.first,
        startsAt: at("09:30"),
        finish: { kind: "openUntil", dayKey: closeDay },
      });
      const [push] = await w.pushes();
      expect(isOpenUntil({ mode: "classFocus", ...push }, timeZone)).toBe(true);
      return { ...w, push };
    }

    test("moved to an earlier day's class: re-timed and relinked, same end, still open-until", async () => {
      const w = await openUntil("2026-11-13");
      await w.teacher.mutation(api.gridGiveActions.moveGive, {
        pushId: w.push._id,
        to: { kind: "class", classId: w.classFor("Science"), dayKey: thursday },
      });
      const open = (await w.pushes()).filter((p) => p.clearedAt === undefined);
      expect(open).toHaveLength(1);
      expect(open[0]).toMatchObject({
        classId: w.classFor("Science"), dayKey: thursday,
        startsAt: at("13:00", thursday), endsAt: w.push.endsAt,
        // The drag keeps the stored finish (TRA-726).
        timing: { kind: "openUntil" },
      });
      expect(isOpenUntil({ mode: "classFocus", ...open[0] }, timeZone)).toBe(true);
    });

    test("a closing time before the end of its day is kept exactly", async () => {
      const w = await setup();
      const assignmentId = await w.teacher.mutation(api.assignments.create, {
        unitId: w.unitId, scholarIds: w.school.scholars.map((s) => s.id),
      });
      // An older or aide-made row that closes at 11 pm Friday.
      await w.t.run((ctx) => writeSchedule(ctx, assignmentId, [{
        activityId: w.first, mode: "classFocus",
        startsAt: at("09:30"), endsAt: at("23:00", "2026-11-13"), scholarIds: [],
      }]));
      const [push] = await w.pushes();
      await w.teacher.mutation(api.gridGiveActions.moveGive, {
        pushId: push._id,
        to: { kind: "class", classId: w.classFor("Science"), dayKey: thursday },
      });
      const [open] = (await w.pushes()).filter((p) => p.clearedAt === undefined);
      expect(open).toMatchObject({
        startsAt: at("13:00", thursday), endsAt: at("23:00", "2026-11-13"),
      });
    });

    test("moved to the All day row: starts that day, same end", async () => {
      const w = await openUntil("2026-11-13");
      await w.teacher.mutation(api.gridGiveActions.moveGive, {
        pushId: w.push._id, to: { kind: "allDay", dayKey: thursday },
      });
      const [open] = (await w.pushes()).filter((p) => p.clearedAt === undefined);
      expect(open).toMatchObject({ startsAt: at("00:00", thursday), endsAt: w.push.endsAt });
      expect(isOpenUntil({ mode: "classFocus", ...open }, timeZone)).toBe(true);
    });

    test("moved onto its closing day: allowed, still open until then (TRA-726)", async () => {
      const w = await openUntil(thursday);
      await w.teacher.mutation(api.gridGiveActions.moveGive, {
        pushId: w.push._id,
        to: { kind: "class", classId: w.classFor("Science"), dayKey: thursday },
      });
      const [open] = (await w.pushes()).filter((p) => p.clearedAt === undefined);
      expect(open).toMatchObject({
        startsAt: at("13:00", thursday), endsAt: w.push.endsAt, timing: { kind: "openUntil" },
      });
      expect(isOpenUntil({ mode: "classFocus", ...open, openUntilKind: true }, timeZone)).toBe(true);
    });

    test("moved past its closing day: refused in a sentence, nothing changes", async () => {
      const w = await openUntil(thursday);
      const before = await w.pushes();
      const refusal = "This is open until Thu, Nov 12, so it can't start after that. Move it to that day or earlier, or change the closing day from the Run page.";
      await expect(w.teacher.mutation(api.gridGiveActions.moveGive, {
        pushId: w.push._id, to: { kind: "allDay", dayKey: "2026-11-13" },
      })).rejects.toThrow(refusal);
      expect(await w.pushes()).toEqual(before);
    });
  });

  test("refuses another group's class, a live give, and someone else's give", async () => {
    const w = await planned();
    await expect(
      w.teacher.mutation(api.gridGiveActions.moveGive, {
        pushId: w.pushId,
        to: { kind: "class", classId: w.classFor("Reef studies"), dayKey: tuesday },
      }),
    ).rejects.toThrow(NOT_THIS_GROUP);
    // Another teacher at the school. (A school admin may move it: see
    // assignmentAdminAuthority.test.ts.)
    const colleague = await identityFor(
      w.t,
      (await makeStaff(w.t, w.school, "teacher")).id,
    );
    await expect(
      colleague.mutation(api.gridGiveActions.moveGive, {
        pushId: w.pushId,
        to: { kind: "class", classId: w.classFor("Science"), dayKey: thursday },
      }),
    ).rejects.toThrow(NOT_YOUR_GIVE);
    await w.t.run((ctx) => ctx.db.patch(w.pushId, { setAt: at("09:00") }));
    await expect(
      w.teacher.mutation(api.gridGiveActions.moveGive, {
        pushId: w.pushId,
        to: { kind: "class", classId: w.classFor("Science"), dayKey: thursday },
      }),
    ).rejects.toThrow(ONLY_PLANNED_MOVES);
  });
});

describe("Up next across assignments", () => {
  const upNextOf = async (w: Awaited<ReturnType<typeof setup>>, subject: string, weekday: number) =>
    (await w.grid()).classMeetings.find(
      (m) => m.classId === w.classFor(subject) && m.weekday === weekday,
    )?.upNext ?? null;

  test("a roster change doesn't send Up next back to the first activity", async () => {
    const w = await setup();
    const everyone = w.school.scholars.map((s) => s.id);
    expect(everyone.length).toBeGreaterThan(1);
    await w.t.run((ctx) => ctx.db.patch(w.groupId, { scholarIds: everyone.slice(0, -1) }));
    await w.teacher.mutation(api.gridGiveActions.giveToClass, {
      classId: w.classFor("Humanities"), dayKey: tuesday, work: { kind: "activity", activityId: w.first },
    });
    // A scholar joins: the next give makes a new assignment for the new roster.
    await w.t.run((ctx) => ctx.db.patch(w.groupId, { scholarIds: everyone }));
    expect(await upNextOf(w, "Humanities", 1)).toMatchObject({ activityId: w.second });
    await w.teacher.mutation(api.gridGiveActions.giveToClass, {
      classId: w.classFor("Humanities"), dayKey: monday, work: { kind: "activity", activityId: w.second },
    });
    expect(await upNextOf(w, "Humanities", 1)).toBeNull();
  });

  test("work a shared assignment gave another group's scholars isn't given here", async () => {
    const w = await setup();
    const [reefScholar, ...others] = w.school.scholars.map((s) => s.id);
    // One Run-page assignment for everyone. It gave the second activity to
    // the Reef scholar in Reef studies, and the first to the others only.
    const shared = await w.teacher.mutation(api.assignments.create, {
      unitId: w.unitId, scholarIds: w.school.scholars.map((s) => s.id),
    });
    const give = (activityId: typeof w.first, scholarIds: typeof others, extra = {}) =>
      w.t.run((ctx) =>
        ctx.db.insert("pushes", {
          institutionId: w.school.id,
          target: { kind: "activity", activityId },
          audience: { kind: "scholars", scholarIds },
          timing: { kind: "untilCleared" },
          afterEnd: "fade",
          blocking: false,
          setAt: at("08:00", monday),
          assignmentId: shared,
          scheduleMirror: true,
          pushedBy: w.school.teacher.id,
          ...extra,
        }),
      );
    await give(w.first, others);
    await give(w.second, [reefScholar], { classId: w.classFor("Reef studies"), dayKey: tuesday });
    expect(reefScholar).toBeDefined();
    const reef = (await w.grid()).classMeetings.find((m) => m.classId === w.classFor("Reef studies"));
    expect(reef?.upNext).toMatchObject({ activityId: w.first });
  });
});

describe("drops that can't land where asked", () => {
  test("a day outside the class's term is refused", async () => {
    const w = await setup();
    await w.t.run((ctx) => ctx.db.patch(w.periodId, { endsAt: at("00:00", thursday) }));
    await expect(
      w.teacher.mutation(api.gridGiveActions.giveToClass, {
        classId: w.classFor("Science"), dayKey: thursday, work: { kind: "activity", activityId: w.first },
      }),
    ).rejects.toThrow(OUTSIDE_TERM);
  });

  test("a give that would link to no class is refused, and nothing is written", async () => {
    const w = await setup();
    // A second group with the same scholars meets at the same time, so the
    // give's time can't say which class it belongs to.
    const twin = await w.t.run((ctx) =>
      ctx.db.insert("scholarGroups", {
        institutionId: w.school.id,
        teacherId: w.school.teacher.id,
        name: "Twin group",
        scholarIds: w.school.scholars.map((s) => s.id),
      }),
    );
    await w.teacher.mutation(api.masterSchedule.placeClass, {
      periodId: w.periodId, groupId: twin, blockId: w.morning, weekday: 2,
      subject: "Art", teacherId: w.school.teacher.id,
    });
    await expect(
      w.teacher.mutation(api.gridGiveActions.giveToClass, {
        classId: w.classFor("Humanities"), dayKey: tuesday, work: { kind: "activity", activityId: w.first },
      }),
    ).rejects.toThrow(LINK_MISMATCH);
    expect(await w.pushes()).toEqual([]);
  });
});

describe("Up next reads", () => {
  test("an old finished give still counts as given", async () => {
    const w = await setup();
    await w.teacher.mutation(api.gridGiveActions.giveToClass, {
      classId: w.classFor("Humanities"), dayKey: tuesday, work: { kind: "activity", activityId: w.second },
    });
    // The first activity went out months ago, on another assignment, and ended.
    const old = await w.teacher.mutation(api.assignments.create, {
      unitId: w.unitId, scholarIds: w.school.scholars.map((s) => s.id),
    });
    await w.t.run((ctx) =>
      ctx.db.insert("pushes", {
        institutionId: w.school.id,
        target: { kind: "activity", activityId: w.first },
        audience: { kind: "assignment", assignmentId: old },
        timing: { kind: "untilCleared" },
        afterEnd: "fade",
        blocking: false,
        setAt: at("09:00", "2026-08-20"),
        clearedAt: at("15:00", "2026-08-20"),
        clearedReason: "expired",
        assignmentId: old,
        scheduleMirror: true,
        pushedBy: w.school.teacher.id,
      }),
    );
    const meetings = (await w.grid()).classMeetings.filter(
      (m) => m.classId === w.classFor("Humanities"),
    );
    expect(meetings.length).toBeGreaterThan(0);
    expect(meetings.every((m) => m.upNext === null)).toBe(true);
  });

  test("the program grid's option derives no Up next", async () => {
    const w = await setup();
    await w.teacher.mutation(api.gridGiveActions.giveToClass, {
      classId: w.classFor("Humanities"), dayKey: tuesday, work: { kind: "activity", activityId: w.first },
    });
    const [teacherView, programView] = await w.t.run(async (ctx) => {
      const grid = await coreGrid(ctx, w.periodId, at("00:00", monday));
      return [
        await gridGivesFor(ctx, w.periodId, grid, { withUpNext: true }),
        await gridGivesFor(ctx, w.periodId, grid, { withUpNext: false, cardsDrawn: true }),
      ];
    });
    expect(teacherView.classMeetings.some((m) => m.upNext?.activityId === w.second)).toBe(true);
    expect(programView.classMeetings.length).toBe(teacherView.classMeetings.length);
    expect(programView.classMeetings.every((m) => m.upNext === null)).toBe(true);
  });
});

describe("removing a block (the shelf retired for work)", () => {
  test("its classes lose their day, its work placements go, and their gives stay", async () => {
    const w = await setup();
    await w.teacher.mutation(api.gridGiveActions.giveToClass, {
      classId: w.classFor("Humanities"), dayKey: tuesday, work: { kind: "activity", activityId: w.first },
    });
    const legacyCard = await w.t.run((ctx) =>
      ctx.db.insert("schedulePlacements", {
        periodId: w.periodId, groupId: w.groupId, weekday: 2, blockId: w.morning,
        subject: "Humanities", assignmentId: undefined, activityId: w.second,
      }),
    );
    const moved = await w.otherTeacher.mutation(api.masterSchedule.removeBlock, {
      blockId: w.morning,
    });
    expect(moved).toBe(2); // Humanities' Monday and Tuesday class rows
    const rows = await w.t.run((ctx) => ctx.db.query("schedulePlacements").collect());
    expect(rows.some((r) => r._id === legacyCard)).toBe(false);
    expect(
      rows.filter((r) => r.subject === "Humanities").every((r) => r.weekday === undefined),
    ).toBe(true);
    const open = (await w.pushes()).filter((p) => p.clearedAt === undefined);
    expect(open).toEqual([expect.objectContaining({ target: { kind: "activity", activityId: w.first } })]);
  });
});

describe("giveToClass arguments", () => {
  test("work is required, and the old activityId argument is gone", async () => {
    const w = await setup();
    const classId = w.classFor("Humanities");
    await expect(
      w.teacher.mutation(api.gridGiveActions.giveToClass, { classId, dayKey: tuesday } as never),
    ).rejects.toThrow(/work/);
    await expect(
      w.teacher.mutation(api.gridGiveActions.giveToClass, {
        classId, dayKey: tuesday, activityId: w.first,
      } as never),
    ).rejects.toThrow(/Validator/);
    expect(await w.pushes()).toEqual([]);
  });
});

// A math skill is givable work too (TRA-582): it rides a practice pair (a
// lesson-less one-skill problem set + an ad-hoc assignment), never a card.
describe("giving a math skill", () => {
  async function withSkill(w: Awaited<ReturnType<typeof setup>>) {
    await w.t.run(async (ctx) => {
      await ctx.db.insert("knowledgeNodes", {
        nodeKey: "fraction_add_like",
        label: "Add fractions with like denominators",
        domain: WHOLE_NUMBER_ARITHMETIC_DOMAIN,
      });
      await ctx.db.insert("knowledgeNodes", {
        nodeKey: "history_of_zero",
        label: "History of zero",
        domain: "history",
      });
    });
  }

  test("gives the skill to the class that day and reuses one pair across days", async () => {
    const w = await setup();
    await withSkill(w);
    const skill = { kind: "skill" as const, nodeKey: "fraction_add_like" };
    const firstId = await w.teacher.mutation(api.gridGiveActions.giveToClass, {
      classId: w.classFor("Humanities"), dayKey: monday, work: skill,
    });
    const secondId = await w.teacher.mutation(api.gridGiveActions.giveToClass, {
      classId: w.classFor("Humanities"), dayKey: tuesday, work: skill,
    });
    expect(secondId).toBe(firstId);
    const { assignment, activities, placements } = await w.t.run(async (ctx) => ({
      assignment: await ctx.db.get(firstId),
      activities: await ctx.db.query("activities").collect(),
      placements: await ctx.db.query("schedulePlacements").collect(),
    }));
    expect(assignment).toMatchObject({
      kind: "adHocDispatch",
      title: "Add fractions with like denominators",
      scholarIds: w.school.scholars.map((s) => s.id),
    });
    const pair = activities.filter((a) => a.kind === "problem_set");
    expect(pair).toHaveLength(1);
    expect(pair[0]).toMatchObject({
      problemSet: { domain: WHOLE_NUMBER_ARITHMETIC_DOMAIN, targetSkillKeys: ["fraction_add_like"] },
    });
    // No activity card: only the classes' own rows.
    expect(placements.every((p) => p.activityId === undefined)).toBe(true);
    const open = (await w.pushes()).filter((p) => p.clearedAt === undefined);
    expect(open).toEqual([
      expect.objectContaining({
        target: { kind: "activity", activityId: pair[0]._id },
        classId: w.classFor("Humanities"),
      }),
    ]);
  });

  test("a node without targeted practice is refused", async () => {
    const w = await setup();
    await withSkill(w);
    await expect(
      w.teacher.mutation(api.gridGiveActions.giveToClass, {
        classId: w.classFor("Humanities"), dayKey: tuesday,
        work: { kind: "skill", nodeKey: "history_of_zero" },
      }),
    ).rejects.toThrow(NOT_A_PRACTICE_SKILL);
  });
});

describe("giveHomework", () => {
  const homeworkGive = async (w: Awaited<ReturnType<typeof setup>>) =>
    (await w.pushes()).filter((p) => p.clearedAt === undefined && p.timing.kind === "homework");

  test("this week's homework shows up now, links its class but no day, and is due that day", async () => {
    const w = await setup();
    await w.teacher.mutation(api.gridGiveActions.giveHomework, {
      classId: w.classFor("Humanities"), dueDayKey: thursday,
      work: { kind: "activity", activityId: w.first },
    });
    const [give] = await homeworkGive(w);
    expect(give).toMatchObject({
      classId: w.classFor("Humanities"),
      endsAt: dayEndForDayKey(thursday, timeZone),
    });
    expect(give.dayKey).toBeUndefined();
    expect(give.setAt).toBeDefined();
    const placements = await w.t.run((ctx) => ctx.db.query("schedulePlacements").collect());
    expect(placements.every((p) => p.activityId === undefined)).toBe(true);
  });

  test("next week's homework shows up at the start of that school week", async () => {
    const w = await setup();
    await w.teacher.mutation(api.gridGiveActions.giveHomework, {
      classId: w.classFor("Science"), dueDayKey: "2026-11-19",
      work: { kind: "activity", activityId: w.first },
    });
    const [give] = await homeworkGive(w);
    expect(give).toMatchObject({
      classId: w.classFor("Science"),
      startsAt: at("00:00", "2026-11-16"),
    });
    expect(give.setAt).toBeUndefined();
  });

  test("a day that has passed is refused", async () => {
    const w = await setup();
    await expect(
      w.teacher.mutation(api.gridGiveActions.giveHomework, {
        classId: w.classFor("Humanities"), dueDayKey: "2026-11-06",
        work: { kind: "activity", activityId: w.first },
      }),
    ).rejects.toThrow(/has passed/);
  });
});

// The aide's place_class with work gives to the class meeting in that cell.
describe("aideGiveToClass", () => {
  test("finds the class meeting in the cell and gives to it", async () => {
    const w = await setup();
    await w.t.mutation(internal.gridGiveActions.aideGiveToClass, {
      callerUserId: w.school.teacher.id,
      periodId: w.periodId, groupId: w.groupId, blockId: w.morning,
      dayKey: tuesday, activityId: w.first, finish: "inClass",
    });
    const open = (await w.pushes()).filter((p) => p.clearedAt === undefined);
    expect(open).toEqual([
      expect.objectContaining({
        classId: w.classFor("Humanities"), dayKey: tuesday, startsAt: at("09:00"),
      }),
    ]);
  });

  test("by the end of that day is homework for that class", async () => {
    const w = await setup();
    await w.t.mutation(internal.gridGiveActions.aideGiveToClass, {
      callerUserId: w.school.teacher.id,
      periodId: w.periodId, groupId: w.groupId, blockId: w.morning,
      dayKey: tuesday, activityId: w.first, finish: "endOfDay",
    });
    const [give] = (await w.pushes()).filter((p) => p.clearedAt === undefined);
    expect(give).toMatchObject({
      classId: w.classFor("Humanities"),
      timing: { kind: "homework" },
      endsAt: dayEndForDayKey(tuesday, timeZone),
    });
    expect(give.dayKey).toBeUndefined();
  });

  test("a cell where the group has no class that day is refused", async () => {
    const w = await setup();
    await expect(
      w.t.mutation(internal.gridGiveActions.aideGiveToClass, {
        callerUserId: w.school.teacher.id,
        periodId: w.periodId, groupId: w.groupId, blockId: w.afternoon,
        dayKey: tuesday, activityId: w.first, finish: "inClass",
      }),
    ).rejects.toThrow(NO_MEETING_THAT_DAY);
    expect(await w.pushes()).toEqual([]);
  });
});
