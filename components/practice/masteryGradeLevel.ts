/**
 * masteryGradeLevel — display helpers for a scholar's math grade level.
 *
 * The level itself is NOT computed here. Each domain's number is the server's
 * `gradeValue`: `mathLevel` (convex/lib/practice/frontierGrade.ts) over that
 * domain's rows and catalog, the level the Math Skills portrait, the parent
 * Math Skills tab and the parent aide also read. One definition, so a teacher
 * sees one grade per scholar (#2462). It sits on the Grade Equivalent scale
 * (`gradeEquivalent.ts`): "4.6" is every grade below 4 covered plus six tenths
 * of grade 4's skills, placement check-in credit included. The legacy
 * "highest" figure (`frontierGradeValue`) rides beside it in words.
 */

import { gradeLabelFromRank } from "@/shared/gradeRange";

/**
 * Renders a computed level as the teacher-facing readout — a bare magnitude on
 * the K–8 grade axis, ALWAYS to one decimal, e.g. "3.6". No "Grade " prefix
 * (the column already says what it is). `null` (nothing credited) reads
 * as a calm em-dash. Grade K is level 0.x, shown as "0.0"–"0.9" like any
 * other rung, so the column stays a uniform number.
 */
export function formatMasteryGradeLevel(level: number | null): string {
  if (level === null) return "—";
  return level.toFixed(1);
}

/** "kindergarten" / "grade 4", for the middle of a sentence. */
export function gradeWords(rank: number): string {
  return rank <= 0 ? "kindergarten" : `grade ${gradeLabelFromRank(rank)}`;
}

/**
 * "Highest skill shown: grade 7" for the legacy highest figure, or null when
 * there is none or its whole grade is no higher than the level's. A level of
 * 4.0 means everything through grade 3 is covered, so "highest: grade 3"
 * beside it would read as a contradiction and adds nothing.
 */
export function highestGradeClause(
  level: number | null,
  highest: number | null | undefined,
): string | null {
  if (highest === null || highest === undefined) return null;
  const highestWhole = Math.floor(highest + 1e-9);
  if (level !== null && Math.floor(level + 1e-9) >= highestWhole) return null;
  return `Highest skill shown: ${gradeWords(highestWhole)}`;
}

/**
 * The small line under an area's level: the legacy "highest" grade when its
 * whole number differs from the level's, and where the credit came from.
 */
export function domainDetailLine(d: {
  gradeValue: number | null;
  highestGradeValue: number | null;
  fluentSkills: number;
  placementSkills: number;
}): string | null {
  const parts: string[] = [];
  const highest = highestGradeClause(d.gradeValue, d.highestGradeValue);
  if (highest) parts.push(highest);
  const skills = (n: number) => `${n} ${n === 1 ? "skill" : "skills"}`;
  if (d.fluentSkills > 0 && d.placementSkills > 0) {
    parts.push(
      `${skills(d.fluentSkills)} from daily work, ${d.placementSkills} from the placement check-in`,
    );
  } else if (d.fluentSkills > 0) {
    parts.push(`${skills(d.fluentSkills)} from daily work`);
  } else if (d.placementSkills > 0) {
    parts.push(`${skills(d.placementSkills)} from the placement check-in`);
  }
  return parts.length > 0 ? parts.join(" · ") : null;
}
