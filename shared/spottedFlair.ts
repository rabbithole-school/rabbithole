/**
 * Spotted flair joins a deliverable's flair strip (web + iPad `FlairChips`).
 *
 * Deliverable flair is keyed to a rubric criterion; spotted flair is the
 * observer's award for an idea no criterion listed, stored on the session
 * (convex/lib/spottedFlair.ts). The strip renders both the same way, so this
 * folds a session's spotted awards into the two lists the strip already reads:
 * each award becomes a flair entry plus a criterion carrying its label.
 */

export interface SpottedFlairView {
  id: string;
  label: string;
  note: string;
  earnedAt: number;
  /** The scholar's words that earned it; present only for teaching staff. */
  excerpt?: string;
  /** Teaching staff who may also take it back (not read-only, not viewing as). */
  canRemove?: boolean;
}

export function withSpottedFlair<
  F extends { criterionId: string; earnedAt: number; note?: string },
  C extends { id: string; label: string },
>(
  flairEarned: F[] | undefined,
  criteria: C[],
  spotted: SpottedFlairView[] | undefined,
): {
  flairEarned: Array<F | { criterionId: string; earnedAt: number; note: string }>;
  criteria: Array<C | { id: string; label: string }>;
} {
  if (!spotted || spotted.length === 0) {
    return { flairEarned: flairEarned ?? [], criteria };
  }
  return {
    flairEarned: [
      ...(flairEarned ?? []),
      ...spotted.map((flair) => ({
        criterionId: flair.id,
        earnedAt: flair.earnedAt,
        note: flair.note,
      })),
    ],
    criteria: [
      ...criteria,
      ...spotted.map((flair) => ({ id: flair.id, label: flair.label })),
    ],
  };
}
