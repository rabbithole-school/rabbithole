/**
 * Deterministic, framework-neutral presentation regions for ecosystemGrid.
 *
 * This module does not create SimulatorScene cells and does not participate in
 * physics. It gives the existing web/native terrain faces a coherent seeded
 * palette plus one-owner contour edges. Manual shelter/current/shallows cells
 * remain the only terrain with gameplay meaning and take visual precedence.
 */

import type { EcosystemBiomeId, EcosystemLandscapeConfig } from "./contract";

export const ECOSYSTEM_LANDSCAPE_VERSION = 1 as const;
export const MAX_ECOSYSTEM_LANDSCAPE_REGIONS = 12;
export const MIN_ECOSYSTEM_LANDSCAPE_REGIONS = 2;
export const ECOSYSTEM_LANDSCAPE_DISCLOSURE =
  "Scenic surface · rules unchanged";

export function ecosystemLandscapeRegionCountLimit(width: number, height: number): number {
  return Math.min(MAX_ECOSYSTEM_LANDSCAPE_REGIONS, width * height);
}

export function clampEcosystemLandscapeRegionCount(
  regionCount: number,
  width: number,
  height: number,
): number {
  return Math.max(
    MIN_ECOSYSTEM_LANDSCAPE_REGIONS,
    Math.min(ecosystemLandscapeRegionCountLimit(width, height), Math.round(regionCount)),
  );
}

export const ECOSYSTEM_LANDSCAPE_BANDS = [
  "basin",
  "lowland",
  "plain",
  "highland",
  "ridge",
] as const;
export type EcosystemLandscapeBand = (typeof ECOSYSTEM_LANDSCAPE_BANDS)[number];

export const ECOSYSTEM_LANDSCAPE_CONTOUR = {
  north: 1,
  east: 2,
  south: 4,
  west: 8,
} as const;

export const ECOSYSTEM_LANDSCAPE_CONTOUR_EDGES = [
  {
    direction: "north",
    bit: ECOSYSTEM_LANDSCAPE_CONTOUR.north,
    dx: 0,
    dy: -1,
    from: "top",
    to: "right",
  },
  {
    direction: "east",
    bit: ECOSYSTEM_LANDSCAPE_CONTOUR.east,
    dx: 1,
    dy: 0,
    from: "right",
    to: "bottom",
  },
  {
    direction: "south",
    bit: ECOSYSTEM_LANDSCAPE_CONTOUR.south,
    dx: 0,
    dy: 1,
    from: "bottom",
    to: "left",
  },
  {
    direction: "west",
    bit: ECOSYSTEM_LANDSCAPE_CONTOUR.west,
    dx: -1,
    dy: 0,
    from: "left",
    to: "top",
  },
] as const;

export interface EcosystemLandscapeCell {
  readonly x: number;
  readonly y: number;
  readonly band: EcosystemLandscapeBand;
  /**
   * Grid-cardinal edges owned by this cell. An edge is present only when this
   * cell is higher than its neighbor, so every transition renders exactly once.
   */
  readonly contourMask: number;
}

export interface EcosystemLandscape {
  readonly version: typeof ECOSYSTEM_LANDSCAPE_VERSION;
  readonly width: number;
  readonly height: number;
  readonly cells: readonly EcosystemLandscapeCell[];
}

export interface EcosystemLandscapePoint {
  readonly x: number;
  readonly y: number;
}

export interface EcosystemLandscapeTileFace {
  readonly x: number;
  readonly y: number;
  readonly top: EcosystemLandscapePoint;
  readonly right: EcosystemLandscapePoint;
  readonly bottom: EcosystemLandscapePoint;
  readonly left: EcosystemLandscapePoint;
}

export interface EcosystemLandscapeVisualPaths {
  readonly marks: Readonly<Record<EcosystemLandscapeBand, string>>;
  readonly reliefShadow: string;
  readonly raisedFacet: string;
  readonly sunkenFacet: string;
  readonly contourSegmentCount: number;
  readonly decoratedCellCount: number;
}

const BAND_RANK: Readonly<Record<EcosystemLandscapeBand, number>> = {
  basin: 0,
  lowland: 1,
  plain: 2,
  highland: 3,
  ridge: 4,
};

function fail(message: string): never {
  throw new Error(message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function finiteNumber(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    fail(`${field} must be a finite number`);
  }
  return value;
}

export function validateEcosystemLandscapeConfig(
  value: unknown,
  width: number,
  height: number,
): EcosystemLandscapeConfig {
  if (!isRecord(value)) fail("config.landscape must be an object");
  const allowed = [
    "version",
    "seed",
    "regionCount",
    "roughness",
    "lowlandCoverage",
    "highlandCoverage",
  ];
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) fail(`config.landscape carries unknown field "${key}"`);
  }
  if (value.version !== ECOSYSTEM_LANDSCAPE_VERSION) {
    fail(`config.landscape.version must be ${ECOSYSTEM_LANDSCAPE_VERSION}`);
  }
  if (typeof value.seed !== "string" || value.seed.trim().length === 0) {
    fail("config.landscape.seed must be a non-empty string");
  }
  if (!Number.isInteger(value.regionCount)) {
    fail("config.landscape.regionCount must be an integer");
  }
  const maxRegions = ecosystemLandscapeRegionCountLimit(width, height);
  if (
    (value.regionCount as number) < MIN_ECOSYSTEM_LANDSCAPE_REGIONS ||
    (value.regionCount as number) > maxRegions
  ) {
    fail(
      `config.landscape.regionCount must be from ${MIN_ECOSYSTEM_LANDSCAPE_REGIONS} through ${maxRegions}`,
    );
  }
  const roughness = finiteNumber(value.roughness, "config.landscape.roughness");
  const lowlandCoverage = finiteNumber(
    value.lowlandCoverage,
    "config.landscape.lowlandCoverage",
  );
  const highlandCoverage = finiteNumber(
    value.highlandCoverage,
    "config.landscape.highlandCoverage",
  );
  if (roughness < 0 || roughness > 1) {
    fail("config.landscape.roughness must be between 0 and 1");
  }
  if (lowlandCoverage < 0 || lowlandCoverage > 1) {
    fail("config.landscape.lowlandCoverage must be between 0 and 1");
  }
  if (highlandCoverage < 0 || highlandCoverage > 1) {
    fail("config.landscape.highlandCoverage must be between 0 and 1");
  }
  if (lowlandCoverage + highlandCoverage > 0.8) {
    fail(
      "config.landscape.lowlandCoverage + config.landscape.highlandCoverage must not exceed 0.8",
    );
  }
  return {
    version: ECOSYSTEM_LANDSCAPE_VERSION,
    seed: value.seed,
    regionCount: value.regionCount as number,
    roughness,
    lowlandCoverage,
    highlandCoverage,
  };
}

function hashString(value: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  hash ^= hash >>> 16;
  hash = Math.imul(hash, 0x7feb352d);
  hash ^= hash >>> 15;
  hash = Math.imul(hash, 0x846ca68b);
  return (hash ^ (hash >>> 16)) >>> 0;
}

function unitHash(seed: string, x: number, y: number, channel: string): number {
  return hashString(`${seed}:${channel}:${x}:${y}`) / 0x100000000;
}

function smoothstep(value: number): number {
  return value * value * (3 - 2 * value);
}

function valueNoise(seed: string, x: number, y: number, scale: number, channel: string): number {
  const sampleX = x / scale;
  const sampleY = y / scale;
  const x0 = Math.floor(sampleX);
  const y0 = Math.floor(sampleY);
  const tx = smoothstep(sampleX - x0);
  const ty = smoothstep(sampleY - y0);
  const top =
    unitHash(seed, x0, y0, channel) * (1 - tx) +
    unitHash(seed, x0 + 1, y0, channel) * tx;
  const bottom =
    unitHash(seed, x0, y0 + 1, channel) * (1 - tx) +
    unitHash(seed, x0 + 1, y0 + 1, channel) * tx;
  return top * (1 - ty) + bottom * ty;
}

function regionCenters(
  seed: string,
  width: number,
  height: number,
  count: number,
): Array<{ x: number; y: number; relief: number }> {
  return Array.from({ length: width * height }, (_, index) => {
    const x = index % width;
    const y = Math.floor(index / width);
    return { x, y, rank: unitHash(seed, x, y, "region-center") };
  })
    .sort((left, right) => left.rank - right.rank || left.y - right.y || left.x - right.x)
    .slice(0, count)
    .map((center, index) => ({
      x: center.x,
      y: center.y,
      relief: unitHash(seed, center.x, center.y, `region-relief-${index}`),
    }));
}

function blendedRegionRelief(
  x: number,
  y: number,
  centers: readonly { x: number; y: number; relief: number }[],
  width: number,
  height: number,
): number {
  const influenceRadius =
    Math.max(width, height) / Math.max(1, Math.sqrt(centers.length));
  let weightedRelief = 0;
  let totalWeight = 0;
  for (const center of centers) {
    const dx = center.x - x;
    const dy = center.y - y;
    const normalizedDistanceSquared =
      (dx * dx + dy * dy) / (influenceRadius * influenceRadius);
    const weight = 1 / (1 + normalizedDistanceSquared) ** 2;
    weightedRelief += center.relief * weight;
    totalWeight += weight;
  }
  return weightedRelief / totalWeight;
}

interface ReliefCell {
  readonly index: number;
  readonly x: number;
  readonly y: number;
  readonly relief: number;
}

class ReliefHeap {
  private readonly values: ReliefCell[] = [];

  constructor(private readonly higherFirst: boolean) {}

  get size(): number {
    return this.values.length;
  }

  private precedes(left: ReliefCell, right: ReliefCell): boolean {
    if (left.relief !== right.relief) {
      return this.higherFirst
        ? left.relief > right.relief
        : left.relief < right.relief;
    }
    return left.index < right.index;
  }

  push(value: ReliefCell): void {
    this.values.push(value);
    let index = this.values.length - 1;
    while (index > 0) {
      const parent = Math.floor((index - 1) / 2);
      if (this.precedes(this.values[parent], value)) break;
      this.values[index] = this.values[parent];
      index = parent;
    }
    this.values[index] = value;
  }

  pop(): ReliefCell | undefined {
    const first = this.values[0];
    const last = this.values.pop();
    if (!first || !last || this.values.length === 0) return first;
    let index = 0;
    while (true) {
      const left = index * 2 + 1;
      const right = left + 1;
      if (left >= this.values.length) break;
      const child =
        right < this.values.length &&
        this.precedes(this.values[right], this.values[left])
          ? right
          : left;
      if (this.precedes(last, this.values[child])) break;
      this.values[index] = this.values[child];
      index = child;
    }
    this.values[index] = last;
    return first;
  }
}

function neighborIndexes(index: number, width: number, height: number): number[] {
  const x = index % width;
  const y = Math.floor(index / width);
  const neighbors: number[] = [];
  if (y > 0) neighbors.push(index - width);
  if (x + 1 < width) neighbors.push(index + 1);
  if (y + 1 < height) neighbors.push(index + width);
  if (x > 0) neighbors.push(index - 1);
  return neighbors;
}

function growConnectedBand(input: {
  scores: readonly ReliefCell[];
  width: number;
  height: number;
  targetCount: number;
  higherFirst: boolean;
  blocked: ReadonlySet<number>;
}): Set<number> {
  const selected = new Set<number>();
  if (input.targetCount === 0) return selected;
  const available = new Set(
    input.scores
      .map((cell) => cell.index)
      .filter((index) => !input.blocked.has(index)),
  );
  const components: number[][] = [];
  while (available.size > 0) {
    const first = available.values().next().value as number;
    const component: number[] = [];
    const pending = [first];
    available.delete(first);
    while (pending.length > 0) {
      const index = pending.pop()!;
      component.push(index);
      for (const neighbor of neighborIndexes(index, input.width, input.height)) {
        if (available.delete(neighbor)) pending.push(neighbor);
      }
    }
    components.push(component);
  }
  const byIndex = new Map(input.scores.map((cell) => [cell.index, cell]));
  const candidateComponents = components.filter(
    (component) => component.length >= input.targetCount,
  );
  const componentScore = (component: readonly number[]) =>
    component.reduce((best, index) => {
      const relief = byIndex.get(index)?.relief ?? 0;
      return input.higherFirst ? Math.max(best, relief) : Math.min(best, relief);
    }, input.higherFirst ? Number.NEGATIVE_INFINITY : Number.POSITIVE_INFINITY);
  candidateComponents.sort((left, right) => {
    const delta = componentScore(left) - componentScore(right);
    return input.higherFirst ? -delta : delta;
  });
  components.sort(
    (left, right) =>
      right.length - left.length ||
      (input.higherFirst ? -1 : 1) *
        (componentScore(left) - componentScore(right)),
  );
  const allowed = new Set(candidateComponents[0] ?? components[0] ?? []);
  if (allowed.size === 0) {
    return selected;
  }
  const targetCount = Math.min(input.targetCount, allowed.size);
  const ordered = [...input.scores].sort((left, right) => {
    if (left.relief !== right.relief) {
      return input.higherFirst
        ? right.relief - left.relief
        : left.relief - right.relief;
    }
    return left.index - right.index;
  }).filter((cell) => allowed.has(cell.index));
  const frontier = new ReliefHeap(input.higherFirst);
  const queued = new Set<number>();
  const add = (cell: ReliefCell) => {
    selected.add(cell.index);
    for (const neighborIndex of neighborIndexes(
      cell.index,
      input.width,
      input.height,
    )) {
      if (
        selected.has(neighborIndex) ||
        input.blocked.has(neighborIndex) ||
        !allowed.has(neighborIndex) ||
        queued.has(neighborIndex)
      ) {
        continue;
      }
      const neighbor = byIndex.get(neighborIndex);
      if (neighbor) {
        frontier.push(neighbor);
        queued.add(neighborIndex);
      }
    }
  };
  const first = ordered.find((cell) => !input.blocked.has(cell.index));
  if (!first) return selected;
  add(first);
  while (selected.size < targetCount) {
    let candidate = frontier.pop();
    while (
      candidate &&
      (selected.has(candidate.index) || input.blocked.has(candidate.index))
    ) {
      candidate = frontier.pop();
    }
    if (!candidate) {
      break;
    }
    add(candidate);
  }
  return selected;
}

function withTransitionBuffer(
  selected: ReadonlySet<number>,
  width: number,
  height: number,
): Set<number> {
  const blocked = new Set(selected);
  for (const index of selected) {
    for (const neighbor of neighborIndexes(index, width, height)) {
      blocked.add(neighbor);
    }
  }
  return blocked;
}

function isInteriorCell(
  index: number,
  selected: ReadonlySet<number>,
  width: number,
  height: number,
): boolean {
  const neighbors = neighborIndexes(index, width, height);
  return neighbors.length === 4 && neighbors.every((neighbor) => selected.has(neighbor));
}

function assignBands(
  scores: readonly ReliefCell[],
  config: EcosystemLandscapeConfig,
  width: number,
  height: number,
): Map<string, EcosystemLandscapeBand> {
  const lowCount = Math.floor(scores.length * config.lowlandCoverage);
  const highCount = Math.floor(scores.length * config.highlandCoverage);
  const low = growConnectedBand({
    scores,
    width,
    height,
    targetCount: lowCount,
    higherFirst: false,
    blocked: new Set(),
  });
  const high = growConnectedBand({
    scores,
    width,
    height,
    targetCount: highCount,
    higherFirst: true,
    blocked: withTransitionBuffer(low, width, height),
  });
  const bands = new Map<string, EcosystemLandscapeBand>();
  for (const cell of scores) {
    let band: EcosystemLandscapeBand = "plain";
    if (low.has(cell.index)) {
      band = isInteriorCell(cell.index, low, width, height) ? "basin" : "lowland";
    } else if (high.has(cell.index)) {
      band = isInteriorCell(cell.index, high, width, height) ? "ridge" : "highland";
    }
    bands.set(`${cell.x}:${cell.y}`, band);
  }
  return bands;
}

function generateEcosystemLandscapeV1(input: {
  width: number;
  height: number;
  config: EcosystemLandscapeConfig;
}): EcosystemLandscape {
  const { config } = input;
  const centers = regionCenters(config.seed, input.width, input.height, config.regionCount);
  const broadScale = Math.max(2, Math.min(input.width, input.height) / 2);
  const detailScale = Math.max(1, broadScale / 2);
  const scores: ReliefCell[] = Array.from(
    { length: input.width * input.height },
    (_, index) => {
    const x = index % input.width;
    const y = Math.floor(index / input.width);
    const regional = blendedRegionRelief(
      x,
      y,
      centers,
      input.width,
      input.height,
    );
    const broad = valueNoise(config.seed, x, y, broadScale, "broad");
    const detail = valueNoise(config.seed, x, y, detailScale, "detail");
    const local = broad * 0.7 + detail * 0.3;
    return {
      index,
      x,
      y,
      relief:
        regional * (1 - config.roughness) +
        local * config.roughness +
        unitHash(config.seed, x, y, "tie-break") * 1e-9,
    };
  },
  );
  const bands = assignBands(scores, config, input.width, input.height);
  const cells = scores.map(({ x, y }) => {
    const band = bands.get(`${x}:${y}`) ?? "plain";
    const rank = BAND_RANK[band];
    let contourMask = 0;
    for (const edge of ECOSYSTEM_LANDSCAPE_CONTOUR_EDGES) {
      const neighbor = { x: x + edge.dx, y: y + edge.dy };
      if (
        neighbor.x < 0 ||
        neighbor.x >= input.width ||
        neighbor.y < 0 ||
        neighbor.y >= input.height
      ) {
        continue;
      }
      const neighborBand = bands.get(`${neighbor.x}:${neighbor.y}`) ?? "plain";
      if (rank > BAND_RANK[neighborBand]) contourMask |= edge.bit;
    }
    return { x, y, band, contourMask };
  });
  return {
    version: ECOSYSTEM_LANDSCAPE_VERSION,
    width: input.width,
    height: input.height,
    cells,
  };
}

/**
 * Version dispatch is intentionally explicit: historical snapshots keep their
 * version number, and a future algorithm must add a new branch rather than
 * silently changing v1 output.
 */
export function generateEcosystemLandscape(input: {
  width: number;
  height: number;
  config: EcosystemLandscapeConfig;
}): EcosystemLandscape {
  if (!Number.isInteger(input.width) || input.width < 1) {
    fail("landscape width must be a positive integer");
  }
  if (!Number.isInteger(input.height) || input.height < 1) {
    fail("landscape height must be a positive integer");
  }
  const config = validateEcosystemLandscapeConfig(input.config, input.width, input.height);
  const version: number = config.version;
  switch (version) {
    case 1:
      return generateEcosystemLandscapeV1({ ...input, config });
  }
  return fail(`Unsupported ecosystem landscape version ${version}`);
}

/** Compact review/debug fingerprint for golden fixtures and the dev gallery. */
export function ecosystemLandscapeFingerprint(landscape: EcosystemLandscape): string {
  const cells = landscape.cells
    .map((cell) => `${cell.x},${cell.y},${cell.band},${cell.contourMask}`)
    .join("|");
  return hashString(
    `${landscape.version}:${landscape.width}:${landscape.height}:${cells}`,
  )
    .toString(16)
    .padStart(8, "0");
}

/** Shared compact SVG path serialization keeps web/native contour payloads aligned. */
export function ecosystemLandscapePathNumber(value: number): string {
  return Number(value.toFixed(2)).toString();
}

function landscapePoint(
  face: EcosystemLandscapeTileFace,
  u: number,
  v: number,
): EcosystemLandscapePoint {
  return {
    x:
      face.top.x +
      (face.right.x - face.top.x) * u +
      (face.left.x - face.top.x) * v,
    y:
      face.top.y +
      (face.right.y - face.top.y) * u +
      (face.left.y - face.top.y) * v,
  };
}

function pathPoint(point: EcosystemLandscapePoint): string {
  return `${ecosystemLandscapePathNumber(point.x)} ${ecosystemLandscapePathNumber(point.y)}`;
}

function polylinePath(
  face: EcosystemLandscapeTileFace,
  points: readonly (readonly [number, number])[],
): string {
  return points
    .map((point, index) => {
      const projected = landscapePoint(face, point[0], point[1]);
      return `${index === 0 ? "M" : "L"} ${pathPoint(projected)}`;
    })
    .join(" ");
}

function quadraticPath(
  face: EcosystemLandscapeTileFace,
  start: readonly [number, number],
  control: readonly [number, number],
  end: readonly [number, number],
): string {
  return `M ${pathPoint(landscapePoint(face, start[0], start[1]))} Q ${pathPoint(
    landscapePoint(face, control[0], control[1]),
  )} ${pathPoint(landscapePoint(face, end[0], end[1]))}`;
}

function closedPolygonPath(
  face: EcosystemLandscapeTileFace,
  points: readonly (readonly [number, number])[],
): string {
  return `${polylinePath(face, points)} Z`;
}

function ellipsePath(
  face: EcosystemLandscapeTileFace,
  center: readonly [number, number],
  radiusU: number,
  radiusV: number,
): string {
  const left = landscapePoint(face, center[0] - radiusU, center[1]);
  const top = landscapePoint(face, center[0], center[1] - radiusV);
  const right = landscapePoint(face, center[0] + radiusU, center[1]);
  const bottom = landscapePoint(face, center[0], center[1] + radiusV);
  return `M ${pathPoint(left)} Q ${pathPoint(top)} ${pathPoint(right)} Q ${pathPoint(
    bottom,
  )} ${pathPoint(left)}`;
}

function markVariant(seed: string, band: EcosystemLandscapeBand, x: number, y: number): number {
  return hashString(`${seed}:terrain-mark:${band}:${x}:${y}`) % 4;
}

function shouldDecorate(band: EcosystemLandscapeBand, variant: number): boolean {
  if (band === "basin" || band === "ridge") return true;
  if (band === "plain") return variant === 0;
  return variant !== 3;
}

function meadowMark(
  face: EcosystemLandscapeTileFace,
  band: EcosystemLandscapeBand,
  variant: number,
): string {
  const shift = (variant - 1.5) * 0.018;
  switch (band) {
    case "basin":
      return [
        closedPolygonPath(face, [
          [0.18 + shift, 0.5],
          [0.5 + shift, 0.23],
          [0.82 + shift, 0.5],
          [0.5 + shift, 0.77],
        ]),
        quadraticPath(face, [0.34, 0.56], [0.5, 0.45], [0.66, 0.56]),
      ].join(" ");
    case "lowland":
      return [
        quadraticPath(face, [0.34 + shift, 0.68], [0.33, 0.46], [0.26, 0.36]),
        quadraticPath(face, [0.5 + shift, 0.69], [0.51, 0.42], [0.5, 0.28]),
        quadraticPath(face, [0.66 + shift, 0.68], [0.67, 0.46], [0.75, 0.37]),
      ].join(" ");
    case "plain":
      return [
        quadraticPath(face, [0.4 + shift, 0.65], [0.43, 0.5], [0.36, 0.43]),
        polylinePath(face, [
          [0.5 + shift, 0.66],
          [0.5 + shift, 0.38],
        ]),
        quadraticPath(face, [0.6 + shift, 0.65], [0.57, 0.5], [0.65, 0.44]),
      ].join(" ");
    case "highland":
      return [
        quadraticPath(face, [0.22, 0.64 + shift], [0.5, 0.48], [0.78, 0.64 + shift]),
        quadraticPath(face, [0.3, 0.46 + shift], [0.5, 0.34], [0.7, 0.46 + shift]),
      ].join(" ");
    case "ridge":
      return [
        polylinePath(face, [
          [0.16, 0.7],
          [0.35 + shift, 0.36],
          [0.5, 0.57],
          [0.68 + shift, 0.27],
          [0.84, 0.7],
        ]),
        polylinePath(face, [
          [0.27, 0.69],
          [0.73, 0.69],
        ]),
      ].join(" ");
  }
}

function reefMark(
  face: EcosystemLandscapeTileFace,
  band: EcosystemLandscapeBand,
  variant: number,
): string {
  const shift = (variant - 1.5) * 0.02;
  switch (band) {
    case "basin":
      return [
        ellipsePath(face, [0.5 + shift, 0.5], 0.29, 0.22),
        ellipsePath(face, [0.5 + shift, 0.5], 0.16, 0.11),
      ].join(" ");
    case "lowland":
      return [
        ellipsePath(face, [0.37 + shift, 0.56], 0.075, 0.075),
        ellipsePath(face, [0.56 + shift, 0.4], 0.055, 0.055),
        ellipsePath(face, [0.67 + shift, 0.62], 0.045, 0.045),
      ].join(" ");
    case "plain":
      return [
        quadraticPath(face, [0.2, 0.51 + shift], [0.35, 0.37], [0.5, 0.51 + shift]),
        quadraticPath(face, [0.5, 0.51 + shift], [0.65, 0.65], [0.8, 0.51 + shift]),
      ].join(" ");
    case "highland":
      return [
        polylinePath(face, [
          [0.5 + shift, 0.71],
          [0.5 + shift, 0.34],
        ]),
        polylinePath(face, [
          [0.5 + shift, 0.52],
          [0.32 + shift, 0.37],
        ]),
        polylinePath(face, [
          [0.5 + shift, 0.47],
          [0.69 + shift, 0.29],
        ]),
      ].join(" ");
    case "ridge":
      return [
        polylinePath(face, [
          [0.16, 0.7],
          [0.3 + shift, 0.4],
          [0.43, 0.62],
          [0.55 + shift, 0.31],
          [0.68, 0.57],
          [0.82 + shift, 0.36],
          [0.88, 0.7],
        ]),
        quadraticPath(face, [0.25, 0.68], [0.5, 0.57], [0.78, 0.68]),
      ].join(" ");
  }
}

/**
 * Build the fixed set of vector paths used by both renderers. Marks are sparse
 * deterministic tile texture; relief is carried by a highlighted high edge and
 * a shadow displaced toward the lower neighboring band.
 */
export function ecosystemLandscapeVisualPaths(input: {
  landscape: EcosystemLandscape;
  seed: string;
  biomeId: EcosystemBiomeId;
  faces: readonly EcosystemLandscapeTileFace[];
  physicsTerrainPositions: ReadonlySet<string>;
}): EcosystemLandscapeVisualPaths {
  const cells = new Map(input.landscape.cells.map((cell) => [`${cell.x}:${cell.y}`, cell]));
  const faces = new Map(input.faces.map((face) => [`${face.x}:${face.y}`, face]));
  const marks: Record<EcosystemLandscapeBand, string[]> = {
    basin: [],
    lowland: [],
    plain: [],
    highland: [],
    ridge: [],
  };
  const reliefShadow: string[] = [];
  const raisedFacet: string[] = [];
  const sunkenFacet: string[] = [];
  let contourSegmentCount = 0;
  let decoratedCellCount = 0;

  for (const face of input.faces) {
    const key = `${face.x}:${face.y}`;
    const cell = cells.get(key);
    if (!cell || input.physicsTerrainPositions.has(key)) continue;
    const variant = markVariant(input.seed, cell.band, face.x, face.y);
    if (shouldDecorate(cell.band, variant)) {
      marks[cell.band].push(
        input.biomeId === "reef"
          ? reefMark(face, cell.band, variant)
          : meadowMark(face, cell.band, variant),
      );
      decoratedCellCount += 1;
    }
    if (cell.band === "highland" || cell.band === "ridge") {
      const inset = cell.band === "ridge" ? 0.18 : 0.1;
      raisedFacet.push(
        closedPolygonPath(face, [
          [1, 0],
          [1, 1],
          [0, 1],
          [0, 1 - inset],
          [1 - inset, 1 - inset],
          [1 - inset, 0],
        ]),
      );
    } else if (cell.band === "lowland" || cell.band === "basin") {
      const inset = cell.band === "basin" ? 0.16 : 0.08;
      sunkenFacet.push(
        closedPolygonPath(face, [
          [0, 1],
          [0, 0],
          [1, 0],
          [1, inset],
          [inset, inset],
          [inset, 1],
        ]),
      );
    }

    const center = landscapePoint(face, 0.5, 0.5);
    for (const edge of ECOSYSTEM_LANDSCAPE_CONTOUR_EDGES) {
      if ((cell.contourMask & edge.bit) === 0) continue;
      const neighborKey = `${face.x + edge.dx}:${face.y + edge.dy}`;
      if (input.physicsTerrainPositions.has(neighborKey)) continue;
      const neighborFace = faces.get(neighborKey);
      if (!neighborFace) continue;
      const from = face[edge.from];
      const to = face[edge.to];
      const neighborCenter = landscapePoint(neighborFace, 0.5, 0.5);
      const shadowOffset = {
        x: (neighborCenter.x - center.x) * 0.055,
        y: (neighborCenter.y - center.y) * 0.055,
      };
      reliefShadow.push(
        `M ${pathPoint({
          x: from.x + shadowOffset.x,
          y: from.y + shadowOffset.y,
        })} L ${pathPoint({
          x: to.x + shadowOffset.x,
          y: to.y + shadowOffset.y,
        })}`,
      );
      contourSegmentCount += 1;
    }
  }

  return {
    marks: {
      basin: marks.basin.join(" "),
      lowland: marks.lowland.join(" "),
      plain: marks.plain.join(" "),
      highland: marks.highland.join(" "),
      ridge: marks.ridge.join(" "),
    },
    reliefShadow: reliefShadow.join(" "),
    raisedFacet: raisedFacet.join(" "),
    sunkenFacet: sunkenFacet.join(" "),
    contourSegmentCount,
    decoratedCellCount,
  };
}
