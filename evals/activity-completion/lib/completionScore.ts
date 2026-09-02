/**
 * The PURE completion-timing classifier — no model calls, no I/O, fully
 * unit-tested (runs in `pnpm test`). This is the deterministic core that guards
 * the one thing the `mark_activity_complete` tool can get wrong when the prompt
 * changes: closing a conversation-only activity **too soon** or **too late**.
 *
 * The signal it consumes is produced by the model-in-the-loop driver
 * (`lib/driver.ts`): a synthetic scholar plays through a conversation-only
 * activity against the real production tutor prompt, and we record (a) the
 * scholar-turn at which the tutor first calls `mark_activity_complete` and
 * (b) the scholar-turn at which the sim first signals it genuinely reached the
 * activity's goal (`[[DONE]]`). Given those, timing is objective.
 *
 * The ground-truth "the arc is genuinely finished" signal is the SIM's goal
 * signal, not the tutor's opinion — that's what makes "too soon" measurable:
 * completing before the kid worked the goals through.
 */
import { isValidActivityCompletionClosing } from "../../../convex/lib/activityCompletionTool";
import { isAutomaticCompletionClosing } from "../../../convex/lib/tutorClosingGuidance";

/**
 * Minimum real scholar turns before a completion is legitimate. Mirrors the
 * server-side guard in `activityCompletions.markCompleteFromTool` (>= 2 real
 * scholar turns, excluding the synthetic `<start>` opener) — a "hello" must
 * never complete an activity. Kept in sync deliberately; the eval flags an
 * early call even though the mutation would also refuse it, because an
 * over-eager *call* is the prompt regression we want to catch, guard or no.
 */
export const MIN_REAL_TURNS = 2;

/**
 * How many scholar exchanges after the goal is reached the tutor is allowed to
 * take before we call it "too late". A tutor that asks one more consolidating
 * question before wrapping is fine; one that never wraps is the failure.
 */
export const DEFAULT_GRACE_TURNS = 2;

/** What a fixture expects to happen by the end of the session. */
export type CompletionExpectation = "should-complete" | "should-withhold";

export type CompletionObservation = {
  /**
   * Real-scholar-turn count at the moment the tutor's `mark_activity_complete`
   * call actually MARKED the activity complete (i.e. passed the server-side
   * gate the driver mirrors), or null if it never did. Counts real scholar
   * turns only (the `<start>` opener is not a scholar turn). This is what
   * "marked as done" means, so it drives the timing verdict.
   */
  completedAtScholarTurn: number | null;
  /**
   * Real-scholar-turn count at which the sim first signalled it reached the
   * goal (`[[DONE]]`), or null if the goal was never reached within budget.
   */
  arcCompleteAtScholarTurn: number | null;
  /** Total real scholar turns in the session. */
  totalScholarTurns: number;
  /**
   * Real-scholar-turn count of the tutor's FIRST `mark_activity_complete` call
   * even if it was blocked by the < MIN_REAL_TURNS guard (so it did NOT mark
   * anything). Reporting-only — a soft signal of an over-eager prompt; does not
   * change the verdict. null if no such blocked-early call happened.
   */
  earlyBlockedCallAtScholarTurn?: number | null;
  /**
   * Scholar-visible text from the turn that completed the activity. A natural
   * handoff winds down without a question or a fresh task.
   */
  completionTurnText?: string | null;
  /**
   * Whether the successful completion tool call preceded every scholar-visible
   * text block. False is accepted only when production suppresses all post-tool
   * text and uses the earlier declarative sentence as the sole closing.
   */
  completionToolWasFirst?: boolean | null;
  /**
   * Whether the tutor emitted more scholar-visible text after a successful
   * completion tool. If it spoke before the tool, production treats that text
   * as the closing response and explicitly suppresses a second closing.
   */
  completionHadPostToolText?: boolean | null;
};

/**
 * Objective timing verdict — independent of what a given fixture expected:
 * - `on-time`     — completed at or after the goal was genuinely reached.
 * - `too-soon`    — completed before the goal was reached (or before the
 *                   scholar meaningfully engaged / below MIN_REAL_TURNS).
 * - `too-late`    — the goal was reached but the tutor never completed.
 * - `kept-going`  — completion was on time, but the tutor spoke on both sides
 *                   of the tool or followed with a question/new task.
 * - `withheld`    — the goal was never reached and the tutor never completed
 *                   (correct restraint OR an inconclusive run — the
 *                   expectation decides which; see {@link scoreCompletion}).
 */
export type CompletionVerdict =
  | "on-time"
  | "too-soon"
  | "too-late"
  | "kept-going"
  | "withheld";

export type CompletionScore = {
  verdict: CompletionVerdict;
  /** Whether the verdict matches the fixture's expectation. */
  pass: boolean;
  /** Terse human-readable reason, safe for a report. */
  reason: string;
};

function completionKeepsGoing(
  text: string | null | undefined,
  completionToolWasFirst: boolean | null | undefined,
): boolean {
  return completionToolWasFirst
    ? !isAutomaticCompletionClosing(text ?? "")
    : !isValidActivityCompletionClosing(text ?? "");
}

/** Classify the timing of a single session, expectation-agnostic. */
export function classifyCompletion(
  obs: CompletionObservation,
): CompletionVerdict {
  const { completedAtScholarTurn: completed, arcCompleteAtScholarTurn: arc } =
    obs;

  if (completed !== null) {
    if (completed < MIN_REAL_TURNS) return "too-soon";
    if (arc === null) return "too-soon";
    if (completed < arc) return "too-soon";
    if (
      obs.completionToolWasFirst === false &&
      obs.completionHadPostToolText !== false
    ) {
      return "kept-going";
    }
    if (
      completionKeepsGoing(
        obs.completionTurnText,
        obs.completionToolWasFirst,
      )
    ) {
      return "kept-going";
    }
    return "on-time";
  }
  // Never completed.
  if (arc !== null) return "too-late";
  return "withheld";
}

/** Classify + compare against a fixture's expectation. */
export function scoreCompletion(
  obs: CompletionObservation,
  expectation: CompletionExpectation,
): CompletionScore {
  const verdict = classifyCompletion(obs);
  const { completedAtScholarTurn: completed, arcCompleteAtScholarTurn: arc } =
    obs;

  let pass: boolean;
  let reason: string;

  switch (verdict) {
    case "on-time":
      pass = expectation === "should-complete";
      reason = pass
        ? `Completed at scholar turn ${completed} (goal reached at ${arc}).`
        : `Completed (turn ${completed}) but this fixture expected the tutor to withhold.`;
      break;
    case "too-soon":
      pass = false;
      reason =
        completed !== null && completed < MIN_REAL_TURNS
          ? `Completed at scholar turn ${completed} — before the scholar engaged (< ${MIN_REAL_TURNS} turns).`
          : arc === null
            ? `Completed at scholar turn ${completed} without the goal ever being reached.`
            : `Completed at scholar turn ${completed}, before the goal was reached (turn ${arc}).`;
      break;
    case "too-late":
      pass = false;
      reason = `Goal reached at scholar turn ${arc} but the tutor never marked the activity complete (${obs.totalScholarTurns} turns).`;
      break;
    case "kept-going":
      pass = false;
      reason =
        obs.completionToolWasFirst === false
          ? `Completed at scholar turn ${completed}, but spoke both before and after recording completion.`
          : `Completed at scholar turn ${completed}, but did not provide one brief declarative closing sentence.`;
      break;
    case "withheld":
      // No completion, goal never reached. Correct for a withhold fixture;
      // inconclusive for a complete fixture (the run didn't exercise the arc).
      pass = expectation === "should-withhold";
      reason = pass
        ? `Correctly withheld — the scholar never reached the goal, so nothing was marked complete.`
        : `Inconclusive — the scholar never reached the goal in budget, so completion was never exercised.`;
      break;
  }

  return { verdict, pass, reason };
}
