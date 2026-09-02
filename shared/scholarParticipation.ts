import type { EnrollmentStanding } from "../convex/lib/enrollmentStanding";
import {
  includesProgramGuests,
  type ScholarGroupParticipation,
} from "./scholarGroupRouting";

export type ScholarParticipationSelection = {
  enrolled: boolean;
  extendedEducation: boolean;
};

export const DEFAULT_SCHOLAR_PARTICIPATION: ScholarParticipationSelection = {
  enrolled: true,
  extendedEducation: false,
};

/**
 * Whether the participation filter must already include Extended Education on
 * the FIRST render of a Scholars-tab visit — derived from the URL that visit
 * actually arrived on, not just from the auto-default path.
 *
 * A cold deep link carries either signal independently, and the enrolled-only
 * default hides both, leaving the rail empty for a link that names real people:
 *   - the path's scholar slug resolves to a `program_guest`, or
 *   - `?group=` names a group whose participation is `includes_program_guests`.
 *
 * The group's participation is read off `scholarGroups.list`, which is NOT
 * gated by the roster's participation filter, so it is available while the
 * roster is still enrolled-only — that is what lets (a) resolve on a cold link.
 *
 * This is only the INITIAL default: the caller latches it so a user's own later
 * toggling of the Participation filter still wins for the rest of the session.
 */
export function deepLinkIncludesExtendedEducation({
  scholarEnrollmentStanding,
  scopedGroupParticipation,
}: {
  /** enrollmentStanding of the scholar the path slug resolved to, if any. */
  scholarEnrollmentStanding?: EnrollmentStanding | null;
  /** participation of the `?group=` group, if it resolved to one. */
  scopedGroupParticipation?: ScholarGroupParticipation | null;
}): boolean {
  if (scholarEnrollmentStanding === "program_guest") return true;
  if (
    scopedGroupParticipation != null &&
    includesProgramGuests({ participation: scopedGroupParticipation })
  ) {
    return true;
  }
  return false;
}

export function scholarMatchesParticipation(
  scholar: { enrollmentStanding?: EnrollmentStanding | null },
  selection: ScholarParticipationSelection,
): boolean {
  return scholar.enrollmentStanding === "program_guest"
    ? selection.extendedEducation
    : selection.enrolled;
}
