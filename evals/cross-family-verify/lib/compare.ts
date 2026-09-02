/**
 * Pure comparison logic for cross-family verification (adoptable #4, Finding 2).
 *
 * Given the SAME cast's transcripts judged twice — once by the Anthropic judge
 * that the curriculum-sim loop already ran, and once by a GPT-family judge — this
 * measures how much the two model families AGREE, per curriculum dimension. No
 * I/O and no model calls here (that's openaiJudge.ts), so the decision logic is
 * unit-testable without a key.
 *
 * We reuse the curriculum judge's own `aggregate` + dimension groupings from
 * evals/curriculum-sim/lib/score.ts, so the per-dimension means are computed the
 * exact same way for both families and the Δ is apples-to-apples.
 */
import {
  aggregate,
  type SessionVerdict,
} from "../../curriculum-sim/lib/score";
import {
  DIMENSION_METADATA,
  type CurriculumDimension,
  type CurriculumDimensionGroup,
} from "../../../convex/lib/curriculumDimensions";

/** Every scored 1–5 dimension, in the curriculum judge's canonical order. */
export const NUMERIC_DIMS = DIMENSION_METADATA.map((dimension) => dimension.key);
export type NumericDim = CurriculumDimension;

/**
 * A material disagreement is a mean gap of MORE THAN a full point on the 1–5
 * scale (|Δ| > 1). Below that, two judges scoring e.g. 3.8 vs 4.2 are effectively
 * agreeing; the literature (Finding 3) warns absolute 1–5 scores are noisy at
 * finer grain, so we don't cry wolf on sub-point deltas.
 */
export const MATERIAL_DELTA = 1;

export type DimGroup = CurriculumDimensionGroup;

export function dimGroup(dim: NumericDim): DimGroup {
  return DIMENSION_METADATA.find((dimension) => dimension.key === dim)!.group;
}

export interface DimComparison {
  dim: NumericDim;
  group: DimGroup;
  /** Mean Anthropic (curriculum judge) score across the cast. */
  anthropic: number;
  /** Mean GPT-family score across the same cast. */
  openai: number;
  /** openai - anthropic (positive = GPT scored it higher). */
  delta: number;
  absDelta: number;
  /** |Δ| > MATERIAL_DELTA — the two families disagree by more than a full point. */
  material: boolean;
}

export interface AgreementReport {
  activityTitle: string;
  /** Sessions compared (both judges scored the same n). */
  n: number;
  anthropicJudge: string;
  openaiJudge: string;
  /** True when the GPT verdicts were stubbed (--dry-run, no API call). */
  dryRun: boolean;
  dims: DimComparison[];
  /** Fitness = mean of the maximized curriculum-fit dims (what promotion leans on). */
  fitness: { anthropic: number; openai: number; delta: number };
  /** Headline scalar: mean |Δ| across all numeric dims. Lower = more agreement. */
  meanAbsDelta: number;
  /** The dims (if any) where the families disagree materially, worst first. */
  materialDisagreements: DimComparison[];
  /** No material per-dimension disagreement anywhere. */
  agree: boolean;
  /** The two families agree on the promotion-relevant fitness scalar. */
  fitnessAgree: boolean;
  /** Plain-language call for the teacher, keyed off the disagreement pattern. */
  recommendation: string;
}

function round(n: number): number {
  return Math.round(n * 1000) / 1000;
}

/**
 * Compare the Anthropic curriculum judge against a second-family (GPT) re-judge of
 * the SAME sessions. `anthropicVerdicts[i]` and `openaiVerdicts[i]` must describe
 * the same session i.
 */
export function compareJudges(args: {
  activityTitle: string;
  anthropicVerdicts: SessionVerdict[];
  openaiVerdicts: SessionVerdict[];
  anthropicJudge: string;
  openaiJudge: string;
  dryRun: boolean;
}): AgreementReport {
  const { anthropicVerdicts, openaiVerdicts } = args;
  if (anthropicVerdicts.length === 0) {
    throw new Error("compareJudges: no Anthropic verdicts to compare against");
  }
  if (anthropicVerdicts.length !== openaiVerdicts.length) {
    throw new Error(
      `compareJudges: verdict counts differ (anthropic ${anthropicVerdicts.length} vs openai ${openaiVerdicts.length})`,
    );
  }

  const aAgg = aggregate(anthropicVerdicts);
  const oAgg = aggregate(openaiVerdicts);

  const dims: DimComparison[] = NUMERIC_DIMS.map((dim) => {
    const anthropic = round(aAgg.dims[dim]);
    const openai = round(oAgg.dims[dim]);
    const delta = round(openai - anthropic);
    const absDelta = round(Math.abs(delta));
    return {
      dim,
      group: dimGroup(dim),
      anthropic,
      openai,
      delta,
      absDelta,
      material: absDelta > MATERIAL_DELTA,
    };
  });

  const meanAbsDelta = round(
    dims.reduce((sum, d) => sum + d.absDelta, 0) / dims.length,
  );

  const materialDisagreements = dims
    .filter((d) => d.material)
    .sort((a, b) => b.absDelta - a.absDelta);

  const fitnessDelta = round(oAgg.fitness - aAgg.fitness);
  const fitness = {
    anthropic: round(aAgg.fitness),
    openai: round(oAgg.fitness),
    delta: fitnessDelta,
  };
  const fitnessAgree = Math.abs(fitnessDelta) <= MATERIAL_DELTA;
  const agree = materialDisagreements.length === 0;

  return {
    activityTitle: args.activityTitle,
    n: anthropicVerdicts.length,
    anthropicJudge: args.anthropicJudge,
    openaiJudge: args.openaiJudge,
    dryRun: args.dryRun,
    dims,
    fitness,
    meanAbsDelta,
    materialDisagreements,
    agree,
    fitnessAgree,
    recommendation: recommend({
      agree,
      fitnessAgree,
      fitnessDelta,
      materialDisagreements,
    }),
  };
}

/**
 * The promotion-relevant call. This script runs on a variant the Anthropic loop
 * already picked as a WINNER, so the question is only "does a second model family
 * confirm before the teacher promotes?". Fitness + protected disagreements are the
 * load-bearing ones (they drive/gate promotion); a gifted-only gap is a softer flag.
 */
function recommend(args: {
  agree: boolean;
  fitnessAgree: boolean;
  fitnessDelta: number;
  materialDisagreements: DimComparison[];
}): string {
  const { agree, fitnessAgree, fitnessDelta, materialDisagreements } = args;
  if (agree && fitnessAgree) {
    return "✅ Second family CONFIRMS — GPT judge agrees within a point on every dimension. Safe to surface 'promote'.";
  }
  const loadBearing = materialDisagreements.filter(
    (d) => d.group === "fitness" || d.group === "protected",
  );
  const dir = fitnessDelta < 0 ? "LOWER" : "higher";
  if (!fitnessAgree || loadBearing.length > 0) {
    const dimList = loadBearing.length
      ? loadBearing.map((d) => `${d.dim} (Δ${d.delta >= 0 ? "+" : ""}${d.delta})`).join(", ")
      : `fitness (Δ${fitnessDelta >= 0 ? "+" : ""}${fitnessDelta})`;
    return `⚠️ Second family DOES NOT confirm — GPT scores the winner ${dir} on load-bearing dims: ${dimList}. Hold for teacher review before promoting (Finding 2: don't let a same-family judge rubber-stamp a same-family improver).`;
  }
  const diagnostic = materialDisagreements
    .map((d) => `${d.dim} (Δ${d.delta >= 0 ? "+" : ""}${d.delta})`)
    .join(", ");
  const lens = materialDisagreements.every((d) => d.group === "design")
    ? "diagnosis-only design lens"
    : materialDisagreements.every((d) => d.group === "gifted")
      ? "gifted lens"
      : "gifted/design diagnostic lenses";
  return `⚠️ Families agree on fitness + protected dims, but diverge on the ${lens}: ${diagnostic}. Promotion signal holds; note the diagnostic disagreement for the teacher.`;
}
