import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import schema from "../schema";
import { api, internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { makeWorld, type World, type WorldScholar } from "./factories/world";
import { dayStartForDayKey } from "../../shared/institutionDay";
import { schoolDayEndAt } from "../lib/schoolDays";

// Scholar's Prep "Assign…": a teacher makes a scholar's best next question
// HOMEWORK due on an open school day (assignments.assignQuestionAsHomework),
// and the teacher Prep read (takeHomePlans.forVisibleScholarsAsTeacher) shows
// each scholar's best next question with the days it can be assigned for.

// Question copy is content; every seed topic gets this fixture.
const question = vi.hoisted(() => ({
  prompt: "Which string vibrates faster?",
  choices: ["The short one", "The long one"],
  answerIndex: 0,
  reveal: "Shorter strings vibrate faster.",
}));
vi.mock("../lib/practice/seedCardQuestions", () => ({
  seedCardQuestion: () => question,
}));

const modules = (
  import.meta as ImportMeta & {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("../**/*.ts");

const TIME_ZONE = "Pacific/Honolulu";
// Wednesday 2026-10-14, noon in Honolulu. Open days after it: Thu 15, Fri 16,
// Mon 19 (Sat 17 / Sun 18 are the weekend).
const TODAY = "2026-10-14";
const NOW = dayStartForDayKey(TODAY, TIME_ZONE) + 12 * 60 * 60_000;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
});

type T = ReturnType<typeof convexTest>;

async function setUp(t: T) {
  const world = await makeWorld(t);
  await t.run(async (ctx) => {
    for (const school of world.schools) {
      await ctx.db.patch(school.id, { timeZone: TIME_ZONE });
    }
  });
  const [schoolA] = world.schools;
  const scholar = schoolA.scholars[0];
  const seedId = await seedQuestion(t, scholar, "Why strings sing");
  return { world, schoolA, schoolB: world.schools[1], scholar, seedId };
}

async function seedQuestion(t: T, scholar: WorldScholar, topic: string) {
  return await t.run((ctx) =>
    ctx.db.insert("seeds", {
      scholarId: scholar.id,
      origin: "ai",
      status: "active",
      suggestionType: "cross_domain",
      topic,
      rationale: "Teacher-only diagnostic",
      scholarInvitation: `Invitation for ${topic}`,
      domain: "music",
    }),
  );
}

async function dispatchCount(t: T) {
  return await t.run(async (ctx) =>
    (await ctx.db.query("assignments").collect()).filter(
      (a) => a.kind === "adHocDispatch",
    ).length,
  );
}

async function teacherRow(
  world: World,
  schoolIndex: number,
  scholarId: Id<"users">,
) {
  const asTeacher = await world.as.staffOf(world.schools[schoolIndex]);
  const result = await asTeacher.query(
    api.takeHomePlans.forVisibleScholarsAsTeacher,
    { scholarIds: [scholarId], now: NOW },
  );
  return result.scholars.find((row) => row.scholarId === scholarId) ?? null;
}

describe("assignQuestionAsHomework", () => {
  test("assigns the question as homework due that school day; the scholar sees it under Due and starting it opens the seed session", async () => {
    const t = convexTest(schema, modules);
    const { world, schoolA, scholar, seedId } = await setUp(t);
    const asTeacher = await world.as.staffOf(schoolA);

    const result = await asTeacher.mutation(
      api.assignments.assignQuestionAsHomework,
      { scholarId: scholar.id, seedId, dueDayKey: "2026-10-15" },
    );
    expect(result.created).toBe(true);
    expect(result.dueAt).toBe(schoolDayEndAt("2026-10-15", TIME_ZONE));

    // The scholar's Prep → Due list carries it, with that due date.
    const asScholar = await world.as.scholar(scholar);
    const plan = await asScholar.query(api.takeHomePlans.forSelf, { now: NOW });
    const due = plan.assigned.find((item) => item.activityId === result.activityId);
    expect(due).toBeDefined();
    expect(due!.assignmentId).toBe(result.assignmentId);
    expect(due!.dueAt).toBe(schoolDayEndAt("2026-10-15", TIME_ZONE));
    expect(due!.label).toBe(question.prompt);

    // It is on exactly one list: no longer in the scholar's question queue.
    const queue = await asScholar.query(api.questionQueue.forSelf, {});
    expect(queue.some((row) => row.seedId === seedId)).toBe(false);

    // Starting it from Due (the activity launch) opens THE seed's session,
    // still anchored to the homework so it completes like any other.
    const { id: sessionId } = await asScholar.mutation(api.sessions.create, {
      activityId: result.activityId,
      assignmentId: result.assignmentId,
    });
    const session = await t.run((ctx) => ctx.db.get(sessionId));
    expect(session?.seedId).toBe(seedId);
    expect(session?.activityId).toBe(result.activityId);
    expect(session?.assignmentId).toBe(result.assignmentId);

    // The tutor is told a teacher assigned it — not "a rabbit hole they picked".
    const context = await t.query(internal.sessionHelpers.getSessionContext, { sessionId });
    expect(context?.seedOriginContext?.assignedAsHomework).toBe(true);
  });

  test("is idempotent per (scholar, question, day) and refuses a second day", async () => {
    const t = convexTest(schema, modules);
    const { world, schoolA, scholar, seedId } = await setUp(t);
    const asTeacher = await world.as.staffOf(schoolA);
    const args = { scholarId: scholar.id, seedId, dueDayKey: "2026-10-16" };

    const first = await asTeacher.mutation(api.assignments.assignQuestionAsHomework, args);
    const again = await asTeacher.mutation(api.assignments.assignQuestionAsHomework, args);
    expect(again.created).toBe(false);
    expect(again.assignmentId).toBe(first.assignmentId);
    expect(again.activityId).toBe(first.activityId);
    expect(await dispatchCount(t)).toBe(1);

    await expect(
      asTeacher.mutation(api.assignments.assignQuestionAsHomework, {
        ...args,
        dueDayKey: "2026-10-19",
      }),
    ).rejects.toThrow(/already homework/);
    expect(await dispatchCount(t)).toBe(1);
  });

  test("refuses a teacher from another school (tenancy)", async () => {
    const t = convexTest(schema, modules);
    const { world, schoolB, scholar, seedId } = await setUp(t);
    const asOtherTeacher = await world.as.staffOf(schoolB);

    await expect(
      asOtherTeacher.mutation(api.assignments.assignQuestionAsHomework, {
        scholarId: scholar.id,
        seedId,
        dueDayKey: "2026-10-15",
      }),
    ).rejects.toThrow(/forbidden/i);
    expect(await dispatchCount(t)).toBe(0);
  });

  test("refuses a scholar (teacher-only)", async () => {
    const t = convexTest(schema, modules);
    const { world, scholar, seedId } = await setUp(t);
    const asScholar = await world.as.scholar(scholar);

    await expect(
      asScholar.mutation(api.assignments.assignQuestionAsHomework, {
        scholarId: scholar.id,
        seedId,
        dueDayKey: "2026-10-15",
      }),
    ).rejects.toThrow();
    expect(await dispatchCount(t)).toBe(0);
  });

  test("only accepts a future open school day", async () => {
    const t = convexTest(schema, modules);
    const { world, schoolA, scholar, seedId } = await setUp(t);
    const asTeacher = await world.as.staffOf(schoolA);
    await t.run((ctx) =>
      ctx.db.insert("schoolClosures", {
        institutionId: schoolA.id,
        startDayKey: "2026-10-16",
        endDayKey: "2026-10-16",
        label: "Staff development day",
        kind: "staffOnly",
      }),
    );
    const assign = (dueDayKey: string) =>
      asTeacher.mutation(api.assignments.assignQuestionAsHomework, {
        scholarId: scholar.id,
        seedId,
        dueDayKey,
      });

    await expect(assign(TODAY)).rejects.toThrow(/after today/);
    await expect(assign("2026-10-13")).rejects.toThrow(/after today/);
    await expect(assign("2026-10-17")).rejects.toThrow(/isn't a school day/); // Saturday
    await expect(assign("2026-10-16")).rejects.toThrow(/isn't a school day/); // closure
    await expect(assign("next week")).rejects.toThrow(/school day/);
    expect(await dispatchCount(t)).toBe(0);
  });

  test("only assigns one of the scholar's OPEN questions", async () => {
    const t = convexTest(schema, modules);
    const { world, schoolA, scholar } = await setUp(t);
    const asTeacher = await world.as.staffOf(schoolA);
    // A seed of a different scholar in the same school.
    const otherSeed = await seedQuestion(t, schoolA.scholars[1], "Tide pools");

    await expect(
      asTeacher.mutation(api.assignments.assignQuestionAsHomework, {
        scholarId: scholar.id,
        seedId: otherSeed,
        dueDayKey: "2026-10-15",
      }),
    ).rejects.toThrow(/isn't open/);
    expect(await dispatchCount(t)).toBe(0);
  });
});

describe("teacher Prep row (forVisibleScholarsAsTeacher)", () => {
  test("carries the best next question and the next open school days", async () => {
    const t = convexTest(schema, modules);
    const { world, schoolA, scholar, seedId } = await setUp(t);
    await t.run((ctx) =>
      ctx.db.insert("schoolClosures", {
        institutionId: schoolA.id,
        startDayKey: "2026-10-16",
        endDayKey: "2026-10-16",
        label: "Staff development day",
        kind: "staffOnly",
      }),
    );

    const row = await teacherRow(world, 0, scholar.id);
    expect(row?.bestNext).toMatchObject({ seedId, prompt: question.prompt });
    expect(row?.dayKey).toBe(TODAY);
    // Thu, then over the closure (Fri) and the weekend.
    expect(row?.assignDays).toEqual(["2026-10-15", "2026-10-19", "2026-10-20"]);
    expect(row?.emptyList).toBe(true);

    // Once assigned, it is due (not "next") — the next question takes the slot.
    const asTeacher = await world.as.staffOf(schoolA);
    await asTeacher.mutation(api.assignments.assignQuestionAsHomework, {
      scholarId: scholar.id,
      seedId,
      dueDayKey: "2026-10-15",
    });
    const after = await teacherRow(world, 0, scholar.id);
    expect(after?.bestNext).toBeNull();
    expect(after?.emptyList).toBe(false);
    expect(after?.assigned.map((item) => item.label)).toEqual([question.prompt]);
  });

  test("homework past the Due window shows on the row with its due date, never twice, never once archived (TRA-476)", async () => {
    const t = convexTest(schema, modules);
    const { world, schoolA, scholar, seedId } = await setUp(t);
    const asTeacher = await world.as.staffOf(schoolA);
    const otherSeed = await seedQuestion(t, scholar, "Tide pools");

    // Within the window (next open school day): the Due list owns it.
    await asTeacher.mutation(api.assignments.assignQuestionAsHomework, {
      scholarId: scholar.id,
      seedId: otherSeed,
      dueDayKey: "2026-10-15",
    });
    let row = await teacherRow(world, 0, scholar.id);
    expect(row?.assigned).toHaveLength(1);
    expect(row?.later ?? []).toEqual([]);

    // Beyond it (Mon 19): not under Due, but the row still shows it, dated.
    const far = await asTeacher.mutation(api.assignments.assignQuestionAsHomework, {
      scholarId: scholar.id,
      seedId,
      dueDayKey: "2026-10-19",
    });
    row = await teacherRow(world, 0, scholar.id);
    expect(row?.bestNext).toBeNull();
    expect(row?.assigned).toHaveLength(1);
    expect(row?.later).toHaveLength(1);
    expect(row?.later[0]).toMatchObject({
      activityId: far.activityId,
      label: question.prompt,
      dueAt: schoolDayEndAt("2026-10-19", TIME_ZONE),
    });

    // Archived homework is not live: it leaves the row.
    await asTeacher.mutation(api.assignments.archive, { assignmentId: far.assignmentId });
    row = await teacherRow(world, 0, scholar.id);
    expect(row?.later ?? []).toEqual([]);
  });

  test("archiving the homework returns the question to the queue, and it can be assigned again", async () => {
    const t = convexTest(schema, modules);
    const { world, schoolA, scholar, seedId } = await setUp(t);
    const asTeacher = await world.as.staffOf(schoolA);
    const asScholar = await world.as.scholar(scholar);
    const first = await asTeacher.mutation(api.assignments.assignQuestionAsHomework, {
      scholarId: scholar.id,
      seedId,
      dueDayKey: "2026-10-15",
    });
    expect(
      (await asScholar.query(api.questionQueue.forSelf, {})).some((row) => row.seedId === seedId),
    ).toBe(false);

    await asTeacher.mutation(api.assignments.archive, { assignmentId: first.assignmentId });

    // Back in the backlog (and the teacher's best next) — never stranded.
    expect(
      (await asScholar.query(api.questionQueue.forSelf, {})).some((row) => row.seedId === seedId),
    ).toBe(true);
    expect((await teacherRow(world, 0, scholar.id))?.bestNext).toMatchObject({ seedId });

    const again = await asTeacher.mutation(api.assignments.assignQuestionAsHomework, {
      scholarId: scholar.id,
      seedId,
      dueDayKey: "2026-10-19",
    });
    expect(again.created).toBe(true);
    expect(again.assignmentId).not.toBe(first.assignmentId);
  });

  test("a scholar removed from the homework dispatch gets the question back", async () => {
    const t = convexTest(schema, modules);
    const { world, schoolA, scholar, seedId } = await setUp(t);
    const asTeacher = await world.as.staffOf(schoolA);
    const first = await asTeacher.mutation(api.assignments.assignQuestionAsHomework, {
      scholarId: scholar.id,
      seedId,
      dueDayKey: "2026-10-15",
    });
    await t.run((ctx) => ctx.db.patch(first.assignmentId, { scholarIds: [] }));

    const asScholar = await world.as.scholar(scholar);
    expect(
      (await asScholar.query(api.questionQueue.forSelf, {})).some((row) => row.seedId === seedId),
    ).toBe(true);
    const again = await asTeacher.mutation(api.assignments.assignQuestionAsHomework, {
      scholarId: scholar.id,
      seedId,
      dueDayKey: "2026-10-15",
    });
    expect(again.created).toBe(true);
  });

  test("never returns another school's scholar", async () => {
    const t = convexTest(schema, modules);
    const { world, scholar } = await setUp(t);

    const row = await teacherRow(world, 1, scholar.id);
    expect(row).toBeNull();
  });
});
