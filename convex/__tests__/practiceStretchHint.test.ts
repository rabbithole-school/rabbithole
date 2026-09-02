/**
 * Serve-side tests for `practiceSession`'s `stretchHint` wiring (the Stretch
 * playlist tile → challenge lane standing home, follow-up to #979/#983).
 *
 * Contract verified:
 *   1. `stretchHint: true` + non-empty challenge tail → items = due reviews
 *      first (unchanged) + challenge-tail items (lane "challenge"); the
 *      required frontier items are NOT in the set (they're in the opt-in tail).
 *   2. `stretchHint: true` + empty challenge tail (no grade band active) →
 *      same items as without `stretchHint` (graceful fall-through).
 *   3. The `challenge` field is empty when `stretchHint` is set and the tail
 *      is non-empty (challenge items are promoted into `items`; no double-serve).
 */

import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "../schema";
import { api, internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import { FLUENT_REPS } from "../lib/practice/scheduler";

const modules = (
  import.meta as ImportMeta & {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("../**/*.ts");

async function seedScholar(t: ReturnType<typeof convexTest>, username = "stretch_hint_scholar") {
  return await t.run(async (ctx) =>
    ctx.db.insert("users", { name: "Stretch Hint Scholar", username, role: "scholar" }),
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

describe("practiceSession — stretchHint wiring (Stretch tile → challenge lane)", () => {
  test("stretchHint with non-empty challenge tail: items = reviews-first + challenge-tail; challenge field is empty", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.practiceSkills.seedGraph, {});
    const scholar = await seedScholar(t);
    const asScholar = await asUser(t, scholar);
    const domain = "whole-number-arithmetic";

    // Patch 2 direct dependents of count_to_10 to grade 8 — above any realistic
    // scholar ceiling once the root is fluent-plus (ceiling ≈ grade 1). Uses
    // .filter() to avoid withIndex type-inference issues in standalone helpers.
    await t.run(async (ctx) => {
      for (const key of ["count_to_100_tens", "count_to_20"]) {
        const node = await ctx.db
          .query("knowledgeNodes")
          .filter((q) => q.eq(q.field("nodeKey"), key))
          .first();
        if (node) await ctx.db.patch(node._id, { grade: "8" });
      }
    });
    // Make count_to_10 demonstrated-fluent so its dependents open on the frontier.
    for (let i = 0; i < FLUENT_REPS + 1; i++) {
      await t.mutation(internal.practiceSkills.recordAttemptInternal, {
        scholarId: scholar,
        skillKey: "count_to_10",
        correct: true,
      });
    }

    // Baseline: the regular session has challenge items in the tail.
    const baseline = await asScholar.query(api.practiceSkills.practiceSession, {
      scholarId: scholar,
      size: 8,
      seed: 42,
      domain,
    });
    expect(baseline.challenge.length).toBeGreaterThan(0);

    const ABOVE_BAND = new Set(["count_to_100_tens", "count_to_20"]);

    // stretchHint session: above-band items ARE in `items`, NOT in `challenge`.
    const stretch = await asScholar.query(api.practiceSkills.practiceSession, {
      scholarId: scholar,
      size: 8,
      seed: 42,
      domain,
      stretchHint: true,
    });

    // The challenge field is drained — items are promoted into the session.
    expect(stretch.challenge).toHaveLength(0);

    // At least one challenge item now appears in `items`.
    const challengeInItems = stretch.items.filter((it) => ABOVE_BAND.has(it.skillKey));
    expect(challengeInItems.length).toBeGreaterThan(0);

    // Every item in the stretch session that is above-band carries lane "challenge".
    for (const it of challengeInItems) {
      expect(it.lane).toBe("challenge");
    }

    // No above-band items appear in the required (non-stretch) baseline items.
    for (const it of baseline.items) {
      expect(ABOVE_BAND.has(it.skillKey)).toBe(false);
    }

    // Reviews precede any challenge items (priority order is preserved).
    const firstChallengeIdx = stretch.items.findIndex((it) => it.lane === "challenge");
    if (firstChallengeIdx > 0) {
      const itemsBeforeChallenge = stretch.items.slice(0, firstChallengeIdx);
      for (const it of itemsBeforeChallenge) {
        expect(it.lane).not.toBe("challenge");
      }
    }

    // Segments include a "stretch" segment covering the challenge items.
    const stretchSegments = stretch.segments?.filter((s) => s.kind === "stretch") ?? [];
    expect(stretchSegments.length).toBeGreaterThan(0);
    const stretchItemCount = stretchSegments.reduce((n, s) => n + s.count, 0);
    expect(stretchItemCount).toBe(challengeInItems.length);
  });

  test("stretchHint with empty challenge tail (no grade band): items are the same as the normal session", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.practiceSkills.seedGraph, {});
    // No grade level → no band active → challenge tail is always empty.
    const scholar = await seedScholar(t, "stretch_hint_no_band");
    const asScholar = await asUser(t, scholar);
    const domain = "whole-number-arithmetic";

    const normal = await asScholar.query(api.practiceSkills.practiceSession, {
      scholarId: scholar,
      size: 6,
      seed: 99,
      domain,
    });
    const withHint = await asScholar.query(api.practiceSkills.practiceSession, {
      scholarId: scholar,
      size: 6,
      seed: 99,
      domain,
      stretchHint: true,
    });

    // No challenge tail → stretchHint is a no-op; items are identical.
    expect(normal.challenge).toHaveLength(0);
    expect(withHint.challenge).toHaveLength(0);
    expect(withHint.items.map((i) => i.skillKey)).toEqual(normal.items.map((i) => i.skillKey));
  });
});
