// Pure read-side helpers for the CLASS resolver — the one new primitive behind
// the class-scoped digest + the group's class picker
// (review/class-view-and-shelf-proposal.html §4/§5). A "class" is the implicit
// (groupId, subject) entity the schedule already draws; this file turns a class
// into the inputs the digest generator + picker already eat, WITHOUT a new
// table or a hidden recurrence rule. No Convex or DOM imports so it's trivially
// unit-testable and importable from either runtime, exactly like
// shared/meetingSlots.ts.

/** The class key: trim + lowercase the subject, so "Humanities " and
 *  "Humanities" are one class. The SAME normalization
 *  shared/meetingSlots.deriveClassMeetingPattern uses (open decision #5), so a
 *  class's meeting pattern, its work set, and its digest row all key identically. */
export function classSubjectKey(subject: string): string {
  return subject.trim().toLowerCase();
}

/** The minimal placement shape the resolver reads — structurally a subset of
 *  both the Convex row and the grid query's enriched placement. */
export type ClassPlacementInput = {
  groupId: string;
  subject: string;
  assignmentId?: string | null;
};

/**
 * Distinct assignmentIds linked from a class's placements — the class's WORK
 * SET. Unions BOTH recurring shells and concrete week-stamped rows (§ open
 * decision #1: "the union of assignments linked from the class's placements
 * this period"), deduped, in FIRST-SEEN order. The caller applies recency
 * ordering (it needs the assignment docs' creation times); this pure pass only
 * owns the (groupId, subject) match + dedupe.
 */
export function linkedAssignmentIdsForClass(args: {
  placements: ClassPlacementInput[];
  groupId: string;
  subject: string;
}): string[] {
  const wantSubject = classSubjectKey(args.subject);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const p of args.placements) {
    if (!p.assignmentId) continue;
    if (String(p.groupId) !== String(args.groupId)) continue;
    if (classSubjectKey(p.subject) !== wantSubject) continue;
    const id = String(p.assignmentId);
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

const WEEKDAY_SHORT = ["", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

/** "Mon · Wed · Fri" from a class's meeting weekdays (already sorted + deduped
 *  by the caller). Feeds the picker chip's meeting-pattern summary (§5b). */
export function formatMeetingSummary(weekdays: number[]): string {
  return weekdays
    .map((d) => WEEKDAY_SHORT[d] ?? "")
    .filter(Boolean)
    .join(" · ");
}
