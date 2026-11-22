/**
 * Subject helpers. The unit-list Subject filters (teacher Curriculum list,
 * Assign picker, scholar unit picker) group and match by meaning through the
 * class matcher (TRA-723); `uniqueSubjects` / `subjectMatches` stay exact for
 * the scholar's subject tabs, whose names are class names.
 */

import { subjectDisciplines } from "../convex/lib/classResolver";

/**
 * Distinct, non-empty subjects from a units array, deduped
 * case-insensitively (first-seen casing wins) and sorted alphabetically.
 */
export function uniqueSubjects(
  units: { subject?: string | null }[],
): string[] {
  const byFolded = new Map<string, string>();
  for (const u of units) {
    const s = u.subject?.trim();
    if (!s) continue;
    const folded = s.toLowerCase();
    if (!byFolded.has(folded)) byFolded.set(folded, s);
  }
  return [...byFolded.values()].sort((a, b) => a.localeCompare(b));
}

/** Case-insensitive subject match — used when filtering a unit list. */
export function subjectMatches(
  unitSubject: string | null | undefined,
  selected: string,
): boolean {
  return (unitSubject?.trim().toLowerCase() ?? "") === selected.toLowerCase();
}

/** What a filter option or unit subject names, by meaning: its school
 *  subjects from the class matcher ("Mathematics" and "Math" are both math),
 *  or, when it names none ("Workshop", "(TBD)"), the subject itself. */
function filterParts(subject: string | null | undefined): string[] {
  const trimmed = subject?.trim();
  if (!trimmed) return [];
  const disciplines = subjectDisciplines(trimmed);
  return disciplines.length > 0
    ? disciplines
    : [trimmed.replace(/\s+/g, " ").toLowerCase()];
}

/** Two subjects are one filter option when their keys match. Empty for a
 *  blank subject. */
export function subjectFilterKey(subject: string | null | undefined): string {
  return [...filterParts(subject)].sort().join(" + ");
}

/**
 * The Subject filter's options for a unit list (TRA-723): one per subject by
 * meaning, so "Math" and "Mathematics" never show as two options. Each is
 * labelled with the spelling most units use, alphabetically first on a tie
 * (so lists of the same units label it the same way), and the options are
 * sorted. A subject naming two ("Art & Science") is its own option, and its
 * units also sit under each of the two (`unitFitsSubjectFilter`).
 */
export function unitSubjectFilterOptions(
  units: { subject?: string | null }[],
): string[] {
  const groups = new Map<string, Map<string, number>>();
  for (const u of units) {
    const key = subjectFilterKey(u.subject);
    if (!key) continue;
    const spellings = groups.get(key) ?? new Map<string, number>();
    const label = u.subject!.trim();
    spellings.set(label, (spellings.get(label) ?? 0) + 1);
    groups.set(key, spellings);
  }
  const labels: string[] = [];
  for (const spellings of groups.values()) {
    const [best] = [...spellings].sort(
      ([a, aCount], [b, bCount]) => bCount - aCount || a.localeCompare(b),
    );
    labels.push(best[0]);
  }
  return labels.sort((a, b) => a.localeCompare(b));
}

/** Whether a unit sits under a Subject filter option: its subject names
 *  everything the option does, by meaning. So a "Mathematics" unit is under
 *  Math, and an "Art & Science" unit is under Art, Science and
 *  "Art & Science". A unit with no subject is under none. */
export function unitFitsSubjectFilter(
  unitSubject: string | null | undefined,
  selected: string,
): boolean {
  const want = filterParts(selected);
  if (want.length === 0) return false;
  const have = new Set(filterParts(unitSubject));
  return want.every((d) => have.has(d));
}

/**
 * Where a unit's current subject sits against the school's class names
 * (TRA-723), for the unit designer's subject picker. `selected` is the class
 * the subject names (any case), else the subject as written. `offList` is set
 * when the unit has a subject that is not one of the classes: the picker
 * still shows it, as-is, with a quiet prompt to pick a class, and leaves the
 * saved value alone until someone picks.
 */
export function subjectPickerState(
  options: readonly string[],
  current: string | null | undefined,
): { selected: string; offList: string | null } {
  const subject = current?.trim() ?? "";
  if (!subject) return { selected: "", offList: null };
  const folded = subject.toLowerCase();
  const match = options.find((o) => o.trim().toLowerCase() === folded);
  return match
    ? { selected: match, offList: null }
    : { selected: subject, offList: subject };
}
