/**
 * Pure logic for the prisonersDilemma Form — kept framework-free so it can be
 * unit tested the same way as ../helpers.ts, per the components/simulatorTeacher
 * test convention (co-located `<name>.test.ts`, no React rendering).
 *
 * The payoff-ordering check mirrors validatePrisonersDilemmaConfig's own
 * `payoffMatrix()` gate in lib/simulator/templates/prisonersDilemma.ts exactly —
 * these are surfaced as inline HINTS while the server validator remains the
 * actual gate (a hint that drifted stale would just be a UI annoyance, never
 * a saved illegal spec).
 */

import type { PrisonersDilemmaPayoffMatrix, SpeciesSlot } from "@/lib/simulator/contract";

export type PrisonersDilemmaDeckMode = "selfPlay" | "twoDecks";

/** Human-readable payoff-ordering violations, or [] when the matrix is legal. */
export function payoffOrderingIssues(matrix: PrisonersDilemmaPayoffMatrix): string[] {
  const issues: string[] = [];
  if (!(matrix.temptation > matrix.mutualCooperation)) {
    issues.push("Temptation must be greater than mutual cooperation.");
  }
  if (!(matrix.mutualCooperation > matrix.mutualDefection)) {
    issues.push("Mutual cooperation must be greater than mutual defection.");
  }
  if (!(matrix.mutualDefection > matrix.sucker)) {
    issues.push("Mutual defection must be greater than the sucker payoff.");
  }
  if (!(2 * matrix.mutualCooperation > matrix.temptation + matrix.sucker)) {
    issues.push(
      "Mutual cooperation must beat alternating exploitation: 2× mutual cooperation must exceed temptation + sucker.",
    );
  }
  return issues;
}

/** Whether the current species slots represent one self-play deck or two matched decks. */
export function deckModeFromSlots(slots: readonly SpeciesSlot[]): PrisonersDilemmaDeckMode {
  return slots.length >= 2 ? "twoDecks" : "selfPlay";
}

/**
 * Rebuild the speciesSlots array for a chosen deck mode, preserving labels and
 * starter hints from the current slots where they carry over. The result
 * always sums defaultCount to exactly 2 (prisonersDilemma's maxAutomata).
 */
export function speciesSlotsForDeckMode(
  mode: PrisonersDilemmaDeckMode,
  current: readonly SpeciesSlot[],
): SpeciesSlot[] {
  const first = current[0];
  const second = current[1];
  if (mode === "selfPlay") {
    return [
      {
        slotId: first?.slotId ?? "deck",
        label: first?.label ?? "Deck",
        countMin: 2,
        countMax: 2,
        defaultCount: 2,
        senses: [{ senseId: "history" }],
        starterHint: first?.starterHint,
      },
    ];
  }
  return [
    {
      slotId: first?.slotId && first.slotId !== "deck" ? first.slotId : "deck_a",
      label: first?.label && first.label !== "Deck" ? first.label : "Deck A",
      countMin: 1,
      countMax: 1,
      defaultCount: 1,
      senses: [{ senseId: "history" }],
      starterHint: first?.starterHint,
    },
    {
      slotId: second?.slotId ?? "deck_b",
      label: second?.label ?? "Deck B",
      countMin: 1,
      countMax: 1,
      defaultCount: 1,
      senses: [{ senseId: "history" }],
      starterHint: second?.starterHint,
    },
  ];
}
