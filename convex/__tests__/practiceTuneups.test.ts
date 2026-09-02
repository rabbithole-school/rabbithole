/**
 * Tune-up checkpoint (§4B, "C"). Two layers:
 *  - pure sampler (`lib/practice/tuneup.ts`): eligibility, the inferred-credit
 *    ×2 weighting, deterministic tie-break;
 *  - backend wiring (`practiceTuneups.ts`): offer gating (pool + interval),
 *    `start` interval re-validation, `complete` idempotency + auth.
 * Features are always-on here (no env flag) — Andy gates at deploy.
 */
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "../schema";
import { api } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import { FLUENT_REPS } from "../lib/practice/scheduler";
import {
  eligibleForTuneup,
  pickTuneupSample,
  TUNEUP_SIZE,
  type TuneupCandidate,
} from "../lib/practice/tuneup";

const modules = (
  import.meta as ImportMeta & {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("../**/*.ts");

const DAY = 86_400_000;
const DOMAIN = "tuneup_test";
const NOW = 1_000 * DAY;

// ── Pure sampler ──────────────────────────────────────────────────────────
describe("tuneup sampler (pure)", () => {
  const cand = (over: Partial<TuneupCandidate> & { skillKey: string }): TuneupCandidate => ({
    repetition: FLUENT_REPS,
    source: "practice",
    lastPracticedAt: NOW - 10 * DAY,
    ...over,
  });

  test("eligibility: fluent + stale + not recently refreshed", () => {
    expect(eligibleForTuneup(cand({ skillKey: "a" }), NOW)).toBe(true);
    // rep below fluent → out
    expect(eligibleForTuneup(cand({ skillKey: "b", repetition: FLUENT_REPS - 1 }), NOW)).toBe(false);
    // practiced within the recent window → out
    expect(eligibleForTuneup(cand({ skillKey: "c", lastPracticedAt: NOW - 1 * DAY }), NOW)).toBe(false);
    // implicitly refreshed within the recent window → out
    expect(
      eligibleForTuneup(cand({ skillKey: "d", lastImplicitAt: NOW - 1 * DAY }), NOW),
    ).toBe(false);
    // never practiced (no timestamp) → out
    expect(eligibleForTuneup(cand({ skillKey: "e", lastPracticedAt: undefined }), NOW)).toBe(false);
  });

  test("inferred credit outranks practice at equal age (×2)", () => {
    const sample = pickTuneupSample(
      [
        cand({ skillKey: "practiced", source: "practice", lastPracticedAt: NOW - 10 * DAY }),
        cand({ skillKey: "inferred", source: "placement", lastPracticedAt: NOW - 10 * DAY }),
      ],
      NOW,
    );
    expect(sample[0]).toBe("inferred"); // same age, but ×2 for undemonstrated credit
  });

  test("deterministic tie-break by skillKey when scores are equal", () => {
    const sample = pickTuneupSample(
      [
        cand({ skillKey: "zzz" }),
        cand({ skillKey: "aaa" }),
        cand({ skillKey: "mmm" }),
      ],
      NOW,
    );
    expect(sample).toEqual(["aaa", "mmm", "zzz"]);
  });

  test("caps at TUNEUP_SIZE", () => {
    const many = Array.from({ length: TUNEUP_SIZE + 4 }, (_, i) =>
      cand({ skillKey: `k${i}`, lastPracticedAt: NOW - (20 + i) * DAY }),
    );
    expect(pickTuneupSample(many, NOW)).toHaveLength(TUNEUP_SIZE);
  });
});

// ── Backend wiring ──────────────────────────────────────────────────────────
async function seedScholar(t: ReturnType<typeof convexTest>, username: string) {
  return await t.run(async (ctx) =>
    ctx.db.insert("users", { name: `Test ${username}`, username, role: "scholar" }),
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

/** Seed `n` eligible (fluent, stale) mastery rows for a scholar. */
async function seedEligible(
  t: ReturnType<typeof convexTest>,
  scholarId: Id<"users">,
  n: number,
) {
  const now = Date.now();
  await t.run(async (ctx) => {
    for (let i = 0; i < n; i++) {
      await ctx.db.insert("practiceMastery", {
        scholarId,
        skillKey: `sk_${i}`,
        domain: DOMAIN,
        repetition: FLUENT_REPS,
        halfLifeDays: 30,
        lastPracticedAt: now - (10 + i) * DAY,
        frontier: false,
        source: i % 2 === 0 ? "placement" : "practice",
        updatedAt: now,
      });
    }
  });
}

describe("practiceTuneups — offerForScholar gating", () => {
  test("no offer below the minimum pool", async () => {
    const t = convexTest(schema, modules);
    const scholar = await seedScholar(t, "tu_small");
    const asScholar = await asUser(t, scholar);
    await seedEligible(t, scholar, 5); // < TUNEUP_MIN_POOL (6)
    const offer = await asScholar.query(api.practiceTuneups.offerForScholar, {
      scholarId: scholar,
      domain: DOMAIN,
    });
    expect(offer).toBeNull();
  });

  test("offers TUNEUP_SIZE skills once the pool is large enough", async () => {
    const t = convexTest(schema, modules);
    const scholar = await seedScholar(t, "tu_ok");
    const asScholar = await asUser(t, scholar);
    await seedEligible(t, scholar, 8);
    const offer = await asScholar.query(api.practiceTuneups.offerForScholar, {
      scholarId: scholar,
      domain: DOMAIN,
    });
    expect(offer).not.toBeNull();
    expect(offer!.count).toBe(TUNEUP_SIZE);
    expect(offer!.skillKeys).toHaveLength(TUNEUP_SIZE);
  });

  test("no offer within the interval of the last started tune-up", async () => {
    const t = convexTest(schema, modules);
    const scholar = await seedScholar(t, "tu_recent");
    const asScholar = await asUser(t, scholar);
    await seedEligible(t, scholar, 8);
    await t.run(async (ctx) => {
      await ctx.db.insert("practiceTuneups", {
        scholarId: scholar,
        domain: DOMAIN,
        skillKeys: ["sk_0"],
        startedAt: Date.now() - 1 * DAY, // well inside the 7-day interval
        total: 1,
      });
    });
    const offer = await asScholar.query(api.practiceTuneups.offerForScholar, {
      scholarId: scholar,
      domain: DOMAIN,
    });
    expect(offer).toBeNull();
  });

  test("offers again once the interval has elapsed", async () => {
    const t = convexTest(schema, modules);
    const scholar = await seedScholar(t, "tu_elapsed");
    const asScholar = await asUser(t, scholar);
    await seedEligible(t, scholar, 8);
    await t.run(async (ctx) => {
      await ctx.db.insert("practiceTuneups", {
        scholarId: scholar,
        domain: DOMAIN,
        skillKeys: ["sk_0"],
        startedAt: Date.now() - 10 * DAY, // older than the 7-day interval
        completedAt: Date.now() - 10 * DAY,
        total: 1,
        correctCount: 1,
      });
    });
    const offer = await asScholar.query(api.practiceTuneups.offerForScholar, {
      scholarId: scholar,
      domain: DOMAIN,
    });
    expect(offer).not.toBeNull();
  });
});

describe("practiceTuneups — start + complete", () => {
  test("start inserts a row; a second start inside the interval throws", async () => {
    const t = convexTest(schema, modules);
    const scholar = await seedScholar(t, "tu_start");
    const asScholar = await asUser(t, scholar);
    await seedEligible(t, scholar, 8);

    const { tuneupId } = await asScholar.mutation(api.practiceTuneups.start, {
      scholarId: scholar,
      domain: DOMAIN,
      skillKeys: ["sk_0", "sk_2", "sk_4"],
    });
    expect(tuneupId).toBeDefined();
    const row = await t.run(async (ctx) => ctx.db.get(tuneupId));
    expect(row!.total).toBe(3);
    expect(row!.completedAt).toBeUndefined();

    await expect(
      asScholar.mutation(api.practiceTuneups.start, {
        scholarId: scholar,
        domain: DOMAIN,
        skillKeys: ["sk_0"],
      }),
    ).rejects.toThrow();
  });

  test("complete patches the result and is idempotent", async () => {
    const t = convexTest(schema, modules);
    const scholar = await seedScholar(t, "tu_complete");
    const asScholar = await asUser(t, scholar);
    await seedEligible(t, scholar, 8);

    const { tuneupId } = await asScholar.mutation(api.practiceTuneups.start, {
      scholarId: scholar,
      domain: DOMAIN,
      skillKeys: ["sk_0", "sk_2"],
    });
    await asScholar.mutation(api.practiceTuneups.complete, { tuneupId, correctCount: 2 });
    const first = await t.run(async (ctx) => ctx.db.get(tuneupId));
    expect(first!.completedAt).toBeDefined();
    expect(first!.correctCount).toBe(2);

    // second call is a no-op — the first completion wins.
    await asScholar.mutation(api.practiceTuneups.complete, { tuneupId, correctCount: 0 });
    const second = await t.run(async (ctx) => ctx.db.get(tuneupId));
    expect(second!.correctCount).toBe(2);
    expect(second!.completedAt).toBe(first!.completedAt);
  });

  test("complete clamps correctCount into [0, total]", async () => {
    const t = convexTest(schema, modules);

    // Over the ceiling → clamped down to `total`.
    const over = await seedScholar(t, "tu_clamp_over");
    const asOver = await asUser(t, over);
    await seedEligible(t, over, 8);
    const started = await asOver.mutation(api.practiceTuneups.start, {
      scholarId: over,
      domain: DOMAIN,
      skillKeys: ["sk_0", "sk_2"], // total = 2
    });
    await asOver.mutation(api.practiceTuneups.complete, {
      tuneupId: started.tuneupId,
      correctCount: 99,
    });
    const overRow = await t.run(async (ctx) => ctx.db.get(started.tuneupId));
    expect(overRow!.correctCount).toBe(2);

    // Below the floor → clamped up to 0.
    const under = await seedScholar(t, "tu_clamp_under");
    const asUnder = await asUser(t, under);
    await seedEligible(t, under, 8);
    const started2 = await asUnder.mutation(api.practiceTuneups.start, {
      scholarId: under,
      domain: DOMAIN,
      skillKeys: ["sk_0", "sk_2"],
    });
    await asUnder.mutation(api.practiceTuneups.complete, {
      tuneupId: started2.tuneupId,
      correctCount: -5,
    });
    const underRow = await t.run(async (ctx) => ctx.db.get(started2.tuneupId));
    expect(underRow!.correctCount).toBe(0);
  });

  test("complete rejects a non-owner, non-teacher caller", async () => {
    const t = convexTest(schema, modules);
    const owner = await seedScholar(t, "tu_owner");
    const stranger = await seedScholar(t, "tu_stranger");
    const asOwner = await asUser(t, owner);
    const asStranger = await asUser(t, stranger);
    await seedEligible(t, owner, 8);

    const { tuneupId } = await asOwner.mutation(api.practiceTuneups.start, {
      scholarId: owner,
      domain: DOMAIN,
      skillKeys: ["sk_0"],
    });
    await expect(
      asStranger.mutation(api.practiceTuneups.complete, { tuneupId, correctCount: 1 }),
    ).rejects.toThrow();
  });
});
