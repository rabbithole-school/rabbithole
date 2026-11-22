/**
 * A curriculum unit's grade level (`units.gradeLevel`): one grade or a span of
 * grades within K–8, stored one way so it can be read, filtered and compared.
 *
 * Canonical form: the bare grade token from `gradeRange` ("K", "1".."8") for
 * one grade, or two tokens joined by a plain hyphen, low first, for a span
 * ("3-5", "K-2"). That is how most units were already written, and what a
 * teacher or the aide types; screens show it through `unitGradeDisplay`
 * ("Grade 3–5", "Kindergarten").
 *
 * `normalizeUnitGrade` reads the ways people wrote it before the picker
 * ("3rd-5th", "Grades 3 to 5", "k-1", "5th grade", "Grade 5 enrichment") and
 * returns null for anything else, so a caller can leave it alone or ask again.
 * Single grades go through the existing grade seams (`normalizeGradeTag`,
 * `gradeRank`); this module only adds the span and the K–8 bounds.
 */
import { normalizeGradeTag } from "./grade";
import { formatGradeRange, gradeLabel, gradeLabelFromRank, gradeRank } from "./gradeRange";

/** The grades a unit can name: kindergarten (rank 0) through grade 8. */
export const UNIT_GRADE_LOWEST = 0;
export const UNIT_GRADE_HIGHEST = 8;

/** A unit's grades as `gradeRange` ranks, `from` <= `to`. */
export type UnitGradeSpan = { from: number; to: number };

// One grade as written: an optional "Grade"/"Gr."/"G" prefix, then K,
// Kindergarten, or a number with an optional ordinal ("5", "5th").
// The prefix repeats the one `normalizeGradeTag` (shared/grade.ts) strips:
// change both together.
const GRADE = String.raw`(?:grades?|gr\.?|g)?\s*(kindergarten|k|\d{1,2}(?:st|nd|rd|th)?)`;
const UNIT_GRADE = new RegExp(
  String.raw`^${GRADE}(?:\s*(?:-|–|—|to|through|thru)\s*${GRADE})?` +
    // A trailing "grade(s)", then at most a few plain words, each one a
    // known descriptor (below); no digits, so "3-5, 7" is not read as 3-5.
    String.raw`(?:\s*grades?)?(?:\s+([a-z][a-z\s]*))?$`,
  "i",
);

/** The only words allowed after the grade: ones that describe the unit
 *  without changing which grades it is for ("Grade 5 enrichment"). Anything
 *  else ("7-8 year olds", "5 and up", "5 k") is not read as a grade. */
const DESCRIPTOR_WORDS = new Set([
  "enrichment", "extension", "advanced", "accelerated", "honors", "gifted", "only",
]);

function tokenRank(token: string): number | null {
  const bare = token.toLowerCase() === "kindergarten" ? "K" : token.replace(/(st|nd|rd|th)$/i, "");
  return gradeRank(normalizeGradeTag(bare));
}

function inUnitRange(rank: number | null): rank is number {
  return rank !== null && rank >= UNIT_GRADE_LOWEST && rank <= UNIT_GRADE_HIGHEST;
}

/** The span a grade-level string names, or null when it is blank, can't be
 *  read, or reaches outside K–8. */
export function parseUnitGrade(raw: string | null | undefined): UnitGradeSpan | null {
  const match = UNIT_GRADE.exec(raw?.trim() ?? "");
  if (!match) return null;
  const [, first, second, descriptor] = match;
  if (descriptor?.trim().toLowerCase().split(/\s+/).some((w) => !DESCRIPTOR_WORDS.has(w))) {
    return null;
  }
  const a = tokenRank(first);
  const b = second === undefined ? a : tokenRank(second);
  if (!inUnitRange(a) || !inUnitRange(b)) return null;
  return { from: Math.min(a, b), to: Math.max(a, b) };
}

/** The canonical text for a span: "5", "K", "3-5", "K-2". */
export function unitGradeText(span: UnitGradeSpan): string {
  const from = gradeLabelFromRank(span.from);
  return span.from === span.to ? from : `${from}-${gradeLabelFromRank(span.to)}`;
}

/** The canonical form of a grade-level string, or null when it can't be read
 *  (see `parseUnitGrade`). Callers treat a blank value as "no grade" first. */
export function normalizeUnitGrade(raw: string | null | undefined): string | null {
  const span = parseUnitGrade(raw);
  return span ? unitGradeText(span) : null;
}

/** How a unit's grade reads on screen: "Grade 3–5", "Kindergarten", the
 *  stored text as-is when it can't be read, or null when there is none. */
export function unitGradeDisplay(raw: string | null | undefined): string | null {
  const trimmed = raw?.trim() ?? "";
  if (!trimmed) return null;
  const span = parseUnitGrade(trimmed);
  if (!span) return trimmed;
  return span.from === span.to
    ? gradeLabel(gradeLabelFromRank(span.from))
    : formatGradeRange(span.from, span.to);
}

/** What the grade picker shows for a unit's saved grade: the span it names,
 *  or (`unreadable`) the saved text when it names none, which the picker
 *  shows as-is until someone picks. */
export function unitGradePickerState(raw: string | null | undefined): {
  span: UnitGradeSpan | null;
  unreadable: string | null;
} {
  const trimmed = raw?.trim() ?? "";
  if (!trimmed) return { span: null, unreadable: null };
  const span = parseUnitGrade(trimmed);
  return span ? { span, unreadable: null } : { span: null, unreadable: trimmed };
}

/** The grade to save when the picker's first grade changes (null clears it).
 *  A single grade stays single; a span keeps its last grade while that is
 *  still above the new first one. */
export function withUnitGradeFrom(current: UnitGradeSpan | null, from: number | null): string | null {
  if (from === null) return null;
  const to = current && current.to > current.from && current.to > from ? current.to : from;
  return unitGradeText({ from, to });
}

/** The grade to save when the picker's last grade changes. */
export function withUnitGradeTo(current: UnitGradeSpan | null, to: number): string {
  const from = current ? Math.min(current.from, to) : to;
  return unitGradeText({ from, to: Math.max(from, to) });
}

/** The Curriculum list's Grade filter options: every single grade some unit
 *  covers, lowest first, as canonical tokens ("K", "1".."8"). A unit for
 *  "3-5" offers 3, 4 and 5; one whose grade can't be read offers nothing. */
export function unitGradeFilterOptions(
  units: readonly { gradeLevel?: string | null }[],
): string[] {
  const covered = new Set<number>();
  for (const unit of units) {
    const span = parseUnitGrade(unit.gradeLevel);
    if (!span) continue;
    for (let rank = span.from; rank <= span.to; rank++) covered.add(rank);
  }
  return [...covered].sort((a, b) => a - b).map(gradeLabelFromRank);
}

/** Whether a unit belongs under the Grade filter's pick: its span covers the
 *  picked grade, so a "3-5" unit shows under grade 4. A unit with no readable
 *  grade shows under none. */
export function unitFitsGradeFilter(
  gradeLevel: string | null | undefined,
  grade: string,
): boolean {
  const span = parseUnitGrade(gradeLevel);
  const pick = parseUnitGrade(grade);
  if (!span || !pick) return false;
  return span.from <= pick.from && pick.to <= span.to;
}
