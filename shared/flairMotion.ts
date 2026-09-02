/**
 * Earned-flair arrival choreography — the timing and the id arithmetic that the
 * transcript notice and the deliverable chips must agree on, on BOTH frontends.
 *
 * When the tutor mints new flair the transcript notice rises and settles, a beat
 * passes, and the identical chip enters on the work surface. The two surfaces
 * consume the same atomic backend commit: each detects its own arrival and the
 * fixed delay below makes the second motion read as caused by the first.
 *
 * This module imports nothing — `native/scripts/sync-vendor.js` copies it into
 * `native/vendor/shared/` verbatim, so the platform motion definitions (the web
 * keyframes, the Reanimated spring) deliberately stay in their own components.
 * Do not add a `react`, `react-native`, or Reanimated import here.
 */

const noticeEmojiMs = 280;
const handoffGapMs = 120;
const chipLeadAllowanceMs = 60;

export const FLAIR_MOTION = {
  /** Notice row: opacity 0→1 with a 4px rise. */
  noticeRiseMs: 220,
  /** Notice emoji: scale .82 → 1.04 → 1. A settle, not a bounce. */
  noticeEmojiMs,
  /** Row n of a multi-award batch, so the group reads as one event. */
  noticeStaggerMs: 90,
  /** The intended stillness between the notice settling and the chip entering. */
  handoffGapMs,
  /**
   * Small allowance for the two reactive queries to paint at slightly different
   * moments even though their data now lands in one transaction.
   */
  chipLeadAllowanceMs,
  /** Chip entrance delay, measured from the chip's OWN detection. Derived. */
  chipEnterDelayMs: noticeEmojiMs + handoffGapMs + chipLeadAllowanceMs,
  /** Chip n of a batch — slightly tighter than the notice stagger. */
  chipStaggerMs: 80,
  /**
   * Awards past this index reuse its delay, so the whole ceremony stays under
   * ~1.1s no matter how many criteria one check awards.
   */
  maxStaggerIndex: 3,
} as const;

/** The stagger slot for the nth arrival: clamped, never negative. */
export function flairStaggerIndex(index: number): number {
  if (!Number.isFinite(index) || index <= 0) return 0;
  return Math.min(Math.floor(index), FLAIR_MOTION.maxStaggerIndex);
}

/** Delay before the nth notice row of one batch begins its rise. */
export function flairNoticeDelayMs(index: number): number {
  return flairStaggerIndex(index) * FLAIR_MOTION.noticeStaggerMs;
}

/** Delay before the nth arriving chip enters, from this surface's detection. */
export function flairChipDelayMs(index: number): number {
  return (
    FLAIR_MOTION.chipEnterDelayMs +
    flairStaggerIndex(index) * FLAIR_MOTION.chipStaggerMs
  );
}

/**
 * The ids a surface should animate: everything in `ids` it has not already seen.
 *
 * Two cases deliberately animate nothing. `ids === undefined` means the query
 * has not resolved, and a `null` baseline means this is the surface's first
 * resolved snapshot — whatever it finds there was already earned. An id is
 * added to the baseline the moment it is animated (after commit, never during
 * render), so a reconnect, remount, or list recycle can never replay it.
 */
export function flairArrivingIds(
  inert: ReadonlySet<string> | null | undefined,
  ids: readonly string[] | undefined,
): string[] {
  if (!ids || !inert) return [];
  return ids.filter((id) => !inert.has(id));
}
