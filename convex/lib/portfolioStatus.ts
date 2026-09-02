// Pure resolution logic for inbox/portfolio items. An item has TWO fields a
// human (or the AI) must resolve before it's fully filed:
//   - scholar    (matchStatus + scholarId)
//   - assignment (assignmentStatus + assignmentId)
// It only counts as "Processed" when BOTH are resolved; otherwise it's "To
// Review". Kept pure so the bucket logic is unit-testable and shared between
// the scanner-feed query and any other surface.

export interface ResolvableItem {
  matchStatus: "unmatched" | "ambiguous" | "matched" | "confirmed";
  scholarId?: unknown | null;
  assignmentStatus?: "unresolved" | "matched" | "confirmed" | "none" | null;
}

/** Scholar is decided: auto-matched or teacher-confirmed, with an id present. */
export function scholarResolved(item: ResolvableItem): boolean {
  return (
    (item.matchStatus === "matched" || item.matchStatus === "confirmed") &&
    item.scholarId != null
  );
}

/**
 * Assignment is decided: AI-matched, teacher-confirmed, or explicitly "none"
 * (not assignment-related). `undefined`/"unresolved" means still open.
 */
export function assignmentResolved(item: ResolvableItem): boolean {
  const s = item.assignmentStatus;
  return s === "matched" || s === "confirmed" || s === "none";
}

/** Fully filed — both axes resolved. */
export function isProcessed(item: ResolvableItem): boolean {
  return scholarResolved(item) && assignmentResolved(item);
}

/** Needs a human to fill in scholar and/or assignment. */
export function needsReview(item: ResolvableItem): boolean {
  return !isProcessed(item);
}

/** Which fields are still open — drives what pickers the review row shows. */
export function openFields(item: ResolvableItem): {
  scholar: boolean;
  assignment: boolean;
} {
  return {
    scholar: !scholarResolved(item),
    assignment: !assignmentResolved(item),
  };
}

/**
 * Decide the assignment field for an ingested item from the AI's guess.
 * Conservative (per spec — don't classify when uncertain):
 *   - no active assignments at all → "none" (nothing to tag)
 *   - guessed a real assignment AND the matched scholar is enrolled → "matched"
 *   - otherwise → "unresolved" (teacher reviews)
 */
export function resolveAssignment(
  guessId: string | null | undefined,
  scholarId: string | null | undefined,
  assignments: { id: string; scholarIds: string[] }[],
): { assignmentId?: string; assignmentStatus: "unresolved" | "matched" | "none" } {
  if (assignments.length === 0) return { assignmentStatus: "none" };
  if (!guessId || !scholarId) return { assignmentStatus: "unresolved" };
  const a = assignments.find((x) => x.id === guessId);
  if (!a) return { assignmentStatus: "unresolved" };
  if (!a.scholarIds.includes(scholarId)) return { assignmentStatus: "unresolved" };
  return { assignmentId: guessId, assignmentStatus: "matched" };
}
