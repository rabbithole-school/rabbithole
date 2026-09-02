import type {
  WorkbenchCommonsRoundEvidence,
  WorkbenchMatchRoundActorEvidence,
  WorkbenchMatchRoundEvidence,
} from "./scene";

export type MatchAction = {
  id: string;
  label: string;
};

export type MatchResponseCount = {
  sawActionId: string;
  nextActionId: string;
  count: number;
};

export type MatchRuleBand = {
  id: string;
  label: string;
  kind: "rule" | "fallback";
  rounds: readonly number[];
};

export type MatchVisualActor = {
  id: string;
  label: string;
  detailsRedacted: boolean;
  actions: readonly {
    round: number;
    actionId: string;
    actionLabel: string;
    cumulativeTotal: number;
    misperceived: boolean;
  }[];
  responseCounts: readonly MatchResponseCount[];
  ruleBands: readonly MatchRuleBand[];
};

export type MatchVisualModel = {
  actions: readonly MatchAction[];
  actors: readonly MatchVisualActor[];
};

export type CommonsPotActor = {
  id: string;
  label: string;
  contributed: number;
  kept: number;
  share: number;
  payoff: number;
  cumulativeTotal: number;
  perceivedContributorCount: number;
  actualContributorCount: number;
  misperceived: boolean;
};

export type CommonsPotModel = {
  round: number;
  contributors: number;
  players: number;
  inputPool: number;
  multiplier: number;
  grownPool: number;
  sharePerPlayer: number;
  actors: readonly CommonsPotActor[];
};

/** Framework-free conservation accounting for the web and native pot views. */
export function commonsPotModel(input: {
  round: WorkbenchCommonsRoundEvidence;
  endowment: number;
  multiplier: number;
  labels?: readonly string[];
}): CommonsPotModel {
  const { round, endowment, multiplier, labels = [] } = input;
  return {
    round: round.round,
    contributors: round.contributorCount,
    players: round.actors.length,
    inputPool: round.contributorCount * endowment,
    multiplier,
    grownPool: round.pool,
    sharePerPlayer: round.sharePerPlayer,
    actors: round.actors.map((actor, index) => {
      const contributed = actor.actionId === "contribute" ? endowment : 0;
      return {
        id: actor.id,
        label: labels[index] ?? actor.label,
        contributed,
        kept: endowment - contributed,
        share: round.sharePerPlayer,
        payoff: actor.roundPayoff,
        cumulativeTotal: actor.cumulativeTotal,
        perceivedContributorCount: actor.perception.perceivedContributorCount,
        actualContributorCount: actor.perception.actualContributorCount,
        misperceived: actor.perception.misperceived,
      };
    }),
  };
}

function actorAt(
  round: WorkbenchMatchRoundEvidence,
  actorId: string,
): WorkbenchMatchRoundActorEvidence | undefined {
  return round.actors.find((actor) => actor.id === actorId);
}

function orderedActions(
  evidence: readonly WorkbenchMatchRoundEvidence[],
): readonly MatchAction[] {
  const actions = new Map<string, string>();
  for (const round of evidence) {
    for (const actor of round.actors) {
      if (!actions.has(actor.actionId)) actions.set(actor.actionId, actor.actionLabel);
      if (!actions.has(actor.perception.sawOpponentActionId)) {
        actions.set(
          actor.perception.sawOpponentActionId,
          actor.perception.sawOpponentActionLabel,
        );
      }
    }
  }
  return [...actions].map(([id, label]) => ({ id, label }));
}

function responseCounts(
  evidence: readonly WorkbenchMatchRoundEvidence[],
  actorId: string,
  actions: readonly MatchAction[],
): readonly MatchResponseCount[] {
  const counts = new Map<string, number>();
  for (const action of actions) {
    for (const nextAction of actions) {
      counts.set(`${action.id}\0${nextAction.id}`, 0);
    }
  }
  for (let index = 0; index < evidence.length - 1; index += 1) {
    const reading = actorAt(evidence[index], actorId);
    const nextDecision = actorAt(evidence[index + 1], actorId);
    if (!reading || !nextDecision) continue;
    const key = `${reading.perception.sawOpponentActionId}\0${nextDecision.actionId}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts].map(([key, count]) => {
    const [sawActionId, nextActionId] = key.split("\0");
    return { sawActionId, nextActionId, count };
  });
}

function ruleBands(
  evidence: readonly WorkbenchMatchRoundEvidence[],
  actorId: string,
): readonly MatchRuleBand[] {
  const bands = new Map<
    string,
    { label: string; kind: MatchRuleBand["kind"]; rounds: number[] }
  >();
  for (const round of evidence) {
    const actor = actorAt(round, actorId);
    if (!actor || actor.detailsRedacted) continue;
    const fallback = actor.decisionSource === "compiled-fallback";
    const id = fallback
      ? "compiled-fallback"
      : actor.policyRuleId
        ? `rule:${actor.policyRuleId}`
        : null;
    if (!id) continue;
    const existing = bands.get(id) ?? {
      label: fallback ? "No compiled match" : actor.policyRuleId!,
      kind: fallback ? "fallback" : "rule",
      rounds: [],
    };
    existing.rounds.push(round.round);
    bands.set(id, existing);
  }
  return [...bands.entries()]
    .map(([id, band]) => ({ id, ...band }))
    .sort(
      (left, right) =>
        right.rounds.length - left.rounds.length ||
        left.rounds[0] - right.rounds[0] ||
        left.label.localeCompare(right.label),
    );
}

export function matchVisualModel(
  evidence: readonly WorkbenchMatchRoundEvidence[],
): MatchVisualModel {
  const actions = orderedActions(evidence);
  const firstSeenActors = new Map<string, WorkbenchMatchRoundActorEvidence>();
  for (const round of evidence) {
    for (const actor of round.actors) {
      if (!firstSeenActors.has(actor.id)) firstSeenActors.set(actor.id, actor);
    }
  }
  return {
    actions,
    actors: [...firstSeenActors.values()].map((firstActor) => ({
      id: firstActor.id,
      label: firstActor.label,
      detailsRedacted: Boolean(firstActor.detailsRedacted),
      actions: evidence.flatMap((round) => {
        const actor = actorAt(round, firstActor.id);
        return actor
          ? [{
              round: round.round,
              actionId: actor.actionId,
              actionLabel: actor.actionLabel,
              cumulativeTotal: actor.cumulativeTotal,
              misperceived: actor.perception.misperceived,
            }]
          : [];
      }),
      responseCounts: responseCounts(evidence, firstActor.id, actions),
      ruleBands: ruleBands(evidence, firstActor.id),
    })),
  };
}
