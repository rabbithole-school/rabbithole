// Tool-layer vocabulary for the enrolled vs Extended Education split.
//
// Model-facing ENUMERATION tools (rosters, group listings, per-scholar
// sweeps) default to ENROLLED scholars only; the model opts in with
// `includeExtendedEducation: true` when the request is genuinely about
// Extended Education (program-guest) scholars. This mirrors the UI's
// participation filter (shared/scholarParticipation.ts, enrolled-only
// default) and the server precedent (`includeProgramGuests` on
// users.listScholars / parentMessages — explicit opt-in, default off).
//
// Two deliberate boundaries, decided with the filter (2026-08-18):
//  - NAMING is opting in. Point lookups and writes keyed by an explicit
//    scholarName/groupName still resolve Extended Education scholars —
//    the human named the kid; hiding them would break "what's Kai's
//    practice" for a real Robotics participant. Only enumerations filter.
//  - IDENTITY-SCOPED callers are exempt. A parent's (guardianship) or
//    scholar's (self) allowed set IS their family — a program-guest
//    family must always see their own children. This is enforced
//    structurally, not by a runtime branch: the role policy
//    (lib/scholarReadPolicy.ts) never grants parent/scholar roles an
//    enumeration tool, so the enrolled-only default only ever runs on
//    staff-side institution enumerations. If an enumeration tool is ever
//    granted to an identity-scoped role, exempt it there.
//
// Factual-membership surfaces (assignment rosters, device inventories)
// ANNOTATE instead of filtering — a guest who is genuinely in the cohort
// or holds managed hardware is real data; they carry
// `extendedEducation: true` so the model can see the standing.

import { isProgramGuest } from "./enrollmentStanding";
import type { EnrollmentStanding } from "./enrollmentStanding";

/**
 * JSON-schema property fragment for the explicit opt-in. Spread into an
 * enumeration tool's `inputSchema.properties`; never into `required`.
 */
export const INCLUDE_EXTENDED_EDUCATION_PROP = {
  includeExtendedEducation: {
    type: "boolean" as const,
    description:
      "Also include Extended Education scholars (program guests who attend " +
      "extended-education programming only, not regular enrollment). " +
      "Defaults to false: results cover enrolled scholars only. Set true " +
      "only when the request is explicitly about Extended Education " +
      "participants or asks for everyone regardless of enrollment.",
  },
};

/**
 * Row tag the read layer stamps on program-guest rows (and omits on
 * enrolled rows, keeping the common case byte-identical to before).
 * Typed as an optional prop — not a union — so spreading it keeps the
 * row a single shape and consumers never need widening casts.
 */
export function extendedEducationTag(scholar: {
  enrollmentStanding?: EnrollmentStanding | null;
}): { extendedEducation?: true } {
  return isProgramGuest({
    enrollmentStanding: scholar.enrollmentStanding ?? undefined,
  })
    ? { extendedEducation: true }
    : {};
}

/**
 * Apply the enrolled-only default at the tool edge. Rows arrive tagged
 * (extendedEducationTag) from the read layer; when the model did not opt
 * in, guests are dropped and counted so the tool can say what it hid.
 */
export function applyParticipationDefault<
  T extends { extendedEducation?: boolean },
>(
  rows: T[],
  includeExtendedEducation: boolean,
): { rows: T[]; extendedEducationOmitted: number } {
  if (includeExtendedEducation) {
    return { rows, extendedEducationOmitted: 0 };
  }
  const kept = rows.filter((r) => r.extendedEducation !== true);
  return { rows: kept, extendedEducationOmitted: rows.length - kept.length };
}

/**
 * Standard discoverability note. Returned alongside filtered results so
 * the model learns the opt-in exists instead of concluding the scholars
 * don't. Null when nothing was hidden (don't add noise to the common case).
 *
 * `describe` names what was hidden in the caller's own units — a count of
 * group-membership entries or idea rows is NOT a count of scholars, and a
 * note that misstates the unit hands the model a wrong roster fact.
 */
export function extendedEducationOmittedNote(
  count: number,
  describe: (n: number) => string = (n) =>
    `${n} Extended Education scholar${n === 1 ? "" : "s"}`,
): string | null {
  if (count <= 0) return null;
  return `${describe(count)} not shown (results default to enrolled scholars only — pass includeExtendedEducation: true to include them).`;
}
