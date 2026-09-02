/**
 * keyMoments.forScholarDay — the by-scholar-and-day Key Moments read that
 * feeds the Special Delivery daily letter. Covers institution-timezone day
 * filtering, superseded / test-drive exclusion, score ordering, the
 * auth/tenant boundary, and the print-safety redaction boundary (scholar
 * verbatim vs. observer analysis land in separate fields, and a SELF read
 * omits `observerAnalysis` entirely — it is teacher-facing analysis of the
 * scholar, never returned to the scholar it's about).
 *
 * Fixtures follow rabbithole-testing.md; institution/access fixtures reuse
 * institutionTestHelpers.
 */
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "../schema";
import { api } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { dayKeyForTimezone, shiftDayKey } from "../../shared/institutionDay";
import {
  seedTestInstitution,
  seedScholarInInstitution,
  seedStaffWithMembership,
  grantStaffAccessToScholars,
} from "./institutionTestHelpers";

const modules = (
  import.meta as ImportMeta & {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("../**/*.ts");

const NY_TZ = "America/New_York"; // UTC-5 in January (no DST ambiguity)

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

async function seedInstitutionWithTz(
  t: ReturnType<typeof convexTest>,
  timeZone: string,
  opts: { slug?: string } = {},
) {
  const institutionId = await seedTestInstitution(t, {
    slug: opts.slug ?? "tz-school",
  });
  await t.run((ctx) => ctx.db.patch(institutionId, { timeZone }));
  return institutionId;
}

async function seedSession(
  t: ReturnType<typeof convexTest>,
  scholarId: Id<"users">,
  isTestDrive = false,
) {
  return await t.run((ctx) =>
    ctx.db.insert("sessions", {
      userId: scholarId,
      title: "S",
      isArchived: false,
      ...(isTestDrive ? { isTestDrive: true } : {}),
    }),
  );
}

async function seedMastery(
  t: ReturnType<typeof convexTest>,
  args: {
    scholarId: Id<"users">;
    sessionId?: Id<"sessions">;
    observedAt: number;
    evidenceType?: string;
    masteryLevel?: number;
    isSuperseded?: boolean;
    transcriptExcerpt?: string;
    evidenceSummary?: string;
  },
) {
  return await t.run((ctx) =>
    ctx.db.insert("masteryObservations", {
      scholarId: args.scholarId,
      conceptLabel: "Gravity",
      domain: "Physics",
      observedAt: args.observedAt,
      sessionId: args.sessionId,
      transcriptExcerpt: args.transcriptExcerpt ?? "heavy falls faster",
      masteryLevel: args.masteryLevel ?? 1,
      confidenceScore: 0.9,
      evidenceSummary: args.evidenceSummary ?? "Observer analysis of gravity.",
      evidenceType: args.evidenceType ?? "direct_demonstration",
      attemptContext: "conversation",
      studentInitiated: false,
      isSuperseded: args.isSuperseded ?? false,
    }),
  );
}

describe("keyMoments.forScholarDay — day filtering", () => {
  test("a row belongs to the day in the scholar's INSTITUTION timezone, not UTC", async () => {
    const t = convexTest(schema, modules);
    const institutionId = await seedInstitutionWithTz(t, NY_TZ);
    const scholar = await seedScholarInInstitution(t, { institutionId });

    // 2026-01-15T02:00Z is 2026-01-14 21:00 in New York → day 2026-01-14.
    // Under UTC it would be 2026-01-15, so querying "2026-01-14" proves the
    // read uses the institution timezone.
    const nyDay = Date.UTC(2026, 0, 15, 2, 0, 0);
    // 2026-01-15T20:00Z is 2026-01-15 15:00 in New York → day 2026-01-15.
    const nextDay = Date.UTC(2026, 0, 15, 20, 0, 0);

    const onDayId = await seedMastery(t, {
      scholarId: scholar,
      observedAt: nyDay,
    });
    await seedMastery(t, { scholarId: scholar, observedAt: nextDay });

    const asScholar = await withUser(t, scholar);
    const moments = await asScholar.query(api.keyMoments.forScholarDay, {
      scholarId: scholar,
      dayKey: "2026-01-14",
    });

    expect(moments.length).toBe(1);
    expect(moments[0].sourceId).toBe(onDayId);
  });

  test("mastery: an OLD record from a prior day is not collected on the target day, even with a full history of rows (by_scholar_observedAt is index-scoped, not a lifetime scan)", async () => {
    const t = convexTest(schema, modules);
    const institutionId = await seedInstitutionWithTz(t, NY_TZ);
    const scholar = await seedScholarInInstitution(t, { institutionId });

    // Many rows spread across many OLD days — the target-day read must find
    // exactly the one on-day row, proving the query ranges on `observedAt`
    // via the by_scholar_observedAt index rather than scanning every row the
    // scholar has ever had.
    for (let daysAgo = 30; daysAgo >= 2; daysAgo -= 1) {
      await seedMastery(t, {
        scholarId: scholar,
        observedAt: Date.UTC(2026, 0, 14, 18, 0, 0) - daysAgo * 24 * 60 * 60 * 1000,
        evidenceSummary: `old row ${daysAgo}d ago`,
      });
    }
    const targetId = await seedMastery(t, {
      scholarId: scholar,
      observedAt: Date.UTC(2026, 0, 14, 18, 0, 0),
      evidenceSummary: "on target day",
    });

    const asScholar = await withUser(t, scholar);
    const moments = await asScholar.query(api.keyMoments.forScholarDay, {
      scholarId: scholar,
      dayKey: "2026-01-14",
    });

    expect(moments.length).toBe(1);
    expect(moments[0].sourceId).toBe(targetId);
  });

  test("signals/connections filter on _creationTime in the institution day", async () => {
    const t = convexTest(schema, modules);
    const institutionId = await seedInstitutionWithTz(t, NY_TZ);
    const scholar = await seedScholarInInstitution(t, { institutionId });
    const session = await seedSession(t, scholar);

    await t.run(async (ctx) => {
      await ctx.db.insert("sessionSignals", {
        scholarId: scholar,
        sessionId: session,
        signalType: "creative_approach",
        description: "Observer note about a creative approach.",
        intensity: "high",
        transcriptExcerpt: "What if we tilt the ramp?",
      });
      await ctx.db.insert("crossDomainConnections", {
        scholarId: scholar,
        domains: ["Physics", "Art"],
        conceptLabels: ["Symmetry", "Balance"],
        description: "Observer note bridging physics and art.",
        sessionId: session,
        studentInitiated: true,
        transcriptExcerpt: "This looks like the mobile we made.",
      });
    });

    const asScholar = await withUser(t, scholar);
    const todayKey = dayKeyForTimezone(Date.now(), NY_TZ);
    const yesterdayKey = shiftDayKey(todayKey, -1);

    const today = await asScholar.query(api.keyMoments.forScholarDay, {
      scholarId: scholar,
      dayKey: todayKey,
    });
    expect(today.map((m) => m.source).sort()).toEqual(["connection", "signal"]);

    const yesterday = await asScholar.query(api.keyMoments.forScholarDay, {
      scholarId: scholar,
      dayKey: yesterdayKey,
    });
    expect(yesterday.length).toBe(0);
  });
});

describe("keyMoments.forScholarDay — exclusions and ordering", () => {
  test("excludes superseded mastery rows and test-drive sessions", async () => {
    const t = convexTest(schema, modules);
    const institutionId = await seedInstitutionWithTz(t, NY_TZ);
    const scholar = await seedScholarInInstitution(t, { institutionId });
    const realSession = await seedSession(t, scholar);
    const driveSession = await seedSession(t, scholar, true);
    const observedAt = Date.UTC(2026, 0, 14, 18, 0, 0); // 13:00 NY → 2026-01-14

    const keptId = await seedMastery(t, {
      scholarId: scholar,
      sessionId: realSession,
      observedAt,
      evidenceSummary: "kept",
    });
    // Superseded → excluded.
    await seedMastery(t, {
      scholarId: scholar,
      sessionId: realSession,
      observedAt,
      isSuperseded: true,
      evidenceSummary: "superseded",
    });
    // On a test-drive session → excluded.
    await seedMastery(t, {
      scholarId: scholar,
      sessionId: driveSession,
      observedAt,
      evidenceSummary: "test drive mastery",
    });
    // A signal on the test-drive session → excluded.
    await t.run((ctx) =>
      ctx.db.insert("sessionSignals", {
        scholarId: scholar,
        sessionId: driveSession,
        signalType: "metacognition",
        description: "test drive signal",
        intensity: "high",
      }),
    );

    const asScholar = await withUser(t, scholar);
    const moments = await asScholar.query(api.keyMoments.forScholarDay, {
      scholarId: scholar,
      dayKey: "2026-01-14",
    });

    expect(moments.length).toBe(1);
    expect(moments[0].sourceId).toBe(keptId);
  });

  test("sorts by interestingness score, descending", async () => {
    const t = convexTest(schema, modules);
    const institutionId = await seedInstitutionWithTz(t, NY_TZ);
    const scholar = await seedScholarInInstitution(t, { institutionId });
    const session = await seedSession(t, scholar);
    const observedAt = Date.UTC(2026, 0, 14, 18, 0, 0);

    // A misconception scores higher than a shallow mastery moment.
    await seedMastery(t, {
      scholarId: scholar,
      sessionId: session,
      observedAt,
      evidenceType: "direct_demonstration",
      masteryLevel: 1,
    });
    await seedMastery(t, {
      scholarId: scholar,
      sessionId: session,
      observedAt,
      evidenceType: "misconception_signal",
      masteryLevel: 1,
    });

    const asScholar = await withUser(t, scholar);
    const moments = await asScholar.query(api.keyMoments.forScholarDay, {
      scholarId: scholar,
      dayKey: "2026-01-14",
    });

    expect(moments.length).toBe(2);
    expect(moments[0].kind).toBe("misconception");
    expect(moments[0].score).toBeGreaterThan(moments[1].score);
  });

  test("caps at the limit", async () => {
    const t = convexTest(schema, modules);
    const institutionId = await seedInstitutionWithTz(t, NY_TZ);
    const scholar = await seedScholarInInstitution(t, { institutionId });
    const session = await seedSession(t, scholar);
    const observedAt = Date.UTC(2026, 0, 14, 18, 0, 0);
    for (let i = 0; i < 5; i++) {
      await seedMastery(t, { scholarId: scholar, sessionId: session, observedAt });
    }

    const asScholar = await withUser(t, scholar);
    const moments = await asScholar.query(api.keyMoments.forScholarDay, {
      scholarId: scholar,
      dayKey: "2026-01-14",
      limit: 2,
    });
    expect(moments.length).toBe(2);
  });
});

describe("keyMoments.forScholarDay — redaction boundary", () => {
  test("teacher read: scholar verbatim and observer analysis land in separate fields", async () => {
    const t = convexTest(schema, modules);
    const institutionId = await seedInstitutionWithTz(t, NY_TZ);
    const scholar = await seedScholarInInstitution(t, { institutionId });
    const teacher = await seedStaffWithMembership(t, {
      institutionId,
      role: "teacher",
      username: "teacher-redaction",
    });
    await grantStaffAccessToScholars(t, {
      staffUserId: teacher,
      scholarIds: [scholar],
      institutionId,
      role: "teacher",
    });
    const session = await seedSession(t, scholar);
    await seedMastery(t, {
      scholarId: scholar,
      sessionId: session,
      observedAt: Date.UTC(2026, 0, 14, 18, 0, 0),
      transcriptExcerpt: "I bet heavier things fall faster.",
      evidenceSummary: "Holds the Aristotelian misconception; re-teach.",
    });

    const asTeacher = await withUser(t, teacher);
    const [m] = await asTeacher.query(api.keyMoments.forScholarDay, {
      scholarId: scholar,
      dayKey: "2026-01-14",
    });

    expect(m.scholarVerbatim).toBe("I bet heavier things fall faster.");
    if (!("observerAnalysis" in m)) {
      throw new Error("teacher read unexpectedly omitted observer analysis");
    }
    expect(m.observerAnalysis).toBe(
      "Holds the Aristotelian misconception; re-teach.",
    );
    // The two texts must never be the same field / merged.
    expect(m.scholarVerbatim).not.toBe(m.observerAnalysis);
    expect(m).not.toHaveProperty("excerpt");
  });

  test("self read: observerAnalysis is OMITTED entirely, not an empty field", async () => {
    const t = convexTest(schema, modules);
    const institutionId = await seedInstitutionWithTz(t, NY_TZ);
    const scholar = await seedScholarInInstitution(t, { institutionId });
    const session = await seedSession(t, scholar);
    await seedMastery(t, {
      scholarId: scholar,
      sessionId: session,
      observedAt: Date.UTC(2026, 0, 14, 18, 0, 0),
      transcriptExcerpt: "I bet heavier things fall faster.",
      evidenceSummary: "Holds the Aristotelian misconception; re-teach.",
    });

    const asScholar = await withUser(t, scholar);
    const [m] = await asScholar.query(api.keyMoments.forScholarDay, {
      scholarId: scholar,
      dayKey: "2026-01-14",
    });

    // Scholar-safe projection: verbatim (their own words) stays; the
    // teacher-facing analysis is stripped entirely, not nulled/emptied.
    expect(m.scholarVerbatim).toBe("I bet heavier things fall faster.");
    expect(m).not.toHaveProperty("observerAnalysis");
    expect(m).not.toHaveProperty("excerpt");
  });
});

describe("keyMoments.forScholarDay — auth / tenant boundary", () => {
  test("a scholar can read their OWN day", async () => {
    const t = convexTest(schema, modules);
    const institutionId = await seedInstitutionWithTz(t, NY_TZ);
    const scholar = await seedScholarInInstitution(t, { institutionId });
    const asScholar = await withUser(t, scholar);
    const moments = await asScholar.query(api.keyMoments.forScholarDay, {
      scholarId: scholar,
      dayKey: "2026-01-14",
    });
    expect(moments).toEqual([]);
  });

  test("a different scholar cannot read another scholar's day", async () => {
    const t = convexTest(schema, modules);
    const institutionId = await seedInstitutionWithTz(t, NY_TZ);
    const scholar = await seedScholarInInstitution(t, { institutionId });
    const other = await seedScholarInInstitution(t, {
      institutionId,
      username: "other-scholar",
    });
    const asOther = await withUser(t, other);
    await expect(
      asOther.query(api.keyMoments.forScholarDay, {
        scholarId: scholar,
        dayKey: "2026-01-14",
      }),
    ).rejects.toThrow();
  });

  test("a teacher OUTSIDE the scholar's institution is denied (cross-tenant)", async () => {
    const t = convexTest(schema, modules);
    const schoolA = await seedInstitutionWithTz(t, NY_TZ, { slug: "school-a" });
    const schoolB = await seedInstitutionWithTz(t, NY_TZ, { slug: "school-b" });
    const scholarB = await seedScholarInInstitution(t, {
      institutionId: schoolB,
      username: "scholar-b",
    });
    const teacherA = await seedStaffWithMembership(t, {
      institutionId: schoolA,
      role: "teacher",
      username: "teacher-a",
    });
    const asTeacherA = await withUser(t, teacherA);
    await expect(
      asTeacherA.query(api.keyMoments.forScholarDay, {
        scholarId: scholarB,
        dayKey: "2026-01-14",
      }),
    ).rejects.toThrow();
  });

  test("a teacher WITHIN the scholar's institution can read the day", async () => {
    const t = convexTest(schema, modules);
    const institutionId = await seedInstitutionWithTz(t, NY_TZ);
    const scholar = await seedScholarInInstitution(t, { institutionId });
    const teacher = await seedStaffWithMembership(t, {
      institutionId,
      role: "teacher",
      username: "teacher-in",
    });
    await grantStaffAccessToScholars(t, {
      staffUserId: teacher,
      scholarIds: [scholar],
      institutionId,
      role: "teacher",
    });
    const session = await seedSession(t, scholar);
    await seedMastery(t, {
      scholarId: scholar,
      sessionId: session,
      observedAt: Date.UTC(2026, 0, 14, 18, 0, 0),
    });

    const asTeacher = await withUser(t, teacher);
    const moments = await asTeacher.query(api.keyMoments.forScholarDay, {
      scholarId: scholar,
      dayKey: "2026-01-14",
    });
    expect(moments.length).toBe(1);
  });
});
