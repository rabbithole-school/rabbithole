/**
 * The ship decision + report for the baked-vs-ad-lib comparison.
 *
 * Reuses evals/curriculum-sim's pure scoring: `aggregate` (mean per dimension)
 * and `isBetter` (baked must beat ad-lib FITNESS by more than the noise floor
 * AND not regress any protected/gifted dim). That `isBetter` IS the quality
 * ship-gate. The latency it can't see — the bake's wall-clock cost — is reported
 * alongside so a human makes the final "worth it net of latency" call.
 */
import {
  aggregate,
  isBetter,
  type Aggregate,
  type BetterResult,
  type SessionVerdict,
  DESIGN_DIMS,
  FITNESS_DIMS,
  GIFTED_DIMS,
  PROTECTED_DIMS,
} from "../../curriculum-sim/lib/score";

export type ArmName = "adLib" | "baked";

export interface Decision {
  adLib: Aggregate;
  baked: Aggregate;
  /** Quality verdict: is the baked arm a keepable win over ad-lib? */
  result: BetterResult;
  /** Per-dimension (baked − adLib). */
  deltas: Record<string, number>;
}

const ALL_DIMS = [
  ...FITNESS_DIMS,
  ...GIFTED_DIMS,
  ...PROTECTED_DIMS,
  ...DESIGN_DIMS,
] as const;

/** Pure: aggregate both arms and run the ship-gate. No I/O. */
export function decide(
  adLibVerdicts: SessionVerdict[],
  bakedVerdicts: SessionVerdict[],
): Decision {
  const adLib = aggregate(adLibVerdicts);
  const baked = aggregate(bakedVerdicts);
  const deltas: Record<string, number> = {};
  for (const d of ALL_DIMS) deltas[d] = +(baked.dims[d] - adLib.dims[d]).toFixed(2);
  return { adLib, baked, result: isBetter(baked, adLib), deltas };
}

export interface LatencyStats {
  /** Per-topic bake wall-clock, ms. */
  perTopicMs: number[];
}

function fmtMs(ms: number): string {
  return `${(ms / 1000).toFixed(0)}s`;
}

function meanMs(xs: number[]): number {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
}

/** Render the full markdown report. */
export function renderReport(
  decision: Decision,
  latency: LatencyStats,
  meta: {
    topics: number;
    scholarsPerTopic: number;
    offline: boolean;
    adLibCapRate?: number;
    bakedCapRate?: number;
  },
): string {
  const { adLib, baked, result, deltas } = decision;
  const barMean = (aggregate: Aggregate) =>
    DESIGN_DIMS.reduce((sum, dim) => sum + aggregate.dims[dim], 0) /
    DESIGN_DIMS.length;
  const row = (label: string, dims: readonly string[]) =>
    dims
      .map((d) => {
        const delta = deltas[d];
        const sign = delta > 0 ? "+" : "";
        return `| ${d} | ${adLib.dims[d as keyof typeof adLib.dims].toFixed(2)} | ${baked.dims[d as keyof typeof baked.dims].toFixed(2)} | ${sign}${delta.toFixed(2)} |`;
      })
      .join("\n");

  const ms = latency.perTopicMs;
  const verdict = result.better
    ? "✅ BAKED WINS on quality"
    : "❌ BAKED does NOT clear the quality gate";

  return [
    `# Seed→unit bake — baked vs ad-lib`,
    ``,
    meta.offline ? `> ⚠️ OFFLINE run (stubbed models + stubbed bake) — wiring only, NOT a quality signal.` : ``,
    ``,
    `Topics: ${meta.topics} · synthetic scholars/topic: ${meta.scholarsPerTopic} · sessions/arm: ${decision.baked.n}`,
    ``,
    `## Quality verdict — ${verdict}`,
    ``,
    `- ad-lib fitness: **${adLib.fitness.toFixed(2)}**  ·  baked fitness: **${baked.fitness.toFixed(2)}**  ·  gain: **${result.fitnessGain >= 0 ? "+" : ""}${result.fitnessGain.toFixed(2)}**`,
    `- goal-attainment rate: ad-lib ${(adLib.goalAttainmentRate * 100).toFixed(0)}% → baked ${(baked.goalAttainmentRate * 100).toFixed(0)}%`,
    `- gate: ${result.reason}`,
    result.gate.violations.length
      ? `- gate violations: ${result.gate.violations.map((v) => `${v.dim} (${v.candidate.toFixed(2)} vs ${v.baseline.toFixed(2)}; ${v.reason})`).join("; ")}`
      : `- gate violations: none`,
    ``,
    `### Curriculum-fit (maximized)`,
    `| dim | ad-lib | baked | Δ |`,
    `| --- | --- | --- | --- |`,
    row("fit", FITNESS_DIMS),
    ``,
    `### Gifted lens (guarded)`,
    `| dim | ad-lib | baked | Δ |`,
    `| --- | --- | --- | --- |`,
    row("gifted", GIFTED_DIMS),
    ``,
    `### Protected tutor dims (gated)`,
    `| dim | ad-lib | baked | Δ |`,
    `| --- | --- | --- | --- |`,
    row("protected", PROTECTED_DIMS),
    ``,
    `### Investigation bar (design)`,
    `Measured, not gating · bar mean: ad-lib **${barMean(adLib).toFixed(2)}** → baked **${barMean(baked).toFixed(2)}**`,
    `| dim | ad-lib | baked | Δ |`,
    `| --- | --- | --- | --- |`,
    row("design", DESIGN_DIMS),
    ``,
    `## Latency cost (what the in-place upgrade hides)`,
    `- bake wall-clock: mean **${fmtMs(meanMs(ms))}**, range ${ms.length ? `${fmtMs(Math.min(...ms))}–${fmtMs(Math.max(...ms))}` : "n/a"} across ${ms.length} topic(s)`,
    meta.adLibCapRate !== undefined && meta.bakedCapRate !== undefined
      ? `- hit the turn cap: ad-lib ${Math.round(meta.adLibCapRate * 100)}% · baked ${Math.round(meta.bakedCapRate * 100)}% (high = sessions cut off mid-thread; raise --max-turns for a fairer read)`
      : ``,
    ``,
    `## Ship call`,
    result.better
      ? `Baked beats ad-lib on quality (${result.reason}). SHIP only if a mean bake of ~${fmtMs(meanMs(ms))} is acceptable given it runs in the background (the scholar is already in the ad-lib session). If the gain is marginal vs the latency, hold.`
      : `Do NOT ship: baked did not clear the quality gate (${result.reason}). The latency cost isn't justified.`,
    ``,
  ]
    .filter((l) => l !== "")
    .join("\n");
}
