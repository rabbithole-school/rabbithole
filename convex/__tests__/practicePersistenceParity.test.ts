import { convexTest } from "convex-test";
import { afterEach, describe, expect, test, vi } from "vitest";
import schema from "../schema";
import { api, internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import { QUICK_FACTS_SCOPE_KEY } from "../../shared/practiceResumeContract";
import {
  seedScholarInInstitution,
  seedTestInstitution,
} from "./institutionTestHelpers";

const modules = (
  import.meta as ImportMeta & { glob: (p: string) => Record<string, () => Promise<unknown>> }
).glob("../**/*.ts");

afterEach(() => {
  vi.useRealTimers();
});

async function seedScholar(t: ReturnType<typeof convexTest>) {
  return seedScholarInInstitution(t, {
    institutionId: await seedTestInstitution(t),
    name: "Scope Scholar",
    username: "scopescholar",
  });
}

/** Mirrors practiceSkills.test.ts's `asUser` — a real authSessions row so
 *  `requireUser` resolves the scholar rather than throwing "Not authenticated". */
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

/**
 * The server-canonical `scopeKey`/`dayKey` a resume snapshot is validated
 * against. These are intentionally NOT tested inside the 8000+-line
 * practiceSkills.test.ts — they are cross-cutting resume plumbing, not
 * domain-serving behavior, so they get their own small focused file.
 */
describe("practiceSession — scopeKey/dayKey (resume validity)", () => {
  test("an open (unscoped) scholar gets a stable scopeKey across repeated calls", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.practiceSkills.seedGraph, {});
    const scholar = await seedScholar(t);
    const as = await asUser(t, scholar);
    const first = await as.query(api.practiceSkills.practiceSession, {
      scholarId: scholar,
      seed: 1,
    });
    const second = await as.query(api.practiceSkills.practiceSession, {
      scholarId: scholar,
      seed: 2,
    });
    expect(first.scopeKey).toBeDefined();
    expect(first.dayKey).toBeDefined();
    // Same resolved scope both times (no Math plan, no standing assignment) —
    // the scopeKey must be byte-identical even though the seed differs.
    expect(second.scopeKey).toBe(first.scopeKey);
  });

  test("adding a Math plan (open → limited) changes the scopeKey", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.practiceSkills.seedGraph, {});
    const scholar = await seedScholar(t);
    const as = await asUser(t, scholar);
    const beforePlan = await as.query(api.practiceSkills.practiceSession, {
      scholarId: scholar,
      seed: 1,
    });
    await t.run(async (ctx) => {
      await ctx.db.insert("scholarMathPlans", {
        scholarId: scholar,
        practiceScope: { kind: "limited", domains: [{ domain: "fraction-arithmetic" }] },
        updatedBy: scholar,
        updatedAt: Date.now(),
      });
    });
    const afterPlan = await as.query(api.practiceSkills.practiceSession, {
      scholarId: scholar,
      seed: 1,
    });
    expect(afterPlan.scopeKey).not.toBe(beforePlan.scopeKey);
  });

  test("a resolved scope with strands sorted differently still produces the SAME scopeKey", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.practiceSkills.seedGraph, {});
    const institutionId = await seedTestInstitution(t);
    const scholarA = await seedScholarInInstitution(t, {
      institutionId,
      name: "A",
      username: "scholar-a",
    });
    const scholarB = await seedScholarInInstitution(t, {
      institutionId,
      name: "B",
      username: "scholar-b",
    });
    await t.run(async (ctx) => {
      await ctx.db.insert("scholarMathPlans", {
        scholarId: scholarA,
        practiceScope: {
          kind: "limited",
          domains: [{ domain: "whole-number-arithmetic", strands: ["multiplication", "addition"] }],
        },
        updatedBy: scholarA,
        updatedAt: Date.now(),
      });
      await ctx.db.insert("scholarMathPlans", {
        scholarId: scholarB,
        practiceScope: {
          kind: "limited",
          domains: [{ domain: "whole-number-arithmetic", strands: ["addition", "multiplication"] }],
        },
        updatedBy: scholarB,
        updatedAt: Date.now(),
      });
    });
    const a = await (await asUser(t, scholarA)).query(api.practiceSkills.practiceSession, {
      scholarId: scholarA,
      seed: 1,
    });
    const b = await (await asUser(t, scholarB)).query(api.practiceSkills.practiceSession, {
      scholarId: scholarB,
      seed: 1,
    });
    expect(a.scopeKey).toBe(b.scopeKey);
  });

  test("dayKey changes across an institution-local midnight rollover (default Pacific/Honolulu)", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.practiceSkills.seedGraph, {});
    const scholar = await seedScholar(t);
    const as = await asUser(t, scholar);
    // 2026-01-05 23:00 HST and 2026-01-06 01:00 HST straddle local midnight —
    // UTC-10, no DST, so this is exact.
    vi.useFakeTimers();
    vi.setSystemTime(Date.UTC(2026, 0, 6, 9, 0, 0)); // 2026-01-05 23:00 HST
    const beforeMidnight = await as.query(api.practiceSkills.practiceSession, {
      scholarId: scholar,
      seed: 1,
    });
    vi.setSystemTime(Date.UTC(2026, 0, 6, 11, 0, 0)); // 2026-01-06 01:00 HST
    const afterMidnight = await as.query(api.practiceSkills.practiceSession, {
      scholarId: scholar,
      seed: 1,
    });
    expect(beforeMidnight.dayKey).toBe("2026-01-05");
    expect(afterMidnight.dayKey).toBe("2026-01-06");
    expect(afterMidnight.dayKey).not.toBe(beforeMidnight.dayKey);
  });

  test("practiceScopeSnapshotKey matches practiceSession's own scopeKey/dayKey without serving anything", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.practiceSkills.seedGraph, {});
    const scholar = await seedScholar(t);
    await t.run(async (ctx) => {
      await ctx.db.insert("scholarMathPlans", {
        scholarId: scholar,
        practiceScope: { kind: "limited", domains: [{ domain: "fraction-arithmetic" }] },
        updatedBy: scholar,
        updatedAt: Date.now(),
      });
    });
    const as = await asUser(t, scholar);
    const served = await as.query(api.practiceSkills.practiceSession, {
      scholarId: scholar,
      seed: 1,
    });
    const validity = await as.query(api.practiceSkills.practiceScopeSnapshotKey, {
      scholarId: scholar,
    });
    expect(validity.scopeKey).toBe(served.scopeKey);
    expect(validity.dayKey).toBe(served.dayKey);
  });

  test("Quick Facts carries a fixed sentinel scopeKey, distinct from an ordinary-domain scopeKey", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.practiceSkills.seedGraph, {});
    const scholar = await seedScholar(t);
    const as = await asUser(t, scholar);
    const ordinary = await as.query(api.practiceSkills.practiceSession, {
      scholarId: scholar,
      seed: 1,
    });
    const quickFacts = await as.query(api.practiceSkills.startQuickFactsPractice, {
      scholarId: scholar,
      seed: 1,
    });
    expect(QUICK_FACTS_SCOPE_KEY).toBe("quick-facts");
    expect(quickFacts.scopeKey).toBe(QUICK_FACTS_SCOPE_KEY);
    expect(quickFacts.scopeKey).not.toBe(ordinary.scopeKey);
    expect(quickFacts.dayKey).toBe(ordinary.dayKey);
  });

  test("a blocked (fully out-of-scope) result still carries a scopeKey/dayKey", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.practiceSkills.seedGraph, {});
    const scholar = await seedScholar(t);
    await t.run(async (ctx) => {
      await ctx.db.insert("scholarMathPlans", {
        scholarId: scholar,
        practiceScope: { kind: "limited", domains: [{ domain: "fraction-arithmetic" }] },
        updatedBy: scholar,
        updatedAt: Date.now(),
      });
    });
    const as = await asUser(t, scholar);
    // Ask for a domain outside the plan's scope — expect the blocked shape.
    const res = await as.query(api.practiceSkills.practiceSession, {
      scholarId: scholar,
      seed: 1,
      domain: "whole-number-arithmetic",
    });
    expect((res as { blocked?: boolean }).blocked).toBe(true);
    expect(res.scopeKey).toBeDefined();
    expect(res.dayKey).toBeDefined();
  });
});
