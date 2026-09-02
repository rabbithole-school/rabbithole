import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "../schema";
import { api, internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import { FLUENT_REPS } from "../lib/practice/scheduler";
import { WHOLE_NUMBER_ARITHMETIC_DOMAIN } from "../seed/wholeNumberArithmeticGraph";
import { MATH_CROSS_DOMAIN_SEEDS } from "../lib/practice/crossDomainSeeds";
import { SKY_COLD_START_MIN_STARS } from "../../shared/skyTiers";

// Why this file: the Sky's two "night-museum" layers (see
// convex/lib/skyMuseum.ts) blend into `seeds.skyForSelf` — a scholar's own
// demonstrated-fluent practice skills as a lit constellation, and (only while
// the real sky is still nearly empty) a warm cold-start layer. These tests pin
// the fluency gate (repetition >= FLUENT_REPS AND source "practice" — an
// inferred credit like placement never counts), the cap/cold-start toggle, and
// that no number/score ever leaks onto a star.

const modules = (
  import.meta as ImportMeta & {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("../**/*.ts");

async function seedScholar(t: ReturnType<typeof convexTest>, username = "museum-scholar") {
  return await t.run(async (ctx) =>
    ctx.db.insert("users", { name: "Museum Scholar", username, role: "scholar" }),
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

async function observerSeed(t: ReturnType<typeof convexTest>, scholarId: Id<"users">, topic: string) {
  return await t.run(async (ctx) =>
    ctx.db.insert("seeds", {
      scholarId,
      origin: "ai",
      status: "pending",
      topic,
      domain: "Physics",
      suggestionType: "frontier",
      rationale: "why",
      scholarInvitation: "hook",
    }),
  );
}

describe("skyForSelf — lit constellation (mastery layer)", () => {
  test("a demonstrated-fluent practice skill lights as a mastery star", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.practiceSkills.seedGraph, {});
    const scholar = await seedScholar(t);
    await t.run((ctx) =>
      ctx.db.insert("practiceMastery", {
        scholarId: scholar,
        skillKey: "count_to_10",
        domain: WHOLE_NUMBER_ARITHMETIC_DOMAIN,
        repetition: FLUENT_REPS,
        halfLifeDays: 4,
        frontier: false,
        source: "practice",
        becameFluentAt: Date.now(),
        updatedAt: Date.now(),
      }),
    );

    const asScholar = await asUser(t, scholar);
    const sky = await asScholar.query(api.seeds.skyForSelf, {});
    expect(sky.mastery).toHaveLength(1);
    const star = sky.mastery[0];
    expect(star.kind).toBe("mastery");
    expect(star.topic).toBe("Count to 10 by ones");
    expect(star.strand).toBe("counting");
    expect(star.domain).toBe("Mathematics");
    // Display-only: never a repetition count, mastery score, or the row's
    // internal `source` reaching the wire.
    expect(star).not.toHaveProperty("repetition");
    expect(star).not.toHaveProperty("source");
  });

  test("an inferred (placement) credit at FLUENT_REPS does NOT light — only real practice does", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.practiceSkills.seedGraph, {});
    const scholar = await seedScholar(t);
    await t.run((ctx) =>
      ctx.db.insert("practiceMastery", {
        scholarId: scholar,
        skillKey: "count_to_10",
        domain: WHOLE_NUMBER_ARITHMETIC_DOMAIN,
        repetition: FLUENT_REPS,
        halfLifeDays: 4,
        frontier: false,
        source: "placement",
        updatedAt: Date.now(),
      }),
    );

    const asScholar = await asUser(t, scholar);
    const sky = await asScholar.query(api.seeds.skyForSelf, {});
    expect(sky.mastery).toHaveLength(0);
  });

  test("most-recently-earned fluent skills come first", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.practiceSkills.seedGraph, {});
    const scholar = await seedScholar(t);
    const now = Date.now();
    await t.run((ctx) =>
      ctx.db.insert("practiceMastery", {
        scholarId: scholar,
        skillKey: "count_to_10",
        domain: WHOLE_NUMBER_ARITHMETIC_DOMAIN,
        repetition: FLUENT_REPS,
        halfLifeDays: 4,
        frontier: false,
        source: "practice",
        becameFluentAt: now - 10_000,
        updatedAt: now - 10_000,
      }),
    );
    await t.run((ctx) =>
      ctx.db.insert("practiceMastery", {
        scholarId: scholar,
        skillKey: "skip_count_2s_5s_10s",
        domain: WHOLE_NUMBER_ARITHMETIC_DOMAIN,
        repetition: FLUENT_REPS,
        halfLifeDays: 4,
        frontier: false,
        source: "practice",
        becameFluentAt: now,
        updatedAt: now,
      }),
    );

    const asScholar = await asUser(t, scholar);
    const sky = await asScholar.query(api.seeds.skyForSelf, {});
    expect(sky.mastery.map((s) => s.topic)).toEqual([
      "Skip-count by 2s, 5s, and 10s",
      "Count to 10 by ones",
    ]);
  });
});

describe("skyForSelf — warm cold-start layer", () => {
  test("a brand-new scholar (no seeds) gets a curated cross-domain sampler", async () => {
    const t = convexTest(schema, modules);
    const scholar = await seedScholar(t);
    const asScholar = await asUser(t, scholar);
    const sky = await asScholar.query(api.seeds.skyForSelf, {});
    expect(sky.seeds).toHaveLength(0);
    const registryStars = sky.starter.filter((s) => s.kind === "starter-registry");
    expect(registryStars.length).toBeGreaterThan(0);
    // Every registry star's blurb is a REAL entry from the curated registry —
    // never fabricated.
    const knownInvitations = new Set(MATH_CROSS_DOMAIN_SEEDS.map((s) => s.scholarInvitation));
    for (const star of registryStars) {
      expect("blurb" in star && knownInvitations.has(star.blurb)).toBe(true);
    }
  });

  test("a scholar's frontier skill surfaces as a starter 'next step' star", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.practiceSkills.seedGraph, {});
    const scholar = await seedScholar(t);
    await t.run((ctx) =>
      ctx.db.insert("practiceMastery", {
        scholarId: scholar,
        skillKey: "count_to_10",
        domain: WHOLE_NUMBER_ARITHMETIC_DOMAIN,
        repetition: 0,
        halfLifeDays: 1,
        frontier: true,
        source: "practice",
        updatedAt: Date.now(),
      }),
    );

    const asScholar = await asUser(t, scholar);
    const sky = await asScholar.query(api.seeds.skyForSelf, {});
    const frontierStars = sky.starter.filter((s) => s.kind === "starter-frontier");
    expect(frontierStars).toHaveLength(1);
    expect(frontierStars[0].topic).toBe("Count to 10 by ones");
  });

  test("the starter layer disappears once the scholar has real invitations", async () => {
    const t = convexTest(schema, modules);
    const scholar = await seedScholar(t);
    for (let i = 0; i < SKY_COLD_START_MIN_STARS; i++) {
      await observerSeed(t, scholar, `Topic ${i}`);
    }

    const asScholar = await asUser(t, scholar);
    const sky = await asScholar.query(api.seeds.skyForSelf, {});
    expect(sky.seeds.length).toBeGreaterThanOrEqual(SKY_COLD_START_MIN_STARS);
    expect(sky.starter).toHaveLength(0);
  });

  test("real seeds still carry kind 'seed'", async () => {
    const t = convexTest(schema, modules);
    const scholar = await seedScholar(t);
    await observerSeed(t, scholar, "A real invitation");

    const asScholar = await asUser(t, scholar);
    const sky = await asScholar.query(api.seeds.skyForSelf, {});
    expect(sky.seeds[0].kind).toBe("seed");
  });
});
