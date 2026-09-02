/**
 * Pure logic for the matrixGame Form — mirrors prisonersDilemmaHelpers.ts's
 * shape (see ./prisonersDilemmaHelpers.ts and its test file for the sibling
 * template's coverage).
 *
 * matrixGame's species-slot rule is IDENTICAL to prisonersDilemma's (one
 * self-play slot with defaultCount 2, or two matched slots with defaultCount
 * 1 each, every slot fixed to exactly the `history` Sense) — see
 * validateMatrixGameSpec in lib/simulator/templates/matrixGame.ts. Rather than
 * duplicate that logic, this module re-exports the same generic deck-mode
 * helpers prisonersDilemma.tsx uses.
 */

import type { AdversarialCriterion, MeasuredCriterion, WorldCriterion } from "@/lib/simulator/contract";

export {
  deckModeFromSlots,
  speciesSlotsForDeckMode,
  type PrisonersDilemmaDeckMode as MatrixGameDeckMode,
} from "./prisonersDilemmaHelpers";

/** matrixGame's own criterion shape — never GalleryCriterion (validateMatrixGameSpec rejects it). */
export type MatrixGameCriterion = AdversarialCriterion | MeasuredCriterion;

/**
 * matrixGame's criterion is either the fixed adversarial deck-score pair, or
 * measured over exactly `jointScore` (validateMatrixGameSpec rejects any
 * other measured metricKey). This builds the correctly-shaped criterion for
 * a chosen kind, preserving the previous measured direction/target when
 * switching between the two measured-compatible fields.
 */
export function defaultMatrixGameCriterion(
  kind: "adversarial" | "measured",
  previous?: WorldCriterion,
): MatrixGameCriterion {
  if (kind === "adversarial") {
    return { kind: "adversarial", scoreMetricKeys: ["deckA.totalScore", "deckB.totalScore"] };
  }
  return {
    kind: "measured",
    metricKey: "jointScore",
    direction: previous?.kind === "measured" ? previous.direction : "maximize",
    target: previous?.kind === "measured" ? previous.target : undefined,
  };
}
