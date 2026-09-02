/**
 * Agreement scorer for the rating-calibration harness — NOT an LLM judge.
 * Deterministically compares the AI rating-suggester's 1–7 PCM ratings
 * against a teacher's hand-assigned "gold" rating for the same evidence
 * binder, using the SAME rubric bands the app rates against
 * (convex/lib/pcm.ts → RUBRIC_BANDS / bandForRating), so "agreement" here
 * means the same thing it'll mean when a teacher reads the calibration view
 * (review/assessment-and-goals-plan.html §11). Named `judge.ts` to mirror
 * evals/observer/lib/judge.ts's role in the harness (the module that scores
 * a run against a rubric) — not because it makes a model call.
 */
import { PCM_DIMENSIONS, bandForRating, type PcmDimension, type RubricBand } from "../../../convex/lib/pcm";

const BAND_ORDER: RubricBand["band"][] = ["Emerging", "Developing", "Proficient", "Exemplary"];

export interface DimensionAgreement {
  dimension: PcmDimension;
  gold: number;
  /** null when the AI omitted a rating for this dimension. */
  ai: number | null;
  absError: number | null;
  goldBand: RubricBand["band"] | null;
  aiBand: RubricBand["band"] | null;
  /** null when the AI omitted a rating. */
  withinOneBand: boolean | null;
  exactBand: boolean | null;
}

/** Per-dimension agreement between one fixture's gold ratings and the AI's suggestion. */
export function scoreFixture(
  gold: Record<PcmDimension, number>,
  ai: Partial<Record<PcmDimension, number>>,
): DimensionAgreement[] {
  return PCM_DIMENSIONS.map((dimension) => {
    const g = gold[dimension];
    const a = ai[dimension];
    const goldBand = bandForRating(g)?.band ?? null;
    if (a === undefined || a === null) {
      return {
        dimension,
        gold: g,
        ai: null,
        absError: null,
        goldBand,
        aiBand: null,
        withinOneBand: null,
        exactBand: null,
      };
    }
    const aiBand = bandForRating(a)?.band ?? null;
    const bandDiff =
      goldBand && aiBand ? Math.abs(BAND_ORDER.indexOf(goldBand) - BAND_ORDER.indexOf(aiBand)) : null;
    return {
      dimension,
      gold: g,
      ai: a,
      absError: Math.abs(a - g),
      goldBand,
      aiBand,
      withinOneBand: bandDiff === null ? null : bandDiff <= 1,
      exactBand: bandDiff === null ? null : bandDiff === 0,
    };
  });
}

export interface AgreementSummary {
  /** dimensions where the AI actually produced a rating */
  n: number;
  /** dimensions where the AI omitted a rating */
  omitted: number;
  mae: number;
  withinOneBandRate: number;
  exactBandRate: number;
}

/** Aggregate mean absolute error + within-1-band / exact-band hit rates over a set of rows. */
export function summarize(rows: DimensionAgreement[]): AgreementSummary {
  const scored = rows.filter((r): r is DimensionAgreement & { ai: number; absError: number } => r.ai !== null);
  const omitted = rows.length - scored.length;
  const mae = scored.length ? scored.reduce((s, r) => s + r.absError, 0) / scored.length : NaN;
  const withinOneBandRate = scored.length ? scored.filter((r) => r.withinOneBand).length / scored.length : NaN;
  const exactBandRate = scored.length ? scored.filter((r) => r.exactBand).length / scored.length : NaN;
  return { n: scored.length, omitted, mae, withinOneBandRate, exactBandRate };
}
