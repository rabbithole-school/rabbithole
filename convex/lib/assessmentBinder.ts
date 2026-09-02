/**
 * Evidence-binder pure helpers (review/assessment-and-goals-plan.html §6).
 *
 * The binder answers Carl's over-weighting concern STRUCTURALLY, not by
 * exhortation:
 *   • Episodes, not notes — same source+context within a short window collapses
 *     to ONE episode with N sources, so a pile of notes is one data point.
 *   • Distinct contexts, not volume — a claim's strength ("consistently…") is
 *     computed from how many DISTINCT contexts show it, never raw row count.
 *   • Thin evidence is said out loud — a dimension with <2 episodes is flagged,
 *     not stretched (routes the fix to Preflight, not the narrative).
 *
 * Pure over plain data so it's unit-tested without a DB. The Convex query
 * (convex/assessmentBinder.ts) maps rows → EvidenceItem[] and calls these.
 */

export type BinderDimension = "core" | "connections" | "practice" | "identity";
export const BINDER_DIMENSIONS: BinderDimension[] = [
  "core",
  "connections",
  "practice",
  "identity",
];

export interface EvidenceItem {
  /** PCM tag (observer-set or heuristic); null = not attributed to a dimension. */
  dimension: BinderDimension | null;
  source: string; // "mastery" | "granule" | "connection" | "deliverable" | "signal" | "seed"
  summary: string;
  detail?: string;
  at: number; // timestamp (observedAt / _creationTime)
  /** The "distinct context" key — a unit, a domain, a week. Drives claim strength. */
  context: string;
  weight?: "minor" | "major";
  studentInitiated?: boolean;
}

export interface Episode {
  summary: string;
  source: string;
  at: number;
  context: string;
  weight?: "minor" | "major";
  studentInitiated?: boolean;
  /** How many rows collapsed into this episode (a pile of notes = 1 exhibit). */
  sources: number;
}

export type ClaimStrength = "none" | "once" | "regular" | "consistent";

export interface DimensionBrief {
  dimension: BinderDimension;
  episodes: Episode[];
  episodeCount: number;
  distinctContexts: number;
  claimStrength: ClaimStrength;
  studentInitiatedCount: number;
  thin: boolean;
  note: string;
}

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

/** ISO-ish week bucket for collapsing same-context notes in a short window. */
function weekBucket(at: number): number {
  return Math.floor(at / WEEK_MS);
}

/**
 * Collapse items into episodes: same (source, context, week) is ONE episode
 * with `sources` = the collapsed count. Keeps the strongest (major, or latest)
 * item's summary. Sorted newest-first.
 */
export function clusterEpisodes(items: EvidenceItem[]): Episode[] {
  const groups = new Map<string, EvidenceItem[]>();
  for (const it of items) {
    const key = `${it.source}|${it.context}|${weekBucket(it.at)}`;
    const arr = groups.get(key) ?? [];
    arr.push(it);
    groups.set(key, arr);
  }
  const episodes: Episode[] = [];
  for (const arr of groups.values()) {
    // Representative = major first, then most recent.
    const rep = [...arr].sort((a, b) => {
      const am = a.weight === "major" ? 1 : 0;
      const bm = b.weight === "major" ? 1 : 0;
      if (am !== bm) return bm - am;
      return b.at - a.at;
    })[0];
    episodes.push({
      summary: rep.summary,
      source: rep.source,
      at: rep.at,
      context: rep.context,
      weight: arr.some((i) => i.weight === "major") ? "major" : rep.weight,
      studentInitiated: arr.some((i) => i.studentInitiated),
      sources: arr.length,
    });
  }
  return episodes.sort((a, b) => {
    const am = a.weight === "major" ? 1 : 0;
    const bm = b.weight === "major" ? 1 : 0;
    if (am !== bm) return bm - am;
    return b.at - a.at;
  });
}

/** Claim strength from DISTINCT contexts (never raw row count). */
export function claimStrength(distinctContexts: number): ClaimStrength {
  if (distinctContexts >= 3) return "consistent";
  if (distinctContexts === 2) return "regular";
  if (distinctContexts === 1) return "once";
  return "none";
}

/** Human phrasing for a claim strength, per the rubric's own words. */
export function claimStrengthPhrase(s: ClaimStrength): string {
  switch (s) {
    case "consistent":
      return "consistently — across multiple distinct contexts";
    case "regular":
      return "regularly — in two distinct contexts";
    case "once":
      return "observed once";
    case "none":
      return "no evidence recorded";
  }
}

/**
 * Build the four per-dimension briefs from a flat evidence list. Untagged items
 * (dimension === null) are ignored here (they still count toward `total` in the
 * caller) — a brief only speaks to what's clearly attributed.
 */
export function buildDimensionBriefs(
  items: EvidenceItem[],
): Record<BinderDimension, DimensionBrief> {
  const out = {} as Record<BinderDimension, DimensionBrief>;
  for (const dim of BINDER_DIMENSIONS) {
    const dimItems = items.filter((i) => i.dimension === dim);
    const episodes = clusterEpisodes(dimItems);
    const distinctContexts = new Set(episodes.map((e) => e.context)).size;
    const strength = claimStrength(distinctContexts);
    const studentInitiatedCount = episodes.filter((e) => e.studentInitiated).length;
    const thin = episodes.length < 2;
    const note = thin
      ? `Little evidence recorded for ${dim} this period — the curriculum may not have created opportunities (see the unit Review's PCM coverage).`
      : `${episodes.length} episode${episodes.length === 1 ? "" : "s"} across ${distinctContexts} distinct context${distinctContexts === 1 ? "" : "s"} — ${claimStrengthPhrase(strength)}.`;
    out[dim] = {
      dimension: dim,
      episodes,
      episodeCount: episodes.length,
      distinctContexts,
      claimStrength: strength,
      studentInitiatedCount,
      thin,
      note,
    };
  }
  return out;
}

/**
 * Heuristic PCM dimension when the observer left a row untagged. Deliberately
 * conservative — used only to fill obvious gaps; a tagged row always wins.
 */
export function heuristicDimension(
  source: string,
  hint?: { signalType?: string; misconception?: boolean },
): BinderDimension | null {
  switch (source) {
    case "mastery":
    case "granule":
      return "core";
    case "connection":
      return "connections";
    case "deliverable":
      return "practice";
    case "seed":
      return "identity";
    case "signal": {
      const st = hint?.signalType ?? "";
      if (["productive_struggle", "metacognition", "task_commitment"].includes(st))
        return "practice";
      return "identity";
    }
    default:
      return null;
  }
}

/** Coverage label: is this period's evidence mostly on- or off-platform? */
export function coverageLabel(
  onPlatformCount: number,
  offPlatformCount: number,
): "mostly-online" | "mostly-offline" | "balanced" {
  const total = onPlatformCount + offPlatformCount;
  if (total === 0) return "mostly-offline";
  const onRatio = onPlatformCount / total;
  if (onRatio >= 0.66) return "mostly-online";
  if (onRatio <= 0.33) return "mostly-offline";
  return "balanced";
}
