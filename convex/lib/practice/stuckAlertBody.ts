import { escapeSlackText } from "../slackApi";
import {
  isBreakerCountedAttempt,
  SPIRAL_GAP_MS,
  SPIRAL_MISS_THRESHOLD,
} from "./spiralBreaker";
import {
  dayKeyForTimezone,
  shiftDayKey,
  weekdayForDayKey,
} from "../../../shared/institutionDay";

export const STUCK_SITTING_SCAN_LIMIT = 120;

/**
 * "Recently" for the same-node breaker re-trip line (T6 calibration): a prior
 * breaker episode on the same (scholar, node) counts when it falls inside the
 * last 7 days. Anchored to the measured prod concentration — the 2026-09-01 pull
 * found re-trips clustered within ~a single week: one scholar tripped
 * permutations_r_from_n ×4 and nt_prime_gaps ×2, another exponents_repeated_mult
 * ×3, and two more ×2. See review/breaker-perseverance-plan.html
 * (§3 Finding C). Widening this window would surface unrelated episodes; a
 * tighter one would miss the concentration the teacher needs to see.
 */
export const BREAKER_REPEAT_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
/** The parent alert is queued in the threshold-crossing transaction. */
export const PRACTICE_ALERT_COMPOSE_DELAY_MS = 0;

export type BreakerTelemetry = {
  offer?: "accepted" | "declined";
  recovery?: "won" | "missed" | "none" | "skipped";
  lifecycle?: {
    version: 2;
    triggeredAt: number;
    repairShownAt?: number;
    repairRungKind?: "completion" | "reveal";
    repairUnavailableAt?: number;
    repairStartedAt?: number;
    repairCompletedAt?: number;
    coachEscalatedAt?: number;
    easyExitedAt?: number;
    stoppedAt?: number;
    freshResult?: { correct: boolean; assisted?: boolean };
  };
};

export type StuckAlertMiss = {
  nodeKey: string;
  skillLabel: string;
  stemSnapshot?: string;
  answerText?: string;
  expectedAnswer?: string;
  errorPattern?: string;
  elapsedMs?: number;
  teachOutcome?: "solved" | "hint" | "stuck";
  isDontKnow: boolean;
};

export type PracticeSitting = {
  correct: number;
  total: number;
  startedAt: number;
  bounded: boolean;
};

export type SittingAttempt = {
  correct: boolean;
  retry?: boolean;
  breakerEligible?: boolean;
  lane?: string;
  createdAt: number;
};

export type DiagnosableStuckAttempt = {
  explanationReason?: string;
  answerText?: string;
  expectedAnswer?: string;
};

/**
 * Prior same-node breaker episodes for this scholar inside the repeat window.
 * `priorEpisodeAts` are the trigger timestamps of earlier episodes only (the
 * current one is excluded upstream); when non-empty, this episode is at least
 * the second on this node.
 */
export type RepeatBreakerEvidence = {
  priorEpisodeAts: number[];
  timeZone: string;
};

export type StuckAlertBodyInput = {
  missStreak: number;
  misses: readonly StuckAlertMiss[];
  sitting?: PracticeSitting;
  diagnosis?: string;
  breaker?: BreakerTelemetry;
  repeatBreaker?: RepeatBreakerEvidence;
  fallbackSkillLabel: string;
  now: number;
};

export type NotYetTaughtAlertBodyInput = {
  missStreak: number;
  misses: readonly StuckAlertMiss[];
  sitting?: PracticeSitting;
  breaker?: BreakerTelemetry;
  now: number;
};

export type BreakerSkillState = {
  label: string;
  proficiency: "not_started" | "practicing" | "fluent" | "overlearned";
  missStreak: number;
  progressed: boolean;
  episodeProgressKnown: boolean;
  brandNew: boolean;
  firstCorrectAnswer: boolean;
};

/** Whether a pinned breaker streak contains a wrong answer a teacher can inspect. */
export function shouldAlertOnStuckEpisode(
  attempts: readonly DiagnosableStuckAttempt[],
): boolean {
  return attempts.some(
    (attempt) =>
      attempt.explanationReason !== "dont_know" &&
      Boolean(attempt.answerText?.trim()) &&
      Boolean(attempt.expectedAnswer?.trim()),
  );
}

export function isAllDontKnowStreak(
  attempts: readonly DiagnosableStuckAttempt[],
): boolean {
  return (
    attempts.length === SPIRAL_MISS_THRESHOLD &&
    attempts.every((attempt) => attempt.explanationReason === "dont_know")
  );
}

export function formatAttemptElapsed(elapsedMs?: number): string | undefined {
  if (
    elapsedMs === undefined ||
    !Number.isFinite(elapsedMs) ||
    elapsedMs < 0
  ) {
    return undefined;
  }
  if (elapsedMs < 60_000) {
    return `${Math.max(1, Math.round(elapsedMs / 1_000))}s`;
  }
  return `${Math.max(1, Math.round(elapsedMs / 60_000))} min`;
}

function truncate(value: string, maxLength: number): string {
  const trimmed = value.trim();
  if (trimmed.length <= maxLength) return trimmed;
  return `${trimmed.slice(0, maxLength - 1).trimEnd()}…`;
}

function safeText(value: string): string {
  // NOTE: this backslash-escape does NOT survive Slack. These bodies go out as
  // `markdown_text` (CommonMark): Slack parses `\\*` as a literal asterisk and
  // then re-emits it RAW into mrkdwn, where its own renderer reads it as markup
  // again, so an emphasis marker in a label still renders as emphasis. Probed
  // live 2026-09-17. The fix is NOT `escapeSlackInline` (convex/lib/slackText.ts)
  // as-is: that STRIPS `_`, which mangles the underscored skill ids this
  // function is mostly given (`divide_by_6` → `divideby6`). Tracked separately.
  return escapeSlackText(value.replace(/`/g, "")).replace(/([*_])/g, "\\$1");
}

function safeCodeSpan(value: string, maxLength: number): string {
  return escapeSlackText(truncate(value.replace(/`/g, ""), maxLength));
}

function renderMiss(miss: StuckAlertMiss): string | null {
  const skillLabel = miss.skillLabel.trim();
  if (!skillLabel) return null;

  const elapsed = formatAttemptElapsed(miss.elapsedMs);
  const lines = [
    `• **${safeText(skillLabel)}**${
      elapsed ? ` (${elapsed} on this one)` : ""
    }`,
  ];
  const stem = miss.stemSnapshot
    ? safeCodeSpan(miss.stemSnapshot, 90)
    : "";
  if (stem) {
    let detail = `   \`${stem}\``;
    if (miss.isDontKnow) {
      detail += ` → tapped "I don't know"`;
    } else {
      const answer = miss.answerText
        ? safeCodeSpan(miss.answerText, 40)
        : "";
      const expected = miss.expectedAnswer
        ? safeCodeSpan(miss.expectedAnswer, 40)
        : "";
      if (answer) {
        detail += ` → answered \`${answer}\``;
        if (expected) {
          detail += `  (expected \`${expected}\`)`;
        }
      } else if (expected) {
        detail += `  (expected \`${expected}\`)`;
      }
    }
    lines.push(detail);
  }
  if (miss.errorPattern?.trim()) {
    lines.push(`   ↳ ${safeText(miss.errorPattern.trim())}`);
  }
  return lines.join("\n");
}

function renderNotYetTaughtMiss(miss: StuckAlertMiss): string | null {
  const skillLabel = miss.skillLabel.trim();
  if (!skillLabel) return null;

  const elapsed = formatAttemptElapsed(miss.elapsedMs);
  const lines = [
    `• **${safeText(skillLabel)}**${
      elapsed ? ` (${elapsed} on this one)` : ""
    }`,
  ];
  const stem = miss.stemSnapshot
    ? safeCodeSpan(miss.stemSnapshot, 90)
    : "";
  if (stem) lines.push(`   \`${stem}\``);

  const teachOutcome = miss.teachOutcome
    ? {
        solved: "Teaching follow-up: solved it.",
        hint: "Teaching follow-up: finished with a hint.",
        stuck: "Teaching follow-up: needed more support.",
      }[miss.teachOutcome]
    : undefined;
  if (teachOutcome) lines.push(`   ↳ ${teachOutcome}`);
  return lines.join("\n");
}

/** Tally the current sitting from newest-first attempts. */
export function tallyPracticeSitting(
  attempts: readonly SittingAttempt[],
  options: { gapMs?: number; limit?: number } = {},
): PracticeSitting | undefined {
  const gapMs = options.gapMs ?? SPIRAL_GAP_MS;
  const limit = options.limit ?? STUCK_SITTING_SCAN_LIMIT;
  let newerAt: number | undefined;
  let correct = 0;
  let total = 0;
  let scanned = 0;
  let startedAt: number | undefined;

  for (const attempt of attempts) {
    if (attempt.retry === true) continue;
    if (scanned >= limit) break;
    if (newerAt !== undefined && newerAt - attempt.createdAt > gapMs) break;

    scanned += 1;
    if (isBreakerCountedAttempt(attempt)) {
      total += 1;
      if (attempt.correct) correct += 1;
      startedAt = attempt.createdAt;
    }
    newerAt = attempt.createdAt;
  }

  if (total === 0 || startedAt === undefined) return undefined;
  return {
    correct,
    total,
    startedAt,
    bounded: scanned === limit,
  };
}

function sittingLine(
  sitting: PracticeSitting | undefined,
  now: number,
): string | undefined {
  if (!sitting) return undefined;
  const durationMinutes = Math.max(
    0,
    Math.round((now - sitting.startedAt) / 60_000),
  );
  return `This sitting: ${sitting.correct} of ${sitting.total}${
    sitting.bounded ? "+" : ""
  } correct, over ${durationMinutes} min.`;
}

function scholarOfferLine(
  missStreak: number,
  breaker?: BreakerTelemetry,
): string {
  if (breaker?.lifecycle?.version === 2) {
    if (breaker.lifecycle.repairUnavailableAt) {
      return (
        `Missed ${missStreak} practice items in a row. Rabbithole paused the run ` +
        "and offered the tutor or an easier finish because no step-card repair was available."
      );
    }
    return (
      `Missed ${missStreak} practice items in a row. Rabbithole paused the run ` +
      "with one step-card repair ready, plus the tutor or an easier finish."
    );
  }
  return (
    `Missed ${missStreak} practice items in a row. Rabbithole paused the run ` +
    "and offered to talk one through with the tutor, or to finish on an easier one."
  );
}

export function breakerResponseLine(
  breaker?: BreakerTelemetry,
): string {
  if (!breaker) {
    return "No response was recorded yet; they may have left the session.";
  }

  if (breaker.lifecycle?.version === 2) {
    const lifecycle = breaker.lifecycle;
    const lines = [
      lifecycle.repairCompletedAt
        ? "Step-card repair completed."
        : lifecycle.repairStartedAt
          ? "Step-card repair started."
          : "Step-card repair is ready.",
    ];
    if (lifecycle.coachEscalatedAt) lines.push("Coach escalation started.");
    if (lifecycle.easyExitedAt) lines.push("They took the easier exit.");
    if (lifecycle.freshResult) {
      lines.push(
        lifecycle.freshResult.correct
          ? "Fresh same-node item: correct."
          : "Fresh same-node item: missed.",
      );
    }
    return lines.join(" ");
  }

  const result =
    breaker.recovery === "won"
      ? " They got the final easier item right."
      : breaker.recovery === "missed"
        ? " They missed the final easier item."
        : "";
  if (breaker.offer === "accepted") {
    return (
      "They chose to talk it through with the tutor; the conversation is under way." +
      result
    );
  }
  return (
    "They chose to finish on an easier one; the session is winding down." +
    result
  );
}

function proficiencyLabel(proficiency: BreakerSkillState["proficiency"]): string {
  return proficiency.replace("_", " ");
}

export function breakerSkillStateLine(
  state: BreakerSkillState,
  breaker?: BreakerTelemetry,
): string {
  const label = safeText(state.label);
  if (!state.episodeProgressKnown) {
    return `${label}: currently ${proficiencyLabel(state.proficiency)} — progress during this episode is unknown.`;
  }
  if (state.brandNew && state.firstCorrectAnswer) {
    return `${label}: first correct answer on this skill in this episode.`;
  }
  if (state.progressed) {
    return `${label}: now ${proficiencyLabel(state.proficiency)}.`;
  }

  const misses = state.missStreak > 0
    ? `${state.missStreak} ${state.missStreak === 1 ? "miss" : "misses"} in a row, `
    : "";
  const recovery =
    breaker?.recovery === "won"
      ? " Recovered on an easier item; the skill itself did not move."
      : "";
  return `${label}: still ${proficiencyLabel(state.proficiency)} — ${misses}no progress this episode.${recovery}`;
}

/** One terminal (or sitting-timeout) reply under the immediate parent alert. */
export function buildBreakerOutcomeReply(
  breaker: BreakerTelemetry | undefined,
  diagnosis?: string,
  skillState?: BreakerSkillState,
): string {
  const lifecycle = breaker?.lifecycle;
  let outcome: string;

  if (lifecycle?.freshResult) {
    const support = lifecycle.coachEscalatedAt
      ? "worked with the tutor"
      : "completed the step-card repair";
    if (lifecycle.freshResult.correct) {
      outcome = lifecycle.freshResult.assisted
        ? `They ${support}, then got the fresh same-skill item right with more help.`
        : `They ${support}, then got the fresh same-skill item right.`;
    } else if (lifecycle.easyExitedAt) {
      outcome =
        breaker?.recovery === "won"
          ? `They ${support}, missed the fresh same-skill item, then got the easier finish right.`
          : breaker?.recovery === "missed"
            ? `They ${support}, missed the fresh same-skill item, then missed the easier finish too.`
            : breaker?.recovery === "skipped"
              ? `They ${support}, missed the fresh same-skill item, then no suitable easier item was available.`
              : `They ${support}, missed the fresh same-skill item, then chose the easier finish; no result was recorded before the sitting ended.`;
    } else if (lifecycle.stoppedAt) {
      outcome = `They ${support}, missed the fresh same-skill item, then stopped for now.`;
    } else {
      outcome = `They ${support}, then missed the fresh same-skill item; no later choice was recorded before the sitting ended.`;
    }
  } else if (lifecycle?.easyExitedAt) {
    outcome =
      breaker?.recovery === "won"
        ? "They chose the easier finish and got that item right."
        : breaker?.recovery === "missed"
          ? "They chose the easier finish and missed that item."
          : breaker?.recovery === "skipped"
            ? "They chose the easier finish, but no suitable item was available."
            : "They chose the easier finish; no result was recorded before the sitting ended.";
  } else if (lifecycle?.coachEscalatedAt) {
    outcome =
      "They opened the tutor to work through the stuck item; no later fresh-item result was recorded before the sitting ended.";
  } else if (lifecycle?.repairCompletedAt) {
    outcome =
      "They completed the step-card repair; no later fresh-item result was recorded before the sitting ended.";
  } else if (lifecycle?.repairStartedAt) {
    outcome =
      "They started the step-card repair but did not finish it before the sitting ended.";
  } else if (lifecycle?.repairUnavailableAt) {
    outcome =
      "No step-card repair was available, and no later choice was recorded before the sitting ended.";
  } else if (lifecycle?.repairShownAt) {
    outcome =
      "The repair card was shown, but no next action was recorded before the sitting ended.";
  } else if (breaker?.offer === "accepted") {
    outcome =
      "They chose to talk it through with the tutor; no later result was recorded before the sitting ended.";
  } else if (breaker?.offer === "declined") {
    outcome =
      breaker.recovery === "won"
        ? "They chose the easier finish and got that item right."
        : breaker.recovery === "missed"
          ? "They chose the easier finish and missed that item."
          : "They chose the easier finish; no result was recorded before the sitting ended.";
  } else {
    outcome =
      "No response was recorded before the sitting ended; they may have left practice.";
  }

  return [
    `**What happened next:** ${outcome}`,
    ...(skillState ? [breakerSkillStateLine(skillState, breaker)] : []),
    ...(diagnosis?.trim() ? [`_AI read:_ ${safeText(diagnosis.trim())}`] : []),
  ].join("\n");
}

const REPEAT_ORDINALS = [
  "",
  "First",
  "Second",
  "Third",
  "Fourth",
  "Fifth",
  "Sixth",
  "Seventh",
  "Eighth",
  "Ninth",
];

function repeatOrdinal(count: number): string {
  return REPEAT_ORDINALS[count] ?? `${count}th`;
}

const REPEAT_WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function repeatDayLabel(dayKey: string, nowDayKey: string): string {
  if (dayKey === nowDayKey) return "earlier today";
  if (dayKey === shiftDayKey(nowDayKey, -1)) return "yesterday";
  return REPEAT_WEEKDAYS[weekdayForDayKey(dayKey)] ?? dayKey;
}

function joinWithAnd(items: readonly string[]): string {
  if (items.length <= 1) return items[0] ?? "";
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(", ")}, and ${items[items.length - 1]}`;
}

/**
 * One staff-voiced factual sentence naming a same-node breaker re-trip, so a
 * teacher in the room can decide to pull the scholar aside. Names the pattern
 * only — the count and the prior days — never a prescription. Absent unless the
 * scholar has at least one prior episode on this node in the window.
 */
export function breakerRepeatLine(
  repeat: RepeatBreakerEvidence | undefined,
  now: number,
): string | undefined {
  if (!repeat || repeat.priorEpisodeAts.length === 0) return undefined;
  const count = repeat.priorEpisodeAts.length + 1;
  const nowDayKey = dayKeyForTimezone(now, repeat.timeZone);
  const seenDays = new Set<string>();
  const labels: string[] = [];
  for (const at of [...repeat.priorEpisodeAts].sort((a, b) => a - b)) {
    const dayKey = dayKeyForTimezone(at, repeat.timeZone);
    if (seenDays.has(dayKey)) continue;
    seenDays.add(dayKey);
    labels.push(repeatDayLabel(dayKey, nowDayKey));
  }
  return `${repeatOrdinal(
    count,
  )} breaker on this skill in the last week (also ${joinWithAnd(labels)}).`;
}

/** Build the complete staff-facing Slack body for one paused practice episode. */
export function buildStuckAlertBody(input: StuckAlertBodyInput): string {
  const repeatLine = breakerRepeatLine(input.repeatBreaker, input.now);
  const renderedMisses = input.misses
    .map(renderMiss)
    .filter((miss): miss is string => miss !== null);

  if (renderedMisses.length === 0) {
    return [
      scholarOfferLine(input.missStreak, input.breaker),
      `Most recently on **${safeText(input.fallbackSkillLabel)}**.`,
      ...(repeatLine ? [repeatLine] : []),
      "Might be a good moment to check in.",
    ].join("\n");
  }

  const lines = [
    scholarOfferLine(input.missStreak, input.breaker),
  ];
  const tally = sittingLine(input.sitting, input.now);
  if (tally) lines.push(tally);

  lines.push("", ...renderedMisses);
  if (repeatLine) lines.push("", repeatLine);
  lines.push("", "Might be a good moment to check in.");
  return lines.join("\n");
}

/** Build the deterministic calm alert for three consecutive don't-know taps. */
export function buildNotYetTaughtAlertBody(
  input: NotYetTaughtAlertBodyInput,
): string {
  const lines = [
    `Tapped "I haven't learned this yet" on ${input.missStreak} practice items in a row. This reads as material not yet taught, rather than a misconception to unpick.`,
  ];
  const tally = sittingLine(input.sitting, input.now);
  if (tally) lines.push(tally);

  const renderedMisses = input.misses
    .map(renderNotYetTaughtMiss)
    .filter((miss): miss is string => miss !== null);
  if (renderedMisses.length > 0) lines.push("", ...renderedMisses);
  return lines.join("\n");
}
