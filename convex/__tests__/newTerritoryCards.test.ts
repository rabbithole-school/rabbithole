import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "../schema";
import { api, internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import { FLUENT_REPS } from "../lib/practice/scheduler";
import { DOMAIN_REACHABILITY_STATIC } from "../knowledgeNodes";
import { domainHasAffectSafeEntry } from "../lib/practice/placement";

// "New territory" tiles (raise-the-ceiling consolidation, f7): the fold-in of
// the old standalone "Explore a new territory" pills into the "Today's Math
// Playlists" tile row. `newTerritoryCards` is additive — it must never change
// `choiceSetForSelf`'s own behavior/tests — and reuses the SAME
// `computeDomainQueue` frontier logic (no forked composition), so a domain
// with zero mastery still returns a real, servable card (its graph roots).

const modules = (
  import.meta as ImportMeta & {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("../**/*.ts");

async function seedScholar(t: ReturnType<typeof convexTest>, username = "new_territory_scholar") {
  return await t.run(async (ctx) => {
    const institution =
      (await ctx.db
        .query("institutions")
        .filter((q) => q.eq(q.field("slug"), "new-territory"))
        .unique()) ??
      {
        _id: await ctx.db.insert("institutions", {
          name: "New Territory",
          slug: "new-territory",
          kind: "school",
          isPrimary: true,
        }),
      };
    const userId = await ctx.db.insert("users", {
      name: "New Territory Scholar",
      username,
      role: "scholar",
      institutionId: institution._id,
    });
    await ctx.db.insert("memberships", {
      userId,
      role: "scholar",
      institutionId: institution._id,
    });
    return userId;
  });
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

async function seedFluent(
  t: ReturnType<typeof convexTest>,
  scholarId: Id<"users">,
  skillKey: string,
  domain: string,
  strand: string,
) {
  await t.run(async (ctx) =>
    ctx.db.insert("practiceMastery", {
      scholarId,
      skillKey,
      domain,
      strand,
      repetition: FLUENT_REPS,
      halfLifeDays: 100,
      lastPracticedAt: Date.now(),
      frontier: false,
      source: "practice",
      updatedAt: Date.now(),
    }),
  );
}

describe("practiceSkills — newTerritoryCards (the folded-in 'Explore a new territory' tiles)", () => {
  test("a scholar who has only started whole-number-arithmetic gets one card per OTHER registered domain, all not-started", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.practiceSkills.seedGraph, {});
    const scholar = await seedScholar(t);
    const asScholar = await asUser(t, scholar);

    // Start exactly one domain — every other registered domain is "new territory".
    await seedFluent(t, scholar, "count_to_10", "whole-number-arithmetic", "counting");

    const cards = await asScholar.query(api.practiceSkills.newTerritoryCards, {});
    expect(cards.length).toBeGreaterThan(0);
    expect(cards.every((c) => c.domain !== "whole-number-arithmetic")).toBe(true);

    // Every returned card is a REAL, servable frontier pick (graph roots for a
    // never-touched domain) — cross-checked against nextForScholar, exactly
    // like choiceSetForSelf's own existing test does.
    for (const card of cards) {
      const frontier = await asScholar.query(api.practiceSkills.nextForScholar, {
        scholarId: scholar,
        domain: card.domain,
        limit: 12,
      });
      const frontierPairs = new Set(
        frontier
          .filter((entry) => entry.reason === "new")
          .map((entry) => `${entry.strand}\u0000${entry.key}`),
      );
      expect(frontierPairs.has(`${card.strand}\u0000${card.sampleSkillKey}`)).toBe(true);
    }
  });

  test("excludeDomains removes a domain from the result even if it's not started", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.practiceSkills.seedGraph, {});
    const scholar = await seedScholar(t);
    const asScholar = await asUser(t, scholar);

    const withoutExclusion = await asScholar.query(api.practiceSkills.newTerritoryCards, {});
    expect(withoutExclusion.some((c) => c.domain === "probability")).toBe(true);

    const withExclusion = await asScholar.query(api.practiceSkills.newTerritoryCards, {
      excludeDomains: ["probability"],
    });
    expect(withExclusion.some((c) => c.domain === "probability")).toBe(false);
    expect(withExclusion.length).toBe(withoutExclusion.length - 1);
  });

  test("a domain the scholar has already started never appears, even unexcluded", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.practiceSkills.seedGraph, {});
    const scholar = await seedScholar(t);
    const asScholar = await asUser(t, scholar);

    await seedFluent(t, scholar, "count_to_10", "whole-number-arithmetic", "counting");
    await seedFluent(t, scholar, "likelihood_scale", "probability", "chance");

    const cards = await asScholar.query(api.practiceSkills.newTerritoryCards, {});
    expect(cards.some((c) => c.domain === "whole-number-arithmetic")).toBe(false);
    expect(cards.some((c) => c.domain === "probability")).toBe(false);
  });

  test("choiceSetForSelf's own behavior is unaffected — still returns at most three balanced cards", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.practiceSkills.seedGraph, {});
    const scholar = await seedScholar(t, "unaffected_choiceset_scholar");
    const asScholar = await asUser(t, scholar);
    const domains = ["whole-number-arithmetic", "probability"];

    const cards = await asScholar.query(api.practiceSkills.choiceSetForSelf, { domains });
    expect(cards.length).toBeLessThanOrEqual(3);
  });

  test("rejects a non-scholar identity", async () => {
    const t = convexTest(schema, modules);
    const teacher = await t.run(async (ctx) =>
      ctx.db.insert("users", { name: "Teacher", username: "nt_teacher", role: "teacher" }),
    );
    const asTeacher = await asUser(t, teacher);
    await expect(
      asTeacher.query(api.practiceSkills.newTerritoryCards, {}),
    ).rejects.toThrow("A learner membership is required");
  });
});

// Raise-the-ceiling ceiling-lift (`scratch-critiques/territory-offer-trace.md`,
// `scratch-critiques/slip-confirm-interaction-review.md`): a `reachable`
// above-ring domain (grade-ineligible, but every cross-domain prereq has
// CONVERGED) is deliberately offered here, sourced from the SAME
// `mappingCandidatesForDomain` derivation the deliberate-pick serve path uses —
// never from `computeDomainQueue`, whose grade band is exactly what drops the
// card otherwise (see the trace's §1).
describe("practiceSkills — newTerritoryCards offers reachable above-ring domains", () => {
  const ALGEBRA1 = "algebra-1";
  const A1_PREREQS = [
    "whole-number-arithmetic",
    "fraction-arithmetic",
    "geometry-measurement",
    "ratio-proportion-percent",
    "integers-coordinates",
    "early-algebra",
  ];

  async function convergeDomains(
    t: ReturnType<typeof convexTest>,
    scholarId: Id<"users">,
    domains: string[],
  ) {
    await t.run(async (ctx) => {
      const nodes = await ctx.db.query("knowledgeNodes").collect();
      for (const domain of domains) {
        const own = nodes.filter((n) => n.domain === domain);
        for (const node of own) {
          await ctx.db.insert("practiceMastery", {
            scholarId,
            skillKey: node.nodeKey,
            domain,
            strand: node.strand,
            repetition: 3,
            halfLifeDays: 30,
            lastPracticedAt: Date.now(),
            frontier: false,
            source: "placement",
            updatedAt: Date.now(),
          });
        }
        await ctx.db.insert("practicePlacements", {
          scholarId,
          domain,
          status: "complete",
          probesAnswered: 1,
          probeLog: [
            {
              nodeKey: own[0].nodeKey,
              strand: own[0].strand ?? "",
              outcome: "correct",
              at: Date.now(),
            },
          ],
          updatedAt: Date.now(),
        });
      }
    });
  }

  test("Henry-shaped (grade 4, every Algebra 1 prereq domain converged) gets an algebra-1 card with a real mapping-probe sample", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.practiceSkills.seedGraph, {});
    const henry = await seedScholar(t, "henry_ceiling");
    await t.run(async (ctx) => ctx.db.patch(henry, { gradeLevel: "4" }));
    const asHenry = await asUser(t, henry);
    await convergeDomains(t, henry, A1_PREREQS);

    const cards = await asHenry.query(api.practiceSkills.newTerritoryCards, {});
    const a1Card = cards.find((c) => c.domain === ALGEBRA1);
    expect(a1Card).toBeTruthy();
    expect(a1Card?.strand).toBeTruthy();
    expect(a1Card?.sampleSkillKey).toBeTruthy();
    expect(a1Card?.sampleSkillLabel).toBeTruthy();

    // The map still classifies it `ineligible` — the offer never flips the
    // classification the automatic breadth-first check-in reads.
    const map = await asHenry.query(api.practiceSkills.domainMapForScholar, {
      scholarId: henry,
    });
    const a1Map = map.find((d) => d.domain === ALGEBRA1);
    expect(a1Map?.status).toBe("ineligible");
    expect(a1Map?.eligible).toBe(false);
  });

  test("Asha-shaped (grade K, nothing converged anywhere) gets NO algebra-1 card", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.practiceSkills.seedGraph, {});
    const asha = await seedScholar(t, "asha_ceiling");
    await t.run(async (ctx) => ctx.db.patch(asha, { gradeLevel: "K" }));
    const asAsha = await asUser(t, asha);

    const cards = await asAsha.query(api.practiceSkills.newTerritoryCards, {});
    expect(cards.some((c) => c.domain === ALGEBRA1)).toBe(false);
  });

  test("an ordinary eligible domain's card is unchanged by the reachable addition", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.practiceSkills.seedGraph, {});
    const scholar = await seedScholar(t, "ordinary_ceiling_scholar");
    const asScholar = await asUser(t, scholar);

    // whole-number-arithmetic has no cross-domain prereqs and is always in-ring
    // — its card must still come from the ordinary computeDomainQueue path.
    const cards = await asScholar.query(api.practiceSkills.newTerritoryCards, {});
    const wholeCard = cards.find((c) => c.domain === "whole-number-arithmetic");
    expect(wholeCard).toBeTruthy();

    const frontier = await asScholar.query(api.practiceSkills.nextForScholar, {
      scholarId: scholar,
      domain: "whole-number-arithmetic",
      limit: 12,
    });
    const frontierPairs = new Set(
      frontier
        .filter((entry) => entry.reason === "new")
        .map((entry) => `${entry.strand}\u0000${entry.key}`),
    );
    expect(
      frontierPairs.has(`${wholeCard?.strand}\u0000${wholeCard?.sampleSkillKey}`),
    ).toBe(true);
  });
});

// ── Static reachability meta must mirror the DB derivation ──────────────────
// The hot-path pre-check in reachableDomainCardsForScholar gates on
// DOMAIN_REACHABILITY_STATIC (module-scope, from the seed arrays) instead of
// loading every domain graph. A false NEGATIVE there would silently hide the
// offer, so pin the static map to the DB-derived truth: same domains, same
// cross-domain buildsOn prereq sets, same ring verdicts at every grade.
describe("DOMAIN_REACHABILITY_STATIC drift", () => {
  test("static prereqs + ring verdicts match the seeded DB graph", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.practiceSkills.seedGraph, {});
    // Scope to the REGISTERED practice domains — the node table also carries
    // Sky/concept domains the placement loader never touches.
    const registered = new Set(DOMAIN_REACHABILITY_STATIC.map((m) => m.domain));
    const db: Record<string, { prereqs: string[]; grades: { grade?: string }[] }> =
      await t.run(async (ctx) => {
        const nodes = (await ctx.db.query("knowledgeNodes").collect()).filter((n) =>
          registered.has(n.domain),
        );
        const edges = (await ctx.db.query("knowledgeNodeEdges").collect()).filter(
          (e) => e.kind === "buildsOn",
        );
        const domainOfKey = new Map(nodes.map((n) => [n.nodeKey, n.domain]));
        const byDomain: Record<string, { prereqs: string[]; grades: { grade?: string }[] }> = {};
        for (const n of nodes) {
          byDomain[n.domain] ??= { prereqs: [], grades: [] };
          byDomain[n.domain].grades.push({ grade: n.grade });
        }
        for (const e of edges) {
          const toDomain = domainOfKey.get(e.toKey);
          const fromDomain = domainOfKey.get(e.fromKey);
          if (toDomain && fromDomain && fromDomain !== toDomain && !byDomain[toDomain].prereqs.includes(fromDomain))
            byDomain[toDomain].prereqs.push(fromDomain);
        }
        return byDomain;
      });
    expect(new Set(Object.keys(db))).toEqual(registered);
    for (const m of DOMAIN_REACHABILITY_STATIC) {
      const d = db[m.domain]!;
      expect(new Set(m.prereqDomains), `${m.domain} prereqs`).toEqual(new Set(d.prereqs));
      // The ring check consumes only the grade multiset — compare the verdict at
      // every grade a scholar can hold rather than node identity.
      for (const g of ["K", "1", "2", "3", "4", "5", "6", "7", "8", "9"]) {
        expect(
          domainHasAffectSafeEntry(m.nodeGrades, g),
          `${m.domain} ring verdict at grade ${g}`,
        ).toBe(domainHasAffectSafeEntry(d.grades, g));
      }
    }
  });
});
