import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "../schema";
import { api } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";

const modules = (
  import.meta as ImportMeta & {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("../**/*.ts");

const DOMAIN = "whole-number-arithmetic";
const FROM_KEY = "story_application_skill";
const TO_KEY = "story_application_world";
const STORY_HOOK = "A story application hook";

function makeHarness() {
  return convexTest(schema, modules);
}
type Harness = ReturnType<typeof makeHarness>;

async function seedScholar(t: Harness) {
  return await t.run(async (ctx) =>
    ctx.db.insert("users", {
      name: "Story Application Scholar",
      username: "story-application-scholar",
      role: "scholar",
    }),
  );
}

async function asUser(t: Harness, userId: Id<"users">) {
  const sessionId = await t.run(async (ctx) => {
    const session: Omit<Doc<"authSessions">, "_id" | "_creationTime"> = {
      userId,
      expirationTime: Date.now() + 3_600_000,
    };
    return await ctx.db.insert("authSessions", session);
  });
  return t.withIdentity({
    subject: `${userId}|${sessionId}`,
    issuer: "https://convex.dev",
  });
}

async function seedStoryApplication(t: Harness, scholarId: Id<"users">) {
  return await t.run(async (ctx) => {
    await ctx.db.insert("knowledgeNodes", {
      nodeKey: FROM_KEY,
      label: "Story application skill",
      domain: DOMAIN,
      strand: "story-applications",
      source: "practice",
    });
    await ctx.db.insert("knowledgeNodes", {
      nodeKey: TO_KEY,
      label: "Story application world",
      domain: "history",
    });
    await ctx.db.insert("knowledgeNodeEdges", {
      fromKey: FROM_KEY,
      toKey: TO_KEY,
      domain: "history",
      kind: "bridge",
      method: "curated",
      story: {
        kind: "applies",
        hook: STORY_HOOK,
        narrative: "Server-only narrative",
        source: "SECRET_STORY_SOURCE",
        provenance: "registry",
      },
    });
    await ctx.db.insert("practiceMastery", {
      scholarId,
      skillKey: FROM_KEY,
      domain: DOMAIN,
      strand: "story-applications",
      repetition: 3,
      halfLifeDays: 30,
      lastPracticedAt: Date.now(),
      frontier: false,
      source: "practice",
      updatedAt: Date.now(),
    });
    const first = await ctx.db.insert("practiceItems", {
      skillKey: FROM_KEY,
      domain: DOMAIN,
      stem: "First story application",
      answerType: "integer",
      answerCanonical: "17",
      verifierKind: "arithmetic",
      tier: "stretch",
      storyToKey: TO_KEY,
      technique: "application_interpret",
      source: "authored",
      verifiedAt: Date.now(),
    });
    const second = await ctx.db.insert("practiceItems", {
      skillKey: FROM_KEY,
      domain: DOMAIN,
      stem: "Second story application",
      answerType: "integer",
      answerCanonical: "29",
      verifierKind: "arithmetic",
      tier: "stretch",
      storyToKey: TO_KEY,
      technique: "application_model",
      source: "authored",
      verifiedAt: Date.now(),
    });
    await ctx.db.insert("practiceItems", {
      skillKey: FROM_KEY,
      domain: DOMAIN,
      stem: "Unrelated stretch item",
      answerType: "integer",
      answerCanonical: "41",
      verifierKind: "arithmetic",
      tier: "stretch",
      technique: "casework",
      source: "authored",
      verifiedAt: Date.now(),
    });
    return [first, second];
  });
}

const baseArgs = {
  seed: 42,
  domain: DOMAIN,
};

describe("practiceSession — story application hint", () => {
  test("a valid hint serves exactly the edge's application items as one stretch segment", async () => {
    const t = makeHarness();
    const scholarId = await seedScholar(t);
    const itemIds = await seedStoryApplication(t, scholarId);
    const asScholar = await asUser(t, scholarId);

    const result = await asScholar.query(api.practiceSkills.practiceSession, {
      scholarId,
      ...baseArgs,
      storyHint: { fromKey: FROM_KEY, toKey: TO_KEY },
    });

    expect(
      "storyApplicationMatched" in result
        ? result.storyApplicationMatched
        : undefined,
    ).toBe(true);
    expect(result.items.map((item) => item.itemId).sort()).toEqual(
      itemIds.map((id) => `gen#${id}`).sort(),
    );
    expect(result.items).toHaveLength(itemIds.length);
    expect(result.items.every((item) => item.lane === "stretch")).toBe(true);
    expect(result.items.every((item) => item.storyHook === STORY_HOOK)).toBe(
      true,
    );
    expect(result.challenge).toEqual([]);
    expect(result.stretch).toEqual([]);
    expect(result.segments).toEqual([
      { kind: "stretch", count: result.items.length },
    ]);
    expect(
      result.segments.reduce((sum, segment) => sum + segment.count, 0),
    ).toBe(result.items.length);
  });

  test("a bogus hint falls through to the un-hinted session unchanged", async () => {
    const t = makeHarness();
    const scholarId = await seedScholar(t);
    await seedStoryApplication(t, scholarId);
    const asScholar = await asUser(t, scholarId);

    const baseline = await asScholar.query(api.practiceSkills.practiceSession, {
      scholarId,
      ...baseArgs,
    });
    const result = await asScholar.query(api.practiceSkills.practiceSession, {
      scholarId,
      ...baseArgs,
      storyHint: { fromKey: FROM_KEY, toKey: "stale-world" },
    });

    expect(result).toEqual(baseline);
    expect(
      "storyApplicationMatched" in result
        ? result.storyApplicationMatched
        : undefined,
    ).toBeUndefined();
  });

  test("existing application evidence makes the hint fall through", async () => {
    const t = makeHarness();
    const scholarId = await seedScholar(t);
    await seedStoryApplication(t, scholarId);
    await t.run(async (ctx) => {
      await ctx.db.insert("masteryObservations", {
        scholarId,
        conceptLabel: "Story application skill",
        domain: DOMAIN,
        nodeKey: FROM_KEY,
        observedAt: Date.now(),
        transcriptExcerpt: "Already solved this application",
        masteryLevel: 4,
        confidenceScore: 0.9,
        evidenceSummary: "Prior application success",
        evidenceType: "application_success",
        attemptContext: "practice",
        studentInitiated: true,
        isSuperseded: false,
      });
    });
    const asScholar = await asUser(t, scholarId);

    const baseline = await asScholar.query(api.practiceSkills.practiceSession, {
      scholarId,
      ...baseArgs,
    });
    const result = await asScholar.query(api.practiceSkills.practiceSession, {
      scholarId,
      ...baseArgs,
      storyHint: { fromKey: FROM_KEY, toKey: TO_KEY },
    });

    expect(result).toEqual(baseline);
    expect(
      "storyApplicationMatched" in result
        ? result.storyApplicationMatched
        : undefined,
    ).toBeUndefined();
  });
});
