import { convexTest } from "convex-test";
import { describe, expect, test, vi } from "vitest";
import schema from "../schema";
import { api, internal } from "../_generated/api";
import { MANIPULATIVE_VERIFIER_KIND } from "../../lib/manipulative/practiceContract";
import { parseManipulativeSpec } from "../../lib/manipulative/grade";
import type { ManipulativeSpec } from "../../lib/manipulative/types";
import {
  isSolved,
  initialArray,
  initialDistribute,
  initialDistributor,
  initialFunctionMachine,
  initialNumberLine,
  initialRekenrek,
} from "../../lib/manipulative/logic";

const modules = (
  import.meta as ImportMeta & {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("../**/*.ts");

/**
 * Content-coverage wave 1 (review/content-coverage-audit.md, ranks 1-3):
 * `seedDefaultManipulativePractice` (convex/practiceSkills.ts) now authors a
 * default manipulative for 35 additional whole-number-arithmetic nodes across
 * add-subtract, mult-divide, and place-value. This locks TWO invariants for
 * every one of them, keyed by the spec `id` chosen at authoring time:
 *
 *   1. NOT pre-solved — the kind-appropriate initial state (what a scholar
 *      actually sees on mount) must fail `isSolved`. A manipulative must
 *      never hand out a puzzle that's already done.
 *   2. Solvable by construction — the INTENDED solution state (the concrete
 *      numbers baked into the prompt, e.g. "23 + 14 = 37") makes `isSolved`
 *      return true. This is the "every new spec passes isSolved with its
 *      intended solution state" guarantee from the task brief; it exercises
 *      the exact same pure grader `gradeManipulativeSubmission` runs
 *      server-side (see convex/__tests__/manipulativeSubmitAnswer.test.ts for
 *      the end-to-end submit path on a couple of these kinds already).
 *
 * Any regression here — a mis-typed number, a goal that doesn't match the
 * story in the prompt, a spec that's accidentally already solved on mount —
 * fails loudly instead of silently shipping an ungradable or trivial item.
 */
const WAVE1_SOLUTIONS: Record<string, unknown> = {
  // add-subtract — open number line (counting on/back) + Dot Blaster (compose/
  // decompose, make-ten regrouping).
  "count-on-23-plus-14": { value: 37 },
  "count-on-12-plus-5": { value: 17 },
  "blast-regroup-8-plus-7": { left: 10 },
  "count-back-38-minus-15": { value: 23 },
  "count-back-18-minus-6": { value: 12 },
  "count-on-27-plus-35": { value: 62 },
  "count-back-42-minus-27": { value: 15 },
  "blast-compose-6-plus-4": { left: 6 },
  "blast-compose-3-plus-2": { left: 3 },
  "count-back-9-minus-4": { value: 5 },
  "count-back-5-minus-3": { value: 2 },

  // mult-divide — number line skip-counting, array (multiplication as area),
  // distribute (area-model partial products), distributor (equal sharing),
  // function machine (a two-step expression IS an affine rule).
  "skip-count-by-2s-to-14": { value: 14 },
  "array-commutative-3x4": { rows: 3, cols: 4 },
  "distribute-4x7-at-5": { column: 5 },
  "share-42-by-7": { perGroup: 6 },
  "share-25-by-5": { perGroup: 5 },
  "array-2x5": { rows: 2, cols: 5 },
  "array-4x6": { rows: 4, cols: 6 },
  "array-7x8": { rows: 7, cols: 8 },
  "skip-count-by-3s-to-15": { value: 15 },
  "skip-count-by-7s-to-21": { value: 21 },
  "array-4-groups-of-5": { rows: 4, cols: 5 },
  "array-3x5-intro": { rows: 3, cols: 5 },
  "distribute-6x13-at-10": { column: 10 },
  "distribute-4x15-at-10": { column: 10 },
  "distribute-3x124-at-100": { column: 100 },
  "distribute-14x23-at-20": { column: 20 },
  "function-machine-2x-plus-3": { predicted: 13 },

  // place-value — number line (comparison-by-position, ten more/less,
  // rounding-to-nearest-multiple) + Dot Blaster (compose ten).
  "compare-47-vs-32": { value: 47 },
  "ten-more-than-34": { value: 44 },
  "compare-245-vs-198": { value: 245 },
  "place-350-to-1000": { value: 350 },
  "round-47-to-nearest-10": { value: 50 },
  "round-3482-to-nearest-1000": { value: 3000 },
  "blast-compose-ten-pair": { left: 4 },
};

function initialStateForTest(spec: ManipulativeSpec): unknown {
  switch (spec.kind) {
    case "numberline":
      return initialNumberLine(spec);
    case "array":
      return initialArray(spec);
    case "rekenrek":
      return initialRekenrek(spec);
    case "distribute":
      return initialDistribute(spec);
    case "distributor":
      return initialDistributor(spec);
    case "functionMachine":
      return initialFunctionMachine();
    default:
      throw new Error(`content-coverage wave 1 fixture used an unexpected kind: ${spec.kind}`);
  }
}

describe("content-coverage wave 1 — default manipulative seed (whole-number-arithmetic)", () => {
  test("every wave-1 spec is not pre-solved, and its intended solution passes isSolved", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.practiceSkills.seedGraph, {});
    await t.mutation(internal.practiceSkills.seedDefaultManipulativePractice, {});

    const rows = await t.run(async (ctx) => ctx.db.query("practiceItems").collect());
    const manipRows = rows.filter((r) => r.verifierKind === MANIPULATIVE_VERIFIER_KIND);

    const found = new Set<string>();
    for (const row of manipRows) {
      const spec = parseManipulativeSpec(row.manipulativeSpec);
      if (!spec) continue;
      const solution = WAVE1_SOLUTIONS[spec.id];
      if (!solution) continue; // a pre-existing fixture spec, outside this wave.
      found.add(spec.id);

      expect(isSolved(spec, initialStateForTest(spec))).toBe(false);
      expect(isSolved(spec, solution)).toBe(true);
    }

    // Every wave-1 id was actually served from the seed (skillKey resolved to
    // a real knowledgeNodes row and the insert succeeded) — a typo'd id or a
    // silently-dropped entry fails here rather than passing vacuously.
    for (const id of Object.keys(WAVE1_SOLUTIONS)) {
      expect(found.has(id)).toBe(true);
    }
    expect(found.size).toBe(Object.keys(WAVE1_SOLUTIONS).length);
  });

  test("no-regroup number-line prompts don't telegraph the strategy in the stem", async () => {
    // A scholar flagged "Start at 23. Count on 14 — no regrouping needed.
    // Where do you land?" as giving away the intended solving strategy before
    // they'd reasoned about it. The prompt should pose the computation
    // cleanly; naming the strategy belongs in a hint/scaffold, not the stem.
    const t = convexTest(schema, modules);
    await t.mutation(internal.practiceSkills.seedGraph, {});
    await t.mutation(internal.practiceSkills.seedDefaultManipulativePractice, {});

    const rows = await t.run(async (ctx) => ctx.db.query("practiceItems").collect());
    const manipRows = rows.filter((r) => r.verifierKind === MANIPULATIVE_VERIFIER_KIND);

    const flaggedIds = ["count-on-23-plus-14", "count-back-38-minus-15"];
    const seen = new Set<string>();
    for (const row of manipRows) {
      const spec = parseManipulativeSpec(row.manipulativeSpec);
      if (!spec || !flaggedIds.includes(spec.id)) continue;
      seen.add(spec.id);
      const prompt = "prompt" in spec ? spec.prompt : "";
      expect(prompt.toLowerCase(), prompt).not.toContain("no regrouping");
      expect(prompt.toLowerCase(), prompt).not.toContain("regrouping needed");
    }
    expect(seen.size).toBe(flaggedIds.length);
  });

  test("counting-on number-line prompts explicitly describe forward one-step moves", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.practiceSkills.seedGraph, {});
    await t.mutation(internal.practiceSkills.seedDefaultManipulativePractice, {});

    const expectedPrompts = new Map([
      ["count-on-23-plus-14", "Start at 23. Count forward 14 steps. Where do you land?"],
      ["count-on-12-plus-5", "Start at 12. Count forward 5 steps. Where do you land?"],
      ["numberline-count-on-4-plus-3", "Start at 4. Count forward 3 steps — where do you land?"],
    ]);
    const rows = await t.run(async (ctx) => ctx.db.query("practiceItems").collect());
    const seen = new Set<string>();

    for (const row of rows) {
      const spec = parseManipulativeSpec(row.manipulativeSpec);
      if (!spec || !expectedPrompts.has(spec.id)) continue;
      seen.add(spec.id);
      expect("prompt" in spec ? spec.prompt : "").toBe(expectedPrompts.get(spec.id));
    }

    expect(seen.size).toBe(expectedPrompts.size);
  });

  test("prompt copy updates preserve an already-served manipulative row id", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.practiceSkills.seedGraph, {});
    await t.mutation(internal.practiceSkills.seedDefaultManipulativePractice, {});

    const rows = await t.run(async (ctx) => ctx.db.query("practiceItems").collect());
    const existing = rows.find((row) => {
      const spec = parseManipulativeSpec(row.manipulativeSpec);
      return spec?.id === "count-on-12-plus-5";
    });
    expect(existing).toBeDefined();
    if (!existing) throw new Error("count-on-12-plus-5 was not seeded");

    const spec = parseManipulativeSpec(existing.manipulativeSpec);
    expect(spec).not.toBeNull();
    if (!spec) throw new Error("count-on-12-plus-5 spec was not parseable");
    const legacyPrompt = "Start at 12. Count on 5. Where do you land?";
    await t.run(async (ctx) =>
      ctx.db.patch(existing._id, {
        stem: legacyPrompt,
        manipulativeSpec: JSON.stringify({ ...spec, prompt: legacyPrompt }),
      }),
    );

    await t.mutation(internal.practiceSkills.seedDefaultManipulativePractice, {});

    const updated = await t.run(async (ctx) => ctx.db.get(existing._id));
    expect(updated?.stem).toBe("Start at 12. Count forward 5 steps. Where do you land?");
    expect(parseManipulativeSpec(updated?.manipulativeSpec)?.prompt).toBe(
      "Start at 12. Count forward 5 steps. Where do you land?",
    );
  });

  test("retires the ambiguous comparison item and resets its evidence for a clean review", async () => {
    const now = Date.UTC(2026, 7, 28, 12, 0, 0);
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const t = convexTest(schema, modules);
    await t.mutation(internal.practiceSkills.seedGraph, {});

    const fixture = await t.run(async (ctx) => {
      const scholarId = await ctx.db.insert("users", {
        name: "Retirement Test",
        username: "retirement-test",
        role: "scholar",
      });
      const itemId = await ctx.db.insert("practiceItems", {
        skillKey: "compare_multidigit",
        domain: "whole-number-arithmetic",
        stem: "Place 4,200 on the line. Is it more or less than the marked 3,800?",
        answerType: "manipulative",
        answerCanonical: "",
        verifierKind: MANIPULATIVE_VERIFIER_KIND,
        manipulativeSpec: JSON.stringify({
          kind: "numberline",
          id: "compare-4200-vs-3800",
          concept: "Comparing multi-digit numbers",
          prompt:
            "Place 4,200 on the line. Is it more or less than the marked 3,800?",
          min: 0,
          max: 10000,
          tickStep: 1000,
          snap: 100,
          start: 1000,
          markers: [{ value: 3800, label: "3,800" }],
          goal: { type: "placeAt", value: 4200, tolerance: 0.5 },
        }),
        source: "generated",
        verifiedAt: now - 20_000,
      });
      const storedItemId = `gen#${itemId}`;
      const validAttemptId = await ctx.db.insert("practiceAttempts", {
        scholarId,
        nodeKey: "compare_multidigit",
        itemId: "compare_multidigit#123",
        correct: true,
        domain: "whole-number-arithmetic",
        lane: "review",
        createdAt: now - 10_000,
      });
      await ctx.db.insert("practiceAttempts", {
        scholarId,
        nodeKey: "compare_multidigit",
        itemId: storedItemId,
        correct: false,
        answerText: JSON.stringify({ value: 5200 }),
        domain: "whole-number-arithmetic",
        lane: "review",
        repetitionBefore: 3,
        halfLifeBefore: 4,
        source: "placement",
        createdAt: now - 5_000,
      });
      await ctx.db.insert("practiceAttempts", {
        scholarId,
        nodeKey: "compare_multidigit",
        itemId: storedItemId,
        correct: true,
        answerText: JSON.stringify({ value: 4200 }),
        domain: "whole-number-arithmetic",
        lane: "review",
        repetitionBefore: 3,
        halfLifeBefore: 2,
        source: "placement",
        createdAt: now - 2_000,
      });
      await ctx.db.insert("practiceErrorEvents", {
        scholarId,
        nodeKey: "compare_multidigit",
        domain: "whole-number-arithmetic",
        pattern: "wrong_operation",
        itemId: storedItemId,
        createdAt: now - 5_000,
      });
      const masteryId = await ctx.db.insert("practiceMastery", {
        scholarId,
        skillKey: "compare_multidigit",
        domain: "whole-number-arithmetic",
        repetition: 4,
        halfLifeDays: 2,
        lastPracticedAt: now - 2_000,
        lastAttemptAt: now - 2_000,
        frontier: false,
        source: "practice",
        accelStreak: 1,
        missStreak: 2,
        latencySamplesMs: [1_000],
        latencyMedianMs: 1_000,
        latencySpreadMs: 0,
        becameFluentAt: now - 2_000,
        frontierAdvancedAt: now - 2_000,
        updatedAt: now - 2_000,
      });
      return { itemId, validAttemptId, masteryId };
    });

    await expect(
      t.mutation(
        internal.practiceSkills.retireAmbiguousCompareManipulative,
        { dryRun: true },
      ),
    ).resolves.toEqual({
      dryRun: true,
      practiceItemId: fixture.itemId,
      invalidatedAttempts: 2,
      repairedScholars: 1,
      deletedErrorEvents: 0,
      continueCursor: null,
      nextPhase: "errors",
      isDone: false,
    });
    expect(await t.run((ctx) => ctx.db.get(fixture.itemId))).not.toBeNull();
    await expect(
      t.query(api.practiceSkills.getManipulativeItem, {
        itemId: `gen#${fixture.itemId}`,
      }),
    ).resolves.toBeNull();
    await expect(
      t.query(internal.practiceSkills.manipulativeHandoffContext, {
        itemId: `gen#${fixture.itemId}`,
        stateJson: JSON.stringify({ value: 5_200 }),
      }),
    ).resolves.toBeNull();

    await expect(
      t.mutation(
        internal.practiceSkills.retireAmbiguousCompareManipulative,
        { dryRun: false },
      ),
    ).resolves.toEqual({
      dryRun: false,
      practiceItemId: fixture.itemId,
      invalidatedAttempts: 2,
      repairedScholars: 1,
      deletedErrorEvents: 0,
      continueCursor: null,
      nextPhase: "errors",
      isDone: false,
    });
    await expect(
      t.mutation(
        internal.practiceSkills.retireAmbiguousCompareManipulative,
        {
          dryRun: false,
          practiceItemId: fixture.itemId,
          phase: "errors",
        },
      ),
    ).resolves.toEqual({
      dryRun: false,
      practiceItemId: fixture.itemId,
      invalidatedAttempts: 0,
      repairedScholars: 0,
      deletedErrorEvents: 1,
      continueCursor: null,
      nextPhase: null,
      isDone: true,
    });

    const repaired = await t.run(async (ctx) => ({
      item: await ctx.db.get(fixture.itemId),
      attempts: await ctx.db.query("practiceAttempts").collect(),
      errors: await ctx.db.query("practiceErrorEvents").collect(),
      mastery: await ctx.db.get(fixture.masteryId),
    }));
    expect(repaired.item).toBeNull();
    expect(repaired.attempts.map((attempt) => attempt._id)).toEqual([
      fixture.validAttemptId,
    ]);
    expect(repaired.errors).toEqual([]);
    expect(repaired.mastery).toMatchObject({
      repetition: 3,
      halfLifeDays: 1,
      lastPracticedAt: now - 2 * 86_400_000,
      source: "content_repair",
      accelStreak: 0,
      missStreak: 0,
      updatedAt: now,
    });
    expect(repaired.mastery?.lastAttemptAt).toBeUndefined();
    expect(repaired.mastery?.latencySamplesMs).toBeUndefined();
    expect(repaired.mastery?.latencyMedianMs).toBeUndefined();
    expect(repaired.mastery?.latencySpreadMs).toBeUndefined();
    expect(repaired.mastery?.becameFluentAt).toBeUndefined();
    expect(repaired.mastery?.frontierAdvancedAt).toBeUndefined();

    await t.mutation(
      internal.practiceSkills.seedDefaultManipulativePractice,
      {},
    );
    const retiredWasNotRecreated = await t.run(async (ctx) => {
      const rows = await ctx.db
        .query("practiceItems")
        .withIndex("by_skill", (q) => q.eq("skillKey", "compare_multidigit"))
        .collect();
      return rows.some(
        (row) =>
          parseManipulativeSpec(row.manipulativeSpec)?.id ===
          "compare-4200-vs-3800",
      );
    });
    expect(retiredWasNotRecreated).toBe(false);
    await expect(
      t.mutation(
        internal.practiceSkills.retireAmbiguousCompareManipulative,
        { dryRun: false },
      ),
    ).resolves.toMatchObject({
      practiceItemId: null,
      invalidatedAttempts: 0,
      repairedScholars: 0,
      deletedErrorEvents: 0,
      nextPhase: null,
      isDone: true,
    });
    vi.useRealTimers();
  });

  test("repairs retired evidence in bounded pages and deletes the item only after the final page", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-01T12:00:00Z"));
    const t = convexTest(schema, modules);
    const fixture = await t.run(async (ctx) => {
      const scholarIds = [];
      for (let index = 0; index < 26; index += 1) {
        scholarIds.push(
          await ctx.db.insert("users", {
            username: `retired-manipulative-${index}`,
            name: `Retired Manipulative ${index}`,
            role: "scholar",
          }),
        );
      }
      const itemId = await ctx.db.insert("practiceItems", {
        skillKey: "compare_multidigit",
        domain: "whole-number-arithmetic",
        stem: "Place 4,200 on the line. Is it more or less than the marked 3,800?",
        answerType: "manipulative",
        answerCanonical: "",
        verifierKind: MANIPULATIVE_VERIFIER_KIND,
        manipulativeSpec: JSON.stringify({
          kind: "numberline",
          id: "compare-4200-vs-3800",
          concept: "Comparing multi-digit numbers",
          prompt:
            "Place 4,200 on the line. Is it more or less than the marked 3,800?",
          min: 0,
          max: 10000,
          tickStep: 1000,
          snap: 100,
          start: 1000,
          markers: [{ value: 3800, label: "3,800" }],
          goal: { type: "placeAt", value: 4200, tolerance: 0.5 },
        }),
        source: "generated",
        verifiedAt: Date.now(),
      });
      let lowEvidenceMasteryId;
      for (const [index, scholarId] of scholarIds.entries()) {
        await ctx.db.insert("practiceAttempts", {
          scholarId,
          nodeKey: "compare_multidigit",
          itemId: `gen#${itemId}`,
          answerText: JSON.stringify({ value: 5_200 }),
          correct: index === 0,
          domain: "whole-number-arithmetic",
          lane: "review",
          createdAt: Date.now() - index,
        });
        const masteryId = await ctx.db.insert("practiceMastery", {
          scholarId,
          skillKey: "compare_multidigit",
          domain: "whole-number-arithmetic",
          repetition: index === 0 ? 1 : 2,
          halfLifeDays: 0.5,
          lastPracticedAt: Date.now() - index,
          lastAttemptAt: Date.now() - index,
          frontier: false,
          source: "practice",
          updatedAt: Date.now() - index,
        });
        if (index === 0) lowEvidenceMasteryId = masteryId;
        await ctx.db.insert("practiceErrorEvents", {
          scholarId,
          nodeKey: "compare_multidigit",
          domain: "whole-number-arithmetic",
          pattern: "wrong_operation",
          itemId: `gen#${itemId}`,
          createdAt: Date.now() - index,
        });
      }
      const spanningAttemptAt = Date.now() + 100;
      await ctx.db.insert("practiceAttempts", {
        scholarId: scholarIds[0],
        nodeKey: "compare_multidigit",
        itemId: `gen#${itemId}`,
        answerText: JSON.stringify({ value: 5_300 }),
        correct: false,
        domain: "whole-number-arithmetic",
        lane: "review",
        createdAt: spanningAttemptAt,
      });
      await ctx.db.patch(lowEvidenceMasteryId!, {
        lastAttemptAt: spanningAttemptAt,
      });
      return {
        itemId,
        lowEvidenceMasteryId: lowEvidenceMasteryId!,
        spanningAttemptAt,
      };
    });

    const firstPage = await t.mutation(
      internal.practiceSkills.retireAmbiguousCompareManipulative,
      { dryRun: false },
    );
    expect(firstPage).toMatchObject({
      practiceItemId: fixture.itemId,
      invalidatedAttempts: 25,
      repairedScholars: 25,
      deletedErrorEvents: 0,
      nextPhase: "attempts",
      isDone: false,
    });
    expect(firstPage.continueCursor).toEqual(expect.any(String));
    expect(await t.run((ctx) => ctx.db.get(fixture.itemId))).not.toBeNull();
    expect(
      await t.run((ctx) => ctx.db.get(fixture.lowEvidenceMasteryId)),
    ).toMatchObject({
      repetition: 0,
      source: "content_repair",
      lastAttemptAt: fixture.spanningAttemptAt,
    });
    await expect(
      t.mutation(
        internal.practiceSkills.retireAmbiguousCompareManipulative,
        {
          dryRun: false,
          practiceItemId: fixture.itemId,
          phase: "errors",
        },
      ),
    ).rejects.toThrow("finish the attempts phase");

    const secondPage = await t.mutation(
      internal.practiceSkills.retireAmbiguousCompareManipulative,
      {
        dryRun: false,
        practiceItemId: fixture.itemId,
        cursor: firstPage.continueCursor ?? undefined,
        phase: firstPage.nextPhase ?? undefined,
      },
    );
    expect(secondPage).toEqual({
      dryRun: false,
      practiceItemId: fixture.itemId,
      invalidatedAttempts: 2,
      repairedScholars: 2,
      deletedErrorEvents: 0,
      continueCursor: null,
      nextPhase: "errors",
      isDone: false,
    });
    expect(
      (await t.run((ctx) => ctx.db.get(fixture.lowEvidenceMasteryId)))
        ?.lastAttemptAt,
    ).toBeUndefined();
    expect(await t.run((ctx) => ctx.db.get(fixture.itemId))).not.toBeNull();

    const firstErrorPage = await t.mutation(
      internal.practiceSkills.retireAmbiguousCompareManipulative,
      {
        dryRun: false,
        practiceItemId: fixture.itemId,
        phase: secondPage.nextPhase ?? undefined,
      },
    );
    expect(firstErrorPage).toEqual({
      dryRun: false,
      practiceItemId: fixture.itemId,
      invalidatedAttempts: 0,
      repairedScholars: 0,
      deletedErrorEvents: 25,
      continueCursor: expect.any(String),
      nextPhase: "errors",
      isDone: false,
    });
    expect(await t.run((ctx) => ctx.db.get(fixture.itemId))).not.toBeNull();

    await expect(
      t.mutation(
        internal.practiceSkills.retireAmbiguousCompareManipulative,
        {
          dryRun: false,
          practiceItemId: fixture.itemId,
          cursor: firstErrorPage.continueCursor ?? undefined,
          phase: firstErrorPage.nextPhase ?? undefined,
        },
      ),
    ).resolves.toEqual({
      dryRun: false,
      practiceItemId: fixture.itemId,
      invalidatedAttempts: 0,
      repairedScholars: 0,
      deletedErrorEvents: 1,
      continueCursor: null,
      nextPhase: null,
      isDone: true,
    });
    expect(await t.run((ctx) => ctx.db.get(fixture.itemId))).toBeNull();
    vi.useRealTimers();
  });
});
