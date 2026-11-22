// Parent accounts + the parent↔scholar guardianship graph.
//
// Two audiences, two gates:
//   1. Scholar-admins (teacher/admin/operations staff) create/manage parent
//      accounts and link them to scholars — `scholarAdminMutation/Query`.
//   2. Parents read their OWN children's non-sensitive data —
//      `authedQuery` + `requireGuardianOf`. These deliberately reuse the
//      SAME shared read layer (lib/scholarReads.ts) as the aide streams
//      and the MCP connector, so the privacy contract (summaries yes,
//      raw transcripts no) is identical across surfaces.
//
// Parent accounts are created ONLY here (never via the generic admin
// "Add User" flow), so a parent always has a verified email + at least the
// intent of a guardianship. Auth is passwordless: magic-link primary (the
// email set here is pre-verified — see lib/email + auth.ts), passkey
// optional.

import { withoutUnstartedTileSessions } from "./lib/tileSessions";
import { loadScheduleRows, readSchedule } from "./lib/scheduleStore";
import {
  firstClassIdByWork,
  homeworkSubjectLabel,
  scheduleWorkKey,
} from "./lib/homeworkSubject";
import { openUntilClosesAt } from "../shared/openUntil";
import { v } from "convex/values";
import { talkLevelOf } from "./lib/readingLevels";
import { isEnrichmentSubject, REPORT_SECTION_KEY, reportTitle } from "./lib/parentReport";
import { familyPortfolioItems } from "./portfolio";
import { authedQuery, authedMutation, scholarAdminQuery, scholarAdminMutation } from "./lib/customFunctions";
import {
  canReadScholarAsTeacher,
  requireActiveScholarAccess,
  requireScholarsAccessible,
} from "./lib/access";
import { internalQuery, internalAction } from "./_generated/server";
import { internal } from "./_generated/api";
import {
  isGuardianOf,
  requireGuardianOf,
  requireGuardianOrStaffPreview,
  hasGuardianships,
} from "./lib/auth";
import { libraryCardStatusFor } from "./libraryCards";
import {
  guardianClearanceRequestsFor,
  guardianFormsAvailableFor,
  guardianHealthRecordStatusFor,
  guardianPhysicalExamFor,
} from "./scholarHealthRecords";
import { resolveValidatedProfileImageUrl } from "./lib/profileImage";
import { isApplicantOnlyParent } from "./lib/applicantParent";
import { ensureDefaultMembershipForUser, ensureMembership } from "./memberships";
import { ROLES, isStaffRole, isTeacherRole, isPlatformAdminRole } from "./lib/roles";
import { normalizeEmail, isValidEmail } from "./lib/email";
import { sendClaimInviteEmail } from "./lib/claimInviteEmail";
import {
  readScholarSignals,
  readScholarSeeds,
} from "./lib/scholarReads";
import { gatherMathPortrait } from "./mathPortrait";
import { parentInLens, resolveInstitutionLens, scholarIdsInLens } from "./lib/institutionLens";
import { isProgramGuest } from "./lib/enrollmentStanding";
import { EXTENDED_EDUCATION_LABEL } from "../shared/scholarGroupRouting";
import { unstartedAssignedRowSurface } from "./scholarPlate";
import { closuresForInstitution, hasUsableDays } from "./academicCalendar";
import { tripsForScholar } from "./fieldTrips";
import { ONBOARDING_UNIT_SLUG } from "./onboardingData";
import { homeworkPlanWindowStart } from "../shared/homeworkPlanWeeks";
import { dayKeyForTimezone } from "../shared/institutionDay";
import {
  hasScholarMembership,
  scholarInstitutionId,
} from "./lib/scholarEnrollment";
import { timeZoneForInstitution } from "./lib/institutionTime";
import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";

// ── Scholar-admin: manage parent accounts + guardianship links ──────────

export function cleanOptional(value: string | undefined) {
  return value?.trim() || undefined;
}

export function formatStructuredAddress(parts: {
  streetAddress?: string;
  city?: string;
  state?: string;
  zip?: string;
}) {
  const cityStateZip = [
    parts.city,
    [parts.state, parts.zip].filter(Boolean).join(" "),
  ].filter(Boolean).join(", ");
  return [parts.streetAddress, cityStateZip].filter(Boolean).join(", ") || undefined;
}

export type ParentAccountLookup =
  | { kind: "parent"; user: Doc<"users">; duplicate: boolean }
  | { kind: "non_parent"; user: Doc<"users">; duplicate: boolean }
  | { kind: "none"; duplicate: false };

/**
 * The account an email already belongs to, if any (`users.by_email`). Shared
 * by `createParent` and the admissions account/link paths so the collision
 * rules cannot drift. `email` must already be normalized.
 *
 * `by_email` is not enforced unique, so this takes the first row and reports
 * `duplicate` when a second one exists; callers flag it instead of throwing.
 */
export async function findParentAccountByEmail(
  ctx: QueryCtx,
  email: string,
): Promise<ParentAccountLookup> {
  const rows = await ctx.db
    .query("users")
    .withIndex("by_email", (q) => q.eq("email", email))
    .take(2);
  const existing = rows[0];
  if (!existing) return { kind: "none", duplicate: false };
  const duplicate = rows.length > 1;
  return existing.role === ROLES.PARENT
    ? { kind: "parent", user: existing, duplicate }
    : { kind: "non_parent", user: existing, duplicate };
}

export type ParentContactFields = {
  name?: string;
  firstName?: string;
  lastName?: string;
  phone?: string;
  address?: string;
  streetAddress?: string;
  city?: string;
  state?: string;
  zip?: string;
};

/**
 * Fill only the contact fields an existing account is MISSING; never
 * overwrite. `stampVerified` also stamps `emailVerificationTime` when absent
 * (createParent's "a trusted operator typed it"; a public intake never does).
 */
export async function backfillParentContact(
  ctx: MutationCtx,
  user: Doc<"users">,
  fields: ParentContactFields,
  opts: { stampVerified?: boolean } = {},
): Promise<void> {
  const patch: Record<string, unknown> = {};
  if (!user.name && fields.name) patch.name = fields.name;
  if (!user.firstName && fields.firstName) patch.firstName = fields.firstName;
  if (!user.lastName && fields.lastName) patch.lastName = fields.lastName;
  if (opts.stampVerified && !user.emailVerificationTime) {
    patch.emailVerificationTime = Date.now();
  }
  if (!user.phone && fields.phone) patch.phone = fields.phone;
  if (!user.address && fields.address) patch.address = fields.address;
  if (!user.streetAddress && fields.streetAddress) patch.streetAddress = fields.streetAddress;
  if (!user.city && fields.city) patch.city = fields.city;
  if (!user.state && fields.state) patch.state = fields.state;
  if (!user.zip && fields.zip) patch.zip = fields.zip;
  if (Object.keys(patch).length) await ctx.db.patch(user._id, patch);
}

/**
 * Create a parent account (or reuse an existing one matched by email) and
 * link it to one or more scholars. Email is stored normalized + stamped
 * verified (trusted entry — the magic link proves inbox control on first
 * use). Idempotent on the (parent, scholar) pair so re-linking is safe.
 */
export const createParent = scholarAdminMutation({
  args: {
    name: v.string(),
    firstName: v.optional(v.string()),
    lastName: v.optional(v.string()),
    email: v.string(),
    phone: v.optional(v.string()),
    address: v.optional(v.string()),
    streetAddress: v.optional(v.string()),
    city: v.optional(v.string()),
    state: v.optional(v.string()),
    zip: v.optional(v.string()),
    scholarIds: v.array(v.id("users")),
  },
  handler: async (ctx, args) => {
    if (args.scholarIds.length === 0) {
      throw new Error("Choose at least one child");
    }
    await requireScholarsAccessible(ctx, ctx.user, args.scholarIds);

    const name = args.name.trim();
    if (!name) throw new Error("Parent name is required");
    const email = normalizeEmail(args.email);
    if (!isValidEmail(email)) throw new Error("Enter a valid email address");
    const firstName = cleanOptional(args.firstName);
    const lastName = cleanOptional(args.lastName);
    const phone = cleanOptional(args.phone);
    const streetAddress = cleanOptional(args.streetAddress);
    const city = cleanOptional(args.city);
    const state = cleanOptional(args.state);
    const zip = cleanOptional(args.zip);
    const address =
      formatStructuredAddress({ streetAddress, city, state, zip }) ??
      cleanOptional(args.address);

    // Reuse an existing account with this email if one exists. An ADMIN may
    // link an existing STAFF account (a staffer who is also a guardian of
    // their own child) — never a scholar, which would be scholar-to-scholar
    // access. We never change their primary role; we add a guardianship + a
    // `parent` membership below.
    const lookup = await findParentAccountByEmail(ctx, email);
    const existing = lookup.kind === "none" ? null : lookup.user;
    if (lookup.kind === "non_parent") {
      const adminLinkingStaff =
        isPlatformAdminRole(ctx.user.role) && isStaffRole(lookup.user.role);
      if (!adminLinkingStaff) {
        throw new Error("That email already belongs to a non-parent account");
      }
    }

    const parentId =
      existing?._id ??
      (await ctx.db.insert("users", {
        name,
        firstName,
        lastName,
        email,
        phone,
        address,
        streetAddress,
        city,
        state,
        zip,
        role: ROLES.PARENT,
        emailVerificationTime: Date.now(),
      }));

    // Backfill name/verified/contact on an existing parent if missing.
    if (existing) {
      await backfillParentContact(
        ctx,
        existing,
        { name, firstName, lastName, phone, address, streetAddress, city, state, zip },
        { stampVerified: true },
      );
    }

    for (const scholarId of args.scholarIds) {
      await linkGuardianInternal(ctx, parentId, scholarId, ctx.user._id);
    }
    // Keep the parent's membership in sync (the access boundary's parent path).
    await ensureDefaultMembershipForUser(ctx, parentId);
    return { parentId };
  },
});

/** Scholar-admin: edit a parent's name / email / phone / address. */
export const updateParent = scholarAdminMutation({
  args: {
    parentId: v.id("users"),
    name: v.optional(v.string()),
    firstName: v.optional(v.string()),
    lastName: v.optional(v.string()),
    email: v.optional(v.string()),
    phone: v.optional(v.string()),
    address: v.optional(v.string()),
    streetAddress: v.optional(v.string()),
    city: v.optional(v.string()),
    state: v.optional(v.string()),
    zip: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const parent = await ctx.db.get(args.parentId);
    if (!parent || parent.role !== ROLES.PARENT) {
      throw new Error("Parent not found");
    }
    const patch: Record<string, unknown> = {};
    if (args.name !== undefined) {
      const name = args.name.trim();
      if (!name) throw new Error("Parent name is required");
      patch.name = name;
    }
    if (args.firstName !== undefined) patch.firstName = cleanOptional(args.firstName);
    if (args.lastName !== undefined) patch.lastName = cleanOptional(args.lastName);
    if (args.firstName !== undefined || args.lastName !== undefined) {
      const firstName =
        args.firstName !== undefined ? cleanOptional(args.firstName) : parent.firstName;
      const lastName =
        args.lastName !== undefined ? cleanOptional(args.lastName) : parent.lastName;
      const displayName = [firstName, lastName].filter(Boolean).join(" ");
      if (displayName) patch.name = displayName;
    }
    if (args.email !== undefined) {
      const email = normalizeEmail(args.email);
      if (!isValidEmail(email)) throw new Error("Enter a valid email address");
      const clash = await ctx.db
        .query("users")
        .withIndex("by_email", (q) => q.eq("email", email))
        .unique();
      if (clash && clash._id !== args.parentId) {
        throw new Error("That email is already in use by another account");
      }
      patch.email = email;
      patch.emailVerificationTime = Date.now();
    }
    // phone/address: empty string clears the field (undefined leaves it as-is).
    if (args.phone !== undefined) patch.phone = cleanOptional(args.phone);
    const structuredAddressProvided =
      args.streetAddress !== undefined ||
      args.city !== undefined ||
      args.state !== undefined ||
      args.zip !== undefined;
    if (structuredAddressProvided) {
      const streetAddress =
        args.streetAddress !== undefined
          ? cleanOptional(args.streetAddress)
          : parent.streetAddress;
      const city =
        args.city !== undefined ? cleanOptional(args.city) : parent.city;
      const state =
        args.state !== undefined ? cleanOptional(args.state) : parent.state;
      const zip = args.zip !== undefined ? cleanOptional(args.zip) : parent.zip;
      patch.streetAddress = streetAddress;
      patch.city = city;
      patch.state = state;
      patch.zip = zip;
      patch.address = formatStructuredAddress({ streetAddress, city, state, zip });
    } else if (args.address !== undefined) {
      patch.address = cleanOptional(args.address);
    }
    if (Object.keys(patch).length) await ctx.db.patch(args.parentId, patch);
  },
});

/**
 * Scholar-admin: send a parent their "claim your account" Welcome invite.
 *
 * The deliberate onboarding push (see review/parent-account-claim-plan.html).
 * The emailed link is INERT — it points at the `/claim` landing page, NOT a
 * magic link — so an invite that lingers in an inbox for days is harmless; the
 * parent requests a fresh, short-lived magic sign-in link from `/claim` when
 * they're ready. The "claim" is still the first magic-link login (proves inbox
 * control). Delivery is asynchronous so the staff action remains responsive;
 * a missing mail configuration or provider error is handled by the delivery
 * action.
 */
export const sendClaimInvite = scholarAdminMutation({
  args: { parentId: v.id("users") },
  handler: async (ctx, args) => {
    const parent = await ctx.db.get(args.parentId);
    if (!parent || parent.role !== ROLES.PARENT) {
      throw new Error("Parent not found");
    }
    // Tenancy: a role wrapper alone is a cross-tenant leak. Same gate as
    // enrollment.issueParentEnrollLink — the parent must sit inside the
    // caller's institution lens (platform admins stay global).
    const lens = await resolveInstitutionLens(ctx, ctx.user);
    if (!(await parentInLens(ctx, lens, args.parentId))) {
      throw new Error("Parent not found");
    }
    const email = parent.email ? normalizeEmail(parent.email) : "";
    if (!isValidEmail(email)) {
      throw new Error("This parent has no valid email on file");
    }
    const firstName = parent.name?.trim().split(/\s+/)[0] || undefined;
    await ctx.scheduler.runAfter(0, internal.parents.deliverClaimInvite, {
      email,
      firstName,
    });
    return { sent: true, email };
  },
});

/** Internal: the actual Welcome-email send (needs an action for `fetch`). */
export const deliverClaimInvite = internalAction({
  args: { email: v.string(), firstName: v.optional(v.string()) },
  handler: async (_ctx, args) => {
    await sendClaimInviteEmail({ to: args.email, firstName: args.firstName });
  },
});

/** Shared link helper (dedupes on the pair). Caller must be scholar-admin. */
async function linkGuardianInternal(
  ctx: MutationCtx,
  parentId: Id<"users">,
  scholarId: Id<"users">,
  createdBy: Id<"users">,
) {
  const scholar = await ctx.db.get(scholarId);
  if (!scholar || scholar.role !== ROLES.SCHOLAR) {
    throw new Error("Scholar not found");
  }
  // Being a guardian IS a parent context — ensure the guardian has a `parent`
  // membership so it surfaces in their context list, regardless of their
  // primary role (a staff/admin guardian keeps their staff membership too).
  await ensureMembership(ctx, { userId: parentId, role: ROLES.PARENT, createdBy });
  const dupe = await ctx.db
    .query("guardianships")
    .withIndex("by_pair", (q) =>
      q.eq("parentUserId", parentId).eq("scholarUserId", scholarId),
    )
    .first();
  if (dupe) return dupe._id;
  return await ctx.db.insert("guardianships", {
    parentUserId: parentId,
    scholarUserId: scholarId,
    createdBy,
  });
}

/** Scholar-admin: link an existing parent to a scholar. */
export const linkGuardian = scholarAdminMutation({
  args: { parentId: v.id("users"), scholarId: v.id("users") },
  handler: async (ctx, args) => {
    await requireActiveScholarAccess(ctx, ctx.user, args.scholarId);
    const parent = await ctx.db.get(args.parentId);
    if (!parent || parent.role !== ROLES.PARENT) {
      throw new Error("Parent not found");
    }
    await linkGuardianInternal(ctx, args.parentId, args.scholarId, ctx.user._id);
  },
});

/** Scholar-admin: remove a parent↔scholar link. */
export const unlinkGuardian = scholarAdminMutation({
  args: { parentId: v.id("users"), scholarId: v.id("users") },
  handler: async (ctx, args) => {
    await requireActiveScholarAccess(ctx, ctx.user, args.scholarId);
    const link = await ctx.db
      .query("guardianships")
      .withIndex("by_pair", (q) =>
        q.eq("parentUserId", args.parentId).eq("scholarUserId", args.scholarId),
      )
      .first();
    if (link) await ctx.db.delete(link._id);
  },
});

/** Scholar-admin: parents linked to a given scholar (for the manage UI). */
export const listForScholar = scholarAdminQuery({
  args: { scholarId: v.id("users") },
  handler: async (ctx, args) => {
    await requireActiveScholarAccess(ctx, ctx.user, args.scholarId);
    const links = await ctx.db
      .query("guardianships")
      .withIndex("by_scholar", (q) => q.eq("scholarUserId", args.scholarId))
      .collect();
    const parents = await Promise.all(
      links.map(async (link) => {
        const parent = await ctx.db.get(link.parentUserId);
        return parent
          ? {
              _id: parent._id,
              name: parent.name ?? null,
              firstName: parent.firstName ?? null,
              lastName: parent.lastName ?? null,
              email: parent.email ?? null,
              phone: parent.phone ?? null,
              address: parent.address ?? null,
              streetAddress: parent.streetAddress ?? null,
              city: parent.city ?? null,
              state: parent.state ?? null,
              zip: parent.zip ?? null,
              linkId: link._id,
            }
          : null;
      }),
    );
    return parents.filter((p): p is NonNullable<typeof p> => p !== null);
  },
});

/**
 * Scholar-admin: the full parent directory — every parent account with its
 * contact info and linked children — for the /school Families surface. This is
 * a STAFF-ONLY surface (scholar-admin gate), so returning addresses here is
 * fine; the parent-facing reads above/below never expose another parent's
 * contact info.
 *
 * Honors the active institution lens (?inst=): only parents with at least one
 * linked child visible under that lens are returned (via `scholarIdsInLens`),
 * and child rows are filtered to that same lens. The resolver only honors a
 * school the caller may see, so an operations staffer/school_admin can't use `scope` to
 * reach another school's families — omitted or unhonored scope falls back to
 * their home institution. Platform admins with no scope keep the full directory.
 *
 * The lens set INCLUDES Extended Education scholars. `scholarIdsInLens`
 * defaults to enrolled-only (the roster's participation filter), which
 * silently dropped every visiting family from the directory — a guardian
 * whose only child is a program guest simply did not exist here.
 */
export const listAllParents = scholarAdminQuery({
  args: { scope: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const lens = await resolveInstitutionLens(ctx, ctx.user, args.scope);
    const scholarScope =
      lens.isAdmin && args.scope === undefined
        ? null
        : await scholarIdsInLens(ctx, lens, {
            includeProgramGuests: true,
            // A withdrawn family's contact record stays in the directory.
            includeWithdrawn: true,
          });

    const parents = await ctx.db
      .query("users")
      .withIndex("by_role", (q) => q.eq("role", ROLES.PARENT))
      .collect();
    const allLinks = await ctx.db.query("guardianships").collect();

    // Guardianship is a RELATION, not a role: a guardian may have a primary
    // users.role of admin/teacher (a staff member who is also a parent) and
    // must still appear in this directory. So the guardian set is the UNION of
    // (a) users with role `parent` — including those with zero links, which
    // show today when unscoped, preserved below — and (b) every distinct
    // `parentUserId` across the guardianships table. (`listMyChildren` resolves
    // by guardianship for exactly this reason.)
    const guardianIds = new Set<Id<"users">>();
    for (const p of parents) guardianIds.add(p._id);
    for (const l of allLinks) guardianIds.add(l.parentUserId);

    const rows = await Promise.all(
      [...guardianIds].map(async (guardianId) => {
        const parent = await ctx.db.get(guardianId);
        if (!parent) return null;
        const links = await ctx.db
          .query("guardianships")
          .withIndex("by_parent", (q) => q.eq("parentUserId", guardianId))
          .collect();
        const children = await Promise.all(
          links.map(async (link) => {
            const scholar = await ctx.db.get(link.scholarUserId);
            return scholar && scholar.role === ROLES.SCHOLAR
              ? {
                  _id: scholar._id,
                  name: scholar.name ?? "Scholar",
                  gradeLevel: scholar.gradeLevel ?? null,
                  image: scholar.image ?? null,
                  username: scholar.username ?? null,
                  enrollmentStanding: isProgramGuest(scholar)
                    ? ("program_guest" as const)
                    : ("enrolled" as const),
                }
              : null;
          }),
        );
        const kids = children.filter(
          (c): c is NonNullable<typeof c> => c !== null,
        );
        // Under a scholar scope, keep a guardian only if at least one of their
        // linked children falls within the resolved institution lens.
        const inScope =
          scholarScope === null || kids.some((c) => scholarScope!.has(c._id));
        return inScope
          ? {
              _id: parent._id,
              name: parent.name ?? null,
              firstName: parent.firstName ?? null,
              lastName: parent.lastName ?? null,
              email: parent.email ?? null,
              phone: parent.phone ?? null,
              address: parent.address ?? null,
              streetAddress: parent.streetAddress ?? null,
              city: parent.city ?? null,
              state: parent.state ?? null,
              zip: parent.zip ?? null,
              image: parent.image ?? null,
              children: scholarScope
                ? kids.filter((c) => scholarScope.has(c._id))
                : kids,
            }
          : null;
      }),
    );

    return rows.filter((r): r is NonNullable<typeof r> => r !== null);
  },
});

// ── Parent self-service reads (guardian-gated) ──────────────────────────

async function requireEnrolledGuardianChild(
  ctx: QueryCtx & { user: { _id: Id<"users"> } },
  scholarId: Id<"users">,
) {
  // Guardian, or staff previewing the family view ("View as parent"). The
  // reads behind this gate are exactly the non-sensitive ones a teacher can
  // already see on their dashboard; writes (setChildPhoto) stay guardian-only.
  await requireGuardianOrStaffPreview(ctx, scholarId);
  const scholar = await ctx.db.get(scholarId);
  if (!scholar || scholar.role !== ROLES.SCHOLAR) {
    throw new Error("Scholar not found");
  }
  if (isProgramGuest(scholar)) {
    throw new Error(
      `School record access isn't available for ${EXTENDED_EDUCATION_LABEL} scholars.`,
    );
  }
  return scholar;
}

/**
 * The signed-in user's own children (id + name + image) for the child
 * switcher — by GUARDIANSHIP, not role, so a staff/admin guardian sees their
 * children too. Returns [] for a caller with no guardianships, so the /parent
 * page can branch cleanly.
 */
export const listMyChildren = authedQuery({
  args: {},
  handler: async (ctx) => myChildren(ctx, ctx.user._id),
});

async function myChildren(ctx: QueryCtx, parentUserId: Id<"users">) {
  const links = await ctx.db
    .query("guardianships")
    .withIndex("by_parent", (q) => q.eq("parentUserId", parentUserId))
    .collect();
  const children = await Promise.all(
    links.map(async (link) => {
      const scholar = await ctx.db.get(link.scholarUserId);
      return scholar && scholar.role === ROLES.SCHOLAR
        ? {
            _id: scholar._id,
            name: scholar.name ?? "Scholar",
            image: scholar.image ?? null,
            enrollmentStanding: scholar.enrollmentStanding ?? "enrolled",
          }
        : null;
    }),
  );
  return children.filter((c): c is NonNullable<typeof c> => c !== null);
}

/**
 * "View as parent": the children a TEACHER previews the parent portal for —
 * the same row shape `portalContext` returns, so `/parent?remote=<id>`
 * renders the ordinary portal. The requested scholar comes first, then the
 * brothers and sisters who share a guardian with them, so the child switcher
 * looks the way it does for the family. Every child, the requested one
 * included, must pass the same boundary as `requireGuardianOrStaffPreview`
 * (teacher-role membership access, never guardianship, never
 * operations-only staff); a sibling at another school is simply left out.
 * Takes the raw URL param and returns an empty list for anything that isn't
 * a reachable scholar — a malformed id, a non-scholar, another school — so
 * the page fails legibly instead of tripping argument validation.
 */
export const previewFamilyForStaff = authedQuery({
  args: { scholarId: v.string() },
  handler: async (ctx, args) => {
    if (!isTeacherRole(ctx.user.role)) return [];
    const scholarId = ctx.db.normalizeId("users", args.scholarId);
    if (!scholarId) return [];

    const guardianLinks = await ctx.db
      .query("guardianships")
      .withIndex("by_scholar", (q) => q.eq("scholarUserId", scholarId))
      .collect();
    const familyIds: Id<"users">[] = [scholarId];
    for (const link of guardianLinks) {
      const siblingLinks = await ctx.db
        .query("guardianships")
        .withIndex("by_parent", (q) => q.eq("parentUserId", link.parentUserId))
        .collect();
      for (const sibling of siblingLinks) {
        if (!familyIds.includes(sibling.scholarUserId)) {
          familyIds.push(sibling.scholarUserId);
        }
      }
    }

    const children = [];
    for (const id of familyIds) {
      if (!(await canReadScholarAsTeacher(ctx, ctx.user, id))) continue;
      const scholar = await ctx.db.get(id);
      if (!scholar || scholar.role !== ROLES.SCHOLAR) continue;
      children.push({
        _id: scholar._id,
        name: scholar.name ?? "Scholar",
        image: scholar.image ?? null,
        enrollmentStanding: scholar.enrollmentStanding ?? "enrolled",
      });
    }
    // The requested scholar anchors the preview: if the teacher can't reach
    // them, siblings alone don't make a parent view.
    return children[0]?._id === scholarId ? children : [];
  },
});

/**
 * A guardian sets one of their linked children's profile photo. Guardian-gated
 * (by the `guardianships` graph, not role) so a parent — or a staff/admin who
 * is also a guardian — can update their own child's avatar. The upload is
 * validated (allowed image MIME + ≤5 MB) via the shared profile-image helper,
 * the same contract the self/staff avatar writes use. Returns only the resolved
 * image URL (no sensitive scholar data).
 */
export const setChildPhoto = authedMutation({
  args: {
    scholarId: v.id("users"),
    imageStorageId: v.id("_storage"),
  },
  handler: async (ctx, args) => {
    await requireGuardianOf(ctx, args.scholarId);
    const scholar = await ctx.db.get(args.scholarId);
    if (!scholar || scholar.role !== ROLES.SCHOLAR) {
      throw new Error("Scholar not found");
    }
    const image = await resolveValidatedProfileImageUrl(
      ctx,
      args.imageStorageId,
    );
    await ctx.db.patch(args.scholarId, { image });
    return { image };
  },
});

/**
 * The `parent_view_link` aide tool's server-side check (lib/aideTools.ts):
 * may this caller open `/parent?remote=<scholarId>`, and how many parents
 * does that family have? Same boundary as `previewFamilyForStaff`, so the
 * aide never hands out a link the page would refuse. The caller id comes
 * from the transport (Slack identity link, in-app session), never the model.
 */
export const parentViewLinkCheck = internalQuery({
  args: { callerUserId: v.id("users"), scholarId: v.id("users") },
  handler: async (ctx, { callerUserId, scholarId }) => {
    const caller = await ctx.db.get(callerUserId);
    if (!caller || !isTeacherRole(caller.role)) return { ok: false as const };
    if (!(await canReadScholarAsTeacher(ctx, caller, scholarId))) {
      return { ok: false as const };
    }
    const scholar = await ctx.db.get(scholarId);
    if (!scholar || scholar.role !== ROLES.SCHOLAR) return { ok: false as const };
    const guardians = await ctx.db
      .query("guardianships")
      .withIndex("by_scholar", (q) => q.eq("scholarUserId", scholarId))
      .collect();
    return { ok: true as const, guardianCount: guardians.length };
  },
});

/**
 * Whether the signed-in user has a "parent context" (≥1 guardianship). Drives
 * the parent-shell access guard + the account-menu "Parent view" entry for a
 * staff/admin user who is also a guardian. Role-agnostic.
 */
export const hasParentContext = authedQuery({
  args: {},
  handler: async (ctx) => {
    return (
      ctx.user.role === ROLES.PARENT ||
      (await hasGuardianships(ctx, ctx.user._id))
    );
  },
});

/**
 * The parent portal's mode for the signed-in user. `applicantOnly` is true for
 * a parent whose family has applied to the primary institution but has no
 * linked child yet (see lib/applicantParent.ts). The portal then shows only
 * its Admissions tab and none of the enrolled-family surfaces.
 */
export const applicantContext = authedQuery({
  args: {},
  handler: async (ctx) => {
    return {
      applicantOnly: await isApplicantOnlyParent(ctx, ctx.user._id),
    };
  },
});

/**
 * Everything the /parent shell needs before it can draw the tab bar, in one
 * read: whether the caller is a guardian at all (`hasParentContext`), whether
 * they are an applicant-only family (`applicantContext`), and their children
 * (`listMyChildren`). Same bodies as those three queries, so the portal
 * decides its tabs from one result instead of waiting on three. Not used by
 * the staff preview, which reads `previewFamilyForStaff` instead.
 */
export const portalContext = authedQuery({
  args: {},
  handler: async (ctx) => {
    const [hasParentContext, applicantOnly, children] = await Promise.all([
      (async () =>
        ctx.user.role === ROLES.PARENT ||
        (await hasGuardianships(ctx, ctx.user._id)))(),
      isApplicantOnlyParent(ctx, ctx.user._id),
      myChildren(ctx, ctx.user._id),
    ]);
    return { hasParentContext, applicantOnly, children };
  },
});

/**
 * May the signed-in user open the guardian-only pages (/parent/health-form,
 * /parent/forms/*)? Requires a real guardianship. `hasParentContext` is true
 * for any parent-role account, including an applicant with no linked child,
 * so those pages gate on this instead. The per-scholar reads and writes behind
 * them still enforce `requireGuardianOf` on their own.
 */
export const canOpenGuardianForms = authedQuery({
  args: {},
  handler: async (ctx) => {
    return await hasGuardianships(ctx, ctx.user._id);
  },
});

/** Internal: does `userId` have any guardianship? For the /parent-chat-stream gate. */
export const hasGuardianshipsInternal = internalQuery({
  args: { userId: v.id("users") },
  handler: async (ctx, args) => {
    return await hasGuardianships(ctx, args.userId);
  },
});

// The reads below each gate on `requireGuardianOf` then delegate to the
// shared scholar-read layer (lib/scholarReads.ts) — one source of truth
// for "what an agent surface may read," and zero raw-transcript exposure.
// childSummary/childSessions keep their own implementations because their
// shape is parent-specific (and the summary deliberately reads NO
// dossier — that's the invariant requireGuardianOf documents).

export const childSummary = authedQuery({
  args: { scholarId: v.id("users") },
  handler: async (ctx, args) => {
    const scholar = await requireEnrolledGuardianChild(
      ctx,
      args.scholarId,
    );
    return summaryOf(ctx, scholar);
  },
});

/** `childSummary`'s body after its gate; shared with `recordsTab`. */
async function summaryOf(ctx: QueryCtx, scholar: Doc<"users">) {
  const sessions = await ctx.db
    .query("sessions")
    .withIndex("by_user", (q) => q.eq("userId", scholar._id))
    .order("desc")
    .take(10);
  const recentPulse = sessions.find((p) => p.pulseScore != null);

  const masteryObs = await ctx.db
    .query("masteryObservations")
    .withIndex("by_scholar_current", (q) =>
      q.eq("scholarId", scholar._id).eq("isSuperseded", false),
    )
    .collect();
  const domains = new Set(masteryObs.map((o) => o.domain));

  return {
    name: scholar.name ?? "Scholar",
    readingLevel: talkLevelOf(scholar.readingLevel),
    dateOfBirth: scholar.dateOfBirth ?? null,
    recentPulseScore: recentPulse?.pulseScore ?? null,
    totalSessions: sessions.length,
    masteryDomainCount: domains.size,
    masteryObservationCount: masteryObs.length,
  };
}

/**
 * Everything the parent portal's Records tab shows, in one read, so the tab
 * renders once instead of card by card. Each part reuses the body of the
 * query that used to fetch it, gate included:
 *
 * - `summary` — `childSummary` (guardian or staff preview; null for an
 *   Extended Education guest, who has no school record).
 * - `family` — the guardian-only parts, null for a staff previewer, who sees
 *   a placeholder instead. Inside it, the health-form parts follow
 *   `scholarFormsAvailable`: the signed record, physical and clearances only
 *   when the forms are available to an enrolled child; the forms list (`listForGuardian`) for an
 *   Extended Education guest or when the forms are available; the library
 *   card (`libraryCards.getStatus`) for an enrolled child only.
 *
 * `scholarId` comes back with the data so the client can tell which child a
 * retained result belongs to while the next child's loads.
 */
export const recordsTab = authedQuery({
  args: { scholarId: v.id("users") },
  handler: async (ctx, { scholarId }) => {
    await requireGuardianOrStaffPreview(ctx, scholarId);
    const scholar = await ctx.db.get(scholarId);
    if (!scholar || scholar.role !== ROLES.SCHOLAR) {
      throw new Error("Scholar not found");
    }
    const programGuest = isProgramGuest(scholar);
    const summary = programGuest ? null : await summaryOf(ctx, scholar);
    if (!(await isGuardianOf(ctx, ctx.user._id, scholarId))) {
      return { scholarId, programGuest, summary, family: null };
    }

    const formsAvailable = await guardianFormsAvailableFor(ctx, scholarId);
    // The health-form reads refuse an Extended Education guest outright, so
    // they're skipped for one even when `formsAvailable` (a platform admin).
    const healthForms = formsAvailable && !programGuest;
    const [healthRecord, physicalExam, clearanceRequests, libraryCard] =
      await Promise.all([
        healthForms ? guardianHealthRecordStatusFor(ctx, scholarId) : null,
        healthForms ? guardianPhysicalExamFor(ctx, scholarId) : null,
        healthForms ? guardianClearanceRequestsFor(ctx, scholarId) : [],
        programGuest ? null : libraryCardStatusFor(ctx, scholarId),
      ]);
    return {
      scholarId,
      programGuest,
      summary,
      family: {
        formsAvailable,
        healthRecord,
        physicalExam,
        clearanceRequests,
        libraryCard,
      },
    };
  },
});

/**
 * Shared course + whole-child narratives for a linked child — PROSE ONLY.
 * The 1–7 ratings, the AI suggestion, and the Working Level numbers are a
 * staff instrument and are NEVER returned here (§3 prose-only). Guardian-gated,
 * own-children-only. Only `status: "shared"` narratives are visible.
 */
function parentVisibleSections<S extends { key: string; body: string }>(sections: S[]): S[] {
  const report = sections.find((s) => s.key === REPORT_SECTION_KEY && s.body.trim());
  return report ? [report] : sections.filter((s) => s.body.trim());
}

export const childSharedNarratives = authedQuery({
  args: { scholarId: v.id("users") },
  handler: async (ctx, args) => {
    await requireEnrolledGuardianChild(ctx, args.scholarId);

    const periodLabel = async (periodId: Id<"reportingPeriods">) =>
      (await ctx.db.get(periodId))?.label ?? "";
    const goalTitles = async (goalIds: Id<"scholarGoals">[]) => {
      const out: string[] = [];
      for (const gid of goalIds) {
        const g = await ctx.db.get(gid);
        if (g) out.push(g.title);
      }
      return out;
    };

    const courseRows = await ctx.db
      .query("courseNarratives")
      .withIndex("by_scholar", (q) => q.eq("scholarId", args.scholarId))
      .collect();
    // "Work in this report": only pieces the portfolio already shows this
    // family, read once and only when a published report lists any.
    const linksPieces = courseRows.some((n) => n.status === "shared" && (n.pieces ?? []).length > 0);
    const familyPieces = new Map(
      (linksPieces ? await familyPortfolioItems(ctx, args.scholarId) : []).map((item) => [String(item._id), item]),
    );
    const course = await Promise.all(
      courseRows
        .filter((n) => n.status === "shared")
        .map(async (n) => ({
          pieces: (n.pieces ?? []).flatMap((id) => familyPieces.get(String(id)) ?? []),
          _id: n._id,
          periodId: n.periodId,
          // The enrichment row reads as its title, "Enrichment and projects".
          subject: reportTitle(n.subject),
          enrichment: isEnrichmentSubject(n.subject),
          periodLabel: await periodLabel(n.periodId),
          sharedAt: n.sharedAt ?? n._creationTime,
          // PROSE ONLY — omit pcmRatings/courseRating/aiSuggested/workingLevel.
          // A prose report is the whole parent text; retired rubric sections on
          // the same row are teacher notes and never leave staff.
          sections: parentVisibleSections(n.sections),
          goals: await goalTitles(n.goalIds),
        })),
    );

    const wholeRows = await ctx.db
      .query("wholeChildNarratives")
      .withIndex("by_scholar", (q) => q.eq("scholarId", args.scholarId))
      .collect();
    const wholeChild = await Promise.all(
      wholeRows
        .filter((n) => n.status === "shared")
        .map(async (n) => ({
          _id: n._id,
          periodLabel: await periodLabel(n.periodId),
          sharedAt: n.sharedAt ?? n._creationTime,
          sections: n.sections.filter((s) => s.body.trim()),
          goals: await goalTitles(n.goalIds),
        })),
    );

    // Newest first, except that a term's "Enrichment and projects" row comes
    // right after that term's other reports: it is the last report of a term.
    const termEnd = new Map<string, number>();
    for (const n of course)
      if (!n.enrichment)
        termEnd.set(String(n.periodId), Math.min(termEnd.get(String(n.periodId)) ?? n.sharedAt, n.sharedAt));
    const order = (n: (typeof course)[number]) =>
      n.enrichment ? Math.min(n.sharedAt, termEnd.get(String(n.periodId)) ?? n.sharedAt) - 0.5 : n.sharedAt;
    return {
      course: course.sort((a, b) => order(b) - order(a)).map(({ periodId: _p, enrichment: _e, ...n }) => n),
      wholeChild: wholeChild.sort((a, b) => b.sharedAt - a.sharedAt),
    };
  },
});

export const childSessions = authedQuery({
  args: { scholarId: v.id("users") },
  handler: async (ctx, args) => {
    await requireEnrolledGuardianChild(ctx, args.scholarId);
    const sessions = await ctx.db
      .query("sessions")
      .withIndex("by_user_and_archived", (q) =>
        q.eq("userId", args.scholarId).eq("isArchived", false),
      )
      .order("desc")
      .take(20);

    const result = [];
    // An unused tile session is not a session yet (lib/tileSessions.ts).
    // No transcript reads here: the portal's "Recent work" card shows the
    // title, unit, date and summary, all on the session row. A per-session
    // message count used to be read here for a field nothing displayed, which
    // made the card's cost grow with every message the child wrote.
    for (const p of await withoutUnstartedTileSessions(ctx, sessions)) {
      let unitTitle: string | null = null;
      if (p.unitId) {
        const unit = await ctx.db.get(p.unitId);
        unitTitle = unit?.title ?? null;
      }
      result.push({
        title: p.title,
        unitTitle,
        pulseScore: p.pulseScore ?? null,
        createdAt: p._creationTime,
        analysisSummary: p.analysisSummary ?? null,
      });
    }
    return result;
  },
});

export const childMastery = authedQuery({
  args: { scholarId: v.id("users") },
  handler: async (ctx, args) => {
    await requireEnrolledGuardianChild(ctx, args.scholarId);

    const observations = await ctx.db
      .query("masteryObservations")
      .withIndex("by_scholar_current", (q) =>
        q.eq("scholarId", args.scholarId).eq("isSuperseded", false),
      )
      .collect();

    // An honest, non-sugar-coated portrait of what the child does and does NOT
    // yet understand — per domain, split into two grounded narratives:
    //   • understands → current understanding at whatever depth the evidence shows
    //   • notYet      → a "not-yet-built understanding" (the child ↔ a concept,
    //                   NEVER the child ↔ other children). A `misconception_signal`
    //                   is the one reliable "doesn't understand yet" marker the
    //                   observer emits; an addressed misconception is no longer a
    //                   current gap, so it drops out.
    // Parent-safe prose only: the observer's `evidenceSummary` / `misconceptionNote`
    // (already the parent-tier contract), never the raw `transcriptExcerpt`.
    type Understands = { concept: string; level: number; evidence: string };
    type NotYet = { concept: string; evidence: string; note: string | null };
    const byDomain: Record<
      string,
      { understands: Understands[]; notYet: NotYet[] }
    > = {};

    for (const o of observations) {
      if (o.evidenceType === "interest_signal") continue;
      const isMisconception = o.evidenceType === "misconception_signal";
      if (isMisconception && o.misconceptionStatus === "addressed") continue;
      const bucket = (byDomain[o.domain] ??= { understands: [], notYet: [] });
      if (isMisconception) {
        bucket.notYet.push({
          concept: o.conceptLabel,
          evidence: o.evidenceSummary,
          note: o.misconceptionNote ?? null,
        });
      } else {
        bucket.understands.push({
          concept: o.conceptLabel,
          level: o.masteryLevel,
          evidence: o.evidenceSummary,
        });
      }
    }

    // Deepest, most-secure understanding first within each domain.
    for (const groups of Object.values(byDomain)) {
      groups.understands.sort((a, b) => b.level - a.level);
    }
    return byDomain;
  },
});

export const childSignals = authedQuery({
  args: { scholarId: v.id("users") },
  handler: async (ctx, args) => {
    await requireEnrolledGuardianChild(ctx, args.scholarId);
    return await readScholarSignals(ctx, args.scholarId);
  },
});

// A guardian-safe Math Skills portrait — the SAME per-domain grade level the
// teacher subtab shows, gated to this parent's own child, plus what the parent
// Math page draws from it: the overall level and this term's learned pace (the
// two stat tiles), each area's new learning this term ("New this term"), and
// each area's three most recently demonstrated skills (never the full list).
// Non-sensitive by construction: levels and skill names off the practice
// engine, no raw transcripts, no learner↔learner comparison.
export const childMathPortrait = authedQuery({
  args: { scholarId: v.id("users") },
  handler: async (ctx, args) => {
    await requireEnrolledGuardianChild(ctx, args.scholarId);
    return await gatherMathPortrait(ctx.db, args.scholarId, {
      withOverall: true,
      withRecentSkills: true,
    });
  },
});

export const childSeeds = authedQuery({
  args: { scholarId: v.id("users") },
  handler: async (ctx, args) => {
    await requireEnrolledGuardianChild(ctx, args.scholarId);
    // Always the parent audience, including a staff "View as parent"
    // preview: the family sees the scholar's own seed text, never the
    // teacher-private rationale.
    return await readScholarSeeds(ctx, args.scholarId, ROLES.PARENT);
  },
});

// ── The homework plan (Homework tab + parent aide) ──────────────────────

/**
 * One item of a child's homework plan as a parent sees it. Deliberately the
 * PLAN, never STATUS (TRA-574): no done, late or started marks and no
 * completion data of any kind ride this shape, so none can leak through a UI
 * that forgets to hide it. Finished work is listed like everything else.
 */
const homeworkPlanItemValidator = v.object({
  key: v.string(),
  title: v.string(),
  subject: v.union(v.string(), v.null()),
  teacherName: v.union(v.string(), v.null()),
  dueAt: v.union(v.number(), v.null()),
  /** Open-until work (shared/openUntil.ts): when its window closes, shown
   *  where a due date would go. Null for homework. */
  openUntil: v.union(v.number(), v.null()),
  awayFromBunnyPad: v.boolean(),
  /** The unit's emoji, the same glyph the child's own Homework row leads with. */
  emoji: v.union(v.string(), v.null()),
});

const homeworkPlanValidator = v.object({
  timeZone: v.string(),
  items: v.array(homeworkPlanItemValidator),
});

export type HomeworkPlan = {
  timeZone: string;
  items: Array<{
    key: string;
    title: string;
    subject: string | null;
    teacherName: string | null;
    dueAt: number | null;
    openUntil: number | null;
    awayFromBunnyPad: boolean;
    emoji: string | null;
  }>;
};

/**
 * A child's homework plan: every live homework give that reaches this child,
 * read straight from the assignments. Membership never depends on what the
 * child did, so this reads no sessions and no completions at all: starting,
 * finishing, archiving or a re-push that keeps a started copy on the child's
 * list can't change which items exist or how they read. An item leaves only
 * when the teacher withdraws or clears the give (the assignment is archived,
 * the entry is removed, or it no longer targets this child), or when it falls
 * before the window: last week's Monday, or an earlier `fromDayKey`
 * (shared/homeworkPlanWeeks.ts). A dated item falls before it once it was due
 * before that day; an undated one (no due date, no open-until window) once it
 * was given (`setAt`) before that day (TRA-620).
 *
 * Open-until work (a class focus that ends on a later day, shared/openUntil.ts)
 * is on the child's list too, in its own "Open from class" section, so it is in
 * the plan, placed by when its window closes (the tab draws it after the weeks,
 * TRA-724). Like homework, it stays listed after that.
 *
 * The rows a give can produce match the child's own Homework section
 * (scholarPlate.ts `unstartedAssignedRowSurface`, BunnyPad rows), and the
 * onboarding unit is left out as it is there. The order is fixed by plan facts
 * alone: due time, then title, then the give's key. Callers authorize first.
 */
const DAY_KEY = /^\d{4}-\d{2}-\d{2}$/;

/** The earlier of the default window start and a well-formed `fromDayKey`.
 *  A malformed one is ignored rather than trusted as a string compare. */
function earliestDayKey(windowStart: string, fromDayKey: string | undefined) {
  return fromDayKey && DAY_KEY.test(fromDayKey) && fromDayKey < windowStart
    ? fromDayKey
    : windowStart;
}

export async function homeworkPlanForScholar(
  ctx: QueryCtx,
  scholar: Doc<"users">,
  nowMs: number,
  /** The earliest day to include (the month calendar's first row), when it
   *  is before the default window's last-week Monday. */
  fromDayKey?: string,
): Promise<HomeworkPlan> {
  const timeZone = await timeZoneForInstitution(
    ctx,
    await scholarInstitutionId(ctx, scholar._id),
  );
  if (!(await hasScholarMembership(ctx, scholar._id))) {
    return { timeZone, items: [] };
  }
  const windowStart = earliestDayKey(
    homeworkPlanWindowStart(nowMs, timeZone),
    fromDayKey,
  );
  const onboardingUnit = await ctx.db
    .query("units")
    .withIndex("by_slug", (q) => q.eq("slug", ONBOARDING_UNIT_SLUG))
    .first();
  const teacherNames = new Map<Id<"users">, string | null>();
  const items: HomeworkPlan["items"] = [];
  const seen = new Set<string>();

  for (const assignment of await ctx.db.query("assignments").collect()) {
    if (assignment.archivedAt) continue;
    if (!assignment.scholarIds.includes(scholar._id)) continue;
    if (onboardingUnit && assignment.unitId === onboardingUnit._id) continue;
    // The give's class labels its subject (shared with the teacher planner
    // and the family Portfolio, lib/homeworkSubject.ts).
    const classIds = firstClassIdByWork(
      await loadScheduleRows(ctx, assignment._id),
    );
    for (const entry of await readSchedule(ctx, assignment)) {
      if (entry.setAt == null) continue;
      const openUntil = openUntilClosesAt(entry, timeZone);
      if (entry.mode !== "homework" && openUntil == null) continue;
      if (
        entry.scholarIds != null &&
        entry.scholarIds.length > 0 &&
        !entry.scholarIds.some((id) => id === scholar._id)
      ) {
        continue;
      }
      // On homework, endsAt means "ended early"; on open-until it is the
      // window, which stays in the plan after it closes.
      if (openUntil == null && entry.endsAt != null && entry.endsAt <= nowMs) {
        continue;
      }
      // One window for every item: dated work is placed by the day it closes,
      // undated work by the day it was given (TRA-620).
      const closesAt = entry.dueAt ?? openUntil;
      const placedOn =
        closesAt != null
          ? dayKeyForTimezone(closesAt - (openUntil != null ? 1 : 0), timeZone)
          : dayKeyForTimezone(entry.setAt, timeZone);
      if (placedOn < windowStart) continue;
      const key = `${assignment._id}::${entry.activityId}`;
      if (seen.has(key)) continue;
      const activity = await ctx.db.get(entry.activityId);
      if (
        !activity ||
        !(await unstartedAssignedRowSurface(
          ctx,
          activity,
          entry.mode,
          true,
          openUntil != null,
        ))
      ) {
        continue;
      }
      seen.add(key);
      const lesson = activity.lessonId ? await ctx.db.get(activity.lessonId) : null;
      const unit = lesson?.unitId ? await ctx.db.get(lesson.unitId) : null;
      const subject = await homeworkSubjectLabel(ctx, {
        classId: classIds.get(scheduleWorkKey(entry.activityId, entry.mode)),
        activityId: entry.activityId,
      });
      if (!teacherNames.has(assignment.teacherId)) {
        const teacher = await ctx.db.get(assignment.teacherId);
        teacherNames.set(assignment.teacherId, teacher?.name?.trim() || null);
      }
      items.push({
        key,
        title: activity.title,
        subject,
        teacherName: teacherNames.get(assignment.teacherId) ?? null,
        dueAt: openUntil == null ? (entry.dueAt ?? null) : null,
        openUntil,
        awayFromBunnyPad: activity.kind === "offline",
        emoji: unit?.emoji ?? null,
      });
    }
  }
  const closes = (item: HomeworkPlan["items"][number]) =>
    item.dueAt ?? item.openUntil ?? Number.MAX_SAFE_INTEGER;
  items.sort(
    (a, b) =>
      closes(a) - closes(b) ||
      a.title.localeCompare(b.title) ||
      (a.key < b.key ? -1 : a.key > b.key ? 1 : 0),
  );
  return { timeZone, items };
}

/**
 * The parent portal Homework tab's plan for one linked child, plus the
 * school's closures from last week on (the Calendar tab's source,
 * academicCalendar.ts), so a no-school day can sit inside its week, and the
 * child's field trips (TRA-601) from the same day on, for the same reason.
 * Guardian-gated like every portal read (a guardian, or a teacher previewing
 * "View as parent"); another family's child throws.
 */
export const childHomeworkPlan = authedQuery({
  args: {
    scholarId: v.id("users"),
    // Minute-rounded client clock: it places the week window and re-arms the
    // reactive query after institution midnight (T11).
    now: v.optional(v.number()),
    // The month calendar's first day ("2026-11-02"), so a month before last
    // week still shows its homework. Only ever widens the default window.
    fromDayKey: v.optional(v.string()),
  },
  returns: v.object({
    timeZone: v.string(),
    items: v.array(homeworkPlanItemValidator),
    closures: v.array(
      v.object({
        id: v.string(),
        startDayKey: v.string(),
        endDayKey: v.string(),
        label: v.string(),
      }),
    ),
    trips: v.array(
      v.object({
        dayKey: v.string(),
        startLocal: v.string(),
        endLocal: v.string(),
        destination: v.string(),
      }),
    ),
  }),
  handler: async (ctx, args) => {
    const scholar = await requireEnrolledGuardianChild(ctx, args.scholarId);
    // t11-ok: fallback for a client that sends no clock; the page always does.
    const nowMs = args.now ?? Date.now();
    const plan = await homeworkPlanForScholar(ctx, scholar, nowMs, args.fromDayKey);
    const institutionId = await scholarInstitutionId(ctx, scholar._id);
    const windowStart = earliestDayKey(
      homeworkPlanWindowStart(nowMs, plan.timeZone),
      args.fromDayKey,
    );
    const closures = institutionId
      ? (await closuresForInstitution(ctx, institutionId))
          .filter(hasUsableDays)
          .filter((closure) => closure.endDayKey >= windowStart)
          .sort((a, b) => a.startDayKey.localeCompare(b.startDayKey))
          .map((closure) => ({
            id: String(closure._id),
            startDayKey: closure.startDayKey,
            endDayKey: closure.endDayKey,
            label: closure.label,
          }))
      : [];
    const { trips } = await tripsForScholar(ctx, scholar._id, windowStart, "9999-12-31");
    return { ...plan, closures, trips };
  },
});

/**
 * The parent aide's read (get_school_calendar adds the plan for a parent).
 * Authorization is one level up: `makeScholarReadTools` resolves a name only
 * inside the parent's own guardianship set.
 */
export const getChildHomeworkPlan = internalQuery({
  args: { scholarId: v.id("users") },
  returns: v.union(homeworkPlanValidator, v.null()),
  handler: async (ctx, args) => {
    const scholar = await ctx.db.get(args.scholarId);
    if (!scholar || scholar.role !== ROLES.SCHOLAR || isProgramGuest(scholar)) {
      return null;
    }
    // t11-ok: an internal read only the aide's tool action calls, once per turn.
    return await homeworkPlanForScholar(ctx, scholar, Date.now());
  },
});
