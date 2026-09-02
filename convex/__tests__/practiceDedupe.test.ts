/**
 * convex-test proof that recent graded-attempt identities are actually threaded
 * into `practiceSession` serving (repeat-question fix §4). The pure selector is
 * covered exhaustively in lib/__tests__/preferUnseenCandidates.test.ts; this test
 * proves the WIRING end-to-end: a same-day attempt on a served item makes that
 * exact question drop out of the very next (byte-identical-seed) session, while
 * the queued node and session length are preserved (dedupe is positional, never
 * a starvation gate).
 */

import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "../schema";
import { api, internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import { canonicalItemIdentity } from "../lib/practice/session";

const modules = (
  import.meta as ImportMeta & {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("../**/*.ts");

// A templated whole-number node with plenty of distinct rendered variants, so a
// single recently-seen identity leaves many unseen alternatives to swap in.
const SKILL = "add_within_5";

async function seedScholar(t: ReturnType<typeof convexTest>) {
  const userId = await t.run((ctx) =>
    ctx.db.insert("users", { name: "Dedupe Scholar", username: "dedupe_scholar", role: "scholar" }),
  );
  const sessionId = await t.run((ctx) => {
    const session: Omit<Doc<"authSessions">, "_id" | "_creationTime"> = {
      userId,
      expirationTime: Date.now() + 3_600_000,
    };
    return ctx.db.insert("authSessions", session);
  });
  const asScholar = t.withIdentity({
    subject: `${userId}|${sessionId}`,
    issuer: "https://convex.dev",
  });
  return { userId, asScholar };
}

describe("practiceSession — recent-serve dedupe threading", () => {
  test("a same-day attempt makes that exact template item drop out of the next session", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.practiceSkills.seedGraph, {});
    const { userId, asScholar } = await seedScholar(t);

    // Scope to one templated skill so every served item is a template item for
    // SKILL — deterministic in `seed`.
    const args = { scholarId: userId, seed: 4242, size: 5, skillKeys: [SKILL] };

    const first = await asScholar.query(api.practiceSkills.practiceSession, args);
    expect(first.items.length).toBeGreaterThan(0);
    expect(first.items.every((it) => it.skillKey === SKILL)).toBe(true);

    // Control: with no recent attempts, the same seed serves the same set.
    const firstAgain = await asScholar.query(api.practiceSkills.practiceSession, args);
    expect(firstAgain.items.map((it) => it.itemId)).toEqual(
      first.items.map((it) => it.itemId),
    );

    // Record a GRADED attempt on the first served item (same-day).
    const target = first.items[0];
    const targetIdentity = canonicalItemIdentity(target.itemId);
    await t.run((ctx) =>
      ctx.db.insert("practiceAttempts", {
        scholarId: userId as Id<"users">,
        nodeKey: SKILL,
        itemId: target.itemId,
        correct: true,
        createdAt: Date.now(),
      }),
    );

    const second = await asScholar.query(api.practiceSkills.practiceSession, args);

    // Threading proof: the recently-attempted identity is gone from the next
    // session (it WAS present before), ...
    const secondIdentities = second.items.map((it) => canonicalItemIdentity(it.itemId));
    expect(secondIdentities).not.toContain(targetIdentity);
    // ...while the node and session length are preserved (positional swap).
    expect(second.items.length).toBe(first.items.length);
    expect(second.items.every((it) => it.skillKey === SKILL)).toBe(true);
  });

  test("an attempt OUTSIDE the recent-serve window does not perturb serving", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.practiceSkills.seedGraph, {});
    const { userId, asScholar } = await seedScholar(t);
    const args = { scholarId: userId, seed: 4242, size: 5, skillKeys: [SKILL] };

    const first = await asScholar.query(api.practiceSkills.practiceSession, args);
    await t.run((ctx) =>
      ctx.db.insert("practiceAttempts", {
        scholarId: userId as Id<"users">,
        nodeKey: SKILL,
        itemId: first.items[0].itemId,
        correct: true,
        // Four days ago — beyond RECENT_DEDUPE_WINDOW_MS (3 days).
        createdAt: Date.now() - 4 * 24 * 60 * 60 * 1000,
      }),
    );

    const second = await asScholar.query(api.practiceSkills.practiceSession, args);
    expect(second.items.map((it) => it.itemId)).toEqual(first.items.map((it) => it.itemId));
  });
});

/**
 * The STORED-item path — the pilot9 J10 §a failure. A conceptual node like
 * `partition_shapes` is served from a finite pool of verified LLM
 * `practiceItems` (`gen#<id>` identity), NOT a template. `by_skill` returns those
 * rows in stable insertion order, and with an
 * empty recent set `preferUnseenCandidates` deterministically re-serves the
 * first-inserted rows — so the same concrete instance re-appeared day after day.
 * The reported case (the "Maya collected 24 seashells…" problem) was served on
 * CONSECUTIVE days (>24h apart) and then counted toward "skill earned". These
 * tests pin the widened window: a stored instance attempted ~30h ago (a
 * consecutive-day serve — INSIDE the 3-day window, OUTSIDE the old 24h one) is
 * NOT re-served while the pool still has unseen alternatives; an instance
 * attempted beyond the window is free to recur.
 */
describe("practiceSession — stored conceptual-item consecutive-day dedupe", () => {
  // A pre-warmed conceptual node: no template, so every served item is a stored
  // gen# item drawn from the pool below.
  const STORED_SKILL = "partition_shapes";
  const DOMAIN = "fraction-arithmetic";

  async function seedPool(t: ReturnType<typeof convexTest>, n: number): Promise<string[]> {
    // n distinct verified word problems for the skill (deterministic, no LLM).
    return t.run(async (ctx) => {
      const ids: string[] = [];
      for (let i = 0; i < n; i++) {
        const id = await ctx.db.insert("practiceItems", {
          skillKey: STORED_SKILL,
          domain: DOMAIN,
          stem: `Word problem ${i}: a crab found ${10 + i} shells and lost 3. How many left?`,
          answerType: "integer",
          answerCanonical: `${7 + i}`,
          verifierKind: "arithmetic",
          source: "generated",
          verifiedAt: Date.now(),
        });
        ids.push(`gen#${id}`);
      }
      return ids;
    });
  }

  test("a stored instance attempted ~30h ago (consecutive day) is NOT re-served", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.practiceSkills.seedGraph, {});
    const { userId, asScholar } = await seedScholar(t);
    await seedPool(t, 5);

    const args = {
      scholarId: userId,
      seed: 4242,
      size: 5,
      domain: DOMAIN,
      skillKeys: [STORED_SKILL],
    };

    const first = await asScholar.query(api.practiceSkills.practiceSession, args);
    // Every served item is a stored gen# item for the (template-less) skill.
    expect(first.items.length).toBeGreaterThan(0);
    expect(first.items.every((it) => it.skillKey === STORED_SKILL)).toBe(true);
    expect(first.items.every((it) => it.itemId.startsWith("gen#"))).toBe(true);
    const firstIds = first.items.map((it) => it.itemId);

    // Grade those exact instances ~30h ago: a CONSECUTIVE-DAY serve — inside the
    // widened 3-day window, but outside the old 24h window that let it recur.
    const thirtyHoursAgo = Date.now() - 30 * 60 * 60 * 1000;
    await t.run(async (ctx) => {
      for (const itemId of firstIds) {
        await ctx.db.insert("practiceAttempts", {
          scholarId: userId as Id<"users">,
          nodeKey: STORED_SKILL,
          itemId,
          correct: true,
          createdAt: thirtyHoursAgo,
        });
      }
    });

    const second = await asScholar.query(api.practiceSkills.practiceSession, args);
    const secondIds = second.items.map((it) => it.itemId);

    // Core invariant: no identical concrete instance served twice in-window.
    for (const seenId of firstIds) expect(secondIds).not.toContain(seenId);
    // …while the node is still served from its pool (dedupe is not a gate).
    expect(second.items.length).toBeGreaterThan(0);
    expect(second.items.every((it) => it.skillKey === STORED_SKILL)).toBe(true);
  });

  test("a stored instance attempted 4 days ago (outside the window) MAY recur", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.practiceSkills.seedGraph, {});
    const { userId, asScholar } = await seedScholar(t);
    await seedPool(t, 5);
    const args = {
      scholarId: userId,
      seed: 4242,
      size: 5,
      domain: DOMAIN,
      skillKeys: [STORED_SKILL],
    };

    const first = await asScholar.query(api.practiceSkills.practiceSession, args);
    const firstIds = first.items.map((it) => it.itemId);
    await t.run(async (ctx) => {
      for (const itemId of firstIds) {
        await ctx.db.insert("practiceAttempts", {
          scholarId: userId as Id<"users">,
          nodeKey: STORED_SKILL,
          itemId,
          correct: true,
          // Beyond the 3-day window → not in the recent set.
          createdAt: Date.now() - 4 * 24 * 60 * 60 * 1000,
        });
      }
    });

    // Serving is byte-identical to the first (the boundary that the widened
    // window turns ON for the ~30h case above).
    const second = await asScholar.query(api.practiceSkills.practiceSession, args);
    expect(second.items.map((it) => it.itemId)).toEqual(firstIds);
  });
});
