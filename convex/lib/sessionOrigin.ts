// Where a session came from — teacher-assigned vs. self-initiated. Kept PURE
// (type-only imports, no ctx) so the observer's origin line
// (observerOrigin.ts) and the offline observer evals can import it without
// loading scholarReads' query graph, which reaches @convex-dev/auth/server —
// an ESM-only export that crashes tsx's CJS loader in `evals/observer/`.

import type { Doc, Id } from "../_generated/dataModel";

/**
 * Classify a session as teacher-ASSIGNED (cohort work) vs SELF-INITIATED
 * (a Quest / Independent Study the scholar chose). Pure — takes the
 * already-resolved unit doc so callers that already loaded it (the session
 * list, the transcript reader) don't re-query.
 *
 * The rule mirrors scholarPlate's origin buckets: a session anchored to an
 * `assignmentId` is assigned; everything else is self-initiated — whether
 * that's the scholar's own Independent Study unit (`unit.authorScholarId`),
 * a seed-spawned exploration (`seedId` / anchorless), or a teacher unit the
 * scholar opened on their own without an assignment. This is what lets the
 * bot stop calling a self-started Quest "an assigned project" — and assess
 * it on its own terms (is the scholar getting value?) instead of against an
 * assignment bar that doesn't exist.
 */
export type SessionOrigin = "assigned" | "selfInitiated";

export function classifySessionOrigin(
  session: Pick<
    Doc<"sessions">,
    "assignmentId" | "seedId" | "activityId" | "unitId"
  >,
  unit: { authorScholarId?: Id<"users"> | null } | null,
): {
  origin: SessionOrigin;
  originLabel: string;
  isIndependentStudyUnit: boolean;
  fromSeed: boolean;
} {
  const isIndependentStudyUnit = unit?.authorScholarId != null;
  const fromSeed =
    session.seedId != null || (!session.activityId && !session.unitId);

  if (session.assignmentId != null) {
    return {
      origin: "assigned",
      originLabel: "Teacher-assigned (part of a cohort assignment)",
      isIndependentStudyUnit,
      fromSeed,
    };
  }

  let originLabel: string;
  if (isIndependentStudyUnit) {
    originLabel =
      "Self-initiated — the scholar's OWN Independent Study unit (they chose this, it was not assigned)";
  } else if (fromSeed) {
    originLabel =
      "Self-initiated — an open exploration the scholar started by following their own curiosity (not assigned)";
  } else {
    originLabel =
      "Self-initiated — the scholar opened this on their own, not through a teacher assignment";
  }
  return {
    origin: "selfInitiated",
    originLabel,
    isIndependentStudyUnit,
    fromSeed,
  };
}
