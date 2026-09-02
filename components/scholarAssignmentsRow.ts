/**
 * Pure display-derivation helpers for `ScholarAssignmentsCard` — extracted so
 * the "day-one scholar's Assignments card reads as a duplicate" fix (TRIAGE
 * M10) is testable without rendering. The assignment's own `title` and its
 * unit's `title` are frequently the identical string (e.g. an onboarding
 * assignment named "Welcome to Rabbithole" for the "Welcome to Rabbithole"
 * unit) — showing both the row label AND a detail line then just repeats the
 * same words, reading as an accidental duplicate rather than two facts.
 */

export interface ScholarAssignmentRow {
  title: string;
  unitTitle?: string | null;
  unitEmoji?: string | null;
}

/**
 * The detail line under an assignment row's title. `undefined` suppresses
 * the line entirely (when it would just repeat the row's own title verbatim);
 * otherwise the unit's emoji + title, or a generic fallback when the
 * assignment has no unit at all (e.g. standing practice).
 */
export function assignmentDetailLine(row: ScholarAssignmentRow): string | undefined {
  if (row.unitTitle && row.title === row.unitTitle) return undefined;
  if (row.unitTitle) {
    return `${row.unitEmoji ? `${row.unitEmoji} ` : ""}${row.unitTitle}`;
  }
  return "Active cohort assignment";
}

/**
 * The "(<n>)" suffix for the card's "Assignments" heading — counts only the
 * scholar's own assignment rows. The class focus row (rendered separately
 * under its own "Class focus" sublabel) is a different kind of thing —
 * whole-class, not this scholar's — and must never inflate this count (the
 * original bug: "Assignments (2)" for one real assignment + one class focus).
 */
export function assignmentsHeadingSuffix(assignmentCount: number): string {
  return assignmentCount > 0 ? ` (${assignmentCount})` : "";
}
