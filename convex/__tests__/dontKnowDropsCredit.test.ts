import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "../schema";
import { api, internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import { skillAttempted } from "../practiceSkills";
import { seedScholarInInstitution, seedTestInstitution } from "./institutionTestHelpers";

const modules = (
  import.meta as ImportMeta & {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("../**/*.ts");

// "I haven't learned this yet" on a never-demonstrated skill drops its
// inferred credit (Andy, 2026-11-21): the row returns to the frontier-seed
// shape so it stops coming back as review.

const SKILL = "subtract_2digit_regroup";
const DOMAIN = "whole-number-arithmetic";

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

async function setup(row: Partial<Doc<"practiceMastery">> = {}, skill = SKILL) {
  const t = convexTest(schema, modules);
  await t.mutation(internal.practiceSkills.seedGraph, {});
  const institutionId = await seedTestInstitution(t);
  const scholarId = await seedScholarInInstitution(t, {
    institutionId,
    name: "Hoku Makani",
    username: "hokudk",
  });
  const asScholar = await withUser(t, scholarId);
  const now = Date.now();
  const masteryId = await t.run(async (ctx) =>
    ctx.db.insert("practiceMastery", {
      scholarId,
      skillKey: skill,
      domain: DOMAIN,
      repetition: 3,
      halfLifeDays: 4,
      lastPracticedAt: now - 10 * 86_400_000,
      frontier: false,
      source: "placement",
      updatedAt: now - 10 * 86_400_000,
      ...row,
    }),
  );
  const itemId = `gen#${await t.run(async (ctx) =>
    ctx.db.insert("practiceItems", {
      skillKey: skill,
      domain: DOMAIN,
      stem: "52 - 38 = ?",
      answerType: "integer",
      answerCanonical: "14",
      source: "generated",
      verifiedAt: now,
    }),
  )}`;
  return { t, scholarId, asScholar, masteryId, itemId };
}

async function priorAttempt(
  t: ReturnType<typeof convexTest>,
  scholarId: Id<"users">,
  fields: Partial<Doc<"practiceAttempts">>,
) {
  await t.run(async (ctx) =>
    ctx.db.insert("practiceAttempts", {
      scholarId,
      nodeKey: SKILL,
      correct: true,
      domain: DOMAIN,
      createdAt: Date.now() - 86_400_000,
      ...fields,
    }),
  );
}

describe("don't-know drops never-demonstrated credit", () => {
  test("first tap on placement credit writes the frontier-seed shape", async () => {
    const { t, scholarId, asScholar, masteryId, itemId } = await setup();
    const res = await asScholar.mutation(api.practiceSkills.submitAnswer, {
      scholarId,
      itemId,
      answer: "",
      dontKnow: true,
    });
    expect(res.repetition).toBe(0);
    const row = await t.run(async (ctx) => ctx.db.get(masteryId));
    expect(row).toMatchObject({ repetition: 0, halfLifeDays: 0, source: "placement" });
    expect(row?.lastPracticedAt).toBeUndefined();
    expect(row?.lastAttemptAt).toBeDefined();
    // No longer access-proven, so it cannot read as review or "placed"; its
    // prereqs are unstarted in this fixture, so it is not frontier yet either.
    expect(row?.becameFluentAt).toBeUndefined();
    // The attempt log keeps the pre-drop provenance.
    const attempts = await t.run(async (ctx) =>
      ctx.db
        .query("practiceAttempts")
        .withIndex("by_scholar_node_createdAt", (q) =>
          q.eq("scholarId", scholarId).eq("nodeKey", SKILL),
        )
        .collect(),
    );
    expect(attempts).toHaveLength(1);
    expect(attempts[0]).toMatchObject({
      explanationReason: "dont_know",
      repetitionBefore: 3,
      source: "placement",
    });
    // The launchpad gate now treats the node as new ground again.
    expect(skillAttempted(row ?? undefined)).toBe(false);
  });

  test("with its prerequisites credited, the dropped node returns as frontier work", async () => {
    const { t, scholarId, asScholar, masteryId, itemId } = await setup();
    await t.run(async (ctx) => {
      const prereqs = (await ctx.db.query("knowledgeNodeEdges").collect()).filter(
        (e) => e.toKey === SKILL && e.kind === "buildsOn",
      );
      expect(prereqs.length).toBeGreaterThan(0);
      for (const e of prereqs) {
        await ctx.db.insert("practiceMastery", {
          scholarId,
          skillKey: e.fromKey,
          domain: DOMAIN,
          repetition: 3,
          halfLifeDays: 4,
          lastPracticedAt: Date.now(),
          frontier: false,
          source: "placement",
          updatedAt: Date.now(),
        });
      }
    });
    await asScholar.mutation(api.practiceSkills.submitAnswer, {
      scholarId,
      itemId,
      answer: "",
      dontKnow: true,
    });
    const row = await t.run(async (ctx) => ctx.db.get(masteryId));
    expect(row).toMatchObject({ repetition: 0, frontier: true });
  });

  test("a dependent in another domain loses its stale frontier flag", async () => {
    const GATE = "division_as_sharing";
    const { t, scholarId, asScholar, itemId } = await setup({}, GATE);
    const dependentId = await t.run(async (ctx) => {
      const edge = (
        await ctx.db
          .query("knowledgeNodeEdges")
          .withIndex("by_from", (q) => q.eq("fromKey", GATE))
          .collect()
      ).find((e) => e.kind === "buildsOn" && e.domain !== DOMAIN);
      expect(edge).toBeDefined();
      return await ctx.db.insert("practiceMastery", {
        scholarId,
        skillKey: edge!.toKey,
        domain: edge!.domain,
        repetition: 0,
        halfLifeDays: 0,
        frontier: true,
        source: "placement",
        updatedAt: Date.now(),
      });
    });
    await asScholar.mutation(api.practiceSkills.submitAnswer, {
      scholarId,
      itemId,
      answer: "",
      dontKnow: true,
    });
    const dependent = await t.run(async (ctx) => ctx.db.get(dependentId));
    expect(dependent?.frontier).toBe(false);
  });

  test("a second tap writes an ordinary miss (nothing left to drop)", async () => {
    const { t, scholarId, asScholar, masteryId, itemId } = await setup();
    for (let i = 0; i < 2; i++) {
      await asScholar.mutation(api.practiceSkills.submitAnswer, {
        scholarId,
        itemId,
        answer: "",
        dontKnow: true,
      });
    }
    const row = await t.run(async (ctx) => ctx.db.get(masteryId));
    expect(row?.repetition).toBe(0);
    expect(row?.lastPracticedAt).toBeDefined();
    expect(row?.missStreak).toBe(2);
  });

  test("any unassisted correct answer on record keeps the credit", async () => {
    const { t, scholarId, asScholar, masteryId, itemId } = await setup();
    await priorAttempt(t, scholarId, { lane: "placement", source: "placement" });
    await asScholar.mutation(api.practiceSkills.submitAnswer, {
      scholarId,
      itemId,
      answer: "",
      dontKnow: true,
    });
    const row = await t.run(async (ctx) => ctx.db.get(masteryId));
    expect(row?.repetition).toBe(3);
  });

  test("a retry or scaffolded correct answer does not count as demonstrated", async () => {
    const { t, scholarId, asScholar, masteryId, itemId } = await setup();
    await priorAttempt(t, scholarId, { retry: true });
    await priorAttempt(t, scholarId, { scaffolded: true });
    await asScholar.mutation(api.practiceSkills.submitAnswer, {
      scholarId,
      itemId,
      answer: "",
      dontKnow: true,
    });
    const row = await t.run(async (ctx) => ctx.db.get(masteryId));
    expect(row?.repetition).toBe(0);
  });

  test("demonstrated (practice) credit is never dropped", async () => {
    const { t, scholarId, asScholar, masteryId, itemId } = await setup({ source: "practice" });
    await asScholar.mutation(api.practiceSkills.submitAnswer, {
      scholarId,
      itemId,
      answer: "",
      dontKnow: true,
    });
    const row = await t.run(async (ctx) => ctx.db.get(masteryId));
    expect(row?.repetition).toBe(3);
  });

  test("credit earned with help (scaffolded) is hers to keep", async () => {
    const { t, scholarId, asScholar, masteryId, itemId } = await setup({ source: "scaffolded" });
    await asScholar.mutation(api.practiceSkills.submitAnswer, {
      scholarId,
      itemId,
      answer: "",
      dontKnow: true,
    });
    const row = await t.run(async (ctx) => ctx.db.get(masteryId));
    expect(row?.repetition).toBe(3);
  });

  test("reprobe-labelled credit that once advanced the frontier is kept", async () => {
    const { t, scholarId, asScholar, masteryId, itemId } = await setup({
      source: "reprobe",
      frontierAdvancedAt: Date.now() - 20 * 86_400_000,
    });
    await priorAttempt(t, scholarId, { scaffolded: true });
    await asScholar.mutation(api.practiceSkills.submitAnswer, {
      scholarId,
      itemId,
      answer: "",
      dontKnow: true,
    });
    const row = await t.run(async (ctx) => ctx.db.get(masteryId));
    expect(row?.repetition).toBe(3);
  });

  test("a wrong typed answer keeps the credit (only the don't-know drops it)", async () => {
    const { t, scholarId, asScholar, masteryId, itemId } = await setup();
    await asScholar.mutation(api.practiceSkills.submitAnswer, {
      scholarId,
      itemId,
      answer: "99",
    });
    const row = await t.run(async (ctx) => ctx.db.get(masteryId));
    expect(row?.repetition).toBe(3);
  });
});

describe("skillAttempted", () => {
  test("only a just-dropped row is new ground again; other attempted rows are not", () => {
    expect(skillAttempted(undefined)).toBe(false);
    expect(skillAttempted({ source: "placement", repetition: 3 })).toBe(false);
    expect(skillAttempted({ source: "placement", repetition: 3, lastAttemptAt: 1 })).toBe(true);
    expect(skillAttempted({ source: "placement", repetition: 0, lastAttemptAt: 1 })).toBe(false);
    // An ordinary miss on a frontier seed starts the SR clock: still attempted.
    expect(
      skillAttempted({ source: "placement", repetition: 0, lastAttemptAt: 1, lastPracticedAt: 1 }),
    ).toBe(true);
    expect(skillAttempted({ source: "practice", repetition: 0, lastAttemptAt: 1 })).toBe(true);
  });
});
