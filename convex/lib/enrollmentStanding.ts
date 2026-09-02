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
