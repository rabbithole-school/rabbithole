import { convexTest, type TestConvex } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import schema from "../schema";
import { api } from "../_generated/api";
import type { ActionCtx } from "../_generated/server";
import type { Id } from "../_generated/dataModel";
import { makeAssignmentTools } from "../lib/assignmentTools";
import { homeworkClassFields } from "../lib/classLink";
import { schoolDayEndAt } from "../lib/schoolDays";
import {
  seedScholarInInstitution,
  seedStaffWithMembership,
  seedTestInstitution,
} from "./institutionTestHelpers";

/**
 * The Schedule tab's Homework view (TRA-581) reads homework gives by group
 * and school week: the class subject labels it (the family tab's resolver),
 * planned work shows as planned, a give reaching two groups is in both rows,
 * only this term's classes make rows, and another school's groups never
 * appear. The end-to-end case runs the aide's `give` with nextWeekHomework
 * and finds the give in the planner, linked to its class.
 */

const modules = (
  import.meta as ImportMeta & {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("../**/*.ts");

const TIME_ZONE = "Pacific/Honolulu";
// Tuesday 2026-11-10, 8am in Honolulu: this school week is Nov 9–13.
const TODAY = "2026-11-10";
const hst = (dayKey: string, hhmm: string) =>
  Date.parse(`${dayKey}T${hhmm}:00.000-10:00`);
const NOW = hst(TODAY, "08:00");

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

type T = TestConvex<typeof schema>;

async function withUser(t: T, userId: Id<"users">) {
  const sessionId = await t.run((ctx) =>
    ctx.db.insert("authSessions", {
      userId,
      expirationTime: NOW + 3_600_000,
    }),
  );
  return t.withIdentity({
    subject: `${userId}|${sessionId}`,
    issuer: "https://convex.dev",
  });
}

function actionCtxFor(t: T): ActionCtx {
  return {
    runQuery: (ref: unknown, args: unknown) =>
      (t as unknown as { query: (r: unknown, a: unknown) => Promise<unknown> }).query(ref, args),
    runMutation: (ref: unknown, args: unknown) =>
      (t as unknown as { mutation: (r: unknown, a: unknown) => Promise<unknown> }).mutation(ref, args),
  } as unknown as ActionCtx;
}

async function seedSchool(t: T, slug: string) {
  const institutionId = await seedTestInstitution(t, { slug, name: `${slug} School` });
  await t.run((ctx) => ctx.db.patch(institutionId, { timeZone: TIME_ZONE }));
  const teacher = await seedStaffWithMembership(t, {
    institutionId,
    name: "Avery Stone",
    username: `avery-${slug}`,
  });
  const scholar = (name: string, username: string) =>
    seedScholarInInstitution(t, { institutionId, name, username: `${username}-${slug}` });
  const hoku = await scholar("Hoku Makani", "hoku");
  const lehua = await scholar("Lehua Torres", "lehua");
  const sloane = await scholar("Sloane Kahale", "sloane");
  return t.run(async (ctx) => {
    const termId = await ctx.db.insert("reportingPeriods", {
      label: "Fall 2026",
      startsAt: hst("2026-08-17", "00:00"),
      endsAt: hst("2026-12-18", "00:00"),
      status: "open",
      institutionId,
    });
    const lastTermId = await ctx.db.insert("reportingPeriods", {
      label: "Spring 2026",
      startsAt: hst("2026-01-05", "00:00"),
      endsAt: hst("2026-05-29", "00:00"),
      status: "closed",
      institutionId,
    });
    const honu = await ctx.db.insert("scholarGroups", {
      teacherId: teacher,
      institutionId,
      name: "Honu",
      scholarIds: [hoku, lehua],
    });
    const pueo = await ctx.db.insert("scholarGroups", {
      teacherId: teacher,
      institutionId,
      name: "Pueo",
      scholarIds: [sloane],
    });
    // Only had classes last term: no row.
    const oldGroup = await ctx.db.insert("scholarGroups", {
      teacherId: teacher,
      institutionId,
      name: "Manu",
      scholarIds: [sloane],
    });
    const blockId = await ctx.db.insert("scheduleBlocks", {
      periodId: termId,
      key: "blockA",
      label: "Block A",
      startLocal: "09:00",
      endLocal: "10:15",
      weekdays: [1, 2, 3, 4, 5],
      order: 0,
      kind: "class",
    });
    const klass = (
      periodId: Id<"reportingPeriods">,
      groupId: Id<"scholarGroups">,
      subject: string,
      meetings: Array<{ weekday: number; blockId: Id<"scheduleBlocks"> }> = [],
    ) =>
      ctx.db.insert("classes", {
        institutionId,
        periodId,
        groupId,
        subject,
        subjectKey: subject.toLowerCase(),
        meetings,
      });
    const mathClass = await klass(termId, honu, "Math");
    const readingGroup = await ctx.db.insert("scholarGroups", {
      teacherId: teacher,
      institutionId,
      name: "Reading circle",
      scholarIds: [hoku, sloane],
    });
    // Science meets Tuesdays in Block A.
    const scienceClass = await klass(termId, honu, "Science", [{ weekday: 2, blockId }]);
    const humanitiesClass = await klass(termId, pueo, "Humanities");
    await klass(lastTermId, oldGroup, "Art");

    const unitId = await ctx.db.insert("units", {
      teacherId: teacher,
      institutionId,
      title: "Tide Pools",
      subject: "Science",
      isActive: true,
    });
    const lessonId = await ctx.db.insert("lessons", { unitId, title: "Observing", order: 0 });
    const activity = (title: string, order: number) =>
      ctx.db.insert("activities", { lessonId, title, kind: "online", systemPrompt: "...", order });
    const fractions = await activity("Fraction strips", 0);
    const notes = await activity("Field notes", 1);
    const focusWork = await activity("Share-out", 2);
    const later = await activity("Winter reading", 3);
    const both = await activity("Reef survey", 4);
    await activity("Tide journal", 5);
    const assignmentId = await ctx.db.insert("assignments", {
      teacherId: teacher,
      unitId,
      scholarIds: [hoku, lehua],
      startedAt: NOW,
    });
    const give = (activityId: Id<"activities">, extra: Record<string, unknown>) =>
      ctx.db.insert("pushes", {
        institutionId,
        target: { kind: "activity", activityId },
        audience: { kind: "assignment", assignmentId },
        timing: { kind: "homework" },
        blocking: false,
        pushedBy: teacher,
        assignmentId,
        afterEnd: "late" as const,
        ...extra,
      });
    // This week, in the Math class, live.
    await give(fractions, {
      classId: mathClass,
      endsAt: schoolDayEndAt("2026-11-13", TIME_ZONE),
      setAt: NOW,
    });
    // Next week, no class: the unit's subject; one scholar; planned.
    await give(notes, {
      audience: { kind: "scholars", scholarIds: [hoku] },
      endsAt: schoolDayEndAt("2026-11-20", TIME_ZONE),
    });
    // A roster across two groups, no class: in both rows.
    await give(both, {
      audience: { kind: "scholars", scholarIds: [hoku, sloane] },
      endsAt: schoolDayEndAt("2026-11-19", TIME_ZONE),
      setAt: NOW,
    });
    // A group with no class this term: placed by its roster.
    await give(notes, {
      audience: { kind: "group", groupId: readingGroup },
      endsAt: schoolDayEndAt("2026-11-26", TIME_ZONE),
      setAt: NOW,
    });
    // School-wide: under every row.
    await give(fractions, {
      audience: { kind: "institution" },
      endsAt: schoolDayEndAt("2026-12-02", TIME_ZONE),
      setAt: NOW,
    });
    // Class focus is not homework.
    await give(focusWork, {
      timing: { kind: "focus" },
      endsAt: schoolDayEndAt("2026-11-12", TIME_ZONE),
      afterEnd: "fade",
      setAt: NOW,
    });
    // Outside the six weeks.
    await give(later, {
      endsAt: schoolDayEndAt("2027-01-08", TIME_ZONE),
      setAt: NOW,
    });
    return {
      institutionId,
      teacher,
      honu,
      pueo,
      unitId,
      mathClass,
      scienceClass,
      humanitiesClass,
      assignmentId,
      termId,
      lastTermId,
      hoku,
      lehua,
    };
  });
}

describe("homeworkPlanner.weeks", () => {
  test("each group's homework by school week, labeled by class subject", async () => {
    const t = convexTest(schema, modules);
    const school = await seedSchool(t, "moli");
    const asTeacher = await withUser(t, school.teacher);
    const plan = await asTeacher.query(api.homeworkPlanner.weeks, { todayKey: TODAY });

    expect(plan.mondayKeys).toEqual([
      "2026-11-09",
      "2026-11-16",
      "2026-11-23",
      "2026-11-30",
      "2026-12-07",
      "2026-12-14",
    ]);
    // Manu only had classes last term.
    expect(plan.groups.map((g) => g.name)).toEqual(["Honu", "Pueo"]);
    const [honu, pueo] = plan.groups;
    expect(honu.weeks[0].items).toEqual([
      expect.objectContaining({
        title: "Fraction strips",
        subject: "Math",
        teacherName: "Avery Stone",
        dueDayKey: "2026-11-13",
        live: true,
        partOfGroup: null,
      }),
    ]);
    expect(honu.weeks[1].items).toEqual([
      expect.objectContaining({ title: "Reef survey", subject: "Science", partOfGroup: 1 }),
      expect.objectContaining({
        title: "Field notes",
        subject: "Science",
        dueDayKey: "2026-11-20",
        live: false,
        partOfGroup: 1,
      }),
    ]);
    // The give that reaches Hoku (Honu) and Sloane (Pueo) is in both rows.
    expect(pueo.weeks[1].items).toEqual([
      expect.objectContaining({ title: "Reef survey", partOfGroup: null }),
    ]);
    // The reading circle has no class: its give sits under Honu (Hoku) and
    // Pueo (Sloane), one scholar of Honu's two.
    expect(honu.weeks[2].items).toEqual([
      expect.objectContaining({ title: "Field notes", partOfGroup: 1 }),
    ]);
    expect(pueo.weeks[2].items).toEqual([
      expect.objectContaining({ title: "Field notes", partOfGroup: null }),
    ]);
    // A school-wide give is under every row, never a part-of-group count.
    for (const group of [honu, pueo]) {
      expect(group.weeks[3].items).toEqual([
        expect.objectContaining({ title: "Fraction strips", partOfGroup: null }),
      ]);
    }
  });

  test("pages to later weeks", async () => {
    const t = convexTest(schema, modules);
    const school = await seedSchool(t, "moli");
    const asTeacher = await withUser(t, school.teacher);
    const plan = await asTeacher.query(api.homeworkPlanner.weeks, {
      todayKey: TODAY,
      fromMondayKey: "2027-01-06",
      weeks: 2,
    });
    expect(plan.mondayKeys).toEqual(["2027-01-04", "2027-01-11"]);
    expect(plan.groups[0].weeks[0].items.map((i) => i.title)).toEqual(["Winter reading"]);
  });

  test("another school's teacher sees only her own groups", async () => {
    const t = convexTest(schema, modules);
    await seedSchool(t, "moli");
    const other = await seedSchool(t, "kai");
    const asOther = await withUser(t, other.teacher);
    const plan = await asOther.query(api.homeworkPlanner.weeks, { todayKey: TODAY });
    expect(plan.groups.map((g) => g.groupId)).toEqual([other.honu, other.pueo]);
  });
});

async function giveTool(t: T, teacher: Id<"users">) {
  const tools = Object.fromEntries(
    (
      await makeAssignmentTools(actionCtxFor(t), () => {}, {
        role: "teacher",
        callerUserId: teacher,
      })
    ).map((tool) => [tool.name, tool]),
  ) as Record<string, { run: (input: unknown) => Promise<string> }>;
  return tools.give;
}

/** The give for `title`, read back from the store. */
async function pushFor(t: T, title: string) {
  return t.run(async (ctx) => {
    const activity = (await ctx.db.query("activities").collect()).find(
      (a) => a.title === title,
    )!;
    return (await ctx.db.query("pushes").collect()).find(
      (p) => p.target.kind === "activity" && p.target.activityId === activity._id,
    );
  });
}

const tideJournal = {
  unitTitle: "Tide Pools",
  activityTitle: "Tide journal",
  groupName: "Honu",
  nextWeekHomework: true,
};

describe("next week's homework, end to end", () => {
  test("shows up at the first school day's start, filed under its class, in the planner", async () => {
    const t = convexTest(schema, modules);
    const school = await seedSchool(t, "moli");
    const give = await giveTool(t, school.teacher);

    const result = JSON.parse(await give.run(tideJournal)) as Record<string, unknown>;
    expect(result).toMatchObject({ ok: true, homeworkClass: "Science" });

    const push = await pushFor(t, "Tide journal");
    // Monday 00:00, due at the end of Friday, the unit's Science class, no
    // meeting day.
    expect(push).toMatchObject({
      classId: school.scienceClass,
      startsAt: hst("2026-11-16", "00:00"),
      endsAt: schoolDayEndAt("2026-11-20", TIME_ZONE),
    });
    expect(push!.dayKey).toBeUndefined();
    expect(push!.setAt).toBeUndefined();

    const asTeacher = await withUser(t, school.teacher);
    const plan = await asTeacher.query(api.homeworkPlanner.weeks, { todayKey: TODAY });
    const honu = plan.groups.find((g) => g.name === "Honu")!;
    expect(honu.weeks[1].items).toContainEqual(
      expect.objectContaining({
        title: "Tide journal",
        subject: "Science",
        dueDayKey: "2026-11-20",
        live: false,
        partOfGroup: null,
      }),
    );
  });

  test("the unit's subject wins over the teacher's own class of another subject", async () => {
    const t = convexTest(schema, modules);
    const school = await seedSchool(t, "moli");
    await t.run((ctx) => ctx.db.patch(school.mathClass, { teacherId: school.teacher }));
    await (await giveTool(t, school.teacher)).run(tideJournal);
    expect((await pushFor(t, "Tide journal"))?.classId).toBe(school.scienceClass);
  });

  test("no class in the unit's subject: the teacher's one class in the group", async () => {
    const t = convexTest(schema, modules);
    const school = await seedSchool(t, "moli");
    await t.run(async (ctx) => {
      await ctx.db.patch(school.unitId, { subject: "Writing" });
      await ctx.db.patch(school.mathClass, { teacherId: school.teacher });
    });
    await (await giveTool(t, school.teacher)).run(tideJournal);
    expect((await pushFor(t, "Tide journal"))?.classId).toBe(school.mathClass);
  });

  test("more than one could be its class: asks which, gives nothing, then files it", async () => {
    const t = convexTest(schema, modules);
    const school = await seedSchool(t, "moli");
    await t.run(async (ctx) => {
      await ctx.db.patch(school.unitId, { subject: undefined });
      await ctx.db.patch(school.mathClass, { teacherId: school.teacher });
      await ctx.db.patch(school.scienceClass, { teacherId: school.teacher });
    });
    const give = await giveTool(t, school.teacher);
    const asked = await give.run(tideJournal);
    expect(asked).toContain('Which class is this for: Math or Science?');
    expect(await pushFor(t, "Tide journal")).toBeFalsy();

    await give.run({ ...tideJournal, homeworkClass: "Math" });
    expect(await pushFor(t, "Tide journal")).toMatchObject({
      classId: school.mathClass,
      startsAt: hst("2026-11-16", "00:00"),
    });
  });

  test("no class fits: given with no class", async () => {
    const t = convexTest(schema, modules);
    const school = await seedSchool(t, "moli");
    await t.run((ctx) => ctx.db.patch(school.unitId, { subject: "Writing" }));
    const result = JSON.parse(
      await (await giveTool(t, school.teacher)).run(tideJournal),
    ) as Record<string, unknown>;
    expect(result.ok).toBe(true);
    expect(result.homeworkClass).toBeUndefined();
    expect((await pushFor(t, "Tide journal"))?.classId).toBeUndefined();
  });

  test("the write path refuses a class that isn't the roster's group's", async () => {
    const t = convexTest(schema, modules);
    const school = await seedSchool(t, "moli");
    // Pueo's Humanities class for Honu's assignment.
    await expect(
      t.run((ctx) =>
        homeworkClassFields(ctx, {
          institutionId: school.institutionId,
          classId: school.humanitiesClass,
          audience: { kind: "assignment", assignmentId: school.assignmentId },
          at: hst("2026-11-16", "00:00"),
        }),
      ),
    ).rejects.toThrow("isn't one of this group's classes");
    // Honu's own class passes.
    await expect(
      t.run((ctx) =>
        homeworkClassFields(ctx, {
          institutionId: school.institutionId,
          classId: school.scienceClass,
          audience: { kind: "assignment", assignmentId: school.assignmentId },
          at: hst("2026-11-16", "00:00"),
        }),
      ),
    ).resolves.toEqual({ classId: school.scienceClass, dayKey: undefined });
  });

  test("two classes in the unit's subject: asks which", async () => {
    const t = convexTest(schema, modules);
    const school = await seedSchool(t, "moli");
    // A second group holding the whole roster, with its own Science class.
    await t.run(async (ctx) => {
      const lab = await ctx.db.insert("scholarGroups", {
        teacherId: school.teacher,
        institutionId: school.institutionId,
        name: "Lab",
        scholarIds: [school.hoku, school.lehua],
      });
      await ctx.db.insert("classes", {
        institutionId: school.institutionId,
        periodId: school.termId,
        groupId: lab,
        subject: "Science",
        subjectKey: "science",
        meetings: [],
      });
    });
    const asked = await (await giveTool(t, school.teacher)).run(tideJournal);
    expect(asked).toContain("Which class is this for: Science (Honu) or Science (Lab)?");
    expect(await pushFor(t, "Tide journal")).toBeFalsy();
  });
});

describe("homework keeps the class it was filed under", () => {
  test("a reschedule onto another class's meeting, then start now, keep it", async () => {
    const t = convexTest(schema, modules);
    const school = await seedSchool(t, "moli");
    // A Writing unit: filed under the teacher's Math class.
    await t.run(async (ctx) => {
      await ctx.db.patch(school.unitId, { subject: "Writing" });
      await ctx.db.patch(school.mathClass, { teacherId: school.teacher });
    });
    await (await giveTool(t, school.teacher)).run(tideJournal);
    const given = await pushFor(t, "Tide journal");
    expect(given?.classId).toBe(school.mathClass);
    const activityId = (given!.target as { activityId: Id<"activities"> }).activityId;

    const asTeacher = await withUser(t, school.teacher);
    // Tuesday 9:30, while Science meets in Block A.
    await asTeacher.mutation(api.assignments.rescheduleActivity, {
      assignmentId: school.assignmentId,
      activityId,
      startsAt: hst("2026-11-17", "09:30"),
    });
    expect(await pushFor(t, "Tide journal")).toMatchObject({
      classId: school.mathClass,
      startsAt: hst("2026-11-17", "09:30"),
    });

    // Moved to now: it goes live, still Math.
    await asTeacher.mutation(api.assignments.rescheduleActivity, {
      assignmentId: school.assignmentId,
      activityId,
      startsAt: NOW,
    });
    const live = await pushFor(t, "Tide journal");
    expect(live?.setAt).toBeDefined();
    expect(live?.classId).toBe(school.mathClass);
    expect(live?.dayKey).toBeUndefined();
  });
});

describe("a named class is checked through the public give", () => {
  const giveFor = async (t: T, school: Awaited<ReturnType<typeof seedSchool>>, classId: Id<"classes">) => {
    const activityId = await t.run(async (ctx) =>
      (await ctx.db.query("activities").collect()).find((a) => a.title === "Tide journal")!._id,
    );
    const asTeacher = await withUser(t, school.teacher);
    return asTeacher.mutation(api.assignments.scheduleActivity, {
      assignmentId: school.assignmentId,
      activityId,
      startsAt: hst("2026-11-16", "00:00"),
      finish: { kind: "by", dayKey: "2026-11-20", classId },
    });
  };

  test("another school's class is refused", async () => {
    const t = convexTest(schema, modules);
    const school = await seedSchool(t, "moli");
    const other = await seedSchool(t, "kai");
    await expect(giveFor(t, school, other.scienceClass)).rejects.toThrow(
      "isn't one of this group's classes",
    );
    expect(await pushFor(t, "Tide journal")).toBeFalsy();
  });

  test("last term's class is refused; this term's is stamped", async () => {
    const t = convexTest(schema, modules);
    const school = await seedSchool(t, "moli");
    const oldScience = await t.run((ctx) =>
      ctx.db.insert("classes", {
        institutionId: school.institutionId,
        periodId: school.lastTermId,
        groupId: school.honu,
        subject: "Science",
        subjectKey: "science",
        meetings: [],
      }),
    );
    await expect(giveFor(t, school, oldScience)).rejects.toThrow(
      "isn't one of this group's classes",
    );
    await giveFor(t, school, school.scienceClass);
    expect((await pushFor(t, "Tide journal"))?.classId).toBe(school.scienceClass);
  });
});
