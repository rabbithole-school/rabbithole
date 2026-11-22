/**
 * The per-kid Sky layout (TRA-699, lib/skyLayout.ts), on synthetic clustered
 * vectors: related stars sit together, no two label boxes overlap, placing
 * new stars moves no old one, a sky grown one star at a time spreads out
 * instead of stacking, and the same input always gives the same sky.
 */
import { describe, expect, test } from "vitest";
import {
  cosineMatrix,
  firstLayout,
  nearbySkyStars,
  placeNewStars,
  SKY_NEARBY_COUNT,
  SKY_NEARBY_RADIUS_EM,
  skyBoxesOverlap,
  skyLabelBox,
  type SkyLayoutInput,
  type SkyPoint,
} from "../lib/skyLayout";

const DIMS = 512;

/** A small seeded generator (mulberry32), so the fixtures never change. */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function gaussian(next: () => number): number {
  const u = Math.max(next(), 1e-12);
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * next());
}

function randomVector(next: () => number): number[] {
  return Array.from({ length: DIMS }, () => gaussian(next));
}

function normalize(v: number[]): number[] {
  const n = Math.hypot(...v);
  return v.map((x) => x / n);
}

const LABELS = [
  "Why do owls hoot at night?",
  "Volcano game",
  "How far away is the moon?",
  "Do fish sleep?",
  "My robot dog",
  "Why is the ocean salty",
  "Dragons",
  "How do bats find bugs in the dark?",
  "Lava lamp science",
  "What is inside a black hole?",
];

/**
 * Clusters of "threads": each cluster is a short path through meaning (a
 * center plus steps along one direction), so a star's two closest stars in
 * meaning are well defined, the way a run of related questions is.
 */
function clusteredSky(seed: number, sizes: number[]): SkyLayoutInput[] {
  const next = rng(seed);
  const stars: SkyLayoutInput[] = [];
  let k = 0;
  for (const size of sizes) {
    const center = normalize(randomVector(next));
    const direction = normalize(randomVector(next));
    const bend = normalize(randomVector(next));
    for (let i = 0; i < size; i++) {
      const t = i / Math.max(1, size - 1) - 0.5;
      const noise = randomVector(next).map((x) => x * 0.02);
      const v = center.map(
        (c, d) => c + 0.9 * t * direction[d] + 0.25 * t * t * bend[d] + noise[d],
      );
      stars.push({ vector: normalize(v), label: LABELS[k++ % LABELS.length] });
    }
  }
  return stars;
}

/** Share of stars whose nearest star on screen is one of their two closest
 *  in meaning (the offline test's measure). */
function neighborScore(stars: SkyLayoutInput[], points: SkyPoint[]): number {
  const sim = cosineMatrix(stars.map((s) => s.vector));
  let hits = 0;
  for (let i = 0; i < points.length; i++) {
    const meaning = sim[i]
      .map((s, j) => ({ s, j }))
      .filter(({ j }) => j !== i)
      .sort((a, b) => b.s - a.s)
      .slice(0, 2)
      .map(({ j }) => j);
    let nearest = -1;
    let best = Infinity;
    for (let j = 0; j < points.length; j++) {
      if (j === i) continue;
      const d = Math.hypot(points[i].x - points[j].x, points[i].y - points[j].y);
      if (d < best) {
        best = d;
        nearest = j;
      }
    }
    if (meaning.includes(nearest)) hits++;
  }
  return hits / points.length;
}

function overlapping(points: SkyPoint[], labels: string[]): [number, number][] {
  const out: [number, number][] = [];
  for (let i = 0; i < points.length; i++) {
    for (let j = i + 1; j < points.length; j++) {
      if (
        skyBoxesOverlap(skyLabelBox(points[i], labels[i]), skyLabelBox(points[j], labels[j]))
      ) {
        out.push([i, j]);
      }
    }
  }
  return out;
}

const SKIES: { name: string; seed: number; sizes: number[] }[] = [
  { name: "a typical kid", seed: 7, sizes: [5, 4, 6, 3, 4] },
  { name: "a kid with one big interest", seed: 11, sizes: [12, 4, 3, 5] },
  { name: "a kid with many small threads", seed: 23, sizes: [3, 3, 4, 3, 3, 4, 3, 3] },
  { name: "a busy sky", seed: 42, sizes: [8, 6, 7, 5, 9, 6, 4, 8, 6, 5] },
];

describe("firstLayout", () => {
  for (const sky of SKIES) {
    test(`${sky.name}: related stars sit together, and no labels overlap`, () => {
      const stars = clusteredSky(sky.seed, sky.sizes);
      const points = firstLayout(stars);
      expect(points).toHaveLength(stars.length);
      expect(neighborScore(stars, points)).toBeGreaterThanOrEqual(0.9);
      expect(overlapping(points, stars.map((s) => s.label))).toEqual([]);
    });
  }

  test("is deterministic", () => {
    const stars = clusteredSky(7, [5, 4, 6, 3, 4]);
    expect(firstLayout(stars)).toEqual(firstLayout(stars));
  });

  test("handles none, one and two stars", () => {
    expect(firstLayout([])).toEqual([]);
    const two = clusteredSky(3, [2]);
    expect(firstLayout(two.slice(0, 1))).toEqual([{ x: 0, y: 0 }]);
    const points = firstLayout(two);
    expect(points).toHaveLength(2);
    expect(overlapping(points, two.map((s) => s.label))).toEqual([]);
  });
});

describe("placeNewStars", () => {
  test("moves no old star, places beside a sibling, and overlaps nothing", () => {
    let beside = 0;
    let added = 0;
    for (const sky of SKIES) {
      const all = clusteredSky(sky.seed + 100, sky.sizes);
      // Hold back every fifth star: the kid's newest ones, added in order.
      const old = all.filter((_, i) => i % 5 !== 4);
      const fresh = all.filter((_, i) => i % 5 === 4);

      const oldPoints = firstLayout(old);
      const before = oldPoints.map((p) => ({ ...p }));
      const placed = old.map((s, i) => ({ ...oldPoints[i], vector: s.vector, label: s.label }));
      const newPoints = placeNewStars(placed, fresh);

      // Exact equality: no old star moved, not even by a rounding step.
      expect(placed.map(({ x, y }) => ({ x, y }))).toEqual(before);
      expect(newPoints).toHaveLength(fresh.length);

      const points = [...oldPoints, ...newPoints];
      const stars = [...old, ...fresh];
      expect(overlapping(points, stars.map((s) => s.label))).toEqual([]);

      // Each new star's nearest star on screen, among those placed before
      // it, against its two closest in meaning among the same stars.
      const sim = cosineMatrix(stars.map((s) => s.vector));
      for (let k = 0; k < fresh.length; k++) {
        const i = old.length + k;
        const siblings = sim[i]
          .slice(0, i)
          .map((s, j) => ({ s, j }))
          .sort((a, b) => b.s - a.s)
          .slice(0, 2)
          .map(({ j }) => j);
        const nearest = points
          .slice(0, i)
          .map((p, j) => ({ j, d: Math.hypot(points[i].x - p.x, points[i].y - p.y) }))
          .sort((a, b) => a.d - b.d)[0].j;
        if (siblings.includes(nearest)) beside++;
        added++;
      }
    }
    expect(beside / added).toBeGreaterThanOrEqual(0.9);
  });

  test("is deterministic", () => {
    const all = clusteredSky(5, [4, 4, 4]);
    const old = all.slice(0, 9);
    const oldPoints = firstLayout(old);
    const placed = old.map((s, i) => ({ ...oldPoints[i], vector: s.vector, label: s.label }));
    expect(placeNewStars(placed, all.slice(9))).toEqual(placeNewStars(placed, all.slice(9)));
  });

  test("a star with no vector still takes its space", () => {
    const all = clusteredSky(9, [3, 3]);
    const oldPoints = firstLayout(all.slice(0, 4));
    const placed = all.slice(0, 4).map((s, i) => ({
      ...oldPoints[i],
      vector: i === 0 ? null : s.vector,
      label: s.label,
    }));
    const newPoints = placeNewStars(placed, all.slice(4));
    const points = [...oldPoints, ...newPoints];
    expect(overlapping(points, all.map((s) => s.label))).toEqual([]);
  });
});

/** A fixed shuffle, for a kid who hops between interests. */
function mixed<T>(xs: readonly T[], seed: number): T[] {
  const next = rng(seed);
  const out = [...xs];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(next() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/**
 * A sky built the way a kid who starts with none gets it: the first star
 * through `firstLayout`, then one refresh per new star, each through
 * `placeNewStars`. Checks at every step that no placed star moved.
 */
function grow(stars: readonly SkyLayoutInput[]): SkyPoint[] {
  const points: SkyPoint[] = [...firstLayout(stars.slice(0, 1))];
  for (let k = 1; k < stars.length; k++) {
    const placed = stars
      .slice(0, k)
      .map((s, i) => ({ ...points[i], vector: s.vector, label: s.label }));
    const before = placed.map(({ x, y }) => ({ x, y }));
    const fresh = placeNewStars(placed, [stars[k]]);
    expect(fresh).toHaveLength(1);
    expect(placed.map(({ x, y }) => ({ x, y }))).toEqual(before);
    points.push(...fresh);
  }
  return points;
}

/** Three stars placed one after another that line up level or plumb, to
 *  within 1 em: the column a grown sky used to stack into. */
function linedUpRuns(points: readonly SkyPoint[]): number[] {
  const runs: number[] = [];
  for (let i = 2; i < points.length; i++) {
    const run = points.slice(i - 2, i + 1);
    const spread = (axis: "x" | "y") =>
      Math.max(...run.map((p) => p[axis])) - Math.min(...run.map((p) => p[axis]));
    if (spread("x") < 1 || spread("y") < 1) runs.push(i);
  }
  return runs;
}

const GROWN: { size: number; sizes: number[] }[] = [
  { size: 8, sizes: [3, 3, 2] },
  { size: 16, sizes: [5, 4, 4, 3] },
  { size: 30, sizes: [8, 6, 5, 6, 5] },
];
const GROWN_SEEDS = [1, 2, 3, 4, 5, 6];

describe("a sky grown one star at a time", () => {
  for (const { size, sizes } of GROWN) {
    test(`${size} stars: no straight-line stacking, no overlapping labels`, () => {
      for (const seed of GROWN_SEEDS) {
        const threads = clusteredSky(seed * 31 + size, sizes);
        for (const stars of [threads, mixed(threads, seed)]) {
          const points = grow(stars);
          expect(points).toHaveLength(size);
          expect(linedUpRuns(points)).toEqual([]);
          expect(overlapping(points, stars.map((s) => s.label))).toEqual([]);
        }
      }
    });
  }

  test("related stars sit together: the measure for 8, 16 and 30 stars", () => {
    // The share of stars whose nearest star on screen is one of their two
    // closest in meaning, for skies grown thread by thread and in mixed
    // order. These fixtures score 96/90%, 89/86% and 92/81% (thread/mixed)
    // for 8, 16 and 30 stars. Before slotting, when each star went straight
    // under its closest sibling, they scored 98/81%, 97/75% and 95/50%.
    const score = (size: number, sizes: number[], order: "threads" | "mixed") => {
      let total = 0;
      for (const seed of GROWN_SEEDS) {
        const threads = clusteredSky(seed * 31 + size, sizes);
        const stars = order === "threads" ? threads : mixed(threads, seed);
        total += neighborScore(stars, grow(stars));
      }
      return total / GROWN_SEEDS.length;
    };
    const below: string[] = [];
    for (const { size, sizes } of GROWN) {
      for (const order of ["threads", "mixed"] as const) {
        const s = score(size, sizes, order);
        if (s < 0.8) below.push(`${size} stars, ${order}: ${s.toFixed(2)}`);
      }
    }
    expect(below).toEqual([]);
  });

  test("is deterministic", () => {
    const stars = mixed(clusteredSky(5, [4, 4, 4, 3]), 5);
    expect(grow(stars)).toEqual(grow(stars));
  });
});

describe("nearbySkyStars", () => {
  test("up to three stars within the radius, nearest first", () => {
    const points = [
      { x: 0, y: 0 },
      { x: 3, y: 0 },
      { x: 0, y: 5 },
      { x: 6, y: 0 },
      { x: 9, y: 0 },
      { x: SKY_NEARBY_RADIUS_EM * 3, y: 0 },
    ];
    const near = nearbySkyStars(points);
    expect(near[0]).toEqual([1, 2, 3]);
    expect(near[0]).toHaveLength(SKY_NEARBY_COUNT);
    expect(near[5]).toEqual([]);
  });
});
