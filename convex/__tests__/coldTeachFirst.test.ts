/**
 * Adversarial coverage for SPEC "Teach before re-serving failed practice
 * skills", v4. Written blind against the spec's target behavior, independently
 * of the implementation (each test cites the spec section it encodes). The
 * whole suite passes on this branch; any failure here is a regression in the
 * cold-serve/grade contract, never "expected".
 *
 * Modeled on `convex/__tests__/fadedWorkedSteps.test.ts`'s harness (same
 * seedScholar/asUser/seedItemWithWorkedSteps shape) — this file adds the cold
 * predicate's edge cases (clearing, teach-on-miss, retries, lane exclusion,
 * the 45-day window), the R3 no-withholding guarantee, and the R4 serve/grade
 * sync (a scaffolded correct must never mint a bare demonstration).
 */
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "../schema";
import { api, internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import {
  DEMONSTRATED_SOURCES,
  FLUENT_REPS,
  SCAFFOLDED_SOURCE,
  isFluent,
} from "../lib/practice/scheduler";
import {
  seedScholarInInstitution,
  seedTestInstitution,
} from "./institutionTestHelpers";

const modules = (
  import.meta as ImportMeta & {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("../**/*.ts");

const DOMAIN = "whole-number-arithmetic";
const SKILL_KEY = "cold_teach_first_skill";
const DAY_MS = 24 * 60 * 60 * 1000;

// Same 4-step shape as fadedWorkedSteps.test.ts — a real multi-step worked
// example, so scaffoldLevel 1 (level-1 forced re-serve) is distinguishable
// from the bare (fully-faded) case.
const WORKED_STEPS = [
  { text: "Find a common denominator for 4 and 3: 12.", blankText: "Find a common denominator: ___" },
  { text: "Convert: 1/4 = 3/12 and 1/3 = 4/12.", blankText: "Convert both fractions: ___" },
  { text: "Add the numerators: 3/12 + 4/12 = 7/12.", blankText: "Add the numerators: ___" },
  { text: "Simplify: 7/12 is already in lowest terms.", blankText: "Simplify the result: ___" },
];

async function seedScholar(t: ReturnType<typeof convexTest>) {
  return await t.run(async (ctx) =>
    ctx.db.insert("users", {
      name: "Cold Teach-First Scholar",
      username: "cold-teach-first-scholar",
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
      label: "Cold teach-first test skill",
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
    const rows = (await ctx.db.query("practiceMastery").collect()) as Doc<"practiceMastery">[];
    return rows.find((r) => r.scholarId === scholarId && r.skillKey === SKILL_KEY) ?? null;
  });
}

/** Access-proven but NOT yet demonstrated (source not in DEMONSTRATED_SOURCES)
 *  — mastery-derived fade would already be bare (repetition >= FLUENT_REPS),
 *  which is exactly the trap R4 guards against: a cold serve at this mastery
 *  level must still force scaffold level 1, and a scaffolded correct must not
 *  be graded as the bare demonstration that would flip this row green. */
async function seedAccessProvenNotFluent(t: ReturnType<typeof convexTest>, scholarId: Id<"users">) {
  await t.run(async (ctx) =>
    ctx.db.insert("practiceMastery", {
      scholarId,
      skillKey: SKILL_KEY,
      domain: DOMAIN,
      repetition: FLUENT_REPS,
      halfLifeDays: 1,
      frontier: false,
      source: "accelerated",
      updatedAt: Date.now(),
    }),
  );
}

async function seedFluentMastery(t: ReturnType<typeof convexTest>, scholarId: Id<"users">) {
  await t.run(async (ctx) =>
    ctx.db.insert("practiceMastery", {
      scholarId,
      skillKey: SKILL_KEY,
      domain: DOMAIN,
      repetition: FLUENT_REPS,
      halfLifeDays: 1,
      frontier: false,
      source: "practice",
      updatedAt: Date.now(),
    }),
  );
}

async function serveOne(t: ReturnType<typeof convexTest>, asScholar: Awaited<ReturnType<typeof asUser>>, scholarId: Id<"users">) {
  const { items } = await asScholar.query(api.practiceSkills.practiceSession, {
    scholarId,
    seed: 1,
    domain: DOMAIN,
    skillKeys: [SKILL_KEY],
    size: 1,
  });
  return items[0];
}

describe("coldFailedSkillKeySet — R1/§3 clearing", () => {
  test("a miss forces level-1; a later CORRECT non-retry attempt clears cold and fade resumes from mastery (bare for FLUENT_REPS)", async () => {
    const t = convexTest(schema, modules);
    const scholar = await seedScholar(t);
    const asScholar = await asUser(t, scholar);
    await seedItemWithWorkedSteps(t);
    await seedFluentMastery(t, scholar);

    const failedAt = Date.now();
    await t.run(async (ctx) =>
      ctx.db.insert("practiceAttempts", {
        scholarId: scholar,
        nodeKey: SKILL_KEY,
        correct: false,
        createdAt: failedAt,
      }),
    );

    const cold = await serveOne(t, asScholar, scholar);
    expect(cold.scaffoldLevel).toBe(1);
    expect(cold.workedSteps?.revealed).toHaveLength(3);
    expect(cold.workedSteps?.faded).toHaveLength(1);

    // A later, qualifying (non-retry) CORRECT attempt on this node — any lane —
    // proves the scholar demonstrated it, so cold clears.
    await t.run(async (ctx) =>
      ctx.db.insert("practiceAttempts", {
        scholarId: scholar,
        nodeKey: SKILL_KEY,
        correct: true,
        createdAt: failedAt + 10,
      }),
    );

    const cleared = await serveOne(t, asScholar, scholar);
    expect(cleared.scaffoldLevel).toBe(WORKED_STEPS.length);
    expect(cleared.workedSteps?.revealed).toHaveLength(0);
  });
});

describe("coldFailedSkillKeySet — §1 teach-on-miss clears cold", () => {
  test("a miss row carrying explanationFinishedAt (no stuck teachOutcome) is NOT cold — bare serve for a fluent scholar", async () => {
    const t = convexTest(schema, modules);
    const scholar = await seedScholar(t);
    const asScholar = await asUser(t, scholar);
    await seedItemWithWorkedSteps(t);
    await seedFluentMastery(t, scholar);

    const failedAt = Date.now();
    await t.run(async (ctx) =>
      ctx.db.insert("practiceAttempts", {
        scholarId: scholar,
        nodeKey: SKILL_KEY,
        correct: false,
        createdAt: failedAt,
        explanationReason: "miss",
        // The explanation streamed to completion AFTER the miss timestamp —
        // this is teach-on-miss, so it counts as teaching at THIS moment.
        explanationFinishedAt: failedAt + 50,
      }),
    );

    const item = await serveOne(t, asScholar, scholar);
    expect(item.scaffoldLevel).toBe(WORKED_STEPS.length);
    expect(item.workedSteps?.revealed).toHaveLength(0);
  });
});

describe("coldFailedSkillKeySet — §1 stuck stays cold", () => {
  test("a miss row with explanationFinishedAt AND teachOutcome 'stuck' does NOT clear cold — still level-1", async () => {
    const t = convexTest(schema, modules);
    const scholar = await seedScholar(t);
    const asScholar = await asUser(t, scholar);
    await seedItemWithWorkedSteps(t);
    await seedFluentMastery(t, scholar);

    const failedAt = Date.now();
    await t.run(async (ctx) =>
      ctx.db.insert("practiceAttempts", {
        scholarId: scholar,
        nodeKey: SKILL_KEY,
        correct: false,
        createdAt: failedAt,
        explanationReason: "miss",
        explanationFinishedAt: failedAt + 50,
        // The explanation was delivered but the scholar stayed lost — the
        // teach-on-miss exception: this does NOT count as teaching.
        teachOutcome: "stuck",
      }),
    );

    const item = await serveOne(t, asScholar, scholar);
    expect(item.scaffoldLevel).toBe(1);
    expect(item.workedSteps?.revealed).toHaveLength(3);
    expect(item.workedSteps?.faded).toHaveLength(1);
  });
});

describe("coldFailedSkillKeySet — §1 retry rows are inert", () => {
  test("a lone retry:true miss does NOT arm cold — bare serve for a fluent scholar", async () => {
    const t = convexTest(schema, modules);
    const scholar = await seedScholar(t);
    const asScholar = await asUser(t, scholar);
    await seedItemWithWorkedSteps(t);
    await seedFluentMastery(t, scholar);

    await t.run(async (ctx) =>
      ctx.db.insert("practiceAttempts", {
        scholarId: scholar,
        nodeKey: SKILL_KEY,
        correct: false,
        retry: true,
        createdAt: Date.now(),
      }),
    );

    const item = await serveOne(t, asScholar, scholar);
    expect(item.scaffoldLevel).toBe(WORKED_STEPS.length);
    expect(item.workedSteps?.revealed).toHaveLength(0);
  });

  test("a retry:true CORRECT after a real miss does NOT clear cold — retries excluded on both sides", async () => {
    const t = convexTest(schema, modules);
    const scholar = await seedScholar(t);
    const asScholar = await asUser(t, scholar);
    await seedItemWithWorkedSteps(t);
    await seedFluentMastery(t, scholar);

    const failedAt = Date.now();
    await t.run(async (ctx) => {
      await ctx.db.insert("practiceAttempts", {
        scholarId: scholar,
        nodeKey: SKILL_KEY,
        correct: false,
        createdAt: failedAt,
      });
      // A correct handoff RETRY after the real miss — spec: "one extra
      // scaffolded rep after a handoff rescue is intended", i.e. this must
      // NOT be read as the qualifying success that clears cold.
      await ctx.db.insert("practiceAttempts", {
        scholarId: scholar,
        nodeKey: SKILL_KEY,
        correct: true,
        retry: true,
        createdAt: failedAt + 10,
      });
    });

    const item = await serveOne(t, asScholar, scholar);
    expect(item.scaffoldLevel).toBe(1);
    expect(item.workedSteps?.revealed).toHaveLength(3);
  });
});

describe("coldFailedSkillKeySet — §1 placement/reprobe misses don't arm cold", () => {
  test("a placement-lane miss only does NOT arm cold — bare serve for a fluent scholar", async () => {
    const t = convexTest(schema, modules);
    const scholar = await seedScholar(t);
    const asScholar = await asUser(t, scholar);
    await seedItemWithWorkedSteps(t);
    await seedFluentMastery(t, scholar);

    await t.run(async (ctx) =>
      ctx.db.insert("practiceAttempts", {
        scholarId: scholar,
        nodeKey: SKILL_KEY,
        correct: false,
        lane: "placement",
        createdAt: Date.now(),
      }),
    );

    const item = await serveOne(t, asScholar, scholar);
    expect(item.scaffoldLevel).toBe(WORKED_STEPS.length);
    expect(item.workedSteps?.revealed).toHaveLength(0);
  });
});

describe("coldFailedSkillKeySet — §1 window bound (fail-open)", () => {
  test("a miss older than the 45-day window does NOT arm cold", async () => {
    const t = convexTest(schema, modules);
    const scholar = await seedScholar(t);
    const asScholar = await asUser(t, scholar);
    await seedItemWithWorkedSteps(t);
    await seedFluentMastery(t, scholar);

    await t.run(async (ctx) =>
      ctx.db.insert("practiceAttempts", {
        scholarId: scholar,
        nodeKey: SKILL_KEY,
        correct: false,
        // Outside COLD_FAILURE_WINDOW_MS (45 days) — the scan is bounded, so
        // this miss is forgotten and serving falls open to status quo.
        createdAt: Date.now() - 46 * DAY_MS,
      }),
    );

    const item = await serveOne(t, asScholar, scholar);
    expect(item.scaffoldLevel).toBe(WORKED_STEPS.length);
    expect(item.workedSteps?.revealed).toHaveLength(0);
  });
});

describe("serveItems — R3 no withholding", () => {
  test("a cold node whose only stored item has NO workedSteps is still SERVED (bare), never dropped", async () => {
    const t = convexTest(schema, modules);
    const scholar = await seedScholar(t);
    const asScholar = await asUser(t, scholar);
    const coldSkill = "cold_no_steps_skill";
    const fallbackSkill = "cold_no_steps_fallback_skill";
    const backfillDomain = "cold-no-withholding-domain";
    await t.run(async (ctx) => {
      await ctx.db.insert("knowledgeNodes", {
        nodeKey: coldSkill,
        label: "Cold plain skill (no worked steps)",
        domain: backfillDomain,
        strand: "plain",
        source: "practice",
      });
      await ctx.db.insert("knowledgeNodes", {
        nodeKey: fallbackSkill,
        label: "Fallback plain skill",
        domain: backfillDomain,
        strand: "plain",
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
      await ctx.db.insert("practiceItems", {
        skillKey: fallbackSkill,
        domain: backfillDomain,
        stem: "What is 3 + 3?",
        answerType: "integer",
        answerCanonical: "6",
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

    // Never withheld: the requested size is met AND the cold node is present
    // (bare — it has nothing to scaffold with), not silently backfilled away.
    expect(items).toHaveLength(2);
    const coldServed = items.find((it) => it.skillKey === coldSkill);
    expect(coldServed).toBeDefined();
    expect(coldServed!.workedSteps).toBeUndefined();
    expect(coldServed!.scaffoldLevel).toBeUndefined();
  });
});

describe("submitAnswer — R4/§4 grade sync (no silent green)", () => {
  test("a cold scholar's scaffolded correct is NEVER a bare demonstration, even at the access-proven (green) threshold", async () => {
    const t = convexTest(schema, modules);
    const scholar = await seedScholar(t);
    const asScholar = await asUser(t, scholar);
    const docId = await seedItemWithWorkedSteps(t);
    const itemId = `gen#${docId}` as const;

    // Access-proven (repetition >= FLUENT_REPS) but not yet demonstrated —
    // exactly the mastery band where scaffoldLevelFor() alone would already
    // read "bare" (accessProven → Infinity), which is the trap: without the
    // cold recompute at grade time, this correct answer would be graded as a
    // real bare demonstration and silently mint DEMONSTRATED_SOURCES.
    await seedAccessProvenNotFluent(t, scholar);
    await t.run(async (ctx) =>
      ctx.db.insert("practiceAttempts", {
        scholarId: scholar,
        nodeKey: SKILL_KEY,
        correct: false,
        createdAt: Date.now(),
      }),
    );

    const res = await asScholar.mutation(api.practiceSkills.submitAnswer, {
      scholarId: scholar,
      itemId,
      answer: "7/12",
    });
    expect(res.correct).toBe(true);
    // R4: must NEVER count as a bare demonstration, even though the scholar
    // was already access-proven (i.e. even right at the green threshold).
    expect(res.turnedFluent).toBe(false);

    const row = await readMastery(t, scholar);
    expect(row).not.toBeNull();
    expect(DEMONSTRATED_SOURCES.has(row!.source ?? "practice")).toBe(false);
    expect(row!.source).toBe(SCAFFOLDED_SOURCE);
  });
});

describe("submitAnswer + practiceSession — §4 full recovery arc", () => {
  test("miss → level-1 serve → scaffolded correct (no green) → mastery-derived bare serve → bare correct → DEMONSTRATED", async () => {
    const t = convexTest(schema, modules);
    const scholar = await seedScholar(t);
    const asScholar = await asUser(t, scholar);
    const docId = await seedItemWithWorkedSteps(t);
    const itemId = `gen#${docId}` as const;

    await seedAccessProvenNotFluent(t, scholar);
    await t.run(async (ctx) =>
      ctx.db.insert("practiceAttempts", {
        scholarId: scholar,
        nodeKey: SKILL_KEY,
        correct: false,
        createdAt: Date.now(),
      }),
    );

    // 1. Cold serve: forced level 1, regardless of the already access-proven
    // mastery row.
    const coldServe = await serveOne(t, asScholar, scholar);
    expect(coldServe.scaffoldLevel).toBe(1);
    expect(coldServe.workedSteps?.revealed).toHaveLength(3);

    // 2. Correct WITH the scaffold visible: assisted, never green.
    const assisted = await asScholar.mutation(api.practiceSkills.submitAnswer, {
      scholarId: scholar,
      itemId,
      answer: "7/12",
    });
    expect(assisted.correct).toBe(true);
    expect(assisted.turnedFluent).toBe(false);
    const afterAssisted = await readMastery(t, scholar);
    expect(DEMONSTRATED_SOURCES.has(afterAssisted!.source ?? "practice")).toBe(false);

    // 3. That correct, non-retry attempt cleared cold (R1) — the next serve
    // falls back to mastery-derived fade, which is bare (still access-proven).
    const bareServe = await serveOne(t, asScholar, scholar);
    expect(bareServe.scaffoldLevel).toBe(WORKED_STEPS.length);
    expect(bareServe.workedSteps?.revealed).toHaveLength(0);

    // 4. A correct answer on a genuinely bare problem is a real demonstration
    // — source flips to DEMONSTRATED and the row may go green.
    const demonstrated = await asScholar.mutation(api.practiceSkills.submitAnswer, {
      scholarId: scholar,
      itemId,
      answer: "7/12",
    });
    expect(demonstrated.correct).toBe(true);
    expect(demonstrated.turnedFluent).toBe(true);
    const finalRow = await readMastery(t, scholar);
    expect(finalRow!.source).toBe("practice");
    expect(DEMONSTRATED_SOURCES.has(finalRow!.source ?? "practice")).toBe(true);
    expect(isFluent(finalRow!)).toBe(true);
  });
});

describe("practiceSession — §2 challenge lane excludes cold keys", () => {
  test("a cold above-band key is dropped from the served challenge tail; a non-cold above-band sibling still serves", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.practiceSkills.seedGraph, {});
    const institutionId = await seedTestInstitution(t);
    const scholar = await seedScholarInInstitution(t, {
      institutionId,
      name: "Challenge-tail Scholar",
      username: "challenge-tail-scholar",
    });
    const asScholar = await asUser(t, scholar);

    // Same fixture as practiceSkills.test.ts's "above-band frontier" test:
    // push two of count_to_10's direct dependents to grade 8 (above-band),
    // then make count_10 demonstrated-fluent so its dependents open on the
    // frontier and surface only as the challenge tail.
    const ABOVE_BAND_COLD = "count_to_100_tens";
    const ABOVE_BAND_HOT = "count_to_20";
    await t.run(async (ctx) => {
      for (const key of [ABOVE_BAND_COLD, ABOVE_BAND_HOT]) {
        const node = await ctx.db
          .query("knowledgeNodes")
          .withIndex("by_nodeKey", (q) => q.eq("nodeKey", key))
          .first();
        if (node) await ctx.db.patch(node._id, { grade: "8" });
      }
    });
    for (let i = 0; i < 3; i++) {
      await t.mutation(internal.practiceSkills.recordAttemptInternal, {
        scholarId: scholar,
        skillKey: "count_to_10",
        correct: true,
      });
    }

    // A just-failed above-band skill is not a "challenge" — arm cold on ONE
    // of the two above-band siblings.
    await t.run(async (ctx) =>
      ctx.db.insert("practiceAttempts", {
        scholarId: scholar,
        nodeKey: ABOVE_BAND_COLD,
        correct: false,
        createdAt: Date.now(),
      }),
    );

    const session = await asScholar.query(api.practiceSkills.practiceSession, {
      scholarId: scholar,
      size: 8,
      seed: 77,
    });

    // Required set never contains an above-band key regardless.
    for (const it of session.items) {
      expect(it.skillKey).not.toBe(ABOVE_BAND_COLD);
      expect(it.skillKey).not.toBe(ABOVE_BAND_HOT);
    }
    // The cold above-band key is excluded from the challenge tail entirely —
    // it is not "a challenge" while it's still a fresh miss.
    for (const it of session.challenge) {
      expect(it.skillKey).not.toBe(ABOVE_BAND_COLD);
    }
    // Its non-cold sibling still surfaces there, proving the exclusion is
    // targeted (not an accidental empty challenge tail).
    expect(session.challenge.some((it) => it.skillKey === ABOVE_BAND_HOT)).toBe(true);
  });
});
