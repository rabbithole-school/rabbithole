import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "../schema";
import { api } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import {
  MANIPULATIVE_ANSWER_TYPE,
  MANIPULATIVE_VERIFIER_KIND,
} from "../../lib/manipulative/practiceContract";
import type {
  AreaPerimeterSpec,
  DistributorSpec,
  ManipulativeSpec,
  RekenrekSpec,
} from "../../lib/manipulative/types";

const modules = (
  import.meta as ImportMeta & {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("../**/*.ts");

const json = (v: unknown) => JSON.stringify(v);

async function seedScholar(t: ReturnType<typeof convexTest>) {
  return await t.run(async (ctx) =>
    ctx.db.insert("users", {
      name: "Manipulative Scholar",
      username: "manipulative-scholar",
      role: "scholar",
    }),
  );
}

async function asUser(t: ReturnType<typeof convexTest>, userId: Id<"users">) {
  const sessionId = await t.run(async (ctx) => {
    const session: Omit<Doc<"authSessions">, "_id" | "_creationTime"> = {
      userId,
      expirationTime: Date.now() + 3_600_000,
    };
    return ctx.db.insert("authSessions", session);
  });
  return t.withIdentity({ subject: `${userId}|${sessionId}`, issuer: "https://convex.dev" });
}

const spec: AreaPerimeterSpec = {
  kind: "areaPerimeter",
  id: "manip-ap-1",
  concept: "Area with fixed perimeter",
  prompt: "Fence in exactly 16 square units.",
  perimeter: 16,
  startWidth: 1,
  goal: { type: "areaEquals", value: 16 },
};

async function seedManipulativeItem(
  t: ReturnType<typeof convexTest>,
  itemSpec: ManipulativeSpec = spec,
  skillKey = "manipulative_area_perimeter_goal",
) {
  const domain = "whole-number-arithmetic";
  const itemId = await t.run(async (ctx) => {
    await ctx.db.insert("knowledgeNodes", {
      nodeKey: skillKey,
      label: itemSpec.concept,
      domain,
      strand: "geometry",
      source: "practice",
    });
    return await ctx.db.insert("practiceItems", {
      skillKey,
      domain,
      stem: itemSpec.prompt,
      answerType: MANIPULATIVE_ANSWER_TYPE,
      answerCanonical: "",
      verifierKind: MANIPULATIVE_VERIFIER_KIND,
      manipulativeSpec: json(itemSpec),
      source: "generated",
      verifiedAt: Date.now(),
    });
  });
  return { itemId: `gen#${itemId}`, skillKey };
}

const distributorSpec: DistributorSpec = {
  kind: "distributor",
  id: "manip-share-13-4",
  concept: "Division as sharing",
  prompt: "Share 13 onto 4 plates.",
  total: 13,
  groups: 4,
  goal: { type: "shareEqually" },
};

const rekenrekSpec: RekenrekSpec = {
  kind: "rekenrek",
  id: "manip-blast-13-10",
  concept: "Make-ten strategy",
  prompt: "Push 10 of the 13 beads across.",
  total: 13,
  goal: { type: "groupOf", value: 10 },
};

describe("practiceSkills.submitAnswer manipulative anti-offloading", () => {
  test("wrong and forged manipulative submissions never reveal an answer; correct state grades correct", async () => {
    const t = convexTest(schema, modules);
    const scholar = await seedScholar(t);
    const asScholar = await asUser(t, scholar);
    const { itemId, skillKey } = await seedManipulativeItem(t);

    const wrong = await asScholar.mutation(api.practiceSkills.submitAnswer, {
      scholarId: scholar,
      itemId,
      answer: json({ width: 3 }),
      elapsedMs: 12_345,
    });
    expect(wrong.correct).toBe(false);
    expect(wrong.correctAnswer).toBeUndefined();
    expect(wrong.skillKey).toBe(skillKey);
    const attempts = await t.run(async (ctx) =>
      ctx.db.query("practiceAttempts").collect(),
    );
    expect(attempts[0]).toMatchObject({
      itemId,
      correct: false,
      elapsedMs: 12_345,
    });
    expect(attempts[0].firstKeyMs).toBeUndefined();

    const forged = await asScholar.mutation(api.practiceSkills.submitAnswer, {
      scholarId: scholar,
      itemId,
      answer: "not json {",
    });
    expect(forged.correct).toBe(false);
    expect(forged.correctAnswer).toBeUndefined();

    const correct = await asScholar.mutation(api.practiceSkills.submitAnswer, {
      scholarId: scholar,
      itemId,
      answer: json({ width: 4 }),
    });
    expect(correct.correct).toBe(true);
    expect(correct.correctAnswer).toBeUndefined();
  });

  test("distributor item grades end-to-end: the max equal deal passes, under-dealing fails, no answer leaks", async () => {
    const t = convexTest(schema, modules);
    const scholar = await seedScholar(t);
    const asScholar = await asUser(t, scholar);
    const { itemId, skillKey } = await seedManipulativeItem(
      t,
      distributorSpec,
      "division_as_sharing",
    );

    // 13 ÷ 4 → 3 each (remainder 1) is the only correct deal.
    const under = await asScholar.mutation(api.practiceSkills.submitAnswer, {
      scholarId: scholar,
      itemId,
      answer: json({ perGroup: 2 }),
    });
    expect(under.correct).toBe(false);
    expect(under.correctAnswer).toBeUndefined();
    expect(under.skillKey).toBe(skillKey);

    const correct = await asScholar.mutation(api.practiceSkills.submitAnswer, {
      scholarId: scholar,
      itemId,
      answer: json({ perGroup: 3 }),
    });
    expect(correct.correct).toBe(true);
    expect(correct.correctAnswer).toBeUndefined();
  });

  test("rekenrek item grades end-to-end: a group of the target on either side passes", async () => {
    const t = convexTest(schema, modules);
    const scholar = await seedScholar(t);
    const asScholar = await asUser(t, scholar);
    const { itemId } = await seedManipulativeItem(t, rekenrekSpec, "make_ten_strategy");

    const off = await asScholar.mutation(api.practiceSkills.submitAnswer, {
      scholarId: scholar,
      itemId,
      answer: json({ left: 7 }),
    });
    expect(off.correct).toBe(false);
    expect(off.correctAnswer).toBeUndefined();

    // left group of 10, OR right group of 10 (left = 3) — both are a group of 10.
    for (const left of [10, 3]) {
      const hit = await asScholar.mutation(api.practiceSkills.submitAnswer, {
        scholarId: scholar,
        itemId,
        answer: json({ left }),
      });
      expect(hit.correct).toBe(true);
      expect(hit.correctAnswer).toBeUndefined();
    }
  });
});
