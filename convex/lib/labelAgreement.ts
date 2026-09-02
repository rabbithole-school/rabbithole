/**
 * Pure agreement math for the golden-set labeling tool. NO Convex/React imports
 * — kept framework-free so it is unit-testable as plain functions (per
 * .claude/rules/rabbithole-test-strategy.md) and reusable by the calibration
 * script. `convex/qualityLabeling.ts` (agreementReport) loads the rater rows and
 * delegates ALL the arithmetic here.
 *
 * A rater's score for one (turn, dimension) is 1..5, higher = better (the judge
 * rubric convention). "Disagreement" on a cell is the spread = max − min across
 * raters; a cell is flagged when that spread ≥ DISAGREEMENT_FLAG_THRESHOLD.
 */

/** A cell (turn × dimension) is flagged when raters differ by at least this. */
export const DISAGREEMENT_FLAG_THRESHOLD = 2;

export interface RaterScore {
  raterId: string;
  score: number;
}

/** One score row from a rater for a single tutor turn (message). */
export interface TurnLabelInput {
  raterId: string;
  messageId: string;
  /** dimKey -> 1..5. Only dims the rater actually scored are present. */
  dims: Record<string, number>;
}

/** One whole-transcript verdict from a rater. */
export interface TranscriptLabelInput {
  raterId: string;
  overall?: number | null;
}

/** The agreement stats for one (turn, dimension) pair. */
export interface DimTurnCell {
  messageId: string;
  /** 0-based turn position in the transcript, or -1 if unknown to the caller. */
  turnIndex: number;
  dimKey: string;
  scores: RaterScore[];
  mean: number;
  min: number;
  max: number;
  /** max − min across raters (0 when <2 raters scored it). */
  spread: number;
  flagged: boolean;
}

/** Per-dimension roll-up across all turns/raters. */
export interface DimSummary {
  dimKey: string;
  /** Mean of every score for this dim (null if no scores). */
  mean: number | null;
  /** How many scores contributed to the mean. */
  count: number;
  /** Largest single-cell spread seen for this dim. */
  maxDisagreement: number;
  /** How many cells for this dim tripped the flag threshold. */
  flaggedTurnCount: number;
}

export interface TranscriptAgreement {
  scores: RaterScore[];
  mean: number | null;
  min: number | null;
  max: number | null;
  spread: number;
  flagged: boolean;
}

export interface AgreementMatrix {
  /** One cell per (turn, dim) that has ≥1 score, ordered by turnIndex then dim. */
  cells: DimTurnCell[];
  /** Per-dimension roll-up, in the caller's `dimKeys` order. */
  dimSummaries: DimSummary[];
  /** The subset of `cells` where raters disagreed enough to flag. */
  flaggedCells: DimTurnCell[];
  /** Distinct rater ids that contributed any turn score. */
  raterIds: string[];
}

export function mean(values: number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

/** max − min; the widest disagreement between any two raters on a cell. */
export function maxPairwiseDisagreement(values: number[]): number {
  if (values.length < 2) return 0;
  return Math.max(...values) - Math.min(...values);
}

/** Round to `places` decimals (deterministic, avoids float noise in the UI). */
export function roundTo(value: number, places = 2): number {
  const f = 10 ** places;
  return Math.round(value * f) / f;
}

/**
 * Build the full agreement matrix from raw rater turn-labels.
 *
 * @param labels    one row per (rater, turn); `dims` holds that rater's scores
 * @param dimKeys   canonical dimension order to report (e.g. PER_TURN_DIMENSIONS keys)
 * @param messageOrder optional transcript order of messageIds → drives turnIndex
 */
export function computeAgreement(
  labels: TurnLabelInput[],
  dimKeys: string[],
  messageOrder: string[] = [],
): AgreementMatrix {
  const turnIndexOf = new Map<string, number>();
  messageOrder.forEach((id, i) => turnIndexOf.set(id, i));

  // (messageId, dimKey) -> RaterScore[]
  const grouped = new Map<string, RaterScore[]>();
  const cellMessage = new Map<string, string>();
  const cellDim = new Map<string, string>();
  const raterSet = new Set<string>();

  for (const label of labels) {
    raterSet.add(label.raterId);
    for (const [dimKey, score] of Object.entries(label.dims)) {
      if (typeof score !== "number") continue;
      const cellKey = `${label.messageId}::${dimKey}`;
      if (!grouped.has(cellKey)) {
        grouped.set(cellKey, []);
        cellMessage.set(cellKey, label.messageId);
        cellDim.set(cellKey, dimKey);
      }
      grouped.get(cellKey)!.push({ raterId: label.raterId, score });
    }
  }

  const dimOrderIndex = new Map<string, number>();
  dimKeys.forEach((k, i) => dimOrderIndex.set(k, i));

  const cells: DimTurnCell[] = [];
  for (const [cellKey, scores] of grouped) {
    const values = scores.map((s) => s.score);
    const min = Math.min(...values);
    const max = Math.max(...values);
    const spread = max - min;
    const messageId = cellMessage.get(cellKey)!;
    const dimKey = cellDim.get(cellKey)!;
    cells.push({
      messageId,
      turnIndex: turnIndexOf.has(messageId) ? turnIndexOf.get(messageId)! : -1,
      dimKey,
      // Stable rater order for deterministic output.
      scores: [...scores].sort((a, b) => a.raterId.localeCompare(b.raterId)),
      mean: roundTo(mean(values)!),
      min,
      max,
      spread,
      flagged: spread >= DISAGREEMENT_FLAG_THRESHOLD,
    });
  }

  cells.sort((a, b) => {
    if (a.turnIndex !== b.turnIndex) return a.turnIndex - b.turnIndex;
    const da = dimOrderIndex.has(a.dimKey) ? dimOrderIndex.get(a.dimKey)! : 999;
    const db = dimOrderIndex.has(b.dimKey) ? dimOrderIndex.get(b.dimKey)! : 999;
    if (da !== db) return da - db;
    return a.dimKey.localeCompare(b.dimKey);
  });

  const dimSummaries: DimSummary[] = dimKeys.map((dimKey) => {
    const dimCells = cells.filter((c) => c.dimKey === dimKey);
    const allValues = dimCells.flatMap((c) => c.scores.map((s) => s.score));
    const m = mean(allValues);
    return {
      dimKey,
      mean: m === null ? null : roundTo(m),
      count: allValues.length,
      maxDisagreement: dimCells.reduce((mx, c) => Math.max(mx, c.spread), 0),
      flaggedTurnCount: dimCells.filter((c) => c.flagged).length,
    };
  });

  return {
    cells,
    dimSummaries,
    flaggedCells: cells.filter((c) => c.flagged),
    raterIds: [...raterSet].sort((a, b) => a.localeCompare(b)),
  };
}

/** Agreement stats for the whole-transcript overall score. */
export function computeTranscriptAgreement(
  labels: TranscriptLabelInput[],
): TranscriptAgreement {
  const scores: RaterScore[] = labels
    .filter((l) => typeof l.overall === "number")
    .map((l) => ({ raterId: l.raterId, score: l.overall as number }))
    .sort((a, b) => a.raterId.localeCompare(b.raterId));
  const values = scores.map((s) => s.score);
  const m = mean(values);
  const spread = maxPairwiseDisagreement(values);
  return {
    scores,
    mean: m === null ? null : roundTo(m),
    min: values.length ? Math.min(...values) : null,
    max: values.length ? Math.max(...values) : null,
    spread,
    flagged: spread >= DISAGREEMENT_FLAG_THRESHOLD,
  };
}
