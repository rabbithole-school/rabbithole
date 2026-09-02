import type { Id } from "../../_generated/dataModel";
import {
  advanceBreakerFlow,
  newBreakerFlow,
  type BreakerFlow,
} from "../../../shared/practiceLoop";
import { accessProven, isFluent, type FluencyContext } from "./scheduler";

export const SPIRAL_GAP_MS = 30 * 60 * 1000;
export const SPIRAL_SCAN_LIMIT = 24;
export const SPIRAL_MISS_THRESHOLD = 3;

const COUNTED_LANES = new Set(["review", "frontier", "confirmation"]);

export type SpiralAttempt = {
  correct: boolean;
  lane?: string;
  createdAt?: number;
  retry?: boolean;
  breakerEligible?: boolean;
};

export type BreakerLifecycleEvidence = {
  triggeredAt: number;
  repairShownAt?: number;
  repairUnavailableAt?: number;
  repairStartedAt?: number;
  repairCompletedAt?: number;
  coachEscalatedAt?: number;
  easyExitedAt?: number;
  stoppedAt?: number;
  freshItemId?: string;
  freshIssuedAt?: number;
  easyItemId?: string;
  easyIssuedAt?: number;
  easyUnavailableAt?: number;
  freshResult?: { correct: boolean; completedAt: number };
};

export type BreakerEpisodeProjection = {
  status: "active" | "terminal" | "expired";
  lastActivityAt: number;
  expiresAt: number;
};

/**
 * Derive an episode's serving status from its durable evidence. `easyExitedAt`
 * records the initial easy-item issuance, not its completion, so it only becomes
 * terminal once the legacy outcome carries a completed easy result.
 */
export function projectBreakerEpisode(
  lifecycle: BreakerLifecycleEvidence,
  latestCountedMissAt: number,
  now: number,
  easyResult?: "won" | "missed",
): BreakerEpisodeProjection {
  const activity = [
    lifecycle.triggeredAt,
    latestCountedMissAt,
    lifecycle.repairShownAt,
    lifecycle.repairUnavailableAt,
    lifecycle.repairStartedAt,
    lifecycle.repairCompletedAt,
    lifecycle.coachEscalatedAt,
    lifecycle.easyExitedAt,
    lifecycle.stoppedAt,
    lifecycle.freshIssuedAt,
    lifecycle.easyIssuedAt,
    lifecycle.easyUnavailableAt,
    lifecycle.freshResult?.completedAt,
  ].filter((at): at is number => at !== undefined);
  const lastActivityAt = Math.max(...activity);
  const terminal =
    lifecycle.stoppedAt !== undefined ||
    lifecycle.freshResult?.correct === true ||
    lifecycle.easyUnavailableAt !== undefined ||
    (lifecycle.easyExitedAt !== undefined && easyResult !== undefined);
  const expiresAt = lastActivityAt + SPIRAL_GAP_MS;

  return {
    status: terminal ? "terminal" : now >= expiresAt ? "expired" : "active",
    lastActivityAt,
    expiresAt,
  };
}

/** The full durable lifecycle evidence stored on the trigger attempt (mirrors
 *  `practiceAttempts.breakerLifecycle` in convex/schema.ts). Distinct from the
 *  slimmer `BreakerLifecycleEvidence` above, which `projectBreakerEpisode`
 *  only needs the timestamps from — this one also carries the fields
 *  `breakerFlowFromLifecycle` needs to reconstruct which stage the scholar was
 *  actually in. */
export type BreakerFullLifecycle = BreakerLifecycleEvidence & {
  easyDomain?: string;
  freshResult?: {
    attemptId: Id<"practiceAttempts">;
    itemId: string;
    correct: boolean;
    assisted?: boolean;
    completedAt: number;
  };
};

/**
 * Reconstruct the client `BreakerFlow` value from durable server evidence —
 * the one thing breaker-episode resume needs so re-entry lands on the exact
 * repair/coach/fresh/easy stage the scholar left, without the client ever
 * interpreting a lifecycle timestamp itself. This replays the SAME transitions
 * the live client dispatches (`advanceBreakerFlow`) in the one order they can
 * have happened in — each lifecycle field is a monotonic, single write (see
 * `recordBreakerRecoveryLifecycle`) — so the result is identical to what the
 * client's own reducer would have produced had it never lost its in-memory
 * state.
 *
 * `easyResult` is `recordBreakerOutcome`'s legacy telemetry field, the only
 * place the easy item's grade is recorded; pass `trigger.breaker?.recovery`
 * narrowed to `"won" | "missed"`.
 */
export function breakerFlowFromLifecycle(
  lifecycle: BreakerFullLifecycle,
  easyResult?: "won" | "missed",
): BreakerFlow {
  let flow = newBreakerFlow(
    lifecycle.repairUnavailableAt !== undefined ? "unavailable" : "opening",
  );
  if (
    lifecycle.repairShownAt !== undefined ||
    lifecycle.repairStartedAt !== undefined
  ) {
    flow = advanceBreakerFlow(flow, { type: "repairOpened" });
  }
  if (lifecycle.repairCompletedAt !== undefined) {
    flow = advanceBreakerFlow(flow, { type: "repairDone" });
  }
  if (lifecycle.coachEscalatedAt !== undefined) {
    flow = advanceBreakerFlow(flow, { type: "coachOpened" });
  }
  if (lifecycle.freshItemId !== undefined) {
    flow = advanceBreakerFlow(flow, { type: "freshServed" });
  }
  if (lifecycle.freshResult !== undefined) {
    // The live client always immediately follows a graded fresh item with
    // `closed` (`finishBreakerFresh` → `closeBreaker`), regardless of
    // correctness: a correct result is the recognized recovery, and a missed
    // one still closes the fresh stage and falls through to the one remaining
    // escape (easyFinish).
    flow = advanceBreakerFlow(flow, {
      type: "freshGraded",
      correct: lifecycle.freshResult.correct,
      assisted: lifecycle.freshResult.assisted ?? false,
      verified: true,
    });
    flow = advanceBreakerFlow(flow, { type: "closed" });
  }
  if (
    lifecycle.easyItemId !== undefined ||
    lifecycle.easyExitedAt !== undefined
  ) {
    flow = advanceBreakerFlow(flow, { type: "easyRequested" });
  }
  if (lifecycle.easyUnavailableAt !== undefined) {
    flow = advanceBreakerFlow(flow, { type: "easyUnavailable" });
  }
  if (easyResult === "won" || easyResult === "missed") {
    // Mirrors `finishBreakerEasy`: graded, then unconditionally closed.
    flow = advanceBreakerFlow(flow, {
      type: "easyGraded",
      correct: easyResult === "won",
    });
    flow = advanceBreakerFlow(flow, { type: "closed" });
  }
  return flow;
}

/** Whether an attempt belongs to a lane whose outcomes define breaker streaks. */
export function isBreakerLaneAttempt(attempt: SpiralAttempt): boolean {
  return (
    attempt.retry !== true &&
    attempt.lane !== undefined &&
    COUNTED_LANES.has(attempt.lane)
  );
}

/** Whether an attempt may contribute to breaker counts or trigger evidence. */
export function isBreakerCountedAttempt(attempt: SpiralAttempt): boolean {
  return isBreakerLaneAttempt(attempt) && attempt.breakerEligible !== false;
}

/**
 * Return the current consecutive breaker misses from newest-first attempt rows.
 *
 * Excluded misses are transparent, matching the existing behavior for
 * non-counted lanes: they do not advance the live streak. A correct result in a
 * counted lane still resets the streak even when its operation was excluded;
 * that preserves the pre-field behavior and prevents successful contained work
 * from welding two miss runs together. The thirty-minute sitting boundary
 * remains measured between eligible counted misses.
 */
export function breakerMissStreakAttempts<T extends SpiralAttempt>(
  attempts: readonly T[],
): T[] {
  const streak: T[] = [];
  let newerCountedAt: number | undefined;

  for (const attempt of attempts.slice(0, SPIRAL_SCAN_LIMIT)) {
    if (!isBreakerLaneAttempt(attempt)) continue;
    if (attempt.correct) break;
    if (!isBreakerCountedAttempt(attempt)) continue;
    if (
      newerCountedAt !== undefined &&
      attempt.createdAt !== undefined &&
      newerCountedAt - attempt.createdAt > SPIRAL_GAP_MS
    ) {
      break;
    }
    streak.push(attempt);
    if (attempt.createdAt !== undefined) newerCountedAt = attempt.createdAt;
  }

  return streak;
}

/** Count consecutive misses among eligible lanes in newest-first attempt rows. */
export function consecutiveMissStreak(attempts: readonly SpiralAttempt[]): number {
  return breakerMissStreakAttempts(attempts).length;
}

/** The mastery fields the recovery pick reads. Structurally a subset of a
 *  `practiceMastery` row (kept local so the helper stays pure + unit-testable). */
export type RecoveryMasteryRow = {
  skillKey: string;
  domain: string;
  repetition: number;
  source?: string;
  halfLifeDays?: number;
  lastPracticedAt?: number;
  latencyMedianMs?: number;
};

/** The chosen recovery skill AND its domain. The domain is load-bearing: the
 *  client serves the recovery item with `practiceSession({ skillKeys, domain })`,
 *  and that query scopes to a SINGLE domain (defaulting to whole-number-arithmetic
 *  when none is passed). A pick from any other domain would be dropped by that
 *  scope and serve nothing, bouncing the scholar home — so the domain travels with
 *  the key all the way to the client. */
export type RecoverySkill = { skillKey: string; domain: string };

/** Choose the skill to serve as the back-off "grab one more and call it a day"
 *  recovery item. Preference, best-first:
 *   1. a DEMONSTRATED-fluent skill — an earned easy win to end on (the original,
 *      and still-ideal, choice);
 *   2. else the best ACCESS-PROVEN skill — placement / valve / practice credited
 *      it, so it's the scholar's likeliest easy win. This is the path a
 *      brand-new scholar takes: right after placement EVERY mastery row is an
 *      inferred placement credit (`source: "placement"`, so `isFluent` is
 *      false), leaving tier 1 empty. Without this fall-through the offer promises
 *      "one more" but no `recoverySkillKey` comes back, and the client
 *      (`startBreakerRecovery` on both web + native) bounces the scholar straight
 *      home — the "one more" that never came;
 *   3. else any practiced skill, so the promise still holds.
 *  Within each tier: most-credited (highest repetition) first, ties broken by
 *  skillKey for determinism.
 *
 *  `isServable` gates the candidate pool to skills that can actually produce an
 *  item (default: everything). The mutation passes membership in its runnable-skill
 *  set (a template OR a non-stretch stored item); a placement-credited skill with
 *  neither would serve nothing and bounce the scholar home, so filtering first
 *  keeps the promise honest.
 *
 *  Returns undefined only when NO servable mastery exists — with the default
 *  predicate that means no mastery at all, impossible once a miss streak has
 *  tripped the back-off (every attempt upserts a mastery row). */
export function pickRecoverySkill(
  mastery: readonly RecoveryMasteryRow[],
  ctx: FluencyContext,
  isServable: (skillKey: string) => boolean = () => true,
): RecoverySkill | undefined {
  const byPreference = (a: RecoveryMasteryRow, b: RecoveryMasteryRow): number =>
    b.repetition - a.repetition || a.skillKey.localeCompare(b.skillKey);

  const servable = mastery.filter((row) => isServable(row.skillKey));
  const pick = (row: RecoveryMasteryRow | undefined): RecoverySkill | undefined =>
    row ? { skillKey: row.skillKey, domain: row.domain } : undefined;

  const fluent = servable.filter((row) => isFluent(row, ctx)).sort(byPreference)[0];
  if (fluent) return pick(fluent);

  const accessible = servable
    .filter((row) => accessProven(row))
    .slice()
    .sort(byPreference)[0];
  if (accessible) return pick(accessible);

  return pick(servable.slice().sort(byPreference)[0]);
}
