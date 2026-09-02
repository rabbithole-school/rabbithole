import type {
  DecisionSource,
  MatrixGameActionId,
  SimulatorSpec,
} from "@/lib/simulator/contract";

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

export type PayoffMatrixCell = {
  rowActionId: string;
  columnActionId: string;
  rowPayoff: number;
  columnPayoff: number;
};

export type MatchPayoffMatrix = {
  rowActions: readonly { id: string; label: string }[];
  columnActions: readonly { id: string; label: string }[];
  cells: readonly PayoffMatrixCell[];
};

const PRISONERS_DILEMMA_ACTIONS = [
  { id: "cooperate", label: "Cooperate" },
  { id: "defect", label: "Defect" },
] as const;

export function matchPayoffMatrix(
  spec: Extract<SimulatorSpec, { templateId: "prisonersDilemma" | "matrixGame" }>,
): MatchPayoffMatrix {
  if (spec.templateId === "matrixGame") {
    const actions = spec.config.actions.map((action) => ({
      id: action.actionId,
      label: action.label,
    }));
    return {
      rowActions: actions,
      columnActions: actions,
      cells: actions.flatMap((row) =>
        actions.map((column) => {
          const payoff = spec.config.payoffs[row.id as MatrixGameActionId][column.id as MatrixGameActionId];
          return {
            rowActionId: row.id,
            columnActionId: column.id,
            rowPayoff: payoff.a,
            columnPayoff: payoff.b,
          };
        }),
      ),
    };
  }

  const payoff = spec.config.payoffMatrix;
  const byPair: Record<string, readonly [number, number]> = {
    "cooperate:cooperate": [payoff.mutualCooperation, payoff.mutualCooperation],
    "cooperate:defect": [payoff.sucker, payoff.temptation],
    "defect:cooperate": [payoff.temptation, payoff.sucker],
    "defect:defect": [payoff.mutualDefection, payoff.mutualDefection],
  };
  return {
    rowActions: PRISONERS_DILEMMA_ACTIONS,
    columnActions: PRISONERS_DILEMMA_ACTIONS,
    cells: PRISONERS_DILEMMA_ACTIONS.flatMap((row) =>
      PRISONERS_DILEMMA_ACTIONS.map((column) => {
        const [rowPayoff, columnPayoff] = byPair[`${row.id}:${column.id}`];
        return {
          rowActionId: row.id,
          columnActionId: column.id,
          rowPayoff,
          columnPayoff,
        };
      }),
    ),
  };
}
