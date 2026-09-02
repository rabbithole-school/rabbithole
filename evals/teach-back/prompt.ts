/**
 * The teach-back eval SHIPS from convex/lib/teachBack.ts. This re-export keeps
 * the eval testing exactly what ships — the tutor-visible prompt section, the
 * two tool specs, the guidance strings each tool hands back to the model, and
 * the grader's prompt/tool/validator cannot drift from what the live tutor
 * would receive once TEACH_BACK_ENABLED flips on.
 *
 * The gate itself (teachBackEnabled()) is NOT exercised here: the eval's whole
 * point is to measure the behavior AS IF the feature were on, so we import
 * buildTeachBackSection + the tools directly. In production the same text and
 * tools are wired only when TEACH_BACK_ENABLED is set. See that module + the
 * PR #591 "before enable" note, and FINDINGS.md for the measured scores.
 */
export {
  buildTeachBackSection,
  START_TEACH_BACK_TOOL,
  FINISH_TEACH_BACK_TOOL,
  teachBackStartGuidance,
  TEACH_BACK_FINISH_GUIDANCE,
  TEACH_BACK_NO_ACTIVE_GUIDANCE,
  buildTeachBackGradingPrompt,
  parseTeachBackRubric,
  TEACH_BACK_GRADING_TOOL,
  type TeachBackRubric,
} from "../../convex/lib/teachBack";
