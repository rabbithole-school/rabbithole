import { convexTest } from "convex-test";
import type { TestConvex } from "convex-test";
import { describe, expect, test } from "vitest";

import schema from "../schema";
import { api } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { fastMathDenominator } from "../lib/practice/fastMath";
import { isFactFamilySkill } from "../../shared/factKey";
import {
  grantInstitutionMembership,
  seedScholarInInstitution,
  seedTestInstitution,
} from "./institutionTestHelpers";

const modules = (
  import.meta as ImportMeta & {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("../**/*.ts");

type TC = TestConvex<typeof schema>;

async function withUser(t: TC, userId: Id<"users">) {
  const sessionId = await t.run((ctx) =>
    ctx.db.insert("authSessions", {
      userId,
      expirationTime: Date.now() + 3_600_000,
    }),
  );
  return t.withIdentity({
    subject: `${userId}|${sessionId}`,
    issuer: "https://convex.dev",
  });
}

async function seedTeacher(
  t: TC,
  institutionId: Id<"institutions">,
  username: string,
) {
  const teacherId = await t.run((ctx) =>
    ctx.db.insert("users", {
      name: `Teacher ${username}`,
      username,
      role: "teacher",
    }),
  );
  await grantInstitutionMembership(t, teacherId, institutionId);
  return teacherId;
}

describe("practiceSkills.startQuickFactsPractice", () => {
  test("starts a canonical Quick-facts-only round for a licensed scholar", async () => {
    const t = convexTest(schema, modules);
    const institutionId = await seedTestInstitution(t, { slug: "quick-facts-a" });
    const scholarId = await seedScholarInInstitution(t, {
      institutionId,
      username: "licensed-quick-facts",
    });
    const teacherId = await seedTeacher(t, institutionId, "quick-facts-teacher");
    await t.run((ctx) =>
      ctx.db.insert("calculatorLicenses", {
        scholarId,
        issuedAt: Date.now(),
        issuedBy: teacherId,
      }),
    );

    const asScholar = await withUser(t, scholarId);
    const [result, status] = await Promise.all([
      asScholar.query(api.practiceSkills.startQuickFactsPractice, {
        scholarId,
        seed: 42,
      }),
      asScholar.query(api.calculatorLicenses.myLicenseStatus, {}),
    ]);

    expect(result).toMatchObject({
      available: true,
      unavailableReason: null,
      domain: "whole-number-arithmetic",
      domains: ["whole-number-arithmetic"],
      challenge: [],
      stretch: [],
    });
    expect(result.items).toHaveLength(5);
    expect(result.items.every((item) => item.isFactSprint)).toBe(true);
    expect(result.items.every((item) => isFactFamilySkill(item.skillKey))).toBe(
      true,
    );
    expect(result.segments).toEqual([
      { kind: "fact_sprint", count: result.items.length },
    ]);
    expect(status).toMatchObject({
      state: "licensed",
      license: { issuedAt: expect.any(Number) },
      fastMath: {
        calibration: "uncalibrated",
        automaticCount: 0,
        denominator: fastMathDenominator(),
        percent: 0,
        ready: false,
      },
    });
  });

  test("starts a useful uncalibrated round and exposes only the scholar's own reading", async () => {
    const t = convexTest(schema, modules);
    const institutionId = await seedTestInstitution(t, { slug: "quick-facts-b" });
    const scholarId = await seedScholarInInstitution(t, {
      institutionId,
      username: "fresh-quick-facts",
    });
    const peerId = await seedScholarInInstitution(t, {
      institutionId,
      username: "peer-quick-facts",
    });
    await t.run((ctx) =>
      ctx.db.insert("factFluency", {
        scholarId: peerId,
        factKey: "add:2+2",
        skillKey: "add_within_10",
        domain: "whole-number-arithmetic",
        seenCount: 12,
        correctCount: 12,
        latencySamplesMs: [100, 120, 140],
        latencyMedianMs: 120,
        lastSeenAt: Date.now(),
      }),
    );
    const asScholar = await withUser(t, scholarId);

    const [round, status] = await Promise.all([
      asScholar.query(api.practiceSkills.startQuickFactsPractice, {
        scholarId,
        seed: 7,
      }),
      asScholar.query(api.calculatorLicenses.myLicenseStatus, {}),
    ]);

    expect(round).toMatchObject({
      available: true,
      unavailableReason: null,
    });
    expect(round.items).toHaveLength(5);
    expect(status).toMatchObject({
      state: "building",
      license: null,
      fastMath: {
        calibration: "uncalibrated",
        baselineKnown: false,
        automaticCount: 0,
        denominator: fastMathDenominator(),
        percent: 0,
        ready: false,
      },
    });
    // The one-card query has no peer rows, teacher-only slices, or latency data.
    expect(status).not.toHaveProperty("scholars");
    expect(status?.fastMath).not.toHaveProperty("byOperation");
    expect(status?.fastMath).not.toHaveProperty("byFamily");
    expect(status?.fastMath).not.toHaveProperty("latencyMedianMs");
  });

  test("keeps a known-baseline zero distinct from an uncalibrated zero", async () => {
    const t = convexTest(schema, modules);
    const institutionId = await seedTestInstitution(t, { slug: "quick-facts-c" });
    const scholarId = await seedScholarInInstitution(t, {
      institutionId,
      username: "known-zero-quick-facts",
    });
    await t.run(async (ctx) => {
      for (const skillKey of [
        "add_within_10",
        "subtract_within_10",
        "mult_facts_3_4_6",
      ]) {
        await ctx.db.insert("practiceMastery", {
          scholarId,
          skillKey,
          domain: "whole-number-arithmetic",
          repetition: 1,
          halfLifeDays: 1,
          frontier: true,
          source: "practice",
          latencyMedianMs: 4000,
          updatedAt: Date.now(),
        });
      }
    });

    const status = await (await withUser(t, scholarId)).query(
      api.calculatorLicenses.myLicenseStatus,
      {},
    );

    expect(status).toMatchObject({
      fastMath: {
        calibration: "known",
        baselineKnown: true,
        automaticCount: 0,
        percent: 0,
        ready: false,
      },
    });
  });

  test("denies a teacher from another institution", async () => {
    const t = convexTest(schema, modules);
    const ownInstitution = await seedTestInstitution(t, { slug: "quick-facts-own" });
    const otherInstitution = await seedTestInstitution(t, {
      slug: "quick-facts-other",
    });
    const teacherId = await seedTeacher(
      t,
      ownInstitution,
      "quick-facts-own-teacher",
    );
    const otherScholarId = await seedScholarInInstitution(t, {
      institutionId: otherInstitution,
      username: "quick-facts-other-scholar",
    });

    await expect(
      (await withUser(t, teacherId)).query(
        api.practiceSkills.startQuickFactsPractice,
        { scholarId: otherScholarId, seed: 11 },
      ),
    ).rejects.toThrow();
  });
});
