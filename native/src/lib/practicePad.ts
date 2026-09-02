/**
 * Native keypad layout for the practice surface — on native (iPad, no hardware
 * keyboard) the on-screen pad is the only way to type, so it stays. On web the
 * equivalent pad was removed (laptops have a keyboard); both surfaces share the
 * same normalization contract below.
 *
 * The framework-free normalization rules (`applyKey`, `choiceSubmitValue`,
 * `isPadAnswerType`, `padShowRemainder`, `PadAnswerType`) live in the
 * cross-surface core (shared/practiceLoop.ts, vendored for Metro) and are
 * re-exported here so this module's importers (and its test) keep a single
 * pad-shaped seam.
 *
 * What stays native-only is the GRID LAYOUT itself (a `react-native` component,
 * not framework-agnostic). The KEY SET follows the shared `applyKey` vocabulary
 * — `/` for fraction/expression, `.` for decimal (plus a wide `/ (fraction)`
 * accessory key, since the grader accepts fraction input by value), and the wide
 * remainder key for expression — so a touch-only scholar
 * can enter every served answer type on either surface. The grid stays out of
 * the shared core only because it's per-framework markup, not because the
 * layouts differ.
 */

import {
  applyKey,
  applyUnitKey,
  choiceSubmitValue,
  isPadAnswerType,
  padShowFraction,
  padShowRemainder,
  padShowSign,
  sanitizePadInput,
  unitKeyFamily,
  UNIT_MISSING_NUDGE,
  UNIT_WRONG_NUDGE,
  DONT_KNOW_LABEL,
  PLACEMENT_SLIP_PROMPT,
  PLACEMENT_SLIP_RETRY_LABEL,
  PLACEMENT_SLIP_CONCEDE_LABEL,
  placementFeedback,
  placementProgress,
  streamStoryOpenTurn,
  makeClientEventId,
  type PadAnswerType,
  type PlacementOutcome,
  type ExplainFetch,
  type StoryThreadTurnResult,
} from "../../vendor/shared/practiceLoop";

export { applyKey, applyUnitKey, choiceSubmitValue, isPadAnswerType, padShowFraction, padShowRemainder, padShowSign, sanitizePadInput, unitKeyFamily, UNIT_MISSING_NUDGE, UNIT_WRONG_NUDGE, DONT_KNOW_LABEL, PLACEMENT_SLIP_PROMPT, PLACEMENT_SLIP_RETRY_LABEL, PLACEMENT_SLIP_CONCEDE_LABEL, placementFeedback, placementProgress, streamStoryOpenTurn, makeClientEventId };
export type { PadAnswerType, PlacementOutcome, ExplainFetch, StoryThreadTurnResult };

/**
 * The bottom-left key of the 3×4 grid: `/` for fraction/expression, `.` for
 * decimal, blank (hidden) for integer. Follows the shared `applyKey` vocabulary.
 */
export function padOpKey(t: PadAnswerType): string {
  if (t === "fraction" || t === "expression") return "/";
  if (t === "decimal") return ".";
  return "";
}

/** The 12 grid keys in row-major order (`""` = a hidden placeholder cell). */
export function padGridKeys(t: PadAnswerType): string[] {
  return ["7", "8", "9", "4", "5", "6", "1", "2", "3", padOpKey(t), "0", "⌫"];
}
