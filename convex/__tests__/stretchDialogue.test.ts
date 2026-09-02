/**
 * Stretch DIALOGUE (rubric'd-chat vessel) + rung-1 designed-target attribution
 * — the deterministic halves of review/beast-academy-lessons.html §8. The LLM
 * chat/judge itself is exercised live (embedded browser); these tests cover:
 *
 *   • parseDialogueVerdict — fail-closed hardening of the judge tool output
 *     (pass computed from per-criterion grades, never the model's say-so);
 *   • dialogueContext — only a real, rubric'd dialogue item resolves;
 *   • recordDialogueOutcome — a pass writes ONE stretch_dialogue depth
 *     observation (deduped against BOTH stretch evidence kinds) and never
 *     touches practiceMastery; a non-pass writes telemetry only;
 *   • serving — an ungradeable dialogue row (no rubric) never reaches the
 *     stretch tail; submitAnswer refuses a dialogue item;
 *   • masteryObservations.record — an activity's declared probeSkillKeys act
 *     as the second-chance nodeKey resolution shortlist.
 */
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "../schema";
import { api, internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import { STRETCH_EVIDENCE_TYPE } from "../practiceSkills";
import {
  dialogueDedupKey,
  dialogueEvidenceExcerpt,
  parseDialogueVerdict,
  STRETCH_DIALOGUE_EVIDENCE_TYPE,
} from "../lib/practice/dialogueStretch";

const modules = (
  import.meta as ImportMeta & {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("../**/*.ts");

const DOMAIN = "whole-number-arithmetic";
const SKILL_KEY = "dialogue_test_skill";
const DAY_MS = 86_400_000;

async function seedScholar(t: ReturnType<typeof convexTest>) {
  return await t.run(async (ctx) =>
    ctx.db.insert("users", {
      name: "Dialogue Scholar",
      username: "dialogue-scholar",
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

async function seedNode(t: ReturnType<typeof convexTest>, nodeKey = SKILL_KEY, label?: string) {
  await t.run(async (ctx) => {
    await ctx.db.insert("knowledgeNodes", {
      nodeKey,
      label: label ?? `Label for ${nodeKey}`,
      domain: DOMAIN,
      strand: "mult-divide",
      source: "practice",
    });
  });
}

async function keepDomainOpen(t: ReturnType<typeof convexTest>) {
  await seedNode(t, "dialogue_test_pending_skill");
}

async function seedDialogueItem(
  t: ReturnType<typeof convexTest>,
  opts: { rubricCriteria?: string[]; bloomLevel?: number } = {},
) {
  return await t.run(async (ctx) =>
    ctx.db.insert("practiceItems", {
      skillKey: SKILL_KEY,
      domain: DOMAIN,
      stem: "Explain why the trick works.",
      answerType: "dialogue",
      answerCanonical: "",
      verifierKind: "rubric_dialogue",
      tier: "stretch",
      technique: "structure",
      bloomLevel: opts.bloomLevel ?? 5,
      rubricCriteria: opts.rubricCriteria ?? ["Names the idea.", "Defends it."],
      source: "authored",
      verifiedAt: Date.now(),
    }),
  );
}

async function seedFluentMastery(t: ReturnType<typeof convexTest>, scholarId: Id<"users">) {
  await t.run(async (ctx) =>
    ctx.db.insert("practiceMastery", {
      scholarId,
      skillKey: SKILL_KEY,
      domain: DOMAIN,
      strand: "mult-divide",
      repetition: 3,
      halfLifeDays: 30,
      lastPracticedAt: Date.now() - DAY_MS,
      lastAttemptAt: Date.now() - DAY_MS,
      frontier: false,
      source: "practice",
      latencySamplesMs: [1_300, 1_000, 1_100],
      latencyMedianMs: 1_100,
      latencySpreadMs: 100,
      accelStreak: 2,
      becameFluentAt: Date.now() - 2 * DAY_MS,
      frontierAdvancedAt: Date.now() - 3 * DAY_MS,
      updatedAt: Date.now() - DAY_MS,
    }),
  );
}

async function seedDialogueTranscript(
  t: ReturnType<typeof convexTest>,
  itemId: string,
  dedupKey: string,
  scholarTurn?: string,
) {
  await t.mutation(internal.practiceDialogue.startDialogueTranscript, {
    dedupKey,
    itemId,
    skillKey: SKILL_KEY,
    stem: "Explain why the trick works.",
  });
  if (scholarTurn) {
    await t.mutation(internal.practiceDialogue.appendDialogueTurn, {
      dedupKey,
      itemId,
      turn: { role: "user", content: scholarTurn },
    });
  }
}

describe("parseDialogueVerdict — fail-closed hardening", () => {
  test("pass is computed from per-criterion grades, missing criteria are not-met", () => {
    const v = parseDialogueVerdict(
      {
        criteria: [
          { index: 1, met: true, evidence: "said it" },
          // criterion 2 missing entirely
        ],
        bestQuote: "the tops cancel with the bottoms",
        note: "got halfway",
      },
      2,
    );
    expect(v.passed).toBe(false);
    expect(v.metCount).toBe(1);
    expect(v.total).toBe(2);
  });

  test("all criteria met → passed; garbage input → fail-closed", () => {
    const good = parseDialogueVerdict(
      { criteria: [{ index: 1, met: true }, { index: 2, met: true }], bestQuote: "q", note: "n" },
      2,
    );
    expect(good.passed).toBe(true);
    const garbage = parseDialogueVerdict("nonsense", 2);
    expect(garbage.passed).toBe(false);
    expect(garbage.metCount).toBe(0);
    const empty = parseDialogueVerdict({ criteria: [] }, 0);
    expect(empty.passed).toBe(false); // zero-criteria rubric can never pass
  });

  test("the evidence excerpt is always copied from a persisted scholar turn", () => {
    const transcript = [
      { role: "assistant" as const, content: "What do you notice?" },
      { role: "user" as const, content: "The tops cancel in a chain because each denominator returns." },
    ];
    expect(dialogueEvidenceExcerpt("The tops cancel in a chain", transcript)).toBe(
      "The tops cancel in a chain",
    );
    expect(dialogueEvidenceExcerpt("hallucinated quote", transcript)).toBe(
      transcript[1].content,
    );
  });

  test("dialogue session keys bind caller, item, and server token", () => {
    const key = dialogueDedupKey("u1", "gen#item", "server-token");
    expect(key).toMatch(/^[0-9a-f]{16}$/);
    expect(dialogueDedupKey("u2", "gen#item", "server-token")).not.toBe(key);
    expect(dialogueDedupKey("u1", "gen#other", "server-token")).not.toBe(key);
    expect(dialogueDedupKey("u1", "gen#item", "other-token")).not.toBe(key);
  });
});

describe("dialogueContext — server-side resolution", () => {
  test("resolves a real dialogue item; rejects non-dialogue and rubric-less rows", async () => {
    const t = convexTest(schema, modules);
    await seedNode(t);
    const good = await seedDialogueItem(t);
    const ctxGood = await t.run(async (ctx) =>
      ctx.runQuery(internal.practiceDialogue.dialogueContext, { itemId: `gen#${good}` }),
    );
    expect(ctxGood?.skillKey).toBe(SKILL_KEY);
    expect(ctxGood?.rubricCriteria).toHaveLength(2);

    const noRubric = await seedDialogueItem(t, { rubricCriteria: [] });
    expect(
      await t.run(async (ctx) =>
        ctx.runQuery(internal.practiceDialogue.dialogueContext, { itemId: `gen#${noRubric}` }),
      ),
    ).toBeNull();

    expect(
      await t.run(async (ctx) =>
        ctx.runQuery(internal.practiceDialogue.dialogueContext, { itemId: "not_gen" }),
      ),
    ).toBeNull();
  });
});

describe("recordDialogueOutcome — depth evidence rules", () => {
  const outcomeArgs = (scholarId: Id<"users">, passed: boolean, dedupKey: string) => ({
    dedupKey,
    scholarId,
    itemId: "gen#whatever",
    skillKey: SKILL_KEY,
    skillLabel: `Label for ${SKILL_KEY}`,
    domain: DOMAIN,
    bloomLevel: 5,
    technique: "structure",
    passed,
    metCount: passed ? 2 : 1,
    total: 2,
    note: "judge note",
    bestQuote: "the tops cancel in a chain",
  });

  test("a PASS writes one stretch_dialogue observation and never touches mastery", async () => {
    const t = convexTest(schema, modules);
    const scholar = await seedScholar(t);
    await seedNode(t);
    await seedFluentMastery(t, scholar);
    const before = await t.run(async (ctx) => (await ctx.db.query("practiceMastery").collect())[0]);
    const dedupKey = "pass-dialogue-log";
    await seedDialogueTranscript(
      t,
      "gen#whatever",
      dedupKey,
      "the tops cancel in a chain",
    );

    const res = await t.run(async (ctx) =>
      ctx.runMutation(
        internal.practiceDialogue.recordDialogueOutcome,
        outcomeArgs(scholar, true, dedupKey),
      ),
    );
    expect(res.observationWritten).toBe(true);

    const obs = await t.run(async (ctx) => await ctx.db.query("masteryObservations").collect());
    expect(obs).toHaveLength(1);
    expect(obs[0].evidenceType).toBe(STRETCH_DIALOGUE_EVIDENCE_TYPE);
    expect(obs[0].masteryLevel).toBe(5);
    expect(obs[0].transcriptExcerpt).toBe("the tops cancel in a chain");
    expect(obs[0].confidenceScore).toBeLessThan(0.85); // model-judged < verifier-graded

    const after = await t.run(async (ctx) => (await ctx.db.query("practiceMastery").collect())[0]);
    expect(after).toEqual(before);

    const attempts = await t.run(async (ctx) => await ctx.db.query("practiceAttempts").collect());
    expect(attempts).toHaveLength(1);
    expect(attempts[0].lane).toBe("stretch");
    expect(attempts[0].correct).toBe(true);
  });

  test("a NON-pass writes telemetry only; a pass dedupes against existing stretch_success", async () => {
    const t = convexTest(schema, modules);
    const scholar = await seedScholar(t);
    await seedNode(t);
    await seedFluentMastery(t, scholar);
    const before = await t.run(async (ctx) => (await ctx.db.query("practiceMastery").collect())[0]);
    const missKey = "miss-dialogue-log";
    await seedDialogueTranscript(
      t,
      "gen#whatever",
      missKey,
      "the tops might cancel somehow",
    );

    const miss = await t.run(async (ctx) =>
      ctx.runMutation(
        internal.practiceDialogue.recordDialogueOutcome,
        outcomeArgs(scholar, false, missKey),
      ),
    );
    expect(miss.observationWritten).toBe(false);
    expect(await t.run(async (ctx) => (await ctx.db.query("masteryObservations").collect()).length)).toBe(0);
    const afterMiss = await t.run(async (ctx) => (await ctx.db.query("practiceMastery").collect())[0]);
    expect(afterMiss).toEqual(before);

    // A verifier-graded claim at the same level already exists → dialogue pass dedupes.
    await t.run(async (ctx) => {
      await ctx.db.insert("masteryObservations", {
        scholarId: scholar,
        conceptLabel: `Label for ${SKILL_KEY}`,
        domain: DOMAIN,
        nodeKey: SKILL_KEY,
        observedAt: Date.now(),
        transcriptExcerpt: "prior",
        masteryLevel: 5,
        confidenceScore: 0.85,
        evidenceSummary: "prior",
        evidenceType: STRETCH_EVIDENCE_TYPE,
        attemptContext: "practice",
        studentInitiated: true,
        isSuperseded: false,
      });
    });
    const passKey = "deduped-pass-dialogue-log";
    await seedDialogueTranscript(
      t,
      "gen#whatever",
      passKey,
      "the tops cancel in a chain",
    );
    const pass = await t.run(async (ctx) =>
      ctx.runMutation(
        internal.practiceDialogue.recordDialogueOutcome,
        outcomeArgs(scholar, true, passKey),
      ),
    );
    expect(pass.observationWritten).toBe(false);
    expect(await t.run(async (ctx) => (await ctx.db.query("masteryObservations").collect()).length)).toBe(1);
  });

  test("a fabricated bestQuote cannot grade an empty server-held transcript", async () => {
    const t = convexTest(schema, modules);
    const scholar = await seedScholar(t);
    await seedNode(t);
    await seedFluentMastery(t, scholar);
    const before = await t.run(async (ctx) => (await ctx.db.query("practiceMastery").collect())[0]);
    const dedupKey = "fabricated-empty-dialogue-log";
    await seedDialogueTranscript(t, "gen#whatever", dedupKey);

    await expect(
      t.mutation(
        internal.practiceDialogue.recordDialogueOutcome,
        outcomeArgs(scholar, true, dedupKey),
      ),
    ).rejects.toThrow(/no scholar evidence/);
    expect(await t.run(async (ctx) => (await ctx.db.query("masteryObservations").collect()).length)).toBe(0);
    expect(await t.run(async (ctx) => (await ctx.db.query("practiceAttempts").collect()).length)).toBe(0);
    const after = await t.run(async (ctx) => (await ctx.db.query("practiceMastery").collect())[0]);
    expect(after).toEqual(before);
  });
});

describe("serving + grading guards", () => {
  test("a rubric-less dialogue row never reaches the stretch tail; a rubric'd one serves", async () => {
    const t = convexTest(schema, modules);
    const scholar = await seedScholar(t);
    const asScholar = await asUser(t, scholar);
    await seedNode(t);
    await keepDomainOpen(t);
    await seedFluentMastery(t, scholar);
    await seedDialogueItem(t, { rubricCriteria: [] });

    const res1 = await asScholar.query(api.practiceSkills.practiceSession, {
      scholarId: scholar,
      seed: 7,
      domain: DOMAIN,
    });
    expect(res1.stretch).toEqual([]);

    const good = await seedDialogueItem(t);
    const res2 = await asScholar.query(api.practiceSkills.practiceSession, {
      scholarId: scholar,
      seed: 7,
      domain: DOMAIN,
    });
    const stretch = res2.stretch as { itemId: string; answerType: string }[];
    expect(stretch.map((i) => i.itemId)).toContain(`gen#${good}`);
    expect(stretch.find((i) => i.itemId === `gen#${good}`)?.answerType).toBe("dialogue");
  });

  test("submitAnswer refuses a dialogue item", async () => {
    const t = convexTest(schema, modules);
    const scholar = await seedScholar(t);
    const asScholar = await asUser(t, scholar);
    await seedNode(t);
    const itemId = await seedDialogueItem(t);
    await expect(
      asScholar.mutation(api.practiceSkills.submitAnswer, {
        scholarId: scholar,
        itemId: `gen#${itemId}`,
        answer: "42",
      }),
    ).rejects.toThrow(/conversation/);
  });
});

describe("masteryObservations.record — rung 1 designed-target attribution", () => {
  test("an activity's probeSkillKeys resolve an otherwise-unresolvable label; unrelated labels stay node-less", async () => {
    const t = convexTest(schema, modules);
    const scholar = await seedScholar(t);
    // Two nodes with labels that would AMBIGUOUSLY fuzzy-match the concept —
    // the global resolver punts on ambiguity; the shortlist decides it.
    await seedNode(t, "frac_equiv_visual", "Equivalent fractions (visual models)");
    await seedNode(t, "frac_equiv_general", "Equivalent fractions (general rule)");

    const { sessionId } = await t.run(async (ctx) => {
      const teacherId = await ctx.db.insert("users", {
        name: "T",
        username: "attrib-teacher",
        role: "teacher",
      });
      const unitId = await ctx.db.insert("units", {
        teacherId,
        title: "U",
        isActive: true,
      });
      const lessonId = await ctx.db.insert("lessons", { unitId, title: "L", order: 0 });
      const activityId = await ctx.db.insert("activities", {
        lessonId,
        title: "A",
        kind: "online",
        systemPrompt: "x",
        order: 0,
        probeSkillKeys: ["frac_equiv_visual"],
      });
      const sessionId = await ctx.db.insert("sessions", {
        userId: scholar,
        title: "S",
        isArchived: false,
        activityId,
      });
      return { sessionId };
    });

    // "equivalent fractions" alone matches BOTH nodes globally (ambiguous → no
    // key) but exactly one on the activity's declared shortlist.
    await t.run(async (ctx) =>
      ctx.runMutation(internal.masteryObservations.record, {
        scholarId: scholar,
        conceptLabel: "equivalent fractions",
        domain: DOMAIN,
        sessionId,
        transcriptExcerpt: "…",
        masteryLevel: 3,
        confidenceScore: 0.8,
        evidenceSummary: "…",
        evidenceType: "direct_demonstration",
        attemptContext: "conversation",
        studentInitiated: false,
      }),
    );
    const obs = await t.run(async (ctx) => await ctx.db.query("masteryObservations").collect());
    expect(obs).toHaveLength(1);
    expect(obs[0].nodeKey).toBe("frac_equiv_visual");

    // A label unrelated to the declared targets still resolves to nothing —
    // declared targets are a shortlist for MATCHING, never blanket credit.
    await t.run(async (ctx) =>
      ctx.runMutation(internal.masteryObservations.record, {
        scholarId: scholar,
        conceptLabel: "long division stamina",
        domain: DOMAIN,
        sessionId,
        transcriptExcerpt: "…",
        masteryLevel: 2,
        confidenceScore: 0.8,
        evidenceSummary: "…",
        evidenceType: "direct_demonstration",
        attemptContext: "conversation",
        studentInitiated: false,
      }),
    );
    const obs2 = await t.run(async (ctx) => await ctx.db.query("masteryObservations").collect());
    const unrelated = obs2.find((o) => o.conceptLabel === "long division stamina");
    expect(unrelated?.nodeKey).toBeUndefined();
  });

  test("competing near targets plus weak evidence remain unresolved", async () => {
    const t = convexTest(schema, modules);
    const scholar = await seedScholar(t);
    await seedNode(t, "frac_area", "Equivalent fractions with area models");
    await seedNode(t, "frac_number_line", "Equivalent fractions on number lines");
    // Makes the global fuzzy pass ambiguous on "area"; the activity shortlist
    // must not turn that ambiguity into credit for whichever target looks closer.
    await seedNode(t, "geometry_area", "Area and perimeter sketches");

    const sessionId = await t.run(async (ctx) => {
      const teacherId = await ctx.db.insert("users", {
        name: "T2",
        username: "attrib-teacher-2",
        role: "teacher",
      });
      const unitId = await ctx.db.insert("units", {
        teacherId,
        title: "U2",
        isActive: true,
      });
      const lessonId = await ctx.db.insert("lessons", { unitId, title: "L2", order: 0 });
      const activityId = await ctx.db.insert("activities", {
        lessonId,
        title: "A2",
        kind: "online",
        systemPrompt: "x",
        order: 0,
        probeSkillKeys: ["frac_area", "frac_number_line"],
      });
      return await ctx.db.insert("sessions", {
        userId: scholar,
        title: "S2",
        isArchived: false,
        activityId,
      });
    });

    await t.run(async (ctx) =>
      ctx.runMutation(internal.masteryObservations.record, {
        scholarId: scholar,
        conceptLabel: "area sketch",
        domain: DOMAIN,
        sessionId,
        transcriptExcerpt: "I drew an area sketch.",
        masteryLevel: 2,
        confidenceScore: 0.6,
        evidenceSummary: "Weak evidence that does not identify either fraction target.",
        evidenceType: "direct_demonstration",
        attemptContext: "conversation",
        studentInitiated: false,
      }),
    );

    const observations = await t.run(async (ctx) =>
      ctx.db.query("masteryObservations").collect(),
    );
    expect(observations).toHaveLength(1);
    expect(observations[0].nodeKey).toBeUndefined();
  });
});
