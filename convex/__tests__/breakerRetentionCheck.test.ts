/**
 * Post-repair spaced reinforcement — CONTRACT tests, not new behavior.
 *
 * The practice engine already guarantees the whole "check retention later"
 * obligation for a successful breaker recovery, purely as an emergent
 * property of existing, calibrated mechanisms — no new table, flag, or
 * learner-facing primitive was needed (or added) for this file:
 *
 *   - An authoritative recovery (`breakerLifecycle.freshResult.correct ===
 *     true`) is graded through the SAME `recordAttemptCore` → `applyAttempt`
 *     path as any ordinary practice attempt (convex/practiceSkills.ts
 *     `submitAnswer`), so it advances `repetition` and refreshes
 *     `halfLifeDays` exactly like a normal correct answer — no bypass, no
 *     second mastery model.
 *   - `dueAt`/`isDue` (convex/lib/practice/scheduler.ts) already compute a
 *     real, calibrated delay from those (existing) retention constants —
 *     never an arbitrary new magic interval.
 *   - `computeFrontier` already excludes any skill at/above `FLUENT_REPS`
 *     (`isFluentPlus`), so an established skill recovered via the breaker
 *     can ONLY resurface through the "due" review lane, never immediate
 *     frontier re-serve of the same prompt.
 *   - `recentServedIdentities` (a 3-day window, comfortably covering the
 *     ~1-day due delay below) already de-prefers both the original trigger
 *     item and the fresh recovery item when the node is served again.
 *
 * This file locks those properties in with regression coverage — the one
 * thing that was genuinely missing — for the specific breaker-recovery
 * scenario, which had no existing end-to-end test of its scheduling
 * side-effects. It intentionally adds no production code.
 */
import { convexTest } from "convex-test";
import type { TestConvex } from "convex-test";
import { afterEach, describe, expect, test, vi } from "vitest";
import schema from "../schema";
import { api, internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import { canonicalItemIdentity, gradeTemplateItem, makeItemId } from "../lib/practice/session";
import {
  applyAttempt,
  desiredRetentionTargets,
  dueAt,
  isDue,
  retention,
  type SkillState,
} from "../lib/practice/scheduler";
import { WHOLE_NUMBER_ARITHMETIC_DOMAIN } from "../seed/wholeNumberArithmeticGraph";
import {
  seedScholarInInstitution,
  seedTestInstitution,
} from "./institutionTestHelpers";

const NOW = Date.UTC(2026, 6, 27, 20, 0, 0);
const DOMAIN = WHOLE_NUMBER_ARITHMETIC_DOMAIN;
const SKILL_KEY = "count_to_10";
const TRIGGER_ITEM_ID = makeItemId(SKILL_KEY, 8675309);
const DAY_MS = 86_400_000;

// Schema-aware test-Convex handle so `t.db`/`t.run` stay strongly typed
// (the untyped `ReturnType<typeof convexTest>` default erases the schema's
// DataModel, which silently degrades every `ctx.db` call in these helpers
// to `any`-shaped ids and loses index-name/document-shape checking).
type TC = TestConvex<typeof schema>;
// Twelve hours between the trigger miss/repair and the fresh recovery
// submission. Without SOME gap, `now === lastPracticedAt` at grading time and
// `retention(prev, now)` short-circuits to exactly 1 (scheduler.ts's
// `days <= 0` branch), which zeroes `spacingCredit` and makes the `threshold`
// argument to `applyAttempt` below inert — the growth term would never
// actually vary with the real per-skill target, silently untesting the
// "half-life refreshes exactly like a normal correct answer" claim. Twelve
// hours is comfortably inside the 3-day `RECENT_DEDUPE_WINDOW_MS` the
// resurfacing-exclusion check below depends on, and `submitAnswer`'s
// breaker-fresh guard (convex/practiceSkills.ts) checks only lifecycle
// fields, never episode age, so the recovery stays valid across the gap.
const RECOVERY_DELAY_MS = 12 * 60 * 60 * 1000;
// Mirrors the private `RECENT_DEDUPE_WINDOW_MS` in convex/practiceSkills.ts
// (recentServedIdentities' exclusion window) — replicated here (not exported)
// so the resurfacing test can assert directly against the exclusion
// mechanism itself, rather than inferring correctness from the identity
// space merely being large enough that an undeduped draw would be unlikely
// to collide.
const RECENT_DEDUPE_WINDOW_MS = 3 * 24 * 60 * 60 * 1000;

/**
 * The scheduler does not grade against its bare default (`DUE_THRESHOLD`) —
 * `recordAttemptCore`/`computeDomainQueue` always compute a per-skill target
 * via `desiredRetentionTargets(skills, edges)` over the REAL domain graph
 * (convex/practiceSkills.ts `loadDomain` + its call sites). Replicate that
 * exact load here so the test's own `dueAt`/`isDue` calls use the same
 * threshold the server actually graded/served against — asserting against
 * the wrong (default) threshold would silently test a delay the server
 * never produces.
 */
async function realRetentionThreshold(t: TC): Promise<number> {
  return t.run(async (ctx) => {
    const nodes = await ctx.db
      .query("knowledgeNodes")
      .withIndex("by_domain", (q) => q.eq("domain", DOMAIN))
      .collect();
    const edgeRows = await ctx.db
      .query("knowledgeNodeEdges")
      .withIndex("by_domain", (q) => q.eq("domain", DOMAIN))
      .collect();
    const edges = edgeRows
      .filter((e) => e.kind === "buildsOn")
      .map((e) => ({ fromKey: e.fromKey, toKey: e.toKey, domain: e.domain, weight: e.weight }));
    const targets = desiredRetentionTargets(nodes.map((n) => n.nodeKey), edges);
    const threshold = targets.get(SKILL_KEY);
    if (threshold === undefined) throw new Error(`No retention target for ${SKILL_KEY}`);
    return threshold;
  });
}

/** Replicates `recentServedIdentities` (convex/practiceSkills.ts) exactly, so
 * the resurfacing test can prove directly that the actually-served item's
 * canonical identity is excluded from the SAME set the server computed at
 * serve time — not just that a fresh draw happened not to collide. */
async function recentIdentitiesAt(
  t: TC,
  scholarId: Id<"users">,
  now: number,
): Promise<Set<string>> {
  // `t.run` marshals its return value through Convex's value encoding, which
  // has no `Set` type — collect into an array inside the callback and
  // reconstruct the Set on the way out.
  const identities = await t.run(async (ctx) => {
    const since = now - RECENT_DEDUPE_WINDOW_MS;
    const rows = await ctx.db
      .query("practiceAttempts")
      .withIndex("by_scholar_createdAt", (q) =>
        q.eq("scholarId", scholarId).gte("createdAt", since),
      )
      .collect();
    const seen = new Set<string>();
    for (const r of rows) {
      if (r.itemId) seen.add(canonicalItemIdentity(r.itemId));
    }
    return Array.from(seen);
  });
  return new Set(identities);
}

const modules = (
  import.meta as ImportMeta & {
    glob: (p: string) => Record<string, () => Promise<unknown>>;
  }
).glob("../**/*.ts");

async function seedScholar(t: TC, username: string) {
  return seedScholarInInstitution(t, {
    institutionId: await seedTestInstitution(t),
    name: "Retention Scholar",
    username,
  });
}

async function asUser(t: TC, userId: Id<"users">) {
  const sessionId = await t.run(async (ctx) => {
    const session: Omit<Doc<"authSessions">, "_id" | "_creationTime"> = {
      userId,
      // Comfortably past this file's longest simulated time horizon (the
      // success-path test advances the fake clock ~1.5 days past `NOW` for
      // the calibrated recovery delay). Nothing on the practice path
      // currently validates `expirationTime`, but a short real-world-scaled
      // expiry here would be a silent tripwire if that ever changes, since
      // callers reuse one `asUser(...)` identity across a later time jump.
      expirationTime: Date.now() + 30 * 24 * 3_600_000,
    };
    return ctx.db.insert("authSessions", session);
  });
  return t.withIdentity({ subject: `${userId}|${sessionId}`, issuer: "https://convex.dev" });
}

/** An established (already fluent-plus) mastery row for the trigger skill —
 * the canonical spiral scenario: a previously-demonstrated skill starts
 * missing, not a brand-new frontier skill still building its first reps. */
async function seedEstablishedMastery(
  t: TC,
  scholarId: Id<"users">,
) {
  await t.run(async (ctx) => {
    await ctx.db.insert("practiceMastery", {
      scholarId,
      domain: DOMAIN,
      skillKey: SKILL_KEY,
      repetition: 4,
      halfLifeDays: 6,
      lastPracticedAt: NOW,
      lastAttemptAt: NOW,
      frontier: false,
      source: "practice",
      updatedAt: NOW,
    });
  });
}

/** Two fictitious misses on unrelated node keys, arming the breaker so the
 * NEXT counted miss (on the real trigger skill) crosses the threshold. */
async function seedPriorMisses(t: TC, scholarId: Id<"users">) {
  await t.run(async (ctx) => {
    for (let i = 2; i >= 1; i--) {
      await ctx.db.insert("practiceAttempts", {
        scholarId,
        nodeKey: `prior_${i}`,
        itemId: `prior_${i}`,
        correct: false,
        domain: DOMAIN,
        lane: "review",
        createdAt: NOW - i,
      });
    }
  });
}

async function masteryRow(t: TC, scholarId: Id<"users">) {
  return t.run(async (ctx) =>
    ctx.db
      .query("practiceMastery")
      .withIndex("by_scholar_skill", (q) => q.eq("scholarId", scholarId).eq("skillKey", SKILL_KEY))
      .first(),
  );
}

function asSkillState(row: Doc<"practiceMastery">): SkillState {
  return {
    repetition: row.repetition,
    halfLifeDays: row.halfLifeDays,
    lastPracticedAt: row.lastPracticedAt,
  };
}

async function triggerBreaker(t: TC, scholarId: Id<"users">) {
  const asScholar = await asUser(t, scholarId);
  const result = await asScholar.mutation(api.practiceSkills.submitAnswer, {
    scholarId,
    itemId: TRIGGER_ITEM_ID,
    answer: "999999",
  });
  const recovery = result.breakerRecovery;
  if (!recovery) throw new Error("Expected the miss to trigger breaker recovery");
  const triggerAttemptId = await t.run(async (ctx) =>
    ctx.db.normalizeId("practiceAttempts", recovery.triggerAttemptId),
  );
  if (!triggerAttemptId) throw new Error("Breaker trigger attempt ID was invalid");
  return triggerAttemptId;
}

async function completeRepair(
  t: TC,
  scholarId: Id<"users">,
  triggerAttemptId: Id<"practiceAttempts">,
) {
  const asScholar = await asUser(t, scholarId);
  for (const event of ["repair_shown", "repair_started", "repair_completed"] as const) {
    await asScholar.mutation(api.practiceSkills.recordBreakerRecoveryLifecycle, {
      scholarId,
      triggerAttemptId,
      event,
    });
  }
}

describe("breaker recovery — post-repair spaced reinforcement (contract)", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  test("an authoritative successful recovery is graded through the normal SR path, is NOT immediately re-servable, becomes due at the calibrated delay, and resurfaces with a different item", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const t = convexTest(schema, modules);
    await t.mutation(internal.practiceSkills.seedGraph, {});
    const scholar = await seedScholar(t, "breaker_retention_success");
    await seedEstablishedMastery(t, scholar);
    await seedPriorMisses(t, scholar);

    const triggerAttemptId = await triggerBreaker(t, scholar);
    await completeRepair(t, scholar, triggerAttemptId);

    const asScholar = await asUser(t, scholar);
    const recovery = await asScholar.mutation(api.practiceSkills.breakerRecoverySession, {
      scholarId: scholar,
      triggerAttemptId,
      seed: 8675311,
    });
    const freshItemId = recovery.items[0].itemId;
    // The fresh recovery item is a genuinely different item from the trigger
    // (already enforced by breakerRecoverySession/submitAnswer validation).
    // Compare CANONICAL identity, not the raw itemId: two different template
    // seeds can render the same underlying question, and it's that rendered
    // identity `recentServedIdentities` actually de-prefers against.
    expect(canonicalItemIdentity(freshItemId)).not.toBe(canonicalItemIdentity(TRIGGER_ITEM_ID));

    // Advance the clock before the fresh recovery submission — see
    // RECOVERY_DELAY_MS above for why this is load-bearing, not cosmetic.
    const recoveredAt = NOW + RECOVERY_DELAY_MS;
    await vi.setSystemTime(recoveredAt);

    const truth = gradeTemplateItem(freshItemId, "0")!.correctAnswer;
    const freshResult = await asScholar.mutation(api.practiceSkills.submitAnswer, {
      scholarId: scholar,
      itemId: freshItemId,
      answer: truth,
      breakerTriggerAttemptId: triggerAttemptId,
    });
    expect(freshResult.breakerRecoveryVerified).toBe(true);
    // Authoritative recovery is credited through the SAME scheduler path as
    // any correct practice attempt: repetition advances (4 → 5), no bypass.
    expect(freshResult.repetition).toBe(5);

    const afterRecovery = await masteryRow(t, scholar);
    expect(afterRecovery).toMatchObject({ repetition: 5, source: "practice" });
    const state = asSkillState(afterRecovery!);

    // The REAL per-skill threshold the server actually graded/serves against
    // (never the scheduler's bare default) — see `realRetentionThreshold`.
    const threshold = await realRetentionThreshold(t);
    // Independently re-derive the expected post-attempt state from the SAME
    // pure `applyAttempt` the server calls, seeded from the row this scholar
    // had right before the fresh (correct) submission — i.e. after the two
    // priming misses shrank the half-life once already. This pins the
    // assertion to a concrete, non-tautological number rather than merely
    // restating whatever the row happens to contain.
    const beforeFresh: SkillState = { repetition: 4, halfLifeDays: 3, lastPracticedAt: NOW };
    const expectedAfterRecovery = applyAttempt(beforeFresh, true, recoveredAt, threshold);
    expect(state).toEqual(expectedAfterRecovery);

    const dueTimestamp = dueAt(state, threshold);
    expect(dueTimestamp).toBeDefined();
    const delayDays = (dueTimestamp! - recoveredAt) / DAY_MS;
    // A real, calibrated, bounded delay — not immediate (same tick) and not
    // an arbitrary/unbounded interval. Cross-checked against the retention
    // curve directly (not just `dueAt`/`isDue` restating themselves) at both
    // sides of the boundary.
    expect(delayDays).toBeGreaterThan(0.1);
    expect(delayDays).toBeLessThan(10);
    expect(retention(state, dueTimestamp! - 1)).toBeGreaterThanOrEqual(threshold);
    expect(retention(state, dueTimestamp! + 1)).toBeLessThan(threshold);

    // Not immediately re-servable: right after the recovery, the skill is
    // fluent-plus (excluded from frontier) and not yet due (excluded from
    // review) — so it simply is not served at all. (A local `isDue` check
    // at this exact instant would be tautological — `now === lastPracticedAt`
    // hits `retention`'s `days <= 0` short-circuit and returns 1 regardless
    // of threshold/half-life — so the real assertion is against the actual
    // server session below.) The non-empty guard on the session itself rules
    // out the check passing vacuously because nothing served at all (e.g. an
    // unrelated gating regression).
    const immediateSession = await asScholar.query(api.practiceSkills.practiceSession, {
      scholarId: scholar,
      domain: DOMAIN,
      size: 10,
      seed: 1,
    });
    expect(immediateSession.items.length).toBeGreaterThan(0);
    expect(immediateSession.items.some((item) => item.skillKey === SKILL_KEY)).toBe(false);

    // A midpoint check against the REAL server (not just local `state` math):
    // still not due, still not served, well before the calibrated point.
    await vi.setSystemTime(recoveredAt + Math.floor((dueTimestamp! - recoveredAt) / 2));
    expect(isDue(state, Date.now(), threshold)).toBe(false);
    const midpointSession = await asScholar.query(api.practiceSkills.practiceSession, {
      scholarId: scholar,
      domain: DOMAIN,
      size: 10,
      seed: 1,
    });
    expect(midpointSession.items.length).toBeGreaterThan(0);
    expect(midpointSession.items.some((item) => item.skillKey === SKILL_KEY)).toBe(false);

    // Advance to exactly the calibrated due point (existing scheduler math,
    // no new magic interval) and confirm eligibility flips.
    await vi.setSystemTime(dueTimestamp! + 1);
    expect(isDue(state, Date.now(), threshold)).toBe(true);

    const laterSession = await asScholar.query(api.practiceSkills.practiceSession, {
      scholarId: scholar,
      domain: DOMAIN,
      size: 10,
      seed: 1,
    });
    const served = laterSession.items.find((item) => item.skillKey === SKILL_KEY);
    expect(served).toBeDefined();
    // Retention check via the existing review lane, not another breaker rung.
    expect(served!.lane).toBe("review");
    // Verify against the ACTUAL exclusion mechanism, not just a probabilistic
    // "distinct draw" inference: recompute the exact set `recentServedIdentities`
    // (convex/practiceSkills.ts) would have excluded at this serve, and assert
    // (a) it really does contain both prior identities — proving the window
    // was live, not just empty/expired — and (b) the served item's identity is
    // NOT a member. Note this pins the OUTCOME (the served item is, in fact,
    // outside the excluded set), not that the dedupe branch itself fired on
    // this draw — `dedupeAgainstRecent` only replaces a slot when the initial
    // draw already collides, so a non-colliding first draw satisfies this the
    // same way a successful dedupe would. Either way the outcome property the
    // scheduling contract cares about — never resurfacing a just-served
    // identity — genuinely holds.
    const excludedAtResurface = await recentIdentitiesAt(t, scholar, Date.now());
    expect(excludedAtResurface.has(canonicalItemIdentity(TRIGGER_ITEM_ID))).toBe(true);
    expect(excludedAtResurface.has(canonicalItemIdentity(freshItemId))).toBe(true);
    expect(excludedAtResurface.has(canonicalItemIdentity(served!.itemId))).toBe(false);
    expect(canonicalItemIdentity(served!.itemId)).not.toBe(canonicalItemIdentity(TRIGGER_ITEM_ID));
    expect(canonicalItemIdentity(served!.itemId)).not.toBe(canonicalItemIdentity(freshItemId));
  });

  test("an abandoned recovery (easy exit, no fresh result) leaves the ordinary miss scheduling untouched — no extra obligation is created", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const t = convexTest(schema, modules);
    await t.mutation(internal.practiceSkills.seedGraph, {});
    const scholar = await seedScholar(t, "breaker_retention_easy_exit");
    await seedEstablishedMastery(t, scholar);
    await seedPriorMisses(t, scholar);

    const triggerAttemptId = await triggerBreaker(t, scholar);
    const afterMiss = await masteryRow(t, scholar);
    // The miss itself already shrank the half-life (ordinary SR lapse) —
    // this happens regardless of what the recovery flow does next. Pin this
    // to the actual expected shrink (independently computed via the same
    // pure `applyAttempt`), not just the repetition count — a miss never
    // moves repetition regardless of whether the half-life math is correct,
    // so asserting repetition alone would pass even if the lapse broke.
    const priorState: SkillState = { repetition: 4, halfLifeDays: 6, lastPracticedAt: NOW };
    const expectedAfterMiss = applyAttempt(priorState, false, NOW);
    expect(asSkillState(afterMiss!)).toEqual(expectedAfterMiss);

    await completeRepair(t, scholar, triggerAttemptId);
    const asScholar = await asUser(t, scholar);
    await asScholar.mutation(api.practiceSkills.recordBreakerRecoveryLifecycle, {
      scholarId: scholar,
      triggerAttemptId,
      event: "easy_exit",
    });

    // No fresh_result was ever recorded — the trigger's lifecycle never
    // reaches an authoritative recovery.
    const trigger = await t.run((ctx) => ctx.db.get(triggerAttemptId));
    expect(trigger?.breakerLifecycle?.freshResult).toBeUndefined();

    // Mastery is byte-for-byte the same as right after the miss: an
    // abandoned recovery does not duplicate or add any scheduling effect.
    const afterEasyExit = await masteryRow(t, scholar);
    expect(afterEasyExit?.repetition).toBe(afterMiss?.repetition);
    expect(afterEasyExit?.halfLifeDays).toBe(afterMiss?.halfLifeDays);
    expect(afterEasyExit?.updatedAt).toBe(afterMiss?.updatedAt);
  });

  test("a missed fresh recovery does not credit retention or advance repetition", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const t = convexTest(schema, modules);
    await t.mutation(internal.practiceSkills.seedGraph, {});
    const scholar = await seedScholar(t, "breaker_retention_missed");
    await seedEstablishedMastery(t, scholar);
    await seedPriorMisses(t, scholar);

    const triggerAttemptId = await triggerBreaker(t, scholar);
    await completeRepair(t, scholar, triggerAttemptId);
    const asScholar = await asUser(t, scholar);
    const recovery = await asScholar.mutation(api.practiceSkills.breakerRecoverySession, {
      scholarId: scholar,
      triggerAttemptId,
      seed: 42,
    });
    const freshItemId = recovery.items[0].itemId;

    const afterMiss = await masteryRow(t, scholar);
    const freshResult = await asScholar.mutation(api.practiceSkills.submitAnswer, {
      scholarId: scholar,
      itemId: freshItemId,
      answer: "not-the-right-answer-at-all",
      breakerTriggerAttemptId: triggerAttemptId,
    });
    expect(freshResult.breakerRecoveryVerified).toBe(false);

    // A miss on the fresh item does NOT advance repetition — no false
    // deep-mastery claim from a failed recovery. It's graded as an ordinary
    // SECOND miss (shrinking half-life again from the ordinary SR lapse),
    // NOT some special "no-op" state — mirroring the easy-exit test's
    // structure, pinned to the actual expected shrink rather than repetition
    // alone.
    const afterMissedFresh = await masteryRow(t, scholar);
    const expectedAfterMissedFresh = applyAttempt(asSkillState(afterMiss!), false, NOW);
    expect(asSkillState(afterMissedFresh!)).toEqual(expectedAfterMissedFresh);
    expect(afterMissedFresh?.repetition).toBe(afterMiss?.repetition);
  });

  test("submission replay under the same clientEventId does not double-credit retention", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const t = convexTest(schema, modules);
    await t.mutation(internal.practiceSkills.seedGraph, {});
    const scholar = await seedScholar(t, "breaker_retention_replay");
    await seedEstablishedMastery(t, scholar);
    await seedPriorMisses(t, scholar);

    const triggerAttemptId = await triggerBreaker(t, scholar);
    await completeRepair(t, scholar, triggerAttemptId);
    const asScholar = await asUser(t, scholar);
    const recovery = await asScholar.mutation(api.practiceSkills.breakerRecoverySession, {
      scholarId: scholar,
      triggerAttemptId,
      seed: 99,
    });
    const freshItemId = recovery.items[0].itemId;
    const truth = gradeTemplateItem(freshItemId, "0")!.correctAnswer;
    const clientEventId = "fresh-recovery-replay-1";

    const first = await asScholar.mutation(api.practiceSkills.submitAnswer, {
      scholarId: scholar,
      itemId: freshItemId,
      answer: truth,
      breakerTriggerAttemptId: triggerAttemptId,
      clientEventId,
    });
    // Anchor that the FIRST submission actually succeeded and credited
    // retention before comparing the replay against it — otherwise a replay
    // that silently no-ops BOTH calls identically would pass vacuously.
    expect(first.breakerRecoveryVerified).toBe(true);
    expect(first.repetition).toBe(5);
    const afterFirst = await masteryRow(t, scholar);
    expect(afterFirst?.repetition).toBe(5);

    // The exact same logical submission (offline-queue replay) must return
    // the identical receipt and must not touch mastery a second time.
    const replay = await asScholar.mutation(api.practiceSkills.submitAnswer, {
      scholarId: scholar,
      itemId: freshItemId,
      answer: truth,
      breakerTriggerAttemptId: triggerAttemptId,
      clientEventId,
    });
    expect(replay).toEqual(first);
    const afterReplay = await masteryRow(t, scholar);
    expect(afterReplay?.repetition).toBe(afterFirst?.repetition);
    expect(afterReplay?.updatedAt).toBe(afterFirst?.updatedAt);
  });
});
