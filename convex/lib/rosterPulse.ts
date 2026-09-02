/**
 * Pure helper for the Scholars-roster "Now vs Lately" board
 * (review/observer-assessment-redesign.md §"Teacher roster view", the
 * low-hanging-fruit rung: rides EXISTING `analyses` data, independent of the
 * observer redesign).
 *
 * The observer already writes an engagement / on-task / concern signal after
 * every exchange (`analyses` rows). Nothing trends them PER SCHOLAR for the
 * roster. `computeRosterPulse` turns a flat list of those signals (one row per
 * analysis, already scoped to the caller's institution lens and joined with the
 * owning scholar + session) into a compact per-scholar bundle: an engagement
 * sparkline, a recent-vs-earlier trend, recurring concern flags, and an
 * attention score/level the roster sorts by.
 *
 * PEDAGOGY NOTE: unlike the weekly Quality Pulse digest (which grades the TUTOR
 * and is scholar-blind by construction), this is a TEACHER-FACING roster — the
 * design note explicitly allows per-scholar readiness/flags here. So `scholarId`
 * IS a dimension. This surface must never be shown to a kid or parent.
 *
 * PURE by design (inputs → output, no `ctx`, no Convex calls) so it can be
 * unit-tested directly — see convex/__tests__/rosterPulse.test.ts and
 * .claude/rules/rabbithole-test-strategy.md (pure-helper-first).
 */

// ─── Tunables ──────────────────────────────────────────────────────────────

/** Most recent N observer readings plotted in a scholar's sparkline. Word-sized
 *  (Tufte): enough to read a shape, not a full chart. */
export const SPARKLINE_MAX_POINTS = 14;

/**
 * Fewest engagement readings before we'll assert a TREND at all.
 *
 * Each `analyses` row is the observer LLM re-reading the whole session-so-far,
 * so a single 0–1 engagement score carries real judgement noise and adjacent
 * readings are autocorrelated. A split-half "trend" off 2–3 points is mostly an
 * artifact (one reading per half). Below this floor we draw the sparkline but
 * make NO trend claim — the arrow/delta are suppressed. Honesty over drama
 * (WWTD: don't show precision the data can't support).
 */
export const TREND_MIN_POINTS = 4;

/**
 * Engagement/on-task are 0–1 rates. A trend counts as up/down only past this
 * band, so per-reading observer noise doesn't flip the arrow. Matches the
 * digest's RATE_REGRESSION_THRESHOLD (0.08): a glanceable roster arrow should
 * sit ABOVE the observer's judgement-noise floor, not inside it.
 */
export const TREND_FLAT_BAND = 0.08; // 0–1 scale

/** A steeper drop than this reads as a real slide → bumps a scholar to "concern". */
export const TREND_CONCERN_DROP = 0.15; // 0–1 scale

// Recent-window means below these read as low.
const LOW_ENGAGEMENT = 0.5;
const CONCERN_ENGAGEMENT = 0.4;
const LOW_ON_TASK = 0.6;
const CONCERN_ON_TASK = 0.45;

/** How many distinct concern flags to carry to the UI (most recent first). */
const CONCERN_FLAG_CAP = 3;

// ─── I/O shapes ──────────────────────────────────────────────────────────────

/**
 * One observer signal, already joined with the owning scholar + session. Metrics
 * are nullable because a given `analyses` row may omit a dial.
 */
export interface RosterAnalysisRow {
  scholarId: string;
  sessionId: string;
  createdAt: number; // ms epoch — `analyses._creationTime`
  engagement: number | null; // 0–1
  onTask: number | null; // 0–1
  concernFlags: string[];
  /** Observer's sentence-level read of the session (`analyses.summary`). */
  summary?: string | null;
  /** Observer's suggested next step (`analyses.suggestedIntervention`). */
  suggestedIntervention?: string | null;
}

export type RosterTrend = "up" | "down" | "flat";
export type RosterAttentionLevel = "concern" | "nudge" | "ok";

export interface ScholarPulse {
  scholarId: string;
  /** Engagement 0–1, oldest → newest, capped at SPARKLINE_MAX_POINTS. */
  sparkline: number[];
  /** The most recent engagement reading (sparkline end-dot value). */
  latestEngagement: number | null;
  /** Mean engagement across the window (the sparkline's reference level). */
  latelyEngagement: number | null;
  /** Mean on-task across the window. */
  latelyOnTask: number | null;
  /** Recent-half mean − earlier-half mean of engagement (null if < 2 points). */
  trendDelta: number | null;
  trend: RosterTrend | null;
  /** Distinct recent concern flags, most-recent-first, capped. */
  concernFlags: string[];
  /** Total concern-flag occurrences in the window. */
  concernCount: number;
  /**
   * The observer's most-recent sentence-level read of what's happening
   * (`analyses.summary`). Richer than the concern keywords — the roster leads
   * with this for flagged scholars instead of flattening it to tags.
   */
  latestSummary: string | null;
  /**
   * When `latestSummary` was written. Distinct from `lastAnalysisAt`: the
   * newest analysis can carry an empty summary, in which case `latestSummary`
   * comes from an older row — age the SUMMARY by this, never by
   * `lastAnalysisAt`.
   */
  latestSummaryAt: number | null;
  /** The observer's most-recent suggested next step, if any. */
  latestIntervention: string | null;
  /** Distinct sessions with an analysis in the window. */
  analyzedSessions: number;
  /** Number of analyses in the window. */
  sampleCount: number;
  lastAnalysisAt: number | null;
  /** Higher = more attention needed. Used to sort the "Lately" board. */
  attentionScore: number;
  attentionLevel: RosterAttentionLevel;
}

export interface RosterPulseOptions {
  /** Max sparkline points. Defaults to SPARKLINE_MAX_POINTS. */
  sparklineMax?: number;
}

// ─── Small numeric helpers ────────────────────────────────────────────────────

function mean(xs: number[]): number | null {
  if (xs.length === 0) return null;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

function round2(x: number): number {
  return Math.round(x * 100) / 100;
}

/** Recent-half mean − earlier-half mean. Needs ≥ 2 points, else null. */
function trendDeltaOf(series: number[]): number | null {
  const n = series.length;
  if (n < 2) return null;
  const split = Math.floor(n / 2);
  const earlier = series.slice(0, split);
  const recent = series.slice(split);
  const em = mean(earlier);
  const rm = mean(recent);
  if (em == null || rm == null) return null;
  return rm - em;
}

function trendOf(delta: number | null): RosterTrend | null {
  if (delta == null) return null;
  if (delta > TREND_FLAT_BAND) return "up";
  if (delta < -TREND_FLAT_BAND) return "down";
  return "flat";
}

/**
 * Attention score — higher means "check on this scholar first". Concerns
 * dominate; then a real engagement slide; then persistently low engagement /
 * on-task. Improving or steady-high scholars land near 0. The exact number is
 * only a sort key — the discrete `attentionLevel` is what the pip shows.
 */
export function attentionScoreOf(p: {
  concernCount: number;
  trendDelta: number | null;
  latelyEngagement: number | null;
  latelyOnTask: number | null;
}): number {
  let score = 0;
  score += Math.min(p.concernCount, 3) * 2.0; // up to 6
  if (p.trendDelta != null && p.trendDelta <= -TREND_FLAT_BAND) {
    score += Math.min(-p.trendDelta, 0.4) * 6; // up to ~2.4
  }
  if (p.latelyEngagement != null && p.latelyEngagement < LOW_ENGAGEMENT) {
    score += (LOW_ENGAGEMENT - p.latelyEngagement) * 3; // up to 1.5
  }
  if (p.latelyOnTask != null && p.latelyOnTask < LOW_ON_TASK) {
    score += (LOW_ON_TASK - p.latelyOnTask) * 3; // up to 1.8
  }
  return round2(score);
}

export function attentionLevelOf(p: {
  concernCount: number;
  trendDelta: number | null;
  latelyEngagement: number | null;
  latelyOnTask: number | null;
}): RosterAttentionLevel {
  const concern =
    p.concernCount > 0 ||
    (p.latelyOnTask != null && p.latelyOnTask < CONCERN_ON_TASK) ||
    (p.latelyEngagement != null && p.latelyEngagement < CONCERN_ENGAGEMENT) ||
    (p.trendDelta != null && p.trendDelta <= -TREND_CONCERN_DROP);
  if (concern) return "concern";

  const nudge =
    (p.trendDelta != null && p.trendDelta <= -TREND_FLAT_BAND) ||
    (p.latelyEngagement != null && p.latelyEngagement < LOW_ENGAGEMENT + 0.1) ||
    (p.latelyOnTask != null && p.latelyOnTask < LOW_ON_TASK + 0.1);
  if (nudge) return "nudge";

  return "ok";
}

/** Dedup concern flags case-insensitively, keeping most-recent-first order. */
function distinctConcerns(flagsNewestFirst: string[], cap: number): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const f of flagsNewestFirst) {
    const key = f.trim().toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(f.trim());
    if (out.length >= cap) break;
  }
  return out;
}

// ─── The compute ──────────────────────────────────────────────────────────────

/**
 * Fold analysis rows into a per-scholar pulse bundle. Rows may arrive in any
 * order and span many scholars/sessions; only scholars with ≥ 1 row appear in
 * the result (the roster treats a missing scholar as "no recent activity").
 */
export function computeRosterPulse(
  rows: RosterAnalysisRow[],
  opts: RosterPulseOptions = {},
): { byScholar: Record<string, ScholarPulse> } {
  const sparklineMax = opts.sparklineMax ?? SPARKLINE_MAX_POINTS;

  const grouped = new Map<string, RosterAnalysisRow[]>();
  for (const r of rows) {
    const arr = grouped.get(r.scholarId);
    if (arr) arr.push(r);
    else grouped.set(r.scholarId, [r]);
  }

  const byScholar: Record<string, ScholarPulse> = {};

  for (const [scholarId, scholarRows] of grouped) {
    // Chronological (oldest → newest). `_creationTime` is unique + monotonic
    // per table, so equal-ms seed inserts still order by insertion.
    const sorted = [...scholarRows].sort((a, b) => a.createdAt - b.createdAt);

    const engagementSeriesFull = sorted
      .map((r) => r.engagement)
      .filter((x): x is number => x != null);
    const onTaskSeriesFull = sorted
      .map((r) => r.onTask)
      .filter((x): x is number => x != null);

    // Sparkline = the most recent N engagement readings, oldest → newest.
    const sparkline = engagementSeriesFull.slice(-sparklineMax);

    const latestEngagement =
      engagementSeriesFull.length > 0
        ? engagementSeriesFull[engagementSeriesFull.length - 1]
        : null;
    const latelyEngagementRaw = mean(engagementSeriesFull);
    const latelyOnTaskRaw = mean(onTaskSeriesFull);
    const latelyEngagement =
      latelyEngagementRaw == null ? null : round2(latelyEngagementRaw);
    const latelyOnTask =
      latelyOnTaskRaw == null ? null : round2(latelyOnTaskRaw);

    // Trend uses the full engagement series (not just the plotted tail) so a
    // long history still trends against its own start — but ONLY once there are
    // enough readings to mean something (see TREND_MIN_POINTS). Below the floor
    // we plot the sparkline and stay silent on direction.
    const trendDeltaRaw =
      engagementSeriesFull.length >= TREND_MIN_POINTS
        ? trendDeltaOf(engagementSeriesFull)
        : null;
    const trendDelta = trendDeltaRaw == null ? null : round2(trendDeltaRaw);
    const trend = trendOf(trendDelta);

    // Concerns — newest first for the "most recent concern" ordering.
    const concernNewestFirst: string[] = [];
    let concernCount = 0;
    for (let i = sorted.length - 1; i >= 0; i--) {
      const flags = sorted[i].concernFlags ?? [];
      concernCount += flags.length;
      for (const f of flags) concernNewestFirst.push(f);
    }
    const concernFlags = distinctConcerns(concernNewestFirst, CONCERN_FLAG_CAP);

    // Carry the observer's most-recent NON-EMPTY sentence + suggested step, so
    // the roster can show what's actually happening rather than bare keywords.
    let latestSummary: string | null = null;
    let latestSummaryAt: number | null = null;
    let latestIntervention: string | null = null;
    for (let i = sorted.length - 1; i >= 0; i--) {
      if (latestSummary == null) {
        const s = sorted[i].summary?.trim();
        if (s) {
          latestSummary = s;
          latestSummaryAt = sorted[i].createdAt;
        }
      }
      if (latestIntervention == null) {
        const iv = sorted[i].suggestedIntervention?.trim();
        if (iv) latestIntervention = iv;
      }
      if (latestSummary != null && latestIntervention != null) break;
    }

    const analyzedSessions = new Set(sorted.map((r) => r.sessionId)).size;
    const lastAnalysisAt =
      sorted.length > 0 ? sorted[sorted.length - 1].createdAt : null;

    const scoreInput = {
      concernCount,
      trendDelta,
      latelyEngagement,
      latelyOnTask,
    };

    byScholar[scholarId] = {
      scholarId,
      sparkline,
      latestEngagement:
        latestEngagement == null ? null : round2(latestEngagement),
      latelyEngagement,
      latelyOnTask,
      trendDelta,
      trend,
      concernFlags,
      concernCount,
      latestSummary,
      latestSummaryAt,
      latestIntervention,
      analyzedSessions,
      sampleCount: sorted.length,
      lastAnalysisAt,
      attentionScore: attentionScoreOf(scoreInput),
      attentionLevel: attentionLevelOf(scoreInput),
    };
  }

  return { byScholar };
}
