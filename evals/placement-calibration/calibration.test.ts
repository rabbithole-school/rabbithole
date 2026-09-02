import { convexTest } from "convex-test";
import { beforeAll, describe, expect, test } from "vitest";
import schema from "../../convex/schema";
import { internal } from "../../convex/_generated/api";
import {
  decideAnswer,
  directionChanges,
  loadDomainMeta,
  mulberry32,
  runCell,
  trueKnownSet,
  type Cx,
  type DomainMeta,
  type RunMetrics,
} from "./harness";
import { buildGrid, implicatedKnobs, summarize } from "./grid";

const modules = (import.meta as ImportMeta & {
  glob: (p: string) => Record<string, () => Promise<unknown>>;
}).glob("../../convex/**/*.ts");

const GEO = "geometry-measurement";

// ── Pure unit tests (no Convex) ────────────────────────────────────────────

describe("harness pure helpers", () => {
  test("directionChanges counts sign flips, ignoring flats", () => {
    expect(directionChanges([1, 2, 3])).toBe(0); // monotone up
    expect(directionChanges([3, 2, 1])).toBe(0); // monotone down
    expect(directionChanges([1, 3, 2, 4])).toBe(2); // up, down, up
    expect(directionChanges([1, 1, 2, 2, 1])).toBe(1); // flats skipped, one flip
    expect(directionChanges([])).toBe(0);
  });

  test("mulberry32 is deterministic per seed", () => {
    const a = mulberry32(42);
    const b = mulberry32(42);
    expect([a(), a(), a()]).toEqual([b(), b(), b()]);
  });

  test("decideAnswer: grade decides known/unknown; unknown non-MC is an honest IDK", () => {
    const rng = mulberry32(1);
    const probe = { itemId: "not-a-real-item", skillKey: "x", strand: "s", grade: "2", answerType: "integer" as const };
    // Oracle at G=3 KNOWS a grade-2 node…
    expect(decideAnswer(probe, "3", { pSlip: 0, pGuessMc: 0 }, rng).knows).toBe(true);
    // …and does NOT know a grade-5 node, answering an honest IDK (non-MC).
    const hi = { ...probe, grade: "5" };
    const d = decideAnswer(hi, "3", { pSlip: 0, pGuessMc: 0 }, rng);
    expect(d.knows).toBe(false);
    expect(d.submit.dontKnow).toBe(true);
  });
});

// ── Real-path smoke: a small deterministic grid ────────────────────────────

describe("placement calibration — smoke grid", () => {
  let t: Cx;
  let geo: DomainMeta;

  beforeAll(async () => {
    t = convexTest(schema, modules);
    await t.mutation(internal.practiceSkills.seedGraph, {});
    geo = await loadDomainMeta(t, GEO);
  });

  test("trueKnownSet only counts nodes at/below G", () => {
    const g2 = trueKnownSet(geo, "2");
    const g4 = trueKnownSet(geo, "4");
    expect(g2.size).toBeGreaterThan(0);
    expect(g4.size).toBeGreaterThan(g2.size); // monotone in G
  });

  test("reproduces the pilot: geometry You-Pick G2 opens high and eats honest IDKs", async () => {
    const m = await runCell(t, geo, {
      domain: GEO,
      entry: "you-pick",
      oracle: { grade: "2", noise: { pSlip: 0, pGuessMc: 0 } },
      seed: 1,
    });
    expect(m.probes).toBeGreaterThan(0);
    // First probe opens well above a grade-2 kid (the "formal angle language" problem).
    expect(m.overshootMaxGrades).toBeGreaterThanOrEqual(2);
    // The kid eats many honest IDKs before the search finds their level.
    expect(m.idkBurden).toBeGreaterThanOrEqual(m.probes * 0.5);
    // start-prior is the implicated knob for this cell.
    expect(implicatedKnobs(summarize([m])[0]).some((k) => k.knob === "start-prior")).toBe(true);
  });

  // POST-FIX: the You-Pick grade prior closes the cold-entry gap the pilot
  // flagged. A cold pick now opens at the domain floor and trusts upward, so it
  // costs about the SAME as an accurate prior — here it is even a touch cheaper,
  // because the floor anchor opens at/below the kid while the accurate default
  // opens one affect-safe grade ABOVE. We assert the gap is now small in both
  // directions, and that the accurate prior never overshoots MORE than a cold pick.
  test("the You-Pick grade prior makes a cold pick cost about the same as an accurate prior", async () => {
    const yp = await runCell(t, geo, {
      domain: GEO,
      entry: "you-pick",
      oracle: { grade: "2", noise: { pSlip: 0, pGuessMc: 0 } },
      seed: 1,
    });
    const df = await runCell(t, geo, {
      domain: GEO,
      entry: "default-foundational",
      oracle: { grade: "2", noise: { pSlip: 0, pGuessMc: 0 } },
      seed: 1,
    });
    expect(Math.abs(yp.probes - df.probes)).toBeLessThanOrEqual(3);
    expect(df.overshootMaxGrades).toBeLessThanOrEqual(yp.overshootMaxGrades);
  });

  test("clean runs are deterministic (seed-invariant, run-invariant)", async () => {
    const spec = {
      domain: GEO,
      entry: "you-pick" as const,
      oracle: { grade: "3", noise: { pSlip: 0, pGuessMc: 0 } },
      seed: 999,
    };
    const a = await runCell(t, geo, spec);
    const b = await runCell(t, geo, { ...spec, seed: 12345 });
    const same = (x: RunMetrics, y: RunMetrics) =>
      x.probes === y.probes &&
      x.idkBurden === y.idkBurden &&
      x.overshootMaxGrades === y.overshootMaxGrades &&
      x.oscillationGlobal === y.oscillationGlobal &&
      x.overCredit === y.overCredit &&
      x.underCredit === y.underCredit &&
      x.placedThroughGrade === y.placedThroughGrade;
    expect(same(a, b)).toBe(true);
  });

  test("credited-vs-true frontier error is well-formed (0 ≤ over/under ≤ node counts)", async () => {
    const m = await runCell(t, geo, {
      domain: GEO,
      entry: "you-pick",
      oracle: { grade: "5", noise: { pSlip: 0, pGuessMc: 0 } },
      seed: 1,
    });
    expect(m.overCredit).toBeGreaterThanOrEqual(0);
    expect(m.underCredit).toBeGreaterThanOrEqual(0);
    expect(m.credited).toBeLessThanOrEqual(geo.allKeys.length);
    expect(m.trueKnown).toBeGreaterThan(0);
  });

  test("buildGrid respects an explicit sub-grid and summarize groups by cell", async () => {
    const grid = buildGrid({
      domains: [GEO],
      grades: ["2"],
      entries: ["you-pick"],
      noises: [{ name: "guess25", noise: { pSlip: 0, pGuessMc: 0.25 } }],
      noiseSeeds: 3,
    });
    expect(grid.length).toBe(3); // 1×1×1×3 seeds
    const runs: RunMetrics[] = [];
    for (const c of grid) runs.push(await runCell(t, geo, c));
    const s = summarize(runs);
    expect(s.length).toBe(1); // one cell, 3 seeds aggregated
    expect(s[0].runs).toBe(3);
  });
});
