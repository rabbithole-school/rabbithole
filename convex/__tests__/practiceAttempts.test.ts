import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "../schema";
import { api, internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import { factKeyFromOperands } from "../../shared/factKey";
import { gradeTemplateItem } from "../lib/practice/session";
import { generateItem } from "../lib/practice/templates";
import {
  seedScholarInInstitution,
  seedStaffWithMembership,
  seedTestInstitution,
} from "./institutionTestHelpers";

const modules = (
  import.meta as ImportMeta & {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("../**/*.ts");

async function seedUser(
  t: ReturnType<typeof convexTest>,
  role: Doc<"users">["role"] = "scholar",
  overrides: Partial<Doc<"users">> = {},
) {
  const institutionId = await seedTestInstitution(t);
  if (role === "teacher") {
    return seedStaffWithMembership(t, {
      institutionId,
      name: overrides.name ?? `Test ${role}`,
      username: overrides.username ?? `test${role}`,
    });
  }
  if (role === "scholar") {
    const userId = await seedScholarInInstitution(t, {
      institutionId,
      name: overrides.name ?? `Test ${role}`,
      username: overrides.username ?? `test${role}`,
    });
    await t.run((ctx) =>
      ctx.db.patch(userId, {
        readingLevel: overrides.readingLevel,
        image: overrides.image,
      }),
    );
    return userId;
  }
  return t.run((ctx) =>
    ctx.db.insert("users", {
      name: overrides.name ?? `Test ${role}`,
      username: overrides.username ?? `test${role}`,
      role,
      readingLevel: overrides.readingLevel,
      image: overrides.image,
    }),
  );
}

async function withUser(t: ReturnType<typeof convexTest>, userId: Id<"users">) {
  const sessionId = await t.run(async (ctx) =>
    ctx.db.insert("authSessions", {
      userId,
      expirationTime: Date.now() + 1000 * 60 * 60,
    }),
  );
  return t.withIdentity({
    subject: `${userId}|${sessionId}`,
    issuer: "https://convex.dev",
  });
}

const SUB_SKILL = "subtract_2digit_regroup";

async function insertBorrowItem(t: ReturnType<typeof convexTest>) {
  return t.run(async (ctx) =>
    ctx.db.insert("practiceItems", {
      skillKey: SUB_SKILL,
      domain: "whole-number-arithmetic",
      stem: "52 - 38 = ?",
      answerType: "integer",
      answerCanonical: "14",
      source: "generated",
      verifiedAt: Date.now(),
    }),
  );
}

async function insertConverseItem(t: ReturnType<typeof convexTest>) {
  return t.run(async (ctx) =>
    ctx.db.insert("practiceItems", {
      skillKey: SUB_SKILL,
      domain: "whole-number-arithmetic",
      stem: "What is the converse of 'If it rains, then the ground is wet'?",
      answerType: "multipleChoice",
      answerCanonical: "1",
      choices: [
        "It rains and the ground is wet",
        "If the ground is wet, then it rains",
        "If it does not rain, then the ground is not wet",
        "If the ground is wet, then it does not rain",
      ],
      source: "generated",
      verifiedAt: Date.now(),
    }),
  );
}

async function attempts(t: ReturnType<typeof convexTest>, scholarId: Id<"users">) {
  const rows = await t.run(async (ctx) => ctx.db.query("practiceAttempts").collect());
  return rows.filter((row) => row.scholarId === scholarId);
}

async function errorEvents(t: ReturnType<typeof convexTest>, scholarId: Id<"users">) {
  const rows = await t.run(async (ctx) => ctx.db.query("practiceErrorEvents").collect());
  return rows.filter((row) => row.scholarId === scholarId);
}

describe("practiceAttempts", () => {
  test("a multiplication fact attempt updates its canonical fact-fluency row", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.practiceSkills.seedGraph, {});
    const scholarId = await seedUser(t);
    const asScholar = await withUser(t, scholarId);
    const skillKey = "mult_facts_7_8_9";
    const seed = 42;
    const itemId = `${skillKey}#${seed}`;
    const generated = generateItem(skillKey, seed);
    expect(generated?.variant).toBeDefined();
    const factKey = generated?.variant
      ? factKeyFromOperands(
          generated.variant.a,
          generated.variant.op,
          generated.variant.b,
        )
      : null;
    expect(factKey).not.toBeNull();
    const truth = gradeTemplateItem(itemId, "0");
    expect(truth).not.toBeNull();

    const correct = await asScholar.mutation(api.practiceSkills.submitAnswer, {
      scholarId,
      itemId,
      answer: truth!.correctAnswer,
      firstKeyMs: 1_250,
    });
    expect(correct.correct).toBe(true);
    const wrong = await asScholar.mutation(api.practiceSkills.submitAnswer, {
      scholarId,
      itemId,
      answer: "-1",
    });
    expect(wrong.correct).toBe(false);

    const rows = await t.run(async (ctx) =>
      ctx.db
        .query("factFluency")
        .withIndex("by_scholar_fact", (q) =>
          q.eq("scholarId", scholarId).eq("factKey", factKey!),
        )
        .collect(),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      scholarId,
      factKey,
      skillKey,
      domain: "whole-number-arithmetic",
      seenCount: 2,
      correctCount: 1,
      latencySamplesMs: [1_250],
      latencyMedianMs: 1_250,
    });
  });

  test("a correct graded attempt logs one row with the item identity", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.practiceSkills.seedGraph, {});
    const scholarId = await seedUser(t);
    const asScholar = await withUser(t, scholarId);
    const itemDocId = await insertBorrowItem(t);
    const itemId = `gen#${itemDocId}`;

    const res = await asScholar.mutation(api.practiceSkills.submitAnswer, {
      scholarId,
      itemId,
      answer: "14",
      firstKeyMs: 1_250,
      elapsedMs: 2_750,
    });
    expect(res.correct).toBe(true);

    const logged = await attempts(t, scholarId);
    expect(logged).toHaveLength(1);
    expect(logged[0]).toMatchObject({
      scholarId,
      nodeKey: SUB_SKILL,
      itemId,
      correct: true,
      firstKeyMs: 1_250,
      elapsedMs: 2_750,
      answerText: "14",
    });
    // A correct attempt does NOT snapshot the problem — the snapshot exists
    // purely to answer "what did they get wrong", so it stays silent here.
    expect(logged[0].stemSnapshot).toBeUndefined();
    expect(logged[0].expectedAnswer).toBeUndefined();
  });

  test("replays one logical submission without a second attempt or mastery transition", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.practiceSkills.seedGraph, {});
    const scholarId = await seedUser(t);
    const asScholar = await withUser(t, scholarId);
    const itemDocId = await insertBorrowItem(t);
    const args = {
      scholarId,
      itemId: `gen#${itemDocId}`,
      answer: "14",
      clientEventId: "practice-answer:replay",
    };

    const [first, duplicate] = await Promise.all([
      asScholar.mutation(api.practiceSkills.submitAnswer, args),
      asScholar.mutation(api.practiceSkills.submitAnswer, args),
    ]);

    expect(duplicate).toEqual(first);
    expect(await attempts(t, scholarId)).toHaveLength(1);
    const mastery = await t.run((ctx) =>
      ctx.db
        .query("practiceMastery")
        .withIndex("by_scholar_skill", (q) =>
          q.eq("scholarId", scholarId).eq("skillKey", SUB_SKILL),
        )
        .first(),
    );
    expect(mastery?.repetition).toBe(1);
  });

  test("rejects a client submission id reused for a different answer", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.practiceSkills.seedGraph, {});
    const scholarId = await seedUser(t);
    const asScholar = await withUser(t, scholarId);
    const itemDocId = await insertBorrowItem(t);
    const itemId = `gen#${itemDocId}`;
    await asScholar.mutation(api.practiceSkills.submitAnswer, {
      scholarId,
      itemId,
      answer: "14",
      clientEventId: "practice-answer:collision",
    });

    await expect(
      asScholar.mutation(api.practiceSkills.submitAnswer, {
        scholarId,
        itemId,
        answer: "13",
        clientEventId: "practice-answer:collision",
      }),
    ).rejects.toThrow("reused for a different answer");
    expect(await attempts(t, scholarId)).toHaveLength(1);
  });

  test("rejects a client submission id reused with different replay semantics", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.practiceSkills.seedGraph, {});
    const scholarId = await seedUser(t);
    const asScholar = await withUser(t, scholarId);
    const itemDocId = await insertBorrowItem(t);
    const args = {
      scholarId,
      itemId: `gen#${itemDocId}`,
      answer: "14",
      clientEventId: "practice-answer:replay-collision",
    };

    await asScholar.mutation(api.practiceSkills.submitAnswer, {
      ...args,
      replay: false,
      submissionFingerprintVersion: 2,
    });
    await expect(
      asScholar.mutation(api.practiceSkills.submitAnswer, {
        ...args,
        replay: true,
        submissionFingerprintVersion: 2,
      }),
    ).rejects.toThrow("reused for a different answer");
    expect(await attempts(t, scholarId)).toHaveLength(1);
  });

  test("grandfathers replay flips from unversioned cached clients", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.practiceSkills.seedGraph, {});
    const scholarId = await seedUser(t);
    const asScholar = await withUser(t, scholarId);
    const itemDocId = await insertBorrowItem(t);
    const args = {
      scholarId,
      itemId: `gen#${itemDocId}`,
      answer: "14",
      clientEventId: "practice-answer:legacy-replay",
    };
    const first = await asScholar.mutation(api.practiceSkills.submitAnswer, {
      ...args,
      replay: false,
    });
    const duplicate = await asScholar.mutation(api.practiceSkills.submitAnswer, {
      ...args,
      replay: true,
    });
    expect(duplicate).toEqual(first);
    expect(await attempts(t, scholarId)).toHaveLength(1);
  });

  test("a wrong graded attempt logs correct:false and preserves practiceErrorEvents", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.practiceSkills.seedGraph, {});
    const scholarId = await seedUser(t);
    const asScholar = await withUser(t, scholarId);
    const itemDocId = await insertBorrowItem(t);
    const itemId = `gen#${itemDocId}`;

    const res = await asScholar.mutation(api.practiceSkills.submitAnswer, {
      scholarId,
      itemId,
      answer: "26",
    });
    expect(res.correct).toBe(false);

    const logged = await attempts(t, scholarId);
    expect(logged).toHaveLength(1);
    expect(logged[0]).toMatchObject({
      scholarId,
      nodeKey: SUB_SKILL,
      itemId,
      correct: false,
      answerText: "26",
    });
    // A MISS snapshots the problem (Option 2): the stem as shown, and the
    // real canonical answer — sourced from the same GradeResult the grader
    // already computed, matching the seeded item's stem/answerCanonical.
    expect(logged[0].stemSnapshot).toBe("52 - 38 = ?");
    expect(logged[0].expectedAnswer).toBe("14");

    const errors = await errorEvents(t, scholarId);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({
      scholarId,
      nodeKey: SUB_SKILL,
      itemId,
      pattern: "SMALLER_FROM_LARGER",
    });
  });

  test("a multiple-choice attempt stores the tapped label, not its wire index", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.practiceSkills.seedGraph, {});
    const scholarId = await seedUser(t);
    const asScholar = await withUser(t, scholarId);
    const itemDocId = await insertConverseItem(t);
    const itemId = `gen#${itemDocId}`;

    const res = await asScholar.mutation(api.practiceSkills.submitAnswer, {
      scholarId,
      itemId,
      answer: "2",
    });
    expect(res.correct).toBe(false);

    const logged = await attempts(t, scholarId);
    expect(logged).toHaveLength(1);
    expect(logged[0]).toMatchObject({
      answerText: "If it does not rain, then the ground is not wet",
      expectedAnswer: "If the ground is wet, then it rains",
    });
  });

  test("a grade-only retry records a flagged diagnostic row without disturbing the first attempt", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.practiceSkills.seedGraph, {});
    const scholarId = await seedUser(t);
    const asScholar = await withUser(t, scholarId);
    const itemDocId = await insertBorrowItem(t);
    const itemId = `gen#${itemDocId}`;

    await asScholar.mutation(api.practiceSkills.submitAnswer, {
      scholarId,
      itemId,
      answer: "26",
    });
    await asScholar.mutation(api.practiceSkills.submitAnswer, {
      scholarId,
      itemId,
      answer: "14",
      record: false,
    });

    const logged = await attempts(t, scholarId);
    expect(logged).toHaveLength(2);

    // The first, scheduler-moving attempt is untouched and NOT flagged.
    const first = logged.find((row) => row.retry !== true);
    expect(first).toMatchObject({ itemId, correct: false, answerText: "26" });

    // The retry is captured as a diagnostic-only row: it stores the submitted
    // answer + outcome, is flagged `retry`, and carries NO lane / predictedRetention
    // (so the spiral-breaker and param-health calibration skip it).
    const retry = logged.find((row) => row.retry === true);
    expect(retry).toMatchObject({ itemId, correct: true, retry: true, answerText: "14" });
    expect(retry?.lane).toBeUndefined();
    expect(retry?.predictedRetention).toBeUndefined();

    // Mastery is unchanged by the grade-only retry: still a single recorded
    // attempt's worth of repetition.
    const mastery = await t.run(async (ctx) =>
      ctx.db
        .query("practiceMastery")
        .collect()
        .then((rows) => rows.filter((r) => r.scholarId === scholarId)),
    );
    expect(mastery).toHaveLength(1);
    expect(mastery[0].repetition).toBe(0);
  });

  test("a don't-know attempt records the don't-know reason and request time", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.practiceSkills.seedGraph, {});
    const scholarId = await seedUser(t);
    const asScholar = await withUser(t, scholarId);
    const itemDocId = await insertBorrowItem(t);
    const itemId = `gen#${itemDocId}`;
    const before = Date.now();

    const res = await asScholar.mutation(api.practiceSkills.submitAnswer, {
      scholarId,
      itemId,
      answer: "",
      dontKnow: true,
      elapsedMs: 7_500,
    });
    expect(res.correct).toBe(false);

    const logged = await attempts(t, scholarId);
    expect(logged).toHaveLength(1);
    expect(logged[0]).toMatchObject({
      itemId,
      correct: false,
      explanationReason: "dont_know",
      elapsedMs: 7_500,
    });
    expect(logged[0].explanationRequestedAt).toBeGreaterThanOrEqual(before);
    expect(logged[0].explanationStartedAt).toBeUndefined();
    expect(logged[0].explanationFinishedAt).toBeUndefined();
    // A Don't-Know carries no submitted answer, so it stores none.
    expect(logged[0].answerText).toBeUndefined();
  });
  test("a scholar's working attaches to their missed attempt, and only to a miss", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.practiceSkills.seedGraph, {});
    const scholarId = await seedUser(t);
    const asScholar = await withUser(t, scholarId);
    const itemDocId = await insertBorrowItem(t);
    const itemId = `gen#${itemDocId}`;
    const imageId = await t.run(async (ctx) => {
      const storageId = await ctx.storage.store(new Blob(["ink"]));
      await ctx.db.insert("practiceWorkImages", {
        scholarId,
        itemId,
        storageId,
        source: "miss",
        createdAt: Date.now(),
      });
      return storageId;
    });

    await asScholar.mutation(api.practiceSkills.submitAnswer, {
      scholarId,
      itemId,
      answer: "26",
    });
    const attached = await asScholar.mutation(api.practiceSkills.attachAttemptWork, {
      scholarId,
      itemId,
      imageId,
    });
    expect(attached.attached).toBe(true);
    expect((await attempts(t, scholarId))[0].workImageId).toBe(imageId);

    // Already carrying a working — a second capture never overwrites the first.
    const again = await asScholar.mutation(api.practiceSkills.attachAttemptWork, {
      scholarId,
      itemId,
      imageId,
    });
    expect(again.attached).toBe(false);
  });

  test("a teacher-preview call never attaches working to the scholar's attempt", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.practiceSkills.seedGraph, {});
    const scholarId = await seedUser(t);
    const asScholar = await withUser(t, scholarId);
    const teacherId = await seedUser(t, "teacher", {
      name: "Lehua Torres",
      username: "lehua",
    });
    const asTeacher = await withUser(t, teacherId);
    const itemDocId = await insertBorrowItem(t);
    const itemId = `gen#${itemDocId}`;
    // A teacher may legitimately mint the ownership row (authorizeUpload admits
    // a teacher), so ownership alone can't be what keeps a preview out.
    const imageId = await t.run(async (ctx) => {
      const storageId = await ctx.storage.store(new Blob(["ink"]));
      await ctx.db.insert("practiceWorkImages", {
        scholarId,
        itemId,
        storageId,
        source: "miss",
        createdAt: Date.now(),
      });
      return storageId;
    });

    await asScholar.mutation(api.practiceSkills.submitAnswer, {
      scholarId,
      itemId,
      answer: "26",
    });

    const previewed = await asTeacher.mutation(api.practiceSkills.attachAttemptWork, {
      scholarId,
      itemId,
      imageId,
    });
    expect(previewed.attached).toBe(false);
    expect((await attempts(t, scholarId))[0].workImageId).toBeUndefined();

    // The scholar's own capture still lands.
    const mine = await asScholar.mutation(api.practiceSkills.attachAttemptWork, {
      scholarId,
      itemId,
      imageId,
    });
    expect(mine.attached).toBe(true);
    expect((await attempts(t, scholarId))[0].workImageId).toBe(imageId);
  });

  test("working never attaches to a correct attempt, or to an item with none", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.practiceSkills.seedGraph, {});
    const scholarId = await seedUser(t);
    const asScholar = await withUser(t, scholarId);
    const itemDocId = await insertBorrowItem(t);
    const itemId = `gen#${itemDocId}`;
    const imageId = await t.run(async (ctx) => {
      const storageId = await ctx.storage.store(new Blob(["ink"]));
      await ctx.db.insert("practiceWorkImages", {
        scholarId,
        itemId,
        storageId,
        source: "miss",
        createdAt: Date.now(),
      });
      return storageId;
    });

    // No attempt at all → a silent no-op, never a throw the scholar could see.
    expect(
      (
        await asScholar.mutation(api.practiceSkills.attachAttemptWork, {
          scholarId,
          itemId,
          imageId,
        })
      ).attached,
    ).toBe(false);

    await asScholar.mutation(api.practiceSkills.submitAnswer, {
      scholarId,
      itemId,
      answer: "14",
    });
    expect(
      (
        await asScholar.mutation(api.practiceSkills.attachAttemptWork, {
          scholarId,
          itemId,
          imageId,
        })
      ).attached,
    ).toBe(false);
    expect((await attempts(t, scholarId))[0].workImageId).toBeUndefined();
  });

  test("recentMissesForNode is teacher-only — the scholar's own read is empty", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.practiceSkills.seedGraph, {});
    const scholarId = await seedUser(t);
    const asScholar = await withUser(t, scholarId);
    const teacherId = await seedUser(t, "teacher", { username: "tworking" });
    const asTeacher = await withUser(t, teacherId);
    const itemDocId = await insertBorrowItem(t);
    const itemId = `gen#${itemDocId}`;
    const imageId = await t.run(async (ctx) => {
      const storageId = await ctx.storage.store(new Blob(["ink"]));
      await ctx.db.insert("practiceWorkImages", {
        scholarId,
        itemId,
        storageId,
        source: "miss",
        createdAt: Date.now(),
      });
      return storageId;
    });

    await asScholar.mutation(api.practiceSkills.submitAnswer, {
      scholarId,
      itemId,
      answer: "26",
    });
    await asScholar.mutation(api.practiceSkills.attachAttemptWork, {
      scholarId,
      itemId,
      imageId,
    });

    const mine = await asScholar.query(api.practiceSkills.recentMissesForNode, {
      scholarId,
      nodeKey: SUB_SKILL,
    });
    expect(mine.misses).toHaveLength(0);

    const theirs = await asTeacher.query(api.practiceSkills.recentMissesForNode, {
      scholarId,
      nodeKey: SUB_SKILL,
    });
    expect(theirs.misses).toHaveLength(1);
    expect(theirs.misses[0].workImageUrl).toBeTruthy();
  });

  test("recentMissesForNode returns the snapshot + the correlated error pattern", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.practiceSkills.seedGraph, {});
    const scholarId = await seedUser(t);
    const asScholar = await withUser(t, scholarId);
    const teacherId = await seedUser(t, "teacher", { username: "tmisses" });
    const asTeacher = await withUser(t, teacherId);
    const itemDocId = await insertBorrowItem(t);
    const itemId = `gen#${itemDocId}`;

    await asScholar.mutation(api.practiceSkills.submitAnswer, {
      scholarId,
      itemId,
      answer: "26", // SMALLER_FROM_LARGER — see the classified-pattern test above.
    });

    const theirs = await asTeacher.query(api.practiceSkills.recentMissesForNode, {
      scholarId,
      nodeKey: SUB_SKILL,
    });
    expect(theirs.misses).toHaveLength(1);
    expect(theirs.misses[0]).toMatchObject({
      nodeKey: SUB_SKILL,
      stemSnapshot: "52 - 38 = ?",
      answerText: "26",
      expectedAnswer: "14",
      errorPattern: "Subtracts the smaller digit from the larger in each column — regrouping not yet stable.",
    });
  });

  test("recentMissesForNode collapses repeated retries of the same stuck item, keeping only the newest", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.practiceSkills.seedGraph, {});
    const scholarId = await seedUser(t);
    const asScholar = await withUser(t, scholarId);
    const teacherId = await seedUser(t, "teacher", { username: "tstuck" });
    const asTeacher = await withUser(t, teacherId);

    // A scholar stuck on ONE item, missing it three times via the grade-only
    // retry seam (record: false) — the Socratic-handoff loop's shape.
    const stuckItemDocId = await insertBorrowItem(t);
    const stuckItemId = `gen#${stuckItemDocId}`;
    for (let i = 0; i < 3; i++) {
      await asScholar.mutation(api.practiceSkills.submitAnswer, {
        scholarId,
        itemId: stuckItemId,
        answer: "26",
        record: false,
      });
    }

    // A miss on a genuinely DIFFERENT item, same node.
    const otherItemDocId = await t.run(async (ctx) =>
      ctx.db.insert("practiceItems", {
        skillKey: SUB_SKILL,
        domain: "whole-number-arithmetic",
        stem: "81 - 47 = ?",
        answerType: "integer",
        answerCanonical: "34",
        source: "generated",
        verifiedAt: Date.now(),
      }),
    );
    const otherItemId = `gen#${otherItemDocId}`;
    await asScholar.mutation(api.practiceSkills.submitAnswer, {
      scholarId,
      itemId: otherItemId,
      answer: "99",
    });

    // Sanity: 4 raw miss rows really do exist (3 retries + 1 distinct miss) —
    // the dedupe has to happen in the query, not upstream.
    const rawMisses = (await attempts(t, scholarId)).filter((row) => !row.correct);
    expect(rawMisses).toHaveLength(4);

    const theirs = await asTeacher.query(api.practiceSkills.recentMissesForNode, {
      scholarId,
      nodeKey: SUB_SKILL,
    });
    // Two DISTINCT problems, not three copies of the stuck one crowding out
    // the other — most-recent-first, newest retry standing in for the item.
    expect(theirs.misses).toHaveLength(2);
    expect(theirs.misses.map((m) => m.stemSnapshot)).toEqual(["81 - 47 = ?", "52 - 38 = ?"]);
  });

  test("recentAttemptsForDomain paginates every domain attempt newest-first", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.practiceSkills.seedGraph, {});
    const scholarId = await seedUser(t);
    const teacherId = await seedUser(t, "teacher", { username: "t-feed" });
    const asTeacher = await withUser(t, teacherId);

    await t.run(async (ctx) => {
      await ctx.db.insert("practiceAttempts", {
        scholarId,
        nodeKey: SUB_SKILL,
        itemId: "older-correct",
        correct: true,
        answerText: "14",
        domain: "whole-number-arithmetic",
        lane: "review",
        createdAt: 100,
      });
      await ctx.db.insert("practiceAttempts", {
        scholarId,
        nodeKey: SUB_SKILL,
        itemId: "newer-wrong",
        correct: false,
        answerText: "26",
        stemSnapshot: "52 - 38 = ?",
        expectedAnswer: "14",
        domain: "whole-number-arithmetic",
        lane: "frontier",
        createdAt: 200,
      });
      await ctx.db.insert("practiceErrorEvents", {
        scholarId,
        nodeKey: SUB_SKILL,
        domain: "whole-number-arithmetic",
        pattern: "SMALLER_FROM_LARGER",
        itemId: "newer-wrong",
        createdAt: 200,
      });
      await ctx.db.insert("practiceAttempts", {
        scholarId,
        nodeKey: SUB_SKILL,
        itemId: "other-domain",
        correct: false,
        domain: "another-domain",
        createdAt: 300,
      });
      await ctx.db.insert("practiceAttempts", {
        scholarId,
        nodeKey: SUB_SKILL,
        itemId: "dont-know",
        correct: false,
        explanationReason: "dont_know",
        domain: "whole-number-arithmetic",
        lane: "review",
        createdAt: 250,
      });
    });

    const first = await asTeacher.query(api.practiceSkills.recentAttemptsForDomain, {
      scholarId,
      domain: "whole-number-arithmetic",
      paginationOpts: { cursor: null, numItems: 1 },
    });
    expect(first.page).toHaveLength(1);
    expect(first.page[0]).toMatchObject({
      attemptId: expect.any(String),
      skillKey: SUB_SKILL,
      skillLabel: expect.any(String),
      at: 250,
      correct: false,
      dontKnow: true,
      lane: "review",
    });

    const next = await asTeacher.query(api.practiceSkills.recentAttemptsForDomain, {
      scholarId,
      domain: "whole-number-arithmetic",
      paginationOpts: { cursor: first.continueCursor, numItems: 1 },
    });
    expect(next.page[0]).toMatchObject({
      at: 200,
      correct: false,
      lane: "frontier",
      stemSnapshot: "52 - 38 = ?",
      answerText: "26",
      expectedAnswer: "14",
      errorPattern:
        "Subtracts the smaller digit from the larger in each column — regrouping not yet stable.",
    });

    const second = await asTeacher.query(api.practiceSkills.recentAttemptsForDomain, {
      scholarId,
      domain: "whole-number-arithmetic",
      paginationOpts: { cursor: next.continueCursor, numItems: 1 },
    });
    expect(second.page).toHaveLength(1);
    expect(second.page[0]).toMatchObject({
      at: 100,
      correct: true,
      lane: "review",
      answerText: "14",
    });
    expect(second.page[0].expectedAnswer).toBeUndefined();
  });

  test("recentAttemptsForDomain never pins an error pattern on a correct retry, keeps '0' answers, and skips legacy no-domain rows", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.practiceSkills.seedGraph, {});
    const scholarId = await seedUser(t);
    const teacherId = await seedUser(t, "teacher", { username: "t-feed2" });
    const asTeacher = await withUser(t, teacherId);

    await t.run(async (ctx) => {
      // Recorded miss + its classified error event…
      await ctx.db.insert("practiceAttempts", {
        scholarId,
        nodeKey: SUB_SKILL,
        itemId: "stuck-item",
        correct: false,
        answerText: "0",
        expectedAnswer: "0",
        stemSnapshot: "5 - 5 = ?",
        domain: "whole-number-arithmetic",
        createdAt: 200,
      });
      await ctx.db.insert("practiceErrorEvents", {
        scholarId,
        nodeKey: SUB_SKILL,
        domain: "whole-number-arithmetic",
        pattern: "SMALLER_FROM_LARGER",
        itemId: "stuck-item",
        createdAt: 200,
      });
      // …then the grade-only Socratic retry on the SAME item, moments later
      // and WITHIN the 60s itemId+time join tolerance, this time correct.
      // The join must not tag it with the miss's diagnosis.
      await ctx.db.insert("practiceAttempts", {
        scholarId,
        nodeKey: SUB_SKILL,
        itemId: "stuck-item",
        correct: true,
        retry: true,
        answerText: "0",
        domain: "whole-number-arithmetic",
        createdAt: 220,
      });
      // A legacy row with no domain must never appear in a domain feed.
      await ctx.db.insert("practiceAttempts", {
        scholarId,
        nodeKey: SUB_SKILL,
        itemId: "legacy-no-domain",
        correct: false,
        createdAt: 300_000,
      });
    });

    const res = await asTeacher.query(api.practiceSkills.recentAttemptsForDomain, {
      scholarId,
      domain: "whole-number-arithmetic",
      paginationOpts: { cursor: null, numItems: 10 },
    });
    expect(res.page.map((a) => a.at)).toEqual([220, 200]);
    const [retryRow, missRow] = res.page;
    expect(retryRow).toMatchObject({ correct: true, retry: true });
    expect(retryRow.errorPattern).toBeUndefined();
    expect(missRow.errorPattern).toContain("Subtracts the smaller digit");
    // "0" answers survive the optional-field spreads.
    expect(missRow).toMatchObject({
      answerText: "0",
      expectedAnswer: "0",
      stemSnapshot: "5 - 5 = ?",
    });
  });

  test("recentAttemptsForDomain returns an exhausted empty page for a domain with no attempts, and denies the scholar's own read", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.practiceSkills.seedGraph, {});
    const scholarId = await seedUser(t);
    const teacherId = await seedUser(t, "teacher", { username: "t-feed3" });
    const asTeacher = await withUser(t, teacherId);
    const asScholar = await withUser(t, scholarId);

    const empty = await asTeacher.query(api.practiceSkills.recentAttemptsForDomain, {
      scholarId,
      domain: "fraction-arithmetic",
      paginationOpts: { cursor: null, numItems: 10 },
    });
    expect(empty.page).toEqual([]);
    expect(empty.isDone).toBe(true);

    // Unlike the sibling's soft-empty read, this surface is a hard throw for
    // scholars — pinned so a later "harmonization" can't widen it silently.
    await expect(
      asScholar.query(api.practiceSkills.recentAttemptsForDomain, {
        scholarId,
        domain: "whole-number-arithmetic",
        paginationOpts: { cursor: null, numItems: 10 },
      }),
    ).rejects.toThrow("Forbidden: teacher or admin role required");
  });

  test("recentAttemptsForDomain denies teachers outside the scholar's institution", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.practiceSkills.seedGraph, {});
    const scholarId = await seedUser(t);
    const otherInstitutionId = await seedTestInstitution(t, {
      slug: "other-practice-feed-school",
    });
    const otherTeacherId = await seedStaffWithMembership(t, {
      institutionId: otherInstitutionId,
      username: "t-other-feed",
    });
    const asOtherTeacher = await withUser(t, otherTeacherId);

    await expect(
      asOtherTeacher.query(api.practiceSkills.recentAttemptsForDomain, {
        scholarId,
        domain: "whole-number-arithmetic",
        paginationOpts: { cursor: null, numItems: 10 },
      }),
    ).rejects.toThrow("Forbidden: scholar is not in your current context");
  });
});
