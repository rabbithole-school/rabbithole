/**
 * Predict-then-Check calibration — the Convex surface.
 *
 * Covers the write path (submitAnswer logging a practicePredictions row) and the
 * two read gates (scholar self-only summary, teacher-gated full read). The pure
 * math is unit-tested separately in convex/lib/practice/calibration.test.ts — this
 * file asserts cardinality + auth, not arithmetic.
 */
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "../schema";
import { api, internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { CONFIDENCE_VALUES } from "../lib/practice/calibration";
import { grantStaffAccessToScholars } from "./institutionTestHelpers";

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
  return await t.run(async (ctx) =>
    ctx.db.insert("users", { name: `Test ${role}`, username, role }),
  );
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

async function allPredictions(t: ReturnType<typeof convexTest>) {
  return await t.run(async (ctx) => ctx.db.query("practicePredictions").collect());
}

describe("practicePredictions — write cardinality on the grade path", () => {
  test("a predicted attempt writes exactly ONE row with the mapped confidence + outcome", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.practiceSkills.seedGraph, {});
    const scholar = await seedUser(t);
    const asScholar = await withUser(t, scholar);
    const itemId = await seedItem(t);

    // Correct answer, "not_sure" prediction → underconfident data point.
    const res = await asScholar.mutation(api.practiceSkills.submitAnswer, {
      scholarId: scholar,
      itemId,
      answer: "1",
      predictedConfidence: "not_sure",
    });
    expect(res.correct).toBe(true);

    const rows = await allPredictions(t);
    expect(rows).toHaveLength(1);
    expect(rows[0].scholarId).toBe(scholar);
    expect(rows[0].skillKey).toBe("count_to_10");
    expect(rows[0].confidence).toBe(CONFIDENCE_VALUES.not_sure);
    expect(rows[0].correct).toBe(true);
    expect(rows[0].source).toBe("practice");
    // A "gen#<id>" item stamps the practiceItems id.
    expect(rows[0].itemId).toBe(itemId.slice(4));
  });

  test("a wrong predicted attempt records the miss (confidence unchanged)", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.practiceSkills.seedGraph, {});
    const scholar = await seedUser(t);
    const asScholar = await withUser(t, scholar);
    const itemId = await seedItem(t);

    const res = await asScholar.mutation(api.practiceSkills.submitAnswer, {
      scholarId: scholar,
      itemId,
      answer: "2", // wrong
      predictedConfidence: "sure",
    });
    expect(res.correct).toBe(false);

    const rows = await allPredictions(t);
    expect(rows).toHaveLength(1);
    expect(rows[0].confidence).toBe(CONFIDENCE_VALUES.sure);
    expect(rows[0].correct).toBe(false);
  });

  test("NO prediction arg → NO row (the chip is optional, skipping changes nothing)", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.practiceSkills.seedGraph, {});
    const scholar = await seedUser(t);
    const asScholar = await withUser(t, scholar);
    const itemId = await seedItem(t);

    await asScholar.mutation(api.practiceSkills.submitAnswer, {
      scholarId: scholar,
      itemId,
      answer: "1",
    });

    expect(await allPredictions(t)).toHaveLength(0);
  });

  test("a record:false retry never logs a prediction (first-look affordance only)", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.practiceSkills.seedGraph, {});
    const scholar = await seedUser(t);
    const asScholar = await withUser(t, scholar);
    const itemId = await seedItem(t);

    await asScholar.mutation(api.practiceSkills.submitAnswer, {
      scholarId: scholar,
      itemId,
      answer: "1",
      record: false,
      predictedConfidence: "sure",
    });

    expect(await allPredictions(t)).toHaveLength(0);
  });
});

describe("myCalibrationSummary — scholar self-only, redacted shape", () => {
  test("returns only { n, band }, never raw bias/gap numbers", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.practiceSkills.seedGraph, {});
    const scholar = await seedUser(t);
    const asScholar = await withUser(t, scholar);
    const itemId = await seedItem(t);

    await asScholar.mutation(api.practiceSkills.submitAnswer, {
      scholarId: scholar,
      itemId,
      answer: "1",
      predictedConfidence: "sure",
    });

    const summary = await asScholar.query(
      api.practiceCalibration.myCalibrationSummary,
      {},
    );
    expect(Object.keys(summary).sort()).toEqual(["band", "n"]);
    expect(summary.n).toBe(1);
    expect(summary.band).toBe("insufficient_data"); // n < 8
  });

  test("a scholar's summary reflects only their OWN predictions, never a peer's", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.practiceSkills.seedGraph, {});
    const scholarA = await seedUser(t, "scholar", "scholarA");
    const scholarB = await seedUser(t, "scholar", "scholarB");
    const asA = await withUser(t, scholarA);
    const asB = await withUser(t, scholarB);

    // B makes several predictions; A makes none.
    for (let i = 0; i < 3; i++) {
      const itemId = await seedItem(t);
      await asB.mutation(api.practiceSkills.submitAnswer, {
        scholarId: scholarB,
        itemId,
        answer: "1",
        predictedConfidence: "sure",
      });
    }

    const aSummary = await asA.query(
      api.practiceCalibration.myCalibrationSummary,
      {},
    );
    expect(aSummary.n).toBe(0);

    const bSummary = await asB.query(
      api.practiceCalibration.myCalibrationSummary,
      {},
    );
    expect(bSummary.n).toBe(3);
  });
});

describe("calibrationForScholar — teacher-gated", () => {
  test("a scholar cannot read the full (teacher) calibration", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.practiceSkills.seedGraph, {});
    const scholar = await seedUser(t);
    const asScholar = await withUser(t, scholar);

    await expect(
      asScholar.query(api.practiceCalibration.calibrationForScholar, {
        scholarId: scholar,
      }),
    ).rejects.toThrow(/teacher or admin/i);
  });

  test("a teacher gets the overall summary + per-domain breakdown", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.practiceSkills.seedGraph, {});
    const scholar = await seedUser(t, "scholar", "cscholar");
    const teacher = await seedUser(t, "teacher", "cteacher");
    await grantStaffAccessToScholars(t, {
      staffUserId: teacher,
      scholarIds: [scholar],
    });
    const asScholar = await withUser(t, scholar);
    const asTeacher = await withUser(t, teacher);

    for (let i = 0; i < 2; i++) {
      const itemId = await seedItem(t);
      await asScholar.mutation(api.practiceSkills.submitAnswer, {
        scholarId: scholar,
        itemId,
        answer: "1",
        predictedConfidence: "think_so",
      });
    }

    const full = await asTeacher.query(
      api.practiceCalibration.calibrationForScholar,
      { scholarId: scholar },
    );
    expect(full.overall.n).toBe(2);
    // count_to_10 lives in whole-number-arithmetic → one domain bucket.
    expect(full.byDomain).toHaveLength(1);
    expect(full.byDomain[0].domain).toBe("whole-number-arithmetic");
    expect(full.byDomain[0].n).toBe(2);
  });
});

// ── Institution boundary ──────────────────────────────────────────────────────
// The role gate above proves teacher-vs-scholar; this proves the per-scholar
// institution scoping (requireActiveScholarAccess): a teacher can read a scholar
// in THEIR institution but not one in another.

async function seedInstitution(t: ReturnType<typeof convexTest>, slug: string) {
  return await t.run(async (ctx) =>
    ctx.db.insert("institutions", { name: `Inst ${slug}`, slug, kind: "school" }),
  );
}

async function seedScholarIn(
  t: ReturnType<typeof convexTest>,
  username: string,
  institutionId: Id<"institutions">,
) {
  return await t.run(async (ctx) =>
    ctx.db.insert("users", {
      name: `Test ${username}`,
      username,
      role: "scholar",
      institutionId,
    }),
  );
}

async function seedTeacherWithMembership(
  t: ReturnType<typeof convexTest>,
  username: string,
  institutionId: Id<"institutions">,
) {
  const teacherId = await t.run(async (ctx) =>
    ctx.db.insert("users", {
      name: `Test ${username}`,
      username,
      role: "teacher",
      institutionId,
    }),
  );
  await t.run(async (ctx) =>
    ctx.db.insert("memberships", { userId: teacherId, role: "teacher", institutionId }),
  );
  return teacherId;
}

describe("calibrationForScholar — institution scope", () => {
  test("a teacher CANNOT read a scholar outside their institution", async () => {
    const t = convexTest(schema, modules);
    const instA = await seedInstitution(t, "alpha");
    const instB = await seedInstitution(t, "beta");
    const teacherA = await seedTeacherWithMembership(t, "teacher-a", instA);
    const scholarB = await seedScholarIn(t, "scholar-b", instB);
    const asTeacherA = await withUser(t, teacherA);

    await expect(
      asTeacherA.query(api.practiceCalibration.calibrationForScholar, {
        scholarId: scholarB,
      }),
    ).rejects.toThrow(/not in your current context/i);
  });

  test("a teacher CAN read a scholar in their own institution", async () => {
    const t = convexTest(schema, modules);
    const instA = await seedInstitution(t, "alpha");
    const teacherA = await seedTeacherWithMembership(t, "teacher-a", instA);
    const scholarA = await seedScholarIn(t, "scholar-a", instA);
    const asTeacherA = await withUser(t, teacherA);

    const full = await asTeacherA.query(
      api.practiceCalibration.calibrationForScholar,
      { scholarId: scholarA },
    );
    // In-scope read succeeds (no predictions yet → insufficient_data).
    expect(full.overall.n).toBe(0);
    expect(full.overall.band).toBe("insufficient_data");
    expect(full.byDomain).toEqual([]);
  });
});
