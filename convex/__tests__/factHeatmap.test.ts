// P4 — the teacher-facing fact heatmap query (cohortPractice.factHeatmapForScholar).
// Verifies the read/map/classify path and the operation filter, using classifier
// states that are DETERMINISTIC without a latency baseline: accuracy below the
// reliable bar is always "effortful"; reliably-correct-but-no-speed-read is
// always "practicing" (we never claim "fast" before we know the scholar's own
// pace — doctrine §5). See convex/lib/practice/factFluency.ts.
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

const modules = (
  import.meta as ImportMeta & {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("../**/*.ts");

type TC = TestConvex<typeof schema>;

async function seedTeacher(t: TC) {
  const institutionId = await seedTestInstitution(t, { slug: "test-school" });
  const userId = await t.run(async (ctx) =>
    ctx.db.insert("users", { name: "Teacher", username: "teacher1", role: "teacher" }),
  );

  await grantInstitutionMembership(t, userId, institutionId);
  return userId;
}

async function seedScholar(t: TC) {
  const institutionId = await seedTestInstitution(t, { slug: "test-school" });
  await t.run((ctx) =>
    ctx.db.patch(institutionId, { timeZone: "Pacific/Honolulu" }),
  );
  return seedScholarInInstitution(t, {
    institutionId,
    name: "Leilani Park",
    username: "leilani1",
  });
}

async function withUser(t: TC, userId: Id<"users">) {
  const sessionId = await t.run(async (ctx) =>
    ctx.db.insert("authSessions", { userId, expirationTime: Date.now() + 3_600_000 }),
  );
  return t.withIdentity({ subject: `${userId}|${sessionId}`, issuer: "https://convex.dev" });
}

async function seedFact(
  t: TC,
  scholarId: Id<"users">,
  fact: {
    factKey: string;
    skillKey: string;
    seenCount: number;
    correctCount: number;
    latencySamplesMs?: number[];
    latencyMedianMs?: number;
    domain?: string;
  },
) {
  await t.run(async (ctx) => {
    await ctx.db.insert("factFluency", {
      scholarId,
      factKey: fact.factKey,
      skillKey: fact.skillKey,
      domain: fact.domain ?? WHOLE_NUMBER_ARITHMETIC_DOMAIN,
      seenCount: fact.seenCount,
      correctCount: fact.correctCount,
      latencySamplesMs: fact.latencySamplesMs,
      latencyMedianMs: fact.latencyMedianMs,
      lastSeenAt: Date.now(),
    });
  });
}

describe("cohortPractice.factHeatmapForScholar", () => {
  test("classifies + maps each fact into a cell (effortful / practicing are baseline-free)", async () => {
    const t = convexTest(schema, modules);
    const teacher = await seedTeacher(t);
    const scholar = await seedScholar(t);

    // Low accuracy (2/4 = 0.5 < 0.67) ⇒ always "effortful", no baseline needed.
    await seedFact(t, scholar, {
      factKey: "mul:7x8",
      skillKey: "mult_facts_7_8_9",
      seenCount: 4,
      correctCount: 2,
    });
    // Reliably correct but no timed samples ⇒ "practicing" (no speed read yet).
    await seedFact(t, scholar, {
      factKey: "mul:2x5",
      skillKey: "mult_facts_0_1_2_5_10",
      seenCount: 5,
      correctCount: 5,
    });
    await seedFact(t, scholar, {
      factKey: "add:6+7",
      skillKey: "add_within_20_regroup",
      seenCount: 3,
      correctCount: 3,
    });
    await seedFact(t, scholar, {
      factKey: "mul:3x4",
      skillKey: "mult_facts_3_4_6",
      seenCount: 2,
      correctCount: 1,
      domain: "another-domain",
    });

    const asTeacher = await withUser(t, teacher);
    const res = await asTeacher.query(api.cohortPractice.factHeatmapForScholar, {
      scholarId: scholar,
      domain: WHOLE_NUMBER_ARITHMETIC_DOMAIN,
    });

    expect(res.baselineKnown).toBe(false);
    const byKey = new Map(res.cells.map((c) => [c.factKey, c]));

    const effortful = byKey.get("mul:7x8");
    expect(effortful).toMatchObject({ op: "mul", a: 7, b: 8, label: "7 × 8", state: "effortful" });

    expect(byKey.get("mul:2x5")).toMatchObject({ op: "mul", a: 2, b: 5, state: "practicing" });
    expect(byKey.get("add:6+7")).toMatchObject({ op: "add", a: 6, b: 7, state: "practicing" });
    // The grid is the same canonical universe as the percentage. A row whose
    // source domain differs still contributes to that one whole-ledger read.
    expect(byKey.get("mul:3x4")).toMatchObject({
      op: "mul",
      a: 3,
      b: 4,
      state: "effortful",
    });
    expect(res.cells).toHaveLength(418);
    expect(res.cells.filter((cell) => cell.op === "add")).toHaveLength(121);
    expect(res.cells.filter((cell) => cell.op === "sub")).toHaveLength(231);
    expect(res.cells.filter((cell) => cell.op === "mul")).toHaveLength(66);
  });

  test("op filter returns just one operation's facts", async () => {
    const t = convexTest(schema, modules);
    const teacher = await seedTeacher(t);
    const scholar = await seedScholar(t);

    await seedFact(t, scholar, {
      factKey: "mul:7x8",
      skillKey: "mult_facts_7_8_9",
      seenCount: 2,
      correctCount: 1,
    });
    await seedFact(t, scholar, {
      factKey: "add:6+7",
      skillKey: "add_within_20_regroup",
      seenCount: 2,
      correctCount: 2,
    });

    const asTeacher = await withUser(t, teacher);
    const mulOnly = await asTeacher.query(api.cohortPractice.factHeatmapForScholar, {
      scholarId: scholar,
      domain: WHOLE_NUMBER_ARITHMETIC_DOMAIN,
      op: "mul",
    });

    expect(mulOnly.cells).toHaveLength(66);
    expect(mulOnly.cells.every((cell) => cell.op === "mul")).toBe(true);
    expect(mulOnly.cells.find((cell) => cell.factKey === "mul:7x8")).toMatchObject({
      state: "effortful",
    });
  });

  test("classifies against one all-domain mastery baseline", async () => {
    const t = convexTest(schema, modules);
    const teacher = await seedTeacher(t);
    const scholar = await seedScholar(t);

    await seedFact(t, scholar, {
      factKey: "mul:7x8",
      skillKey: "mult_facts_7_8_9",
      seenCount: 4,
      correctCount: 4,
      latencySamplesMs: [2_500, 2_500, 2_500],
      latencyMedianMs: 2_500,
    });
    await t.run(async (ctx) => {
      for (const [index, latencyMedianMs] of [1_000, 3_000, 5_000].entries()) {
        await ctx.db.insert("practiceMastery", {
          scholarId: scholar,
          skillKey: `baseline_${index}`,
          domain: `domain_${index}`,
          repetition: 1,
          halfLifeDays: 1,
          frontier: false,
          source: "practice",
          updatedAt: Date.now(),
          latencySamplesMs: [latencyMedianMs],
          latencyMedianMs,
          latencySpreadMs: 0,
        });
      }
    });

    const asTeacher = await withUser(t, teacher);
    const res = await asTeacher.query(api.cohortPractice.factHeatmapForScholar, {
      scholarId: scholar,
      domain: WHOLE_NUMBER_ARITHMETIC_DOMAIN,
    });

    expect(res.baselineKnown).toBe(true);
    expect(res.cells.find((cell) => cell.factKey === "mul:7x8")).toMatchObject({
      factKey: "mul:7x8",
      state: "automatic",
    });
  });

  test("returns the full unseen grid for a scholar with no practiced facts", async () => {
    const t = convexTest(schema, modules);
    const teacher = await seedTeacher(t);
    const scholar = await seedScholar(t);

    const asTeacher = await withUser(t, teacher);
    const res = await asTeacher.query(api.cohortPractice.factHeatmapForScholar, {
      scholarId: scholar,
      domain: WHOLE_NUMBER_ARITHMETIC_DOMAIN,
    });

    expect(res.cells).toHaveLength(418);
    expect(res.cells.every((cell) => cell.state === "unseen")).toBe(true);
    expect(res.cells.every((cell) => cell.seenCount === 0)).toBe(true);
    expect(res.baselineKnown).toBe(false);
  });
});
