export const PRIMARY_GROUP_TYPE = "primary";
export const EXTENDED_EDUCATION_LABEL = "Extended education";
export const SCHOLAR_GROUP_PARTICIPATION = {
  ENROLLED_ONLY: "enrolled_only",
  INCLUDES_PROGRAM_GUESTS: "includes_program_guests",
} as const;

export type ScholarGroupParticipation =
  (typeof SCHOLAR_GROUP_PARTICIPATION)[keyof typeof SCHOLAR_GROUP_PARTICIPATION];

type GroupType = {
  type?: string | null;
};

type GroupParticipation = {
  participation?: ScholarGroupParticipation | null;
};

type ScholarGroup = GroupType & {
  scholarIds: readonly unknown[];
};

function normalizedType(group: GroupType): string | null {
  const type = group.type?.trim().toLowerCase();
  return type || null;
}

export function subjectKeyOf(group: GroupType): string | null {
  const type = normalizedType(group);
  return type === PRIMARY_GROUP_TYPE ? null : type;
}

export function isSubjectCohort(group: GroupType): boolean {
  return subjectKeyOf(group) !== null;
}

/** Missing legacy values are deliberately enrolled-only. */
export function includesProgramGuests(group: GroupParticipation): boolean {
  return (
    group.participation ===
    SCHOLAR_GROUP_PARTICIPATION.INCLUDES_PROGRAM_GUESTS
  );
}

/** Guest-inclusive groups stay hidden until Extended education is selected. */
export function groupMatchesParticipation(
  group: GroupParticipation,
  includeProgramGuests: boolean,
): boolean {
  return includeProgramGuests || !includesProgramGuests(group);
}

export function owningGroupForScholar<T extends ScholarGroup>(
  groups: readonly T[],
  scholarId: unknown,
  subject?: string | null,
): T | null {
  const memberships = groups.filter((group) =>
    group.scholarIds.some((id) => String(id) === String(scholarId)),
  );
  return pickBySubject(memberships, subject);
}

type OwnedGroup = GroupType & GroupParticipation & {
  ownerId?: unknown;
};

/**
 * The group a group-scoped surface should OPEN ON for this teacher — the
 * mirror of `owningGroupForScholar` on the staff side of the same ownership
 * fact. A teacher who runs "Amber's Math" lands on it instead of the whole
 * roster; a teacher who owns nothing gets `null` and the surface keeps its
 * existing all-scholars default.
 *
 * `subject` narrows to that subject cohort first (the Math Skills studio
 * passes "math"), then falls back to an owned primary group, then to any
 * owned group — so a subject-scoped surface still opens on a teacher's own
 * scholars when they own only a primary group, and an unscoped surface (the
 * Scholars tab) still opens on their math cohort when that's all they own.
 */
export function defaultGroupForTeacher<T extends OwnedGroup>(
  groups: readonly T[],
  teacherId: unknown,
  subject?: string | null,
): T | null {
  if (!teacherId) return null;
  const owned = groups.filter(
    (group) =>
      group.ownerId &&
      String(group.ownerId) === String(teacherId),
  );
  return pickBySubject(owned, subject) ?? owned[0] ?? null;
}

/** Subject cohort for `subject` → primary group → nothing. */
function pickBySubject<T extends GroupType>(
  groups: readonly T[],
  subject?: string | null,
): T | null {
  const subjectKey = subject?.trim().toLowerCase() || null;
  return (
    (subjectKey
      ? groups.find((group) => subjectKeyOf(group) === subjectKey)
      : undefined) ??
    groups.find((group) => !isSubjectCohort(group)) ??
    null
  );
}
