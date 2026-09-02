/**
 * B5 — the self-relative latency baseline on `practiceMastery` (raise-the-
 * ceiling plan §5). Verifies submitAnswer's clamp + the ring-buffer/median/MAD
 * bookkeeping in recordAttemptCore, WITHOUT reaching into scheduler.ts (owned
 * by a parallel lane) — these tests only exercise the public submitAnswer
 * surface + direct reads of the practiceMastery row.
 */
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "../schema";
import { api, internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import { gradeTemplateItem } from "../lib/practice/session";

const modules = (import.meta as ImportMeta & { glob: (p: string) => Record<string, () => Promise<unknown>> }).glob("../**/*.ts");

async function seedScholar(t: ReturnType<typeof convexTest>, username = "latencyscholar") {
  return await t.run(async (ctx) =>
    ctx.db.insert("users", { name: "Latency Scholar", username, role: "scholar" }),
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

async function masteryRow(t: ReturnType<typeof convexTest>, scholar: Id<"users">, skillKey: string) {
  const rows = await t.run(async (ctx) => ctx.db.query("practiceMastery").collect());
  return rows.find((r) => r.scholarId === scholar && r.skillKey === skillKey) ?? null;
}

async function attemptRow(t: ReturnType<typeof convexTest>, itemId: string) {
  const rows = await t.run(async (ctx) => ctx.db.query("practiceAttempts").collect());
  return rows.find((row) => row.itemId === itemId) ?? null;
}

/** Submit a correct answer to a fresh session item, with the given first-key
 * latency reading. Returns the graded result. */
async function submitCorrectWithLatency(
  t: ReturnType<typeof convexTest>,
  asScholar: Awaited<ReturnType<typeof asUser>>,
  scholar: Id<"users">,
  seed: number,
  firstKeyMs: number | undefined,
) {
  const session = await asScholar.query(api.practiceSkills.practiceSession, { scholarId: scholar, size: 1, seed });
  const item = session.items[0];
  const truth = gradeTemplateItem(item.itemId, "0");
  const res = await asScholar.mutation(api.practiceSkills.submitAnswer, {
    scholarId: scholar,
    itemId: item.itemId,
    answer: truth!.correctAnswer,
    firstKeyMs,
    elapsedMs: firstKeyMs !== undefined ? firstKeyMs + 500 : undefined,
  });
  return { res, skillKey: item.skillKey, itemId: item.itemId };
}

describe("practiceMastery — self-relative latency baseline (B5)", () => {
  test("a valid firstKeyMs populates the ring buffer + median + spread", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.practiceSkills.seedGraph, {});
    const scholar = await seedScholar(t);
    const asScholar = await asUser(t, scholar);

    const { res, skillKey } = await submitCorrectWithLatency(t, asScholar, scholar, 7, 2_000);
    expect(res.correct).toBe(true);

    const row = await masteryRow(t, scholar, skillKey);
    expect(row?.latencySamplesMs).toEqual([2_000]);
    expect(row?.latencyMedianMs).toBe(2_000);
    expect(row?.latencySpreadMs).toBe(0);
  });

  test("out-of-range firstKeyMs is ignored — no sample stored", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.practiceSkills.seedGraph, {});
    const scholar = await seedScholar(t);
    const asScholar = await asUser(t, scholar);

    // Below the 300ms floor (implausibly fast — noise, not a real reading).
    const tooFast = await submitCorrectWithLatency(t, asScholar, scholar, 11, 50);
    expect(tooFast.res.correct).toBe(true);
    const rowFast = await masteryRow(t, scholar, tooFast.skillKey);
    expect(rowFast?.latencySamplesMs ?? []).toEqual([]);
    expect(rowFast?.latencyMedianMs).toBeUndefined();
    expect(await attemptRow(t, tooFast.itemId)).toMatchObject({
      elapsedMs: 550,
      firstKeyMsCensored: { observedMs: 50, reason: "below_min" },
    });
    expect((await attemptRow(t, tooFast.itemId))?.firstKeyMs).toBeUndefined();

    // Above the 120s ceiling (a backgrounded tab, not a real reading).
    const tooSlow = await submitCorrectWithLatency(t, asScholar, scholar, 12, 200_000);
    expect(tooSlow.res.correct).toBe(true);
    const rowSlow = await masteryRow(t, scholar, tooSlow.skillKey);
    expect(rowSlow?.latencySamplesMs ?? []).toEqual([]);
    expect(rowSlow?.latencyMedianMs).toBeUndefined();
    expect(await attemptRow(t, tooSlow.itemId)).toMatchObject({
      elapsedMs: 200_500,
      firstKeyMsCensored: { observedMs: 200_000, reason: "above_max" },
    });
    expect((await attemptRow(t, tooSlow.itemId))?.firstKeyMs).toBeUndefined();

    // No reading at all (e.g. a reveal / voice path) — also gracefully a no-op.
    const noReading = await submitCorrectWithLatency(t, asScholar, scholar, 13, undefined);
    expect(noReading.res.correct).toBe(true);
    const rowNone = await masteryRow(t, scholar, noReading.skillKey);
    expect(rowNone?.latencySamplesMs ?? []).toEqual([]);
  });

  test("the ring buffer caps at 10 samples — oldest dropped", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.practiceSkills.seedGraph, {});
    const scholar = await seedScholar(t);
    const asScholar = await asUser(t, scholar);

    // Force every attempt onto the SAME skill so samples accumulate on one row
    // — drive the ring buffer through submitAnswer against directly-inserted
    // generated items on the same skill, one latency reading per submission,
    // 1000ms apart so the expected drop-oldest order is legible.
    const skillKey = "count_to_10"; // the root — always present after seedGraph.
    for (let i = 1; i <= 12; i++) {
      const itemId = await t.run(async (ctx) =>
        ctx.db.insert("practiceItems", {
          skillKey,
          domain: "whole-number-arithmetic",
          stem: `probe ${i}`,
          answerType: "integer",
          answerCanonical: "1",
          source: "generated",
          verifiedAt: Date.now(),
        }),
      );
      await asScholar.mutation(api.practiceSkills.submitAnswer, {
        scholarId: scholar,
        itemId: `gen#${itemId}`,
        answer: "1",
        firstKeyMs: 1_000 * i, // 1000, 2000, …, 12000
      });
    }

    const row = await masteryRow(t, scholar, skillKey);
    expect(row?.latencySamplesMs).toHaveLength(10);
    // Oldest two (1000, 2000) dropped; buffer holds 3000..12000.
    expect(row?.latencySamplesMs).toEqual([3_000, 4_000, 5_000, 6_000, 7_000, 8_000, 9_000, 10_000, 11_000, 12_000]);
  });

  test("a record:false retry does NOT add a latency sample", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.practiceSkills.seedGraph, {});
    const scholar = await seedScholar(t);
    const asScholar = await asUser(t, scholar);

    const session = await asScholar.query(api.practiceSkills.practiceSession, { scholarId: scholar, size: 1, seed: 21 });
    const item = session.items[0];

    // First real (wrong) attempt: misses don't feed the baseline either
    // (correct-only — see recordAttemptCore), so no sample yet.
    const first = await asScholar.mutation(api.practiceSkills.submitAnswer, {
      scholarId: scholar,
      itemId: item.itemId,
      answer: "-1",
      firstKeyMs: 1_500,
    });
    expect(first.correct).toBe(false);
    const afterFirst = await masteryRow(t, scholar, item.skillKey);
    expect(afterFirst?.latencySamplesMs ?? []).toEqual([]);

    // A grade-only retry with a "valid" latency reading — must not touch the
    // baseline (or anything else on the row) at all.
    const truth = gradeTemplateItem(item.itemId, "0");
    const retry = await asScholar.mutation(api.practiceSkills.submitAnswer, {
      scholarId: scholar,
      itemId: item.itemId,
      answer: truth!.correctAnswer,
      record: false,
      firstKeyMs: 3_000,
    });
    expect(retry.correct).toBe(true);
    const afterRetry = await masteryRow(t, scholar, item.skillKey);
    expect(afterRetry?.latencySamplesMs ?? []).toEqual([]);
    expect(afterRetry?.updatedAt).toBe(afterFirst?.updatedAt);
  });

  test("median + MAD are computed correctly on a known sample set", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.practiceSkills.seedGraph, {});
    const scholar = await seedScholar(t);
    const asScholar = await asUser(t, scholar);
    const skillKey = "count_to_10";

    // Known set: 1000, 2000, 3000, 4000, 5000 → median 3000.
    // Deviations from median: 2000, 1000, 0, 1000, 2000 → sorted 0,1000,1000,2000,2000
    // → MAD (median of deviations) = 1000.
    const readings = [1_000, 2_000, 3_000, 4_000, 5_000];
    for (const [i, ms] of readings.entries()) {
      const itemId = await t.run(async (ctx) =>
        ctx.db.insert("practiceItems", {
          skillKey,
          domain: "whole-number-arithmetic",
          stem: `mad probe ${i}`,
          answerType: "integer",
          answerCanonical: "1",
          source: "generated",
          verifiedAt: Date.now(),
        }),
      );
      await asScholar.mutation(api.practiceSkills.submitAnswer, {
        scholarId: scholar,
        itemId: `gen#${itemId}`,
        answer: "1",
        firstKeyMs: ms,
      });
    }

    const row = await masteryRow(t, scholar, skillKey);
    expect(row?.latencySamplesMs).toEqual(readings);
    expect(row?.latencyMedianMs).toBe(3_000);
    expect(row?.latencySpreadMs).toBe(1_000);
  });
});
