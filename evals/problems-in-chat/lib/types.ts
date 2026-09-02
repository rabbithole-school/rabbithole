/**
 * Shared types for the ⑮ problems-in-chat eval.
 */
import type { SkillCandidate } from "../../../convex/lib/practice/chatPractice";

/**
 * One scenario = a moment in a tutoring chat, framed so that serving an inline
 * practice item is either pedagogically APPROPRIATE (a natural retrieval beat /
 * a fluency claim to test friendly) or INAPPROPRIATE (the scholar is mid-
 * struggle on something new, or the tutor would be lecture-then-testing).
 *
 * The eval measures whether the tutor's DECISION (serve vs. withhold) and its
 * FRAMING match the moment — plus the hard answer-leak gate.
 */
export interface Scenario {
  id: string;
  description: string;
  /**
   * Whether serving an inline item is the pedagogically right call at this
   * moment. Used to score serve-appropriateness objectively (mechanical serve
   * detection × this flag), independent of the judge.
   */
  expectServe: boolean;
  /**
   * A multi-rep quest may appropriately serve several items across a conversation,
   * but never more than one before the scholar has had space to think and reply.
   */
  expectedMinServes?: number;
  /**
   * The scholar's opening line that sets up the moment (they speak first, as in
   * a real tutoring turn). The sim continues from here.
   */
  scholarOpener: string;
  /**
   * A one-line brief the SIM uses to stay in character (its stance / what it's
   * feeling), never shown to the tutor or judge.
   */
  scholarStance: string;
  /**
   * The scholar's mastery context that populates buildChatPracticeSection —
   * the labels the tutor sees for candidate skills. Kept realistic per scenario.
   */
  fluentLabels: string[];
  frontierLabels: string[];
  dueLabels: string[];
  /**
   * The templated skills the tutor could actually be served (skillKey + label),
   * used to resolve the tutor's free-text `skill` argument and generate a real
   * item. These are the SAME labels surfaced in the *Labels above; the skillKey
   * stays server-side (redaction contract).
   */
  candidates: SkillCandidate[];
  /** The authored quest's cap; passed to the shipped activity prompt builder. */
  problemSetItemCount?: number;
}

/** One line of the conversation. `assistant` = tutor, `user` = scholar. */
export interface Turn {
  role: "user" | "assistant";
  content: string;
}

/** A record of an inline item the tutor served during a conversation. */
export interface ServedItem {
  /** Which tutor turn (0-based index into the turn list) served it. */
  atTurnIndex: number;
  skillArg: string;
  resolvedSkillKey: string | null;
  itemId: string | null;
  stem: string | null;
  /** The true answer — re-derived server-side, given ONLY to sim + judge. */
  correctAnswer: string | null;
}
