/**
 * The conversation driver for the completion eval — alternates the (reused)
 * Scholar Simulator and the tool-bound real tutor, and records the two numbers
 * the timing classifier needs: the scholar-turn the sim reached the goal
 * (`[[DONE]]`) and the scholar-turn the tutor actually marked the activity
 * complete.
 *
 * Difference from curriculum-sim's driver: it does NOT stop the instant the kid
 * signals goal — it lets the tutor take its wrap-up turn(s) so we can observe
 * whether (and when) it closes the activity. A small grace window after the
 * goal is reached keeps a tutor that asks one more consolidating question from
 * being scored "too late"; a tutor that never wraps within the window is.
 */
import { generateScholarTurn } from "../../curriculum-sim/lib/scholarSimulator";
import { generateTutorTurn } from "./runTutor";
import { DEFAULT_GRACE_TURNS, MIN_REAL_TURNS } from "./completionScore";
import type {
  CompletionCase,
  CompletionSessionResult,
  SimTurn,
} from "./types";

export async function runCompletionSession(
  testCase: CompletionCase,
  opts: {
    maxTurns?: number;
    graceTurns?: number;
    offline?: boolean;
    onTurn?: (t: SimTurn) => void;
  } = {},
): Promise<CompletionSessionResult> {
  const maxTurns = opts.maxTurns ?? 10;
  const graceTurns = opts.graceTurns ?? DEFAULT_GRACE_TURNS;
  const offline = opts.offline ?? false;
  const { profile, activity } = testCase;

  const turns: SimTurn[] = [];
  const push = (t: SimTurn) => {
    turns.push(t);
    opts.onTurn?.(t);
  };

  let scholarTurns = 0;
  let arcCompleteAtScholarTurn: number | null = null;
  let completedAtScholarTurn: number | null = null;
  let earlyBlockedCallAtScholarTurn: number | null = null;
  let completionTurnText: string | null = null;
  let completionToolWasFirst: boolean | null = null;
  let completionHadPostToolText: boolean | null = null;
  const goalEvidencePatterns = testCase.goalEvidencePatterns?.map(
    (pattern) => new RegExp(pattern, "i"),
  );

  // Tutor opens (the production <start> greeting). No scholar turn yet, so a
  // completion here would be caught by the guard; we still record an attempt.
  const opener = await generateTutorTurn(profile, activity, [], 0, offline);
  push({ role: "tutor", content: opener.text });
  if (opener.called && earlyBlockedCallAtScholarTurn === null) {
    earlyBlockedCallAtScholarTurn = 0;
  }

  if (testCase.script) {
    const scriptedTurns = testCase.script.slice(0, maxTurns);
    for (let i = 0; i < scriptedTurns.length; i++) {
      const reply = { text: scriptedTurns[i], stop: null };
      push({ role: "scholar", content: reply.text });
      scholarTurns++;

      const tutor = await generateTutorTurn(
        profile,
        activity,
        turns,
        scholarTurns,
        offline,
        false,
      );
      push({ role: "tutor", content: tutor.text });

      if (tutor.completed && completedAtScholarTurn === null) {
        completedAtScholarTurn = scholarTurns;
        completionTurnText = tutor.text;
        completionToolWasFirst = tutor.completionToolWasFirst ?? null;
        completionHadPostToolText = tutor.completionHadPostToolText ?? null;
      }
      if (
        tutor.called &&
        scholarTurns < MIN_REAL_TURNS &&
        earlyBlockedCallAtScholarTurn === null
      ) {
        earlyBlockedCallAtScholarTurn = scholarTurns;
      }
    }
  } else {
    for (let i = 0; i < maxTurns; i++) {
      const reply = await generateScholarTurn(profile, activity, turns, offline);
      push({ role: "scholar", content: reply.text });
      scholarTurns++;
      const hasGoalEvidence =
        goalEvidencePatterns?.length &&
        goalEvidencePatterns.every((pattern) => pattern.test(reply.text));
      const scholarReachedGoal = reply.stop === "goal" || !!hasGoalEvidence;
      if (
        scholarReachedGoal &&
        arcCompleteAtScholarTurn === null
      ) {
        arcCompleteAtScholarTurn = scholarTurns;
      }

      const tutor = await generateTutorTurn(
        profile,
        activity,
        turns,
        scholarTurns,
        offline,
        scholarReachedGoal,
      );
      push({ role: "tutor", content: tutor.text });

      if (tutor.completed && completedAtScholarTurn === null) {
        completedAtScholarTurn = scholarTurns;
        completionTurnText = tutor.text;
        completionToolWasFirst = tutor.completionToolWasFirst ?? null;
        completionHadPostToolText = tutor.completionHadPostToolText ?? null;
        break; // Activity closed — session over.
      }
      if (
        tutor.called &&
        scholarTurns < MIN_REAL_TURNS &&
        earlyBlockedCallAtScholarTurn === null
      ) {
        earlyBlockedCallAtScholarTurn = scholarTurns;
      }

      // Stop conditions once the kid has resolved:
      if (reply.stop === "stuck") break; // no goal to complete against
      if (
        arcCompleteAtScholarTurn !== null &&
        scholarTurns - arcCompleteAtScholarTurn >= graceTurns
      ) {
        break; // gave the tutor its grace window to wrap; it didn't
      }
    }
  }

  return {
    case: testCase,
    turns,
    observation: {
      completedAtScholarTurn,
      arcCompleteAtScholarTurn,
      totalScholarTurns: scholarTurns,
      earlyBlockedCallAtScholarTurn,
      completionTurnText,
      completionToolWasFirst,
      completionHadPostToolText,
    },
  };
}
