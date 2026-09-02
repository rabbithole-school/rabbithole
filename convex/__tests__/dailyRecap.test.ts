import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "../schema";
import { grantInstitutionMembership, seedTestInstitution } from "./institutionTestHelpers";
import { api } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import { ONBOARDING_UNIT_SLUG } from "../onboardingData";
import { dayStartForTimezone } from "../../shared/institutionDay";
import { effectiveInstitutionTimeZone } from "../lib/institutionTime";

const modules = (
  import.meta as ImportMeta & {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("../**/*.ts");

// ── Standard fixtures (copied verbatim from convex/__tests__/testDrive.test.ts) ──
async function seedUser(
  t: ReturnType<typeof convexTest>,
  role: "scholar" | "teacher" | "platform_admin" = "scholar",
) {
  const institutionId = await seedTestInstitution(t);
  const userId = await t.run(async (ctx) => {
    return await ctx.db.insert("users", {
      name: role === "scholar" ? "Test Scholar" : `Test ${role}`,
      username: role === "scholar" ? "testscholar" : `test${role}`,
      role,
    });
  });

  await t.run((ctx) => ctx.db.patch(userId, { institutionId }));
  if (role === "teacher") {
    await grantInstitutionMembership(t, userId, institutionId, role);
  }
  return userId;
}

async function withUser(
  t: ReturnType<typeof convexTest>,
  userId: Id<"users">,
) {
  const sessionId = await t.run(async (ctx) => {
    const session: Omit<Doc<"authSessions">, "_id" | "_creationTime"> = {
      userId,
      expirationTime: Date.now() + 1000 * 60 * 60,
    };
    return await ctx.db.insert("authSessions", session);
  });
  return t.withIdentity({
    subject: `${userId}|${sessionId}`,
    issuer: "https://convex.dev",
  });
}
// ── end standard fixtures ──

// Standard unit/lesson/activity fixture (copied verbatim from
// convex/__tests__/testDrive.test.ts).
async function seedUnitWithActivity(
  t: ReturnType<typeof convexTest>,
  teacherId: Id<"users">,
) {
  return await t.run(async (ctx) => {
    const unitId = await ctx.db.insert("units", {
      teacherId,
      title: "Test Unit",
      isActive: true,
    });
    const lessonId = await ctx.db.insert("lessons", {
      unitId,
      title: "Test Lesson",
      order: 0,
    });
    const activityId = await ctx.db.insert("activities", {
      lessonId,
      title: "Test Activity",
      kind: "online",
      systemPrompt: "You are testing this activity.",
      order: 0,
    });
    return { unitId, lessonId, activityId };
  });
}

async function seedOnboardingActivity(
  t: ReturnType<typeof convexTest>,
  teacherId: Id<"users">,
) {
  return await t.run(async (ctx) => {
    const unitId = await ctx.db.insert("units", {
      teacherId,
      title: "Welcome to Rabbithole",
      slug: ONBOARDING_UNIT_SLUG,
      isActive: true,
    });
    const lessonId = await ctx.db.insert("lessons", {
      unitId,
      title: "Welcome",
      order: 0,
    });
    const activityId = await ctx.db.insert("activities", {
      lessonId,
      title: "What pulls you in",
      kind: "online",
      systemPrompt: "Welcome the scholar.",
      order: 0,
    });
    return { unitId, lessonId, activityId };
  });
}

const DAILY_RECAP_KEYS = [
  "finished",
  "hasAny",
  "newOnMap",
  "practiced",
  "practicedCount",
  "revealed",
  "yoursNow",
];

/** The SAME day boundary the query derives (fixture scholars have no
 *  institution, so `timeZoneForScholar` falls back to the default tz).
 *  Server-local midnight (`new Date().setHours(0,0,0,0)`) is WRONG here: on a
 *  UTC runner (CI) it disagrees with the institution boundary for part of the
 *  day, so a "yesterday" fixture seeded 1ms before server-local midnight lands
 *  inside the query's day — a time-of-day-dependent CI failure (observed
 *  2026-07-15, 01:17 UTC). */
function localMidnight(now = Date.now()): number {
  return dayStartForTimezone(now, effectiveInstitutionTimeZone(undefined));
}

async function seedNode(
  t: ReturnType<typeof convexTest>,
  nodeKey: string,
  label: string,
  domain = "whole-number-arithmetic",
) {
  await t.run(async (ctx) => {
    await ctx.db.insert("knowledgeNodes", { nodeKey, label, domain });
  });
}

async function seedMastery(
  t: ReturnType<typeof convexTest>,
  scholarId: Id<"users">,
  over: {
    skillKey: string;
    source?: string;
    domain?: string;
    lastAttemptAt?: number;
    lastPracticedAt?: number;
    becameFluentAt?: number;
    frontierAdvancedAt?: number;
  },
) {
  await t.run(async (ctx) => {
    await ctx.db.insert("practiceMastery", {
      scholarId,
      skillKey: over.skillKey,
      domain: over.domain ?? "whole-number-arithmetic",
      repetition: 3,
      halfLifeDays: 1,
      frontier: false,
      source: over.source ?? "practice",
      updatedAt: Date.now(),
      // A fresh SR clock so the composite green claim (isFluent's retention leg)
      // sees the row as currently fluent — otherwise a never-reviewed row reads
      // as immediately "due" and fluentNow would be false.
      lastPracticedAt: over.lastPracticedAt ?? Date.now(),
      lastAttemptAt: over.lastAttemptAt,
      becameFluentAt: over.becameFluentAt,
      frontierAdvancedAt: over.frontierAdvancedAt,
    });
  });
}

async function seedReveal(
  t: ReturnType<typeof convexTest>,
  scholarId: Id<"users">,
  nodeKey: string,
  revealedAt = Date.now(),
  source = "practice",
) {
  await t.run(async (ctx) => {
    await ctx.db.insert("nodeReveals", {
      scholarId,
      nodeKey,
      revealedAt,
      source,
    });
  });
}

describe("dailyRecap.forScholar — access gate", () => {
  test("a scholar reads their OWN recap", async () => {
    const t = convexTest(schema, modules);
    const scholar = await seedUser(t, "scholar");
    await seedNode(t, "add_within_20", "Adding within 20");
    await seedMastery(t, scholar, {
      skillKey: "add_within_20",
      frontierAdvancedAt: Date.now(),
    });

    const asScholar = await withUser(t, scholar);
    const recap = await asScholar.query(api.dailyRecap.forScholar, {
      scholarId: scholar,
      dayStart: localMidnight(),
    });

    expect(recap.hasAny).toBe(true);
    expect(recap.newOnMap).toEqual(["Adding within 20"]);
  });

  test("another scholar is Forbidden", async () => {
    const t = convexTest(schema, modules);
    const a = await seedUser(t, "scholar");
    const b = await t.run(async (ctx) =>
      ctx.db.insert("users", { name: "Other", username: "other", role: "scholar" }),
    );
    const asA = await withUser(t, a);
    await expect(
      asA.query(api.dailyRecap.forScholar, { scholarId: b, dayStart: localMidnight() }),
    ).rejects.toThrow(/Forbidden/);
  });

  test("a teacher can read a scholar's recap", async () => {
    const t = convexTest(schema, modules);
    const teacher = await seedUser(t, "teacher");
    const scholar = await seedUser(t, "scholar");
    await seedNode(t, "sub_within_20", "Subtracting within 20");
    await seedMastery(t, scholar, {
      skillKey: "sub_within_20",
      becameFluentAt: Date.now(),
      source: "practice",
    });

    const asTeacher = await withUser(t, teacher);
    const recap = await asTeacher.query(api.dailyRecap.forScholar, {
      scholarId: scholar,
      dayStart: localMidnight(),
    });
    expect(recap.yoursNow).toEqual(["Subtracting within 20"]);
  });
});

describe("dailyRecap.forScholar — data resolution", () => {
  test("today's reveal rows resolve labels into the additive bucket", async () => {
    const t = convexTest(schema, modules);
    const scholar = await seedUser(t, "scholar");
    await seedNode(t, "place_value", "Place value");
    await seedNode(t, "mult_facts", "Multiplication facts");
    await seedReveal(t, scholar, "place_value");
    await seedReveal(t, scholar, "mult_facts", localMidnight() - 1);

    const asScholar = await withUser(t, scholar);
    const recap = await asScholar.query(api.dailyRecap.forScholar, {
      scholarId: scholar,
      dayStart: localMidnight(),
    });

    expect(recap.revealed).toEqual(["Place value"]);
    expect(recap.hasAny).toBe(true);
  });

  test("an accelerated-source reveal latch never mints a recap card", async () => {
    const t = convexTest(schema, modules);
    const scholar = await seedUser(t, "scholar");
    await seedNode(t, "place_value", "Place value");
    // A valve-jump crossing latches visibility (never un-reveal) but is
    // inferred credit — the receipt only reports practice-earned reveals.
    await seedReveal(t, scholar, "place_value", Date.now(), "accelerated");

    const asScholar = await withUser(t, scholar);
    const recap = await asScholar.query(api.dailyRecap.forScholar, {
      scholarId: scholar,
      dayStart: localMidnight(),
    });

    expect(recap.revealed).toEqual([]);
    expect(recap.hasAny).toBe(false);
  });

  test("labels resolve from knowledgeNodes; unknown keys de-slug", async () => {
    const t = convexTest(schema, modules);
    const scholar = await seedUser(t, "scholar");
    await seedNode(t, "place_value", "Place value");
    // Only place_value has a node; mult_facts is unmapped → de-slug fallback.
    await seedMastery(t, scholar, {
      skillKey: "place_value",
      frontierAdvancedAt: Date.now(),
    });
    await seedMastery(t, scholar, {
      skillKey: "mult_facts",
      frontierAdvancedAt: Date.now(),
    });

    const asScholar = await withUser(t, scholar);
    const recap = await asScholar.query(api.dailyRecap.forScholar, {
      scholarId: scholar,
      dayStart: localMidnight(),
    });
    expect(recap.newOnMap).toContain("Place value");
    expect(recap.newOnMap).toContain("mult facts");
  });

  test("an ordinary activity completion alone does not create a receipt", async () => {
    const t = convexTest(schema, modules);
    const scholar = await seedUser(t, "scholar");
    const { activityId } = await seedUnitWithActivity(t, scholar);
    await t.run(async (ctx) => {
      await ctx.db.insert("activityCompletions", {
        scholarId: scholar,
        activityId,
        completedAt: Date.now(),
      });
    });

    const asScholar = await withUser(t, scholar);
    const recap = await asScholar.query(api.dailyRecap.forScholar, {
      scholarId: scholar,
      dayStart: localMidnight(),
    });
    expect(recap.finished).toEqual([]);
    expect(recap.hasAny).toBe(false);
  });

  test("an onboarding beat completion alone does not create a daily recap", async () => {
    const t = convexTest(schema, modules);
    const scholar = await seedUser(t, "scholar");
    const { unitId, lessonId, activityId } = await seedOnboardingActivity(t, scholar);
    await t.run(async (ctx) => {
      await ctx.db.insert("activityCompletions", {
        scholarId: scholar,
        unitId,
        lessonId,
        activityId,
        completedAt: Date.now(),
      });
    });

    const asScholar = await withUser(t, scholar);
    const recap = await asScholar.query(api.dailyRecap.forScholar, {
      scholarId: scholar,
      dayStart: localMidnight(),
    });
    expect(recap.finished).toEqual([]);
    expect(recap.hasAny).toBe(false);
  });

  test("practice-only movement does not create a receipt", async () => {
    const t = convexTest(schema, modules);
    const scholar = await seedUser(t, "scholar");
    await seedNode(t, "place_value", "Place value");
    await seedMastery(t, scholar, {
      skillKey: "place_value",
      lastAttemptAt: Date.now(),
    });

    const asScholar = await withUser(t, scholar);
    const recap = await asScholar.query(api.dailyRecap.forScholar, {
      scholarId: scholar,
      dayStart: localMidnight(),
    });

    expect(recap.practiced).toEqual([]);
    expect(recap.hasAny).toBe(false);
  });

  test("weak signals stay hidden when durable map movement also happened", async () => {
    const t = convexTest(schema, modules);
    const scholar = await seedUser(t, "scholar");
    const { unitId, lessonId, activityId } = await seedOnboardingActivity(t, scholar);
    await seedNode(t, "place_value", "Place value");
    await seedMastery(t, scholar, {
      skillKey: "place_value",
      lastAttemptAt: Date.now(),
      frontierAdvancedAt: Date.now(),
    });
    await t.run(async (ctx) => {
      await ctx.db.insert("activityCompletions", {
        scholarId: scholar,
        unitId,
        lessonId,
        activityId,
        completedAt: Date.now(),
      });
    });

    const asScholar = await withUser(t, scholar);
    const recap = await asScholar.query(api.dailyRecap.forScholar, {
      scholarId: scholar,
      dayStart: localMidnight(),
    });
    expect(recap.finished).toEqual([]);
    expect(recap.practiced).toEqual([]);
    expect(recap.newOnMap).toEqual(["Place value"]);
    expect(recap.hasAny).toBe(true);
  });

  test("placement-sourced fluency never appears in `yoursNow`", async () => {
    const t = convexTest(schema, modules);
    const scholar = await seedUser(t, "scholar");
    await seedNode(t, "add_within_20", "Adding within 20");
    await seedMastery(t, scholar, {
      skillKey: "add_within_20",
      becameFluentAt: Date.now(),
      source: "placement",
    });

    const asScholar = await withUser(t, scholar);
    const recap = await asScholar.query(api.dailyRecap.forScholar, {
      scholarId: scholar,
      dayStart: localMidnight(),
    });
    expect(recap.yoursNow).toEqual([]);
    expect(recap.hasAny).toBe(false);
  });
});

describe("dailyRecap.forScholar — institution day", () => {
  test("a stale day key returns an empty recap", async () => {
    const t = convexTest(schema, modules);
    const scholar = await seedUser(t, "scholar");
    await seedNode(t, "add_within_20", "Adding within 20");
    await seedMastery(t, scholar, {
      skillKey: "add_within_20",
      frontierAdvancedAt: Date.now(),
    });

    const asScholar = await withUser(t, scholar);
    const recap = await asScholar.query(api.dailyRecap.forScholar, {
      scholarId: scholar,
      dayKey: "1900-01-01",
    });
    expect(recap.hasAny).toBe(false);
    expect(recap.practiced).toEqual([]);
  });

  test("legacy device-local dayStart cannot override the school calendar", async () => {
    const t = convexTest(schema, modules);
    const scholar = await seedUser(t, "scholar");
    await seedNode(t, "add_within_20", "Adding within 20");
    await seedMastery(t, scholar, {
      skillKey: "add_within_20",
      frontierAdvancedAt: Date.now(),
    });

    const asScholar = await withUser(t, scholar);
    const recap = await asScholar.query(api.dailyRecap.forScholar, {
      scholarId: scholar,
      dayStart: 0,
    });
    expect(recap.hasAny).toBe(true);
    expect(recap.newOnMap).toEqual(["Adding within 20"]);
  });
});

describe("dailyRecap.forScholar — redaction canary", () => {
  test("scholar read never returns teacher-only practice diagnostics", async () => {
    const t = convexTest(schema, modules);
    const scholar = await seedUser(t, "scholar");
    const now = Date.now();
    const dayStart = localMidnight(now);
    const total = 987;
    const correctCount = 654;

    await seedNode(t, "subtract_across_zero", "Subtracting across zero");
    await seedMastery(t, scholar, {
      skillKey: "subtract_across_zero",
      lastAttemptAt: now,
      becameFluentAt: now,
      frontierAdvancedAt: now,
    });
    await t.run(async (ctx) => {
      await ctx.db.insert("practiceErrorEvents", {
        scholarId: scholar,
        nodeKey: "subtract_across_zero",
        domain: "whole-number-arithmetic",
        pattern: "subtract_smaller_from_larger",
        itemId: "teacher-only-error-item",
        createdAt: now,
      });
      await ctx.db.insert("practiceTuneups", {
        scholarId: scholar,
        domain: "whole-number-arithmetic",
        skillKeys: ["subtract_across_zero"],
        startedAt: now - 1000,
        completedAt: now,
        total,
        correctCount,
      });
    });

    const asScholar = await withUser(t, scholar);
    const recap = await asScholar.query(api.dailyRecap.forScholar, {
      scholarId: scholar,
      dayStart,
    });
    const serialized = JSON.stringify(recap);

    expect(Object.keys(recap).sort()).toEqual(DAILY_RECAP_KEYS);
    expect(recap.yoursNow).toEqual(["Subtracting across zero"]);
    expect(recap.newOnMap).toEqual([]);
    expect(recap.revealed).toEqual([]);
    expect(serialized).not.toContain("subtract_smaller_from_larger");
    expect(serialized).not.toContain("misconception");
    expect(serialized).not.toContain("tuneup");
    expect(serialized).not.toContain("pattern");
    expect(serialized).not.toContain("correctCount");
    expect(serialized).not.toContain(String(total));
    expect(serialized).not.toContain(String(correctCount));
  });
});
