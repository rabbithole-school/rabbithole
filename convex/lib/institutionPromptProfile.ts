/**
 * institutionPromptProfile — per-school identity strings for model prompts.
 *
 * The tutor / soul / observer / reflection / rubric prompts (scholar-facing) AND
 * the staff/parent aide surfaces (curriculum bot, teacher aide, parent chat,
 * Slack, unit designer, end-of-day check-in) resolve their identity through
 * one profile instead of carrying school-specific literals.
 * Every scholar has an institution (`users.institutionId` → `institutions`,
 * which carries `name` + `timeZone`), and every adult resolves an institution
 * from their active membership / their child / the owning unit — so a person at
 * a second *school* should see THEIR school's name instead. This module resolves
 * a small profile of identity/label strings from an institution, and is the
 * single resolver for every one of those prompts (scholar and adult alike).
 *
 * The primary / guest / unknown default is supplied by the explicit
 * downstream-only primaryInstitutionPromptProfile module. Foundation recreates
 * that module with its neutral fallback. Changing a downstream default changes
 * the rendered tutor prompt AND the `promptVersion` hash — treat it as
 * load-bearing.
 *
 * SCOPE: identity/label strings ONLY. This does NOT touch date/timezone
 * ARITHMETIC (the date-boundary math) — that is owned elsewhere. The
 * `timeZone` and `timeZoneAbbrev` here drive the prompt's clock rendering.
 *
 * See convex/institutions.ts (`PRIMARY_SLUG`) and shared/institutionDay.ts.
 */

import type { QueryCtx, MutationCtx } from "../_generated/server";
import type { Id } from "../_generated/dataModel";
import { scholarInstitutionId } from "./scholarEnrollment";
import { PRIMARY_INSTITUTION_PROMPT_PROFILE } from "./primaryInstitutionPromptProfile";

export type InstitutionPromptProfile = {
  /** Full institution name used by tutor, observer, reflection, and rubric
   *  prompts. */
  schoolName: string;
  /** Short institution name used by soul-document and observer headings. */
  shortName: string;
  /** Location shown in the tutor base prompt, or null to omit it when the
   *  institution's city is unknown. */
  baseLocation: string | null;
  /** Location shown in observer and meta-observer prompts, or null to omit it. */
  observerLocation: string | null;
  /** IANA timezone used to render the model-facing clock, or null when the
   *  institution has not supplied one. */
  timeZone: string | null;
  /** Time-zone abbreviation label appended to tutor and adult-aide clock
   *  lines, or null to omit it. */
  timeZoneAbbrev: string | null;
  /** Region word used in adult-aide clock lines. Derived schools use their city;
   *  null omits the clock phrase when no location is known. */
  clockRegion: string | null;
  /** Trailing detail appended after the abbreviation in long adult-aide clock
   *  clauses. It is a display label only, never used for arithmetic. */
  timeZoneOffsetNote: string | null;
};

export const DEFAULT_INSTITUTION_PROMPT_PROFILE =
  PRIMARY_INSTITUTION_PROMPT_PROFILE;

/** The subset of an `institutions` doc this module reads. Structural so a full
 *  `Doc<"institutions">` (extra fields) and a test fixture both satisfy it. */
export type InstitutionForProfile = {
  name: string;
  kind?: "school" | "guest" | "community";
  isPrimary?: boolean;
  timeZone?: string;
};

/** Drop a trailing generic institution word so the soul header reads naturally. */
function shortSchoolName(fullName: string): string {
  const short = fullName.replace(/\s+(School|Academy)$/i, "").trim();
  return short.length > 0 ? short : fullName;
}

/** Possessive form for the adult prompts ("Kestrels' founders",
 *  "Kestrel's founders"). A name already ending in "s" takes a bare apostrophe;
 *  otherwise "'s". */
export function possessive(name: string): string {
  return /s$/i.test(name) ? `${name}'` : `${name}'s`;
}

/** The adult-aide short region and abbreviation clock label, or null when no
 *  timezone is known. */
export function shortClockLabel(
  profile: InstitutionPromptProfile,
): string | null {
  if (!profile.clockRegion || !profile.timeZoneAbbrev) return null;
  return `${profile.clockRegion} (${profile.timeZoneAbbrev})`;
}

/** The adult-aide long clock clause (leading space included), or an empty string
 *  when no timezone is known. */
export function longClockClause(profile: InstitutionPromptProfile): string {
  if (!profile.clockRegion || !profile.timeZoneAbbrev) return "";
  return ` in ${profile.clockRegion} time (${profile.timeZoneAbbrev}${
    profile.timeZoneOffsetNote ?? ""
  })`;
}

/** A human city label from an IANA zone: last path segment, underscores→spaces
 * ("Pacific/Fiji" → "Fiji", "America/New_York" → "New York"). Null when
 *  no zone is set, since we can't honestly guess a school's city otherwise. */
function cityFromTimeZone(timeZone: string | undefined): string | null {
  if (!timeZone) return null;
  const segment = timeZone.split("/").pop() ?? timeZone;
  const label = segment.replace(/_/g, " ").trim();
  return label.length > 0 ? label : null;
}

/** The short time-zone abbreviation label for a zone, or null when
 *  unknown/underivable. Purely a display label. */
function timeZoneAbbrev(timeZone: string | undefined): string | null {
  if (!timeZone) return null;
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone,
      timeZoneName: "short",
    }).formatToParts(new Date());
    const value = parts.find((p) => p.type === "timeZoneName")?.value ?? null;
    return value && value.trim().length > 0 ? value : null;
  } catch {
    return null;
  }
}

/**
 * Resolve the identity profile for an institution (or null). Returns the
 * configured primary default for the primary school, guest bucket, or a missing
 * institution; otherwise derives the profile from a real school's `name` +
 * `timeZone`.
 */
export function institutionPromptProfile(
  institution: InstitutionForProfile | null | undefined,
): InstitutionPromptProfile {
  // Primary / guest / unknown use the configured default. The guest bucket is
  // not a real school whose name belongs in a tutor prompt, and a missing
  // institution must not inherit another tenant's identity.
  if (
    !institution ||
    institution.isPrimary === true ||
    institution.kind === "guest"
  ) {
    return DEFAULT_INSTITUTION_PROMPT_PROFILE;
  }
  const schoolName =
    institution.name.trim() || DEFAULT_INSTITUTION_PROMPT_PROFILE.schoolName;
  const location = cityFromTimeZone(institution.timeZone);
  return {
    schoolName,
    shortName: shortSchoolName(schoolName),
    baseLocation: location,
    observerLocation: location,
    timeZone: institution.timeZone ?? null,
    timeZoneAbbrev: timeZoneAbbrev(institution.timeZone),
    // A derived school's region == its city (we don't invent a state), and we
    // can't honestly state its UTC offset, so the long-clause offset note is null.
    clockRegion: location,
    timeZoneOffsetNote: null,
  };
}

/**
 * The async form used inside the context-building queries/mutations: resolve a
 * scholar's institution and return its prompt profile. Falls back to the
 * configured default when the scholar or institution is missing.
 */
export async function institutionPromptProfileForScholar(
  ctx: QueryCtx | MutationCtx,
  scholarId: Id<"users"> | null | undefined,
): Promise<InstitutionPromptProfile> {
  if (!scholarId) return DEFAULT_INSTITUTION_PROMPT_PROFILE;
  const institutionId = (await scholarInstitutionId(ctx, scholarId)) ?? null;
  if (!institutionId) return DEFAULT_INSTITUTION_PROMPT_PROFILE;
  const institution = await ctx.db.get(institutionId);
  return institutionPromptProfile(institution);
}

/**
 * The async form used by the ADULT aide surfaces (staff/parent), which resolve
 * an institution id up front (from the staff member's active membership, the
 * child's institution, or the owning unit) and want its profile. Falls back to
 * the configured default when the id is missing or the institution is gone.
 */
export async function institutionPromptProfileById(
  ctx: QueryCtx | MutationCtx,
  institutionId: Id<"institutions"> | null | undefined,
): Promise<InstitutionPromptProfile> {
  if (!institutionId) return DEFAULT_INSTITUTION_PROMPT_PROFILE;
  const institution = await ctx.db.get(institutionId);
  return institutionPromptProfile(institution);
}
