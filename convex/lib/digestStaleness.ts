// Pure staleness / watermark comparison + header copy for class digests.
//
// No Convex `ctx` — inputs → output, unit-testable in plain Vitest. The
// Convex side (read-time staleness in `convex/classDigests.ts` and the
// suppression filter in `convex/teacherToday.ts`) computes the current
// counts + source watermark and hands them here.
//
// The "source watermark" is the newest observer-analysis time, newest message
// time, and newest ACTIVITY-COMPLETION time across the source a digest
// collated. A digest generated mid-session goes stale once a later analysis /
// message advances that watermark, even when completion/deliverable counts
// never change — the Leilani "cut off" vs. "resolved" contradiction (see
// review/pilotT1/invest/dayend-coherence.md §B). The completion leg is what
// makes "someone finished since this was written" a first-class staleness
// reason instead of a count side effect: it is the one event a teacher reads
// the digest right before a family conversation about.

export type DigestSourceSnapshot = {
  completedCount: number;
  startedCount: number;
  deliverableCount: number;
  // Optional/additive: absent on digests generated before watermarks
  // existed. Absent == that field's watermark check is skipped, so legacy
  // rows behave exactly as before. (For completions specifically, a legacy
  // row loses nothing: `completedCount` growth already stales it.)
  latestAnalysisAt?: number;
  latestMessageAt?: number;
  latestCompletionAt?: number;
};

export type DigestSourceCurrent = {
  completedCount: number;
  startedCount: number;
  deliverableCount: number;
  latestAnalysisAt?: number;
  latestMessageAt?: number;
  latestCompletionAt?: number;
};

export type DigestStaleness = {
  stale: boolean;
  newSince: number;
  /** Scholars who finished since the digest was written (never negative). */
  completionsSince: number;
  countGrew: boolean;
  watermarkAdvanced: boolean;
};

/**
 * Whether the digest's source watermark advanced past the snapshot. A
 * snapshot field that is ABSENT (a digest predating watermarks) is skipped
 * entirely — absent == no watermark check — so legacy rows are never marked
 * stale on watermark grounds.
 */
export function watermarkAdvanced(
  snap: DigestSourceSnapshot | undefined,
  current: {
    latestAnalysisAt?: number;
    latestMessageAt?: number;
    latestCompletionAt?: number;
  },
): boolean {
  if (!snap) return false;
  const analysisAdvanced =
    snap.latestAnalysisAt !== undefined &&
    (current.latestAnalysisAt ?? 0) > snap.latestAnalysisAt;
  const messageAdvanced =
    snap.latestMessageAt !== undefined &&
    (current.latestMessageAt ?? 0) > snap.latestMessageAt;
  const completionAdvanced =
    snap.latestCompletionAt !== undefined &&
    (current.latestCompletionAt ?? 0) > snap.latestCompletionAt;
  return analysisAdvanced || messageAdvanced || completionAdvanced;
}

/**
 * Staleness of a digest vs. current cohort source. Stale when the
 * completion + deliverable COUNT grew (as before) OR the analysis / message /
 * completion watermark advanced. `newSince` is the count delta only — the
 * watermark has no cardinality to surface, so a watermark-only advance
 * reports 0. `completionsSince` isolates the completion delta so the nudge
 * can name what actually changed.
 */
export function digestStaleness(
  snap: DigestSourceSnapshot | undefined,
  current: DigestSourceCurrent,
): DigestStaleness {
  if (!snap) {
    return {
      stale: false,
      newSince: 0,
      completionsSince: 0,
      countGrew: false,
      watermarkAdvanced: false,
    };
  }
  const before = snap.completedCount + snap.deliverableCount;
  const after = current.completedCount + current.deliverableCount;
  const countGrew = after > before;
  const wmAdvanced = watermarkAdvanced(snap, current);
  return {
    stale: countGrew || wmAdvanced,
    newSince: countGrew ? after - before : 0,
    completionsSince: Math.max(
      0,
      current.completedCount - snap.completedCount,
    ),
    countGrew,
    watermarkAdvanced: wmAdvanced,
  };
}

/**
 * The one stale nudge, worded for what actually moved. ONE stale state with
 * an accurate noun — not a second treatment: a completion is the change a
 * teacher most needs named before they act on a digest, and a watermark-only
 * advance has no cardinality to report (it used to read "0 new since").
 */
export function digestStaleNote(stale: {
  newSince: number;
  completionsSince: number;
}): string {
  if (stale.completionsSince > 0) {
    return `written before ${stale.completionsSince} ${
      stale.completionsSince === 1 ? "scholar" : "scholars"
    } finished — regenerate to see what changed`;
  }
  if (stale.newSince > 0) {
    return `${stale.newSince} new since — regenerate for the latest`;
  }
  return "new work since — regenerate for the latest";
}

/**
 * The digest header's count line — the ONLY place the digest states counts.
 *
 * The prose body is forbidden from narrating completion (the run record owns
 * that signal; see `convex/classDigestActions.ts`), so this line carries it,
 * and therefore has to read correctly at n=1: "1 activity done", never the
 * "1 activities done" the teacher saw on the walkthrough.
 */
export function digestMetaLine(
  scope: "activity" | "cohort",
  current: { completedCount: number; startedCount: number; deliverableCount: number },
): string {
  if (scope === "activity") {
    return `${current.completedCount} done · ${current.startedCount} started · ${current.deliverableCount} submitted`;
  }
  const noun = current.completedCount === 1 ? "activity" : "activities";
  return `${current.completedCount} ${noun} done · ${current.startedCount} active`;
}
