/**
 * #900 — teach-as-action mastery leak. `teachingStep` used to hand back the
 * item's answer (+ faded worked steps) for ANY item, and `submitAnswer`'s
 * scaffold guard only covered STORED items — so a scholar could read the reveal
 * for a TEMPLATE item (the serve path never scaffolds those) and submit it for
 * clean, green-eligible "practice" mastery.
 *
 * The fix keys both the reveal and the post-reveal scaffold on the durable
 * per-(scholar, item) "I haven't learned this yet" signal (a `dont_know` MISS in
 * practiceAttempts). These tests prove:
 *   1. no reveal before the scholar earns it;
 *   2. the reveal appears after an honest don't-know on THAT item;
 *   3. a correct attempt following that don't-know on the same TEMPLATE item
 *      lands the INFERRED "scaffolded" source (can't go green), whereas the same
 *      correct attempt WITHOUT a preceding don't-know lands "practice".
 */
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "../schema";
import { api } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import { generateItem } from "../lib/practice/templates";
import { makeItemId } from "../lib/practice/session";
import { SCAFFOLDED_SOURCE } from "../lib/practice/scheduler";

const modules = (
  import.meta as ImportMeta & {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("../**/*.ts");

// A real whole-number-arithmetic TEMPLATE family (multi-digit column addition):
// it carries ≥2 worked steps AND — crucially for #900 — the serve path never
// scaffolds template items, so the stored-item guard in submitAnswer never
// covered it. Deterministic in the seed, so the test derives the correct answer
// without the server ever sending it (resolveServableItem accepts this id).
const SKILL_KEY = "add_multidigit_algorithm";
const SEED = 12345;
const ITEM_ID = makeItemId(SKILL_KEY, SEED);

function correctAnswerString(): string {
  const gen = generateItem(SKILL_KEY, SEED);
  if (!gen || gen.answer.type !== "integer") {
    throw new Error("expected an integer template answer for the test fixture");
  }
  return String(gen.answer.value);
}

async function seedScholar(t: ReturnType<typeof convexTest>) {
  return await t.run(async (ctx) => {
    return await ctx.db.insert("users", {
      name: "Test Scholar",
      username: "teachstep_scholar",
      role: "scholar",
    });
  });
}

async function withUser(
  t: ReturnType<typeof convexTest>,
  userId: Id<"users">,
) {
  const sessionId = await t.run(async (ctx) => {
    const session: Omit<Doc<"authSessions">, "_id" | "_creationTime"> = {
      userId,
      expirationTime: Date.now() + 1000 * 60 * 60,
    };
    return await ctx.db.insert("authSessions", session);
  });
  return t.withIdentity({
    subject: `${userId}|${sessionId}`,
    issuer: "https://convex.dev",
  });
}

async function masterySource(
  t: ReturnType<typeof convexTest>,
  scholarId: Id<"users">,
): Promise<string | undefined> {
  return await t.run(async (ctx) => {
    const rows = await ctx.db.query("practiceMastery").collect();
    const row = rows.find(
      (r) => r.scholarId === scholarId && r.skillKey === SKILL_KEY,
    );
    return row?.source;
  });
}

describe("#900 teachingStep reveal is earned, not free", () => {
  test("teachingStep reveals nothing before the scholar earns it (no dont_know recorded)", async () => {
    const t = convexTest(schema, modules);
    const scholarId = await seedScholar(t);
    const asScholar = await withUser(t, scholarId);

    const res = await asScholar.query(api.practiceSkills.teachingStep, {
      scholarId,
      itemId: ITEM_ID,
    });

    expect(res.answer).toBeNull();
    expect(res.steps).toBeNull();
  });

  test("teachingStep reveals the answer after an honest 'I haven't learned this yet' on that item", async () => {
    const t = convexTest(schema, modules);
    const scholarId = await seedScholar(t);
    const asScholar = await withUser(t, scholarId);

    // Honest don't-know → recorded as a dont_know MISS for THIS item.
    await asScholar.mutation(api.practiceSkills.submitAnswer, {
      scholarId,
      itemId: ITEM_ID,
      answer: "",
      record: true,
      dontKnow: true,
    });

    const res = await asScholar.query(api.practiceSkills.teachingStep, {
      scholarId,
      itemId: ITEM_ID,
    });

    expect(res.answer).not.toBeNull();
    expect(res.answer).toBe(correctAnswerString());
  });

  test("a don't-know on ONE item does not unlock the reveal on a DIFFERENT item", async () => {
    const t = convexTest(schema, modules);
    const scholarId = await seedScholar(t);
    const asScholar = await withUser(t, scholarId);

    // Earn the reveal on ITEM_ID …
    await asScholar.mutation(api.practiceSkills.submitAnswer, {
      scholarId,
      itemId: ITEM_ID,
      answer: "",
      record: true,
      dontKnow: true,
    });

    // … but ask for a different item's reveal — still withheld.
    const otherItemId = makeItemId(SKILL_KEY, SEED + 1);
    const res = await asScholar.query(api.practiceSkills.teachingStep, {
      scholarId,
      itemId: otherItemId,
    });

    expect(res.answer).toBeNull();
    expect(res.steps).toBeNull();
  });
});

describe("#900 submitAnswer scaffold-forces a post-reveal correct attempt (template items)", () => {
  test("a correct TEMPLATE attempt with NO preceding don't-know lands a demonstrated 'practice' source (green-eligible)", async () => {
    const t = convexTest(schema, modules);
    const scholarId = await seedScholar(t);
    const asScholar = await withUser(t, scholarId);

    await asScholar.mutation(api.practiceSkills.submitAnswer, {
      scholarId,
      itemId: ITEM_ID,
      answer: correctAnswerString(),
      record: true,
    });

    // Baseline: the honest, unassisted path still records demonstrated practice.
    expect(await masterySource(t, scholarId)).toBe("practice");
  });

  test("a correct TEMPLATE attempt FOLLOWING a don't-know on the same item is scaffolded (inferred, NOT green-eligible)", async () => {
    const t = convexTest(schema, modules);
    const scholarId = await seedScholar(t);
    const asScholar = await withUser(t, scholarId);

    // 1) Earn the reveal (the leak's entry point).
    await asScholar.mutation(api.practiceSkills.submitAnswer, {
      scholarId,
      itemId: ITEM_ID,
      answer: "",
      record: true,
      dontKnow: true,
    });

    // 2) Submit the now-revealed correct answer for the SAME template item.
    await asScholar.mutation(api.practiceSkills.submitAnswer, {
      scholarId,
      itemId: ITEM_ID,
      answer: correctAnswerString(),
      record: true,
    });

    // The post-reveal correct attempt must NOT read as clean demonstrated
    // practice — it's forced to the inferred SCAFFOLDED_SOURCE, so it can't go
    // green. This is the template-item coverage the stored-item guard lacked.
    const source = await masterySource(t, scholarId);
    expect(source).toBe(SCAFFOLDED_SOURCE);
    expect(source).not.toBe("practice");
  });

  test("a grade-only retry (record:false) after a don't-know never touches mastery", async () => {
    const t = convexTest(schema, modules);
    const scholarId = await seedScholar(t);
    const asScholar = await withUser(t, scholarId);

    // Earn the reveal (records the only mastery-moving attempt: a miss).
    await asScholar.mutation(api.practiceSkills.submitAnswer, {
      scholarId,
      itemId: ITEM_ID,
      answer: "",
      record: true,
      dontKnow: true,
    });
    const afterDontKnow = await masterySource(t, scholarId);

    // A record:false retry returns a verdict but must not move mastery — the
    // scaffold-force lives on the recorded path only.
    await asScholar.mutation(api.practiceSkills.submitAnswer, {
      scholarId,
      itemId: ITEM_ID,
      answer: correctAnswerString(),
      record: false,
    });

    expect(await masterySource(t, scholarId)).toBe(afterDontKnow);
  });
});
