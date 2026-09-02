// Institution gate for the primary institution's health/consent-form
// surfaces.
//
// Some downstream deployments author health/consent forms (physician forms —
// medication authorization, the asthma/diabetes/seizure/allergy/behavioral-
// health action plans, medical clearance — plus a guardian e-sign layer) that
// encode that deployment's own legal identity and jurisdiction — statutory
// authorization language and jurisdiction-specific crisis resources, not just
// a crest and a school name. Substituting an institution name would produce a
// document that LOOKS like another school's but still carries the authoring
// school's legal authorization and the wrong jurisdiction's resources — worse
// than not offering it. So those forms are RESTRICTED to the primary
// institution rather than genericized; genericizing them (offering them to a
// second school) is real legal work — per-institution legal templates +
// jurisdiction review — not a name substitution.
//
// This module is the one place that decides "may the primary institution's
// form surfaces be produced for / reached by this caller" — the single
// institution-scoped gate reused by both that legal print/e-sign layer AND
// the generic scholar-document / health-record capabilities that merely need
// to know whether health forms exist for a scholar's institution
// (convex/scholarDocuments.ts, convex/scholarHealthRecords.ts). It has no
// knowledge of any specific form's content or legal text — see
// convex/guardianForms.ts for the guardian e-sign form ids and their own
// narrower gate.

import type { MutationCtx, QueryCtx } from "../_generated/server";
import type { Doc, Id } from "../_generated/dataModel";
import { primaryInstitutionId } from "../institutions";
import { isProgramGuest } from "./enrollmentStanding";
import { isPlatformAdminRole } from "./roles";
import { EXTENDED_EDUCATION_LABEL } from "../../shared/scholarGroupRouting";

/** The single, honest refusal shown/raised when a non-primary caller reaches a
 *  form surface. Kept to one sentence, in the app's voice. */
export const FORMS_UNAVAILABLE_MESSAGE =
  "Health forms aren't available for your school yet.";
export const PROGRAM_GUEST_FORMS_UNAVAILABLE_MESSAGE =
  `Health form access isn't available for ${EXTENDED_EDUCATION_LABEL} scholars.`;

/**
 * Whether a scholar belongs to the primary institution — the audience the
 * primary institution's forms are authored for. An unset `institutionId`
 * counts as primary (unstamped home-school scholars, matching portfolio.ts /
 * formCompletion's existing treatment). When NO institution is marked primary
 * (a fresh deployment before `ensureDefaults`), the gate fails OPEN — there is
 * nothing to restrict to, and production always has a primary institution set.
 */
export function scholarIsPrimary(
  scholar: Pick<Doc<"users">, "institutionId">,
  primaryId: Id<"institutions"> | null,
): boolean {
  if (primaryId === null) return true;
  if (scholar.institutionId === undefined) return true;
  return scholar.institutionId === primaryId;
}

/** Whether the health/consent forms may be produced for `scholarId`. */
export async function scholarFormsAllowed(
  ctx: QueryCtx | MutationCtx,
  scholarId: Id<"users">,
): Promise<boolean> {
  const primaryId = await primaryInstitutionId(ctx);
  if (primaryId === null) return true;
  const scholar = await ctx.db.get(scholarId);
  if (!scholar || scholar.role !== "scholar") return false;
  if (isProgramGuest(scholar)) return false;
  return scholarIsPrimary(scholar, primaryId);
}

/** Throw unless forms are available for the scholar's institution. */
export async function assertScholarInstitutionFormsAllowed(
  ctx: QueryCtx | MutationCtx,
  scholarId: Id<"users">,
): Promise<void> {
  const scholar = await ctx.db.get(scholarId);
  if (scholar?.role === "scholar" && isProgramGuest(scholar)) {
    throw new Error(PROGRAM_GUEST_FORMS_UNAVAILABLE_MESSAGE);
  }
  if (!(await scholarFormsAllowed(ctx, scholarId))) {
    throw new Error(FORMS_UNAVAILABLE_MESSAGE);
  }
}

/**
 * Throw the legible refusal unless the forms may be produced for `scholarId`.
 * Platform admins bypass the gate — they retain access across institutions.
 */
export async function assertScholarFormsAllowed(
  ctx: QueryCtx | MutationCtx,
  user: Pick<Doc<"users">, "role">,
  scholarId: Id<"users">,
): Promise<void> {
  const scholar = await ctx.db.get(scholarId);
  if (scholar?.role === "scholar" && isProgramGuest(scholar)) {
    throw new Error(PROGRAM_GUEST_FORMS_UNAVAILABLE_MESSAGE);
  }
  if (isPlatformAdminRole(user.role)) return;
  await assertScholarInstitutionFormsAllowed(ctx, scholarId);
}

/**
 * Whether a STAFF caller may reach the form surfaces: a platform admin (global)
 * or someone with a membership in the primary institution. A staffer whose only
 * memberships are at other schools is refused. Fails OPEN when no primary is
 * configured, for the same reason as `scholarIsPrimary`.
 */
export async function staffFormsAllowed(
  ctx: QueryCtx | MutationCtx,
  user: Pick<Doc<"users">, "_id" | "role">,
): Promise<boolean> {
  if (isPlatformAdminRole(user.role)) return true;
  const primaryId = await primaryInstitutionId(ctx);
  if (primaryId === null) return true;
  const memberships = await ctx.db
    .query("memberships")
    .withIndex("by_user", (q) => q.eq("userId", user._id))
    .collect();
  return memberships.some((m) => m.institutionId === primaryId);
}

/** Throw the legible refusal unless the staff caller may reach the forms. */
export async function assertStaffFormsAllowed(
  ctx: QueryCtx | MutationCtx,
  user: Pick<Doc<"users">, "_id" | "role">,
): Promise<void> {
  if (!(await staffFormsAllowed(ctx, user))) {
    throw new Error(FORMS_UNAVAILABLE_MESSAGE);
  }
}

/**
 * Whether the currently-signed-in VIEWER has any tie to the primary
 * institution: a platform admin, a primary staff membership, a primary scholar
 * record, or a guardianship of a primary scholar. Drives the public print-route
 * gate. An UNAUTHENTICATED viewer (`null`) returns `true` — the blank templates
 * are a public resource of the primary institution a physician completes
 * without signing in; the risk this gate addresses is an authenticated
 * non-primary FAMILY being led to a document that carries the wrong school's
 * authorization.
 */
export async function viewerFormsAllowed(
  ctx: QueryCtx,
  user: Doc<"users"> | null,
): Promise<boolean> {
  if (!user) return true;
  if (isPlatformAdminRole(user.role)) return true;
  const primaryId = await primaryInstitutionId(ctx);
  if (primaryId === null) return true;

  const memberships = await ctx.db
    .query("memberships")
    .withIndex("by_user", (q) => q.eq("userId", user._id))
    .collect();
  if (memberships.some((m) => m.institutionId === primaryId)) return true;

  if (
    user.role === "scholar" &&
    !isProgramGuest(user) &&
    scholarIsPrimary(user, primaryId)
  ) {
    return true;
  }

  const links = await ctx.db
    .query("guardianships")
    .withIndex("by_parent", (q) => q.eq("parentUserId", user._id))
    .collect();
  for (const link of links) {
    const child = await ctx.db.get(link.scholarUserId);
    if (
      child &&
      child.role === "scholar" &&
      !isProgramGuest(child) &&
      scholarIsPrimary(child, primaryId)
    ) {
      return true;
    }
  }
  return false;
}
