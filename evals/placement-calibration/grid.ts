/**
 * The calibration GRID: which oracle profiles × domains × entry kinds to run,
 * how to aggregate the per-run metrics into per-cell summaries, and — analysis
 * only, NO tuning — which placement knob (start prior / step size / convergence
 * rule) each bad cell implicates.
 *
 * Everything here is pure (no Convex); the Convex-driving lives in ./harness.ts.
 */

import { PRACTICE_DOMAINS } from "../../convex/lib/practice/domains";
import type { CellSpec, EntryKind, NoiseProfile, RunMetrics } from "./harness";

// ── Grid axes ──────────────────────────────────────────────────────────────

/** Representative true-frontier grades. Covers the pilot's grade-2 case up
 *  through mid-elementary; domain content spans ~grade 2–8. */
export const GRADES = ["2", "3", "4", "5", "6"] as const;

/** The 7 registered practice domains (source of truth: PRACTICE_DOMAINS). */
export const DOMAINS: string[] = PRACTICE_DOMAINS.map((d) => d.domain);

export const ENTRIES: EntryKind[] = ["default-foundational", "you-pick"];

export type NamedNoise = { name: string; noise: NoiseProfile };

/** Clean oracle + two single-axis noise variants. Clean is seed-invariant. */
export const NOISE_PROFILES: NamedNoise[] = [
  { name: "clean", noise: { pSlip: 0, pGuessMc: 0 } },
  { name: "slip15", noise: { pSlip: 0.15, pGuessMc: 0 } },
  { name: "guess25", noise: { pSlip: 0, pGuessMc: 0.25 } },
];

/** Seeds per noisy cell (a noisy cell is sampled this many times; a clean cell
 *  is deterministic so one seed suffices). */
export const NOISE_SEEDS = 5;

/** Build the full flat list of runs (one CellSpec per seed). */
export function buildGrid(opts?: {
  grades?: readonly string[];
  domains?: readonly string[];
  entries?: readonly EntryKind[];
  noises?: readonly NamedNoise[];
  noiseSeeds?: number;
}): CellSpec[] {
  const grades = opts?.grades ?? GRADES;
  const domains = opts?.domains ?? DOMAINS;
  const entries = opts?.entries ?? ENTRIES;
  const noises = opts?.noises ?? NOISE_PROFILES;
  const noiseSeeds = opts?.noiseSeeds ?? NOISE_SEEDS;

  const cells: CellSpec[] = [];
  for (const domain of domains) {
    for (const entry of entries) {
      for (const grade of grades) {
        for (const { noise } of noises) {
          const isClean = noise.pSlip === 0 && noise.pGuessMc === 0;
          const seeds = isClean ? [1] : Array.from({ length: noiseSeeds }, (_, i) => i + 1);
          for (const seed of seeds) {
            cells.push({ domain, entry, oracle: { grade, noise }, seed });
          }
        }
      }
    }
  }
  return cells;
}

// ── Aggregation ────────────────────────────────────────────────────────────

export type CellKey = string; // `${domain}|${entry}|${grade}|${noiseName}`

export function noiseName(pSlip: number, pGuessMc: number): string {
  if (pSlip === 0 && pGuessMc === 0) return "clean";
  if (pGuessMc === 0) return `slip${Math.round(pSlip * 100)}`;
  if (pSlip === 0) return `guess${Math.round(pGuessMc * 100)}`;
  return `slip${Math.round(pSlip * 100)}_guess${Math.round(pGuessMc * 100)}`;
}

export function cellKeyOf(m: RunMetrics): CellKey {
  return `${m.domain}|${m.entry}|${m.grade}|${noiseName(m.pSlip, m.pGuessMc)}`;
}

export type CellSummary = {
  key: CellKey;
  domain: string;
  entry: EntryKind;
  grade: string;
  noise: string;
  runs: number;
  probes: number;
  idkBurden: number;
  overshootMaxGrades: number;
  overshootMeanGrades: number;
  oscillationGlobal: number;
  oscillationPerStrandMean: number;
  overCredit: number;
  underCredit: number;
  /** Over-credit as a fraction of the domain's UNKNOWN nodes (cross-domain comparable). */
  overCreditFrac: number;
  /** Under-credit as a fraction of the oracle's KNOWN nodes (cross-domain comparable). */
  underCreditFrac: number;
  gradeErrorMean: number;
  gradeErrorAbsMean: number;
  trueKnown: number;
  credited: number;
  capHitRate: number;
  badness: number;
};

const mean = (xs: number[]): number => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

export function summarize(runs: RunMetrics[]): CellSummary[] {
  const byKey = new Map<CellKey, RunMetrics[]>();
  for (const r of runs) {
    const k = cellKeyOf(r);
    const list = byKey.get(k);
    if (list) list.push(r);
    else byKey.set(k, [r]);
  }
  const out: CellSummary[] = [];
  for (const [key, list] of byKey) {
    const first = list[0];
    const s: CellSummary = {
      key,
      domain: first.domain,
      entry: first.entry,
      grade: first.grade,
      noise: noiseName(first.pSlip, first.pGuessMc),
      runs: list.length,
      probes: mean(list.map((r) => r.probes)),
      idkBurden: mean(list.map((r) => r.idkBurden)),
      overshootMaxGrades: mean(list.map((r) => r.overshootMaxGrades)),
      overshootMeanGrades: mean(list.map((r) => r.overshootMeanGrades)),
      oscillationGlobal: mean(list.map((r) => r.oscillationGlobal)),
      oscillationPerStrandMean: mean(list.map((r) => r.oscillationPerStrandMean)),
      overCredit: mean(list.map((r) => r.overCredit)),
      underCredit: mean(list.map((r) => r.underCredit)),
      overCreditFrac: mean(
        list.map((r) => r.overCredit / Math.max(1, r.domainNodeCount - r.trueKnown)),
      ),
      underCreditFrac: mean(list.map((r) => r.underCredit / Math.max(1, r.trueKnown))),
      gradeErrorMean: mean(list.map((r) => r.gradeError)),
      gradeErrorAbsMean: mean(list.map((r) => Math.abs(r.gradeError))),
      trueKnown: mean(list.map((r) => r.trueKnown)),
      credited: mean(list.map((r) => r.credited)),
      capHitRate: mean(list.map((r) => (r.capHit ? 1 : 0))),
      badness: 0,
    };
    s.badness = badness(s);
    out.push(s);
  }
  return out;
}

/**
 * Composite calibration BADNESS of a cell (higher = worse). A weighted sum of the
 * affect + accuracy costs a real scholar pays. Credit error is normalized to a
 * FRACTION of the relevant node pool so a big domain doesn't mechanically
 * dominate a small one. Documented in the report so the ranking is legible; this
 * is a measurement lens, not a tuned objective.
 */
export function badness(s: CellSummary): number {
  return (
    s.idkBurden * 1.0 +
    s.overshootMaxGrades * 1.5 +
    s.oscillationGlobal * 0.5 +
    s.overCreditFrac * 10.0 +
    s.underCreditFrac * 10.0 +
    s.gradeErrorAbsMean * 1.0 +
    s.capHitRate * 5.0
  );
}

// ── Knob attribution (analysis only) ───────────────────────────────────────

export type Knob = "start-prior" | "step-size" | "convergence-rule";

export type KnobVerdict = { knob: Knob; reason: string; weight: number };

/**
 * Which placement knob(s) a bad cell implicates — DIAGNOSIS ONLY, no code change.
 * Thresholds are heuristics for pointing a human at the right constant, not tuning.
 *
 *   • start-prior       — the affect-safe first-probe target (`affectSafeFirstProbeIndex`
 *                         / `firstProbeTargets`) + the grade ring. Implicated when the
 *                         search OPENS well above the true frontier (high overshoot) and
 *                         the kid eats IDKs before the search finds their level.
 *   • step-size         — the binary-search midpoint stride and cross-strand round-robin.
 *                         Implicated by high felt oscillation (served difficulty bounces
 *                         up and down).
 *   • convergence-rule  — the per-strand / global probe caps, the trust-upward
 *                         monotonicity assumption, and the lo≥hiNoRing stop. Implicated
 *                         by frontier error (over/under-credit), a cap-limited finish, or
 *                         probe counts out of proportion to the strand count.
 */
export function implicatedKnobs(s: CellSummary): KnobVerdict[] {
  const verdicts: KnobVerdict[] = [];

  // START PRIOR — opens above the kid.
  if (s.overshootMaxGrades >= 1.5) {
    verdicts.push({
      knob: "start-prior",
      reason: `first probe opens ~${s.overshootMaxGrades.toFixed(1)} grades above the true frontier${
        s.entry === "you-pick" ? " (You-Pick entry carries no grade prior)" : ""
      }`,
      weight: s.overshootMaxGrades * 1.5,
    });
  } else if (s.idkBurden >= 4 && s.probes > 0 && s.idkBurden / s.probes >= 0.5) {
    verdicts.push({
      knob: "start-prior",
      reason: `${s.idkBurden.toFixed(1)} of ${s.probes.toFixed(
        1,
      )} probes are honest IDKs — the search samples above the kid before finding their level`,
      weight: s.idkBurden,
    });
  }

  // STEP SIZE — felt oscillation.
  if (s.oscillationGlobal >= Math.max(3, s.probes * 0.4)) {
    verdicts.push({
      knob: "step-size",
      reason: `served difficulty changes direction ${s.oscillationGlobal.toFixed(
        1,
      )}× over ${s.probes.toFixed(1)} probes (round-robin + midpoint stride)`,
      weight: s.oscillationGlobal * 0.5,
    });
  }

  // CONVERGENCE RULE — frontier error, caps, probe bloat.
  if (s.capHitRate > 0) {
    verdicts.push({
      knob: "convergence-rule",
      reason: `hits the global probe cap ${(s.capHitRate * 100).toFixed(0)}% of runs`,
      weight: s.capHitRate * 5,
    });
  }
  if (s.overCredit >= 1) {
    verdicts.push({
      knob: "convergence-rule",
      reason: `over-credits ${s.overCredit.toFixed(
        1,
      )} node(s) the kid does not know (trust-upward across non-grade-monotone topo order${
        s.noise.startsWith("guess") ? " + lucky MC guesses raise the floor" : ""
      })`,
      weight: s.overCredit * 2,
    });
  }
  if (s.underCredit >= 1) {
    verdicts.push({
      knob: "convergence-rule",
      reason: `under-credits ${s.underCredit.toFixed(
        1,
      )} known node(s) — search stops below the true frontier`,
      weight: s.underCredit * 2,
    });
  }
  // A large grade-LABEL error with only small node-level credit error points at
  // the placed-through-grade DERIVATION (`derivePlacedThroughGrade`), not the
  // frontier search itself — the kid is TOLD a grade that understates the credit.
  if (s.gradeErrorAbsMean >= 1.5 && s.overCredit < 1 && s.underCredit < 2) {
    verdicts.push({
      knob: "convergence-rule",
      reason: `single-grade label off by ${s.gradeErrorMean.toFixed(
        1,
      )} while node-level credit is near-exact — the "You're starting at Grade X" derivation, not the search`,
      weight: s.gradeErrorAbsMean,
    });
  }

  verdicts.sort((a, b) => b.weight - a.weight);
  return verdicts;
}
