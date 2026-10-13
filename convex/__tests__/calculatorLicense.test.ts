/**
 * Fast Math readiness (cohortPractice.fastMathForScholars) + the Calculator
 * License grant/revoke gates.
 *
 * What this pins, in order of consequence:
 *   1. The INSTITUTION boundary — a teacher never reads or writes a scholar
 *      outside their own school, on both the query and both mutations.
 *   2. The GRANT is entirely TEACHER DISCRETION — no score input, no
 *      threshold, no server-side numeric validation. Automaticity remains
 *      diagnostic context only.
 *   3. The CORRECTION rule — an existing license can be re-recorded because
 *      the credential is durable.
 */

import { convexTest } from "convex-test";
import type { TestConvex } from "convex-test";
import { describe, expect, test, vi } from "vitest";
import schema from "../schema";
import {
  grantInstitutionMembership,
  seedScholarInInstitution,
  seedTestInstitution,
} from "./institutionTestHelpers";
import { api, internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { formatLicenseExpiry, validateLicenseExpiry } from "../calculatorLicenses";
import { WHOLE_NUMBER_ARITHMETIC_DOMAIN } from "../seed/wholeNumberArithmeticGraph";
import { fastMathFactKeys } from "../lib/practice/fastMath";
import { FACT_FAMILY_SKILLS } from "../../shared/factKey";

// A grant no longer schedules AI badge art (the license badge's image is the
// card itself), but nothing scheduled from here may ever reach a real image
// endpoint if a path regressed — so the image modules stay mocked with their
// real failure sentinel (`null`), and the print test asserts they are never
// called.
vi.mock("../lib/openaiImage", () => ({ openaiGenerateImage: vi.fn(async () => null) }));
vi.mock("../lib/gemini", () => ({ geminiGenerateImage: vi.fn(async () => null) }));

// Pre-load the "use node" modules the scheduled chain reaches, so the pump
// budget is spent on the scheduled work rather than a cold module import —
// see rabbithole-testing.md → "finishAllScheduledFunctions has a real-time
// budget" (the onboarding.test.ts scar).
import "../badgeArtActions";
import "../badges";

const modules = (
  import.meta as ImportMeta & {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("../**/*.ts");

type TC = TestConvex<typeof schema>;

async function withUser(t: TC, userId: Id<"users">) {
  const sessionId = await t.run(async (ctx) =>
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

async function seedTeacher(t: TC, institutionId: Id<"institutions">, username: string) {
  const userId = await t.run(async (ctx) =>
    ctx.db.insert("users", { name: `Teacher ${username}`, username, role: "teacher" }),
  );
  await grantInstitutionMembership(t, userId, institutionId);
  return userId;
}

/**
 * Give the scholar a latency baseline (from `practiceMastery` medians) and,
 * optionally, an all-automatic fact ledger across the ENTIRE canonical space —
 * the only shape that reaches 100%.
 */
async function seedFactLedger(
  t: TC,
  scholarId: Id<"users">,
) {
  await t.run(async (ctx) => {
    // Baseline = median of per-skill medians ⇒ 4000ms.
    for (const skillKey of ["add_within_10", "subtract_within_10", "mult_facts_3_4_6"]) {
      await ctx.db.insert("practiceMastery", {
        scholarId,
        skillKey,
        domain: WHOLE_NUMBER_ARITHMETIC_DOMAIN,
        repetition: 4,
        halfLifeDays: 10,
        frontier: false,
        source: "practice",
        latencyMedianMs: 4000,
        updatedAt: Date.now(),
      });
    }
    const keys = fastMathFactKeys();
    for (const factKey of keys) {
      await ctx.db.insert("factFluency", {
        scholarId,
        factKey,
        skillKey: "add_within_10",
        domain: WHOLE_NUMBER_ARITHMETIC_DOMAIN,
        seenCount: 12,
        correctCount: 12,
        latencySamplesMs: [700, 720, 740],
        latencyMedianMs: 720,
        lastSeenAt: Date.now(),
      });
    }
  });
}

describe("cohortPractice.fastMathForScholars", () => {
  test("reports the canonical fraction, and 0% for an untouched scholar", async () => {
    const t = convexTest(schema, modules);
    const institutionId = await seedTestInstitution(t, { slug: "school-a" });
    const teacher = await seedTeacher(t, institutionId, "teacher-a");
    const ready = await seedScholarInInstitution(t, {
      institutionId,
      username: "ready-scholar",
    });
    const fresh = await seedScholarInInstitution(t, {
      institutionId,
      username: "fresh-scholar",
    });
    await seedFactLedger(t, ready);

    const asTeacher = await withUser(t, teacher);
    const res = await asTeacher.query(api.cohortPractice.fastMathForScholars, {
      scholarIds: [ready, fresh],
    });

    const byId = new Map(res.scholars.map((s) => [String(s.scholarId), s]));
    expect(byId.get(String(ready))).toMatchObject({
      percent: 100,
      ready: true,
      denominator: fastMathFactKeys().length,
      automaticCount: fastMathFactKeys().length,
      license: null,
    });
    expect(byId.get(String(fresh))).toMatchObject({
      percent: 0,
      ready: false,
      baselineKnown: false,
    });
  });

  test("filters out a scholar from another institution", async () => {
    const t = convexTest(schema, modules);
    const mine = await seedTestInstitution(t, { slug: "school-a" });
    const theirs = await seedTestInstitution(t, { slug: "school-b" });
    const teacher = await seedTeacher(t, mine, "teacher-a");
    const ownScholar = await seedScholarInInstitution(t, {
      institutionId: mine,
      username: "own-scholar",
    });
    const otherScholar = await seedScholarInInstitution(t, {
      institutionId: theirs,
      username: "other-scholar",
    });

    const asTeacher = await withUser(t, teacher);
    const res = await asTeacher.query(api.cohortPractice.fastMathForScholars, {
      scholarIds: [ownScholar, otherScholar],
    });
    expect(res.scholars.map((s) => String(s.scholarId))).toEqual([
      String(ownScholar),
    ]);
  });

  test("refuses an unauthenticated reader", async () => {
    const t = convexTest(schema, modules);
    const institutionId = await seedTestInstitution(t, { slug: "school-a" });
    const scholarId = await seedScholarInInstitution(t, {
      institutionId,
      username: "some-scholar",
    });
    await expect(
      t.query(api.cohortPractice.fastMathForScholars, { scholarIds: [scholarId] }),
    ).rejects.toThrow();
  });
});

describe("calculatorLicenses.grantCalculatorLicense", () => {
  test("shows scholars only building or ready, never the diagnostic percentage", async () => {
    const t = convexTest(schema, modules);
    const institutionId = await seedTestInstitution(t, { slug: "school-a" });
    const building = await seedScholarInInstitution(t, {
      institutionId,
      username: "building-scholar",
    });
    const ready = await seedScholarInInstitution(t, {
      institutionId,
      username: "ready-scholar",
    });
    await seedFactLedger(t, ready);

    const buildingStatus = await (await withUser(t, building)).query(
      api.calculatorLicenses.myLicenseStatus,
      {},
    );
    const readyStatus = await (await withUser(t, ready)).query(
      api.calculatorLicenses.myLicenseStatus,
      {},
    );

    expect(buildingStatus).toMatchObject({ state: "building", license: null });
    expect(readyStatus).toMatchObject({ state: "ready", license: null });
    expect(buildingStatus?.fastMath.facts).toHaveLength(418);
    expect(
      buildingStatus?.fastMath.facts.every((fact) => fact.state === "unseen"),
    ).toBe(true);
    expect(readyStatus?.fastMath.facts).toHaveLength(418);
    expect(
      readyStatus?.fastMath.facts.every((fact) => fact.state === "automatic"),
    ).toBe(true);
    expect(buildingStatus).not.toHaveProperty("percent");
    expect(buildingStatus).not.toHaveProperty("automaticCount");
    expect(readyStatus).not.toHaveProperty("denominator");
  });

  test("family-level fluency is not readiness, but a teacher can grant regardless", async () => {
    // The rejected cheaper denominator ("fluent-or-better families / 11") would
    // read this scholar as 100%: every fact family is fluent (repetition ≥
    // FLUENT_REPS), one of them by PLACEMENT rather than practice. They have
    // actually made 30 of 418 facts automatic. Pinned because the whole point
    // of the canonical denominator is that this scholar is not ready — and
    // that a teacher may still grant the license at their own discretion
    // regardless of readiness.
    const t = convexTest(schema, modules);
    const institutionId = await seedTestInstitution(t, { slug: "school-a" });
    const teacher = await seedTeacher(t, institutionId, "teacher-a");
    const scholarId = await seedScholarInInstitution(t, {
      institutionId,
      username: "family-fluent-scholar",
    });

    await t.run(async (ctx) => {
      for (const skillKey of FACT_FAMILY_SKILLS) {
        await ctx.db.insert("practiceMastery", {
          scholarId,
          skillKey,
          domain: WHOLE_NUMBER_ARITHMETIC_DOMAIN,
          repetition: 5,
          halfLifeDays: 12,
          frontier: false,
          source: skillKey === "mult_facts_7_8_9" ? "placement" : "practice",
          latencyMedianMs: 4000,
          updatedAt: Date.now(),
        });
      }
      for (const factKey of fastMathFactKeys().slice(0, 30)) {
        await ctx.db.insert("factFluency", {
          scholarId,
          factKey,
          skillKey: "add_within_10",
          domain: WHOLE_NUMBER_ARITHMETIC_DOMAIN,
          seenCount: 12,
          correctCount: 12,
          latencySamplesMs: [700, 720, 740],
          latencyMedianMs: 720,
          lastSeenAt: Date.now(),
        });
      }
    });

    const asTeacher = await withUser(t, teacher);
    const res = await asTeacher.query(api.cohortPractice.fastMathForScholars, {
      scholarIds: [scholarId],
    });
    expect(res.scholars[0].automaticCount).toBe(30);
    expect(res.scholars[0].ready).toBe(false);
    expect(res.scholars[0].percent).toBe(7);

    const granted = await asTeacher.mutation(
      api.calculatorLicenses.grantCalculatorLicense,
      { expiresOn: "2099-01-15", scholarId },
    );
    expect(granted.corrected).toBe(false);
  });

  test("grants a license at teacher discretion, and the reading then reports it", async () => {
    const t = convexTest(schema, modules);
    const institutionId = await seedTestInstitution(t, { slug: "school-a" });
    const teacher = await seedTeacher(t, institutionId, "teacher-a");
    const scholarId = await seedScholarInInstitution(t, {
      institutionId,
      username: "ready-scholar",
    });
    await seedFactLedger(t, scholarId);

    const asTeacher = await withUser(t, teacher);
    const granted = await asTeacher.mutation(
      api.calculatorLicenses.grantCalculatorLicense,
      { expiresOn: "2099-01-15", scholarId },
    );
    expect(granted.corrected).toBe(false);

    const { licenseRow, badgeRow } = await t.run(async (ctx) => {
      const licenseRow = await ctx.db
        .query("calculatorLicenses")
        .withIndex("by_scholar", (q) => q.eq("scholarId", scholarId))
        .unique();
      const badgeRow = licenseRow?.badgeId
        ? await ctx.db.get(licenseRow.badgeId)
        : null;
      return { licenseRow, badgeRow };
    });
    expect(licenseRow?.badgeId).toBeDefined();
    expect(licenseRow).not.toHaveProperty("score");
    expect(badgeRow).toMatchObject({
      scholarId,
      kind: "calculator_license",
      artStatus: "generating",
      badgeSnapshot: {
        title: "Calculator license",
        icon: "🧮",
      },
    });

    const res = await asTeacher.query(api.cohortPractice.fastMathForScholars, {
      scholarIds: [scholarId],
    });
    expect(res.scholars[0].license).toMatchObject({
      issuedByName: "Teacher teacher-a",
    });
    expect(res.scholars[0].license).not.toHaveProperty("score");
    expect(res.scholars[0].license?.issuedAt).toBeGreaterThan(0);

    const ownStatus = await (await withUser(t, scholarId)).query(
      api.calculatorLicenses.myLicenseStatus,
      {},
    );
    expect(ownStatus).toMatchObject({
      state: "licensed",
      license: {
        issuedByName: "Teacher teacher-a",
        badge: {
          artStatus: "generating",
          icon: "🧮",
        },
      },
    });
    expect(ownStatus).not.toHaveProperty("percent");
    expect((ownStatus as { license?: object }).license).not.toHaveProperty(
      "score",
    );
  });

  test("grants a license with no in-app Fast Math history", async () => {
    const t = convexTest(schema, modules);
    const institutionId = await seedTestInstitution(t, { slug: "school-a" });
    const teacher = await seedTeacher(t, institutionId, "teacher-a");
    const scholarId = await seedScholarInInstitution(t, {
      institutionId,
      username: "unmeasured-scholar",
    });

    const asTeacher = await withUser(t, teacher);
    const granted = await asTeacher.mutation(
      api.calculatorLicenses.grantCalculatorLicense,
      { expiresOn: "2099-01-15", scholarId },
    );
    expect(granted.corrected).toBe(false);
    const res = await asTeacher.query(api.cohortPractice.fastMathForScholars, {
      scholarIds: [scholarId],
    });
    expect(res.scholars[0]).toMatchObject({
      percent: 0,
      ready: false,
      baselineKnown: false,
    });
    expect(res.scholars[0].license).not.toHaveProperty("score");
  });

  test("refuses a scholar in another institution", async () => {
    const t = convexTest(schema, modules);
    const mine = await seedTestInstitution(t, { slug: "school-a" });
    const theirs = await seedTestInstitution(t, { slug: "school-b" });
    const teacher = await seedTeacher(t, mine, "teacher-a");
    const otherScholar = await seedScholarInInstitution(t, {
      institutionId: theirs,
      username: "other-scholar",
    });
    await seedFactLedger(t, otherScholar);

    const asTeacher = await withUser(t, teacher);
    await expect(
      asTeacher.mutation(api.calculatorLicenses.grantCalculatorLicense, { expiresOn: "2099-01-15",
        scholarId: otherScholar,
      }),
    ).rejects.toThrow();
  });

  test("corrects an existing license even after readiness has decayed", async () => {
    const t = convexTest(schema, modules);
    const institutionId = await seedTestInstitution(t, { slug: "school-a" });
    const teacher = await seedTeacher(t, institutionId, "teacher-a");
    const scholarId = await seedScholarInInstitution(t, {
      institutionId,
      username: "ready-scholar",
    });
    await seedFactLedger(t, scholarId);
    const asTeacher = await withUser(t, teacher);
    await asTeacher.mutation(api.calculatorLicenses.grantCalculatorLicense, { expiresOn: "2099-01-15",
      scholarId,
    });

    // Readiness decays: wipe the ledger entirely.
    await t.run(async (ctx) => {
      const rows = await ctx.db
        .query("factFluency")
        .withIndex("by_scholar", (q) => q.eq("scholarId", scholarId))
        .collect();
      for (const row of rows) await ctx.db.delete(row._id);
    });

    const corrected = await asTeacher.mutation(
      api.calculatorLicenses.grantCalculatorLicense,
      { expiresOn: "2099-01-15", scholarId },
    );
    expect(corrected.corrected).toBe(true);

    const res = await asTeacher.query(api.cohortPractice.fastMathForScholars, {
      scholarIds: [scholarId],
    });
    expect(res.scholars[0].ready).toBe(false);
    expect(res.scholars[0].license).not.toHaveProperty("score");
    const rowCount = await t.run(async (ctx) =>
      (await ctx.db.query("calculatorLicenses").collect()).length,
    );
    expect(rowCount).toBe(1);
  });
});

describe("calculatorLicenses.revokeCalculatorLicense", () => {
  test("removes a license granted in error, and no-ops when there is none", async () => {
    const t = convexTest(schema, modules);
    const institutionId = await seedTestInstitution(t, { slug: "school-a" });
    const teacher = await seedTeacher(t, institutionId, "teacher-a");
    const scholarId = await seedScholarInInstitution(t, {
      institutionId,
      username: "ready-scholar",
    });
    await seedFactLedger(t, scholarId);
    const asTeacher = await withUser(t, teacher);
    await asTeacher.mutation(api.calculatorLicenses.grantCalculatorLicense, { expiresOn: "2099-01-15",
      scholarId,
    });
    const badgeId = await t.run(async (ctx) => {
      const license = await ctx.db
        .query("calculatorLicenses")
        .withIndex("by_scholar", (q) => q.eq("scholarId", scholarId))
        .unique();
      return license?.badgeId ?? null;
    });
    expect(badgeId).not.toBeNull();

    expect(
      await asTeacher.mutation(api.calculatorLicenses.revokeCalculatorLicense, {
        scholarId,
      }),
    ).toEqual({ removed: true });
    expect(
      await asTeacher.mutation(api.calculatorLicenses.revokeCalculatorLicense, {
        scholarId,
      }),
    ).toEqual({ removed: false });

    const res = await asTeacher.query(api.cohortPractice.fastMathForScholars, {
      scholarIds: [scholarId],
    });
    expect(res.scholars[0].license).toBeNull();
    if (badgeId) {
      expect(await t.run(async (ctx) => ctx.db.get(badgeId))).toBeNull();
    }
  });

  test("refuses a scholar in another institution", async () => {
    const t = convexTest(schema, modules);
    const mine = await seedTestInstitution(t, { slug: "school-a" });
    const theirs = await seedTestInstitution(t, { slug: "school-b" });
    const teacher = await seedTeacher(t, mine, "teacher-a");
    const otherScholar = await seedScholarInInstitution(t, {
      institutionId: theirs,
      username: "other-scholar",
    });
    const asTeacher = await withUser(t, teacher);
    await expect(
      asTeacher.mutation(api.calculatorLicenses.revokeCalculatorLicense, {
        scholarId: otherScholar,
      }),
    ).rejects.toThrow();
  });
});

/**
 * The bot path (Slack, in-app assistant, MCP): the same shared grant/revoke
 * helpers as the UI, behind an internal mutation that takes an explicit
 * callerUserId. Pins the role gate, the institution boundary, and the
 * already-licensed guard that keeps a bot from silently reprinting a card.
 */
describe("calculator license expiration", () => {
  test("validateLicenseExpiry requires a real date after the school's today", () => {
    // 2026-10-12 23:30 in Honolulu is already 10-13 in UTC: "today" is the
    // school's calendar day, so 10-13 is still a valid (future) expiry.
    const now = Date.UTC(2026, 9, 13, 9, 30);
    expect(validateLicenseExpiry("2026-10-13", now, "Pacific/Honolulu")).toBe("2026-10-13");
    expect(() => validateLicenseExpiry("2026-10-12", now, "Pacific/Honolulu")).toThrow(/after today/);
    expect(() => validateLicenseExpiry("2027-02-30", now, "Pacific/Honolulu")).toThrow(/calendar date/);
    expect(() => validateLicenseExpiry("1/15/2027", now, "Pacific/Honolulu")).toThrow(/calendar date/);
    expect(formatLicenseExpiry("2027-01-15")).toBe("Jan 15, 2027");
  });

  test("amendLicenseTerms sets the expiry and proctor without re-issuing", async () => {
    const t = convexTest(schema, modules);
    const institutionId = await seedTestInstitution(t, { slug: "school-a" });
    const teacher = await seedTeacher(t, institutionId, "teacher-a");
    const proctor = await seedTeacher(t, institutionId, "teacher-b");
    const outsider = await seedTeacher(
      t,
      await seedTestInstitution(t, { slug: "school-b" }),
      "teacher-c",
    );
    const scholarId = await seedScholarInInstitution(t, { institutionId, username: "kai" });
    // A license from before expiry existed.
    const licenseId = await t.run((ctx) =>
      ctx.db.insert("calculatorLicenses", { scholarId, issuedAt: 1_000, issuedBy: teacher }),
    );

    await expect(
      t.mutation(internal.calculatorLicenses.amendLicenseTerms, { scholarId, issuedBy: outsider }),
    ).rejects.toThrow(/Forbidden/);
    await expect(
      t.mutation(internal.calculatorLicenses.amendLicenseTerms, { scholarId, expiresOn: "2001-01-01" }),
    ).rejects.toThrow(/after today/);

    expect(
      await t.mutation(internal.calculatorLicenses.amendLicenseTerms, {
        scholarId,
        expiresOn: "2099-01-15",
        issuedBy: proctor,
      }),
    ).toEqual({ amended: true, reprinted: false });
    const row = await t.run((ctx) => ctx.db.get(licenseId));
    expect(row).toMatchObject({ issuedAt: 1_000, issuedBy: proctor, expiresOn: "2099-01-15" });
  });
});

describe("calculatorLicenses bot path (grantForCaller / revokeForCaller)", () => {
  async function licenseRows(t: TC, scholarId: Id<"users">) {
    return await t.run((ctx) =>
      ctx.db
        .query("calculatorLicenses")
        .withIndex("by_scholar", (q) => q.eq("scholarId", scholarId))
        .collect(),
    );
  }

  test("grants, refuses a silent re-grant, re-records only on rerecord, then revokes", async () => {
    const t = convexTest(schema, modules);
    const institutionId = await seedTestInstitution(t, { slug: "school-a" });
    const teacher = await seedTeacher(t, institutionId, "teacher-a");
    const scholarId = await seedScholarInInstitution(t, {
      institutionId,
      name: "Kai Nakamura",
      username: "kai",
    });

    // No expiration date yet: nothing is granted; the bot is told to ask.
    expect(
      await t.mutation(internal.calculatorLicenses.grantForCaller, {
        callerUserId: teacher,
        scholarId,
      }),
    ).toEqual({ status: "needs_expiry", scholarName: "Kai Nakamura" });
    expect(await licenseRows(t, scholarId)).toHaveLength(0);

    const granted = await t.mutation(internal.calculatorLicenses.grantForCaller, {
      callerUserId: teacher,
      scholarId,
      expiresOn: "2099-01-15",
    });
    expect(granted).toMatchObject({
      status: "granted",
      expiresOn: "Jan 15, 2099",
      scholarName: "Kai Nakamura",
      issuedByName: "Teacher teacher-a",
      printsCard: false, // non-primary institution: no card
    });
    const [first] = await licenseRows(t, scholarId);
    expect(first.issuedBy).toBe(teacher);
    expect(first.badgeId).toBeDefined();
    const scheduledAfterGrant = await t.run(
      async (ctx) =>
        (await ctx.db.system.query("_scheduled_functions").collect()).length,
    );

    // A second ask without rerecord changes nothing and schedules nothing.
    const again = await t.mutation(internal.calculatorLicenses.grantForCaller, {
      callerUserId: teacher,
      scholarId,
    });
    expect(again).toMatchObject({
      status: "already_licensed",
      scholarName: "Kai Nakamura",
      issuedByName: "Teacher teacher-a",
      expiresOn: "Jan 15, 2099",
    });
    const [unchanged] = await licenseRows(t, scholarId);
    expect(unchanged.issuedAt).toBe(first.issuedAt);
    expect(
      await t.run(
        async (ctx) =>
          (await ctx.db.system.query("_scheduled_functions").collect()).length,
      ),
    ).toBe(scheduledAfterGrant);

    // The teacher confirmed: rerecord goes through the shared correction path.
    const rerecorded = await t.mutation(
      internal.calculatorLicenses.grantForCaller,
      { callerUserId: teacher, scholarId, rerecord: true, expiresOn: "2099-06-30" },
    );
    expect(rerecorded.status).toBe("rerecorded");
    const rerecordedRows = await licenseRows(t, scholarId);
    expect(rerecordedRows).toHaveLength(1);
    expect(rerecordedRows[0].expiresOn).toBe("2099-06-30");

    expect(
      await t.mutation(internal.calculatorLicenses.revokeForCaller, {
        callerUserId: teacher,
        scholarId,
      }),
    ).toEqual({ removed: true });
    expect(await licenseRows(t, scholarId)).toHaveLength(0);
    expect(
      await t.mutation(internal.calculatorLicenses.revokeForCaller, {
        callerUserId: teacher,
        scholarId,
      }),
    ).toEqual({ removed: false });
  });

  test("refuses a non-teacher caller on both grant and revoke", async () => {
    const t = convexTest(schema, modules);
    const institutionId = await seedTestInstitution(t, { slug: "school-a" });
    const scholarId = await seedScholarInInstitution(t, {
      institutionId,
      username: "kai",
    });
    const otherScholar = await seedScholarInInstitution(t, {
      institutionId,
      username: "peer",
    });
    const designer = await t.run((ctx) =>
      ctx.db.insert("users", {
        name: "Designer",
        username: "designer",
        role: "curriculum_designer",
      }),
    );
    await grantInstitutionMembership(t, designer, institutionId);

    for (const callerUserId of [otherScholar, designer]) {
      await expect(
        t.mutation(internal.calculatorLicenses.grantForCaller, {
          callerUserId,
          scholarId,
        }),
      ).rejects.toThrow(/teacher or admin/);
      await expect(
        t.mutation(internal.calculatorLicenses.revokeForCaller, {
          callerUserId,
          scholarId,
        }),
      ).rejects.toThrow(/teacher or admin/);
    }
    expect(await licenseRows(t, scholarId)).toHaveLength(0);
  });

  test("refuses a scholar in another institution", async () => {
    const t = convexTest(schema, modules);
    const mine = await seedTestInstitution(t, { slug: "school-a" });
    const theirs = await seedTestInstitution(t, { slug: "school-b" });
    const teacher = await seedTeacher(t, mine, "teacher-a");
    const otherScholar = await seedScholarInInstitution(t, {
      institutionId: theirs,
      username: "other-scholar",
    });
    await expect(
      t.mutation(internal.calculatorLicenses.grantForCaller, {
        callerUserId: teacher,
        scholarId: otherScholar,
      }),
    ).rejects.toThrow(/Forbidden/);
    await expect(
      t.mutation(internal.calculatorLicenses.revokeForCaller, {
        callerUserId: teacher,
        scholarId: otherScholar,
      }),
    ).rejects.toThrow(/Forbidden/);
    expect(await licenseRows(t, otherScholar)).toHaveLength(0);
  });
});

