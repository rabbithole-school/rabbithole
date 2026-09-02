import type {
  EcosystemGridSimulatorSpec,
  SimulatorSceneEntityV1,
  SimulatorSceneV1,
  SimulatorSense,
} from "./contract";

export type EcosystemInspectableSenseId = "vision" | "smell";

export const ECOSYSTEM_DEFAULT_SENSE_CHANNELS = {
  vision: ["automata", "resources", "corpses", "terrain", "boundary"],
  smell: ["automata", "resources", "corpses"],
  touch: ["automata", "resources", "corpses", "terrain", "boundary"],
} as const;

export const ECOSYSTEM_SHALLOWS_SENSE_PENALTY = 2;

export function effectiveEcosystemSenseRange({
  sense,
  perceptionTrait = 1,
  inShallows,
}: {
  sense: SimulatorSense;
  perceptionTrait?: number;
  inShallows: boolean;
}): number {
  const authoredRange = sense.range ?? (sense.senseId === "touch" ? 0 : 1);
  return Math.max(
    0,
    Math.round(authoredRange * perceptionTrait) -
      (inShallows && (sense.senseId === "vision" || sense.senseId === "smell")
        ? ECOSYSTEM_SHALLOWS_SENSE_PENALTY
        : 0),
  );
}

function axisDistance(
  from: number,
  to: number,
  size: number,
  boundary: SimulatorSceneV1["viewport"]["boundary"],
): number {
  const direct = Math.abs(to - from);
  return boundary === "toroidal" ? Math.min(direct, size - direct) : direct;
}

export function ecosystemGridDistance(
  from: { x: number; y: number },
  to: { x: number; y: number },
  viewport: SimulatorSceneV1["viewport"],
): number {
  return (
    axisDistance(from.x, to.x, viewport.width, viewport.boundary) +
    axisDistance(from.y, to.y, viewport.height, viewport.boundary)
  );
}

export type EcosystemSenseTarget = {
  key: string;
  x: number;
  y: number;
  kind: "automaton" | "resource" | "corpse" | "terrain";
  status: "perceived" | "hidden";
  label: string;
};

export type EcosystemSenseProjection = {
  actorId: string;
  actorLabel: string;
  senseId: EcosystemInspectableSenseId;
  range: number;
  targets: readonly EcosystemSenseTarget[];
};

export type EcosystemSenseCoverage = {
  actorId: string;
  actorLabel: string;
  senseId: EcosystemInspectableSenseId;
  range: number;
  cells: readonly { x: number; y: number }[];
};

type EcosystemSenseContext = {
  actor: SimulatorSceneEntityV1;
  slot: EcosystemGridSimulatorSpec["speciesSlots"][number];
  sense: SimulatorSense;
  range: number;
};

function ecosystemSenseContext({
  spec,
  scene,
  actorId,
  senseId,
}: {
  spec: EcosystemGridSimulatorSpec;
  scene: SimulatorSceneV1;
  actorId: string;
  senseId: EcosystemInspectableSenseId;
}): EcosystemSenseContext | null {
  const actor = scene.entities.find(
    (entity) => entity.kind === "automaton" && entity.id === actorId,
  );
  if (!actor?.slotId) return null;
  const slot = spec.speciesSlots.find((candidate) => candidate.slotId === actor.slotId);
  const sense = slot?.senses.find((candidate) => candidate.senseId === senseId);
  if (!slot || !sense) return null;

  const inShallows =
    spec.config.terrain?.shallows.some(
      (cell) => cell.x === actor.x && cell.y === actor.y,
    ) ?? false;
  return {
    actor,
    slot,
    sense,
    range: effectiveEcosystemSenseRange({
      sense,
      perceptionTrait: actor.perceptionTrait,
      inShallows,
    }),
  };
}

/**
 * The one coverage projection for Sense lenses. It uses the same wrapped
 * Manhattan distance and effective range as model-visible ecosystem senses.
 */
export function projectEcosystemSenseCoverage(input: {
  spec: EcosystemGridSimulatorSpec;
  scene: SimulatorSceneV1;
  actorId: string;
  senseId: EcosystemInspectableSenseId;
}): EcosystemSenseCoverage | null {
  const context = ecosystemSenseContext(input);
  if (!context) return null;
  const cells: { x: number; y: number }[] = [];
  for (let y = 0; y < input.scene.viewport.height; y += 1) {
    for (let x = 0; x < input.scene.viewport.width; x += 1) {
      if (ecosystemGridDistance(context.actor, { x, y }, input.scene.viewport) <= context.range) {
        cells.push({ x, y });
      }
    }
  }
  return {
    actorId: input.actorId,
    actorLabel: context.actor.label ?? context.slot.label,
    senseId: input.senseId,
    range: context.range,
    cells,
  };
}

function entityTarget(
  entity: SimulatorSceneEntityV1,
  senseId: EcosystemInspectableSenseId,
): EcosystemSenseTarget {
  const kind = entity.kind === "corpse" ? "corpse" : "automaton";
  const hiddenFromSight = senseId === "smell" && Boolean(entity.hidden);
  return {
    key: `entity:${entity.id}`,
    x: entity.x,
    y: entity.y,
    kind,
    status: hiddenFromSight ? "hidden" : "perceived",
    label: hiddenFromSight
      ? `${entity.label ?? "Automaton"} is detected by scent but hidden from sight`
      : `${entity.label ?? (kind === "corpse" ? "Corpse" : "Automaton")} is in ${senseId === "vision" ? "sight" : "scent"} range`,
  };
}

export function projectEcosystemSense({
  spec,
  scene,
  actorId,
  senseId,
}: {
  spec: EcosystemGridSimulatorSpec;
  scene: SimulatorSceneV1;
  actorId: string;
  senseId: EcosystemInspectableSenseId;
}): EcosystemSenseProjection | null {
  const context = ecosystemSenseContext({ spec, scene, actorId, senseId });
  if (!context) return null;
  const { actor, slot, sense, range } = context;
  const channels =
    sense.channels ??
    ECOSYSTEM_DEFAULT_SENSE_CHANNELS[
      senseId as keyof typeof ECOSYSTEM_DEFAULT_SENSE_CHANNELS
    ];
  const inRange = (target: { x: number; y: number }) =>
    ecosystemGridDistance(actor, target, scene.viewport) <= range;
  const targets: EcosystemSenseTarget[] = [];

  if (channels.includes("automata")) {
    targets.push(
      ...scene.entities
        .filter(
          (entity) =>
            entity.kind === "automaton" &&
            entity.id !== actor.id &&
            (senseId !== "vision" || !entity.hidden) &&
            inRange(entity),
        )
        .map((entity) => entityTarget(entity, senseId)),
    );
  }
  if (channels.includes("corpses")) {
    targets.push(
      ...scene.entities
        .filter((entity) => entity.kind === "corpse" && inRange(entity))
        .map((entity) => entityTarget(entity, senseId)),
    );
  }
  if (channels.includes("resources")) {
    targets.push(
      ...scene.cells
        .filter((cell) => cell.kind === "resource" && inRange(cell))
        .map((cell) => ({
          key: `resource:${cell.x}:${cell.y}`,
          x: cell.x,
          y: cell.y,
          kind: "resource" as const,
          status: "perceived" as const,
          label: `Resource is in ${senseId === "vision" ? "sight" : "scent"} range`,
        })),
    );
  }
  if (channels.includes("terrain")) {
    targets.push(
      ...scene.cells
        .filter((cell) => cell.kind !== "resource" && inRange(cell))
        .map((cell) => ({
          key: `terrain:${cell.kind}:${cell.x}:${cell.y}`,
          x: cell.x,
          y: cell.y,
          kind: "terrain" as const,
          status: "perceived" as const,
          label: `${cell.kind.replaceAll("_", " ")} is in sight range`,
        })),
    );
  }

  return {
    actorId,
    actorLabel: actor.label ?? slot.label,
    senseId,
    range,
    targets,
  };
}
