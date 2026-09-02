/**
 * The CZI cross-check lens: run vendored Learning Commons rubrics over tutor
 * turns as an EXTERNAL, learning-science second opinion, telemetry-free on our
 * own models via the tutor-quality judge seam.
 *
 * Split into PURE helpers (scoring, grade-band math, turn pairing — unit-tested
 * offline in __tests__/lens.test.ts, no API) and LIVE runners (the ones that
 * actually call the judge, exercised by run.ts).
 *
 * Two lenses:
 *   1. Coaching answer-dump detector — `manageable` + `acknowledges-strength`.
 *      `manageable === 0` is the cognitive-offloading / answer-dump signal.
 *   2. Grade-level calibration gauge — measures the tutor turn's language band
 *      and compares it to the scholar's reading level (drift). Gifted learners
 *      work above grade level, so drift is REPORTED; only large positive drift
 *      for a low-reading-level scholar is a flag.
 */
import { runStructuredJudge } from "../../tutor-quality/lib/judgeEngine";
import type {
  CoachingDim,
  CoachingVerdict,
  GradeBand,
  GradeDrift,
  GradeLevelVerdict,
  TutorCase,
} from "./types";
import {
  RUBRIC_SCORE_KEY,
  assembleUserText,
  buildRubricTool,
  loadRubricBundle,
} from "./rubrics";

/** Turns whose content is the synthetic conversation opener, not real text. */
const SYNTHETIC_OPENERS = new Set(["<start>", "<begin>", ""]);

// ── PURE: turn pairing ───────────────────────────────────────────────────────

export interface TurnPair {
  turnIndex: number;
  studentText: string;
  feedbackText: string;
}

/**
 * Pair each assistant (tutor) turn with the student text it responds to (the
 * nearest preceding user turn, minus synthetic openers). These are the
 * (student_text, feedback_text) pairs the coaching rubrics score.
 */
export function pairTurns(caseData: TutorCase): TurnPair[] {
  const pairs: TurnPair[] = [];
  const { turns } = caseData;
  for (let i = 0; i < turns.length; i++) {
    if (turns[i].role !== "assistant") continue;
    const feedbackText = turns[i].content.trim();
    if (!feedbackText) continue;
    let studentText = "";
    for (let j = i - 1; j >= 0; j--) {
      if (turns[j].role === "user") {
        const c = turns[j].content.trim();
        if (!SYNTHETIC_OPENERS.has(c)) studentText = c;
        break;
      }
    }
    pairs.push({ turnIndex: i, studentText, feedbackText });
  }
  return pairs;
}

// ── PURE: coaching verdict parsing ───────────────────────────────────────────

function coerceBinary(v: unknown, ctx: string): 0 | 1 {
  if (v === 0 || v === 1) return v;
  if (v === "0") return 0;
  if (v === "1") return 1;
  throw new Error(`${ctx}: expected a 0/1 score, got ${JSON.stringify(v)}`);
}

/**
 * Normalise a raw rubric tool result into a `CoachingVerdict`. Pulls the
 * dimension's overall score (`<dim>_score`), the reasoning + proposed
 * adjustment, and the per-key-feature 0/1 map. `concern` is `score === 0`.
 */
export function scoreCoachingVerdict(
  dim: CoachingDim,
  raw: Record<string, unknown>,
): CoachingVerdict {
  const scoreKey = RUBRIC_SCORE_KEY[dim];
  const score = coerceBinary(raw[scoreKey], `${dim}.${scoreKey}`);
  const keyFeaturesRaw = (raw.key_features ?? {}) as Record<string, unknown>;
  const keyFeatures: CoachingVerdict["keyFeatures"] = {};
  for (const [k, vRaw] of Object.entries(keyFeaturesRaw)) {
    if (typeof vRaw !== "object" || vRaw === null) continue;
    const v = vRaw as Record<string, unknown>;
    keyFeatures[k] = {
      met: coerceBinary(v.met, `${dim}.key_features.${k}.met`),
      justification: typeof v.justification === "string" ? v.justification : "",
    };
  }
  return {
    dim,
    score,
    concern: score === 0,
    reasoning: typeof raw.reasoning === "string" ? raw.reasoning : "",
    proposedAdjustment:
      typeof raw.proposed_adjustment === "string" ? raw.proposed_adjustment : "",
    keyFeatures,
  };
}

// ── PURE: grade-band math + calibration ──────────────────────────────────────

/** Inclusive numeric grade range for each band (11-CCR ≈ 11–13). */
export const GRADE_BAND_RANGE: Record<GradeBand, [number, number]> = {
  "K-1": [0, 1],
  "2-3": [2, 3],
  "4-5": [4, 5],
  "6-8": [6, 8],
  "9-10": [9, 10],
  "11-CCR": [11, 13],
};

export const DEFAULT_DRIFT_THRESHOLD = 2;

export function isGradeBand(v: unknown): v is GradeBand {
  return typeof v === "string" && v in GRADE_BAND_RANGE;
}

/**
 * Coerce a judge-returned grade string to a canonical `GradeBand`, or null.
 * The forced-tool enum constrains output to the six bands, but the vendored
 * grade-level `user.txt` word-count table labels the top band "11-12" while the
 * enum uses "11-CCR" — so accept "11-12" as an alias rather than crash a turn
 * on the one-in-a-thousand off-enum reply.
 */
export function coerceGradeBand(v: unknown): GradeBand | null {
  if (isGradeBand(v)) return v;
  if (v === "11-12" || v === "11" || v === "11-CCR ") return "11-CCR";
  return null;
}

export function bandFloor(band: GradeBand): number {
  return GRADE_BAND_RANGE[band][0];
}

/**
 * Parse a scholar reading level to a numeric grade. Accepts "7", "4",
 * "grade 7", "9-10" (→ midpoint), "K"/"KG" (→ 0). Returns null if unparseable
 * or unknown, so an absent reading level never fabricates a drift.
 */
export function parseReadingLevel(raw: string | null | undefined): number | null {
  if (raw == null) return null;
  const s = raw.trim().toLowerCase();
  if (s === "") return null;
  if (/^k(g|inder(garten)?)?$/.test(s)) return 0;
  const range = s.match(/(\d+)\s*[-–]\s*(\d+)/);
  if (range) return (Number(range[1]) + Number(range[2])) / 2;
  const single = s.match(/\d+/);
  if (single) return Number(single[0]);
  return null;
}

/**
 * Compare a tutor turn's measured band against the scholar's reading level.
 * `drift = bandFloor − readingGrade` (positive = pitched above). Flagged only
 * when `drift >= threshold` AND we actually know the reading level.
 */
export function computeGradeDrift(
  band: GradeBand,
  readingLevel: string | null | undefined,
  threshold: number = DEFAULT_DRIFT_THRESHOLD,
): GradeDrift {
  const floor = bandFloor(band);
  const readingGrade = parseReadingLevel(readingLevel);
  const drift = readingGrade === null ? null : floor - readingGrade;
  return {
    band,
    bandFloor: floor,
    readingGrade,
    drift,
    pitchedAboveReadingLevel: drift !== null && drift >= threshold,
  };
}

// ── LIVE runners (call the judge; see run.ts) ────────────────────────────────

const COACHING_MAX_TOKENS = 1500;
const GRADE_LEVEL_MAX_TOKENS = 1800;

/** Run one coaching dimension over one (student → tutor) pair. */
export async function runCoachingDim(
  dim: CoachingDim,
  studentText: string,
  feedbackText: string,
): Promise<CoachingVerdict> {
  const bundle = loadRubricBundle(dim);
  const tool = buildRubricTool(bundle, {
    name: `record_${dim.replace(/-/g, "_")}_verdict`,
    description: `Learning Commons productive-coaching criterion: ${dim}.`,
  });
  const userText = assembleUserText(bundle.userTemplate, {
    student_text: studentText || "(no prior student message)",
    feedback_text: feedbackText,
  });
  const raw = await runStructuredJudge({
    system: bundle.system,
    tool,
    userText,
    maxTokens: COACHING_MAX_TOKENS,
  });
  return scoreCoachingVerdict(dim, raw);
}

/** Measure the grade-level band of a single tutor turn's language. */
export async function runGradeLevel(text: string): Promise<GradeLevelVerdict> {
  const bundle = loadRubricBundle("grade-level-appropriateness");
  const tool = buildRubricTool(bundle, {
    name: "record_grade_level_verdict",
    description:
      "Learning Commons grade-level-appropriateness: the grade band this text is appropriate for.",
  });
  const userText = assembleUserText(bundle.userTemplate, { text });
  const raw = await runStructuredJudge({
    system: bundle.system,
    tool,
    userText,
    maxTokens: GRADE_LEVEL_MAX_TOKENS,
  });
  const grade = coerceGradeBand(raw.grade);
  const alt = coerceGradeBand(raw.alternative_grade);
  if (grade === null) {
    throw new Error(`grade-level: judge returned invalid grade ${JSON.stringify(raw.grade)}`);
  }
  return {
    grade,
    alternativeGrade: alt ?? grade,
    scaffoldingNeeded:
      typeof raw.scaffolding_needed === "string" ? raw.scaffolding_needed : "",
    reasoning: typeof raw.reasoning === "string" ? raw.reasoning : "",
  };
}

export const COACHING_DIMS: CoachingDim[] = ["manageable", "acknowledges-strength"];
