/**
 * Backward-faded worked examples (SPIKE) — serving- and grading-path
 * integration test. Pure fade-level/apply-fade logic is unit-tested directly in
 * convex/lib/practice/fadedSteps.test.ts; this file proves the WIRING:
 * `practiceSession` attaches the fade for a stored `practiceItems` row that
 * carries `workedSteps`, keyed off the scholar's OWN `practiceMastery` row for
 * that skill, and never leaks a faded step's real text over the wire; and
 * `submitAnswer` grades a correct answer produced with the scaffold still
 * visible as ASSISTED (an inferred `scaffolded` source that never goes green),
 * while a correct answer on a bare problem is a real demonstration.
 */
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "../schema";
import { api } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import {
  DEMONSTRATED_SOURCES,
  FLUENT_REPS,
  SCAFFOLDED_SOURCE,
  isFluent,
} from "../lib/practice/scheduler";

const modules = (
  import.meta as ImportMeta & {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("../**/*.ts");

const DOMAIN = "whole-number-arithmetic";
const SKILL_KEY = "faded_step_test_skill";

const WORKED_STEPS = [
  { text: "Find a common denominator for 4 and 3: 12.", blankText: "Find a common denominator: ___" },
  { text: "Convert: 1/4 = 3/12 and 1/3 = 4/12.", blankText: "Convert both fractions: ___" },
  { text: "Add the numerators: 3/12 + 4/12 = 7/12.", blankText: "Add the numerators: ___" },
  { text: "Simplify: 7/12 is already in lowest terms.", blankText: "Simplify the result: ___" },
];

async function seedScholar(t: ReturnType<typeof convexTest>) {
  return await t.run(async (ctx) =>
    ctx.db.insert("users", {
      name: "Faded Steps Scholar",
      username: "faded-steps-scholar",
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

async function seedItemWithWorkedSteps(t: ReturnType<typeof convexTest>) {
  return await t.run(async (ctx) => {
    await ctx.db.insert("knowledgeNodes", {
      nodeKey: SKILL_KEY,
      label: "Faded-step test skill",
      domain: DOMAIN,
      strand: "operations",
      source: "practice",
    });
    return ctx.db.insert("practiceItems", {
      skillKey: SKILL_KEY,
      domain: DOMAIN,
      stem: "Add: 1/4 + 1/3",
      answerType: "fraction",
      answerCanonical: "7/12",
      verifierKind: "arithmetic",
      workedSteps: WORKED_STEPS,
      source: "generated",
      verifiedAt: Date.now(),
    });
  });
}

async function readMastery(
  t: ReturnType<typeof convexTest>,
  scholarId: Id<"users">,
): Promise<Doc<"practiceMastery"> | null> {
  return await t.run(async (ctx) => {
    const rows = (await ctx.db
      .query("practiceMastery")
      .collect()) as Doc<"practiceMastery">[];
    return (
      rows.find((r) => r.scholarId === scholarId && r.skillKey === SKILL_KEY) ?? null
    );
  });
}

async function seedMastery(
  t: ReturnType<typeof convexTest>,
  scholarId: Id<"users">,
  repetition: number,
  source = "practice",
) {
  await t.run(async (ctx) =>
    ctx.db.insert("practiceMastery", {
      scholarId,
      skillKey: SKILL_KEY,
      domain: DOMAIN,
      repetition,
      halfLifeDays: 1,
      frontier: false,
      source,
      updatedAt: Date.now(),
    }),
  );
}

describe("practiceSession — backward-faded worked examples", () => {
  test("no mastery row (not_started): last (answer-producing) step faded, never a full key", async () => {
    const t = convexTest(schema, modules);
    const scholar = await seedScholar(t);
    const asScholar = await asUser(t, scholar);
    await seedItemWithWorkedSteps(t);

    const { items } = await asScholar.query(api.practiceSkills.practiceSession, {
      scholarId: scholar,
      seed: 1,
      domain: DOMAIN,
      skillKeys: [SKILL_KEY],
      size: 1,
    });

    expect(items).toHaveLength(1);
    const item = items[0];
    expect(item.workedSteps).toBeDefined();
    // Completion effect: even a not-started scholar gets level 1 (last step
    // faded), never a fully-revealed answer key.
    expect(item.scaffoldLevel).toBe(1);
    expect(item.workedSteps!.revealed).toHaveLength(3);
    expect(item.workedSteps!.faded).toHaveLength(1);
    expect(item.workedSteps!.revealed.map((s) => s.text)).toEqual(
      WORKED_STEPS.slice(0, 3).map((s) => s.text),
    );
    expect(item.workedSteps!.faded[0]).toEqual({ blankText: "Simplify the result: ___" });
    expect(item.workedSteps!.selfExplainPrompt).toBeTruthy();

    // The last step's real text (the answer-producing move) is never sent.
    const lastStepRealText = WORKED_STEPS[WORKED_STEPS.length - 1].text;
    expect(JSON.stringify(items).includes(lastStepRealText)).toBe(false);
  });

  test("repetition 1 (practicing): last TWO steps faded, their real text absent from the WHOLE payload", async () => {
    const t = convexTest(schema, modules);
    const scholar = await seedScholar(t);
    const asScholar = await asUser(t, scholar);
    await seedItemWithWorkedSteps(t);
    await seedMastery(t, scholar, 1);

    const result = await asScholar.query(api.practiceSkills.practiceSession, {
      scholarId: scholar,
      seed: 1,
      domain: DOMAIN,
      skillKeys: [SKILL_KEY],
      size: 1,
    });

    const item = result.items[0];
    expect(item.scaffoldLevel).toBe(2);
    expect(item.workedSteps!.revealed).toHaveLength(2);
    expect(item.workedSteps!.faded).toHaveLength(2);
    expect(item.workedSteps!.faded).toEqual([
      { blankText: "Add the numerators: ___" },
      { blankText: "Simplify the result: ___" },
    ]);
    expect(item.workedSteps!.selfExplainPrompt).toBeTruthy();

    // Anti-cheat: the faded steps' REAL text must not appear anywhere in the
    // whole serialized response — not just the `faded` array.
    const serialized = JSON.stringify(result);
    for (const step of WORKED_STEPS.slice(2)) {
      expect(serialized.includes(step.text)).toBe(false);
    }
  });

  test("fluent scholar (repetition >= FLUENT_REPS): bare problem, nothing revealed", async () => {
    const t = convexTest(schema, modules);
    const scholar = await seedScholar(t);
    const asScholar = await asUser(t, scholar);
    await seedItemWithWorkedSteps(t);
    await seedMastery(t, scholar, FLUENT_REPS);

    const { items } = await asScholar.query(api.practiceSkills.practiceSession, {
      scholarId: scholar,
      seed: 1,
      domain: DOMAIN,
      skillKeys: [SKILL_KEY],
      size: 1,
    });

    const item = items[0];
    expect(item.scaffoldLevel).toBe(4);
    expect(item.workedSteps!.revealed).toHaveLength(0);
    expect(item.workedSteps!.faded).toHaveLength(4);
    // Fully bare — nothing to build on, so no completion prompt (the frontend
    // renders no scaffold card at all here).
    expect(item.workedSteps!.selfExplainPrompt).toBeUndefined();

    // No revealed step — no step's real text is ever sent.
    const serialized = JSON.stringify(item.workedSteps);
    for (const step of WORKED_STEPS) {
      expect(serialized.includes(step.text)).toBe(false);
    }
  });

  test("an item with no workedSteps is served with no workedSteps/scaffoldLevel field", async () => {
    const t = convexTest(schema, modules);
    const scholar = await seedScholar(t);
    const asScholar = await asUser(t, scholar);
    const plainSkillKey = "plain_no_worked_steps_skill";
    await t.run(async (ctx) => {
      await ctx.db.insert("knowledgeNodes", {
        nodeKey: plainSkillKey,
        label: "Plain skill",
        domain: DOMAIN,
        strand: "operations",
        source: "practice",
      });
      await ctx.db.insert("practiceItems", {
        skillKey: plainSkillKey,
        domain: DOMAIN,
        stem: "What is 2 + 2?",
        answerType: "integer",
        answerCanonical: "4",
        verifierKind: "arithmetic",
        source: "generated",
        verifiedAt: Date.now(),
      });
    });

    const { items } = await asScholar.query(api.practiceSkills.practiceSession, {
      scholarId: scholar,
      seed: 1,
      domain: DOMAIN,
      skillKeys: [plainSkillKey],
      size: 1,
    });

    expect(items).toHaveLength(1);
    expect(items[0].workedSteps).toBeUndefined();
    expect(items[0].scaffoldLevel).toBeUndefined();
  });
});

describe("practiceSession — cold failed skills teach before re-serving", () => {
  test("a stored miss on an otherwise fluent skill re-enters through a single faded worked step", async () => {
    const t = convexTest(schema, modules);
    const scholar = await seedScholar(t);
    const asScholar = await asUser(t, scholar);
    await seedItemWithWorkedSteps(t);
    await seedMastery(t, scholar, FLUENT_REPS);
    await t.run(async (ctx) =>
      ctx.db.insert("practiceAttempts", {
        scholarId: scholar,
        nodeKey: SKILL_KEY,
        correct: false,
        createdAt: Date.now(),
      }),
    );

    const { items } = await asScholar.query(api.practiceSkills.practiceSession, {
      scholarId: scholar,
      seed: 1,
      domain: DOMAIN,
      skillKeys: [SKILL_KEY],
      size: 1,
    });

    expect(items).toHaveLength(1);
    expect(items[0].scaffoldLevel).toBe(1);
    expect(items[0].workedSteps?.revealed).toHaveLength(3);
    expect(items[0].workedSteps?.faded).toHaveLength(1);
  });

  test("a template don't-know re-enters through its deterministic faded worked steps", async () => {
    const t = convexTest(schema, modules);
    const scholar = await seedScholar(t);
    const asScholar = await asUser(t, scholar);
    const templateSkill = "add_subtract_unlike";
    const templateDomain = "cold-template-domain";
    await t.run(async (ctx) => {
      await ctx.db.insert("knowledgeNodes", {
        nodeKey: templateSkill,
        label: "Unlike fractions",
        domain: templateDomain,
        strand: "fractions",
        source: "practice",
      });
      await ctx.db.insert("practiceMastery", {
        scholarId: scholar,
        skillKey: templateSkill,
        domain: templateDomain,
        repetition: FLUENT_REPS,
        halfLifeDays: 1,
        frontier: false,
        source: "practice",
        updatedAt: Date.now(),
      });
      await ctx.db.insert("practiceAttempts", {
        scholarId: scholar,
        nodeKey: templateSkill,
        correct: false,
        explanationReason: "dont_know",
        createdAt: Date.now(),
      });
    });

    const { items } = await asScholar.query(api.practiceSkills.practiceSession, {
      scholarId: scholar,
      seed: 4242,
      domain: templateDomain,
      skillKeys: [templateSkill],
      size: 1,
    });

    expect(items).toHaveLength(1);
    expect(items[0].itemId.startsWith(`${templateSkill}#`)).toBe(true);
    expect(items[0].scaffoldLevel).toBe(1);
    expect(items[0].workedSteps?.revealed.length).toBeGreaterThan(0);
    expect(items[0].workedSteps?.faded).toHaveLength(1);
  });

  test("a later viewed node instruction clears the cold-failure restriction", async () => {
    const t = convexTest(schema, modules);
    const scholar = await seedScholar(t);
    const asScholar = await asUser(t, scholar);
    await seedItemWithWorkedSteps(t);
    await seedMastery(t, scholar, FLUENT_REPS);
    const failedAt = Date.now() - 100;
    await t.run(async (ctx) => {
      await ctx.db.insert("practiceAttempts", {
        scholarId: scholar,
        nodeKey: SKILL_KEY,
        correct: false,
        createdAt: failedAt,
      });
      await ctx.db.insert("instructionEvents", {
        scholarId: scholar,
        key: `node:${SKILL_KEY}`,
        offerId: `${scholar}:node:${SKILL_KEY}`,
        viewedAt: failedAt + 1,
        offerCount: 1,
        retrievals: [],
      });
    });

    const { items } = await asScholar.query(api.practiceSkills.practiceSession, {
      scholarId: scholar,
      seed: 1,
      domain: DOMAIN,
      skillKeys: [SKILL_KEY],
      size: 1,
    });

    expect(items).toHaveLength(1);
    expect(items[0].scaffoldLevel).toBe(WORKED_STEPS.length);
    expect(items[0].workedSteps?.revealed).toHaveLength(0);
  });

  test("a cold failed node without worked-step content is still served, bare", async () => {
    const t = convexTest(schema, modules);
    const scholar = await seedScholar(t);
    const asScholar = await asUser(t, scholar);
    const coldSkill = "cold_plain_skill";
    const fallbackSkill = "add_subtract_unlike";
    const backfillDomain = "cold-backfill-domain";
    await t.run(async (ctx) => {
      await ctx.db.insert("knowledgeNodes", {
        nodeKey: coldSkill,
        label: "Cold plain skill",
        domain: backfillDomain,
        strand: "plain",
        source: "practice",
      });
      await ctx.db.insert("knowledgeNodes", {
        nodeKey: fallbackSkill,
        label: "Unlike fractions",
        domain: backfillDomain,
        strand: "fractions",
        source: "practice",
      });
      await ctx.db.insert("practiceItems", {
        skillKey: coldSkill,
        domain: backfillDomain,
        stem: "What is 2 + 2?",
        answerType: "integer",
        answerCanonical: "4",
        verifierKind: "arithmetic",
        source: "generated",
        verifiedAt: Date.now(),
      });
      await ctx.db.insert("practiceAttempts", {
        scholarId: scholar,
        nodeKey: coldSkill,
        correct: false,
        createdAt: Date.now(),
      });
    });

    const { items } = await asScholar.query(api.practiceSkills.practiceSession, {
      scholarId: scholar,
      seed: 7,
      domain: backfillDomain,
      skillKeys: [coldSkill, fallbackSkill],
      size: 2,
    });

    // R3 — serving NEVER withholds a queued node. With no worked steps to
    // reveal, the cold node comes back exactly as it does today: a bare problem.
    expect(items).toHaveLength(2);
    const coldItem = items.find((item) => item.skillKey === coldSkill);
    expect(coldItem).toBeDefined();
    expect(coldItem!.workedSteps).toBeUndefined();
    expect(coldItem!.scaffoldLevel).toBeUndefined();
  });

  test("recovery arc: miss → level-1 completion → assisted solve (no green) → bare re-serve → demonstrated", async () => {
    const t = convexTest(schema, modules);
    const scholar = await seedScholar(t);
    const asScholar = await asUser(t, scholar);
    const docId = await seedItemWithWorkedSteps(t);
    const itemId = `gen#${docId}` as const;
    // Access-proven through PLACEMENT — an inferred credit, so the fade is
    // already retired but the skill has never been demonstrated. That keeps
    // every green claim below earned by the arc itself.
    await seedMastery(t, scholar, FLUENT_REPS, "placement");
    await t.run(async (ctx) =>
      ctx.db.insert("practiceAttempts", {
        scholarId: scholar,
        nodeKey: SKILL_KEY,
        correct: false,
        createdAt: Date.now(),
      }),
    );

    const serveArgs = {
      scholarId: scholar,
      seed: 1,
      domain: DOMAIN,
      skillKeys: [SKILL_KEY],
      size: 1,
    };

    // 1. The miss re-enters as a completion problem even though mastery says bare.
    const cold = await asScholar.query(api.practiceSkills.practiceSession, serveArgs);
    expect(cold.items[0].scaffoldLevel).toBe(1);
    expect(cold.items[0].workedSteps!.revealed).toHaveLength(WORKED_STEPS.length - 1);

    // 2. Finishing it is ASSISTED: reps/access still bump, but the credit is
    //    inferred (SCAFFOLDED_SOURCE), so the skill cannot turn green.
    const assisted = await asScholar.mutation(api.practiceSkills.submitAnswer, {
      scholarId: scholar,
      itemId,
      answer: "7/12",
    });
    expect(assisted.correct).toBe(true);
    expect(assisted.turnedFluent).toBe(false);
    const afterAssisted = await readMastery(t, scholar);
    expect(afterAssisted!.source).toBe(SCAFFOLDED_SOURCE);
    expect(afterAssisted!.repetition).toBeGreaterThan(FLUENT_REPS);
    expect(isFluent(afterAssisted!)).toBe(false);

    // 3. That correct answer cleared the cold state (R1), so the next serve is
    //    mastery-derived again — bare for an access-proven scholar.
    const bareServe = await asScholar.query(api.practiceSkills.practiceSession, serveArgs);
    expect(bareServe.items[0].scaffoldLevel).toBe(WORKED_STEPS.length);
    expect(bareServe.items[0].workedSteps!.revealed).toHaveLength(0);

    // 4. A correct answer on the BARE problem is a real demonstration.
    const demonstrated = await asScholar.mutation(api.practiceSkills.submitAnswer, {
      scholarId: scholar,
      itemId,
      answer: "7/12",
    });
    expect(demonstrated.correct).toBe(true);
    const afterBare = await readMastery(t, scholar);
    expect(afterBare!.source).toBe("practice");
    expect(DEMONSTRATED_SOURCES.has(afterBare!.source ?? "practice")).toBe(true);
    expect(isFluent(afterBare!)).toBe(true);
  });
});

describe("submitAnswer — scaffold-aware grading (assisted ≠ demonstrated)", () => {
  test("a correct answer WITH the scaffold visible records an inferred source and never goes green; a correct BARE answer demonstrates", async () => {
    const t = convexTest(schema, modules);
    const scholar = await seedScholar(t);
    const asScholar = await asUser(t, scholar);
    const docId = await seedItemWithWorkedSteps(t);
    const itemId = `gen#${docId}` as const;

    // A 4-step item + the fade bands mean attempts at rep 0/1/2 are all still
    // scaffolded (≥1 revealed step); the scholar only reaches a bare problem at
    // rep >= FLUENT_REPS (accessProven). Every submission is the CORRECT answer.
    for (let i = 0; i < FLUENT_REPS; i++) {
      const res = await asScholar.mutation(api.practiceSkills.submitAnswer, {
        scholarId: scholar,
        itemId,
        answer: "7/12",
      });
      expect(res.correct).toBe(true);

      const row = await readMastery(t, scholar);
      expect(row).not.toBeNull();
      // Assisted: the credit is inferred, NOT demonstrated — so even once the
      // scholar is access-proven (rep >= FLUENT_REPS) the bare-fluency gate
      // stays closed.
      expect(DEMONSTRATED_SOURCES.has(row!.source ?? "practice")).toBe(false);
      expect(isFluent(row!)).toBe(false);
    }

    // After FLUENT_REPS scaffolded corrects the scholar is access-proven but
    // still not fluent (never demonstrated on a bare problem).
    const afterScaffold = await readMastery(t, scholar);
    expect(afterScaffold!.repetition).toBeGreaterThanOrEqual(FLUENT_REPS);
    expect(afterScaffold!.source).toBe("scaffolded");
    expect(isFluent(afterScaffold!)).toBe(false);

    // Now access-proven → the item serves BARE (no revealed step). A correct
    // answer here is a real demonstration: source "practice", and the row goes
    // green (context-free isFluent).
    const bare = await asScholar.mutation(api.practiceSkills.submitAnswer, {
      scholarId: scholar,
      itemId,
      answer: "7/12",
    });
    expect(bare.correct).toBe(true);

    const demonstrated = await readMastery(t, scholar);
    expect(demonstrated!.source).toBe("practice");
    expect(DEMONSTRATED_SOURCES.has(demonstrated!.source ?? "practice")).toBe(true);
    expect(isFluent(demonstrated!)).toBe(true);
  });

  test("a SCAFFOLDED miss is still just a miss (source untouched, not demonstrated)", async () => {
    const t = convexTest(schema, modules);
    const scholar = await seedScholar(t);
    const asScholar = await asUser(t, scholar);
    const docId = await seedItemWithWorkedSteps(t);
    const itemId = `gen#${docId}` as const;

    const res = await asScholar.mutation(api.practiceSkills.submitAnswer, {
      scholarId: scholar,
      itemId,
      answer: "1/2", // wrong
    });
    expect(res.correct).toBe(false);

    const row = await readMastery(t, scholar);
    expect(row).not.toBeNull();
    // A first-attempt miss inserts the ordinary "practice" provenance (a wrong
    // answer never claims the scaffold source), at repetition 0 — not fluent.
    expect(row!.source).toBe("practice");
    expect(row!.repetition).toBe(0);
    expect(isFluent(row!)).toBe(false);
  });
});

describe("teachingStep — the one interactive step for a don't-know", () => {
  test("forces a single blank (level 1: reveal all but the answer-producing step), regardless of mastery", async () => {
    const t = convexTest(schema, modules);
    const scholar = await seedScholar(t);
    const asScholar = await asUser(t, scholar);
    const docId = await seedItemWithWorkedSteps(t);
    // Rep 2 would fade the last THREE steps at serve time — the teaching step
    // must still force exactly ONE blank (doing one step is the whole ask).
    await seedMastery(t, scholar, 2);

    // #900: teachingStep only reveals once the scholar has EARNED it — an
    // honest "I haven't learned this yet" (recorded dont_know MISS) on THIS item.
    await asScholar.mutation(api.practiceSkills.submitAnswer, {
      scholarId: scholar,
      itemId: `gen#${docId}`,
      answer: "",
      record: true,
      dontKnow: true,
    });

    const step = await asScholar.query(api.practiceSkills.teachingStep, {
      scholarId: scholar,
      itemId: `gen#${docId}`,
    });

    expect(step).not.toBeNull();
    expect(step!.steps).not.toBeNull();
    expect(step!.steps!.revealed).toHaveLength(3);
    expect(step!.steps!.faded).toHaveLength(1);
    expect(step!.steps!.revealed.map((s) => s.text)).toEqual(
      WORKED_STEPS.slice(0, 3).map((s) => s.text),
    );
    expect(step!.steps!.faded[0]).toEqual({ blankText: "Simplify the result: ___" });
    // The gradeable value for the one blank (echoed here, post-measurement).
    expect(step!.answer).toBe("7/12");
    expect(step!.answerType).toBe("fraction");

    // The faded (answer-producing) step's DESCRIPTIVE text never crosses the wire.
    const serialized = JSON.stringify(step!.steps);
    expect(serialized.includes(WORKED_STEPS[3].text)).toBe(false);
  });

  test("records nothing — a read-only query, so the step attempt can't move mastery/placement", async () => {
    const t = convexTest(schema, modules);
    const scholar = await seedScholar(t);
    const asScholar = await asUser(t, scholar);
    const docId = await seedItemWithWorkedSteps(t);

    await asScholar.query(api.practiceSkills.teachingStep, {
      scholarId: scholar,
      itemId: `gen#${docId}`,
    });

    // No mastery row was created by fetching the teaching step.
    expect(await readMastery(t, scholar)).toBeNull();
  });

  test("degrades to a reveal-only payload (steps null) for an item with no worked steps", async () => {
    const t = convexTest(schema, modules);
    const scholar = await seedScholar(t);
    const asScholar = await asUser(t, scholar);
    const plainSkillKey = "plain_no_worked_steps_skill";
    const docId = await t.run(async (ctx) => {
      await ctx.db.insert("knowledgeNodes", {
        nodeKey: plainSkillKey,
        label: "Plain skill",
        domain: DOMAIN,
        strand: "operations",
        source: "practice",
      });
      return ctx.db.insert("practiceItems", {
        skillKey: plainSkillKey,
        domain: DOMAIN,
        stem: "What is 2 + 2?",
        answerType: "integer",
        answerCanonical: "4",
        verifierKind: "arithmetic",
        source: "generated",
        verifiedAt: Date.now(),
      });
    });

    // #900: earn the reveal first (dont_know MISS on this item).
    await asScholar.mutation(api.practiceSkills.submitAnswer, {
      scholarId: scholar,
      itemId: `gen#${docId}`,
      answer: "",
      record: true,
      dontKnow: true,
    });

    const step = await asScholar.query(api.practiceSkills.teachingStep, {
      scholarId: scholar,
      itemId: `gen#${docId}`,
    });
    // No interactive step, but a reveal-only answer so Next never dead-ends.
    expect(step!.steps).toBeNull();
    expect(step!.answer).toBe("4");
  });

  test("degrades to steps null for a single-step item (nothing earlier to reveal)", async () => {
    const t = convexTest(schema, modules);
    const scholar = await seedScholar(t);
    const asScholar = await asUser(t, scholar);
    const oneStepSkill = "one_step_skill";
    const docId = await t.run(async (ctx) => {
      await ctx.db.insert("knowledgeNodes", {
        nodeKey: oneStepSkill,
        label: "One-step skill",
        domain: DOMAIN,
        strand: "operations",
        source: "practice",
      });
      return ctx.db.insert("practiceItems", {
        skillKey: oneStepSkill,
        domain: DOMAIN,
        stem: "What is 2 + 2?",
        answerType: "integer",
        answerCanonical: "4",
        verifierKind: "arithmetic",
        workedSteps: [{ text: "Add: 2 + 2 = 4.", blankText: "Add: ___" }],
        source: "generated",
        verifiedAt: Date.now(),
      });
    });

    const step = await asScholar.query(api.practiceSkills.teachingStep, {
      scholarId: scholar,
      itemId: `gen#${docId}`,
    });
    expect(step!.steps).toBeNull();
  });

  test("serves a single-blank step for a TEMPLATE item too (the content-gap fix)", async () => {
    // Almost every served drill item is TEMPLATE-generated; those now carry
    // deterministic workedSteps for mechanical families, so the teaching moment
    // fires for them — not just for stored fixtures. A template itemId
    // (skillKey#seed) resolves server-side with no seeded row.
    const t = convexTest(schema, modules);
    const scholar = await seedScholar(t);
    const asScholar = await asUser(t, scholar);

    // #900: earn the reveal first (dont_know MISS on this template item).
    await asScholar.mutation(api.practiceSkills.submitAnswer, {
      scholarId: scholar,
      itemId: "add_subtract_unlike#4242",
      answer: "",
      record: true,
      dontKnow: true,
    });

    const step = await asScholar.query(api.practiceSkills.teachingStep, {
      scholarId: scholar,
      itemId: "add_subtract_unlike#4242",
    });

    expect(step!.steps).not.toBeNull();
    expect(step!.steps!.faded).toHaveLength(1);
    expect(step!.steps!.revealed.length).toBeGreaterThan(0);
    expect(step!.answerType).toBe("fraction");
    // The reveal value is the item's canonical answer, and the final
    // (answer-producing) step is faded — its blankText prompts, its text is gone.
    expect(step!.answer && step!.answer.length > 0).toBe(true);
    expect(step!.steps!.faded[0].blankText.length).toBeGreaterThan(0);
  });

  test("a TEMPLATE family with no worked steps degrades to reveal-only", async () => {
    const t = convexTest(schema, modules);
    const scholar = await seedScholar(t);
    const asScholar = await asUser(t, scholar);

    // #900: earn the reveal first (dont_know MISS on this template item).
    await asScholar.mutation(api.practiceSkills.submitAnswer, {
      scholarId: scholar,
      itemId: "count_to_10#4242",
      answer: "",
      record: true,
      dontKnow: true,
    });

    // `count_to_10` is a trivial single-step family — deliberately emits no
    // worked steps, so the teaching moment degrades to reveal-only.
    const step = await asScholar.query(api.practiceSkills.teachingStep, {
      scholarId: scholar,
      itemId: "count_to_10#4242",
    });
    expect(step!.steps).toBeNull();
    expect(step!.answer && step!.answer.length > 0).toBe(true);
    // Nothing to hint at when there is no step to do.
    expect(step!.hint).toBeNull();
  });

  test("serves the TIER-2 hint alongside the blank — the move set up, not done", async () => {
    const t = convexTest(schema, modules);
    const scholar = await seedScholar(t);
    const asScholar = await asUser(t, scholar);
    await t.run(async (ctx) => {
      await ctx.db.insert("knowledgeNodes", {
        nodeKey: "long_division_1digit_divisor",
        label: "Long division",
        domain: DOMAIN,
        strand: "operations",
        source: "practice",
      });
    });
    const itemId = "long_division_1digit_divisor#4242";
    await asScholar.mutation(api.practiceSkills.submitAnswer, {
      scholarId: scholar,
      itemId,
      answer: "",
      record: true,
      dontKnow: true,
    });

    const step = await asScholar.query(api.practiceSkills.teachingStep, {
      scholarId: scholar,
      itemId,
    });
    expect(step!.steps).not.toBeNull();
    const blank = step!.steps!.faded[step!.steps!.faded.length - 1]!.blankText;
    // A real middle rung: distinct from the blank above it, and it never hands
    // over the answer (that's the whole contract — see evals/scaffold-progress).
    expect(step!.hint).toBeTruthy();
    expect(step!.hint).not.toBe(blank);
    expect(step!.hint!.length).toBeGreaterThan(blank.length);
  });
});

describe("recordTeachingOutcome — which rung of the ladder was needed", () => {
  // Derived from a real call so the schema generic survives — a bare
  // `ReturnType<typeof convexTest>` drops it and `ctx.db` degrades to the
  // system tables only.
  const _makeTest = () => convexTest(schema, modules);
  type TestCtx = ReturnType<typeof _makeTest>;

  /** Drive a don't-know on a template item and return its itemId. */
  async function dontKnow(t: TestCtx, scholar: Id<"users">) {
    const asScholar = await asUser(t, scholar);
    await t.run(async (ctx) => {
      await ctx.db.insert("knowledgeNodes", {
        nodeKey: "long_division_1digit_divisor",
        label: "Long division",
        domain: DOMAIN,
        strand: "operations",
        source: "practice",
      });
    });
    const itemId = "long_division_1digit_divisor#4242";
    await asScholar.mutation(api.practiceSkills.submitAnswer, {
      scholarId: scholar,
      itemId,
      answer: "",
      record: true,
      dontKnow: true,
    });
    return { asScholar, itemId };
  }

  const outcomeOf = (t: TestCtx, scholar: Id<"users">) =>
    t.run(async (ctx) => {
      const rows = await ctx.db
        .query("practiceAttempts")
        .withIndex("by_scholar", (q) => q.eq("scholarId", scholar))
        .collect();
      return rows.find((r) => r.explanationReason === "dont_know")?.teachOutcome ?? null;
    });

  test("patches the EXISTING don't-know row — no second attempt is written", async () => {
    const t = convexTest(schema, modules);
    const scholar = await seedScholar(t);
    const { asScholar, itemId } = await dontKnow(t, scholar);
    const before = await t.run(async (ctx) =>
      (
        await ctx.db
          .query("practiceAttempts")
          .withIndex("by_scholar", (q) => q.eq("scholarId", scholar))
          .collect()
      ).length,
    );

    const res = await asScholar.mutation(api.practiceSkills.recordTeachingOutcome, {
      scholarId: scholar,
      itemId,
      outcome: "hint",
    });
    expect(res.recorded).toBe(true);
    expect(await outcomeOf(t, scholar)).toBe("hint");

    // The teaching moment must stay invisible to the scheduler: no new attempt.
    const after = await t.run(async (ctx) =>
      (
        await ctx.db
          .query("practiceAttempts")
          .withIndex("by_scholar", (q) => q.eq("scholarId", scholar))
          .collect()
      ).length,
    );
    expect(after).toBe(before);
  });

  test("is MONOTONE — the ladder only ever deepens", async () => {
    const t = convexTest(schema, modules);
    const scholar = await seedScholar(t);
    const { asScholar, itemId } = await dontKnow(t, scholar);

    await asScholar.mutation(api.practiceSkills.recordTeachingOutcome, {
      scholarId: scholar,
      itemId,
      outcome: "stuck",
    });
    // A late/duplicate "solved" from the other frontend must not walk it back.
    const res = await asScholar.mutation(api.practiceSkills.recordTeachingOutcome, {
      scholarId: scholar,
      itemId,
      outcome: "solved",
    });
    expect(res.recorded).toBe(false);
    expect(await outcomeOf(t, scholar)).toBe("stuck");
  });

  test("is a silent no-op when there is no don't-know row to annotate", async () => {
    const t = convexTest(schema, modules);
    const scholar = await seedScholar(t);
    const asScholar = await asUser(t, scholar);
    // Bookkeeping must never throw into a child's teaching moment.
    const res = await asScholar.mutation(api.practiceSkills.recordTeachingOutcome, {
      scholarId: scholar,
      itemId: "long_division_1digit_divisor#4242",
      outcome: "stuck",
    });
    expect(res.recorded).toBe(false);
  });

  test("a teacher preview / non-self call never writes the scholar's row", async () => {
    const t = convexTest(schema, modules);
    const scholar = await seedScholar(t);
    // The scholar's own don't-know creates the row the ladder would deepen.
    const { itemId } = await dontKnow(t, scholar);
    expect(await outcomeOf(t, scholar)).toBe(null);

    const teacher = await t.run(async (ctx) =>
      ctx.db.insert("users", {
        name: "Preview Teacher",
        username: "preview-teacher",
        role: "teacher",
      }),
    );
    const asTeacher = await asUser(t, teacher);

    // A teacher rehearsing/previewing the activity must NOT deepen the real
    // scholar's analytics row.
    const teacherRes = await asTeacher.mutation(api.practiceSkills.recordTeachingOutcome, {
      scholarId: scholar,
      itemId,
      outcome: "stuck",
    });
    expect(teacherRes.recorded).toBe(false);
    expect(await outcomeOf(t, scholar)).toBe(null);

    // The scholar's OWN call still records, proving the guard is self-scoped.
    const asScholar = await asUser(t, scholar);
    const selfRes = await asScholar.mutation(api.practiceSkills.recordTeachingOutcome, {
      scholarId: scholar,
      itemId,
      outcome: "stuck",
    });
    expect(selfRes.recorded).toBe(true);
    expect(await outcomeOf(t, scholar)).toBe("stuck");
  });
});
