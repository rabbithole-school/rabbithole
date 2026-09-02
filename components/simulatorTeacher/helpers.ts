"use client";

/**
 * Client-side labels and formatters shared by the teacher World surfaces.
 */

/** Human labels for ecosystemGrid metrics — the criterion + distribution axes. */
export const METRIC_LABEL: Record<string, string> = {
  longevity: "Longevity (ticks)",
  livingAutomata: "Living automata",
  livingSpecies: "Living species",
  resourceBiomass: "Resource biomass",
  totalEnergy: "Total energy",
  births: "Births",
  deaths: "Deaths",
  invalidActions: "Invalid actions",
  traitMean: "Average trait",
  traitSpread: "Trait spread",
  perceptionMean: "Average perception",
  perceptionSpread: "Perception spread",
};

const TRAIT_METRIC_KEYS = new Set([
  "traitMean",
  "traitSpread",
  "perceptionMean",
  "perceptionSpread",
]);

export function availableCriterionMetricKeys(
  metricKeys: readonly string[],
  heredityEnabled: boolean,
): string[] {
  return heredityEnabled
    ? [...metricKeys]
    : metricKeys.filter((key) => !TRAIT_METRIC_KEYS.has(key));
}

export function metricLabel(key: string | null): string {
  if (!key) return "—";
  return METRIC_LABEL[key] ?? key;
}

export function fmt(value: number | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(value)) return "—";
  return Number.isInteger(value) ? String(value) : (Math.round(value * 100) / 100).toString();
}
