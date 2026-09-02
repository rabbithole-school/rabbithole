/**
 * PURE parameter-health metrics + Layer-2 recommender for the self-tuning weekly
 * digest (Workstream 4 — see review/practice/algo-decisions-2026-07.md
 * §"Workstream 4" and review/practice-algorithm-plan.html §7).
 *
 * Everything here is a pure function over an ARRAY of practice-attempt rows the
 * caller has already filtered to a rolling window. There is deliberately NO
 * `Date.now()`, no I/O, and no model call in this module: the window boundaries
 * (`windowStart` / `windowEnd`) are passed in so the math is reproducible and
 * unit-testable, and the Convex action in convex/practiceDigest.ts owns all the
 * reads/writes/dispatch.
 *
 * THE FIREWALL (the whole point of the workstream — do not weaken it):
 *   • MEMORY-MODEL params (`HALFLIFE_GROWTH`, `HALFLIFE_LAPSE`, initial
 *     half-life) describe how forgetting behaves — empirical claims the data can
 *     be right or wrong about. The recommender may propose a change to them
 *     (Layer 2) and, behind a flag, draft a proposal PR (Layer 3).
 *   • POLICY params (retention targets, grade-band width, FLUENT_REPS, caps) are
 *     curricular judgments. The digest may only PROMPT DISCUSSION about them,
 *     citing the data — it never emits a recommendation row for a policy param.
 *   • A recommendation fires only under a strict double gate: the signal is
 *     directionally consistent across TWO consecutive windows AND its 95%
 *     confidence interval excludes the healthy band in both. A single noisy
 *     window never moves a parameter.
 *   • Nothing here auto-applies anything. The output is a *proposal*, reviewed
 *     and merged by a human.
 *
 * Redaction: attempt rows + recommendations are teacher/admin-only. This module
 * never produces a scholar- or parent-facing string.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

/** Rolling window the digest evaluates parameter health over. */
export const PARAM_HEALTH_WINDOW_MS = 28 * DAY_MS;

/** Downstream-miss lookahead for a gap escape. */
export const GAP_ESCAPE_WINDOW_MS = 14 * DAY_MS;

/** Below this many gap escapes we report the count but draw no conclusion. */
export const GAP_ESCAPE_MIN_N = 5;

/** The healthy review-success band (per the plan): 80–90%. */
export const REVIEW_BAND_LOW = 0.8;
export const REVIEW_BAND_HIGH = 0.9;

/** z for a 95% two-sided normal interval (Wilson score). */
export const Z_95 = 1.96;

/** Fixed nudge steps for the memory-model params a recommendation may propose. */
export const HALFLIFE_GROWTH_STEP = 0.3;
/** A growth multiplier must stay above 1 (a rep should never shrink half-life). */
export const HALFLIFE_GROWTH_FLOOR = 1.1;

/**
 * The ONLY params a recommendation row may ever name. A hard allow-list is the
 * code-level half of the memory-vs-policy firewall: even a future bug can't emit
 * a recommendation for a policy param, because building the row asserts against
 * this set.
 */
export const MEMORY_PARAMS = [
  "HALFLIFE_GROWTH",
  "HALFLIFE_LAPSE",
  "INITIAL_HALFLIFE_DAYS",
] as const;
export type MemoryParam = (typeof MEMORY_PARAMS)[number];

/** Notable challenge-item volume before we raise the (policy) discussion prompt. */
export const POLICY_CHALLENGE_MIN_N = 5;

/**
 * How far apart two windows may be and still count as "consecutive". The digest
 * runs weekly (a Friday cron), so back-to-back evaluations are ~7 days apart.
 * This bound must sit ABOVE the digest cadence (so consecutive runs chain) but
 * BELOW two cadences (so a single non-qualifying window in between breaks the
 * streak — the gap to the last open row then jumps to ~14 days and no longer
 * counts). 10 days satisfies both for the weekly cadence. The digest passes an
 * explicit value derived from its own cadence; this is the default.
 */
export const MAX_CONSECUTIVE_WINDOW_GAP_MS = 10 * DAY_MS;

export type PracticeLane =
  | "review"
  | "frontier"
  | "confirmation"
  | "placement"
  | "reprobe"
  | "tuneup"
  | "challenge"
  | "chat";

/**
 * The subset of a `practiceAttempts` row the metrics read. Kept structural (not
 * the Convex `Doc`) so the pure functions and their tests never touch the
 * generated data model.
 */
export interface AttemptRow {
  scholarId: string;
  nodeKey: string;
  domain?: string;
  lane?: PracticeLane;
  predictedRetention?: number;
  correct: boolean;
  createdAt?: number;
}

export interface WilsonInterval {
  low: number;
  high: number;
}

/**
 * Wilson score interval for a binomial proportion — the small-n-honest CI the
 * plan calls for (a normal-approx interval lies at the extremes). Returns the
 * maximally-uncertain [0, 1] for n = 0 so callers treat "no data" as "cannot
 * exclude anything".
 */
export function wilsonInterval(
  successes: number,
  n: number,
  z: number = Z_95,
): WilsonInterval {
  if (n <= 0) return { low: 0, high: 1 };
  const p = successes / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const center = (p + z2 / (2 * n)) / denom;
  const margin = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denom;
  return {
    low: Math.max(0, center - margin),
    high: Math.min(1, center + margin),
  };
}

// ── Calibration table ──────────────────────────────────────────────────────

export interface CalibrationBucket {
  /** Human label for the predicted-retention band, e.g. "0.60–0.75". */
  label: string;
  /** Half-open bounds [lo, hi) on predictedRetention; hi === null for ≥ top. */
  lo: number;
  hi: number | null;
  /** Mean predicted retention of the attempts that fell in the bucket. */
  meanPredicted: number;
  n: number;
  successes: number;
  observedRate: number;
  wilson: WilsonInterval;
}

const CALIBRATION_BOUNDS: { label: string; lo: number; hi: number | null }[] = [
  { label: "<0.60", lo: 0, hi: 0.6 },
  { label: "0.60–0.75", lo: 0.6, hi: 0.75 },
  { label: "0.75–0.90", lo: 0.75, hi: 0.9 },
  { label: "≥0.90", lo: 0.9, hi: null },
];

/** Lanes whose attempts have a meaningful engine-predicted retention to grade. */
const CALIBRATION_LANES = new Set<PracticeLane>(["review", "confirmation"]);

/**
 * Bucket review + confirmation attempts by the engine's predicted retention and
 * compare predicted vs observed success. This is the substrate for "predicted
 * 7-in-10, observed 8.8-in-10 (n=214)".
 */
export function calibrationTable(rows: AttemptRow[]): CalibrationBucket[] {
  const acc = CALIBRATION_BOUNDS.map((b) => ({
    ...b,
    n: 0,
    successes: 0,
    predictedSum: 0,
  }));
  for (const r of rows) {
    if (!r.lane || !CALIBRATION_LANES.has(r.lane)) continue;
    if (typeof r.predictedRetention !== "number") continue;
    const pr = r.predictedRetention;
    const bucket = acc.find((b) => pr >= b.lo && (b.hi === null || pr < b.hi));
    if (!bucket) continue;
    bucket.n += 1;
    bucket.predictedSum += pr;
    if (r.correct) bucket.successes += 1;
  }
  return acc.map((b) => ({
    label: b.label,
    lo: b.lo,
    hi: b.hi,
    meanPredicted: b.n > 0 ? b.predictedSum / b.n : (b.lo + (b.hi ?? 1)) / 2,
    n: b.n,
    successes: b.successes,
    observedRate: b.n > 0 ? b.successes / b.n : 0,
    wilson: wilsonInterval(b.successes, b.n),
  }));
}

// ── Review success by domain (vs the healthy band) ──────────────────────────

export type BandVerdict = "below" | "within" | "above" | "insufficient";

export interface DomainReviewRate {
  domain: string;
  n: number;
  successes: number;
  rate: number;
  wilson: WilsonInterval;
  verdict: BandVerdict;
}

/** Below this many review attempts a domain's rate is "insufficient" to read. */
export const DOMAIN_REVIEW_MIN_N = 20;

function bandVerdict(rate: number, n: number): BandVerdict {
  if (n < DOMAIN_REVIEW_MIN_N) return "insufficient";
  if (rate < REVIEW_BAND_LOW) return "below";
  if (rate > REVIEW_BAND_HIGH) return "above";
  return "within";
}

/** Per-domain review-lane success rate + Wilson CI + healthy-band verdict. */
export function reviewSuccessByDomain(rows: AttemptRow[]): DomainReviewRate[] {
  const byDomain = new Map<string, { n: number; successes: number }>();
  for (const r of rows) {
    if (r.lane !== "review") continue;
    const domain = r.domain ?? "unknown";
    const agg = byDomain.get(domain) ?? { n: 0, successes: 0 };
    agg.n += 1;
    if (r.correct) agg.successes += 1;
    byDomain.set(domain, agg);
  }
  return Array.from(byDomain.entries())
    .map(([domain, { n, successes }]) => {
      const rate = n > 0 ? successes / n : 0;
      return {
        domain,
        n,
        successes,
        rate,
        wilson: wilsonInterval(successes, n),
        verdict: bandVerdict(rate, n),
      };
    })
    .sort((a, b) => a.domain.localeCompare(b.domain));
}

/** Overall (all-domain) review-lane success — the recommender's headline signal. */
export function overallReviewSuccess(rows: AttemptRow[]): {
  n: number;
  successes: number;
  rate: number;
  wilson: WilsonInterval;
} {
  let n = 0;
  let successes = 0;
  for (const r of rows) {
    if (r.lane !== "review") continue;
    n += 1;
    if (r.correct) successes += 1;
  }
  return {
    n,
    successes,
    rate: n > 0 ? successes / n : 0,
    wilson: wilsonInterval(successes, n),
  };
}

// ── Review share ────────────────────────────────────────────────────────────

export interface ReviewShare {
  reviewCount: number;
  servedCount: number;
  share: number;
}

/**
 * Share of SERVED items that were reviews. "Served" = any attempt carrying a
 * lane (a row with no lane is telemetry we can't classify, so it's excluded from
 * the denominator rather than silently counted as non-review).
 */
export function reviewShare(rows: AttemptRow[]): ReviewShare {
  let reviewCount = 0;
  let servedCount = 0;
  for (const r of rows) {
    if (!r.lane) continue;
    servedCount += 1;
    if (r.lane === "review") reviewCount += 1;
  }
  return {
    reviewCount,
    servedCount,
    share: servedCount > 0 ? reviewCount / servedCount : 0,
  };
}

// ── Band pressure (the policy signal) ────────────────────────────────────────

export interface BandPressure {
  challengeAttempts: number;
  challengeCorrect: number;
  challengeSuccessRate: number;
  distinctChallengeNodes: number;
  distinctChallengeScholars: number;
}

/**
 * Challenge-lane uptake + success — the observable half of "is the grade band
 * too conservative?". NOTE: the count of frontier nodes the band *suppressed*
 * lives at scheduling time, not in the attempt log, so it is not computable here
 * — the digest reports challenge uptake/success and asks the question; the
 * suppressed-count would need a separate scheduler signal.
 */
export function bandPressure(rows: AttemptRow[]): BandPressure {
  let challengeAttempts = 0;
  let challengeCorrect = 0;
  const nodes = new Set<string>();
  const scholars = new Set<string>();
  for (const r of rows) {
    if (r.lane !== "challenge") continue;
    challengeAttempts += 1;
    if (r.correct) challengeCorrect += 1;
    nodes.add(r.nodeKey);
    scholars.add(r.scholarId);
  }
  return {
    challengeAttempts,
    challengeCorrect,
    challengeSuccessRate:
      challengeAttempts > 0 ? challengeCorrect / challengeAttempts : 0,
    distinctChallengeNodes: nodes.size,
    distinctChallengeScholars: scholars.size,
  };
}

// ── Gap escapes ───────────────────────────────────────────────────────────────

export interface GapEscapes {
  n: number;
  /** True once n ≥ GAP_ESCAPE_MIN_N — below that we report the count only. */
  readable: boolean;
}

/**
 * A "gap escape" = a skill answered CORRECTLY in a review, then MISSED again on
 * the same node within 14 days — the review said "consolidated" and reality
 * disagreed shortly after. Counted per (scholar, node): the earliest correct
 * review that has any later miss within the window is one escape (we don't
 * double-count a node that keeps flapping). Reported with n; under
 * GAP_ESCAPE_MIN_N we draw no conclusion.
 */
export function gapEscapes(rows: AttemptRow[]): GapEscapes {
  const byKey = new Map<string, AttemptRow[]>();
  for (const r of rows) {
    if (typeof r.createdAt !== "number") continue;
    const key = `${r.scholarId}\u0000${r.nodeKey}`;
    const list = byKey.get(key) ?? [];
    list.push(r);
    byKey.set(key, list);
  }

  let n = 0;
  for (const list of byKey.values()) {
    list.sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0));
    for (let i = 0; i < list.length; i++) {
      const a = list[i];
      if (a.lane !== "review" || !a.correct) continue;
      const at = a.createdAt as number;
      const escaped = list.some(
        (b, j) =>
          j > i &&
          !b.correct &&
          (b.createdAt as number) > at &&
          (b.createdAt as number) - at <= GAP_ESCAPE_WINDOW_MS,
      );
      if (escaped) {
        n += 1;
        break; // one escape per (scholar, node)
      }
    }
  }

  return { n, readable: n >= GAP_ESCAPE_MIN_N };
}

// ── The bundled window metrics ────────────────────────────────────────────────

export interface ParamHealthMetrics {
  calibration: CalibrationBucket[];
  reviewByDomain: DomainReviewRate[];
  overallReview: ReturnType<typeof overallReviewSuccess>;
  reviewShare: ReviewShare;
  bandPressure: BandPressure;
  gapEscapes: GapEscapes;
}

export function computeParamHealthMetrics(rows: AttemptRow[]): ParamHealthMetrics {
  return {
    calibration: calibrationTable(rows),
    reviewByDomain: reviewSuccessByDomain(rows),
    overallReview: overallReviewSuccess(rows),
    reviewShare: reviewShare(rows),
    bandPressure: bandPressure(rows),
    gapEscapes: gapEscapes(rows),
  };
}

// ── Layer 2 — the recommender (memory-model params only) ─────────────────────

export type SignalDirection = "raise" | "lower" | "none";

export interface WindowSignal {
  param: MemoryParam;
  direction: SignalDirection;
  /** True only when the 95% CI is entirely on one side of the healthy band. */
  ciExcludesBand: boolean;
  currentValue: number;
  proposedValue: number;
  reviewSuccess: ReturnType<typeof overallReviewSuccess>;
}

/**
 * Turn this window's metrics into a memory-model signal. The headline signal is
 * the overall review-success rate against the healthy 80–90% band:
 *   • CI wholly above 0.90  → the engine is forgetting-PESSIMISTIC (kids remember
 *     better than the model predicts) → RAISE half-life growth.
 *   • CI wholly below 0.80  → the engine over-estimates retention (reviews land
 *     too late) → LOWER half-life growth.
 * A point estimate outside the band but a CI that still overlaps it yields a
 * direction with `ciExcludesBand = false` (a lean, not yet actionable) so the
 * digest can honestly say "leaning, but the interval is too wide".
 */
export function deriveWindowSignal(
  metrics: ParamHealthMetrics,
  currentGrowth: number,
): WindowSignal {
  const rs = metrics.overallReview;
  let direction: SignalDirection = "none";
  let ciExcludesBand = false;

  if (rs.n > 0) {
    if (rs.wilson.low > REVIEW_BAND_HIGH) {
      direction = "raise";
      ciExcludesBand = true;
    } else if (rs.wilson.high < REVIEW_BAND_LOW) {
      direction = "lower";
      ciExcludesBand = true;
    } else if (rs.rate > REVIEW_BAND_HIGH) {
      direction = "raise";
    } else if (rs.rate < REVIEW_BAND_LOW) {
      direction = "lower";
    }
  }

  const proposedValue =
    direction === "raise"
      ? round1(currentGrowth + HALFLIFE_GROWTH_STEP)
      : direction === "lower"
        ? round1(Math.max(HALFLIFE_GROWTH_FLOOR, currentGrowth - HALFLIFE_GROWTH_STEP))
        : currentGrowth;

  return {
    param: "HALFLIFE_GROWTH",
    direction,
    ciExcludesBand,
    currentValue: currentGrowth,
    proposedValue,
    reviewSuccess: rs,
  };
}

function round1(x: number): number {
  return Math.round(x * 10) / 10;
}

/**
 * The trail carried in a persisted recommendation row's `evidence` JSON, plus the
 * top-level row fields, is enough for the NEXT window to judge consecutiveness.
 * This is the shape the digest reconstructs from the previous open row.
 */
export interface PreviousRecommendation {
  windowEnd: number;
  param: string;
  status: "open" | "dismissed" | "actioned";
  direction: SignalDirection;
  consecutiveWindows: number;
}

export interface RecommendationEvidence {
  signal: string;
  direction: SignalDirection;
  consecutiveWindows: number;
  windowStart: number;
  windowEnd: number;
  reviewSuccess: {
    n: number;
    successes: number;
    rate: number;
    wilsonLow: number;
    wilsonHigh: number;
  };
  healthyBand: [number, number];
  calibration: {
    label: string;
    meanPredicted: number;
    observedRate: number;
    wilsonLow: number;
    wilsonHigh: number;
    n: number;
  }[];
}

export interface ParamRecommendationDraft {
  windowEnd: number;
  param: MemoryParam;
  currentValue: number;
  proposedValue: number;
  evidence: RecommendationEvidence;
  /**
   * True only on the window a signal FIRST crosses the two-window gate — the
   * Layer-3 hook dispatches on this edge, so a sustained signal doesn't re-draft
   * a PR every week.
   */
  firstFire: boolean;
}

export type RecommendationDecision =
  | { kind: "none" }
  | { kind: "pending"; draft: ParamRecommendationDraft }
  | { kind: "fire"; draft: ParamRecommendationDraft };

/**
 * The Layer-2 double gate, pure. Given this window's signal and the previous
 * OPEN recommendation row (if any), decide whether to fire.
 *   • No qualifying signal (direction none, or CI overlaps the band) → none.
 *   • Qualifying signal but no matching, recent, open previous row → pending
 *     (persist it so next window can confirm; nothing surfaced as actionable).
 *   • Qualifying signal that matches the previous open row's param + direction
 *     within MAX_CONSECUTIVE_WINDOW_GAP_MS → fire.
 * `firstFire` is set the first time consecutiveWindows reaches 2, so the caller
 * dispatches Layer 3 exactly once per sustained run.
 */
export function recommendParamChange(
  signal: WindowSignal,
  previous: PreviousRecommendation | null,
  window: { windowStart: number; windowEnd: number },
  metrics: ParamHealthMetrics,
  opts?: { maxWindowGapMs?: number },
): RecommendationDecision {
  const qualifies = signal.direction !== "none" && signal.ciExcludesBand;
  if (!qualifies) return { kind: "none" };

  // Defense-in-depth: never emit a row for anything but a memory-model param.
  if (!(MEMORY_PARAMS as readonly string[]).includes(signal.param)) {
    return { kind: "none" };
  }

  const maxGap = opts?.maxWindowGapMs ?? MAX_CONSECUTIVE_WINDOW_GAP_MS;
  const gap = previous ? window.windowEnd - previous.windowEnd : Infinity;
  const consecutive =
    previous !== null &&
    previous.status === "open" &&
    previous.param === signal.param &&
    previous.direction === signal.direction &&
    gap > 0 &&
    gap <= maxGap;

  const consecutiveWindows = consecutive ? previous!.consecutiveWindows + 1 : 1;

  const draft: ParamRecommendationDraft = {
    windowEnd: window.windowEnd,
    param: signal.param,
    currentValue: signal.currentValue,
    proposedValue: signal.proposedValue,
    firstFire: consecutive && previous!.consecutiveWindows < 2,
    evidence: {
      signal:
        signal.direction === "raise"
          ? "review-success-above-band"
          : "review-success-below-band",
      direction: signal.direction,
      consecutiveWindows,
      windowStart: window.windowStart,
      windowEnd: window.windowEnd,
      reviewSuccess: {
        n: signal.reviewSuccess.n,
        successes: signal.reviewSuccess.successes,
        rate: signal.reviewSuccess.rate,
        wilsonLow: signal.reviewSuccess.wilson.low,
        wilsonHigh: signal.reviewSuccess.wilson.high,
      },
      healthyBand: [REVIEW_BAND_LOW, REVIEW_BAND_HIGH],
      calibration: metrics.calibration
        .filter((b) => b.n > 0)
        .map((b) => ({
          label: b.label,
          meanPredicted: b.meanPredicted,
          observedRate: b.observedRate,
          wilsonLow: b.wilson.low,
          wilsonHigh: b.wilson.high,
          n: b.n,
        })),
    },
  };

  return consecutive ? { kind: "fire", draft } : { kind: "pending", draft };
}

// ── Rendering — teacher-legible digest copy ──────────────────────────────────

/** "8.8-in-10" style — the plan's chosen phrasing for a success rate. */
export function xInTen(rate: number): string {
  const v = Math.round(rate * 100) / 10; // one decimal on the 0–10 scale
  return Number.isInteger(v) ? String(v) : v.toFixed(1);
}

function ci(w: WilsonInterval): string {
  return `${w.low.toFixed(2)}–${w.high.toFixed(2)}`;
}

function pctInt(x: number): string {
  return `${Math.round(x * 100)}%`;
}

function humanDomain(domain: string): string {
  return domain.replace(/[-_]+/g, " ");
}

const CALIBRATION_READ: Record<Exclude<BandVerdict, "insufficient">, string> = {
  below: "we over-predict retention",
  within: "on target",
  above: "we under-predict retention",
};

/** Per-bucket read: is observed materially above / below / around predicted? */
function calibrationRead(b: CalibrationBucket): string {
  if (b.n === 0) return "no data";
  if (b.meanPredicted < b.wilson.low) return CALIBRATION_READ.above;
  if (b.meanPredicted > b.wilson.high) return CALIBRATION_READ.below;
  return CALIBRATION_READ.within;
}

export interface ParamHealthSectionInput {
  metrics: ParamHealthMetrics;
  signal: WindowSignal;
  decision: RecommendationDecision;
  windowStart: number;
  windowEnd: number;
  /** Review share for the immediately-prior window, for week-over-week context. */
  previousReviewShare?: ReviewShare | null;
}

export interface ParamHealthSection {
  text: string;
  decision: RecommendationDecision;
}

/**
 * Render the "Practice parameter health" digest section. Portrait-shaped and
 * calm like the rest of the digest: it explains what the numbers mean and,
 * crucially, treats "no action" as a first-class, healthy outcome — not a
 * failure. Recommendations are always framed as OPEN proposals for human review.
 */
export function renderParamHealthSection(
  input: ParamHealthSectionInput,
): ParamHealthSection {
  const { metrics, signal, decision } = input;
  const lines: string[] = [];

  lines.push("🩺 *Practice parameter health* — last 28 days");

  // ── Layer 1: calibration table ──
  const calBuckets = metrics.calibration.filter((b) => b.n > 0);
  if (calBuckets.length === 0) {
    lines.push(
      "_Calibration:_ not enough review/confirmation attempts logged yet to read — the table fills as data accrues.",
    );
  } else {
    lines.push("_Calibration (review + confirmation lanes):_");
    for (const b of calBuckets) {
      lines.push(
        `• predicted R ${b.label}: predicted ${xInTen(b.meanPredicted)}-in-10, observed ${xInTen(b.observedRate)}-in-10 (95% ${ci(b.wilson)}, n=${b.n}) — ${calibrationRead(b)}`,
      );
    }
  }

  // ── Layer 1: review success vs the healthy band ──
  if (metrics.reviewByDomain.length > 0) {
    lines.push(`_Review success vs the healthy ${REVIEW_BAND_LOW * 10}–${REVIEW_BAND_HIGH * 10}-in-10 band:_`);
    for (const d of metrics.reviewByDomain) {
      const verdict =
        d.verdict === "insufficient"
          ? `too few reviews to read (n=${d.n})`
          : d.verdict === "within"
            ? "in the healthy band"
            : d.verdict === "above"
              ? "above the healthy band"
              : "below the healthy band";
      lines.push(
        `• ${humanDomain(d.domain)}: ${xInTen(d.rate)}-in-10 (95% ${ci(d.wilson)}, n=${d.n}) — ${verdict}`,
      );
    }
  }

  // ── Layer 1: review share (week over week) ──
  const rs = metrics.reviewShare;
  if (rs.servedCount > 0) {
    const prev = input.previousReviewShare;
    const wow =
      prev && prev.servedCount > 0
        ? ` (was ${pctInt(prev.share)} the prior window)`
        : "";
    lines.push(
      `_Review share of served items:_ ${pctInt(rs.share)}${wow} — ${rs.reviewCount} of ${rs.servedCount} served items were reviews.`,
    );
  }

  // ── Layer 1: gap escapes ──
  const ge = metrics.gapEscapes;
  if (ge.n === 0) {
    lines.push("_Gap escapes_ (correct in review, then missed within 14 days): none this window.");
  } else if (!ge.readable) {
    lines.push(
      `_Gap escapes_ (correct in review, then missed within 14 days): ${ge.n} seen — too few to read (need ≥${GAP_ESCAPE_MIN_N}).`,
    );
  } else {
    lines.push(
      `_Gap escapes_ (correct in review, then missed within 14 days): ${ge.n} — worth checking whether those reviews are landing too early.`,
    );
  }

  // ── Layer 2 / policy: challenge-item discussion prompt (NEVER a recommendation) ──
  const bp = metrics.bandPressure;
  if (bp.challengeAttempts >= POLICY_CHALLENGE_MIN_N) {
    lines.push(
      `⚖️ *Discussion prompt (policy — not a recommendation):* ${bp.challengeAttempts} challenge item${bp.challengeAttempts === 1 ? "" : "s"} taken this window, ${bp.challengeCorrect} correct (${xInTen(bp.challengeSuccessRate)}-in-10, across ${bp.distinctChallengeScholars} scholar${bp.distinctChallengeScholars === 1 ? "" : "s"}). Is the grade band too conservative? This is a values call, not a metric — your decision.`,
    );
  } else if (bp.challengeAttempts > 0) {
    lines.push(
      `_Challenge items:_ ${bp.challengeAttempts} taken, ${bp.challengeCorrect} correct — too few to read (band-pressure discussion needs ≥${POLICY_CHALLENGE_MIN_N}).`,
    );
  }

  // ── Layer 2: the recommendation / no-action verdict (memory-model params only) ──
  lines.push(renderVerdict(signal, decision));

  return { text: lines.join("\n"), decision };
}

function renderVerdict(
  signal: WindowSignal,
  decision: RecommendationDecision,
): string {
  const arrow = (d: ParamRecommendationDraft) =>
    `\`${d.param}\` ${d.currentValue} → ${d.proposedValue}`;
  const rsPhrase = (s: WindowSignal) =>
    `${xInTen(s.reviewSuccess.rate)}-in-10, 95% ${ci(s.reviewSuccess.wilson)}, n=${s.reviewSuccess.n}`;

  if (decision.kind === "fire") {
    const d = decision.draft;
    const why =
      signal.direction === "raise"
        ? "children retain more than the model predicts"
        : "reviews are coming back too late — retention is over-estimated";
    return (
      `📈 *Recommendation (memory-model):* ${signal.direction === "raise" ? "raise" : "lower"} ${arrow(d)}. ` +
      `Review success was ${signal.direction === "raise" ? "above" : "below"} the healthy band for two consecutive windows (this window ${rsPhrase(signal)}) — ${why}. ` +
      `Logged as an OPEN recommendation for human review; never auto-applied.`
    );
  }

  if (decision.kind === "pending") {
    const d = decision.draft;
    return (
      `👀 *No action yet* — review success is ${signal.direction === "raise" ? "above" : "below"} the healthy band this window (${rsPhrase(signal)}), ` +
      `but a recommendation needs the same signal two windows running. Watching for a second before proposing ${arrow(d)}.`
    );
  }

  // none — a first-class, healthy outcome (or a wide interval doing its job).
  if (signal.reviewSuccess.n === 0) {
    return "🩺 *No parameter change* — no review attempts logged this window, so there is nothing to calibrate against yet.";
  }
  if (signal.direction !== "none") {
    return (
      `🩺 *No parameter change* — review success leans ${signal.direction === "raise" ? "high" : "low"} this window (${rsPhrase(signal)}), ` +
      "but the 95% interval still overlaps the healthy band, so it is too wide to act on. That is the interval doing its job — a wide interval is a reason NOT to move a parameter."
    );
  }
  return "🩺 *No parameter change* — review success sits inside the healthy band and calibration is on target. A quiet week here is the system working, not a failure.";
}
