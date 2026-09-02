// LANE B — cohortPractice.mapStatusForScholars (§6/§8,
// review/math-skills-matrix-visual-language.html): the teacher cohort read
// behind the Skills matrix's empty-cell states. Classifies every seeded
// domain per scholar via the shared `summarizeDomainMap` derivation
// (lib/practice/domainMapStatus.ts) and names a queued domain's blocker(s).
import { convexTest } from "convex-test";
import type { TestConvex } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "../schema";
import {
  grantInstitutionMembership,
  seedScholarInInstitution,
  seedTestInstitution,
} from "./institutionTestHelpers";
import { api } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { WHOLE_NUMBER_ARITHMETIC_DOMAIN } from "../seed/wholeNumberArithmeticGraph";
import { FRACTION_ARITHMETIC_DOMAIN } from "../seed/fractionArithmeticGraph";
import { PROBABILITY_DOMAIN } from "../seed/probabilityGraph";
import { GEOMETRY_MEASUREMENT_DOMAIN } from "../seed/geometryMeasurementGraph";
import { RATIO_PROPORTION_PERCENT_DOMAIN } from "../seed/ratioProportionPercentGraph";
import { ALGEBRA_1_DOMAIN } from "../seed/algebra1Graph";

const modules = (
  import.meta as ImportMeta & {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("../**/*.ts");

type TC = TestConvex<typeof schema>;

async function withUser(t: TC, userId: Id<"users">) {
  const sessionId = await t.run(async (ctx) =>
    ctx.db.insert("authSessions", { userId, expirationTime: Date.now() + 3_600_000 }),
  );
  return t.withIdentity({ subject: `${userId}|${sessionId}`, issuer: "https://convex.dev" });
}

async function seedNode(
  t: TC,
  domain: string,
  nodeKey: string,
  overrides: { grade?: string } = {},
) {
  await t.run((ctx) =>
    ctx.db.insert("knowledgeNodes", {
      nodeKey,
      label: nodeKey,
      domain,
      grade: overrides.grade,
    }),
  );
}

async function seedBuildsOnEdge(
  t: TC,
  domain: string,
  fromKey: string,
  toKey: string,
) {
  await t.run((ctx) =>
    ctx.db.insert("knowledgeNodeEdges", {
      fromKey,
      toKey,
      domain,
      kind: "buildsOn",
    }),
  );
}

describe("cohortPractice.mapStatusForScholars", () => {
  test("classifies all six map statuses for one scholar", async () => {
    const t = convexTest(schema, modules);
    const institutionId = await seedTestInstitution(t, { slug: "moli-map-status" });
    const teacherId = await t.run((ctx) =>
      ctx.db.insert("users", { name: "Teacher", username: "teacher-map-status", role: "teacher" }),
    );
    await grantInstitutionMembership(t, teacherId, institutionId);
    const scholarId = await seedScholarInInstitution(t, {
      institutionId,
      name: "Scholar",
      username: "scholar-map-status",
    });
    // K-grade scholar — the ring (grade+2 = up to "2") excludes Algebra 1's
    // grade-9 node entirely, giving us a deterministic `ineligible` domain.
    await t.run((ctx) => ctx.db.patch(scholarId, { gradeLevel: "K" }));

    // ── converged: whole-number-arithmetic ──────────────────────────────
    await seedNode(t, WHOLE_NUMBER_ARITHMETIC_DOMAIN, "whole_1");
    await t.run((ctx) =>
      ctx.db.insert("practicePlacements", {
        scholarId,
        domain: WHOLE_NUMBER_ARITHMETIC_DOMAIN,
        status: "complete",
        probesAnswered: 5,
        updatedAt: Date.now(),
      }),
    );

    // ── in_flight: fraction-arithmetic (open run, 1 answered probe) ─────
    await seedNode(t, FRACTION_ARITHMETIC_DOMAIN, "frac_1");
    await t.run((ctx) =>
      ctx.db.insert("practicePlacements", {
        scholarId,
        domain: FRACTION_ARITHMETIC_DOMAIN,
        status: "in_progress",
        probesAnswered: 1,
        probeLog: [
          { nodeKey: "frac_1", strand: "s", outcome: "correct", at: Date.now() },
        ],
        updatedAt: Date.now(),
      }),
    );

    // ── shadow_placed: probability (mastery, no converged run) ──────────
    await seedNode(t, PROBABILITY_DOMAIN, "prob_1");
    await t.run((ctx) =>
      ctx.db.insert("practiceMastery", {
        scholarId,
        skillKey: "prob_1",
        domain: PROBABILITY_DOMAIN,
        repetition: 1,
        halfLifeDays: 1,
        frontier: false,
        source: "practice",
        updatedAt: Date.now(),
      }),
    );

    // ── available: geometry-measurement (eligible, no prereq, untouched) ─
    await seedNode(t, GEOMETRY_MEASUREMENT_DOMAIN, "geo_1");

    // ── queued: ratio-proportion-percent (buildsOn geometry, unconverged) ─
    await seedNode(t, RATIO_PROPORTION_PERCENT_DOMAIN, "ratio_1");
    await seedBuildsOnEdge(t, RATIO_PROPORTION_PERCENT_DOMAIN, "geo_1", "ratio_1");

    // ── ineligible: algebra-1 (grade-9 node, outside the K+2 ring) ──────
    await seedNode(t, ALGEBRA_1_DOMAIN, "alg_1", { grade: "9" });

    const asTeacher = await withUser(t, teacherId);
    const result = await asTeacher.query(api.cohortPractice.mapStatusForScholars, {
      scholarIds: [scholarId],
    });

    expect(result.scholars).toHaveLength(1);
    const scholarResult = result.scholars[0];
    expect(scholarResult.scholarId).toBe(scholarId);

    const byDomain = Object.fromEntries(
      scholarResult.perDomain.map((e) => [e.domain, e]),
    );
    expect(byDomain[WHOLE_NUMBER_ARITHMETIC_DOMAIN].status).toBe("converged");
    expect(byDomain[FRACTION_ARITHMETIC_DOMAIN].status).toBe("in_flight");
    expect(byDomain[PROBABILITY_DOMAIN].status).toBe("shadow_placed");
    expect(byDomain[GEOMETRY_MEASUREMENT_DOMAIN].status).toBe("available");
    expect(byDomain[RATIO_PROPORTION_PERCENT_DOMAIN].status).toBe("queued");
    expect(byDomain[RATIO_PROPORTION_PERCENT_DOMAIN].blockedBy).toEqual([
      GEOMETRY_MEASUREMENT_DOMAIN,
    ]);
    expect(byDomain[ALGEBRA_1_DOMAIN].status).toBe("ineligible");
    // Non-queued entries never carry a blocker list.
    expect(byDomain[WHOLE_NUMBER_ARITHMETIC_DOMAIN].blockedBy).toEqual([]);
    expect(byDomain[GEOMETRY_MEASUREMENT_DOMAIN].blockedBy).toEqual([]);

    // N-of-M: converged (1) among eligible (everything but ineligible → 5).
    expect(scholarResult.mappedCount).toBe(1);
    expect(scholarResult.eligibleCount).toBe(5);
  });

  test("a non-teacher caller is Forbidden", async () => {
    const t = convexTest(schema, modules);
    const institutionId = await seedTestInstitution(t, { slug: "moli-map-status-forbidden" });
    const scholarId = await seedScholarInInstitution(t, {
      institutionId,
      name: "Scholar",
      username: "scholar-map-status-forbidden",
    });

    const asScholar = await withUser(t, scholarId);
    await expect(
      asScholar.query(api.cohortPractice.mapStatusForScholars, {
        scholarIds: [scholarId],
      }),
    ).rejects.toThrow(/Forbidden/);
  });

  test("a cross-institution scholar is silently excluded, not leaked", async () => {
    const t = convexTest(schema, modules);
    const homeInstitutionId = await seedTestInstitution(t, { slug: "moli-map-status-home" });
    const otherInstitutionId = await seedTestInstitution(t, { slug: "moli-map-status-other" });

    const teacherId = await t.run((ctx) =>
      ctx.db.insert("users", {
        name: "Teacher",
        username: "teacher-map-status-cross",
        role: "teacher",
      }),
    );
    await grantInstitutionMembership(t, teacherId, homeInstitutionId);

    const homeScholarId = await seedScholarInInstitution(t, {
      institutionId: homeInstitutionId,
      name: "Home Scholar",
      username: "scholar-map-status-home",
    });
    const otherScholarId = await seedScholarInInstitution(t, {
      institutionId: otherInstitutionId,
      name: "Other Scholar",
      username: "scholar-map-status-other",
    });

    const asTeacher = await withUser(t, teacherId);
    const result = await asTeacher.query(api.cohortPractice.mapStatusForScholars, {
      scholarIds: [homeScholarId, otherScholarId],
    });

    const scholarIds = result.scholars.map((s) => s.scholarId);
    expect(scholarIds).toContain(homeScholarId);
    expect(scholarIds).not.toContain(otherScholarId);
    expect(result.scholars).toHaveLength(1);
  });
});
