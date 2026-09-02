import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "../schema";
import { api } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import { ACCEL_SOURCE, FLUENT_REPS } from "../lib/practice/scheduler";

const modules = (
  import.meta as ImportMeta & {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("../**/*.ts");

const DAY = 86_400_000;

async function seedUser(
  t: ReturnType<typeof convexTest>,
  role: "scholar" | "teacher" | "platform_admin",
  username: string,
) {
  return await t.run(async (ctx) =>
    ctx.db.insert("users", { name: `Test ${username}`, username, role }),
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

describe("practiceInstruments — admin gate", () => {
  test("a non-admin (scholar) is rejected", async () => {
    const t = convexTest(schema, modules);
    const scholar = await seedUser(t, "scholar", "scholar1");
    const asScholar = await asUser(t, scholar);
    await expect(
      asScholar.query(api.practiceInstruments.getInstruments, {}),
    ).rejects.toThrow(/Forbidden/);
  });

  test("a teacher (not platform admin) is rejected", async () => {
    const t = convexTest(schema, modules);
    const teacher = await seedUser(t, "teacher", "teacher1");
    const asTeacher = await asUser(t, teacher);
    await expect(
      asTeacher.query(api.practiceInstruments.getInstruments, {}),
    ).rejects.toThrow(/Forbidden/);
  });

  test("a platform_admin can read (empty world → all-zero shape)", async () => {
    const t = convexTest(schema, modules);
    const admin = await seedUser(t, "platform_admin", "admin1");
    const asAdmin = await asUser(t, admin);
    const res = await asAdmin.query(api.practiceInstruments.getInstruments, {});
    expect(res.valve).toEqual({ fired: 0, stillHolding: 0, lapsed: 0, lapseRate: 0 });
    expect(res.sourceMix.total).toBe(0);
    expect(res.latency.count).toBe(0);
    expect(res.errorPatterns).toEqual([]);
    expect(res.domainExhaustion).toEqual([]);
  });
});

describe("practiceInstruments — aggregation", () => {
  const domain = "whole_number_arithmetic";

  async function seedWorld(t: ReturnType<typeof convexTest>) {
    const admin = await seedUser(t, "platform_admin", "admin2");
    const scholarA = await seedUser(t, "scholar", "scholarA");
    const scholarB = await seedUser(t, "scholar", "scholarB");
    const now = Date.now();

    await t.run(async (ctx) => {
      // ── knowledgeNodes ──
      // Practice nodes carry a `strand` (the scheduler's sub-thread) — that's
      // how the panel tells a real practice domain from an atlas/standards node.
      for (const nodeKey of ["a", "b", "c", "d"]) {
        await ctx.db.insert("knowledgeNodes", { nodeKey, label: nodeKey, domain, strand: "core" });
      }
      // A practice domain with a node but (below) no mastery — still counts.
      await ctx.db.insert("knowledgeNodes", { nodeKey: "x", label: "x", domain: "writing", strand: "core" });
      // A STRAND-LESS atlas/standards node — its free-form `domain` must NOT
      // appear in domain-exhaustion. This is the fix for the "Mathematics /
      // mathematics / whole-number-arithmetic are three domains" mess: only
      // stranded practice nodes count; shared-table atlas nodes are ignored.
      await ctx.db.insert("knowledgeNodes", { nodeKey: "some math concept", label: "some math concept", domain: "Mathematics" });

      // ── practiceMastery ──
      // 1. An accelerated row that STILL HOLDS (fresh half-life, practiced today).
      await ctx.db.insert("practiceMastery", {
        scholarId: scholarA, skillKey: "a", domain, repetition: FLUENT_REPS,
        halfLifeDays: 30, lastPracticedAt: now, frontier: false,
        source: ACCEL_SOURCE, updatedAt: now,
      });
      // 2. An accelerated row that HAS LAPSED (short half-life, practiced long ago → due).
      await ctx.db.insert("practiceMastery", {
        scholarId: scholarB, skillKey: "b", domain, repetition: FLUENT_REPS,
        halfLifeDays: 1, lastPracticedAt: now - 30 * DAY, frontier: false,
        source: ACCEL_SOURCE, updatedAt: now,
      });
      // 3. A plain "practice"-sourced fluent row, with a latency reading.
      await ctx.db.insert("practiceMastery", {
        scholarId: scholarA, skillKey: "c", domain, repetition: FLUENT_REPS,
        halfLifeDays: 10, lastPracticedAt: now, frontier: false,
        source: "practice", updatedAt: now, latencyMedianMs: 2000,
      });
      // 4. A "placement"-sourced fluent row, with a latency reading.
      await ctx.db.insert("practiceMastery", {
        scholarId: scholarB, skillKey: "d", domain, repetition: FLUENT_REPS,
        halfLifeDays: 10, lastPracticedAt: now, frontier: false,
        source: "placement", updatedAt: now, latencyMedianMs: 4000,
      });
      // 5. A not-yet-fluent row (should be excluded from source mix, still counts
      //    toward the domain's scholar denominator).
      await ctx.db.insert("practiceMastery", {
        scholarId: scholarA, skillKey: "d", domain, repetition: 1,
        halfLifeDays: 2, lastPracticedAt: now, frontier: true,
        source: "practice", updatedAt: now, latencyMedianMs: 3000,
      });

      // ── practiceErrorEvents: 2 recent "SMALLER_FROM_LARGER", 1 recent "REVERSED_OPERANDS",
      //    1 STALE "SMALLER_FROM_LARGER" outside the 14-day window (must be excluded).
      await ctx.db.insert("practiceErrorEvents", {
        scholarId: scholarA, nodeKey: "a", domain, pattern: "SMALLER_FROM_LARGER",
        itemId: "i1", createdAt: now,
      });
      await ctx.db.insert("practiceErrorEvents", {
        scholarId: scholarB, nodeKey: "b", domain, pattern: "SMALLER_FROM_LARGER",
        itemId: "i2", createdAt: now - DAY,
      });
      await ctx.db.insert("practiceErrorEvents", {
        scholarId: scholarA, nodeKey: "c", domain, pattern: "REVERSED_OPERANDS",
        itemId: "i3", createdAt: now,
      });
      await ctx.db.insert("practiceErrorEvents", {
        scholarId: scholarA, nodeKey: "a", domain, pattern: "SMALLER_FROM_LARGER",
        itemId: "i4", createdAt: now - 20 * DAY,
      });
    });

    return { admin, scholarA, scholarB };
  }

  test("valve stats: fired / stillHolding / lapsed / lapseRate", async () => {
    const t = convexTest(schema, modules);
    const { admin } = await seedWorld(t);
    const res = await (await asUser(t, admin)).query(api.practiceInstruments.getInstruments, {});
    expect(res.valve).toEqual({ fired: 2, stillHolding: 1, lapsed: 1, lapseRate: 0.5 });
  });

  test("source mix across fluent rows only", async () => {
    const t = convexTest(schema, modules);
    const { admin } = await seedWorld(t);
    const res = await (await asUser(t, admin)).query(api.practiceInstruments.getInstruments, {});
    // 4 fluent rows: 2 accelerated, 1 practice, 1 placement (the repetition:1 row is excluded).
    expect(res.sourceMix).toEqual({
      total: 4,
      counts: { accelerated: 2, practice: 1, placement: 1 },
    });
  });

  test("latency distribution over rows with a latencyMedianMs reading", async () => {
    const t = convexTest(schema, modules);
    const { admin } = await seedWorld(t);
    const res = await (await asUser(t, admin)).query(api.practiceInstruments.getInstruments, {});
    // readings: 2000, 3000, 4000
    expect(res.latency.count).toBe(3);
    expect(res.latency.min).toBe(2000);
    expect(res.latency.median).toBe(3000);
    expect(res.latency.max).toBe(4000);
  });

  test("error patterns: 14-day window + distinct-scholar counts", async () => {
    const t = convexTest(schema, modules);
    const { admin } = await seedWorld(t);
    const res = await (await asUser(t, admin)).query(api.practiceInstruments.getInstruments, {});
    // The stale SMALLER_FROM_LARGER (20 days old) is excluded, leaving 2 recent SMALLER_FROM_LARGER
    // (scholarA + scholarB) and 1 REVERSED_OPERANDS (scholarA).
    expect(res.errorPatterns).toEqual([
      { pattern: "SMALLER_FROM_LARGER", count: 2, scholarCount: 2 },
      { pattern: "REVERSED_OPERANDS", count: 1, scholarCount: 1 },
    ]);
  });

  test("domain exhaustion: totalNodes / scholarCount / fluentNodeInstances / avgPercentComplete", async () => {
    const t = convexTest(schema, modules);
    const { admin } = await seedWorld(t);
    const res = await (await asUser(t, admin)).query(api.practiceInstruments.getInstruments, {});
    const arith = res.domainExhaustion.find((d) => d.domain === domain);
    expect(arith).toBeDefined();
    // 4 knowledgeNodes in-domain; scholarA + scholarB both have rows → scholarCount 2;
    // 4 fluent-node instances (rows 1-4 above). avg% = 4 / (4*2) * 100 = 50.
    expect(arith).toEqual({
      domain,
      totalNodes: 4,
      scholarCount: 2,
      fluentNodeInstances: 4,
      avgPercentComplete: 50,
    });
    // The "writing" domain has a practice (stranded) node but no mastery rows
    // → still listed (it's a practice domain), pinned at 0% since no scholar
    // has touched it yet.
    expect(res.domainExhaustion.find((d) => d.domain === "writing")).toEqual({
      domain: "writing",
      totalNodes: 1,
      scholarCount: 0,
      fluentNodeInstances: 0,
      avgPercentComplete: 0,
    });
    // The strand-less atlas node's free-form domain ("Mathematics") is NOT a
    // practice domain → excluded entirely (the shared-table dedup fix).
    expect(res.domainExhaustion.find((d) => d.domain === "Mathematics")).toBeUndefined();
  });

  test("domain filter scopes every metric", async () => {
    const t = convexTest(schema, modules);
    const { admin } = await seedWorld(t);
    const res = await (await asUser(t, admin)).query(api.practiceInstruments.getInstruments, {
      domain: "writing",
    });
    expect(res.valve).toEqual({ fired: 0, stillHolding: 0, lapsed: 0, lapseRate: 0 });
    expect(res.sourceMix.total).toBe(0);
    expect(res.errorPatterns).toEqual([]);
    // "writing" has 1 knowledgeNode and 0 mastery rows → still listed, at 0%.
    expect(res.domainExhaustion).toEqual([
      { domain: "writing", totalNodes: 1, scholarCount: 0, fluentNodeInstances: 0, avgPercentComplete: 0 },
    ]);
  });
});

describe("practiceInstruments — FIRe implicit refresh block", () => {
  const domain = "whole_number_arithmetic";

  test("implicit: refreshedRows14d / totalImplicitCount / dueNow", async () => {
    const t = convexTest(schema, modules);
    const admin = await seedUser(t, "platform_admin", "admin_impl");
    const scholar = await seedUser(t, "scholar", "scholar_impl");
    const now = Date.now();

    await t.run(async (ctx) => {
      // 1. Refreshed within the 14-day window, fresh half-life → NOT due.
      await ctx.db.insert("practiceMastery", {
        scholarId: scholar, skillKey: "a", domain, repetition: FLUENT_REPS,
        halfLifeDays: 30, lastPracticedAt: now, frontier: false, source: "practice",
        updatedAt: now, lastImplicitAt: now, implicitCount: 3,
      });
      // 2. Last implicit refresh is STALE (20 days ago) + decayed → due.
      await ctx.db.insert("practiceMastery", {
        scholarId: scholar, skillKey: "b", domain, repetition: FLUENT_REPS,
        halfLifeDays: 1, lastPracticedAt: now - 30 * DAY, frontier: false, source: "practice",
        updatedAt: now, lastImplicitAt: now - 20 * DAY, implicitCount: 2,
      });
      // 3. Never received implicit credit + decayed → due, contributes 0 to the count.
      await ctx.db.insert("practiceMastery", {
        scholarId: scholar, skillKey: "c", domain, repetition: FLUENT_REPS,
        halfLifeDays: 1, lastPracticedAt: now - 30 * DAY, frontier: false, source: "practice",
        updatedAt: now,
      });
    });

    const res = await (await asUser(t, admin)).query(api.practiceInstruments.getInstruments, {});
    expect(res.implicit).toEqual({
      refreshedRows14d: 1, // only row 1's lastImplicitAt is inside the window
      totalImplicitCount: 5, // 3 + 2 + 0
      dueNow: 2, // rows b and c are decayed below threshold; a is fresh
    });
  });
});

describe("practiceInstruments — auto-remediation coverage block (§5)", () => {
  const domain = "remediation_test";

  test("remediation: activeTargets counts served scholars; scholarsWithOpenFlags counts all flagged", async () => {
    const t = convexTest(schema, modules);
    const admin = await seedUser(t, "platform_admin", "admin_rem");
    const served = await seedUser(t, "scholar", "scholar_served");
    const secondServed = await seedUser(t, "scholar", "scholar_second_served");
    const belowCount = await seedUser(t, "scholar", "scholar_below");
    const now = Date.now();

    await t.run(async (ctx) => {
      // Graph: prereq "p" → flagged "f".
      await ctx.db.insert("knowledgeNodeEdges", { fromKey: "p", toKey: "f", domain, kind: "buildsOn" });

      // Weak-but-attempted prereq state, shared shape (retention ≈0.76 → candidate).
      const weakPrereq = (scholarId: Id<"users">, extra: Record<string, unknown> = {}) => ({
        scholarId, skillKey: "p", domain, repetition: FLUENT_REPS,
        halfLifeDays: 10, lastPracticedAt: now - 4 * DAY, frontier: false,
        source: "practice", updatedAt: now, ...extra,
      });
      const openFlag = (scholarId: Id<"users">, count: number) => {
        const rows: Promise<unknown>[] = [];
        for (let i = 0; i < count; i++) {
          rows.push(
            ctx.db.insert("practiceErrorEvents", {
              scholarId, nodeKey: "f", domain, pattern: "DROPPED_CARRY",
              itemId: `it#${scholarId}#${i}`, createdAt: now - (i + 1) * DAY,
            }),
          );
        }
        return Promise.all(rows);
      };

      // 1. Open flag + weak prereq → an active target.
      await ctx.db.insert("practiceMastery", weakPrereq(served));
      await openFlag(served, 3);
      // 2. A second open flag + weak prereq → a second active target.
      await ctx.db.insert("practiceMastery", weakPrereq(secondServed));
      await openFlag(secondServed, 3);
      // 3. Only two misses (below MIN_COUNT) → not flagged at all.
      await ctx.db.insert("practiceMastery", weakPrereq(belowCount));
      await openFlag(belowCount, 2);
    });

    const res = await (await asUser(t, admin)).query(api.practiceInstruments.getInstruments, { domain });
    expect(res.remediation).toEqual({ activeTargets: 2, scholarsWithOpenFlags: 2 });
  });
});

describe("practiceInstruments — tune-up throughput block (§4B)", () => {
  const domain = "tuneup_instruments_test";

  test("tuneups: started14d / completed14d count the trailing window; avgCorrect over completions only", async () => {
    const t = convexTest(schema, modules);
    const admin = await seedUser(t, "platform_admin", "admin_tu");
    const scholar = await seedUser(t, "scholar", "scholar_tu");
    const now = Date.now();

    await t.run(async (ctx) => {
      // 1. Started + completed inside the window (correct 5).
      await ctx.db.insert("practiceTuneups", {
        scholarId: scholar, domain, skillKeys: ["a"], startedAt: now - 1 * DAY,
        completedAt: now - 1 * DAY, total: 6, correctCount: 5,
      });
      // 2. Started + completed inside the window (correct 3) → avg = (5+3)/2 = 4.
      await ctx.db.insert("practiceTuneups", {
        scholarId: scholar, domain, skillKeys: ["b"], startedAt: now - 3 * DAY,
        completedAt: now - 2 * DAY, total: 6, correctCount: 3,
      });
      // 3. Started inside the window but not yet completed → counts started only.
      await ctx.db.insert("practiceTuneups", {
        scholarId: scholar, domain, skillKeys: ["c"], startedAt: now - 5 * DAY, total: 6,
      });
      // 4. Started + completed BEFORE the 14-day window → excluded from both counts.
      await ctx.db.insert("practiceTuneups", {
        scholarId: scholar, domain, skillKeys: ["d"], startedAt: now - 40 * DAY,
        completedAt: now - 40 * DAY, total: 6, correctCount: 0,
      });
      // 5. Different domain → excluded by the domain filter.
      await ctx.db.insert("practiceTuneups", {
        scholarId: scholar, domain: "other_domain", skillKeys: ["e"], startedAt: now - 1 * DAY,
        completedAt: now - 1 * DAY, total: 6, correctCount: 6,
      });
    });

    const res = await (await asUser(t, admin)).query(api.practiceInstruments.getInstruments, { domain });
    expect(res.tuneups).toEqual({ started14d: 3, completed14d: 2, avgCorrect: 4 });
  });
});
