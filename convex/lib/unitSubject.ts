// The aide always names a subject on a unit it creates (TRA-723): the scholar's
// subject tabs, class filing and end-of-term reports all sort a unit by its
// subject, and a unit with none lands nowhere. One home for the check and the
// wording, shared by every aide tool that can create a unit (create_unit,
// make_app_a_coached_activity). Teacher-typed units and the CLI installer keep
// the subject optional.
//
// A school's subjects are its classes (`schoolSubjectOptions` in
// lib/classLink.ts). When the school has classes, an aide-written subject must
// be one of them: `resolveUnitSubject` maps a near miss ("Social Studies") to
// the one class it fits ("Humanities") and otherwise asks again with the list.

import { ConvexError } from "convex/values";
import { classSubjectKey, unitSubjectFitsClass } from "./classResolver";

/** The tool-input description of a unit's subject. */
export const UNIT_SUBJECT_DESCRIPTION =
  'The one class on the school\'s timetable this unit belongs to, by the class\'s name (e.g., "Science" or "Math"), never the unit\'s topic. The scholar\'s subject tabs, class filing and end-of-term reports all sort the unit by this. If you don\'t know the class names, give the broad subject: the tool files it under the class that fits, or lists the classes to choose from.';

/** Words that fill the field without naming a subject. */
const PLACEHOLDER_SUBJECTS = new Set([
  "general", "n/a", "na", "none", "other", "misc", "miscellaneous", "tbd", "unknown",
]);

/** The trimmed subject, or null when it names no subject: missing, blank, or
 *  a placeholder ("general", "n/a", "tbd"…). */
export function unitSubjectInput(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const subject = raw.trim();
  const folded = subject.toLowerCase();
  if (!folded || PLACEHOLDER_SUBJECTS.has(folded)) return null;
  return subject;
}

/** What a tool tells the model when a new unit would have no real subject. */
export function unitSubjectAskAgain(toolName: string): string {
  return `No unit was created: a new unit needs a subject. Choose the class this unit belongs to (a class on the school's timetable, such as Science or Math), not a placeholder like "general", and call ${toolName} again with subject set.`;
}

/** How an aide-written subject lands against the school's class list. */
export type UnitSubjectResolution =
  /** Nothing usable was named (missing, blank or a placeholder) at a
   *  school with no classes. */
  | { kind: "missing" }
  /** Write `subject`. `mapped` when it is a different class name than the
   *  words the model passed, so the tool result can say where it was filed. */
  | { kind: "ok"; subject: string; mapped: boolean }
  /** Not one of the school's classes and not a clear fit for exactly one,
   *  or (at a school with classes) no real subject at all. */
  | { kind: "ask"; given: string; options: string[] };

/**
 * Resolve a subject the model passed against the school's class subjects.
 * With no classes the old rule stands (any real subject). Otherwise an exact
 * class name (any case) wins, then the single class it fits by meaning
 * (`unitSubjectFitsClass`); two fits or none ask again.
 */
export function resolveUnitSubject(
  raw: unknown,
  options: readonly string[],
): UnitSubjectResolution {
  const subject = unitSubjectInput(raw);
  if (options.length === 0) {
    return subject ? { kind: "ok", subject, mapped: false } : { kind: "missing" };
  }
  // A school with classes always answers with its list, placeholder or not.
  if (!subject) {
    return {
      kind: "ask",
      given: typeof raw === "string" ? raw.trim() : "",
      options: [...options],
    };
  }
  const key = classSubjectKey(subject);
  const exact = options.find((o) => classSubjectKey(o) === key);
  if (exact) return { kind: "ok", subject: exact, mapped: false };
  const fits = options.filter((o) => unitSubjectFitsClass(subject, o));
  if (fits.length === 1) return { kind: "ok", subject: fits[0], mapped: true };
  return { kind: "ask", given: subject, options: [...options] };
}

/** How an edit to an EXISTING unit's subject lands. */
export type UnitSubjectEdit =
  /** Write this (undefined clears the subject). `mapped` when it is a class
   *  name other than the words given, so a caller can say where it went. */
  | { kind: "write"; subject: string | undefined; mapped: boolean }
  /** Not one of the school's classes and no clear fit: write nothing. */
  | { kind: "ask"; given: string; options: string[] };

/** Case- and spacing-blind form of a subject, for "is this the same subject
 *  re-sent" (not for matching classes, which `classSubjectKey` keys). */
function resentKey(subject: string): string {
  return subject.replace(/\s+/g, " ").trim().toLowerCase();
}

/**
 * The one rule for changing an existing unit's subject (TRA-723), shared by
 * the web editor (`units.update`) and the aide's `update_unit`. Clearing is
 * allowed, and a scholar's own unit never takes a class. Re-sending the
 * current subject keeps it as stored, so saving another field of a unit
 * whose old subject is not a class still works; a re-send that differs only
 * in case or spacing takes a class's exact spelling when it names one of the
 * school's classes ("math" for "Math") and is otherwise kept, never re-filed
 * by meaning. Anything else resolves
 * against the school's classes (`resolveUnitSubject`), read through
 * `loadOptions` only when needed; a placeholder at a school with no classes
 * is written as typed, the old rule.
 */
export async function resolveUnitSubjectEdit(
  unit: { subject?: string; authorScholarId?: unknown },
  given: string | null,
  loadOptions: () => Promise<readonly string[]>,
): Promise<UnitSubjectEdit> {
  const subject = given?.trim() ?? "";
  if (!subject) return { kind: "write", subject: undefined, mapped: false };
  const stored = unit.subject?.trim() ?? "";
  const keep = { kind: "write" as const, subject: unit.subject, mapped: false };
  if (subject === stored) return keep;
  if (unit.authorScholarId) return { kind: "write", subject, mapped: false };
  const options = await loadOptions();
  const resolved = resolveUnitSubject(subject, options);
  if (stored && resentKey(subject) === resentKey(stored)) {
    // Only a class's own spelling replaces the stored one; with no classes
    // there is none, so a case-only re-send is not an edit.
    return options.length > 0 && resolved.kind === "ok" && !resolved.mapped
      ? { kind: "write", subject: resolved.subject, mapped: false }
      : keep;
  }
  if (resolved.kind === "ok") {
    return { kind: "write", subject: resolved.subject, mapped: resolved.mapped };
  }
  if (resolved.kind === "missing") return { kind: "write", subject, mapped: false };
  return { kind: "ask", given: resolved.given, options: resolved.options };
}

/** What a tool tells the model when the subject is not one of the school's
 *  classes. Nothing was written. */
export function unitSubjectNotAClass(
  toolName: string,
  given: string,
  options: readonly string[],
): string {
  const what = given
    ? `"${given}" is not one of this school's classes`
    : "no class was named";
  return `Nothing in this call was saved (no other field either): ${what}, and a unit's subject is the class it belongs to. Pick one of: ${options.join(", ")}. Then call ${toolName} again with subject set to it, along with anything else you meant to change.`;
}

/** The line a tool adds when it filed the unit under a class name other than
 *  the words it was given. */
export function unitSubjectFiledNote(subject: string): string {
  return `Filed under ${subject}, the school's class for that subject.`;
}

const UNIT_SUBJECT_REQUIRED = "unit_subject_required";
const UNIT_SUBJECT_NOT_A_CLASS = "unit_subject_not_a_class";

/** Thrown inside the unit-creating mutation when the caller asked for a
 *  subject on a NEW unit and gave none, so nothing is written. */
export function unitSubjectRequiredError() {
  return new ConvexError({ code: UNIT_SUBJECT_REQUIRED });
}

/** Thrown inside the unit-creating mutation when the subject is not one of
 *  the school's classes and fits none (or several) of them. */
export function unitSubjectNotAClassError(given: string, options: readonly string[]) {
  return new ConvexError({
    code: UNIT_SUBJECT_NOT_A_CLASS,
    given,
    options: [...options],
  });
}

function convexErrorData(error: unknown): Record<string, unknown> | null {
  if (!(error instanceof ConvexError)) return null;
  const data: unknown = error.data;
  if (typeof data !== "object" || data === null || Array.isArray(data)) return null;
  return data as Record<string, unknown>;
}

export function isUnitSubjectRequiredError(error: unknown): boolean {
  // Built by unitSubjectRequiredError above: `{ code: UNIT_SUBJECT_REQUIRED }`.
  return convexErrorData(error)?.code === UNIT_SUBJECT_REQUIRED;
}

/** The given subject and the school's options when `error` came from
 *  `unitSubjectNotAClassError`; otherwise null. */
export function unitSubjectNotAClassDetails(
  error: unknown,
): { given: string; options: string[] } | null {
  const data = convexErrorData(error);
  if (data?.code !== UNIT_SUBJECT_NOT_A_CLASS) return null;
  const given = typeof data.given === "string" ? data.given : "";
  const options = Array.isArray(data.options)
    ? data.options.filter((o): o is string => typeof o === "string")
    : [];
  return { given, options };
}
