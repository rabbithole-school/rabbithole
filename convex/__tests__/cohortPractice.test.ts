// Tests for cohortPractice.masteryForScholars — the teacher-facing cohort
// mastery matrix read: canonical per-scholar dial readings, per-scholar
// independence, and the "still mapping" placement state (spec §3.4) adopted
// from the retired strandProgressForScholar. The practiced-today
// institution-local day boundary that used to live here now rides
// scholars.rosterPulse (see rosterPulsePracticedToday.test.ts).
import { convexTest } from "convex-test";
import type { TestConvex } from "convex-test";
import { afterEach, describe, expect, test, vi } from "vitest";
import schema from "../schema";
import {
  grantInstitutionMembership,
  seedScholarInInstitution,
  seedTestInstitution,
} from "./institutionTestHelpers";
import { api } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { WHOLE_NUMBER_ARITHMETIC_DOMAIN } from "../seed/wholeNumberArithmeticGraph";
import { FLUENT_REPS, OVERLEARNED_REPS } from "../lib/practice/scheduler";

const modules = (
  import.meta as ImportMeta & {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("../**/*.ts");

type TC = TestConvex<typeof schema>;

// Honolulu is a fixed UTC-10 offset (no DST) — deterministic across the year.
const HONOLULU = "Pacific/Honolulu";

async function seedTeacher(t: TC) {
  const institutionId = await seedTestInstitution(t, { slug: "test-school" });
  const userId = await t.run(async (ctx) =>
    ctx.db.insert("users", { name: "Teacher", username: "teacher1", role: "teacher" }),
  );

  await grantInstitutionMembership(t, userId, institutionId);
  return userId;
}

async function seedScholarInTimeZone(t: TC, timeZone: string) {
  const institutionId = await seedTestInstitution(t, { slug: "test-school" });
  await t.run((ctx) => ctx.db.patch(institutionId, { timeZone }));
  return seedScholarInInstitution(t, {
    institutionId,
    name: "Scholar",
    username: "scholar1",
  });
}

async function withUser(t: TC, userId: Id<"users">) {
  const sessionId = await t.run(async (ctx) =>
    ctx.db.insert("authSessions", { userId, expirationTime: Date.now() + 3_600_000 }),
  );
  return t.withIdentity({ subject: `${userId}|${sessionId}`, issuer: "https://convex.dev" });
}

async function seedMasteryRow(
  t: TC,
  scholarId: Id<"users">,
  updatedAt: number,
  skillKey = "add_within_20",
) {
  await t.run(async (ctx) => {
    await ctx.db.insert("practiceMastery", {
      scholarId,
      skillKey,
      domain: WHOLE_NUMBER_ARITHMETIC_DOMAIN,
      repetition: 1,
      halfLifeDays: 1,
      frontier: false,
      source: "practice",
      updatedAt,
    });
  });
}

afterEach(() => {
  vi.useRealTimers();
});

describe("cohortPractice.masteryForScholars — mappingState (spec §3.4)", () => {
  // The still-mapping state adopted from the retired strandProgressForScholar,
  // so the matrix can render an unmapped scholar honestly. An untouched domain
  // reads "mapping"; a parked, partly-answered placement reads "in_progress"; a
  // domain with any mastery row reads "mapped".
  test("unmapped → 'mapping'; parked placement → 'in_progress'; placed → 'mapped'", async () => {
    const t = convexTest(schema, modules);
    const teacher = await seedTeacher(t);
    const scholar = await seedScholarInTimeZone(t, HONOLULU);
    const asTeacher = await withUser(t, teacher);

    const unmapped = await asTeacher.query(api.cohortPractice.masteryForScholars, {
      scholarIds: [scholar],
      domain: WHOLE_NUMBER_ARITHMETIC_DOMAIN,
    });
    expect(unmapped.scholars[0]?.mappingState).toBe("mapping");

    // A parked, in-progress placement (a real probeLog entry) reads in_progress.
    await t.run(async (ctx) => {
      await ctx.db.insert("practicePlacements", {
        scholarId: scholar,
        domain: WHOLE_NUMBER_ARITHMETIC_DOMAIN,
        status: "in_progress",
        probesAnswered: 1,
        probeLog: [{ nodeKey: "add_within_20", strand: "addition", outcome: "correct", at: Date.now() }],
        updatedAt: Date.now(),
      });
    });

    const inProgress = await asTeacher.query(api.cohortPractice.masteryForScholars, {
      scholarIds: [scholar],
      domain: WHOLE_NUMBER_ARITHMETIC_DOMAIN,
    });
    expect(inProgress.scholars[0]?.mappingState).toBe("in_progress");

    // Once mastery exists (placed), the domain reads mapped.
    await seedMasteryRow(t, scholar, Date.now());
    const mapped = await asTeacher.query(api.cohortPractice.masteryForScholars, {
      scholarIds: [scholar],
      domain: WHOLE_NUMBER_ARITHMETIC_DOMAIN,
    });
    expect(mapped.scholars[0]?.mappingState).toBe("mapped");
  });
});

describe("cohortPractice.masteryForScholars", () => {
  test("returns canonical per-scholar dial readings without a group aggregate", async () => {
    const t = convexTest(schema, modules);
    const teacher = await seedTeacher(t);
    const scholar = await seedScholarInTimeZone(t, HONOLULU);
    const now = Date.now();

    await t.run(async (ctx) => {
      await ctx.db.insert("knowledgeNodes", {
        nodeKey: "whole_numbers",
        label: "Whole numbers",
        normalizedLabel: "whole numbers",
        domain: WHOLE_NUMBER_ARITHMETIC_DOMAIN,
        strand: "number-sense",
        order: 1,
      });
      await ctx.db.insert("knowledgeNodes", {
        nodeKey: "add_within_20",
        label: "Add within 20",
        normalizedLabel: "add within 20",
        domain: WHOLE_NUMBER_ARITHMETIC_DOMAIN,
        strand: "addition",
        order: 2,
      });
      await ctx.db.insert("knowledgeNodeEdges", {
        fromKey: "whole_numbers",
        toKey: "add_within_20",
        domain: WHOLE_NUMBER_ARITHMETIC_DOMAIN,
        kind: "buildsOn",
      });
      await ctx.db.insert("practiceMastery", {
        scholarId: scholar,
        skillKey: "whole_numbers",
        domain: WHOLE_NUMBER_ARITHMETIC_DOMAIN,
        repetition: FLUENT_REPS,
        halfLifeDays: 30,
        lastPracticedAt: now,
        frontier: false,
        source: "placement",
        updatedAt: now,
      });
      await ctx.db.insert("masteryObservations", {
        scholarId: scholar,
        conceptLabel: "Add within 20",
        nodeKey: "add_within_20",
        domain: WHOLE_NUMBER_ARITHMETIC_DOMAIN,
        observedAt: now,
        transcriptExcerpt: "Uses decomposition accurately.",
        masteryLevel: 4,
        confidenceScore: 0.9,
        evidenceSummary: "Explained the strategy.",
        evidenceType: "direct_demonstration",
        attemptContext: "session",
        studentInitiated: true,
        isSuperseded: false,
      });
    });

    const asTeacher = await withUser(t, teacher);
    const result = await asTeacher.query(api.cohortPractice.masteryForScholars, {
      scholarIds: [scholar],
      domain: WHOLE_NUMBER_ARITHMETIC_DOMAIN,
    });

    expect(result).not.toHaveProperty("aggregate");
    expect(result.scholars).toHaveLength(1);
    expect(result.scholars[0]?.readings).toEqual([
      expect.objectContaining({
        nodeKey: "whole_numbers",
        mastery: "placed",
        automaticity: 0.85,
      }),
      expect.objectContaining({
        nodeKey: "add_within_20",
        mastery: "frontier",
        depth: 0.8,
        frontier: true,
      }),
    ]);
  });

  test("keeps each scholar's mastery independent", async () => {
    const t = convexTest(schema, modules);
    const teacher = await seedTeacher(t);
    const first = await seedScholarInTimeZone(t, HONOLULU);
    const second = await seedScholarInInstitution(t, {
      institutionId: await seedTestInstitution(t, { slug: "test-school" }),
      name: "Second Scholar",
      username: "scholar2",
    });
    const now = Date.now();

    await t.run(async (ctx) => {
      await ctx.db.insert("knowledgeNodes", {
        nodeKey: "add_within_20",
        label: "Add within 20",
        domain: WHOLE_NUMBER_ARITHMETIC_DOMAIN,
        strand: "addition",
        order: 1,
      });
      await ctx.db.insert("practiceMastery", {
        scholarId: first,
        skillKey: "add_within_20",
        domain: WHOLE_NUMBER_ARITHMETIC_DOMAIN,
        repetition: FLUENT_REPS,
        halfLifeDays: 30,
        lastPracticedAt: now,
        frontier: false,
        source: "practice",
        updatedAt: now,
      });
    });

    const asTeacher = await withUser(t, teacher);
    const result = await asTeacher.query(api.cohortPractice.masteryForScholars, {
      scholarIds: [first, second],
      domain: WHOLE_NUMBER_ARITHMETIC_DOMAIN,
    });

    expect(result.scholars.map((row) => row.readings[0]?.mastery)).toEqual([
      "fluent",
      "frontier",
    ]);
  });

  test("resolves a foreign prerequisite from its canonical domain", async () => {
    const t = convexTest(schema, modules);
    const teacher = await seedTeacher(t);
    const scholar = await seedScholarInTimeZone(t, HONOLULU);
    const now = Date.now();

    await t.run(async (ctx) => {
      await ctx.db.insert("knowledgeNodes", {
        nodeKey: "foreign_prerequisite",
        label: "Foreign prerequisite",
        domain: "source-domain",
      });
      await ctx.db.insert("knowledgeNodes", {
        nodeKey: "child_skill",
        label: "Child skill",
        domain: "child-domain",
      });
      await ctx.db.insert("knowledgeNodeEdges", {
        fromKey: "foreign_prerequisite",
        toKey: "child_skill",
        domain: "child-domain",
        kind: "buildsOn",
      });
      await ctx.db.insert("practiceMastery", {
        scholarId: scholar,
        skillKey: "foreign_prerequisite",
        domain: "legacy-domain",
        repetition: 0,
        halfLifeDays: 0,
        frontier: false,
        source: "practice",
        updatedAt: now,
      });
      await ctx.db.insert("practiceMastery", {
        scholarId: scholar,
        skillKey: "foreign_prerequisite",
        domain: "source-domain",
        repetition: FLUENT_REPS,
        halfLifeDays: 30,
        lastPracticedAt: now,
        frontier: false,
        source: "practice",
        updatedAt: now,
      });
    });

    const asTeacher = await withUser(t, teacher);
    const result = await asTeacher.query(api.cohortPractice.masteryForScholars, {
      scholarIds: [scholar],
      domain: "child-domain",
    });

    expect(result.scholars[0]?.readings[0]).toEqual(
      expect.objectContaining({
        nodeKey: "child_skill",
        mastery: "frontier",
      }),
    );
  });
});

describe("cohortPractice.masteryForScholars — retention (Tier 1/2 freshness, spec §9-10.2)", () => {
  test("no mastery rows at all → a calm all-zero retention, no crash", async () => {
    const t = convexTest(schema, modules);
    const teacher = await seedTeacher(t);
    const scholar = await seedScholarInTimeZone(t, HONOLULU);
    const asTeacher = await withUser(t, teacher);

    const result = await asTeacher.query(api.cohortPractice.masteryForScholars, {
      scholarIds: [scholar],
      domain: WHOLE_NUMBER_ARITHMETIC_DOMAIN,
    });
    expect(result.scholars[0]?.retention).toEqual({
      dueCount: 0,
      greenCount: 0,
      mostOverdue: undefined,
    });
  });

  test("a fresh green skill is green, not due — the cell's spare number stays uncluttered", async () => {
    const t = convexTest(schema, modules);
    const teacher = await seedTeacher(t);
    const scholar = await seedScholarInTimeZone(t, HONOLULU);
    const now = Date.now();
    await seedMasteryRow(t, scholar, now);
    await t.run(async (ctx) => {
      await ctx.db.patch(
        (
          await ctx.db
            .query("practiceMastery")
            .withIndex("by_scholar_domain", (q) =>
              q.eq("scholarId", scholar).eq("domain", WHOLE_NUMBER_ARITHMETIC_DOMAIN),
            )
            .first()
        )!._id,
        { repetition: FLUENT_REPS, halfLifeDays: 60, lastPracticedAt: now },
      );
    });

    const asTeacher = await withUser(t, teacher);
    const result = await asTeacher.query(api.cohortPractice.masteryForScholars, {
      scholarIds: [scholar],
      domain: WHOLE_NUMBER_ARITHMETIC_DOMAIN,
    });
    expect(result.scholars[0]?.retention).toEqual({
      dueCount: 0,
      greenCount: 1,
      mostOverdue: undefined,
    });
  });

  test("a decayed green skill is due, and reports its HONEST last-attempt recency", async () => {
    const t = convexTest(schema, modules);
    const teacher = await seedTeacher(t);
    const scholar = await seedScholarInTimeZone(t, HONOLULU);
    const staleAttempt = Date.now() - 24 * 24 * 60 * 60 * 1000;

    await t.run(async (ctx) => {
      await ctx.db.insert("practiceMastery", {
        scholarId: scholar,
        skillKey: "add_within_20",
        domain: WHOLE_NUMBER_ARITHMETIC_DOMAIN,
        repetition: OVERLEARNED_REPS,
        halfLifeDays: 18,
        lastPracticedAt: staleAttempt,
        lastAttemptAt: staleAttempt,
        frontier: false,
        source: "practice",
        updatedAt: staleAttempt,
      });
    });

    const asTeacher = await withUser(t, teacher);
    const result = await asTeacher.query(api.cohortPractice.masteryForScholars, {
      scholarIds: [scholar],
      domain: WHOLE_NUMBER_ARITHMETIC_DOMAIN,
    });
    expect(result.scholars[0]?.retention).toEqual({
      dueCount: 1,
      greenCount: 1,
      mostOverdue: { lastAttemptAt: staleAttempt, halfLifeDays: 18 },
    });
  });

  test("a due skill credited ONLY by placement (never actually drilled) reports a NULL lastAttemptAt — never lastPracticedAt", async () => {
    const t = convexTest(schema, modules);
    const teacher = await seedTeacher(t);
    const scholar = await seedScholarInTimeZone(t, HONOLULU);
    const staleClock = Date.now() - 40 * 24 * 60 * 60 * 1000;

    await t.run(async (ctx) => {
      await ctx.db.insert("practiceMastery", {
        scholarId: scholar,
        skillKey: "add_within_20",
        domain: WHOLE_NUMBER_ARITHMETIC_DOMAIN,
        repetition: FLUENT_REPS,
        halfLifeDays: 10,
        lastPracticedAt: staleClock, // SR clock only — placement stamped it
        // lastAttemptAt intentionally omitted: never a real attempt.
        frontier: false,
        source: "placement",
        updatedAt: staleClock,
      });
    });

    const asTeacher = await withUser(t, teacher);
    const result = await asTeacher.query(api.cohortPractice.masteryForScholars, {
      scholarIds: [scholar],
      domain: WHOLE_NUMBER_ARITHMETIC_DOMAIN,
    });
    expect(result.scholars[0]?.retention?.dueCount).toBe(1);
    expect(result.scholars[0]?.retention?.mostOverdue?.lastAttemptAt).toBeNull();
  });
});

describe("cohortPractice.crossDomainMasteryForScholars — retention (Tier 1 hover, spec §9)", () => {
  test("no mastery rows → each seeded domain's retention is a calm all-zero, cell stays uncluttered", async () => {
    const t = convexTest(schema, modules);
    const teacher = await seedTeacher(t);
    const scholar = await seedScholarInTimeZone(t, HONOLULU);

    await t.run(async (ctx) => {
      await ctx.db.insert("knowledgeNodes", {
        nodeKey: "add_within_20",
        label: "Add within 20",
        domain: WHOLE_NUMBER_ARITHMETIC_DOMAIN,
        strand: "addition",
        grade: "1",
        order: 1,
      });
    });

    const asTeacher = await withUser(t, teacher);
    const result = await asTeacher.query(api.cohortPractice.crossDomainMasteryForScholars, {
      scholarIds: [scholar],
    });
    const wholeNumberEntry = result.scholars[0]?.domains.find(
      (entry) => entry.domain === WHOLE_NUMBER_ARITHMETIC_DOMAIN,
    );
    expect(wholeNumberEntry?.retention).toEqual({
      dueCount: 0,
      greenCount: 0,
      mostOverdue: undefined,
    });
  });

  test("a due green skill surfaces on its OWN domain's aggregate only, honest recency intact", async () => {
    const t = convexTest(schema, modules);
    const teacher = await seedTeacher(t);
    const scholar = await seedScholarInTimeZone(t, HONOLULU);
    const staleAttempt = Date.now() - 24 * 24 * 60 * 60 * 1000;

    await t.run(async (ctx) => {
      await ctx.db.insert("knowledgeNodes", {
        nodeKey: "add_within_20",
        label: "Add within 20",
        domain: WHOLE_NUMBER_ARITHMETIC_DOMAIN,
        strand: "addition",
        grade: "1",
        order: 1,
      });
      await ctx.db.insert("practiceMastery", {
        scholarId: scholar,
        skillKey: "add_within_20",
        domain: WHOLE_NUMBER_ARITHMETIC_DOMAIN,
        repetition: OVERLEARNED_REPS,
        halfLifeDays: 18,
        lastPracticedAt: staleAttempt,
        lastAttemptAt: staleAttempt,
        frontier: false,
        source: "practice",
        updatedAt: staleAttempt,
      });
    });

    const asTeacher = await withUser(t, teacher);
    const result = await asTeacher.query(api.cohortPractice.crossDomainMasteryForScholars, {
      scholarIds: [scholar],
    });
    const domains = result.scholars[0]?.domains ?? [];
    const wholeNumberEntry = domains.find(
      (entry) => entry.domain === WHOLE_NUMBER_ARITHMETIC_DOMAIN,
    );
    expect(wholeNumberEntry?.retention).toEqual({
      dueCount: 1,
      greenCount: 1,
      mostOverdue: { lastAttemptAt: staleAttempt, halfLifeDays: 18 },
    });
    // Every OTHER seeded domain stays at the calm zero — one scholar's
    // freshness fact in one domain must never leak into another's cell.
    for (const entry of domains) {
      if (entry.domain === WHOLE_NUMBER_ARITHMETIC_DOMAIN) continue;
      expect(entry.retention.dueCount).toBe(0);
    }
  });

  test("institution scoping still gates retention data exactly like the rest of the row", async () => {
    const t = convexTest(schema, modules);
    const teacher = await seedTeacher(t);
    const outsider = await seedScholarInInstitution(t, {
      institutionId: await seedTestInstitution(t, { slug: "outside-school" }),
      name: "Outsider",
      username: "outsider1",
    });

    await t.run(async (ctx) => {
      await ctx.db.insert("knowledgeNodes", {
        nodeKey: "add_within_20",
        label: "Add within 20",
        domain: WHOLE_NUMBER_ARITHMETIC_DOMAIN,
        strand: "addition",
        grade: "1",
        order: 1,
      });
      await ctx.db.insert("practiceMastery", {
        scholarId: outsider,
        skillKey: "add_within_20",
        domain: WHOLE_NUMBER_ARITHMETIC_DOMAIN,
        repetition: OVERLEARNED_REPS,
        halfLifeDays: 1,
        lastPracticedAt: Date.now() - 100 * 24 * 60 * 60 * 1000,
        lastAttemptAt: Date.now() - 100 * 24 * 60 * 60 * 1000,
        frontier: false,
        source: "practice",
        updatedAt: Date.now(),
      });
    });

    const asTeacher = await withUser(t, teacher);
    const result = await asTeacher.query(api.cohortPractice.crossDomainMasteryForScholars, {
      scholarIds: [outsider],
    });
    // A teacher outside the scholar's institution gets nothing back for them —
    // the outsider's retention fact never leaks across the boundary.
    expect(result.scholars).toHaveLength(0);
  });
});

describe("cohortPractice.cohortTree", () => {
  test("collapses the cohort to a median band + histogram + frontier per node, in the tree shape", async () => {
    const t = convexTest(schema, modules);
    const teacher = await seedTeacher(t);
    const first = await seedScholarInTimeZone(t, HONOLULU);
    const second = await seedScholarInInstitution(t, {
      institutionId: await seedTestInstitution(t, { slug: "test-school" }),
      name: "Second Scholar",
      username: "scholar2",
    });
    const now = Date.now();

    await t.run(async (ctx) => {
      // A root skill and one that buildsOn it.
      await ctx.db.insert("knowledgeNodes", {
        nodeKey: "whole_numbers",
        label: "Whole numbers",
        domain: WHOLE_NUMBER_ARITHMETIC_DOMAIN,
        strand: "number-sense",
        order: 1,
      });
      await ctx.db.insert("knowledgeNodes", {
        nodeKey: "add_within_20",
        label: "Add within 20",
        domain: WHOLE_NUMBER_ARITHMETIC_DOMAIN,
        strand: "addition",
        order: 2,
      });
      await ctx.db.insert("knowledgeNodeEdges", {
        fromKey: "whole_numbers",
        toKey: "add_within_20",
        domain: WHOLE_NUMBER_ARITHMETIC_DOMAIN,
        kind: "buildsOn",
      });
      // First scholar is demonstrated-fluent on BOTH.
      for (const skillKey of ["whole_numbers", "add_within_20"]) {
        await ctx.db.insert("practiceMastery", {
          scholarId: first,
          skillKey,
          domain: WHOLE_NUMBER_ARITHMETIC_DOMAIN,
          repetition: FLUENT_REPS,
          halfLifeDays: 30,
          lastPracticedAt: now,
          frontier: false,
          source: "practice",
          updatedAt: now,
        });
      }
      // Second scholar has NO mastery: the root is their frontier, and the
      // prereq-gated skill stays locked.
    });

    const asTeacher = await withUser(t, teacher);
    const tree = await asTeacher.query(api.cohortPractice.cohortTree, {
      scholarIds: [first, second],
      domain: WHOLE_NUMBER_ARITHMETIC_DOMAIN,
    });

    expect(tree.scholarCount).toBe(2);
    // Returned in buildTreeVMs's TreeNode shape (skillKey, not nodeKey).
    const root = tree.nodes.find((n) => n.skillKey === "whole_numbers");
    const gated = tree.nodes.find((n) => n.skillKey === "add_within_20");

    // Root: one fluent + one frontier → lower-median band = frontier; the
    // second scholar's working edge counts toward the cohort frontier.
    expect(root?.band).toBe("frontier");
    expect(root?.bands.fluent).toBe(1);
    expect(root?.bands.frontier).toBe(1);
    expect(root?.frontierCount).toBe(1);
    expect(root?.frontier).toBe(true);

    // Prereq-gated skill: one fluent + one locked → lower-median band = locked.
    expect(gated?.band).toBe("locked");
    expect(gated?.bands.fluent).toBe(1);
    expect(gated?.bands.locked).toBe(1);
  });
});

describe("cohortPractice.domainRollup", () => {
  test("returns basic per-scholar identity for accessible scholars only (no legacy focus fields)", async () => {
    const t = convexTest(schema, modules);
    const teacher = await seedTeacher(t);
    const scholar = await seedScholarInTimeZone(t, HONOLULU);
    const foreign = await seedScholarInInstitution(t, {
      institutionId: await seedTestInstitution(t, { slug: "foreign-school" }),
      name: "Foreign Scholar",
      username: "scholar-foreign",
    });

    const asTeacher = await withUser(t, teacher);
    const rollup = await asTeacher.query(api.cohortPractice.domainRollup, {
      scholarIds: [scholar, foreign],
    });

    // Foreign scholar is filtered out by the institution-scoped access check;
    // only the accessible scholar is returned.
    expect(rollup.scholars).toHaveLength(1);
    expect(rollup.scholars[0]).toEqual(
      expect.objectContaining({ scholarId: scholar }),
    );
    expect(rollup.scholars[0]).not.toHaveProperty("focusConfigured");
    expect(rollup.scholars[0]).not.toHaveProperty("domainFocus");
  });
});
