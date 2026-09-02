/**
 * Predict-then-Check — the PURE calibration (judgment-of-learning) core.
 *
 * The kid optionally predicts, BEFORE checking, how confident they are that
 * their answer is right; we compare that prediction to the actual outcome. Short
 * predict → feedback → reflect loops measurably improve metacognitive calibration
 * (gifted learners run BOTH ways: fluency-driven overconfidence AND perfectionist
 * under-confidence). This module is the dependency-free math + copy behind that
 * mechanic — no `ctx`, no Convex, no framework — so it unit-tests as plain
 * functions and vendors standalone into the native app.
 *
 * A wrong prediction (like a wrong answer) is DATA, never shame: reveals are
 * gentle and shown only on a mismatch; the kid never sees a running score. Full
 * calibration analysis is teacher-facing (see convex/practiceCalibration.ts).
 */

/** The three pre-answer picks the kid can tap (most → least confident). */
export type ConfidenceLevel = "sure" | "think_so" | "not_sure";

/**
 * Each pick → the probability-of-correct it stands for. Kept coarse on purpose:
 * three taps, not a slider — low friction, and enough signal for a bias read.
 */
export const CONFIDENCE_VALUES: Record<ConfidenceLevel, number> = {
  sure: 0.9,
  think_so: 0.65,
  not_sure: 0.35,
};

/** Ordered for the chip row, with the kid-facing label. */
export const CONFIDENCE_LEVELS: {
  level: ConfidenceLevel;
  value: number;
  label: string;
}[] = [
  { level: "sure", value: CONFIDENCE_VALUES.sure, label: "Sure" },
  { level: "think_so", value: CONFIDENCE_VALUES.think_so, label: "I think so" },
  { level: "not_sure", value: CONFIDENCE_VALUES.not_sure, label: "Not sure" },
];

export function confidenceValue(level: ConfidenceLevel): number {
  return CONFIDENCE_VALUES[level];
}

export type CalibrationBand =
  | "well_calibrated"
  | "overconfident"
  | "underconfident"
  | "insufficient_data";

/** Below this many scored predictions we refuse to name a direction. */
export const CALIBRATION_MIN_N = 8;

/** Signed-bias magnitude beyond which calibration tips out of "well_calibrated". */
export const CALIBRATION_BIAS_THRESHOLD = 0.18;

export type CalibrationSummary = {
  /** Number of scored predictions in the window. */
  n: number;
  /** Mean |confidence − outcome| — overall resolution (0 = perfect). */
  meanAbsGap: number;
  /** Mean SIGNED gap: positive ⇒ overconfident, negative ⇒ underconfident. */
  bias: number;
  /** Coarse band; `insufficient_data` until n ≥ CALIBRATION_MIN_N. */
  band: CalibrationBand;
};

/**
 * Fold predict↔outcome pairs into a calibration reading. `gap = confidence −
 * (correct ? 1 : 0)`, so a "sure" (0.9) miss contributes +0.9 to the signed sum
 * (overconfident) and a "not_sure" (0.35) hit contributes −0.65 (underconfident).
 * Empty input is `insufficient_data` with zeroed stats.
 */
export function summarizeCalibration(
  pairs: { confidence: number; correct: boolean }[],
): CalibrationSummary {
  const n = pairs.length;
  if (n === 0) return { n: 0, meanAbsGap: 0, bias: 0, band: "insufficient_data" };

  let sumAbs = 0;
  let sumSigned = 0;
  for (const p of pairs) {
    const gap = p.confidence - (p.correct ? 1 : 0);
    sumAbs += Math.abs(gap);
    sumSigned += gap;
  }
  const meanAbsGap = sumAbs / n;
  const bias = sumSigned / n;
  return { n, meanAbsGap, bias, band: classifyBand(n, bias) };
}

function classifyBand(n: number, bias: number): CalibrationBand {
  if (n < CALIBRATION_MIN_N) return "insufficient_data";
  if (bias > CALIBRATION_BIAS_THRESHOLD) return "overconfident";
  if (bias < -CALIBRATION_BIAS_THRESHOLD) return "underconfident";
  return "well_calibrated";
}

/**
 * The gentle, per-item kid reveal — returned ONLY when the prediction and the
 * outcome DISAGREE (leaned confident but wrong, or wasn't sure but right). On
 * agreement (sure + right, not-sure + wrong) it returns null → no reveal, no
 * noise. Copy is warm and never shaming: a mismatch is information, not a verdict
 * on the kid. `confidence > 0.5` is "leaned confident" (sure / think_so vs not_sure).
 *
 * The confident-but-wrong copy matches the child's ACTUAL pick: a "Sure" miss
 * says "You felt sure", but an "I think so" miss says "You thought you had this
 * one" — so we never report a stronger confidence back than the kid stated. (From
 * a usability finding: it previously said "felt sure" to an "I think so" pick.)
 */
export function mismatchReveal(confidence: number, correct: boolean): string | null {
  const leanedConfident = confidence > 0.5;
  if (correct && !leanedConfident) return "You weren't sure — but you had it. 👍";
  if (!correct && leanedConfident) {
    return confidence >= CONFIDENCE_VALUES.sure
      ? "You felt sure on this one — worth another look."
      : "You thought you had this one — worth another look.";
  }
  return null;
}

/**
 * The soft, NON-numeric line a well-calibrated kid may see once there's enough
 * signal (band === "well_calibrated", which already requires n ≥ CALIBRATION_MIN_N).
 * Names the meta-skill ("knowing what you know"), never a score.
 */
export const WELL_CALIBRATED_LINE = "You're getting to know what you know. 🎯";

/**
 * Per-confidence-level correct/total counts — the raw material for the kid's
 * OWN calibration mirror ("Getting to know what you know", convex/practiceCalibration.ts
 * → calibrationForSelf). This is a parallel VIEW of the exact same `pairs` that
 * feed summarizeCalibration (same confidence→value mapping, same input), not a
 * fork of its math — the two walk the identical rows once each. Always returns
 * all three levels in chip order, zero-filled where no data landed.
 */
export type ConfidenceLevelBreakdown = {
  level: ConfidenceLevel;
  label: string;
  correct: number;
  total: number;
};

export function summarizeByConfidenceLevel(
  pairs: { confidence: number; correct: boolean }[],
): ConfidenceLevelBreakdown[] {
  return CONFIDENCE_LEVELS.map(({ level, value, label }) => {
    const atLevel = pairs.filter((p) => p.confidence === value);
    return {
      level,
      label,
      correct: atLevel.filter((p) => p.correct).length,
      total: atLevel.length,
    };
  });
}

/**
 * The kid-facing growth line for a calibration band — a sentence KEY, never a
 * numeric score. `insufficient_data` maps to null: the mirror never nags a kid
 * with too little data to collect more, it just doesn't render (the read query
 * gates on this — see calibrationForSelf).
 */
const DIRECTIONAL_GROWTH_LINE: Record<
  Exclude<CalibrationBand, "insufficient_data">,
  string
> = {
  well_calibrated: WELL_CALIBRATED_LINE,
  overconfident: "Trying \"I think so\" before \"Sure\" could sharpen this even more. 🔍",
  underconfident: "You know more than you're giving yourself credit for. 🌱",
};

export function growthLineForBand(band: CalibrationBand): string | null {
  if (band === "insufficient_data") return null;
  return DIRECTIONAL_GROWTH_LINE[band];
}

/**
 * The calibration mirror's headline: names the confidence level with the MOST
 * data (the strongest, most legible signal) and how often it landed right —
 * the one concrete number the mirror shows, framed as a fact about a specific
 * pick rather than an aggregate score. Ties keep the first (most-confident)
 * level, matching CONFIDENCE_LEVELS' order. Null only when every level is
 * empty (unreachable once a caller has gated on enough total data, but keeps
 * this pure fn total for n = 0).
 */
export function strongestSignalHeadline(
  byLevel: ConfidenceLevelBreakdown[],
): string | null {
  const withData = byLevel.filter((l) => l.total > 0);
  if (withData.length === 0) return null;
  const strongest = withData.reduce((a, b) => (b.total > a.total ? b : a));
  return `When you said "${strongest.label}", you were right ${strongest.correct} out of ${strongest.total}.`;
}
