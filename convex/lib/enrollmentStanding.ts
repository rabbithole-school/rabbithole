export const ENROLLMENT_STANDINGS = {
  ENROLLED: "enrolled",
  PROGRAM_GUEST: "program_guest",
} as const;

export type EnrollmentStanding =
  (typeof ENROLLMENT_STANDINGS)[keyof typeof ENROLLMENT_STANDINGS];

type ScholarStanding = {
  enrollmentStanding?: EnrollmentStanding;
};

/** Legacy scholar rows are full enrollments until explicitly marked otherwise. */
export function isProgramGuest(
  scholar: ScholarStanding | null | undefined,
): boolean {
  return (
    scholar?.enrollmentStanding === ENROLLMENT_STANDINGS.PROGRAM_GUEST
  );
}

export function isEnrolledScholar(scholar: ScholarStanding): boolean {
  return !isProgramGuest(scholar);
}

/**
 * A withdrawn scholar has left the school (`users.withdrawnOn` is set). Their
 * history stays; they just stop counting as a current scholar. Separate from
 * enrollment standing on purpose: an enrolled scholar or a program guest can
 * each withdraw, and undoing a withdrawal restores whichever they were.
 */
export function isWithdrawn(
  scholar: { withdrawnOn?: string } | null | undefined,
): boolean {
  return scholar?.withdrawnOn !== undefined;
}

/** The plain "is this child at the school now" test for current-scholar lists. */
export function isCurrentScholar(
  scholar: { withdrawnOn?: string } | null | undefined,
): boolean {
  return !!scholar && !isWithdrawn(scholar);
}
