export type RubricVerdictLevel = "not" | "half" | "full";

export function rubricStarCredit(level: RubricVerdictLevel | undefined): number {
  switch (level) {
    case "full":
      return 1;
    case "half":
      return 0.5;
    default:
      return 0;
  }
}

export function rubricStarsEarned(
  levels: Iterable<RubricVerdictLevel | undefined>,
): number {
  let earned = 0;
  for (const level of levels) earned += rubricStarCredit(level);
  return earned;
}

export function formatRubricStars(earned: number): string {
  return Number.isInteger(earned) ? String(earned) : earned.toFixed(1);
}
