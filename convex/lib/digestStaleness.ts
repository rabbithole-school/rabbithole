// Pure staleness / watermark comparison for class digests.
//
// No Convex `ctx` — inputs → output, unit-testable in plain Vitest. The
// Convex side (read-time staleness in `convex/classDigests.ts` and the
// suppression filter in `convex/teacherToday.ts`) computes the current
// counts + source watermark and hands them here.
//
// The "source watermark" is the newest observer-analysis time and newest
// message time across the sessions a digest collated. A digest generated
// mid-session goes stale once a later analysis / message advances that
// watermark, even when completion/deliverable counts never change — the
// Leilani "cut off" vs. "resolved" contradiction (see
// review/pilotT1/invest/dayend-coherence.md §B).

export type DigestSourceSnapshot = {
  completedCount: number;
  startedCount: number;
  deliverableCount: number;
  // Optional/additive: absent on digests generated before watermarks
  // existed. Absent == that field's watermark check is skipped, so legacy
  // rows behave exactly as before.
  latestAnalysisAt?: number;
  latestMessageAt?: number;
};

export type DigestSourceCurrent = {
  completedCount: number;
  startedCount: number;
  deliverableCount: number;
  latestAnalysisAt?: number;
  latestMessageAt?: number;
};

export type DigestStaleness = {
  stale: boolean;
  newSince: number;
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
  current: { latestAnalysisAt?: number; latestMessageAt?: number },
): boolean {
  if (!snap) return false;
  const analysisAdvanced =
    snap.latestAnalysisAt !== undefined &&
    (current.latestAnalysisAt ?? 0) > snap.latestAnalysisAt;
  const messageAdvanced =
    snap.latestMessageAt !== undefined &&
    (current.latestMessageAt ?? 0) > snap.latestMessageAt;
  return analysisAdvanced || messageAdvanced;
}

/**
 * Staleness of a digest vs. current cohort source. Stale when the
 * completion + deliverable COUNT grew (as before) OR the analysis / message
 * watermark advanced. `newSince` is the count delta only — the watermark has
 * no cardinality to surface, so a watermark-only advance reports 0.
 */
export function digestStaleness(
  snap: DigestSourceSnapshot | undefined,
  current: DigestSourceCurrent,
): DigestStaleness {
  if (!snap) {
    return {
      stale: false,
      newSince: 0,
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
    countGrew,
    watermarkAdvanced: wmAdvanced,
  };
}
