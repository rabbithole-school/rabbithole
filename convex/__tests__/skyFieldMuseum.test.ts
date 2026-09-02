import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "../schema";
import { api, internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import { FLUENT_REPS } from "../lib/practice/scheduler";
import { WHOLE_NUMBER_ARITHMETIC_DOMAIN } from "../seed/wholeNumberArithmeticGraph";
import { SKY_COLD_START_MIN_STARS } from "../../shared/skyTiers";

// Why this file: the Sky night-museum layers (convex/lib/skyMuseum.ts) blend
// into TWO surfaces — the flat `seeds.skyForSelf` list (covered by
// skyMuseum.test.ts) AND the LIVE embedding-placed Atlas field
// (`concepts.skyFieldForScholar`, which feeds web ConceptAtlasView's scholar
// lens + native sky.tsx). These tests pin the Atlas-field integration
// specifically: a fluent skill floats as a `source: "mastery"` node in `lit`
// with hopTier 0 and a rest-visible display tier (0, same as a seed — see
// shared/skyTiers.ts classifySkyNode — but dimmer/smaller so it never
// out-brightens a real invitation); same-domain mastery stars are connected
// into a constellation via `threads`; the cold-start `starter` role blends in
// only while the scholar's real sky is nearly empty; and nothing but a
// label/blurb/strand ever reaches the wire (no repetition, no raw
// practiceMastery `source`).

const modules = (
  import.meta as ImportMeta & {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("../**/*.ts");

async function seedScholar(t: ReturnType<typeof convexTest>, username = "atlas-museum-scholar") {
  return await t.run(async (ctx) =>
    ctx.db.insert("users", { name: "Atlas Museum Scholar", username, role: "scholar" }),
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

describe("concepts.skyFieldForScholar — night-museum layers", () => {
  test("a demonstrated-fluent practice skill floats as a lit mastery star", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.practiceSkills.seedGraph, {});
    const scholar = await seedScholar(t);
    // Enough real seeds that the cold-start layer doesn't also fire, so this
    // test isolates the mastery layer only.
    for (let i = 0; i < SKY_COLD_START_MIN_STARS; i++) {
      await observerSeed(t, scholar, `Topic ${i}`);
    }
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
    const sky = await asScholar.query(api.concepts.skyFieldForScholar, { scholarId: scholar });

    const masteryId = "mastery:count_to_10";
    expect(sky.lit[masteryId]).toBeDefined();
    const node = sky.nodes.find((n) => n.id === masteryId);
    expect(node).toBeDefined();
    expect(node?.source).toBe("mastery");
    expect(node?.hopTier).toBe(0);
    expect(node?.label).toBe("Count to 10 by ones");

    const meta = sky.seedMeta[masteryId];
    expect(meta?.kind).toBe("mastery");
    expect(meta?.seedId).toBeUndefined();
    expect(meta?.blurb).toBe("Practice keeps it bright.");
    expect(meta?.strand).toBe("counting");

    // Display-only: never a repetition count or the row's raw `source`.
    expect(JSON.stringify(node)).not.toMatch(/repetition/);
    expect(JSON.stringify(meta)).not.toMatch(/repetition/);
  });

  test("an inferred (placement) credit does not light — only real practice does", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.practiceSkills.seedGraph, {});
    const scholar = await seedScholar(t);
    for (let i = 0; i < SKY_COLD_START_MIN_STARS; i++) {
      await observerSeed(t, scholar, `Topic ${i}`);
    }
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
    const sky = await asScholar.query(api.concepts.skyFieldForScholar, { scholarId: scholar });
    expect(sky.lit["mastery:count_to_10"]).toBeUndefined();
    expect(sky.nodes.some((n) => n.id === "mastery:count_to_10")).toBe(false);
  });

  test("two fluent skills in the same domain are connected by a constellation edge in `threads`", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.practiceSkills.seedGraph, {});
    const scholar = await seedScholar(t);
    for (let i = 0; i < SKY_COLD_START_MIN_STARS; i++) {
      await observerSeed(t, scholar, `Topic ${i}`);
    }
    await t.run((ctx) =>
      ctx.db.insert("practiceMastery", {
        scholarId: scholar,
        skillKey: "count_to_10",
        domain: WHOLE_NUMBER_ARITHMETIC_DOMAIN,
        repetition: FLUENT_REPS,
        halfLifeDays: 4,
        frontier: false,
        source: "practice",
        becameFluentAt: Date.now() - 1000,
        updatedAt: Date.now() - 1000,
      }),
    );
    await t.run((ctx) =>
      ctx.db.insert("practiceMastery", {
        scholarId: scholar,
        skillKey: "count_to_20",
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
    const sky = await asScholar.query(api.concepts.skyFieldForScholar, { scholarId: scholar });

    const a = "mastery:count_to_10";
    const b = "mastery:count_to_20";
    expect(sky.lit[a]).toBeDefined();
    expect(sky.lit[b]).toBeDefined();
    // A real constellation, not two isolated dots: a faint connective edge
    // between the two same-domain mastery stars rides the SAME `threads`
    // field the atlas already draws every other connective line through (see
    // convex/lib/skyMuseum.ts constellationEdges + concepts.ts).
    const hasEdge = sky.threads.some(
      ([s, tgt]) => (s === a && tgt === b) || (s === b && tgt === a),
    );
    expect(hasEdge).toBe(true);
  });

  test("cold-start: a brand-new scholar's field carries starter stars, no CTA", async () => {
    const t = convexTest(schema, modules);
    const scholar = await seedScholar(t);
    const asScholar = await asUser(t, scholar);
    const sky = await asScholar.query(api.concepts.skyFieldForScholar, { scholarId: scholar });

    expect(sky.seeds).toHaveLength(0);
    expect(sky.starter.length).toBeGreaterThan(0);
    for (const id of sky.starter) {
      const node = sky.nodes.find((n) => n.id === id);
      expect(node?.source).toBe("starter");
      expect(node?.hopTier).toBe(0);
      const meta = sky.seedMeta[id];
      expect(meta?.kind).toBe("starter");
      expect(meta?.seedId).toBeUndefined();
      expect(typeof meta?.blurb).toBe("string");
    }
  });

  test("the starter layer disappears once the scholar has real invitations", async () => {
    const t = convexTest(schema, modules);
    const scholar = await seedScholar(t);
    for (let i = 0; i < SKY_COLD_START_MIN_STARS; i++) {
      await observerSeed(t, scholar, `Topic ${i}`);
    }

    const asScholar = await asUser(t, scholar);
    const sky = await asScholar.query(api.concepts.skyFieldForScholar, { scholarId: scholar });
    expect(sky.starter).toHaveLength(0);
  });
});
