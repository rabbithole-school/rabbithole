/**
 * Types for the CZI cross-check lens — an independent, external second opinion
 * on tutor turns, distinct in provenance from our own Opus judge.
 *
 * The lens consumes the SAME conversation shape as the tutor-quality harness
 * (`TutorCase` / `Turn`), so a transcript pulled for one can be fed to the
 * other. See ./rubrics.ts for how vendored Learning Commons rubrics become
 * forced-tool schemas, and ./cziLens.ts for scoring.
 */
import type { TutorCase, Turn } from "../../tutor-quality/lib/types";

export type { TutorCase, Turn };

/** The two vendored coaching dimensions we run as answer-dump detectors. */
export type CoachingDim = "manageable" | "acknowledges-strength";

/** CZI grade bands (K-1 .. 11-CCR). */
export type GradeBand = "K-1" | "2-3" | "4-5" | "6-8" | "9-10" | "11-CCR";

/** One coaching-dimension verdict for one (student → tutor) turn pair. */
export interface CoachingVerdict {
  dim: CoachingDim;
  /** CZI's binary criterion score: 1 = meets the criterion, 0 = does not. */
  score: 0 | 1;
  /**
   * The concern flag. CZI scores 0 when the criterion is NOT met. For
   * `manageable` that means the feedback was too long / too dense / too many
   * suggestions — i.e. an answer-dump / cognitive-offloading risk. For
   * `acknowledges-strength` it means the tutor named no genuine strength.
   * `concern === (score === 0)`.
   */
  concern: boolean;
  reasoning: string;
  proposedAdjustment: string;
  /** Per-key-feature 0/1 assessments, verbatim from the rubric output. */
  keyFeatures: Record<string, { met: 0 | 1; justification: string }>;
}

/** Grade-level-appropriateness result for one tutor turn's language. */
export interface GradeLevelVerdict {
  grade: GradeBand;
  alternativeGrade: GradeBand;
  scaffoldingNeeded: string;
  reasoning: string;
}

/**
 * Calibration signal: how the tutor's language band compares to the scholar's
 * stated independent reading level. Positive drift = pitched above the reading
 * level. For gifted learners some positive drift is intentional (we teach above
 * grade level), so this is REPORTED, and only flagged past a threshold — the
 * load-bearing case is a LOW-reading-level scholar being pitched too high.
 */
export interface GradeDrift {
  band: GradeBand;
  /** Lowest grade in the band (conservative floor). */
  bandFloor: number;
  /** Parsed scholar reading level, or null if unknown / unparseable. */
  readingGrade: number | null;
  /** bandFloor − readingGrade, or null when readingGrade is null. */
  drift: number | null;
  /** drift !== null && drift >= threshold. */
  pitchedAboveReadingLevel: boolean;
}

/** One tutor turn evaluated by the CZI lens. */
export interface TurnEvaluation {
  turnIndex: number;
  studentText: string;
  feedbackText: string;
  coaching: CoachingVerdict[];
  gradeLevel: GradeLevelVerdict | null;
  drift: GradeDrift | null;
}

/** Full CZI cross-check for one conversation. */
export interface CziCaseResult {
  caseId: string;
  description: string;
  scholarReadingLevel: string | null;
  /** Provenance of the judge that produced these scores (model / engine). */
  judge: string;
  turns: TurnEvaluation[];
}
