// A unit's grade level is one grade or a span within K–8, stored in one form
// (`shared/unitGrade.ts`). Every writer that takes a grade normalizes it with
// `resolveUnitGradeEdit` and refuses one it can't read, so the catalog stays
// filterable. A value is checked only when it changes: a legacy unit still
// saves its other fields. A scholar's own unit (a quest) has no grade rules,
// matching the subject rule.

import { ConvexError } from "convex/values";
import { normalizeUnitGrade } from "../../shared/unitGrade";

/** The expected form, said the same way to the model and in an error. */
const UNIT_GRADE_FORMAT =
  'one grade from K to 8, like "5" or "K", or a span written low-high, like "3-5" or "K-2"';

/** The tool-input description of a unit's grade level. */
export const UNIT_GRADE_DESCRIPTION = `The grade or grades this unit is for: ${UNIT_GRADE_FORMAT}. Leave it out if the teacher didn't say.`;

/** How a grade given to a unit writer lands on the unit. */
export type UnitGradeEdit =
  /** Store this (undefined clears the grade). It equals the unit's current
   *  value when the grade was re-sent; callers write only a change. */
  | { kind: "write"; gradeLevel: string | undefined }
  /** Not a grade within K–8 in any form we read: write nothing. */
  | { kind: "unreadable"; given: string };

/** Case- and spacing-blind form of a grade, for "is this the same grade
 *  re-sent". */
function resentKey(grade: string): string {
  return grade.replace(/\s+/g, " ").trim().toLowerCase();
}

/**
 * The one rule for setting a unit's grade, shared by `units.create`,
 * `units.update`, the aide's `create_unit` and every bot's `update_unit`
 * (`applyUnitMetadata`). Pass `{}` for a unit not yet created. Blank clears.
 * A scholar's own unit keeps free text. Re-sending the current grade, in any
 * case or spacing, keeps it as stored (legacy or not), so saving another field
 * of an old unit still works. Anything else is stored in the one form, or
 * refused.
 */
export function resolveUnitGradeEdit(
  unit: { gradeLevel?: string; authorScholarId?: unknown },
  given: string | null,
): UnitGradeEdit {
  const grade = given?.trim() ?? "";
  if (!grade) return { kind: "write", gradeLevel: undefined };
  if (unit.authorScholarId) return { kind: "write", gradeLevel: grade };
  if (unit.gradeLevel !== undefined && resentKey(grade) === resentKey(unit.gradeLevel)) {
    return { kind: "write", gradeLevel: unit.gradeLevel };
  }
  const gradeLevel = normalizeUnitGrade(grade);
  return gradeLevel ? { kind: "write", gradeLevel } : { kind: "unreadable", given: grade };
}

/** What a person or the model is told when a grade can't be read. */
export function unitGradeUnreadableMessage(given: string): string {
  return `"${given}" isn't a grade level. A unit's grade is ${UNIT_GRADE_FORMAT}.`;
}

/** What `create_unit` / `update_unit` tell the model when the grade can't be
 *  read. Nothing in the call was written. */
export function unitGradeUnreadable(toolName: string, given: string): string {
  return `Nothing in this call was saved (no other field either): ${unitGradeUnreadableMessage(given)} Call ${toolName} again with gradeLevel in that form, or without it if you don't know the grade, along with everything else you meant to send.`;
}

const UNIT_GRADE_UNREADABLE = "unit_grade_unreadable";

/** Thrown inside a unit-writing mutation when the grade can't be read, so
 *  nothing is written. */
export function unitGradeUnreadableError(given: string) {
  return new ConvexError({
    code: UNIT_GRADE_UNREADABLE,
    given,
    message: unitGradeUnreadableMessage(given),
  });
}

/** The unreadable grade when `error` came from `unitGradeUnreadableError`;
 *  otherwise null. */
export function unitGradeUnreadableGiven(error: unknown): string | null {
  if (!(error instanceof ConvexError)) return null;
  const data: unknown = error.data;
  if (typeof data !== "object" || data === null) return null;
  const record = data as Record<string, unknown>;
  if (record.code !== UNIT_GRADE_UNREADABLE) return null;
  return typeof record.given === "string" ? record.given : "";
}
