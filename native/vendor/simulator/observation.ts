/**
 * Turn a raw Automaton observation / action into short, kid-grade prose for the
 * Mind panel (QB walkthrough W2). A nine-year-old reads "algae patch here
 * (thick) · another creature 4 tiles north-east", not
 * `{self:{energy:9.743…}, vision:{…}}`. Honest data, readable first — the raw
 * JSON stays one disclosure away.
 *
 * NEUTRAL LANGUAGE (plan §4.3): these are FACTS about what the Automaton
 * perceived and chose. Nothing here diagnoses the scholar or the prompt.
 *
 * Coordinate convention (from lib/simulator/templates/ecosystemGrid.ts):
 *   dx = target.x − self.x  → +east / −west
 *   dy = target.y − self.y  → +south / −north   (grid y increases downward)
 *   distance = |dx| + |dy|  (Manhattan)
 *   biomass ∈ [0, 10]       (RESOURCE_CAPACITY)
 */

const RESOURCE_CAPACITY = 10;

interface Rel {
  dx?: number;
  dy?: number;
  distance?: number;
}
interface SensedAutomatonLite extends Rel {
  id?: string;
  slotId?: string;
  energy?: number;
  hidden?: boolean;
}
interface SensedResourceLite extends Rel {
  x?: number;
  y?: number;
  biomass?: number;
}
interface SensedCorpseLite extends Rel {
  slotId?: string;
}
interface SenseReadingLite {
  automata?: SensedAutomatonLite[];
  resources?: SensedResourceLite[];
  corpses?: SensedCorpseLite[];
  boundary?: Array<string | { side?: string; distance?: number }>;
}
interface ObservationLite {
  self?: { energy?: number; hidden?: boolean; x?: number; y?: number };
  vision?: SenseReadingLite;
  smell?: SenseReadingLite;
  touch?: SenseReadingLite;
}

const SENSE_KEYS = ["vision", "smell", "touch"] as const;

/** A compass phrase from a relative offset. "here" when both axes are zero. */
export function directionPhrase(dx: number, dy: number): string {
  const vertical = dy < 0 ? "north" : dy > 0 ? "south" : "";
  const horizontal = dx < 0 ? "west" : dx > 0 ? "east" : "";
  if (!vertical && !horizontal) return "here";
  if (vertical && horizontal) return `${vertical}-${horizontal}`;
  return vertical || horizontal;
}

/** "here" · "1 tile south" · "4 tiles north-east". */
export function distancePhrase(dx: number, dy: number, distance?: number): string {
  const dist = distance ?? Math.abs(dx) + Math.abs(dy);
  if (dist === 0) return "here";
  const dir = directionPhrase(dx, dy);
  return `${dist} ${dist === 1 ? "tile" : "tiles"} ${dir}`;
}

/** How full an algae patch is, in words a kid can read off the color. */
export function biomassWord(biomass: number): "thick" | "medium" | "thin" {
  const ratio = biomass / RESOURCE_CAPACITY;
  if (ratio >= 0.66) return "thick";
  if (ratio >= 0.33) return "medium";
  return "thin";
}

function mergeAutomata(observation: ObservationLite): SensedAutomatonLite[] {
  const byId = new Map<string, SensedAutomatonLite>();
  for (const key of SENSE_KEYS) {
    for (const automaton of observation[key]?.automata ?? []) {
      const id = automaton.id ?? JSON.stringify([automaton.dx, automaton.dy]);
      const existing = byId.get(id);
      if (!existing || (automaton.distance ?? Infinity) < (existing.distance ?? Infinity)) {
        byId.set(id, automaton);
      }
    }
  }
  return [...byId.values()].sort((a, b) => (a.distance ?? 0) - (b.distance ?? 0));
}

function mergeResources(observation: ObservationLite): SensedResourceLite[] {
  const byPoint = new Map<string, SensedResourceLite>();
  for (const key of SENSE_KEYS) {
    for (const resource of observation[key]?.resources ?? []) {
      const point = `${resource.x},${resource.y}`;
      const existing = byPoint.get(point);
      if (!existing || (resource.distance ?? Infinity) < (existing.distance ?? Infinity)) {
        byPoint.set(point, resource);
      }
    }
  }
  return [...byPoint.values()].sort((a, b) => (a.distance ?? 0) - (b.distance ?? 0));
}

function mergeBoundary(observation: ObservationLite): Array<{ side: string; distance?: number }> {
  const walls = new Map<string, number | undefined>();
  for (const key of SENSE_KEYS) {
    for (const boundary of observation[key]?.boundary ?? []) {
      const side = typeof boundary === "string" ? boundary : boundary.side;
      if (!side) continue;
      const distance = typeof boundary === "string" ? undefined : boundary.distance;
      const current = walls.get(side);
      if (current === undefined || (distance !== undefined && distance < current)) {
        walls.set(side, distance);
      }
    }
  }
  return ["north", "east", "south", "west"]
    .filter((side) => walls.has(side))
    .map((side) => ({ side, distance: walls.get(side) }));
}

function speciesName(slotId: string | undefined, labelBySlot?: Record<string, string>): string {
  if (slotId && labelBySlot?.[slotId]) return labelBySlot[slotId];
  return "another creature";
}

/**
 * Short prose lines for the SAW panel. Nearest few of each kind; capped so the
 * panel stays a glance, not a wall of text. Returns [] when nothing is sensed.
 */
export function describeObservation(
  observationJson: string | undefined,
  labelBySlot?: Record<string, string>,
  options?: { maxResources?: number; maxAutomata?: number },
): string[] {
  if (!observationJson) return [];
  let observation: ObservationLite;
  try {
    observation = JSON.parse(observationJson) as ObservationLite;
  } catch {
    return [];
  }
  const lines: string[] = [];

  if (typeof observation.self?.energy === "number") {
    lines.push(`your energy: ${observation.self.energy.toFixed(1)}`);
  }
  if (observation.self?.hidden) lines.push("you are hidden");

  const walls = mergeBoundary(observation);
  if (walls.length > 0) {
    lines.push(
      `walls: ${walls
        .map(({ side, distance }) =>
          distance === undefined
            ? side
            : distance === 0
              ? `${side} here`
              : `${distance} ${distance === 1 ? "tile" : "tiles"} ${side}`,
        )
        .join(", ")}`,
    );
  }

  const resources = mergeResources(observation).slice(0, options?.maxResources ?? 4);
  for (const resource of resources) {
    const thickness = typeof resource.biomass === "number" ? biomassWord(resource.biomass) : "some";
    const where = distancePhrase(resource.dx ?? 0, resource.dy ?? 0, resource.distance);
    lines.push(where === "here" ? `algae patch here (${thickness})` : `algae ${where} (${thickness})`);
  }

  const automata = mergeAutomata(observation).slice(0, options?.maxAutomata ?? 4);
  for (const automaton of automata) {
    const who = speciesName(automaton.slotId, labelBySlot);
    const where = distancePhrase(automaton.dx ?? 0, automaton.dy ?? 0, automaton.distance);
    const hidden = automaton.hidden ? ", hidden" : "";
    lines.push(where === "here" ? `${who} sharing this cell${hidden}` : `${who} ${where}${hidden}`);
  }

  for (const key of SENSE_KEYS) {
    for (const corpse of observation[key]?.corpses ?? []) {
      const where = distancePhrase(corpse.dx ?? 0, corpse.dy ?? 0, corpse.distance);
      lines.push(`remains ${where}`);
    }
  }

  return lines;
}

interface ActionLite {
  kind?: string;
  to?: { x?: number; y?: number };
  at?: { x?: number; y?: number };
  targetId?: string;
}

/**
 * One readable line for the DID panel. Neutral, dignified (a death is a fact,
 * never celebrated or gory — plan §7.5).
 */
export function describeAction(actionJson: string | undefined, fallbackKind?: string): string {
  let action: ActionLite = {};
  if (actionJson) {
    try {
      action = JSON.parse(actionJson) as ActionLite;
    } catch {
      action = {};
    }
  }
  const kind = action.kind ?? fallbackKind ?? "none";
  switch (kind) {
    case "move":
      return action.to && typeof action.to.x === "number" && typeof action.to.y === "number"
        ? `moved to cell (${action.to.x}, ${action.to.y})`
        : "moved";
    case "graze":
      return "grazed the algae here";
    case "eat":
      return "ate a nearby creature";
    case "hide":
      return "hid";
    case "rest":
      return "rested to save energy";
    case "reproduce":
      return "split into two";
    case "noop":
    case "none":
      return "did nothing this day";
    default:
      return kind;
  }
}
