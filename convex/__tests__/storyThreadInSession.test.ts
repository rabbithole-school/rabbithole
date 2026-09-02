import { convexTest } from "convex-test";
import type { TestConvex } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "../schema";
import { api, internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { STORY_THREAD_POLICY } from "../lib/practice/servable";
import { buildStoryThreadSection } from "../sessionHelpers";

const modules = (
  import.meta as ImportMeta & {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("../**/*.ts");

type TC = TestConvex<typeof schema>;

const DOMAIN = "fraction-arithmetic";
const FROM_KEY = "story_thread_fraction";
const TO_KEY = "story_thread_music";
const OTHER_TO_KEY = "story_thread_architecture";
const STORY_STEM = "A measure has four equal beats. How many quarter notes fill it?";

async function asScholar(t: TC, scholarId: Id<"users">) {
  const authSessionId = await t.run(async (ctx) =>
    ctx.db.insert("authSessions", {
      userId: scholarId,
      expirationTime: Date.now() + 3_600_000,
    }),
  );
  return t.withIdentity({
    subject: `${scholarId}|${authSessionId}`,
    issuer: "https://convex.dev",
  });
}

async function setup(t: TC) {
  const seeded = await t.run(async (ctx) => {
    const scholarId = await ctx.db.insert("users", {
      name: "Story Thread Scholar",
      username: "story-thread-scholar",
      role: "scholar",
    });
    await ctx.db.insert("knowledgeNodes", {
      nodeKey: FROM_KEY,
      label: "Fractions as equal parts",
      domain: DOMAIN,
      strand: "fraction-concepts",
      source: "practice",
    });
    await ctx.db.insert("knowledgeNodes", {
      nodeKey: TO_KEY,
      label: "Musical rhythm",
      domain: "music",
    });
    await ctx.db.insert("knowledgeNodeEdges", {
      fromKey: FROM_KEY,
      toKey: TO_KEY,
      domain: "music",
      kind: "bridge",
      method: "curated",
      story: {
        kind: "applies",
        hook: "Fractions keep the beat",
        narrative:
          "Half notes and quarter notes divide a measure into equal parts.",
        probe: "What changes when the beat is divided into smaller pieces?",
        source: "A verified music-theory source",
        provenance: "registry",
      },
    });
    await ctx.db.insert("practiceMastery", {
      scholarId,
      skillKey: FROM_KEY,
      domain: DOMAIN,
      strand: "fraction-concepts",
      repetition: 3,
      halfLifeDays: 30,
      lastPracticedAt: Date.now(),
      frontier: false,
      source: "practice",
      updatedAt: Date.now(),
    });
    const targetItemId = await ctx.db.insert("practiceItems", {
      skillKey: FROM_KEY,
      domain: DOMAIN,
      stem: STORY_STEM,
      answerType: "integer",
      answerCanonical: "4",
      verifierKind: "arithmetic",
      tier: "stretch",
      storyToKey: TO_KEY,
      bloomLevel: 3,
      source: "authored",
      verifiedAt: Date.now(),
    });
    const otherEdgeItemId = await ctx.db.insert("practiceItems", {
      skillKey: FROM_KEY,
      domain: DOMAIN,
      stem: "How many equal panels fit this building facade?",
      answerType: "integer",
      answerCanonical: "8",
      verifierKind: "arithmetic",
      tier: "stretch",
      storyToKey: OTHER_TO_KEY,
      bloomLevel: 3,
      source: "authored",
      verifiedAt: Date.now(),
    });
    await ctx.db.insert("practiceItems", {
      skillKey: FROM_KEY,
      domain: DOMAIN,
      stem: "An unrelated stretch problem",
      answerType: "integer",
      answerCanonical: "12",
      verifierKind: "arithmetic",
      tier: "stretch",
      source: "authored",
      verifiedAt: Date.now(),
    });
    const seedId = await ctx.db.insert("seeds", {
      scholarId,
      origin: "story",
      status: "active",
      topic: "Fractions keep the beat",
      domain: "music",
      suggestionType: "cross_domain",
      rationale: "A saved thread from the verified rhythm story.",
      storyFromKey: FROM_KEY,
      storyToKey: TO_KEY,
    });
    return { scholarId, seedId, targetItemId, otherEdgeItemId };
  });

  const scholarClient = await asScholar(t, seeded.scholarId);
  const { id: sessionId } = await scholarClient.mutation(
    api.sessions.createFromSeed,
    { seedId: seeded.seedId },
  );
  const assistantMessageId = await t.run(async (ctx) =>
    ctx.db.insert("messages", {
      sessionId,
      role: "assistant",
      content: "We have been wondering about the rhythm together.",
      flagged: false,
    }),
  );
  return {
    ...seeded,
    scholarClient,
    sessionId,
    assistantMessageId,
  };
}

async function practiceState(t: TC, scholarId: Id<"users">) {
  return await t.run(async (ctx) => ({
    mastery: await ctx.db
      .query("practiceMastery")
      .withIndex("by_scholar_skill", (q) =>
        q.eq("scholarId", scholarId).eq("skillKey", FROM_KEY),
      )
      .first(),
    attempts: await ctx.db
      .query("practiceAttempts")
      .withIndex("by_scholar", (q) => q.eq("scholarId", scholarId))
      .collect(),
  }));
}

async function applicationEvidence(t: TC, scholarId: Id<"users">) {
  return await t.run(async (ctx) =>
    ctx.db
      .query("masteryObservations")
      .withIndex("by_scholar_node", (q) =>
        q.eq("scholarId", scholarId).eq("nodeKey", FROM_KEY),
      )
      .collect(),
  );
}

describe("story-thread in-session application serving", () => {
  test("the story policy grades but records no mastery or practice attempt", async () => {
    expect(STORY_THREAD_POLICY).toEqual({
      surface: "story-thread",
      recordMastery: false,
      recordPracticeAttempt: false,
      recordLatency: false,
      classifyErrorPatterns: false,
      revealAnswer: "onCorrect",
      explanation: "none",
    });

    const t = convexTest(schema, modules);
    const scenario = await setup(t);
    const before = await practiceState(t, scenario.scholarId);

    const result = await scenario.scholarClient.mutation(
      api.practiceSkills.submitStoryThreadApplication,
      {
        sessionId: scenario.sessionId,
        itemId: `gen#${scenario.targetItemId}`,
        answer: "3",
      },
    );

    expect(result.correct).toBe(false);
    expect(result.correctAnswer).toBeUndefined();
    const after = await practiceState(t, scenario.scholarId);
    expect(after.mastery).toEqual(before.mastery);
    expect(after.attempts).toEqual([]);
  });

  test("writes application_success only for an unassisted correct answer", async () => {
    const t = convexTest(schema, modules);
    const scenario = await setup(t);
    const itemId = `gen#${scenario.targetItemId}`;

    await scenario.scholarClient.mutation(
      api.practiceSkills.submitStoryThreadApplication,
      { sessionId: scenario.sessionId, itemId, answer: "3" },
    );
    expect(await applicationEvidence(t, scenario.scholarId)).toEqual([]);

    const dontKnow = await scenario.scholarClient.mutation(
      api.practiceSkills.submitStoryThreadApplication,
      {
        sessionId: scenario.sessionId,
        itemId,
        answer: "4",
        dontKnow: true,
      },
    );
    expect(dontKnow.correct).toBe(false);
    expect(await applicationEvidence(t, scenario.scholarId)).toEqual([]);

    const correct = await scenario.scholarClient.mutation(
      api.practiceSkills.submitStoryThreadApplication,
      { sessionId: scenario.sessionId, itemId, answer: "4" },
    );
    expect(correct.correct).toBe(true);
    expect(correct.correctAnswer).toBe("4");

    const evidence = await applicationEvidence(t, scenario.scholarId);
    expect(evidence).toHaveLength(1);
    expect(evidence[0]).toMatchObject({
      evidenceType: "application_success",
      nodeKey: FROM_KEY,
      masteryLevel: 3,
      isSuperseded: false,
    });
    expect((await practiceState(t, scenario.scholarId)).attempts).toEqual([]);
  });

  test("a story seed stays a durable thread and loads canonical edge context", async () => {
    const t = convexTest(schema, modules);
    const scenario = await setup(t);

    const scheduled = await t.run((ctx) =>
      ctx.db.system.query("_scheduled_functions").collect(),
    );
    expect(scheduled).toEqual([]);

    const context = await t.query(
      internal.sessionHelpers.getSessionContext,
      { sessionId: scenario.sessionId },
    );
    expect(context?.storyThreadContext).toEqual({
      fromKey: FROM_KEY,
      toKey: TO_KEY,
      fromLabel: "Fractions as equal parts",
      toLabel: "Musical rhythm",
      toDomain: "music",
      hook: "Fractions keep the beat",
      narrative:
        "Half notes and quarter notes divide a measure into equal parts.",
      probe: "What changes when the beat is divided into smaller pieces?",
      source: "A verified music-theory source",
    });
    const prompt = buildStoryThreadSection(context?.storyThreadContext ?? null);
    expect(prompt).toContain("Stay grounded in that story");
    expect(prompt).toContain("MAY call serve_story_application_problem");
    expect(prompt).toContain("NEVER open with a problem");
  });

  test("the story tool persists exactly the edge's eligible application", async () => {
    const t = convexTest(schema, modules);
    const scenario = await setup(t);

    const result = await t.mutation(
      internal.chatPractice.serveStoryThreadApplicationItem,
      {
        sessionId: scenario.sessionId,
        currentMessageId: scenario.assistantMessageId,
        contentSoFar: "We have been wondering about the rhythm together.",
      },
    );
    expect(result.ok).toBe(true);

    const payload = await t.run(async (ctx) => {
      const messages = await ctx.db
        .query("messages")
        .withIndex("by_session", (q) =>
          q.eq("sessionId", scenario.sessionId),
        )
        .collect();
      return messages.find(
        (message) => message.role === "tool" && message.chatPractice,
      )?.chatPractice;
    });
    expect(payload).toEqual({
      kind: "typed",
      mode: "storyThread",
      itemId: `gen#${scenario.targetItemId}`,
      skillKey: FROM_KEY,
      skillLabel: "Fractions as equal parts",
      stem: STORY_STEM,
      answerType: "integer",
    });
    expect(payload?.itemId).not.toBe(`gen#${scenario.otherEdgeItemId}`);
    expect(JSON.stringify(payload)).not.toContain("answerCanonical");
  });
});
