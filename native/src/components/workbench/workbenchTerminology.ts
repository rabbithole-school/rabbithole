import type { DecisionSource, SimulatorSpec } from "../../../vendor/simulator/contract";
import {
  getWorkbenchRendererFamily,
  workbenchTimeNoun as timeNounForTemplate,
} from "../../../vendor/simulator/templates/registry";

export function isRoundBasedWorkbench(spec: SimulatorSpec | undefined): boolean {
  const family = spec ? getWorkbenchRendererFamily(spec.templateId) : null;
  return family === "match" || family === "commons";
}

export function workbenchTimeNoun(spec: SimulatorSpec | undefined): "day" | "round" {
  return spec ? timeNounForTemplate(spec.templateId) : "day";
}

export function workbenchActorNoun(spec: SimulatorSpec | undefined): "species" | "player" {
  return isRoundBasedWorkbench(spec) ? "player" : "species";
}

export function workbenchDeckNoun(spec: SimulatorSpec | undefined): "prompt deck" | "strategy rules" {
  return isRoundBasedWorkbench(spec) ? "strategy rules" : "prompt deck";
}

export function formatDecisionSource(source: DecisionSource | undefined): string {
  switch (source) {
    case "compiled":
      return "Rule ran exactly";
    case "compiled-fallback":
      return "Rule fallback";
    case "decision_cache":
      return "Recorded decision";
    case "model":
      return "Model read the prompt";
    default:
      return "Decision source not recorded";
  }
}

export function disambiguatedActorLabels(
  actors: readonly { label: string }[],
): readonly string[] {
  const counts = new Map<string, number>();
  for (const actor of actors) {
    counts.set(actor.label, (counts.get(actor.label) ?? 0) + 1);
  }
  const seen = new Map<string, number>();
  return actors.map((actor) => {
    if ((counts.get(actor.label) ?? 0) < 2) return actor.label;
    const occurrence = (seen.get(actor.label) ?? 0) + 1;
    seen.set(actor.label, occurrence);
    return `${actor.label} ${occurrence}`;
  });
}

export function isSelectedMatchPayoffCell(
  round: { actors: readonly { actionId: string }[] } | undefined,
  rowActionId: string,
  columnActionId: string,
): boolean {
  return (
    round?.actors[0]?.actionId === rowActionId &&
    round.actors[1]?.actionId === columnActionId
  );
}
