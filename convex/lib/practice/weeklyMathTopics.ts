import { PATTERN_PHRASING } from "./errorFlags";
import type { ErrorPattern } from "./errorPatterns";
import {
  isBreakerCountedAttempt,
  isBreakerLaneAttempt,
  SPIRAL_GAP_MS,
} from "./spiralBreaker";

export const WEEKLY_TOPIC_MIN_MISSES = 2;
export const WEEKLY_SUSTAINED_MIN_MISSES = 3;
export const WEEKLY_SUSTAINED_MIN_SITTINGS = 2;
export const ERROR_EVENT_JOIN_TOLERANCE_MS = 60_000;

export type WeeklyMathTopicTier = "practice" | "acute" | "sustained";
export type WeeklyMathSupportOutcome =
  | "triggered"
  | "repair_started"
  | "repair_completed"
  | "coach_escalated"
  | "easy_exited"
  | "fresh_correct"
  | "fresh_missed";

export interface WeeklyMathTopicAttempt {
  domain?: string;
  nodeKey: string;
  itemId?: string;
  correct: boolean;
  retry?: boolean;
  breakerEligible?: boolean;
  lane?: string;
  createdAt?: number;
  breaker?: {
    streak?: number;
    offer?: "accepted" | "declined";
    recovery?: "won" | "missed" | "none" | "skipped";
  };
  breakerLifecycle?: {
    version: 2;
    triggerNodeKey: string;
    triggeredAt: number;
    repairStartedAt?: number;
    repairCompletedAt?: number;
    coachEscalatedAt?: number;
    easyExitedAt?: number;
    freshItemId?: string;
    freshResult?: {
      attemptId: string;
      itemId: string;
      correct: boolean;
      completedAt: number;
    };
  };
  stemSnapshot?: string;
  answerText?: string;
  expectedAnswer?: string;
  explanationReason?: string;
}

export interface WeeklyMathTopicErrorEvent {
  nodeKey: string;
  domain: string;
  pattern: string;
  itemId: string;
  createdAt: number;
}

export interface WeeklyMathMissExample {
  stem: string;
  learnerAnswer?: string;
  expectedAnswer?: string;
  isDontKnow: boolean;
}

export interface WeeklyMathTopicEvidence {
  domain: string;
  nodeKey: string;
  tier: WeeklyMathTopicTier;
  attemptCount: number;
  missCount: number;
  correctCount: number;
  missSittingCount: number;
  dayCount: number;
  dayLabels: string[];
  firstAt: number;
  lastAt: number;
  latestAttemptCorrect: boolean;
  trailingCorrectCount: number;
  breakerCount: number;
  supportOutcome?: WeeklyMathSupportOutcome;
  pattern?: ErrorPattern;
  patternDescription?: string;
  missExamples: WeeklyMathMissExample[];
}

type IndexedAttempt = {
  attempt: WeeklyMathTopicAttempt & { domain: string; createdAt: number };
  sitting: number;
};

const HONOLULU_DAY = new Intl.DateTimeFormat("en-US", {
  timeZone: "Pacific/Honolulu",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

const HONOLULU_WEEKDAY = new Intl.DateTimeFormat("en-US", {
  timeZone: "Pacific/Honolulu",
  weekday: "long",
});

function dayKey(timestamp: number): string {
  return HONOLULU_DAY.format(timestamp);
}

function dayLabel(timestamp: number): string {
  return HONOLULU_WEEKDAY.format(timestamp);
}

function indexedAttempts(
  attempts: readonly WeeklyMathTopicAttempt[],
  since: number,
  now: number,
): IndexedAttempt[] {
  const chronological = attempts
    .filter(
      (
        attempt,
      ): attempt is WeeklyMathTopicAttempt & {
        domain: string;
        createdAt: number;
      } =>
        attempt.retry !== true &&
        typeof attempt.domain === "string" &&
        typeof attempt.createdAt === "number" &&
        Number.isFinite(attempt.createdAt) &&
        attempt.createdAt >= since &&
        attempt.createdAt <= now,
    )
    .sort(
      (a, b) =>
        a.createdAt - b.createdAt ||
        a.nodeKey.localeCompare(b.nodeKey) ||
        (a.itemId ?? "").localeCompare(b.itemId ?? ""),
    );

  let sitting = 0;
  let previousAt: number | undefined;
  return chronological.map((attempt) => {
    if (
      previousAt !== undefined &&
      attempt.createdAt - previousAt > SPIRAL_GAP_MS
    ) {
      sitting += 1;
    }
    previousAt = attempt.createdAt;
    return { attempt, sitting };
  });
}

function dominantPattern(
  events: readonly WeeklyMathTopicErrorEvent[],
  misses: readonly IndexedAttempt[],
  since: number,
  now: number,
): { pattern: ErrorPattern; description: string } | undefined {
  const matched = new Map<ErrorPattern, { count: number; lastAt: number }>();
  for (const event of events) {
    if (event.createdAt < since || event.createdAt > now) continue;
    const pattern = event.pattern as ErrorPattern;
    if (!PATTERN_PHRASING[pattern]) continue;
    if (
      !misses.some(
        ({ attempt }) =>
          attempt.domain === event.domain &&
          attempt.nodeKey === event.nodeKey &&
          attempt.itemId === event.itemId &&
          Math.abs(attempt.createdAt - event.createdAt) <=
            ERROR_EVENT_JOIN_TOLERANCE_MS,
      )
    ) {
      continue;
    }
    const current = matched.get(pattern);
    matched.set(pattern, {
      count: (current?.count ?? 0) + 1,
      lastAt: Math.max(current?.lastAt ?? 0, event.createdAt),
    });
  }

  const winner = [...matched.entries()].sort(
    ([patternA, a], [patternB, b]) =>
      b.count - a.count ||
      b.lastAt - a.lastAt ||
      patternA.localeCompare(patternB),
  )[0];
  if (!winner) return undefined;
  return { pattern: winner[0], description: PATTERN_PHRASING[winner[0]] };
}

function missExamples(
  misses: readonly IndexedAttempt[],
): WeeklyMathMissExample[] {
  return misses
    .filter(({ attempt }) => Boolean(attempt.stemSnapshot?.trim()))
    .slice(-3)
    .map(({ attempt }) => ({
      stem: attempt.stemSnapshot!.trim(),
      ...(attempt.answerText?.trim()
        ? { learnerAnswer: attempt.answerText.trim() }
        : {}),
      ...(attempt.expectedAnswer?.trim()
        ? { expectedAnswer: attempt.expectedAnswer.trim() }
        : {}),
      isDontKnow: attempt.explanationReason === "dont_know",
    }));
}

function lifecycleOutcome(
  lifecycle: NonNullable<WeeklyMathTopicAttempt["breakerLifecycle"]>,
): WeeklyMathSupportOutcome {
  if (lifecycle.freshResult) {
    return lifecycle.freshResult.correct ? "fresh_correct" : "fresh_missed";
  }
  if (lifecycle.easyExitedAt !== undefined) return "easy_exited";
  if (lifecycle.coachEscalatedAt !== undefined) return "coach_escalated";
  if (lifecycle.repairCompletedAt !== undefined) return "repair_completed";
  if (lifecycle.repairStartedAt !== undefined) return "repair_started";
  return "triggered";
}

type SameTopicBreakerEvidence = {
  count: number;
  supportOutcome?: WeeklyMathSupportOutcome;
  supportCompletedAt?: number;
};

function sameTopicBreakerEvidence(
  indexed: readonly IndexedAttempt[],
): Map<string, SameTopicBreakerEvidence> {
  const relevant = indexed.filter(
    ({ attempt }) =>
      isBreakerCountedAttempt(attempt) ||
      (attempt.correct && isBreakerLaneAttempt(attempt)),
  );
  const evidence = new Map<string, SameTopicBreakerEvidence>();
  for (let index = 2; index < relevant.length; index += 1) {
    const current = relevant[index];
    const key = `${current.attempt.domain}\u0000${current.attempt.nodeKey}`;
    const lifecycle =
      current.attempt.breakerLifecycle?.version === 2 &&
      current.attempt.breakerLifecycle.triggerNodeKey === current.attempt.nodeKey
        ? current.attempt.breakerLifecycle
        : undefined;
    if ((current.attempt.breaker?.streak ?? 0) < 3 && !lifecycle) continue;

    const recent = relevant.slice(index - 2, index + 1);
    if (
      recent.every(
        ({ attempt, sitting }) =>
          !attempt.correct &&
          sitting === current.sitting &&
          `${attempt.domain}\u0000${attempt.nodeKey}` === key,
      )
    ) {
      const prior = evidence.get(key);
      evidence.set(key, {
        count: (prior?.count ?? 0) + 1,
        ...(lifecycle
          ? {
              supportOutcome: lifecycleOutcome(lifecycle),
              ...(lifecycle.freshResult
                ? { supportCompletedAt: lifecycle.freshResult.completedAt }
                : {}),
            }
          : prior?.supportOutcome
            ? {
                supportOutcome: prior.supportOutcome,
                ...(prior.supportCompletedAt !== undefined
                  ? { supportCompletedAt: prior.supportCompletedAt }
                  : {}),
              }
            : {}),
      });
    }
  }
  return evidence;
}

/**
 * Rank concrete weekly practice topics from the canonical attempt log.
 * Classified error events can explain a topic, but never decide eligibility:
 * most legitimate misses do not match one of the narrow deterministic patterns.
 */
export function weeklyMathTopics(
  events: readonly WeeklyMathTopicErrorEvent[],
  attempts: readonly WeeklyMathTopicAttempt[],
  since: number,
  now: number,
): WeeklyMathTopicEvidence[] {
  const indexed = indexedAttempts(attempts, since, now);
  const breakerEvidence = sameTopicBreakerEvidence(indexed);
  const byNode = new Map<string, IndexedAttempt[]>();
  for (const attempt of indexed) {
    const key = `${attempt.attempt.domain}\u0000${attempt.attempt.nodeKey}`;
    const rows = byNode.get(key) ?? [];
    rows.push(attempt);
    byNode.set(key, rows);
  }

  const topics: WeeklyMathTopicEvidence[] = [];
  for (const rows of byNode.values()) {
    const first = rows[0];
    const latest = rows.at(-1);
    if (!first || !latest) continue;
    const misses = rows.filter(({ attempt }) => !attempt.correct);
    if (misses.length < WEEKLY_TOPIC_MIN_MISSES) continue;

    const missSittings = new Set(misses.map(({ sitting }) => sitting));
    const days = new Map<string, number>();
    for (const { attempt } of misses) {
      const key = dayKey(attempt.createdAt);
      if (!days.has(key)) days.set(key, attempt.createdAt);
    }
    const breaker =
      breakerEvidence.get(
        `${first.attempt.domain}\u0000${first.attempt.nodeKey}`,
      );
    const breakerCount = breaker?.count ?? 0;
    const sustained =
      misses.length >= WEEKLY_SUSTAINED_MIN_MISSES &&
      missSittings.size >= WEEKLY_SUSTAINED_MIN_SITTINGS;
    const pattern = dominantPattern(
      events.filter(
        (event) =>
          event.domain === first.attempt.domain &&
          event.nodeKey === first.attempt.nodeKey,
      ),
      misses,
      since,
      now,
    );
    let trailingCorrectCount = 0;
    for (let index = rows.length - 1; index >= 0; index -= 1) {
      if (!rows[index].attempt.correct) break;
      trailingCorrectCount += 1;
    }
    const supportClosed =
      breaker?.supportOutcome === "fresh_correct" &&
      breaker.supportCompletedAt !== undefined &&
      !misses.some(
        ({ attempt }) => attempt.createdAt > breaker.supportCompletedAt!,
      );
    const tier: WeeklyMathTopicTier = sustained
      ? "sustained"
      : breakerCount > 0 && !supportClosed
        ? "acute"
        : "practice";

    topics.push({
      domain: first.attempt.domain,
      nodeKey: first.attempt.nodeKey,
      tier,
      attemptCount: rows.length,
      missCount: misses.length,
      correctCount: rows.length - misses.length,
      missSittingCount: missSittings.size,
      dayCount: days.size,
      dayLabels: [...days.values()].map(dayLabel),
      firstAt: first.attempt.createdAt,
      lastAt: latest.attempt.createdAt,
      latestAttemptCorrect: latest.attempt.correct,
      trailingCorrectCount,
      breakerCount,
      ...(breaker?.supportOutcome
        ? { supportOutcome: breaker.supportOutcome }
        : {}),
      ...(pattern
        ? {
            pattern: pattern.pattern,
            patternDescription: pattern.description,
          }
        : {}),
      missExamples: missExamples(misses),
    });
  }

  const tierRank: Record<WeeklyMathTopicTier, number> = {
    sustained: 3,
    acute: 2,
    practice: 1,
  };
  return topics.sort(
    (a, b) =>
      tierRank[b.tier] - tierRank[a.tier] ||
      b.missCount - a.missCount ||
      b.missSittingCount - a.missSittingCount ||
      b.breakerCount - a.breakerCount ||
      Number(a.latestAttemptCorrect) - Number(b.latestAttemptCorrect) ||
      b.lastAt - a.lastAt ||
      a.domain.localeCompare(b.domain) ||
      a.nodeKey.localeCompare(b.nodeKey) ||
      (a.pattern ?? "").localeCompare(b.pattern ?? ""),
  );
}
