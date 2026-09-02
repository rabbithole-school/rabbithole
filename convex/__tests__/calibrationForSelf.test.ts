/**
 * calibrationForSelf — the scholar's OWN calibration mirror.
 *
 * Covers: self-access works, another scholar is denied, the n < CALIBRATION_MIN_N
 * gate returns null (no "collect more" nag), and the aggregation reconciles
 * with calibrationForScholar (the teacher read) on the SAME underlying rows —
 * proving the two queries share one pure core (convex/lib/practice/calibration.ts)
 * instead of forking the math. This file only asserts cardinality + auth + cross-
 * query agreement; the pure aggregation itself is unit-tested in
 * convex/lib/practice/calibration.test.ts.
 */
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "../schema";
import { grantInstitutionMembership, seedTestInstitution } from "./institutionTestHelpers";
import { api, internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { CALIBRATION_MIN_N } from "../lib/practice/calibration";

const modules = (
  import.meta as ImportMeta & {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("../**/*.ts");

async function seedUser(
  t: ReturnType<typeof convexTest>,
  role: "scholar" | "teacher" = "scholar",
  username = `test${role}`,
) {
  const institutionId = await seedTestInstitution(t);
  const userId = await t.run(async (ctx) =>
    ctx.db.insert("users", { name: `Test ${role}`, username, role }),
  );

  await t.run((ctx) => ctx.db.patch(userId, { institutionId }));
  if (role === "teacher") {
    await grantInstitutionMembership(t, userId, institutionId, role);
  }
  return userId;
}

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

/** Insert a stored generated item on a real seeded skill (answer "1"). */
async function seedItem(
  t: ReturnType<typeof convexTest>,
  skillKey = "count_to_10",
) {
  const id = await t.run(async (ctx) =>
    ctx.db.insert("practiceItems", {
      skillKey,
      domain: "whole-number-arithmetic",
      stem: "probe",
      answerType: "integer",
      answerCanonical: "1",
      source: "generated",
      verifiedAt: Date.now(),
    }),
  );
  return `gen#${id}` as const;
}

/** Submit `n` predicted attempts for a scholar, alternating right/wrong so the
 * band lands somewhere non-trivial (exact band isn't the point of this file). */
async function submitPredictions(
  t: ReturnType<typeof convexTest>,
  asScholar: Awaited<ReturnType<typeof withUser>>,
  scholar: Id<"users">,
  n: number,
  confidence: "sure" | "think_so" | "not_sure" = "sure",
) {
  for (let i = 0; i < n; i++) {
    const itemId = await seedItem(t);
    await asScholar.mutation(api.practiceSkills.submitAnswer, {
      scholarId: scholar,
      itemId,
      answer: i % 2 === 0 ? "1" : "2", // alternate right/wrong
      predictedConfidence: confidence,
    });
  }
}

describe("calibrationForSelf — self access", () => {
  test("a scholar can read their own calibration mirror", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.practiceSkills.seedGraph, {});
    const scholar = await seedUser(t, "scholar", "mirror-self");
    const asScholar = await withUser(t, scholar);

    await submitPredictions(t, asScholar, scholar, CALIBRATION_MIN_N, "sure");

    const mirror = await asScholar.query(api.practiceCalibration.calibrationForSelf, {
      scholarId: scholar,
    });
    expect(mirror).not.toBeNull();
    expect(mirror!.n).toBe(CALIBRATION_MIN_N);
    expect(mirror!.byLevel).toHaveLength(3);
    expect(mirror!.byLevel.map((l) => l.level)).toEqual(["sure", "think_so", "not_sure"]);
    // never a raw bias/gap number in the shape
    expect(Object.keys(mirror!).sort()).toEqual(["byLevel", "growthLine", "n"]);
    for (const level of mirror!.byLevel) {
      expect(Object.keys(level).sort()).toEqual(["correct", "label", "level", "total"]);
    }
    expect(typeof mirror!.growthLine).toBe("string");
  });
});

describe("calibrationForSelf — another scholar is denied", () => {
  test("a scholar cannot read a peer's calibration mirror", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.practiceSkills.seedGraph, {});
    const scholarA = await seedUser(t, "scholar", "mirror-a");
    const scholarB = await seedUser(t, "scholar", "mirror-b");
    const asA = await withUser(t, scholarA);

    await expect(
      asA.query(api.practiceCalibration.calibrationForSelf, { scholarId: scholarB }),
    ).rejects.toThrow(/forbidden/i);
  });

  test("a teacher CAN read a scholar's mirror (self-or-teacher gate)", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.practiceSkills.seedGraph, {});
    const scholar = await seedUser(t, "scholar", "mirror-c");
    const teacher = await seedUser(t, "teacher", "mirror-teacher");
    const asScholar = await withUser(t, scholar);
    const asTeacher = await withUser(t, teacher);

    await submitPredictions(t, asScholar, scholar, CALIBRATION_MIN_N, "sure");

    const mirror = await asTeacher.query(api.practiceCalibration.calibrationForSelf, {
      scholarId: scholar,
    });
    expect(mirror).not.toBeNull();
    expect(mirror!.n).toBe(CALIBRATION_MIN_N);
  });
});

describe("calibrationForSelf — minimum data gate", () => {
  test("returns null below CALIBRATION_MIN_N — no nag, just nothing", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.practiceSkills.seedGraph, {});
    const scholar = await seedUser(t, "scholar", "mirror-thin");
    const asScholar = await withUser(t, scholar);

    await submitPredictions(t, asScholar, scholar, CALIBRATION_MIN_N - 1, "sure");

    const mirror = await asScholar.query(api.practiceCalibration.calibrationForSelf, {
      scholarId: scholar,
    });
    expect(mirror).toBeNull();
  });

  test("zero predictions also returns null", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.practiceSkills.seedGraph, {});
    const scholar = await seedUser(t, "scholar", "mirror-empty");
    const asScholar = await withUser(t, scholar);

    const mirror = await asScholar.query(api.practiceCalibration.calibrationForSelf, {
      scholarId: scholar,
    });
    expect(mirror).toBeNull();
  });
});

describe("calibrationForSelf — reconciles with calibrationForScholar on the same data", () => {
  test("both queries agree on n and on band-derived direction (shared pure core)", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.practiceSkills.seedGraph, {});
    const scholar = await seedUser(t, "scholar", "mirror-reconcile");
    const teacher = await seedUser(t, "teacher", "mirror-reconcile-teacher");
    const asScholar = await withUser(t, scholar);
    const asTeacher = await withUser(t, teacher);

    // 8 "sure" hits, all correct → unambiguously well_calibrated on both reads.
    for (let i = 0; i < CALIBRATION_MIN_N; i++) {
      const itemId = await seedItem(t);
      await asScholar.mutation(api.practiceSkills.submitAnswer, {
        scholarId: scholar,
        itemId,
        answer: "1",
        predictedConfidence: "sure",
      });
    }

    const mirror = await asScholar.query(api.practiceCalibration.calibrationForSelf, {
      scholarId: scholar,
    });
    const teacherView = await asTeacher.query(api.practiceCalibration.calibrationForScholar, {
      scholarId: scholar,
    });

    expect(mirror).not.toBeNull();
    // Same n from the same underlying rows — the two queries never fork the count.
    expect(mirror!.n).toBe(teacherView.overall.n);
    expect(teacherView.overall.band).toBe("well_calibrated");
    // The mirror's byLevel totals sum back to n, and "sure" carries every row.
    const totalAcrossLevels = mirror!.byLevel.reduce((sum, l) => sum + l.total, 0);
    expect(totalAcrossLevels).toBe(mirror!.n);
    const sureLevel = mirror!.byLevel.find((l) => l.level === "sure")!;
    expect(sureLevel.total).toBe(CALIBRATION_MIN_N);
    expect(sureLevel.correct).toBe(CALIBRATION_MIN_N);
  });
});
