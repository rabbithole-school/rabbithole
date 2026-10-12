/**
 * Regression: a session spawned by clicking "Explore" on a seed
 * (sessions.createFromSeed) has NO unit/lesson/activity anchor, so before this
 * fix the tutor opened cold — "what's the context?" / "I can't see any
 * materials" — because getSessionContext never read session.seedId. These tests
 * pin that the originating seed now flows into the tutor's context + prompt.
 */
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "../schema";
import { api, internal } from "../_generated/api";
import { buildTutorSystemPrompt } from "../sessionStreamHelpers";
import type { Doc, Id } from "../_generated/dataModel";
import { MATH_CROSS_DOMAIN_SEEDS } from "../lib/practice/crossDomainSeeds";
import { SEED_CARD_QUESTIONS } from "../lib/practice/seedCardQuestions";

const modules = (
  import.meta as ImportMeta & {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("../**/*.ts");

async function withScholar(
  t: ReturnType<typeof convexTest>,
  scholarId: Id<"users">,
) {
  const sessionId = await t.run(async (ctx) => {
    const session: Omit<Doc<"authSessions">, "_id" | "_creationTime"> = {
      userId: scholarId,
      expirationTime: Date.now() + 1000 * 60 * 60,
    };
    return await ctx.db.insert("authSessions", session);
  });
  return t.withIdentity({
    subject: `${scholarId}|${sessionId}`,
    issuer: "https://convex.dev",
  });
}

/** The done-screen card recorded as shown for this seed. */
async function markCardShown(
  t: ReturnType<typeof convexTest>,
  scholarId: Id<"users">,
  seedId: Id<"seeds">,
) {
  await t.run(async (ctx) =>
    ctx.db.insert("momentEvents", {
      scholarId,
      kind: "seed",
      seedId,
      trigger: "fluency_transition",
      offeredAt: Date.now(),
      outcome: "offered",
      clientEventId: `card-${seedId}`,
    }),
  );
}

describe("seed-spawned session origin context", () => {
  test("createFromSeed → getSessionContext surfaces the originating seed", async () => {
    const t = convexTest(schema, modules);

    const scholarId = await t.run(async (ctx) =>
      ctx.db.insert("users", {
        name: "Oliver",
        username: "oliver",
        role: "scholar",
      }),
    );

    const seedId = await t.run(async (ctx) =>
      ctx.db.insert("seeds", {
        scholarId,
        origin: "ai",
        status: "active",
        topic: "Heat transfer and fluid dynamics in fire behavior",
        domain: "Physics",
        suggestionType: "depth_probe",
        rationale: "He's wrestling with gas behavior complexity.",
        approachHint: "Create visible demonstrations of convection currents.",
        connectionTo: "His hypothetical about NO₂ fire safety reversal",
      }),
    );

    const asScholar = await withScholar(t, scholarId);
    const { id: sessionId } = await asScholar.mutation(
      api.sessions.createFromSeed,
      { seedId },
    );

    // The session is anchorless (no activity/lesson/unit) but carries seedId.
    const session = await t.run(async (ctx) => ctx.db.get(sessionId));
    expect(session?.activityId).toBeUndefined();
    expect(session?.lessonId).toBeUndefined();
    expect(session?.unitId).toBeUndefined();
    expect(session?.seedId).toBe(seedId);

    const context = await t.query(internal.sessionHelpers.getSessionContext, {
      sessionId,
    });

    expect(context?.seedOriginContext).toEqual({
      topic: "Heat transfer and fluid dynamics in fire behavior",
      domain: "Physics",
      rationale: "He's wrestling with gas behavior complexity.",
      approachHint: "Create visible demonstrations of convection currents.",
      connectionTo: "His hypothetical about NO₂ fire safety reversal",
      suggestionType: "depth_probe",
      // Only a cross-domain seed has a done-screen card to carry forward.
      card: null,
      hasStructure: false,
      // Started by the scholar, not assigned by a teacher.
      assignedAsHomework: false,
      // No question card was answered for this seed.
      cardAnswer: null,
      // A non-story seed carries no story-thread grounding.
      storyThreadContext: null,
    });

    const prompt = buildTutorSystemPrompt(context!);
    expect(prompt).toContain("SESSION FOCUS — SELF-DIRECTED EXPLORATION");
    expect(prompt).toContain(
      "Heat transfer and fluid dynamics in fire behavior",
    );
    expect(prompt).toContain("THIS topic");
  });

  test("a cross_domain seed's session context carries suggestionType", async () => {
    const t = convexTest(schema, modules);

    const scholarId = await t.run(async (ctx) =>
      ctx.db.insert("users", {
        name: "Maya",
        username: "maya",
        role: "scholar",
      }),
    );

    const seedId = await t.run(async (ctx) =>
      ctx.db.insert("seeds", {
        scholarId,
        origin: "ai",
        status: "active",
        topic: "Symmetry in origami and group theory",
        domain: "Mathematics",
        suggestionType: "cross_domain",
        rationale: "She folds paper obsessively.",
        approachHint: "Bridge her folding intuition to formal symmetry groups.",
        connectionTo: "Her origami crane collection",
      }),
    );

    await markCardShown(t, scholarId, seedId);
    const asScholar = await withScholar(t, scholarId);
    const { id: sessionId } = await asScholar.mutation(
      api.sessions.createFromSeed,
      { seedId },
    );

    const context = await t.query(internal.sessionHelpers.getSessionContext, {
      sessionId,
    });
    expect(context?.seedOriginContext?.suggestionType).toBe("cross_domain");
    // A topic the registry doesn't carry: the card is the row's own copy.
    expect(context?.seedOriginContext?.card).toEqual({
      title: "Symmetry in origami and group theory",
      teaser: "She folds paper obsessively.",
    });
  });

  test("a seed launched from the Sky, never shown as a card, carries no card", async () => {
    const t = convexTest(schema, modules);
    const scholarId = await t.run(async (ctx) =>
      ctx.db.insert("users", { name: "Sky Scholar", role: "scholar" }),
    );
    const seedId = await t.run(async (ctx) =>
      ctx.db.insert("seeds", {
        scholarId,
        origin: "ai",
        status: "active",
        topic: "Symmetry in origami and group theory",
        domain: "Mathematics",
        suggestionType: "cross_domain",
        rationale: "Folding paper.",
      }),
    );
    const asScholar = await withScholar(t, scholarId);
    const { id: sessionId } = await asScholar.mutation(api.sessions.createFromSeed, { seedId });
    const context = await t.query(internal.sessionHelpers.getSessionContext, { sessionId });
    expect(context?.seedOriginContext?.suggestionType).toBe("cross_domain");
    expect(context?.seedOriginContext?.card).toBeNull();
  });

  test("a registry seed's session carries the card the scholar read, not its minted copy", async () => {
    const t = convexTest(schema, modules);
    const def = MATH_CROSS_DOMAIN_SEEDS.find(
      (s) => s.gateSkillKey === "exponents_repeated_mult",
    )!;

    const scholarId = await t.run(async (ctx) =>
      ctx.db.insert("users", {
        name: "Hoku Makani",
        username: "hoku",
        role: "scholar",
      }),
    );
    const seedId = await t.run(async (ctx) =>
      ctx.db.insert("seeds", {
        scholarId,
        origin: "ai-constellation",
        status: "active",
        topic: def.topic,
        domain: "Mathematics",
        suggestionType: "cross_domain",
        rationale: def.rationale,
        scholarInvitation: "OLD_WORKSHEET_INVITATION",
        connectionTo: def.connectionTo,
        sourceLens: "math-practice",
      }),
    );

    await markCardShown(t, scholarId, seedId);
    const asScholar = await withScholar(t, scholarId);
    const { id: sessionId } = await asScholar.mutation(
      api.sessions.createFromSeed,
      { seedId },
    );
    const context = await t.query(internal.sessionHelpers.getSessionContext, {
      sessionId,
    });

    expect(context?.seedOriginContext?.card).toMatchObject({
      title: def.cardTitle,
      teaser: def.scholarInvitation,
    });
    const prompt = buildTutorSystemPrompt(context!);
    expect(prompt).toContain(def.scholarInvitation);
    expect(prompt).not.toContain("OLD_WORKSHEET_INVITATION");
  });

  test("a non-seed (blank) session has no origin context", async () => {
    const t = convexTest(schema, modules);

    const scholarId = await t.run(async (ctx) =>
      ctx.db.insert("users", {
        name: "Kai",
        username: "kai",
        role: "scholar",
      }),
    );

    const asScholar = await withScholar(t, scholarId);
    const { id: sessionId } = await asScholar.mutation(api.sessions.create, {});

    const context = await t.query(internal.sessionHelpers.getSessionContext, {
      sessionId,
    });
    expect(context?.seedOriginContext).toBeNull();
    expect(buildTutorSystemPrompt(context!)).not.toContain("SESSION FOCUS");
  });

  test("a session from a seed carries what the question card asked and the scholar answered", async () => {
    const t = convexTest(schema, modules);
    const [topic, question] = Object.entries(SEED_CARD_QUESTIONS)[0]!;
    const scholarId = await t.run(async (ctx) =>
      ctx.db.insert("users", { name: "Ada", username: "ada", role: "scholar" }),
    );
    const seedId = await t.run(async (ctx) =>
      ctx.db.insert("seeds", {
        scholarId,
        origin: "ai",
        status: "active",
        topic,
        domain: "Mathematics",
        rationale: "A nearby idea.",
        suggestionType: "cross_domain",
      }),
    );
    const wrong = (question.answerIndex + 1) % question.choices.length;
    await t.run(async (ctx) => {
      await ctx.db.insert("momentEvents", {
        scholarId,
        kind: "seed",
        seedId,
        trigger: "fluency_transition",
        offeredAt: Date.now(),
        outcome: "probed",
        clientEventId: "ev-1",
        answerIndex: wrong,
        answerCorrect: false,
        answeredAt: Date.now(),
      });
    });

    const asScholar = await withScholar(t, scholarId);
    const { id: sessionId } = await asScholar.mutation(
      api.sessions.createFromSeed,
      { seedId },
    );
    const context = await t.query(internal.sessionHelpers.getSessionContext, {
      sessionId,
    });
    expect(context?.seedOriginContext?.cardAnswer).toEqual({
      prompt: question.prompt,
      choice: question.choices[wrong],
      correct: false,
    });
    const prompt = buildTutorSystemPrompt(context!);
    expect(prompt).toContain(question.prompt);
    expect(prompt).toContain(question.choices[wrong]!);
  });
});
