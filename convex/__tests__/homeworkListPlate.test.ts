import { convexTest } from "convex-test";
import { insertAssignmentWithSchedule } from "./scheduleFixtures";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import schema from "../schema";
import { api } from "../_generated/api";
import {
  makeActivity,
  makeLesson,
  makeUnit,
  makeWorld,
  type WorldScholar,
} from "./factories/world";
import { dayStartForDayKey } from "../../shared/institutionDay";

// The plate rows that feed the scholar's "Your list" (shared/homeworkList.ts).
// Since Prep's Due section was retired, the plate is the ONLY place a scholar
// finds homework, so every live, unfinished homework item must keep a row.

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
  return { world, schoolA, scholar: schoolA.scholars[0] };
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

describe("plate homework rows behind Your list", () => {
  test("started question homework (a unit-less dispatch) keeps its homework row", async () => {
    const t = convexTest(schema, modules);
    const { world, schoolA, scholar } = await setUp(t);
    const seedId = await seedQuestion(t, scholar, "Why strings sing");
    const asTeacher = await world.as.staffOf(schoolA);
    const hw = await asTeacher.mutation(api.assignments.assignQuestionAsHomework, {
      scholarId: scholar.id,
      seedId,
      dueDayKey: "2026-10-15",
    });

    const asScholar = await world.as.scholar(scholar);
    const homeworkRows = async () =>
      (await asScholar.query(api.scholarPlate.activeForMe, {})).rows.filter(
        (row) => row.origin === "homework" && row.activityId === hw.activityId,
      );

    expect(await homeworkRows()).toHaveLength(1);

    const { id: sessionId } = await asScholar.mutation(api.sessions.create, {
      activityId: hw.activityId,
      assignmentId: hw.assignmentId,
    });
    const after = await homeworkRows();
    expect(after).toHaveLength(1);
    expect(after[0].sessionId).toBe(sessionId);
  });

  test("unit-backed practice-set and website homework each get a row on web and native", async () => {
    const t = convexTest(schema, modules);
    const { world, schoolA, scholar } = await setUp(t);
    const unitId = await makeUnit(t, schoolA.teacher, schoolA, { subject: "Math" });
    const lessonId = await makeLesson(t, unitId);
    const practice = await makeActivity(t, lessonId, {
      title: "Fractions practice",
      kind: "problem_set",
      order: 0,
      problemSet: { targetSkillKeys: ["fraction_add_like"] },
    });
    const site = await makeActivity(t, lessonId, {
      title: "Read the museum page",
      kind: "web",
      order: 1,
      webUrl: "https://example.org/museum",
    });
    const online = await makeActivity(t, lessonId, {
      title: "Talk it through",
      kind: "online",
      order: 2,
      systemPrompt: "...",
    });
    await t.run((ctx) =>
      insertAssignmentWithSchedule(ctx, {
        teacherId: schoolA.teacher.id,
        unitId,
        scholarIds: [scholar.id],
        startedAt: NOW - 86_400_000,
        activitySchedule: [practice, site, online].map((activityId) => ({
          activityId,
          mode: "homework" as const,
          setAt: NOW - 60_000,
        })),
      }),
    );

    const asScholar = await world.as.scholar(scholar);
    for (const includeWebActivities of [false, true]) {
      const rows = (
        await asScholar.query(api.scholarPlate.activeForMe, {
          ...(includeWebActivities ? { includeWebActivities } : {}),
        })
      ).rows.filter((row) => row.origin === "homework");
      expect(rows.map((row) => row.activityId).sort()).toEqual(
        [practice, site, online].sort(),
      );
    }
  });
});
