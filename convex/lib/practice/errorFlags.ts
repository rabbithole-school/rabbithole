/**
 * Windowing + phrasing for practice-derived error flags (Wave C, "C3" —
 * raise-the-ceiling plan §7).
 *
 * The classifier (errorPatterns.ts) turns a wrong answer into a buggy-algorithm
 * label at grade time; submitAnswer logs each classified miss as a
 * `practiceErrorEvents` row. This module is the pure read side: given a
 * scholar's recent events for a node, decide which patterns are currently
 * "open" (recurring enough to be worth a teacher's eye) and how to phrase them.
 *
 * ── AUTO-CLEAR BY CONSTRUCTION ─────────────────────────────────────────────
 * A pattern is open only while ≥ MIN_COUNT of its events fall inside a rolling
 * WINDOW. Nothing has to explicitly "close" a flag — once the scholar stops
 * making that error, its events age past the window and the flag drops on the
 * next read. (Superseding a self-healing signal with a durable teacher record
 * is deliberately NOT done here; that would be a write to the authored record.)
 *
 * ── REDACTION ──────────────────────────────────────────────────────────────
 * Every string here is TEACHER-FACING. The phrasing is growth-framed (§7 table)
 * but still describes a not-yet-stable procedure, so it is never surfaced to a
 * scholar or parent. The gate lives in the callers (nodeDepth.ts /
 * practiceSkills.ts), which only compute these for teacher/admin.
 *
 * Pure module — no Convex imports; unit-tested directly.
 */

import type { ErrorPattern } from "./errorPatterns";

/** Rolling window over which same-pattern misses accumulate toward a flag. */
export const ERROR_FLAG_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;

/** How many same-pattern misses (inside the window) light the flag. */
export const ERROR_FLAG_MIN_COUNT = 3;

/**
 * Teacher-facing, growth-framed phrasing for each pattern (raise-the-ceiling
 * plan §7 table — verbatim). Describes the not-yet-stable procedure, never the
 * child; never comparative.
 */
export const PATTERN_PHRASING: Record<ErrorPattern, string> = {
  SMALLER_FROM_LARGER:
    "Subtracts the smaller digit from the larger in each column — regrouping not yet stable.",
  DROPPED_CARRY: "Adds each column but the carry isn't landing yet.",
  PLACE_MISALIGNMENT:
    "Lines numbers up from the left — place-value link to the algorithm.",
  OFF_BY_ONE_SKIP: "Skip-count sequence slips by one step under load.",
  REMAINDER_IGNORED: "Quotient is right; the remainder is getting dropped.",
  REVERSED_OPERANDS: "Order of the operation isn't yet anchored.",
};

export type ErrorEvent = { pattern: string; createdAt: number };

export type OpenErrorPattern = {
  pattern: ErrorPattern;
  /** Count of this pattern's events inside the window. */
  count: number;
  /** Most-recent event timestamp for this pattern (inside the window). */
  lastAt: number;
  /** When the flag opened: the ERROR_FLAG_MIN_COUNT-th earliest in-window event. */
  openedAt: number;
  /** Growth-framed teacher phrasing. */
  phrasing: string;
};

/**
 * Reduce a node's raw error events to the patterns currently OPEN (≥
 * ERROR_FLAG_MIN_COUNT inside the trailing window ending at `now`). Returns them
 * most-recent-first. Unknown pattern strings (never expected, but defensive) are
 * ignored. Pure — safe to unit-test.
 */
export function openErrorPatterns(
  events: ErrorEvent[],
  now: number,
): OpenErrorPattern[] {
  const since = now - ERROR_FLAG_WINDOW_MS;
  const byPattern = new Map<ErrorPattern, number[]>();

  for (const e of events) {
    if (e.createdAt < since || e.createdAt > now) continue;
    const phrasing = PATTERN_PHRASING[e.pattern as ErrorPattern];
    if (!phrasing) continue; // unknown / retired pattern → skip
    const key = e.pattern as ErrorPattern;
    const times = byPattern.get(key) ?? [];
    times.push(e.createdAt);
    byPattern.set(key, times);
  }

  const open: OpenErrorPattern[] = [];
  for (const [pattern, times] of byPattern) {
    if (times.length < ERROR_FLAG_MIN_COUNT) continue;
    times.sort((a, b) => a - b);
    open.push({
      pattern,
      count: times.length,
      lastAt: times[times.length - 1],
      openedAt: times[ERROR_FLAG_MIN_COUNT - 1],
      phrasing: PATTERN_PHRASING[pattern],
    });
  }
  open.sort((a, b) => b.lastAt - a.lastAt);
  return open;
}

/** An error event tagged with the node it happened on. */
export type NodeErrorEvent = ErrorEvent & { nodeKey: string };

/**
 * One node's open practice flag. Every flag reader goes through this shape
 * (via `openPracticeFlags` in convex/lib/practiceFlags.ts, or
 * `practiceFlagsFromEvents` over rows a caller already holds), so a new
 * opener only has to be added here once.
 */
export type OpenPracticeFlag = {
  nodeKey: string;
  /** The node's open patterns, most-recent-first (never empty). */
  patterns: OpenErrorPattern[];
};

/**
 * Group events by node and keep the nodes with at least one open pattern,
 * most recently reinforced first (`patterns[0].lastAt` desc), ties by
 * `nodeKey` ascending — so `[0]` is the node auto-remediation targets.
 */
export function practiceFlagsFromEvents(
  events: readonly NodeErrorEvent[],
  now: number,
): OpenPracticeFlag[] {
  const byNode = new Map<string, NodeErrorEvent[]>();
  for (const e of events) {
    const list = byNode.get(e.nodeKey);
    if (list) list.push(e);
    else byNode.set(e.nodeKey, [e]);
  }
  const flags: OpenPracticeFlag[] = [];
  for (const [nodeKey, nodeEvents] of byNode) {
    const patterns = openErrorPatterns(nodeEvents, now);
    if (patterns.length > 0) flags.push({ nodeKey, patterns });
  }
  return flags.sort(
    (a, b) =>
      b.patterns[0].lastAt - a.patterns[0].lastAt ||
      (a.nodeKey < b.nodeKey ? -1 : a.nodeKey > b.nodeKey ? 1 : 0),
  );
}

/** True iff at least one pattern is open — the teacher-only node flag. */
export function hasOpenErrorPattern(events: ErrorEvent[], now: number): boolean {
  return openErrorPatterns(events, now).length > 0;
}
