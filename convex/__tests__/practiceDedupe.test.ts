/**
 * convex-test proof that recent graded-attempt identities are actually threaded
 * into `practiceSession` serving (repeat-question fix §4). The pure selector is
 * covered exhaustively in lib/__tests__/preferUnseenCandidates.test.ts; this test
 * proves the WIRING end-to-end: a same-day attempt on a served item makes that
 * exact question drop out of the very next (byte-identical-seed) session, while
 * the queued node and session length are preserved (dedupe is positional, never
 * a starvation gate).
 */

import { convexTest, type TestConvex } from "convex-test";
import { beforeAll, describe, expect, test } from "vitest";
import schema from "../schema";
import { api, internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import { canonicalItemIdentity } from "../lib/practice/session";

const modules = (
  import.meta as ImportMeta & {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("../**/*.ts");

let sharedT: TestConvex<typeof schema>;

beforeAll(async () => {
  sharedT = convexTest(schema, modules);
  await sharedT.mutation(internal.practiceSkills.seedGraph, {});
});

function sharedSeeded() {
  return sharedT;
}

async function freshSeeded() {
  const t = convexTest(schema, modules);
  await t.mutation(internal.practiceSkills.seedGraph, {});
  return t;
}

// A templated whole-number node with plenty of distinct rendered variants, so a
// single recently-seen identity leaves many unseen alternatives to swap in.
const SKILL = "add_within_5";

let scholarCounter = 0;

async function seedScholar(t: TestConvex<typeof schema>) {
  const username = `dedupe_scholar_${++scholarCounter}`;
  const userId = await t.run((ctx) =>
    ctx.db.insert("users", { name: "Dedupe Scholar", username, role: "scholar" }),
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
    const t = sharedSeeded();
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
    const t = sharedSeeded();
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

  async function seedPool(t: TestConvex<typeof schema>, n: number): Promise<string[]> {
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
    const t = await freshSeeded();
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
    const t = await freshSeeded();
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

/**
 * Review rotation. A review usually comes back DAYS after the skill's last
 * serve — past the 3-day window above — and the stored pool's index order is
 * the same on every serve, so before this fix a review re-served the pool's
 * first row every time, the row just missed included. Serving now orders a
 * REVIEW skill's stored pool least-recently-seen first from the scholar's own
 * attempts on that skill. Frontier work is untouched.
 */
describe("practiceSession — stored items rotate across reviews", () => {
  const STORED_SKILL = "partition_shapes";
  const DOMAIN = "fraction-arithmetic";
  const DAY_MS = 24 * 60 * 60 * 1000;
  // Past RECENT_DEDUPE_WINDOW_MS, so only the per-skill history can rotate.
  const LONG_AGO = Date.now() - 5 * DAY_MS;

  async function seedPool(t: TestConvex<typeof schema>, n: number): Promise<string[]> {
    return t.run(async (ctx) => {
      const ids: string[] = [];
      for (let i = 0; i < n; i++) {
        const id = await ctx.db.insert("practiceItems", {
          skillKey: STORED_SKILL,
          domain: DOMAIN,
          stem: `Rotation problem ${i}: cut a pizza into ${2 + i} equal slices. How many slices?`,
          answerType: "integer",
          answerCanonical: `${2 + i}`,
          verifierKind: "arithmetic",
          source: "generated",
          verifiedAt: Date.now(),
        });
        ids.push(`gen#${id}`);
      }
      return ids;
    });
  }

  // A demonstrated skill whose retention has long decayed: due, so it is
  // queued as a REVIEW.
  async function seedDueReview(t: TestConvex<typeof schema>, userId: Id<"users">) {
    await t.run((ctx) =>
      ctx.db.insert("practiceMastery", {
        scholarId: userId,
        skillKey: STORED_SKILL,
        domain: DOMAIN,
        repetition: 4,
        halfLifeDays: 1,
        lastPracticedAt: LONG_AGO,
        lastAttemptAt: LONG_AGO,
        frontier: false,
        source: "practice",
        updatedAt: LONG_AGO,
      }),
    );
  }

  async function recordAttempt(
    t: TestConvex<typeof schema>,
    userId: Id<"users">,
    itemId: string,
    correct: boolean,
    createdAt: number,
    lane?: "review",
  ) {
    await t.run((ctx) =>
      ctx.db.insert("practiceAttempts", {
        scholarId: userId,
        nodeKey: STORED_SKILL,
        itemId,
        correct,
        ...(lane ? { lane } : {}),
        createdAt,
      }),
    );
  }

  async function serveStored(
    asScholar: Awaited<ReturnType<typeof seedScholar>>["asScholar"],
    userId: Id<"users">,
    seed: number,
  ) {
    const session = await asScholar.query(api.practiceSkills.practiceSession, {
      scholarId: userId,
      seed,
      domain: DOMAIN,
    });
    return session.items.filter((it) => it.skillKey === STORED_SKILL);
  }

  test("after a review miss on item A, the next review serve is not A", async () => {
    const t = await freshSeeded();
    const { userId, asScholar } = await seedScholar(t);
    const ids = await seedPool(t, 5);
    await seedDueReview(t, userId);

    // Control: with no history the review leads with the pool's first row.
    const before = await serveStored(asScholar, userId, 11);
    expect(before.length).toBeGreaterThan(0);
    expect(before.every((it) => it.lane === "review")).toBe(true);
    expect(before[0].itemId).toBe(ids[0]);

    await recordAttempt(t, userId, ids[0], false, LONG_AGO, "review");

    const after = await serveStored(asScholar, userId, 12);
    expect(after.length).toBeGreaterThan(0);
    expect(after.map((it) => it.itemId)).not.toContain(ids[0]);
  });

  test("over several reviews the scholar meets more than one item", async () => {
    const t = await freshSeeded();
    const { userId, asScholar } = await seedScholar(t);
    const ids = await seedPool(t, 3);
    await seedDueReview(t, userId);

    const leads: string[] = [];
    for (let review = 0; review < 4; review++) {
      const served = await serveStored(asScholar, userId, 100 + review);
      const lead = served[0].itemId;
      // Never the item answered at the previous review.
      if (leads.length > 0) expect(lead).not.toBe(leads[leads.length - 1]);
      leads.push(lead);
      // Each review answered (correctly) well outside the recent-serve window.
      await recordAttempt(t, userId, lead, true, LONG_AGO + review * 60_000, "review");
    }
    // Least-recently-seen first walks the whole pool before repeating.
    expect(leads.slice(0, 3).sort()).toEqual([...ids].sort());
    expect(leads[3]).toBe(leads[0]);
  });

  test("a two-item pool: the item just answered is absent from the whole next run", async () => {
    const t = await freshSeeded();
    const { userId, asScholar } = await seedScholar(t);
    const ids = await seedPool(t, 2);
    await seedDueReview(t, userId);

    // Last answered is the pool's FIRST row, then (next review) its second.
    await recordAttempt(t, userId, ids[0], false, LONG_AGO, "review");
    const afterFirst = await serveStored(asScholar, userId, 21);
    expect(afterFirst.map((it) => it.itemId)).toEqual([ids[1]]);

    await recordAttempt(t, userId, ids[1], false, LONG_AGO + 60_000, "review");
    const afterSecond = await serveStored(asScholar, userId, 22);
    expect(afterSecond.map((it) => it.itemId)).toEqual([ids[0]]);
  });

  test("a just-missed skill still leads with worked steps: rotation stays inside the stepped rows", async () => {
    const t = await freshSeeded();
    const { userId, asScholar } = await seedScholar(t);
    const steps = [
      { text: "Count the equal parts: 4.", blankText: "Count the equal parts: ___" },
      { text: "Each part is one fourth.", blankText: "Each part is one ___" },
      { text: "So the shape has 4 fourths.", blankText: "So the shape has ___ fourths" },
    ];
    // Pool order: A (steps), C (steps), B (bare, never seen).
    const [a, c, b] = await t.run(async (ctx) => {
      const ids: string[] = [];
      for (const [i, withSteps] of [true, true, false].entries()) {
        const id = await ctx.db.insert("practiceItems", {
          skillKey: STORED_SKILL,
          domain: DOMAIN,
          stem: `Stepped rotation problem ${i}: how many fourths make a whole?`,
          answerType: "integer",
          answerCanonical: "4",
          verifierKind: "arithmetic",
          ...(withSteps ? { workedSteps: steps } : {}),
          source: "generated",
          verifiedAt: Date.now(),
        });
        ids.push(`gen#${id}`);
      }
      return ids;
    });
    await seedDueReview(t, userId);
    await recordAttempt(t, userId, c, true, LONG_AGO, "review");
    // The miss that arms teach-before-re-serve: recent, no teaching since.
    await recordAttempt(t, userId, a, false, Date.now() - 60_000, "review");

    const served = await serveStored(asScholar, userId, 31);
    expect(served[0].itemId).toBe(c);
    expect(served[0].workedSteps?.revealed.length ?? 0).toBeGreaterThan(0);
    expect(served.map((it) => it.itemId)).not.toContain(a);
    expect(served[0].itemId).not.toBe(b);
  });

  test("a one-item skill still serves its item after a miss on it", async () => {
    const t = await freshSeeded();
    const { userId, asScholar } = await seedScholar(t);
    const [only] = await seedPool(t, 1);
    await seedDueReview(t, userId);
    await recordAttempt(t, userId, only, false, LONG_AGO, "review");

    const served = await serveStored(asScholar, userId, 7);
    expect(served.map((it) => it.itemId)).toEqual([only]);
  });

  test("frontier work is unchanged: an old attempt does not reorder a frontier skill's pool", async () => {
    const t = await freshSeeded();
    const { userId, asScholar } = await seedScholar(t);
    const ids = await seedPool(t, 5);
    // No mastery row: the skill is new frontier work, not a review.
    await recordAttempt(t, userId, ids[0], false, LONG_AGO);

    const served = await serveStored(asScholar, userId, 11);
    expect(served.length).toBeGreaterThan(0);
    expect(served.every((it) => it.lane !== "review")).toBe(true);
    expect(served[0].itemId).toBe(ids[0]);
  });
});
