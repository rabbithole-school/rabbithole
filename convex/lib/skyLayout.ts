// Where the stars on one kid's own Sky sit (TRA-699). Pure and deterministic:
// no server imports, no randomness, the same input always gives the same
// output. It runs in the per-kid refresh (skyStars.ts), for one kid at a time.
//
// Two entry points:
//   - `firstLayout` places all of a kid's stars at once, from how related
//     they are (cosine similarity of their embeddings), so related ones sit
//     together. A t-SNE pass gives each star a target; stars are then placed
//     one at a time, outward along links of meaning, each in the free spot
//     nearest its target that puts it beside a sibling; finally whole groups
//     slide together so the sky isn't mostly empty.
//   - `placeNewStars` slots each new star beside its closest sibling in
//     meaning, in free space. Every star already placed keeps its exact
//     position: a sky laid out again moves the old stars (the offline test
//     measured about 13% of the sky's width), and a kid's stars should stay
//     where they left them.
//
// Units and the label box (the contract the renderers share):
//   - x and y are in em, the label's font size; y grows downward. The first
//     layout centers the sky on (0, 0); later stars may land anywhere, so a
//     renderer fits the bounds of the stars it gets.
//   - The star's dot is at (x, y) and its label sits centered under it,
//     wrapped at SKY_LABEL.lineChars characters to at most SKY_LABEL.maxLines
//     lines (`skyLabelBox`). No two boxes overlap, with SKY_LABEL.gapEm clear.
//   - `nearbySkyStars` is the one "near this" rule: up to three other stars
//     within SKY_NEARBY_RADIUS_EM, nearest first.

// The label box (SKY_LABEL, skyLabelBox and the rest) lives in shared/ so the
// BunnyPad can vendor it; re-exported here for the server and web.
import {
  SKY_LABEL,
  skyBoxesOverlap,
  skyLabelBox,
  skyLabelSize,
  type SkyBox,
  type SkyPoint,
} from "../../shared/skyLabelBox";

export { SKY_LABEL, skyBoxesOverlap, skyLabelBox, skyLabelSize };
export type { SkyBox, SkyPoint };

/** The median distance from a star to its nearest one in the t-SNE targets. */
const TARGET_SPACING_EM = 7;
/** Up to this many stars count as near one star, within this radius. */
export const SKY_NEARBY_COUNT = 3;
export const SKY_NEARBY_RADIUS_EM = 24;

export type SkyLayoutInput = { vector: readonly number[]; label: string };
export type PlacedSkyStar = SkyPoint & { vector: readonly number[] | null; label: string };

// ─── Small numeric helpers ───────────────────────────────────────────

function unit(v: readonly number[]): number[] {
  let norm = 0;
  for (const x of v) norm += x * x;
  norm = Math.sqrt(norm);
  return norm > 0 ? v.map((x) => x / norm) : v.map(() => 0);
}

function dot(a: readonly number[], b: readonly number[]): number {
  let sum = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) sum += a[i] * b[i];
  return sum;
}

/** Cosine similarity of every pair. */
export function cosineMatrix(vectors: readonly (readonly number[])[]): number[][] {
  const units = vectors.map(unit);
  return units.map((a, i) => units.map((b, j) => (i === j ? 1 : dot(a, b))));
}

/** To 0.01 em, and never -0 (which Convex's JSON spells as a special float). */
function round2(x: number): number {
  return Math.round(x * 100) / 100 || 0;
}

function distance(a: SkyPoint, b: SkyPoint): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function centroid(points: readonly SkyPoint[]): SkyPoint {
  const n = points.length || 1;
  return {
    x: points.reduce((a, p) => a + p.x, 0) / n,
    y: points.reduce((a, p) => a + p.y, 0) / n,
  };
}

// ─── Targets: t-SNE ──────────────────────────────────────────────────

/** Top two eigenvectors of a symmetric matrix by power iteration, scaled by
 *  the square root of their eigenvalues: classical MDS coordinates. */
function mds2d(b: number[][]): number[][] {
  const n = b.length;
  const coords = Array.from({ length: n }, () => [0, 0]);
  let m = b.map((row) => [...row]);
  for (let axis = 0; axis < 2; axis++) {
    let v = Array.from({ length: n }, (_, i) =>
      axis === 0 ? Math.sin(i + 1) : Math.cos(2 * i + 1),
    );
    let lambda = 0;
    for (let iter = 0; iter < 200; iter++) {
      const next = m.map((row) => dot(row, v));
      const norm = Math.hypot(...next);
      if (norm < 1e-12) break;
      v = next.map((x) => x / norm);
      lambda = norm;
    }
    // A fixed sign, so the output does not depend on the start vector's.
    const lead = v.find((x) => Math.abs(x) > 1e-9) ?? 1;
    if (lead < 0) v = v.map((x) => -x);
    const scale = Math.sqrt(Math.max(lambda, 0));
    for (let i = 0; i < n; i++) coords[i][axis] = v[i] * scale;
    m = m.map((row, i) => row.map((x, j) => x - lambda * v[i] * v[j]));
  }
  return coords;
}

/** Joint t-SNE probabilities from squared distances, for one perplexity. */
function jointProbabilities(dist2: number[][], perplexity: number): number[][] {
  const n = dist2.length;
  const target = Math.log(perplexity);
  const p = Array.from({ length: n }, () => new Array<number>(n).fill(0));
  for (let i = 0; i < n; i++) {
    let lo = 0;
    let hi = Infinity;
    let beta = 1;
    let row = new Array<number>(n).fill(0);
    for (let iter = 0; iter < 64; iter++) {
      let sum = 0;
      for (let j = 0; j < n; j++) {
        row[j] = j === i ? 0 : Math.exp(-dist2[i][j] * beta);
        sum += row[j];
      }
      if (sum <= 0) sum = 1e-12;
      let entropy = 0;
      for (let j = 0; j < n; j++) {
        if (j === i) continue;
        const pj = row[j] / sum;
        if (pj > 1e-12) entropy -= pj * Math.log(pj);
      }
      row = row.map((x) => x / sum);
      const diff = entropy - target;
      if (Math.abs(diff) < 1e-5) break;
      if (diff > 0) {
        lo = beta;
        beta = hi === Infinity ? beta * 2 : (beta + hi) / 2;
      } else {
        hi = beta;
        beta = (beta + lo) / 2;
      }
    }
    p[i] = row;
  }
  const joint = p.map((row, i) =>
    row.map((x, j) => Math.max((x + p[j][i]) / (2 * n), 1e-12)),
  );
  for (let i = 0; i < n; i++) joint[i][i] = 0;
  return joint;
}

/** Exact t-SNE in two dimensions: fine for one kid's stars (hundreds at
 *  most), deterministic from the MDS start. */
function tsne2d(similarity: number[][]): SkyPoint[] {
  const n = similarity.length;
  const dist2 = similarity.map((row) => row.map((s) => Math.max(0, 2 - 2 * s)));
  const perplexity = Math.max(2, Math.min(5, (n - 1) / 3));
  const p = jointProbabilities(dist2, perplexity);

  // Start from classical MDS (double-centered similarity), shrunk small.
  const rowMean = similarity.map((row) => row.reduce((a, b) => a + b, 0) / n);
  const mean = rowMean.reduce((a, b) => a + b, 0) / n;
  const centered = similarity.map((row, i) =>
    row.map((s, j) => s - rowMean[i] - rowMean[j] + mean),
  );
  const start = mds2d(centered);
  const spread = Math.sqrt(start.reduce((a, [x, y]) => a + x * x + y * y, 0) / n) || 1;
  const y = start.map(([a, b]) => [(a / spread) * 1e-2, (b / spread) * 1e-2]);

  const gains = Array.from({ length: n }, () => [1, 1]);
  const velocity = Array.from({ length: n }, () => [0, 0]);
  const learningRate = Math.max(n / 4, 10);
  const num = Array.from({ length: n }, () => new Array<number>(n).fill(0));
  for (let iter = 0; iter < 1000; iter++) {
    const exaggeration = iter < 120 ? 4 : 1;
    const momentum = iter < 250 ? 0.5 : 0.8;
    let sumQ = 0;
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        const dx = y[i][0] - y[j][0];
        const dy = y[i][1] - y[j][1];
        const q = 1 / (1 + dx * dx + dy * dy);
        num[i][j] = q;
        num[j][i] = q;
        sumQ += 2 * q;
      }
    }
    if (sumQ <= 0) sumQ = 1e-12;
    for (let i = 0; i < n; i++) {
      let gx = 0;
      let gy = 0;
      for (let j = 0; j < n; j++) {
        if (j === i) continue;
        const coef = (exaggeration * p[i][j] - num[i][j] / sumQ) * num[i][j];
        gx += coef * (y[i][0] - y[j][0]);
        gy += coef * (y[i][1] - y[j][1]);
      }
      const grad = [4 * gx, 4 * gy];
      for (let d = 0; d < 2; d++) {
        gains[i][d] =
          Math.sign(grad[d]) !== Math.sign(velocity[i][d])
            ? gains[i][d] + 0.2
            : Math.max(gains[i][d] * 0.8, 0.01);
        velocity[i][d] = momentum * velocity[i][d] - learningRate * gains[i][d] * grad[d];
      }
    }
    let cx = 0;
    let cy = 0;
    for (let i = 0; i < n; i++) {
      y[i][0] += velocity[i][0];
      y[i][1] += velocity[i][1];
      cx += y[i][0];
      cy += y[i][1];
    }
    for (let i = 0; i < n; i++) {
      y[i][0] -= cx / n;
      y[i][1] -= cy / n;
    }
  }
  return y.map(([a, b]) => ({ x: a, y: b }));
}

/** Scale so the median distance to the nearest star is TARGET_SPACING_EM,
 *  centered on the origin. */
function scaleToSpacing(points: SkyPoint[]): SkyPoint[] {
  const n = points.length;
  const nearest = points.map((p, i) => {
    let best = Infinity;
    for (let j = 0; j < n; j++) if (j !== i) best = Math.min(best, distance(p, points[j]));
    return best;
  });
  const sorted = [...nearest].filter(Number.isFinite).sort((a, b) => a - b);
  const median = sorted.length ? sorted[Math.floor(sorted.length / 2)] : 0;
  const scale = median > 1e-9 ? TARGET_SPACING_EM / median : 1;
  const middle = centroid(points);
  return points.map((p) => ({ x: (p.x - middle.x) * scale, y: (p.y - middle.y) * scale }));
}

// ─── Placing one star in free space ──────────────────────────────────

/** Clear space kept between boxes while placing: a little over the gap the
 *  overlap check uses, so rounding to 0.01 em can never close it. */
const PLACE_GAP_EM = SKY_LABEL.gapEm + 0.05;
const RING_STEP_EM = 0.75;
const RING_ARC_EM = 1.5;
/** Rings searched past the first one with a free spot. */
const EXTRA_RINGS = 4;
const MAX_RINGS = 4000;

type SkyStarOnCanvas = { point: SkyPoint; label: string; box: SkyBox };

/** The sky being built: placed stars, their boxes, and each one's nearest
 *  star on screen so far. */
class SkyCanvas {
  readonly stars: SkyStarOnCanvas[] = [];
  readonly nearest: number[] = [];
  readonly nearestDist: number[] = [];

  add(point: SkyPoint, label: string): number {
    const index = this.stars.length;
    this.stars.push({ point, label, box: skyLabelBox(point, label) });
    this.nearest.push(-1);
    this.nearestDist.push(Infinity);
    for (let j = 0; j < index; j++) {
      const d = distance(point, this.stars[j].point);
      if (d < this.nearestDist[j]) {
        this.nearestDist[j] = d;
        this.nearest[j] = index;
      }
      if (d < this.nearestDist[index]) {
        this.nearestDist[index] = d;
        this.nearest[index] = j;
      }
    }
    return index;
  }

  isFree(point: SkyPoint, label: string): boolean {
    const box = skyLabelBox(point, label);
    for (const s of this.stars) {
      if (skyBoxesOverlap(box, s.box, PLACE_GAP_EM)) return false;
    }
    return true;
  }

  nearestTo(point: SkyPoint): number {
    let best = -1;
    let bestDist = Infinity;
    this.stars.forEach((s, j) => {
      const d = distance(point, s.point);
      if (d < bestDist) {
        bestDist = d;
        best = j;
      }
    });
    return best;
  }
}

/** Free spots around `anchor`, ring by ring: straight down first (labels
 *  stack well), then around the circle. Stops `extraRings` rings after the
 *  first ring that has one. */
function freeSpotsAround(
  canvas: SkyCanvas,
  anchor: SkyPoint,
  label: string,
  extraRings = EXTRA_RINGS,
): SkyPoint[] {
  const spots: SkyPoint[] = [];
  let lastRing = MAX_RINGS;
  for (let ring = 0; ring <= Math.min(lastRing, MAX_RINGS); ring++) {
    const radius = ring === 0 ? 0 : 1 + ring * RING_STEP_EM;
    const steps =
      ring === 0 ? 1 : Math.max(12, Math.ceil((2 * Math.PI * radius) / RING_ARC_EM));
    for (let k = 0; k < steps; k++) {
      const angle = Math.PI / 2 + (2 * Math.PI * k) / steps;
      const p = {
        x: round2(anchor.x + radius * Math.cos(angle)),
        y: round2(anchor.y + radius * Math.sin(angle)),
      };
      if (canvas.isFree(p, label)) spots.push(p);
    }
    if (spots.length && lastRing === MAX_RINGS) lastRing = ring + extraRings;
  }
  return spots;
}

/** How far past the first free ring the search around a preferred star goes
 *  when no free spot nearer has that star as its nearest. */
const BESIDE_EXTRA_RINGS = 40;

type SpotRank = [beside: number, harm: number, away: number];

function better(a: SpotRank, b: SpotRank | null): boolean {
  if (!b) return true;
  if (a[0] !== b[0]) return a[0] < b[0];
  if (a[1] !== b[1]) return a[1] < b[1];
  return a[2] < b[2];
}

/**
 * The spot for one star. Candidates are free spots near `target` and near
 * each preferred star. The best spot is one whose nearest star is preferred
 * (beside a sibling in meaning; an earlier tier of `preferred` is better);
 * then one that takes the fewest placed stars' nearest star away from a
 * sibling of theirs (`stealsFrom`); then the one closest to `target`.
 */
function chooseSpot(
  canvas: SkyCanvas,
  args: {
    target: SkyPoint;
    label: string;
    /** Placed stars to sit beside, in tiers, best tier first. */
    preferred: readonly (readonly number[])[];
    /** Would this star, sitting nearest to placed star `c`, take that
     *  place from a sibling of `c`? */
    stealsFrom?: (c: number) => boolean;
  },
): SkyPoint {
  const tierOf = (c: number) => {
    const tier = args.preferred.findIndex((stars) => stars.includes(c));
    return tier < 0 ? args.preferred.length : tier;
  };
  if (canvas.stars.length === 0) {
    return { x: round2(args.target.x), y: round2(args.target.y) };
  }
  let best: SkyPoint | null = null;
  let bestRank: SpotRank | null = null;
  const seen = new Set<string>();
  const consider = (spots: readonly SkyPoint[]) => {
    for (const p of spots) {
      const key = `${p.x},${p.y}`;
      if (seen.has(key)) continue;
      seen.add(key);
      let harm = 0;
      if (args.stealsFrom) {
        for (let c = 0; c < canvas.stars.length; c++) {
          if (
            distance(p, canvas.stars[c].point) < canvas.nearestDist[c] &&
            args.stealsFrom(c)
          ) {
            harm++;
          }
        }
      }
      const rank: SpotRank = [tierOf(canvas.nearestTo(p)), harm, distance(p, args.target)];
      if (better(rank, bestRank)) {
        best = p;
        bestRank = rank;
      }
    }
  };
  const preferredPoints = args.preferred.flat().map((c) => canvas.stars[c].point);
  for (const anchor of [args.target, ...preferredPoints]) {
    consider(freeSpotsAround(canvas, anchor, args.label));
  }
  // Nothing free beside the first preferred star yet: look farther around
  // the preferred stars.
  const found = bestRank as SpotRank | null;
  if (preferredPoints.length && (!found || found[0] > 0)) {
    for (const anchor of preferredPoints) {
      consider(freeSpotsAround(canvas, anchor, args.label, BESIDE_EXTRA_RINGS));
    }
  }
  return best ?? { x: round2(args.target.x), y: round2(args.target.y) };
}

/** How many stars' nearest star on screen is one of their two siblings. */
function besideCount(points: readonly SkyPoint[], siblings: readonly Set<number>[]): number {
  let count = 0;
  for (let i = 0; i < points.length; i++) {
    let nearest = -1;
    let best = Infinity;
    for (let j = 0; j < points.length; j++) {
      if (j === i) continue;
      const d = distance(points[i], points[j]);
      if (d < best) {
        best = d;
        nearest = j;
      }
    }
    if (siblings[i].has(nearest)) count++;
  }
  return count;
}

const REPAIR_PASSES = 3;

/**
 * Move each star whose nearest star is not a sibling to a free spot beside a
 * sibling, when that puts more stars beside a sibling overall. Deterministic:
 * stars in index order, a few passes.
 */
function repairNeighbors(
  points: SkyPoint[],
  labels: readonly string[],
  siblings: readonly Set<number>[],
): SkyPoint[] {
  let out = points.map((p) => ({ ...p }));
  let score = besideCount(out, siblings);
  for (let pass = 0; pass < REPAIR_PASSES; pass++) {
    let improved = false;
    for (let i = 0; i < out.length; i++) {
      const others = out.map((_, j) => j).filter((j) => j !== i);
      const canvas = new SkyCanvas();
      const onCanvas = new Map<number, number>();
      for (const j of others) onCanvas.set(j, canvas.add(out[j], labels[j]));
      const nearest = canvas.nearestTo(out[i]);
      if (siblings[i].has(others[nearest])) continue;
      const spot = chooseSpot(canvas, {
        target: out[i],
        label: labels[i],
        preferred: [[...siblings[i]].map((j) => onCanvas.get(j)!)],
        stealsFrom: (c) => {
          const star = others[c];
          const near = canvas.nearest[c];
          return near >= 0 && siblings[star].has(others[near]) && !siblings[star].has(i);
        },
      });
      const moved = out.map((p, j) => (j === i ? spot : p));
      const movedScore = besideCount(moved, siblings);
      if (movedScore > score) {
        out = moved;
        score = movedScore;
        improved = true;
      }
    }
    if (!improved) break;
  }
  return out;
}

// ─── Pulling groups together ─────────────────────────────────────────

/** Stars closer than this on screen are one group; two groups never come
 *  closer than this. */
const GROUP_LINK_EM = TARGET_SPACING_EM * 2.5;
const PULL_STEP_EM = 0.5;

/** Groups of stars within GROUP_LINK_EM of each other (single linkage). */
function groupsOf(points: readonly SkyPoint[]): number[][] {
  const n = points.length;
  const group = new Array<number>(n).fill(-1);
  const groups: number[][] = [];
  for (let i = 0; i < n; i++) {
    if (group[i] >= 0) continue;
    const members = [i];
    group[i] = groups.length;
    for (let k = 0; k < members.length; k++) {
      for (let j = 0; j < n; j++) {
        if (group[j] < 0 && distance(points[members[k]], points[j]) < GROUP_LINK_EM) {
          group[j] = groups.length;
          members.push(j);
        }
      }
    }
    groups.push(members.sort((a, b) => a - b));
  }
  return groups;
}

/**
 * t-SNE keeps unrelated groups far apart, which would leave a kid's sky mostly
 * empty. Slide each group, whole, toward the groups already settled until it
 * would come within GROUP_LINK_EM of one: a group's own arrangement never
 * changes, and groups stay farther apart than any star sits from its group,
 * so a star with a group-mate keeps its nearest star (a lone star may gain a
 * nearer one; it had no near sibling to lose).
 */
function pullGroupsTogether(points: SkyPoint[], labels: readonly string[]): SkyPoint[] {
  const groups = groupsOf(points);
  if (groups.length < 2) return points;
  const out = points.map((p) => ({ ...p }));
  const middle = centroid(points);
  const order = groups
    .map((members, g) => ({
      members,
      g,
      d: distance(centroid(members.map((i) => points[i])), middle),
    }))
    .sort((a, b) => a.d - b.d || a.g - b.g);
  const settled: number[] = [...order[0].members];
  for (const { members } of order.slice(1)) {
    const target = centroid(settled.map((i) => out[i]));
    const from = centroid(members.map((i) => out[i]));
    const span = distance(from, target);
    if (span > 1e-9) {
      const ux = (target.x - from.x) / span;
      const uy = (target.y - from.y) / span;
      const fits = (t: number) =>
        members.every((i) => {
          const p = { x: out[i].x + ux * t, y: out[i].y + uy * t };
          const box = skyLabelBox(p, labels[i]);
          return settled.every(
            (j) =>
              distance(p, out[j]) >= GROUP_LINK_EM &&
              !skyBoxesOverlap(box, skyLabelBox(out[j], labels[j]), PLACE_GAP_EM),
          );
        });
      let t = 0;
      if (fits(0)) {
        while (t + PULL_STEP_EM <= span && fits(t + PULL_STEP_EM)) t += PULL_STEP_EM;
      } else {
        while (!fits(t)) t -= PULL_STEP_EM;
      }
      for (const i of members) {
        out[i] = { x: out[i].x + ux * t, y: out[i].y + uy * t };
      }
    }
    settled.push(...members);
  }
  return out;
}

// ─── First layout ────────────────────────────────────────────────────

/** Each star's other stars, most similar first (ties by index). */
function meaningRanks(similarity: number[][]): number[][] {
  return similarity.map((row, i) =>
    row
      .map((s, j) => ({ s, j }))
      .filter(({ j }) => j !== i)
      .sort((a, b) => b.s - a.s || a.j - b.j)
      .map(({ j }) => j),
  );
}

/** The order stars are placed in: outward along links of meaning (each
 *  star's three closest, both ways) from the star nearest the middle, so a
 *  star's siblings are usually placed before it. */
function placementOrder(ranks: number[][], targets: readonly SkyPoint[]): number[] {
  const n = ranks.length;
  const middle = centroid(targets);
  const byMiddle = targets
    .map((p, i) => ({ i, d: distance(p, middle) }))
    .sort((a, b) => a.d - b.d || a.i - b.i)
    .map(({ i }) => i);
  const links = ranks.map((r) => new Set(r.slice(0, 3)));
  for (let i = 0; i < n; i++) for (const j of ranks[i].slice(0, 3)) links[j].add(i);
  const seen = new Set<number>();
  const order: number[] = [];
  for (const start of byMiddle) {
    if (seen.has(start)) continue;
    seen.add(start);
    const queue = [start];
    for (let head = 0; head < queue.length; head++) {
      const i = queue[head];
      order.push(i);
      for (const j of ranks[i]) {
        if (links[i].has(j) && !seen.has(j)) {
          seen.add(j);
          queue.push(j);
        }
      }
    }
  }
  return order;
}

/**
 * Lay out all of a kid's stars at once. Related stars sit together, and no
 * two label boxes overlap. Returns one point per input, in order.
 */
export function firstLayout(stars: readonly SkyLayoutInput[]): SkyPoint[] {
  const n = stars.length;
  if (n === 0) return [];
  const labels = stars.map((s) => s.label);
  const similarity = cosineMatrix(stars.map((s) => s.vector));
  const targets =
    n === 1
      ? [{ x: 0, y: 0 }]
      : n === 2
        ? [
            { x: -TARGET_SPACING_EM / 2, y: 0 },
            { x: TARGET_SPACING_EM / 2, y: 0 },
          ]
        : scaleToSpacing(tsne2d(similarity));
  const ranks = meaningRanks(similarity);
  const siblings = ranks.map((r) => new Set(r.slice(0, 2)));

  const canvas = new SkyCanvas();
  /** Input index → canvas index, and back. */
  const onCanvas = new Array<number>(n).fill(-1);
  const fromCanvas: number[] = [];
  for (const i of placementOrder(ranks, targets)) {
    const placedSiblings = [...siblings[i]].filter((j) => onCanvas[j] >= 0);
    const anchorStars = placedSiblings.length
      ? placedSiblings
      : ranks[i].filter((j) => onCanvas[j] >= 0).slice(0, 1);
    const point = chooseSpot(canvas, {
      target: targets[i],
      label: labels[i],
      preferred: [anchorStars.map((j) => onCanvas[j])],
      stealsFrom: (c) => {
        const star = fromCanvas[c];
        const near = canvas.nearest[c];
        return (
          near >= 0 && siblings[star].has(fromCanvas[near]) && !siblings[star].has(i)
        );
      },
    });
    onCanvas[i] = canvas.add(point, labels[i]);
    fromCanvas.push(i);
  }
  const placed = repairNeighbors(
    stars.map((_, i) => canvas.stars[onCanvas[i]].point),
    labels,
    siblings,
  );
  const pulled = pullGroupsTogether(placed, labels);
  const middle = centroid(pulled);
  return pulled.map((p) => ({ x: round2(p.x - middle.x), y: round2(p.y - middle.y) }));
}

// ─── Place new ───────────────────────────────────────────────────────

/** Directions tried around a sibling, evenly round the circle, offset half a
 *  step so none is exactly level or plumb: a slot straight beside or under
 *  its sibling is how rows and columns line up. */
const SLOT_ANGLES = 24;
/** Distances tried in each direction, in multiples of the distance at which
 *  the two labels just clear (`clearDistance`); the far ones only when
 *  nothing nearer is free. */
const SLOT_RADII = [1, 1.35, 1.8] as const;
const SLOT_FAR_RADII = [2.4, 3.2, 4.2, 5.5] as const;
/** A little extra clearance on a slot, so rounding to 0.01 em never lets it
 *  touch the star it sits beside. */
const SLOT_SLACK_EM = 0.05;
/**
 * The room a new star leaves around itself. A slot pays (ROOM_EM / d)² in
 * clear distances, where d is how far its nearest star on screen is, in em.
 * A star tucked in at a neighbor's minimum distance (about 3 em straight
 * down) leaves no nearer spot for a closer sibling that arrives later, so
 * that sibling can never become its nearest. Calibrated by a sweep over
 * synthetic 30-star skies grown one star at a time (the measure in
 * skyLayout.test.ts, 12 skies, before the half-step angle offset): mixed
 * order scored 62% with no room term and 81% to 89% at 12 to 20 em; at 20
 * em, skies grown thread by thread fell from 96% to 93%, so 16. The test's
 * fixtures score 81% mixed and 92% thread by thread at 16.
 */
const ROOM_EM = 16;

/**
 * How far from a star labelled `fromLabel`, in direction `angle` (radians,
 * y down), a star labelled `label` must sit for their boxes to clear by
 * PLACE_GAP_EM. Labels are wide and short, so it is about four times farther
 * sideways than straight down.
 */
function clearDistance(fromLabel: string, label: string, angle: number): number {
  const from = skyLabelSize(fromLabel);
  const to = skyLabelSize(label);
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const needX = (from.w + to.w) / 2 + PLACE_GAP_EM + SLOT_SLACK_EM;
  // Each box hangs below its dot: a star below clears the upper one's height.
  const needY = (sin > 0 ? from.h : to.h) + PLACE_GAP_EM + SLOT_SLACK_EM;
  const alongX = Math.abs(cos) > 1e-9 ? needX / Math.abs(cos) : Infinity;
  const alongY = Math.abs(sin) > 1e-9 ? needY / Math.abs(sin) : Infinity;
  return Math.min(alongX, alongY);
}

/** How far apart two stars are in clear distances: 1 means their labels just
 *  clear, whichever way one lies from the other. In em, a star beside
 *  another looks four times farther off than one stacked under it, which is
 *  why a sky grown by em stacked into one column. */
function clearDistances(p: SkyPoint, label: string, q: SkyPoint, qLabel: string): number {
  const d = distance(p, q);
  if (d < 1e-9) return 0;
  return d / clearDistance(qLabel, label, Math.atan2(p.y - q.y, p.x - q.x));
}

type MeaningSibling = { j: number; sim: number };

/** `list` with star `j` added, kept to the two most similar, most similar
 *  first (ties: lower index). */
function withSibling(
  list: readonly MeaningSibling[],
  j: number,
  sim: number,
): MeaningSibling[] {
  return [...list, { j, sim }].sort((a, b) => b.sim - a.sim || a.j - b.j).slice(0, 2);
}

function hasSibling(list: readonly MeaningSibling[], j: number): boolean {
  return list.some((s) => s.j === j);
}

/** A slot's rank: more stars beside a sibling, then the lower cost. */
type SlotRank = [beside: number, cost: number];

function betterSlot(a: SlotRank, b: SlotRank | null): boolean {
  if (!b) return true;
  return a[0] !== b[0] ? a[0] > b[0] : a[1] < b[1];
}

/**
 * Place new stars on a sky that already has some. Placed stars never move:
 * the result is only the new stars' points, in order. Each new star, in the
 * order given (a new star placed earlier in the same call counts as placed),
 * is slotted beside a sibling in meaning: slots are tried in SLOT_ANGLES
 * directions at SLOT_RADII times the distance where the labels just clear,
 * round its two closest siblings and round any star it becomes one of the
 * two closest siblings of. Of the free slots, the best:
 *   1. leaves the most stars on the sky with a sibling as their nearest star
 *      on screen (the layout's measure, counted with this star in place);
 *   2. then costs least: its clear distances to the new star's two closest
 *      siblings, plus the room it leaves (ROOM_EM).
 * A sky grown this way spreads out in both directions instead of stacking.
 */
export function placeNewStars(
  placed: readonly PlacedSkyStar[],
  incoming: readonly SkyLayoutInput[],
): SkyPoint[] {
  const canvas = new SkyCanvas();
  const vectors: (number[] | null)[] = [];
  for (const s of placed) {
    canvas.add({ x: s.x, y: s.y }, s.label);
    vectors.push(s.vector && s.vector.length ? unit(s.vector) : null);
  }
  // Each star's two closest siblings in meaning among the stars on the sky.
  let siblings: MeaningSibling[][] = vectors.map(() => []);
  for (let i = 0; i < vectors.length; i++) {
    const vi = vectors[i];
    if (!vi) continue;
    for (let j = i + 1; j < vectors.length; j++) {
      const vj = vectors[j];
      if (!vj) continue;
      const sim = dot(vi, vj);
      siblings[i] = withSibling(siblings[i], j, sim);
      siblings[j] = withSibling(siblings[j], i, sim);
    }
  }

  const out: SkyPoint[] = [];
  for (const star of incoming) {
    const v = unit(star.vector);
    const n = canvas.stars.length;
    const sims = vectors.map((w) => (w ? dot(v, w) : null));
    let own: MeaningSibling[] = [];
    sims.forEach((sim, j) => {
      if (sim !== null) own = withSibling(own, j, sim);
    });
    // Every star's two closest siblings once this one is on the sky.
    const after = siblings.map((list, j) => {
      const sim = sims[j];
      return sim === null ? list : withSibling(list, n, sim);
    });

    const rankOf = (p: SkyPoint): SlotRank => {
      let beside = 0;
      let nearest = -1;
      let nearestDist = Infinity;
      for (let c = 0; c < n; c++) {
        const d = distance(p, canvas.stars[c].point);
        if (d < nearestDist) {
          nearestDist = d;
          nearest = c;
        }
        if (!vectors[c]) continue;
        const near = d < canvas.nearestDist[c] ? n : canvas.nearest[c];
        if (near >= 0 && hasSibling(after[c], near)) beside++;
      }
      if (nearest >= 0 && hasSibling(own, nearest)) beside++;
      let cost = (ROOM_EM / Math.max(nearestDist, 1e-6)) ** 2;
      for (const s of own) {
        const sibling = canvas.stars[s.j];
        cost += clearDistances(p, star.label, sibling.point, sibling.label);
      }
      return [beside, cost];
    };

    let point: SkyPoint | null = null;
    const anchors = own.map((s) => s.j);
    for (let c = 0; c < n; c++) {
      if (!anchors.includes(c) && hasSibling(after[c], n)) anchors.push(c);
    }
    let bestRank: SlotRank | null = null;
    const seen = new Set<string>();
    for (const radii of [SLOT_RADII, SLOT_FAR_RADII]) {
      for (const j of anchors) {
        const anchor = canvas.stars[j];
        for (const r of radii) {
          for (let k = 0; k < SLOT_ANGLES; k++) {
            const angle = (2 * Math.PI * (k + 0.5)) / SLOT_ANGLES;
            const t = r * clearDistance(anchor.label, star.label, angle);
            const p = {
              x: round2(anchor.point.x + t * Math.cos(angle)),
              y: round2(anchor.point.y + t * Math.sin(angle)),
            };
            const key = `${p.x},${p.y}`;
            if (seen.has(key)) continue;
            seen.add(key);
            if (!canvas.isFree(p, star.label)) continue;
            const rank = rankOf(p);
            if (betterSlot(rank, bestRank)) {
              point = p;
              bestRank = rank;
            }
          }
        }
      }
      if (point) break;
    }
    if (!point) {
      // No free slot near a sibling: the free spot nearest the closest one.
      // No sibling in meaning on the sky at all: nearest the sky's middle.
      const target = own.length
        ? canvas.stars[own[0].j].point
        : n
          ? centroid(canvas.stars.map((s) => s.point))
          : { x: 0, y: 0 };
      point = chooseSpot(canvas, {
        target,
        label: star.label,
        preferred: own.map((s) => [s.j]),
      });
    }

    canvas.add(point, star.label);
    vectors.push(v);
    siblings = [...after, own];
    out.push(point);
  }
  return out;
}

// ─── Near this ───────────────────────────────────────────────────────

/**
 * For each star, up to SKY_NEARBY_COUNT other stars within
 * SKY_NEARBY_RADIUS_EM, nearest first (ties by input order). Indices into
 * `points`.
 */
export function nearbySkyStars(points: readonly SkyPoint[]): number[][] {
  return points.map((p, i) =>
    points
      .map((q, j) => ({ j, d: distance(p, q) }))
      .filter(({ j, d }) => j !== i && d <= SKY_NEARBY_RADIUS_EM)
      .sort((a, b) => a.d - b.d || a.j - b.j)
      .slice(0, SKY_NEARBY_COUNT)
      .map(({ j }) => j),
  );
}
