import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "../schema";
import { api, internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import { ELECTIVE_PRACTICE_DOMAINS } from "../knowledgeNodes";
import {
  grantInstitutionMembership,
  seedScholarInInstitution,
  seedTestInstitution,
} from "./institutionTestHelpers";
import { DISCRETE_MATH_DOMAIN } from "../seed/discreteMathGraph";

// ── ELECTIVE domains (raise-the-ceiling follow-up) ──────────────────────────
// An elective domain (discrete-math is the first carrier) must NEVER cost any
// scholar a forced pre-test: it stays out of the check-in denominator M and
// the automatic breadth-first serving REGARDLESS of its grade tags, and
// reaches scholars only through the reachable new-territory offer once its
// cross-domain prereq DAG (whole-number-arithmetic) has converged.

const modules = (
  import.meta as ImportMeta & {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("../**/*.ts");

const WNA = "whole-number-arithmetic";

async function seedScholar(t: ReturnType<typeof convexTest>, username: string, gradeLevel: string) {
  return await t.run(async (ctx) =>
    ctx.db.insert("users", { name: username, username, role: "scholar", gradeLevel }),
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
          { nodeKey: own[0].nodeKey, strand: own[0].strand ?? "", outcome: "correct", at: Date.now() },
        ],
        updatedAt: Date.now(),
      });
    }
  });
}

describe("elective domains — never a forced pre-test", () => {
  test("the TEACHER cohort read agrees: an unopened elective is ineligible, never owed work", async () => {
    // The cohort path re-derives gradeEligible separately from the scholar
    // path; a missing elective fold there showed every scholar owing
    // discrete-math on the Math Skills matrix (Sol review 2026-08-19,
    // finding 1). Pin the two derivations to the same answer.
    const t = convexTest(schema, modules);
    await t.mutation(internal.practiceSkills.seedGraph, {});
    const institutionId = await seedTestInstitution(t, { slug: "moli-elective" });
    const scholar = await seedScholarInInstitution(t, {
      institutionId,
      name: "Elective Cohort Scholar",
      username: "elective_cohort",
    });
    await t.run(async (ctx) => ctx.db.patch(scholar, { gradeLevel: "9" }));
    const teacher = await t.run(async (ctx) =>
      ctx.db.insert("users", { name: "T", username: "elective_cohort_t", role: "teacher" }),
    );
    await grantInstitutionMembership(t, teacher, institutionId);
    const asTeacher = await asUser(t, teacher);
    const res = (await asTeacher.query(api.cohortPractice.mapStatusForScholars, {
      scholarIds: [scholar],
    })) as { scholars: { scholarId: Id<"users">; eligibleCount: number; perDomain: { domain: string; status: string }[] }[] };
    const row = res.scholars[0];
    const dm = row.perDomain.find((d) => d.domain === DISCRETE_MATH_DOMAIN);
    expect(dm).toBeDefined();
    expect(dm!.status).toBe("ineligible");
    // …and it never inflates the teacher-facing denominator (grade 9 would
    // make all 8 core domains eligible; the elective must not be a 9th).
    expect(row.eligibleCount).toBe(8);
  });

  test("discrete-math is registered elective", () => {
    expect(ELECTIVE_PRACTICE_DOMAINS.has(DISCRETE_MATH_DOMAIN)).toBe(true);
  });

  test("stays OUT of the check-in denominator even for a grade-9 scholar whose ring covers its every node", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.practiceSkills.seedGraph, {});
    const scholar = await seedScholar(t, "elective_ring", "9");
    const as = await asUser(t, scholar);
    const map = await as.query(api.practiceSkills.domainMapForScholar, { scholarId: scholar });
    const dm = map.find((d: { domain: string }) => d.domain === DISCRETE_MATH_DOMAIN);
    expect(dm).toBeDefined();
    expect(dm!.eligible).toBe(false);
    expect(dm!.status).toBe("ineligible");
    // The denominator counts only the 8 core domains.
    expect(map.filter((d: { eligible: boolean }) => d.eligible)).toHaveLength(8);
  });

  test("map COMPLETION ignores an unopened elective: converging the 8 core domains completes the map", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.practiceSkills.seedGraph, {});
    const scholar = await seedScholar(t, "elective_complete", "9");
    const core = [
      WNA, "fraction-arithmetic", "probability", "geometry-measurement",
      "ratio-proportion-percent", "integers-coordinates", "early-algebra", "algebra-1",
    ];
    await convergeDomains(t, scholar, core);
    const as = await asUser(t, scholar);
    const completion = await as.query(api.practiceSkills.mapCompletionForScholar, {});
    expect(completion.state).toBe("complete");
  });

  test("the automatic mixed check-in NEVER serves an unopened elective", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.practiceSkills.seedGraph, {});
    // Grade 9: every domain incl. discrete-math is inside the scholar's ring —
    // only electivity keeps it out of the automatic band.
    const scholar = await seedScholar(t, "elective_band", "9");
    // Converge WNA so discrete-math is even REACHABLE (prereqs met) — the
    // strongest temptation for the automatic path.
    await convergeDomains(t, scholar, [WNA]);
    const as = await asUser(t, scholar);
    const served = (await as.query(api.practiceSkills.practiceSession, {
      scholarId: scholar,
      seed: 7,
      includeMapping: true,
    })) as unknown as { items: { lane?: string; domain?: string }[] };
    for (const it of served.items) {
      expect(it.domain, `served ${JSON.stringify(it)}`).not.toBe(DISCRETE_MATH_DOMAIN);
    }
  });

  test("offered as a reachable territory card ONLY once WNA converges", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.practiceSkills.seedGraph, {});
    const scholar = await seedScholar(t, "elective_offer", "5");
    const as = await asUser(t, scholar);

    // Before: WNA unconverged → not reachable → no card.
    const before = await as.query(api.practiceSkills.newTerritoryCards, {});
    expect(before.map((c: { domain: string }) => c.domain)).not.toContain(DISCRETE_MATH_DOMAIN);

    await convergeDomains(t, scholar, [WNA]);
    const after = await as.query(api.practiceSkills.newTerritoryCards, {});
    const card = after.find((c: { domain: string }) => c.domain === DISCRETE_MATH_DOMAIN);
    expect(card, "discrete-math card should be offered once WNA converged").toBeDefined();
    // The card's sample is a real discrete-math node the deliberate-pick serve
    // path would open (strand + skillKey populated from the mapping derivation).
    expect(card!.strand.length).toBeGreaterThan(0);
    expect(card!.sampleSkillKey.length).toBeGreaterThan(0);

    // …and the elective never takes the ordinary (grade-band) door: the card is
    // the reachable path's, gated on the DAG, not a band alumnus. Pin this by
    // asserting an in-ring scholar with NO convergence anywhere (the `before`
    // read above) saw nothing.
  });

  test("deliberately opening the elective joins M (in_flight precedence) — the accepted consequence", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.practiceSkills.seedGraph, {});
    const scholar = await seedScholar(t, "elective_open", "5");
    await convergeDomains(t, scholar, [WNA]);
    const as = await asUser(t, scholar);

    const served = (await as.query(api.practiceSkills.practiceSession, {
      scholarId: scholar,
      seed: 3,
      domain: DISCRETE_MATH_DOMAIN,
      includeMapping: true,
      choiceHint: { domain: DISCRETE_MATH_DOMAIN, strand: "counting" },
    })) as unknown as { items: { itemId: string; lane?: string; domain?: string; skillKey: string }[] };
    const mapping = served.items.filter(
      (it) => it.lane === "mapping" && it.domain === DISCRETE_MATH_DOMAIN,
    );
    expect(mapping.length, "deliberate pick must serve discrete-math probes").toBeGreaterThan(0);

    await as.mutation(api.practiceSkills.submitMappingAnswer, {
      scholarId: scholar,
      domain: DISCRETE_MATH_DOMAIN,
      itemId: mapping[0].itemId,
      seed: 3,
      answer: "0",
    });
    const map = await as.query(api.practiceSkills.domainMapForScholar, { scholarId: scholar });
    const dm = map.find((d: { domain: string }) => d.domain === DISCRETE_MATH_DOMAIN)!;
    expect(dm.status).toBe("in_flight");
    expect(dm.eligible).toBe(true);
  });
});
