/**
 * Pure logic for the publicGoods Form — mirrors prisonersDilemmaHelpers.ts's
 * shape (see ./prisonersDilemmaHelpers.ts and its test file for the sibling
 * template's coverage).
 *
 * The multiplier constraint mirrors validatePopulation's own gate in
 * lib/simulator/templates/publicGoods.ts exactly (`1 < multiplier < launched
 * player count`) — surfaced here as an inline HINT while the server
 * validator remains the actual gate.
 */

export const PUBLIC_GOODS_CRITERION_METRIC_KEYS = [
  "groupWelfare",
  "minScore",
  "contributionRate",
] as const;

export type PublicGoodsCriterionMetricKey = (typeof PUBLIC_GOODS_CRITERION_METRIC_KEYS)[number];

/** Plain-language noun phrases for the picker buttons — never the raw key. */
export const PUBLIC_GOODS_METRIC_LABEL: Record<PublicGoodsCriterionMetricKey, string> = {
  groupWelfare: "Group welfare (total score)",
  minScore: "Lowest score (fairness floor)",
  contributionRate: "Contribution rate",
};

/**
 * The one-line goal sentence for a metric+direction pair. minScore+maximize
 * gets the plain-language phrase called out by the catalog guidance
 * ("lift the lowest score" — i.e. maximin fairness); the other common
 * maximize pairings get their own plain phrasing; anything else (minimize,
 * target, or an unrecognized key) falls back to a generic "<verb> <label>"
 * sentence built from the metric's noun phrase.
 */
export function publicGoodsGoalSentence(
  metricKey: string,
  direction: "maximize" | "minimize" | "target",
): string {
  if (metricKey === "minScore" && direction === "maximize") return "Lift the lowest score";
  if (metricKey === "groupWelfare" && direction === "maximize") return "Grow total welfare";
  if (metricKey === "contributionRate" && direction === "maximize") return "Encourage contribution";
  const label =
    PUBLIC_GOODS_METRIC_LABEL[metricKey as PublicGoodsCriterionMetricKey] ?? metricKey;
  const verb = direction === "minimize" ? "Hold down" : direction === "target" ? "Aim for a target" : "Maximize";
  return `${verb} ${label.toLowerCase()}`;
}

/** Human-readable multiplier-constraint violations, or [] when it's legal. */
export function multiplierIssues(multiplier: number, launchedPlayers: number): string[] {
  const issues: string[] = [];
  if (!(multiplier > 1)) {
    issues.push("Multiplier must be greater than 1.");
  }
  if (!(multiplier < launchedPlayers)) {
    issues.push(
      `Multiplier must be less than the number of players launched by default (${launchedPlayers}).`,
    );
  }
  return issues;
}

/** The population actually launched by the default prompt deck — sum of every slot's defaultCount. */
export function totalDefaultCount(slots: readonly { defaultCount: number }[]): number {
  return slots.reduce((sum, slot) => sum + slot.defaultCount, 0);
}
