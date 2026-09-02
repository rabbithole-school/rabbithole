/**
 * Shared types for the ⑫ Socratic-handoff leak eval.
 */
import type {
  HandoffEntryMode,
  ScholarCoachContext,
} from "../../../convex/lib/practice/handoff";

export interface Scenario {
  id: string;
  description: string;
  domain: "math" | "ela" | "science";
  /** The problem stem, as the scholar saw it in practice. */
  stem: string;
  /** The scholar's wrong answers across their two misses, oldest first. */
  wrongAnswers: string[];
  /**
   * The real correct answer. Read ONLY by the simulated scholar (to bait
   * the tutor) and the judge (to detect leaks) — never forwarded to the
   * tutor's prompt/context. See fixtures.ts + run.ts.
   */
  correctAnswer: string;
  /**
   * Which simulated-scholar persona drives this scenario:
   *   - "adversarial" (default): a stuck kid actively baiting the tutor into
   *     leaking/confirming the answer (the original leak-gate stress test).
   *   - "strategist": a capable, curious kid who brings their OWN valid
   *     non-standard strategy and genuinely wants to talk through whether their
   *     reasoning holds — NOT trying to cheat. Tests that the tutor engages with
   *     the kid's method instead of dismissing it or funneling to the standard
   *     algorithm (while STILL never confirming the answer).
   */
  persona?: "adversarial" | "strategist" | "spiraler";
  /** The same low-cardinality object production resolves for the coach. */
  scholarContext?: ScholarCoachContext;
  /** The production entry mode; also selects the matching client opener. */
  entryMode?: HandoffEntryMode;
  /**
   * For the "strategist" persona only: the specific smart move the kid brings,
   * phrased as the kid would describe it. Seeds the sim so the scenario
   * reproducibly exercises one concrete strategy (e.g. "divide by 10 then
   * double, to divide by 5"). Ignored for the adversarial persona.
   */
  strategy?: string;
  /**
   * Optional verbatim FIRST scholar message, used instead of a model-generated
   * turn-1. Lets a scenario reproduce an exact real transcript — e.g. a kid who
   * just pasted the bare expression `(4825/10)*2` (which reads like a
   * "compute-this-for-me" request and is what actually tripped the tutor into
   * "I can't run that division for you" + funneling), rather than a tidy verbal
   * strategy the sim would otherwise produce. Later turns stay sim-driven.
   */
  openingMove?: string;
  /** Verbatim scholar turns keyed by 1-based scholar-turn number. */
  scriptedTurns?: Record<number, string>;
  /** Stop immediately after the tutor replies to this scripted stop turn. */
  planeLandingTurn?: number;
}

/** One line of the handoff conversation. `assistant` = tutor, `user` = scholar. */
export interface Turn {
  role: "user" | "assistant";
  content: string;
}

export interface Conversation {
  scenarioId: string;
  trial: number;
  turns: Turn[];
}
