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

import { v } from "convex/values";
import { authedQuery, authedMutation, scholarAdminQuery, scholarAdminMutation } from "./lib/customFunctions";
import {
  requireActiveScholarAccess,
  requireScholarsAccessible,
} from "./lib/access";
import { internalQuery, internalAction } from "./_generated/server";
import { internal } from "./_generated/api";
import { requireGuardianOf, hasGuardianships } from "./lib/auth";
import { resolveValidatedProfileImageUrl } from "./lib/profileImage";
import { ensureDefaultMembershipForUser, ensureMembership } from "./memberships";
import { ROLES, isStaffRole, isPlatformAdminRole } from "./lib/roles";
import { normalizeEmail, isValidEmail } from "./lib/email";
import { sendClaimInviteEmail } from "./lib/claimInviteEmail";
import {
  readScholarSignals,
  readScholarSeeds,
} from "./lib/scholarReads";
import { gatherMathPortrait } from "./mathPortrait";
import { resolveInstitutionLens, scholarIdsInLens } from "./lib/institutionLens";
import { isProgramGuest } from "./lib/enrollmentStanding";
import { EXTENDED_EDUCATION_LABEL } from "../shared/scholarGroupRouting";
import type { Id } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";

// ── Scholar-admin: manage parent accounts + guardianship links ──────────

function cleanOptional(value: string | undefined) {
  return value?.trim() || undefined;
}

function formatStructuredAddress(parts: {
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
    const existing = await ctx.db
      .query("users")
      .withIndex("by_email", (q) => q.eq("email", email))
      .unique();
    if (existing && existing.role !== ROLES.PARENT) {
      const adminLinkingStaff =
        isPlatformAdminRole(ctx.user.role) && isStaffRole(existing.role);
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
      const patch: Record<string, unknown> = {};
      if (!existing.name) patch.name = name;
      if (!existing.firstName && firstName) patch.firstName = firstName;
      if (!existing.lastName && lastName) patch.lastName = lastName;
      if (!existing.emailVerificationTime) patch.emailVerificationTime = Date.now();
      if (!existing.phone && phone) patch.phone = phone;
      if (!existing.address && address) patch.address = address;
      if (!existing.streetAddress && streetAddress) patch.streetAddress = streetAddress;
      if (!existing.city && city) patch.city = city;
      if (!existing.state && state) patch.state = state;
      if (!existing.zip && zip) patch.zip = zip;
      if (Object.keys(patch).length) await ctx.db.patch(existing._id, patch);
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
        : await scholarIdsInLens(ctx, lens, { includeProgramGuests: true });

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
  await requireGuardianOf(ctx, scholarId);
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
  handler: async (ctx) => {
    const links = await ctx.db
      .query("guardianships")
      .withIndex("by_parent", (q) => q.eq("parentUserId", ctx.user._id))
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

    const sessions = await ctx.db
      .query("sessions")
      .withIndex("by_user", (q) => q.eq("userId", args.scholarId))
      .order("desc")
      .take(10);
    const recentPulse = sessions.find((p) => p.pulseScore != null);

    const masteryObs = await ctx.db
      .query("masteryObservations")
      .withIndex("by_scholar_current", (q) =>
        q.eq("scholarId", args.scholarId).eq("isSuperseded", false),
      )
      .collect();
    const domains = new Set(masteryObs.map((o) => o.domain));

    return {
      name: scholar.name ?? "Scholar",
      readingLevel: scholar.readingLevel ?? null,
      dateOfBirth: scholar.dateOfBirth ?? null,
      recentPulseScore: recentPulse?.pulseScore ?? null,
      totalSessions: sessions.length,
      masteryDomainCount: domains.size,
      masteryObservationCount: masteryObs.length,
    };
  },
});

/**
 * Shared course + whole-child narratives for a linked child — PROSE ONLY.
 * The 1–7 ratings, the AI suggestion, and the Working Level numbers are a
 * staff instrument and are NEVER returned here (§3 prose-only). Guardian-gated,
 * own-children-only. Only `status: "shared"` narratives are visible.
 */
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
    const course = await Promise.all(
      courseRows
        .filter((n) => n.status === "shared")
        .map(async (n) => ({
          _id: n._id,
          subject: n.subject,
          periodLabel: await periodLabel(n.periodId),
          sharedAt: n.sharedAt ?? n._creationTime,
          // PROSE ONLY — omit pcmRatings/courseRating/aiSuggested/workingLevel.
          sections: n.sections.filter((s) => s.body.trim()),
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

    return {
      course: course.sort((a, b) => b.sharedAt - a.sharedAt),
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
    for (const p of sessions) {
      let unitTitle: string | null = null;
      if (p.unitId) {
        const unit = await ctx.db.get(p.unitId);
        unitTitle = unit?.title ?? null;
      }
      const messages = await ctx.db
        .query("messages")
        .withIndex("by_session", (q) => q.eq("sessionId", p._id))
        .collect();
      result.push({
        title: p.title,
        unitTitle,
        pulseScore: p.pulseScore ?? null,
        messageCount: messages.length,
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

// A guardian-safe Math Skills portrait — the SAME per-domain grade level +
// real growth trajectory the teacher subtab shows, gated to this parent's own
// child. Non-sensitive by construction: grade bands + month-over-month growth
// off the practice frontier, no raw transcripts, no learner↔learner comparison.
export const childMathPortrait = authedQuery({
  args: { scholarId: v.id("users") },
  handler: async (ctx, args) => {
    await requireEnrolledGuardianChild(ctx, args.scholarId);
    return await gatherMathPortrait(ctx.db, args.scholarId);
  },
});

export const childSeeds = authedQuery({
  args: { scholarId: v.id("users") },
  handler: async (ctx, args) => {
    await requireEnrolledGuardianChild(ctx, args.scholarId);
    return await readScholarSeeds(ctx, args.scholarId);
  },
});
