import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import schema from "../schema";
import { api } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import {
  bestNextQuestionForScholar,
  questionQueueForScholar,
  questionQueueSource,
  rankQuestionQueue,
} from "../lib/questionQueue";

// The question lookups are content (owned by the content lanes): every story
// edge / seed topic gets this fixture unless its key is listed in `noQuestion`,
// so the queue's ranking/exclusion rules are tested independent of coverage.
const questionFixture = vi.hoisted(() => ({
  noQuestion: new Set<string>(),
  question: {
    prompt: "Which one wins?",
    choices: ["The first", "The second", "Neither", "Both"],
    answerIndex: 1,
    reveal: "The second one wins.",
  },
}));
vi.mock("../lib/practice/storyCardQuestions", () => ({
  storyCardQuestion: (fromKey: string, toKey: string) =>
    questionFixture.noQuestion.has(`${fromKey}→${toKey}`)
      ? undefined
      : questionFixture.question,
}));
vi.mock("../lib/practice/seedCardQuestions", () => ({
  seedCardQuestion: (topic: string) =>
    questionFixture.noQuestion.has(topic) ? undefined : questionFixture.question,
}));

const modules = (
  import.meta as ImportMeta & {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("../**/*.ts");

const HOUR_MS = 60 * 60 * 1000;
const NOW = Date.UTC(2026, 9, 6, 20);

beforeEach(() => {
  questionFixture.noQuestion.clear();
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
});

type T = ReturnType<typeof convexTest>;

async function seedUser(t: T, username: string, role: "scholar" | "teacher" = "scholar") {
  return await t.run((ctx) =>
    ctx.db.insert("users", { name: username, username, role }),
  );
}

async function withUser(t: T, userId: Id<"users">) {
  const sessionId = await t.run((ctx) =>
    ctx.db.insert("authSessions", { userId, expirationTime: Date.now() + HOUR_MS }),
  );
  return t.withIdentity({ subject: `${userId}|${sessionId}`, issuer: "https://convex.dev" });
}

async function seedCrossDomain(t: T, scholarId: Id<"users">, topic: string) {
  const seedId = await t.run((ctx) =>
    ctx.db.insert("seeds", {
      scholarId,
      origin: "ai",
      status: "active",
      suggestionType: "cross_domain",
      topic,
      rationale: "Teacher-only diagnostic",
      scholarInvitation: `Invitation for ${topic}`,
      domain: "music",
    }),
  );
  vi.advanceTimersByTime(1000);
  return seedId;
}

async function seedEvent(
  t: T,
  scholarId: Id<"users">,
  seedId: Id<"seeds">,
  fields: Partial<Doc<"momentEvents">> & { offeredAt: number },
) {
  return await t.run((ctx) =>
    ctx.db.insert("momentEvents", {
      scholarId,
      kind: "seed",
      seedId,
      trigger: "fluency_transition",
      outcome: "offered",
      clientEventId: `evt-${seedId}-${fields.offeredAt}`,
      ...fields,
    }),
  );
}

async function seedStory(t: T, scholarId: Id<"users">, fromKey: string, toKey: string) {
  return await t.run(async (ctx) => {
    await ctx.db.insert("knowledgeNodeEdges", {
      fromKey,
      toKey,
      domain: "music",
      kind: "bridge",
      method: "curated",
      story: {
        kind: "applies",
        hook: "Fractions keep the beat",
        narrative: "Half notes and quarter notes divide a measure.",
        visualEmoji: "🥁",
        provenance: "registry",
      },
    });
    return await ctx.db.insert("seeds", {
      scholarId,
      origin: "story",
      status: "active",
      suggestionType: "leap",
      topic: "Musical rhythm",
      rationale: "Fractions keep the beat",
      connectionTo: "Fractions as equal parts",
      storyFromKey: fromKey,
      storyToKey: toKey,
      domain: "music",
    });
  });
}

async function seedTeacherQuest(t: T, scholarId: Id<"users">) {
  const teacherId = await seedUser(t, "quest-teacher", "teacher");
  return await t.run(async (ctx) => {
    const unitId = await ctx.db.insert("units", {
      teacherId,
      title: "Tide pools",
      emoji: "🐚",
      isActive: true,
    });
    const lessonId = await ctx.db.insert("lessons", { unitId, title: "Look", order: 0 });
    await ctx.db.insert("activities", {
      lessonId,
      title: "Find a crab",
      kind: "online",
      order: 0,
    });
    const seedId = await ctx.db.insert("seeds", {
      scholarId,
      teacherId,
      origin: "teacher",
      status: "active",
      suggestionType: "teacher_suggestion",
      topic: "Tide pools",
      rationale: "Try this",
      scholarInvitation: "You'd love the crabs.",
      unitId,
    });
    return { seedId, unitId };
  });
}

describe("rankQuestionQueue / questionQueueSource (pure)", () => {
  test("bucket order first, newest first within a bucket, stable on ties", () => {
    const rows = [
      { id: "t1", source: "teacher" as const, sortAt: 2 },
      { id: "n-old", source: "new" as const, sortAt: 1 },
      { id: "m", source: "missed" as const, sortAt: 1 },
      { id: "n-new", source: "new" as const, sortAt: 5 },
      { id: "o", source: "offered" as const, sortAt: 9 },
      { id: "t2", source: "teacher" as const, sortAt: 2 },
    ];
    expect(rankQuestionQueue(rows).map((r) => r.id)).toEqual([
      "m",
      "o",
      "n-new",
      "n-old",
      "t1",
      "t2",
    ]);
  });

  test("settled and correctly-answered items are not open", () => {
    expect(questionQueueSource({ outcome: "dismissed" }, null)).toBeNull();
    expect(questionQueueSource({ outcome: "tried" }, { correct: false })).toBeNull();
    expect(questionQueueSource({ outcome: "probed" }, { correct: true })).toBeNull();
    expect(questionQueueSource({ outcome: "probed" }, { correct: false })).toBe("missed");
    expect(questionQueueSource({ outcome: "offered" }, null)).toBe("offered");
    expect(questionQueueSource(undefined, null)).toBe("new");
  });
});

describe("questionQueue.forSelf", () => {
  test("ranks missed → offered → never-carded → teacher, and excludes closed items", async () => {
    const t = convexTest(schema, modules);
    const scholarId = await seedUser(t, "queue-scholar");

    const teacher = await seedTeacherQuest(t, scholarId);
    const firstNew = await seedCrossDomain(t, scholarId, "Never carded, planted first");
    const offered = await seedCrossDomain(t, scholarId, "Offered, unanswered");
    const missed = await seedCrossDomain(t, scholarId, "Answered wrong");
    const correct = await seedCrossDomain(t, scholarId, "Answered right");
    const dismissed = await seedCrossDomain(t, scholarId, "Let go");
    const followed = await seedCrossDomain(t, scholarId, "Followed");
    const noQuestion = await seedCrossDomain(t, scholarId, "No question");
    questionFixture.noQuestion.add("No question");
    const lastNew = await seedCrossDomain(t, scholarId, "Never carded, planted last");

    await seedEvent(t, scholarId, offered, { offeredAt: NOW - 2 * HOUR_MS });
    await seedEvent(t, scholarId, missed, {
      offeredAt: NOW - 30 * HOUR_MS,
      outcome: "probed",
      answerIndex: 0,
      answerCorrect: false,
      answeredAt: NOW - 29 * HOUR_MS,
    });
    await seedEvent(t, scholarId, correct, {
      offeredAt: NOW - 3 * HOUR_MS,
      outcome: "probed",
      answerIndex: 1,
      answerCorrect: true,
      answeredAt: NOW - 3 * HOUR_MS,
    });
    await seedEvent(t, scholarId, dismissed, {
      offeredAt: NOW - 4 * HOUR_MS,
      outcome: "dismissed",
    });
    await t.run((ctx) =>
      ctx.db.insert("sessions", {
        userId: scholarId,
        seedId: followed,
        title: "Following it",
        isArchived: false,
      }),
    );

    const rows = await (await withUser(t, scholarId)).query(api.questionQueue.forSelf, {});
    const ids = rows.map((row) => row.seedId);

    expect(ids).not.toContain(correct);
    expect(ids).not.toContain(dismissed);
    expect(ids).not.toContain(followed);
    expect(ids).not.toContain(noQuestion);
    // (a) missed, (b) offered, (c) never carded newest-seed-first, (d) teacher.
    expect(ids).toEqual([missed, offered, lastNew, firstNew, teacher.seedId]);

    const missedRow = rows[0];
    expect(missedRow).toMatchObject({
      kind: "question",
      source: "missed",
      origin: "seed",
      answer: { choiceIndex: 0, correct: false },
      moment: { kind: "seed", seedId: missed },
    });
    expect(missedRow.eventId).not.toBeNull();
    expect(rows[2]).toMatchObject({ source: "new", eventId: null, answer: null });
    expect(rows.at(-1)).toMatchObject({
      kind: "teacherQuest",
      source: "teacher",
      unitId: teacher.unitId,
      question: null,
    });
    // The teacher-only diagnostic never reaches a question row.
    expect(JSON.stringify(rows.filter((r) => r.kind === "question"))).not.toContain(
      "Teacher-only diagnostic",
    );
  });

  test("a story souvenir becomes a question row cited to its unlocking skill", async () => {
    const t = convexTest(schema, modules);
    const scholarId = await seedUser(t, "story-scholar");
    const seedId = await seedStory(t, scholarId, "fraction_as_parts", "music_rhythm");

    const rows = await (await withUser(t, scholarId)).query(api.questionQueue.forSelf, {});
    expect(rows).toEqual([
      expect.objectContaining({
        seedId,
        origin: "story",
        source: "new",
        emoji: "🥁",
        meta: "Unlocked by Fractions as equal parts",
        moment: { kind: "story", fromKey: "fraction_as_parts", toKey: "music_rhythm" },
      }),
    ]);
  });

  test("self-only: another scholar's items never appear, and staff get nothing", async () => {
    const t = convexTest(schema, modules);
    const me = await seedUser(t, "me");
    const other = await seedUser(t, "other");
    const teacher = await seedUser(t, "a-teacher", "teacher");
    await seedCrossDomain(t, other, "Theirs");
    await seedTeacherQuest(t, other);

    expect(await (await withUser(t, me)).query(api.questionQueue.forSelf, {})).toEqual([]);
    expect(await (await withUser(t, teacher)).query(api.questionQueue.forSelf, {})).toEqual([]);
  });

  test("answering a never-carded row mints a list ledger row and grades it; the done-screen budget is untouched", async () => {
    const t = convexTest(schema, modules);
    const scholarId = await seedUser(t, "answer-scholar");
    const seedId = await seedCrossDomain(t, scholarId, "Fresh");
    const asScholar = await withUser(t, scholarId);

    const [row] = await asScholar.query(api.questionQueue.forSelf, {});
    expect(row).toMatchObject({ source: "new", eventId: null });

    const minted = await asScholar.mutation(api.practiceMoments.recordMomentOffered, {
      scholarId,
      clientEventId: "quests-row-1",
      surface: "quests",
      kind: "seed",
      seedId,
    });
    // Idempotent per item: a second mint returns the same open row.
    const again = await asScholar.mutation(api.practiceMoments.recordMomentOffered, {
      scholarId,
      clientEventId: "quests-row-2",
      surface: "quests",
      kind: "seed",
      seedId,
    });
    expect(again.eventId).toBe(minted.eventId);
    expect(await t.run((ctx) => ctx.db.get(minted.eventId))).toMatchObject({
      trigger: "quests_list",
      outcome: "offered",
    });

    await asScholar.mutation(api.practiceMoments.recordMomentAnswer, {
      eventId: minted.eventId,
      choiceIndex: 3,
    });
    const [after] = await asScholar.query(api.questionQueue.forSelf, {});
    expect(after).toMatchObject({
      seedId,
      source: "missed",
      eventId: minted.eventId,
      answer: { choiceIndex: 3, correct: false },
    });

    // A list answer does not spend the done-screen's one-a-day card: a second
    // cross-domain seed is still offered there.
    const other = await seedCrossDomain(t, scholarId, "Done-screen card");
    const moment = await asScholar.query(api.practiceMoments.storyMomentForScholar, {
      scholarId,
    });
    expect(moment).toMatchObject({ kind: "seed", seedId: other });
  });

  test("a settled item cannot be re-minted from the list", async () => {
    const t = convexTest(schema, modules);
    const scholarId = await seedUser(t, "settled-scholar");
    const seedId = await seedCrossDomain(t, scholarId, "Settled");
    await seedEvent(t, scholarId, seedId, {
      offeredAt: NOW - HOUR_MS,
      outcome: "dismissed",
    });
    await expect(
      (await withUser(t, scholarId)).mutation(api.practiceMoments.recordMomentOffered, {
        scholarId,
        clientEventId: "quests-row-x",
        surface: "quests",
        kind: "seed",
        seedId,
      }),
    ).rejects.toThrow(/settled/);
  });
});

describe("bestNextQuestionForScholar (the teacher Prep's bounded read)", () => {
  async function liveHomework(t: T, scholarId: Id<"users">, seedId: Id<"seeds">) {
    const teacherId = await seedUser(t, `hw-teacher-${seedId}`, "teacher");
    await t.run(async (ctx) => {
      const activityId = await ctx.db.insert("activities", {
        title: "Homework question",
        kind: "online",
        order: 0,
        seedId,
      });
      const assignmentId = await ctx.db.insert("assignments", {
        teacherId,
        scholarIds: [scholarId],
        title: "Homework question",
        kind: "adHocDispatch",
        startedAt: NOW,
        activitySchedule: [{ activityId, mode: "homework", dueAt: NOW + 24 * HOUR_MS }],
      });
      await ctx.db.patch(activityId, { dispatchAssignmentId: assignmentId });
    });
  }

  test("agrees with the full queue's top question row, skipping started and homework items", async () => {
    const t = convexTest(schema, modules);
    const scholarId = await seedUser(t, "best-next-scholar");
    await seedTeacherQuest(t, scholarId);
    await seedCrossDomain(t, scholarId, "Never carded");
    const offered = await seedCrossDomain(t, scholarId, "Offered");
    const missedOld = await seedCrossDomain(t, scholarId, "Missed a while ago");
    const missedHomework = await seedCrossDomain(t, scholarId, "Missed, now homework");
    const missedStarted = await seedCrossDomain(t, scholarId, "Missed, then followed");
    await seedStory(t, scholarId, "fraction_as_parts", "music_rhythm");

    await seedEvent(t, scholarId, offered, { offeredAt: NOW - HOUR_MS });
    const miss = (answeredAt: number) => ({
      offeredAt: answeredAt - HOUR_MS,
      outcome: "probed" as const,
      answerIndex: 0,
      answerCorrect: false,
      answeredAt,
    });
    await seedEvent(t, scholarId, missedOld, miss(NOW - 40 * HOUR_MS));
    await seedEvent(t, scholarId, missedHomework, miss(NOW - 3 * HOUR_MS));
    await seedEvent(t, scholarId, missedStarted, miss(NOW - 2 * HOUR_MS));
    await liveHomework(t, scholarId, missedHomework);
    await t.run((ctx) =>
      ctx.db.insert("sessions", {
        userId: scholarId,
        seedId: missedStarted,
        title: "Following it",
        isArchived: false,
      }),
    );

    const { best, queue } = await t.run(async (ctx) => ({
      best: await bestNextQuestionForScholar(ctx, scholarId),
      queue: await questionQueueForScholar(ctx, scholarId),
    }));
    const topQuestion = queue.find((row) => row.kind === "question");
    expect(best?.seedId).toBe(missedOld);
    expect(best).toEqual(topQuestion);
  });

  test("agrees on a never-carded story souvenir, and returns null when nothing is open", async () => {
    const t = convexTest(schema, modules);
    const scholarId = await seedUser(t, "best-next-story");
    const empty = await t.run((ctx) => bestNextQuestionForScholar(ctx, scholarId));
    expect(empty).toBeNull();

    const seedId = await seedStory(t, scholarId, "fraction_as_parts", "music_rhythm");
    const { best, queue } = await t.run(async (ctx) => ({
      best: await bestNextQuestionForScholar(ctx, scholarId),
      queue: await questionQueueForScholar(ctx, scholarId),
    }));
    expect(best?.seedId).toBe(seedId);
    expect(best).toEqual(queue[0]);
  });
});

describe("the Quests-list offer never plants a story seed", () => {
  test("an edge the scholar never unlocked is refused and nothing is written", async () => {
    const t = convexTest(schema, modules);
    const scholarId = await seedUser(t, "no-plant-scholar");
    const other = await seedUser(t, "unlocked-it");
    // The edge carries a story, but only ANOTHER scholar holds its seed.
    await seedStory(t, other, "fraction_as_parts", "music_rhythm");
    const asScholar = await withUser(t, scholarId);

    await expect(
      asScholar.mutation(api.practiceMoments.recordMomentOffered, {
        scholarId,
        clientEventId: "quests-story-forged",
        surface: "quests",
        kind: "story",
        fromKey: "fraction_as_parts",
        toKey: "music_rhythm",
      }),
    ).rejects.toThrow(/no open question/);
    const written = await t.run(async (ctx) => ({
      seeds: (await ctx.db.query("seeds").collect()).filter((s) => s.scholarId === scholarId),
      events: (await ctx.db.query("momentEvents").collect()).filter(
        (e) => e.scholarId === scholarId,
      ),
    }));
    expect(written).toEqual({ seeds: [], events: [] });
  });

  test("a story the scholar holds as an active story seed mints its ledger row on that seed", async () => {
    const t = convexTest(schema, modules);
    const scholarId = await seedUser(t, "held-story-scholar");
    const seedId = await seedStory(t, scholarId, "fraction_as_parts", "music_rhythm");
    const asScholar = await withUser(t, scholarId);

    const minted = await asScholar.mutation(api.practiceMoments.recordMomentOffered, {
      scholarId,
      clientEventId: "quests-story-1",
      surface: "quests",
      kind: "story",
      fromKey: "fraction_as_parts",
      toKey: "music_rhythm",
    });
    expect(minted.seedId).toBe(seedId);
    const seeds = await t.run(async (ctx) =>
      (await ctx.db.query("seeds").collect()).filter((s) => s.scholarId === scholarId),
    );
    expect(seeds.map((s) => s._id)).toEqual([seedId]);
  });
});
