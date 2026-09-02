import { v } from "convex/values";
import { query, mutation, internalMutation, internalQuery } from "./_generated/server";
import { authedQuery, authedMutation, teacherQuery, platformAdminMutation, platformAdminQuery, scholarAdminQuery, scholarAdminMutation, schoolAdminMutation } from "./lib/customFunctions";
import { getCurrentUser } from "./lib/auth";
import {
  assertInstitutionActive,
  requireActiveScholarAccess,
  evaluateInstitutionSuspension,
} from "./lib/access";
import {
  curriculumAccessInstitutionIds,
  hasCurriculumAccess,
} from "./lib/curriculumAccess";
import {
  resolveInstitutionLens,
  scholarIdsInLens,
} from "./lib/institutionLens";
import {
  ensureDefaultMembershipForUser,
  ensureMembership,
  retireDefaultMembershipForRole,
} from "./memberships";
import { getAuthUserId } from "@convex-dev/auth/server";
import {
  ROLES,
  isNonTeachingOperationsRole,
  isPlatformAdminRole,
  isStaffRole,
  type Role,
} from "./lib/roles";
import { internal } from "./_generated/api";
import { normalizeEmail, isValidEmail } from "./lib/email";
import { assertValidUsername } from "./lib/username";
import { isValidGradeLevel } from "./lib/standardStrand";
import { seedDefaultAppsForScholar } from "./lib/externalAppsSeed";
import { resolveValidatedProfileImageUrl } from "./lib/profileImage";
import { requireScholarsAccessible } from "./lib/access";
import { scholarHasPasswordCredential } from "./lib/scholarCredential";
import { scheduleClaimDecommissionLocksForScholar } from "./lib/deviceAppUnlockScheduling";
import {
  hasScholarMembership,
  scholarInstitutionId,
} from "./lib/scholarEnrollment";
import type { Id } from "./_generated/dataModel";
import type { Doc } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";
import { createTokenForUser, enrollPath } from "./enrollment";
import {
  findInviteByCode,
  inviteRejectionReason,
} from "./lib/institutionInvites";
import { DEFAULT_TIMEZONE, isValidTimeZone } from "../shared/institutionDay";
import { grantPasswordBind } from "./lib/authGuards";
import { isPublicProductionDeployment } from "./lib/deploymentSafety";

function slugifyInstitutionName(name: string): string {
  return name
    .toLowerCase()
    .replace(/['’ʻ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 96);
}
import { entryTargetsScholar } from "./assignments";
import { ENROLLMENT_STANDINGS } from "./lib/enrollmentStanding";
import {
  EXTENDED_EDUCATION_LABEL,
  includesProgramGuests,
} from "../shared/scholarGroupRouting";
import {
  authorizedGroupIds,
  hasSchoolOperationsAccessAtInstitution,
  healthInstitutionIds,
  schoolOperationsInstitutionIds,
  STAFF_CAPABILITIES,
} from "./lib/staffCapabilities";

/**
 * The outcome of a successful `registerWithCode`, telling the client how to
 * finish signing the new account in:
 *   - "password" → the user row was pre-created; the client completes a
 *     username+password sign-up (scholars + the legacy env-code staff paths).
 *   - "enroll"   → a passwordless (passkey) account was created; the client
 *     redirects to `/enroll?token=…` to register a passkey (school_admin +
 *     staff join invites).
 */
export type RegisterOutcome =
  | { kind: "password"; username: string }
  | { kind: "enroll"; token: string; path: string; username: string };

type CreateInstitutionInviteOutcome = {
  createdInstitutionId: Id<"institutions">;
  redeemedBy: Id<"users">;
  redeemedAt: number;
};

/** Record a successful redemption and its create-school outcome, when present. */
async function consumeInvite(
  ctx: MutationCtx,
  invite: Doc<"institutionInvites">,
  outcome?: CreateInstitutionInviteOutcome,
): Promise<void> {
  await ctx.db.patch(invite._id, {
    usedCount: invite.usedCount + 1,
    ...outcome,
  });
}

/** Validate + default an institution timezone. */
function normalizeInstitutionTimeZone(timeZone?: string): string {
  const t = timeZone?.trim();
  if (!t) return DEFAULT_TIMEZONE;
  if (!isValidTimeZone(t)) throw new Error("Enter a valid IANA time zone");
  return t;
}

/** A slug derived from the school name, made unique against existing rows. */
async function uniqueInstitutionSlug(
  ctx: MutationCtx,
  name: string,
): Promise<string> {
  const base = slugifyInstitutionName(name) || "school";
  let slug = base;
  let n = 2;
  // The institutions table is tiny; this loops at most a handful of times.
  while (
    await ctx.db
      .query("institutions")
      .withIndex("by_slug", (q) => q.eq("slug", slug))
      .unique()
  ) {
    slug = `${base}-${n++}`;
  }
  return slug;
}

/**
 * Redeem a DB-backed institution invite (the multi-tenant onboarding flow).
 * Called from `registerWithCode` after the invite is confirmed redeemable.
 *
 * create_institution → atomically create the new institution (unique slug, NOT
 *   primary, no global grant), the school_admin user, and their school_admin
 *   membership; then mint a passkey enrollment token.
 * join_institution   → create the user + membership at the invite's
 *   institution with the invite's role (scholar accounts also get their
 *   `users.institutionId` stamped + the default apps/onboarding). Scholars
 *   finish with a password; staff (teacher/school_admin) get a passkey enroll
 *   token.
 *
 * Every created membership is stamped with `inviteId`, and the invite's
 * `usedCount` is incremented, all inside this one transactional mutation.
 */
async function redeemInstitutionInvite(
  ctx: MutationCtx,
  invite: Doc<"institutionInvites">,
  args: {
    username: string;
    name?: string;
    email?: string;
    institutionName?: string;
    timeZone?: string;
  },
): Promise<RegisterOutcome> {
  const username = assertValidUsername(args.username);

  const existingUsername = await ctx.db
    .query("users")
    .withIndex("by_username", (q) => q.eq("username", username))
    .unique();
  if (existingUsername) {
    throw new Error(`Username "${username}" is already taken`);
  }

  let email: string | undefined;
  if (args.email && args.email.trim()) {
    email = normalizeEmail(args.email);
    if (!isValidEmail(email)) throw new Error(`Invalid email "${args.email}"`);
    const clash = await ctx.db
      .query("users")
      .withIndex("by_email", (q) => q.eq("email", email))
      .first();
    if (clash) throw new Error(`Email "${email}" is already in use`);
  }
  const name = args.name?.trim() || undefined;
  const verified = email ? { emailVerificationTime: Date.now() } : {};

  if (invite.kind === "create_institution") {
    const rawName = args.institutionName?.trim();
    if (!rawName) throw new Error("Institution name is required");
    // The school leader is passkey-primary (passwordless), so their email is
    // the ONLY magic-link recovery path if they lose their passkey device.
    // Require it here — server-side — so an API caller can't skip what the
    // /join form now demands. (Scholars/staff-join deliberately stay optional.)
    if (!email) {
      throw new Error(
        "An email is required to create a school — it's the sign-in-link backup if you lose your passkey.",
      );
    }
    const timeZone = normalizeInstitutionTimeZone(args.timeZone);

    // The new school leader. school_admin is institution-scoped, never global,
    // so we grant NOTHING platform-wide here. `pendingEnrollment` blocks any
    // password bootstrap onto this credential-less account until the redeemer
    // completes passkey / magic-link enrollment (auth callback refuses it).
    const userId = await ctx.db.insert("users", {
      name,
      username,
      email,
      role: ROLES.SCHOOL_ADMIN,
      pendingEnrollment: true,
      ...verified,
    });
    const slug = await uniqueInstitutionSlug(ctx, rawName);
    const institutionId = await ctx.db.insert("institutions", {
      name: rawName,
      slug,
      kind: "school",
      isPrimary: false, // a partner's school is never the home institution
      timeZone,
      createdBy: userId,
    });
    await ensureMembership(ctx, {
      userId,
      role: ROLES.SCHOOL_ADMIN,
      institutionId,
      createdBy: userId,
      inviteId: invite._id,
    });
    await consumeInvite(ctx, invite, {
      createdInstitutionId: institutionId,
      redeemedBy: userId,
      redeemedAt: Date.now(),
    });
    // Passwordless: the school_admin enrolls a passkey via the returned link.
    const token = await createTokenForUser(ctx, userId, invite.createdBy);
    return { kind: "enroll", token, path: enrollPath(token), username };
  }

  // join_institution
  const role = invite.role as Role;
  const institutionId = invite.institutionId;
  if (!institutionId) {
    throw new Error("This invite is misconfigured (no institution).");
  }
  const inst = await ctx.db.get(institutionId);
  if (!inst) throw new Error("This invite's institution no longer exists.");

  if (role === ROLES.SCHOLAR) {
    const userId = await ctx.db.insert("users", {
      name,
      username,
      email,
      role: ROLES.SCHOLAR,
      institutionId, // stamp the scholar's school so the access boundary sees them
      ...verified,
    });
    await ensureMembership(ctx, {
      userId,
      role: ROLES.SCHOLAR,
      institutionId,
      createdBy: invite.createdBy,
      inviteId: invite._id,
    });
    // Redeeming this invite proves authorization to bind the password the join
    // page submits next. The auth callback consumes this short-lived grant.
    await grantPasswordBind(ctx, userId);
    // Self-registration is a first-class scholar-creation path — seed the
    // default External Apps + welcome quest, same as createScholar.
    await seedDefaultAppsForScholar(ctx, userId);
    await ctx.scheduler.runAfter(0, internal.onboarding.enrollScholar, {
      scholarId: userId,
    });
    await consumeInvite(ctx, invite);
    return { kind: "password", username };
  }

  // Staff join (teacher | school_admin) → passwordless passkey enrollment.
  // `pendingEnrollment` blocks a password bootstrap onto this credential-less
  // account until the redeemer completes enrollment (see the auth callback).
  const userId = await ctx.db.insert("users", {
    name,
    username,
    email,
    role,
    pendingEnrollment: true,
    ...verified,
  });
  await ensureMembership(ctx, {
    userId,
    role,
    institutionId,
    createdBy: invite.createdBy,
    inviteId: invite._id,
  });
  await consumeInvite(ctx, invite);
  const token = await createTokenForUser(ctx, userId, invite.createdBy);
  return { kind: "enroll", token, path: enrollPath(token), username };
}

/**
 * Pre-register a user by redeeming an institution invite — the single public
 * signup entry point. ALWAYS requires a valid, redeemable invite.
 *
 * DB-invite-only (the legacy env codes SIGNUP_CODE / DESIGNER_SIGNUP_CODE /
 * TEACHER_SIGNUP_CODE were removed). There is NO empty-deployment bootstrap
 * here: an empty users table is not proof of a virgin deployment (a prod
 * restore / partial re-seed empties it temporarily — see the /restore-backup
 * skill), so a public "first signup becomes admin" path could mint an anonymous
 * platform admin during a restore window. The first platform admin is created
 * out-of-band via the admin-key-gated `bootstrapFirstPlatformAdmin` below.
 *
 * A matching, redeemable invite creates the institution/user/membership per the
 * invite kind; pre-creating the user row here means the auth callback finds it
 * by username instead of trying to create one (which it now refuses,
 * unconditionally). Any missing / invalid / expired / revoked / exhausted code
 * is rejected.
 */
export const registerWithCode = mutation({
  args: {
    username: v.string(),
    code: v.string(),
    // Additional fields the /join page collects for DB-backed invites.
    name: v.optional(v.string()),
    email: v.optional(v.string()),
    institutionName: v.optional(v.string()),
    timeZone: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<RegisterOutcome> => {
    const username = args.username.trim();

    const invite = await findInviteByCode(ctx, args.code);
    if (!invite) {
      throw new Error("Invalid invite code");
    }
    const reason = inviteRejectionReason(invite, Date.now());
    if (reason) throw new Error(reason);
    return await redeemInstitutionInvite(ctx, invite, { ...args, username });
  },
});

/**
 * Create the FIRST platform admin — the deployment bootstrap. This replaces the
 * old "first public signup becomes admin" path, which was unsafe on production:
 * an empty `users` table is not proof of a virgin deployment (a prod restore /
 * partial re-seed empties it temporarily — see the /restore-backup skill), so a
 * public bootstrap could mint an anonymous platform admin during a restore
 * window.
 *
 * This is an `internalMutation`: it is NOT part of the public API and can only
 * be invoked with deployment admin credentials via the CLI —
 *
 *   npx convex run users:bootstrapFirstPlatformAdmin '{"username":"andy"}'
 *
 * INVARIANT (the one that survives a restore window): it refuses to run if ANY
 * platform admin already EXISTS — checked against both the `users.role` column
 * and `memberships`, since a restore repopulates admins. So on a real
 * production (which always has an admin) this is a no-op safeguard; it only ever
 * creates an account on a genuinely admin-less deployment.
 *
 * It creates the user ROW only. The admin then signs in once with the given
 * username + a password of their choice on the sign-in screen; the auth callback
 * binds that password account to this pre-created row (the seeded-user path in
 * convex/auth.ts). That's the bootstrap exception to passwordless staff — there
 * is no one to issue an enrollment link yet. They can enroll a passkey after.
 */
export const bootstrapFirstPlatformAdmin = internalMutation({
  args: {
    username: v.string(),
    // Optional display name; the profile setup screen can fill it later.
    name: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<{ userId: Id<"users"> }> => {
    const username = assertValidUsername(args.username);

    // Refuse if ANY platform admin already exists — the invariant that holds
    // through a restore window (a restore repopulates admins). Check the
    // denormalized role column…
    const adminByRole = await ctx.db
      .query("users")
      .withIndex("by_role", (q) => q.eq("role", ROLES.PLATFORM_ADMIN))
      .first();
    if (adminByRole) {
      throw new Error(
        "A platform admin already exists — bootstrap is not allowed.",
      );
    }
    // …and any platform_admin membership (defense in depth against a row whose
    // denormalized role drifted from its membership).
    const adminMembership = await ctx.db
      .query("memberships")
      .filter((q) => q.eq(q.field("role"), ROLES.PLATFORM_ADMIN))
      .first();
    if (adminMembership) {
      throw new Error(
        "A platform admin already exists — bootstrap is not allowed.",
      );
    }

    // Reuse an existing username row if present (e.g. a seeded placeholder),
    // otherwise create it. Never create a duplicate username.
    const existing = await ctx.db
      .query("users")
      .withIndex("by_username", (q) => q.eq("username", username))
      .unique();
    const userId =
      existing?._id ??
      (await ctx.db.insert("users", {
        username,
        name: args.name?.trim() || undefined,
        role: ROLES.PLATFORM_ADMIN,
      }));
    if (existing && existing.role !== ROLES.PLATFORM_ADMIN) {
      await ctx.db.patch(userId, { role: ROLES.PLATFORM_ADMIN });
    }
    await ensureDefaultMembershipForUser(ctx, userId);
    return { userId };
  },
});

/**
 * Get the current authenticated user without recoverable app credentials.
 * Library autofill uses scholarApps.credentialsForApp's explicit owner-only
 * path instead of putting a saved PIN in the general client user cache.
 */
export const currentUser = query({
  handler: async (ctx) => {
    const user = await getCurrentUser(ctx);
    if (!user) return null;
    const safeUser = { ...user };
    delete safeUser.libraryCredential;
    // Suspension status for the client paused-screen gate. This query uses the
    // non-throwing getCurrentUser (unlike requireUser) precisely so the app can
    // still bootstrap the user and render a legible "access paused" screen
    // instead of white-screening when every OTHER authed query throws at the
    // requireUser chokepoint. Kept in lockstep with the server block via the
    // shared evaluateInstitutionSuspension.
    const suspension = await evaluateInstitutionSuspension(ctx, user);
    const memberships = await ctx.db
      .query("memberships")
      .withIndex("by_user", (q) => q.eq("userId", user._id))
      .collect();
    const institutionIds = Array.from(
      new Set(
        memberships.flatMap((membership) =>
          membership.institutionId && isStaffRole(membership.role as Role)
            ? [membership.institutionId]
            : [],
        ),
      ),
    );
    const [
      curriculumInstitutions,
      operationsInstitutions,
      healthInstitutions,
      publishingGroups,
      captureReviewGroups,
    ] =
      await Promise.all([
        curriculumAccessInstitutionIds(ctx, user),
        schoolOperationsInstitutionIds(ctx, user),
        healthInstitutionIds(ctx, user),
        Promise.all(
          institutionIds.map((institutionId) =>
            authorizedGroupIds(
              ctx,
              user._id,
              institutionId,
              "program:publish",
            ),
          ),
        ),
        Promise.all(
          institutionIds.map((institutionId) =>
            authorizedGroupIds(
              ctx,
              user._id,
              institutionId,
              "captures:review",
            ),
          ),
        ),
      ]);
    return {
      ...safeUser,
      hasCurriculumAccess:
        curriculumInstitutions === "all" || curriculumInstitutions.size > 0,
      hasSchoolOperationsAccess:
        operationsInstitutions === "all" || operationsInstitutions.size > 0,
      schoolOperationsInstitutionIds:
        operationsInstitutions === "all"
          ? "all"
          : [...operationsInstitutions],
      hasHealthManagementAccess:
        healthInstitutions === "all" || healthInstitutions.size > 0,
      healthInstitutionIds:
        healthInstitutions === "all" ? "all" : [...healthInstitutions],
      hasProgramPublishingAccess:
        isPlatformAdminRole(user.role) ||
        memberships.some(
          (membership) =>
            membership.institutionId &&
            membership.role === ROLES.SCHOOL_ADMIN,
        ) ||
        publishingGroups.some((groupIds) => groupIds.size > 0),
      hasCaptureReviewAccess: captureReviewGroups.some(
        (groupIds) => groupIds.size > 0,
      ),
      institutionSuspended: suspension.blocked,
      institutionSuspendedName: suspension.institutionName,
    };
  },
});

/**
 * Set (or clear) the caller's own staff-aide model preference — the
 * "vote with your feet" opt-in (see convex/lib/aideModel.ts). Staff only:
 * the preference only affects staff-aide surfaces, and scholars/parents
 * must not be able to pick their own model.
 */
export const setAideModel = authedMutation({
  args: {
    model: v.optional(
      v.union(v.literal("sonnet"), v.literal("opus"), v.literal("fable")),
    ),
  },
  handler: async (ctx, args) => {
    if (!isStaffRole(ctx.user.role)) {
      throw new Error("Forbidden: staff only");
    }
    await ctx.db.patch(ctx.user._id, { aideModel: args.model });
  },
});

/**
 * Internal sibling of setAideModel for the aide's own `set_aide_model`
 * tool (the Slack opt-in path — a bot tool runs in an httpAction with an
 * explicit principal, not an authed session). Re-checks the principal's
 * role server-side, same as every other tool-backed mutation.
 */
export const setAideModelInternal = internalMutation({
  args: {
    callerUserId: v.id("users"),
    model: v.optional(
      v.union(v.literal("sonnet"), v.literal("opus"), v.literal("fable")),
    ),
  },
  handler: async (ctx, args) => {
    const caller = await ctx.db.get(args.callerUserId);
    if (!caller || !isStaffRole(caller.role)) {
      throw new Error("Forbidden: staff only");
    }
    await ctx.db.patch(args.callerUserId, { aideModel: args.model });
  },
});

/**
 * Store / update user on login.
 * Called after successful auth — creates user if new, updates if existing.
 */
export const storeUser = mutation({
  args: {
    email: v.string(),
    name: v.string(),
    image: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("Not authenticated");

    const existing = await ctx.db.get(userId);
    if (existing) {
      await ctx.db.patch(userId, {
        name: args.name,
        image: args.image,
      });
      return userId;
    }

    await ctx.db.patch(userId, {
      email: args.email,
      name: args.name,
      image: args.image,
    });
    return userId;
  },
});

/**
 * List all scholars (for teacher dashboard).
 * Returns scholars with project counts and status.
 */
export const listScholars = scholarAdminQuery({
  args: {
    // Back-compat lens: older callers pass "primary", "all", or an institution
    // id. New URL-driven callers use `institutionScope` with a pretty slug.
    scope: v.optional(
      v.union(v.literal("primary"), v.literal("all"), v.id("institutions")),
    ),
    // Default ("primary"/"") resolves to the caller's home staff membership and
    // includes not-yet-assigned scholars when that home is the primary school.
    // Pass a member institution slug for just that school, or "all" for all
    // institutions the caller may access (admins = every institution).
    // Invalid/non-member slugs fall back home.
    institutionScope: v.optional(v.string()),
    // Ordinary school workflows are enrolled-only. Extended Education scholars
    // require an explicit caller opt-in (for example, editing a Robotics group).
    includeProgramGuests: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const lens = await resolveInstitutionLens(
      ctx,
      ctx.user,
      args.institutionScope ?? args.scope ?? "",
    );

    // Resolve institutions once so each scholar row can carry its
    // institution's name/slug.
    const institutions = await ctx.db.query("institutions").collect();
    const instById = new Map(institutions.map((i) => [i._id, i]));

    const scholarIds = await scholarIdsInLens(ctx, lens, {
      includeProgramGuests: args.includeProgramGuests === true,
    });
    const scholars = (
      await Promise.all([...scholarIds].map((id) => ctx.db.get(id)))
    ).filter((scholar): scholar is NonNullable<typeof scholar> => !!scholar);

    // Non-teaching operations staff administer accounts but must not see
    // learning data: observer scores (pulse), AI status summaries, transcript
    // snippets, reading level, or process state. Strip all of that from their view.
    const isNonTeachingOps = isNonTeachingOperationsRole(ctx.user.role);

    const scholarData = await Promise.all(
      scholars.map(async (scholar) => {
        const institutionId = await scholarInstitutionId(ctx, scholar._id);
        const hasLearnerEnrollment = await hasScholarMembership(
          ctx,
          scholar._id,
        );
        // Get projects (most recent 5, non-archived)
        const sessionsForUser = await ctx.db
          .query("sessions")
          .withIndex("by_user", (q) => q.eq("userId", scholar._id))
          .order("desc")
          .collect();
        const allSessions = sessionsForUser.filter(
          (session) =>
            session.institutionId === institutionId ||
            (session.institutionId === undefined &&
              hasLearnerEnrollment),
        );

        const activeSessions = allSessions.filter((c) => !c.isArchived).slice(0, 5);

        // Count messages across all projects, and track the single latest
        // message timestamp across ALL sessions (not just the most-recently-
        // CREATED one) — reusing this same scan rather than adding a query.
        let messageCount = 0;
        let latestMessageAt = 0;
        for (const proj of allSessions) {
          const msgs = await ctx.db
            .query("messages")
            .withIndex("by_session", (q) =>
              q.eq("sessionId", proj._id)
            )
            .collect();
          messageCount += msgs.length;
          for (const msg of msgs) {
            if (msg._creationTime > latestMessageAt) {
              latestMessageAt = msg._creationTime;
            }
          }
        }

        // Latest practice attempt (check-in/playlist/placement lanes all write
        // here) — practice never touches `sessions`/`messages`, so without this
        // a scholar who only practiced today reads as stale (see
        // FIX_WAVE_PLAN.md T4).
        const latestAttempt = await ctx.db
          .query("practiceAttempts")
          .withIndex("by_scholar", (q) => q.eq("scholarId", scholar._id))
          .order("desc")
          .first();
        const latestPracticeAt =
          latestAttempt?.createdAt ?? latestAttempt?._creationTime ?? 0;

        // Whether the scholar already has a stored PIN (a `password` auth
        // account). Drives the "Create PIN" (no credential yet) vs "Reset PIN"
        // (already has one) label on the roster — a boolean only, never the
        // secret. Cheap indexed lookup; see lib/scholarCredential.ts.
        const hasCredential = await scholarHasPasswordCredential(
          ctx,
          scholar._id,
        );

        // Get status summary, pulse score, last message, and lastMessageAt from most recent project
        const mostRecent = activeSessions[0];
        const statusSummary = mostRecent?.analysisSummary ?? null;
        const pulseScore = mostRecent?.pulseScore ?? null;
        let lastMessage: string | null = null;
        let lastMessageAt: number | null = null;
        if (mostRecent && !isNonTeachingOps) {
          const msgs = await ctx.db
            .query("messages")
            .withIndex("by_session", (q) =>
              q.eq("sessionId", mostRecent._id)
            )
            .order("desc")
            .collect();
          const lastUserMsg = msgs.find((m) => m.role === "user");
          if (lastUserMsg) {
            const text = lastUserMsg.content;
            lastMessage = text.length > 120 ? text.slice(0, 120) + "..." : text;
            lastMessageAt = lastUserMsg._creationTime;
          }
        }

        // Get process state from most recent project (resolve via unit's building block)
        let processStep: string | null = null;
        let processTitle: string | null = null;
        if (mostRecent?.unitId && !isNonTeachingOps) {
          const unit = await ctx.db.get(mostRecent.unitId);
          if (unit?.processId) {
            const pState = await ctx.db
              .query("processState")
              .withIndex("by_session", (q) =>
                q.eq("sessionId", mostRecent._id)
              )
              .first();
            if (pState) {
              processStep = pState.currentStep;
              const process = await ctx.db.get(unit.processId);
              processTitle = process?.title ?? null;
            }
          }
        }

        return {
          _id: scholar._id,
          id: scholar._id,
          username: scholar.username ?? null,
          name: scholar.name,
          image: scholar.image,
          enrollmentStanding: scholar.enrollmentStanding ?? "enrolled",
          hasCredential,
          institutionId: institutionId ?? null,
          institutionSlug: institutionId
            ? (instById.get(institutionId)?.slug ?? null)
            : null,
          institutionName: institutionId
            ? (instById.get(institutionId)?.name ?? null)
            : null,
          institutionKind: institutionId
            ? (instById.get(institutionId)?.kind ?? null)
            : null,
          readingLevel: isNonTeachingOps ? null : (scholar.readingLevel ?? null),
          dateOfBirth: scholar.dateOfBirth ?? null,
          gradeLevel: scholar.gradeLevel ?? null,
          sessionCount: activeSessions.length,
          messageCount,
          lastActive: Math.max(
            mostRecent?._creationTime ?? scholar._creationTime,
            latestMessageAt,
            latestPracticeAt,
          ),
          statusSummary: isNonTeachingOps ? null : statusSummary,
          pulseScore: isNonTeachingOps ? null : pulseScore,
          lastMessage,
          lastMessageAt,
          lastSessionTitle: isNonTeachingOps ? null : (mostRecent?.title ?? null),
          processStep,
          processTitle,
        };
      })
    );

    // Sort by name
    scholarData.sort((a, b) => (a.name ?? "").localeCompare(b.name ?? ""));
    return scholarData;
  },
});

/**
 * Minimal scholar identity and credential state for the family directory.
 * Scoped through the same institution lens as the full scholar roster, while
 * avoiding its per-scholar learning-record reads.
 */
export const listDirectoryScholars = scholarAdminQuery({
  args: { institutionScope: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const lens = await resolveInstitutionLens(
      ctx,
      ctx.user,
      args.institutionScope,
    );
    const scholarIds = await scholarIdsInLens(ctx, lens, {
      includeProgramGuests: true,
    });
    const scholars = (
      await Promise.all([...scholarIds].map((id) => ctx.db.get(id)))
    ).filter((scholar): scholar is NonNullable<typeof scholar> => !!scholar);

    const directory = await Promise.all(
      scholars.map(async (scholar) => ({
        _id: scholar._id,
        name: scholar.name ?? null,
        image: scholar.image ?? null,
        username: scholar.username ?? null,
        enrollmentStanding:
          scholar.enrollmentStanding ?? ENROLLMENT_STANDINGS.ENROLLED,
        hasCredential: await scholarHasPasswordCredential(ctx, scholar._id),
      })),
    );
    directory.sort((a, b) => (a.name ?? "").localeCompare(b.name ?? ""));
    return directory;
  },
});

/**
 * Get a single user by ID — PROJECTED to non-sensitive identity fields only.
 *
 * This is an `authedQuery` (any authenticated user, incl. a parent) that
 * accepts an arbitrary `userId`, so it must NOT return the raw user doc:
 * that carries custody-sensitive contact info (`address`/`phone`/`email`) a
 * parent must never read about another parent (see convex/parents.ts +
 * schema.ts). Its only callers are teacher "remote mode" banners, which need
 * just name + image. Project accordingly.
 */
export const getUser = authedQuery({
  args: { userId: v.id("users") },
  handler: async (ctx, args) => {
    const u = await ctx.db.get(args.userId);
    if (!u) return null;
    return { _id: u._id, name: u.name ?? null, image: u.image ?? null, role: u.role ?? null };
  },
});

/**
 * Update user role (admin only).
 */
export const updateRole = platformAdminMutation({
  args: {
    userId: v.id("users"),
    role: v.union(
      v.literal(ROLES.SCHOLAR),
      v.literal(ROLES.TEACHER),
      v.literal(ROLES.PLATFORM_ADMIN),
      v.literal(ROLES.SCHOOL_ADMIN),
      v.literal(ROLES.CURRICULUM_DESIGNER),
      v.literal(ROLES.STAFF),
      v.literal(ROLES.PARENT)
    ),
  },
  handler: async (ctx, args) => {
    const user = await ctx.db.get(args.userId);
    if (!user) throw new Error("User not found");
    if (user.role !== args.role) {
      await retireDefaultMembershipForRole(ctx, user);
    }
    await ctx.db.patch(args.userId, { role: args.role });
    // Keep the user's membership in sync with their new role.
    await ensureDefaultMembershipForUser(ctx, args.userId);
  },
});

/**
 * Admin: create a new account with a chosen username, optional name, and role.
 * Username must be unique. Returns the new userId so the caller can immediately
 * issue a passkey enrollment link (enrollment.issueToken) for staff accounts.
 */
export const adminCreateUser = platformAdminMutation({
  args: {
    username: v.string(),
    name: v.optional(v.string()),
    role: v.union(
      v.literal(ROLES.SCHOLAR),
      v.literal(ROLES.TEACHER),
      v.literal(ROLES.PLATFORM_ADMIN),
      v.literal(ROLES.SCHOOL_ADMIN),
      v.literal(ROLES.CURRICULUM_DESIGNER),
      v.literal(ROLES.STAFF)
    ),
    // Which institution a newly created SCHOLAR belongs to. Ignored for staff
    // roles (they stay global / get stamped by ensureDefaultMembershipForUser).
    // Absent → ensureDefaultMembershipForUser stamps the primary school.
    institutionId: v.optional(v.id("institutions")),
  },
  handler: async (ctx, args) => {
    const username = assertValidUsername(args.username);
    const existing = await ctx.db
      .query("users")
      .withIndex("by_username", (q) => q.eq("username", username))
      .unique();
    if (existing) throw new Error(`Username "${username}" is already taken`);
    // For a scholar, honor an explicit institution choice; ensureDefaultMembership
    // below reads users.institutionId, so stamp it at insert time. Validate it
    // exists first. Non-scholar roles ignore this.
    let institutionId: Id<"institutions"> | undefined;
    if (args.role === ROLES.SCHOLAR && args.institutionId) {
      const inst = await ctx.db.get(args.institutionId);
      if (!inst) throw new Error("Institution not found");
      institutionId = args.institutionId;
    }
    const userId = await ctx.db.insert("users", {
      username,
      name: args.name?.trim() || undefined,
      role: args.role,
      ...(institutionId ? { institutionId } : {}),
    });
    await ensureDefaultMembershipForUser(ctx, userId);
    // New scholars get the default External Apps (any flagged default provider) on their
    // launcher. Other roles have no launcher. Idempotent.
    if (args.role === ROLES.SCHOLAR) {
      await seedDefaultAppsForScholar(ctx, userId, ctx.user._id);
    }
    await ctx.scheduler.runAfter(0, internal.onboarding.enrollScholar, {
      scholarId: userId,
    });
    return { userId };
  },
});

/**
 * Fix role for a user (no auth required — run via CLI).
 * Usage: npx convex run users:fixRole '{"userId":"<id>","role":"platform_admin"}'
 */
export const fixRole = internalMutation({
  args: {
    userId: v.id("users"),
    role: v.union(v.literal(ROLES.SCHOLAR), v.literal(ROLES.TEACHER), v.literal(ROLES.PLATFORM_ADMIN), v.literal(ROLES.SCHOOL_ADMIN), v.literal(ROLES.CURRICULUM_DESIGNER), v.literal(ROLES.STAFF), v.literal(ROLES.PARENT)),
  },
  handler: async (ctx, args) => {
    const user = await ctx.db.get(args.userId);
    if (!user) throw new Error(`No user found with id: ${args.userId}`);
    if (user.role !== args.role) {
      await retireDefaultMembershipForRole(ctx, user);
    }
    await ctx.db.patch(args.userId, { role: args.role });
    await ensureDefaultMembershipForUser(ctx, args.userId);
    return { updated: args.userId, name: user.name, role: args.role };
  },
});

/**
 * Internal: set any user's profile image from a stored file (CLI only).
 * Resolves the storage id to a serving URL and patches `image`. Works for
 * ANY role (staff included) — unlike updateProfile (self) and
 * adminUpdateScholarProfile (scholars). Used to seed staff profile photos.
 */
export const setUserImageInternal = internalMutation({
  args: { userId: v.id("users"), imageStorageId: v.id("_storage") },
  handler: async (ctx, args) => {
    const user = await ctx.db.get(args.userId);
    if (!user) throw new Error(`No user found with id: ${args.userId}`);
    const url = await ctx.storage.getUrl(args.imageStorageId);
    if (!url) throw new Error(`No file found for storage id: ${args.imageStorageId}`);
    await ctx.db.patch(args.userId, { image: url });
    return { updated: args.userId, name: user.name, image: url };
  },
});

/**
 * Internal operator repair for legacy scholar profiles that were completed
 * before `profileSetupComplete` existed. The expected username and populated
 * profile fields keep an accidental user id from suppressing real onboarding.
 */
export const repairCompletedProfileSetup = internalMutation({
  args: {
    userId: v.id("users"),
    expectedUsername: v.string(),
  },
  handler: async (ctx, args) => {
    const user = await ctx.db.get(args.userId);
    if (!user || user.role !== ROLES.SCHOLAR) {
      throw new Error("Scholar not found");
    }
    if (user.username !== args.expectedUsername) {
      throw new Error("Username does not match the requested scholar");
    }
    if (!user.name?.trim() || !user.dateOfBirth || !user.image) {
      throw new Error("Scholar profile is not complete enough to repair");
    }
    if (user.profileSetupComplete === true) {
      return { updated: false };
    }

    await ctx.db.patch(user._id, { profileSetupComplete: true });
    return { updated: true };
  },
});

/** Internal: delete a user by ID (CLI only). */
export const internalDeleteUser = internalMutation({
  args: { userId: v.id("users") },
  handler: async (ctx, args) => {
    const user = await ctx.db.get(args.userId);
    if (!user) throw new Error(`No user found with id: ${args.userId}`);
    await scheduleClaimDecommissionLocksForScholar(ctx, args.userId);
    await ctx.db.delete(args.userId);
    return { deleted: args.userId, name: user.name, email: user.email };
  },
});

/**
 * Internal: full-cascade delete of ANY user (not role-gated like
 * teacherAide.deleteScholar). CLI/dashboard only — for operator cleanup of
 * stray accounts (e.g. smoke-test users). Reuses deleteUserCore, so auth
 * accounts/sessions, memberships, and all scholar-keyed records go with it.
 */
export const internalDeleteUserCascade = internalMutation({
  args: { userId: v.id("users"), callerUserId: v.id("users") },
  handler: async (ctx, args) => deleteUserCore(ctx, args.userId, args.callerUserId),
});

/** Internal: fetch a single user document by id. */
export const getByIdInternal = internalQuery({
  args: { id: v.id("users") },
  handler: async (ctx, args) => {
    return await ctx.db.get(args.id);
  },
});

/** Internal action bridge for the session owner's curriculum-design capability. */
export const hasCurriculumAccessInternal = internalQuery({
  args: { id: v.id("users") },
  handler: async (ctx, args) => {
    const user = await ctx.db.get(args.id);
    if (!user) return false;
    await assertInstitutionActive(ctx, user);
    return await hasCurriculumAccess(ctx, user);
  },
});

export const schoolOperationsInstitutionIdsInternal = internalQuery({
  args: { id: v.id("users") },
  handler: async (ctx, args) => {
    const user = await ctx.db.get(args.id);
    if (!user) return [] as Id<"institutions">[];
    const ids = await schoolOperationsInstitutionIds(ctx, user);
    return ids === "all" ? "all" : [...ids];
  },
});

export const healthInstitutionIdsInternal = internalQuery({
  args: { id: v.id("users") },
  handler: async (ctx, args) => {
    const user = await ctx.db.get(args.id);
    if (!user) return [] as Id<"institutions">[];
    const ids = await healthInstitutionIds(ctx, user);
    return ids === "all" ? "all" : [...ids];
  },
});

export const hasSchoolOperationsAccessAtInstitutionInternal = internalQuery({
  args: {
    id: v.id("users"),
    institutionId: v.id("institutions"),
  },
  handler: async (ctx, args) => {
    const user = await ctx.db.get(args.id);
    if (!user) return false;
    return await hasSchoolOperationsAccessAtInstitution(
      ctx,
      user,
      args.institutionId,
    );
  },
});

/**
 * Internal: may this email use a magic-link sign-in? True when a user with
 * this (normalized) email exists AND that stored email is a real external
 * address.
 *
 * Capability-based, NOT role-based: ANY account that has an email on file
 * can sign in with a magic link — scholars included, once they (or an
 * operator) set one. There's no role allowlist; auth method follows the
 * credential you have, not your user type. Accounts without an email (most
 * scholars) are simply inert here. The `isValidEmail` check also rejects
 * the synthetic `username@local` address the Password provider uses (no dot
 * in the domain), so a password-only account can never be magic-linked into.
 *
 * Used by the magic-link provider's `sendVerificationRequest` to avoid
 * emailing links to non-accounts, and mirrors the verification-time gate in
 * `auth.ts:resolveMagicLinkUser`.
 */
export const isMagicLinkEligible = internalQuery({
  args: { email: v.string() },
  handler: async (ctx, args) => {
    const email = normalizeEmail(args.email);
    if (!isValidEmail(email)) return false;
    const user = await ctx.db
      .query("users")
      .withIndex("by_email", (q) => q.eq("email", email))
      .unique();
    return !!user && isValidEmail(user.email ?? "");
  },
});

/**
 * Shared: set/replace a user's email, enforcing uniqueness so two accounts
 * can't share an email (which would make `by_email` lookups ambiguous and
 * break magic-link resolution). Backs both the operator path
 * (`adminSetUserEmail`) and the self-service path (`setMyEmail`).
 *
 * `verified` controls `emailVerificationTime`:
 *   - operator entry (`verified: true`) pre-verifies — a trusted admin typed
 *     it, and the magic link proves inbox control on first use anyway.
 *   - self-service (`verified: false`) does NOT pre-verify: a user can type
 *     any address, so we leave it unproven and let the first successful
 *     magic-link use stamp `emailVerificationTime` (`auth.ts:resolveMagicLinkUser`).
 * Either way the email becomes magic-link eligible (eligibility keys off the
 * address, not the verification stamp).
 *
 * `genericClashError` softens the uniqueness-collision message for
 * self-service so an authenticated user can't probe which emails already
 * belong to an account (a mild enumeration vector); operators get the
 * specific message.
 */
async function patchUserEmail(
  ctx: MutationCtx,
  userId: Id<"users">,
  rawEmail: string,
  opts: { verified: boolean; genericClashError?: boolean },
): Promise<{ userId: Id<"users">; email: string }> {
  const email = normalizeEmail(rawEmail);
  if (!isValidEmail(email)) throw new Error("Enter a valid email address");

  const target = await ctx.db.get(userId);
  if (!target) throw new Error("User not found");

  const clash = await ctx.db
    .query("users")
    .withIndex("by_email", (q) => q.eq("email", email))
    .unique();
  if (clash && clash._id !== userId) {
    throw new Error(
      opts.genericClashError
        ? "That email address can't be used. Try a different one."
        : "That email is already in use by another account",
    );
  }

  // The address changed, so a prior verification no longer applies: stamp now
  // for trusted operator entry, otherwise clear it (unproven until first use).
  await ctx.db.patch(userId, {
    email,
    emailVerificationTime: opts.verified ? Date.now() : undefined,
  });
  return { userId, email };
}

/**
 * Admin: set/replace ANY user's email (trusted operator entry, pre-verified).
 * Works on any role — staff, parents, and scholars (a scholar with an email
 * gets passwordless magic-link sign-in as an option; their password still
 * works). Parent emails are also set via `parents.ts` (operations staff/admin).
 */
export const adminSetUserEmail = platformAdminMutation({
  args: { userId: v.id("users"), email: v.string() },
  handler: async (ctx, args) =>
    patchUserEmail(ctx, args.userId, args.email, { verified: true }),
});

/**
 * Self-service: the signed-in user sets/updates their OWN email. This is the
 * opt-in path that lets a scholar (or anyone) turn on passwordless email
 * sign-in for themselves — no role gate, the same primitive for every user
 * type. NOT pre-verified (the user could type any address); the first
 * successful magic-link use stamps `emailVerificationTime`.
 */
export const setMyEmail = authedMutation({
  args: { email: v.string() },
  handler: async (ctx, args) =>
    patchUserEmail(ctx, ctx.user._id, args.email, {
      verified: false,
      genericClashError: true,
    }),
});

/**
 * Self-service: the signed-in user removes their OWN email, turning off
 * passwordless email sign-in (their password / passkey are unaffected). Also
 * drops the verification stamp. Idempotent when no email is set.
 */
export const clearMyEmail = authedMutation({
  args: {},
  handler: async (ctx) => {
    await ctx.db.patch(ctx.user._id, {
      email: undefined,
      emailVerificationTime: undefined,
    });
    return { ok: true };
  },
});

/** Internal: fetch a user by username (used by the dev-only test login). */
export const getByUsernameInternal = internalQuery({
  args: { username: v.string() },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("users")
      .withIndex("by_username", (q) => q.eq("username", args.username))
      .unique();
  },
});

/**
 * Internal: resolve a Slack workspace member to their Rabbithole account.
 * The Slack bot's identity bridge — returns null for unmapped users (the
 * bot fails closed). See review/slack-bot-plan.md.
 */
export const getBySlackIdInternal = internalQuery({
  args: { slackUserId: v.string() },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("users")
      .withIndex("by_slackUserId", (q) => q.eq("slackUserId", args.slackUserId))
      .unique();
  },
});

/**
 * Internal: the staff directory the `send_slack_dm` aide tool resolves a
 * recipient against. STAFF-role users ONLY — a scholar or parent must never be
 * a DM target, so they aren't even candidates for the name match. Returns just
 * the fields the tool needs to name a person and open a Slack IM; `slackUserId`
 * is null when the staffer isn't linked to Slack (the tool then returns the
 * "not linked" instruction instead of sending).
 */
export const listStaffForSlackDmInternal = internalQuery({
  args: {},
  handler: async (ctx) => {
    const users = await ctx.db.query("users").collect();
    return users
      .filter((u) => isStaffRole(u.role))
      .map((u) => ({
        id: u._id,
        name: u.name ?? u.username ?? "Unknown",
        username: u.username ?? null,
        slackUserId: u.slackUserId ?? null,
      }));
  },
});

/**
 * Admin: set (or clear, with undefined) a user's Slack member id. Enforces
 * uniqueness — one Slack identity may map to at most one Rabbithole user,
 * otherwise the bot couldn't pick a principal.
 */
export const adminSetSlackUserId = platformAdminMutation({
  args: {
    userId: v.id("users"),
    slackUserId: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const target = await ctx.db.get(args.userId);
    if (!target) throw new Error("User not found");
    const slackUserId = args.slackUserId?.trim() || undefined;
    if (slackUserId) {
      const existing = await ctx.db
        .query("users")
        .withIndex("by_slackUserId", (q) => q.eq("slackUserId", slackUserId))
        .unique();
      if (existing && existing._id !== args.userId) {
        throw new Error(
          `That Slack id is already linked to ${existing.name ?? existing.username ?? "another user"}`,
        );
      }
    }
    await ctx.db.patch(args.userId, { slackUserId });
  },
});

/**
 * Internal (CLI-only): link a Slack member id to a Rabbithole user — the
 * CLI-runnable twin of adminSetSlackUserId, which needs a platform-admin
 * browser identity `npx convex run` can't supply. Same uniqueness guard (one
 * Slack identity maps to at most one user, or the bot couldn't pick a
 * principal). Pass slackUserId omitted/empty to CLEAR the link.
 */
export const setSlackUserIdInternal = internalMutation({
  args: {
    userId: v.id("users"),
    slackUserId: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const target = await ctx.db.get(args.userId);
    if (!target) throw new Error(`No user found with id: ${args.userId}`);
    const slackUserId = args.slackUserId?.trim() || undefined;
    if (slackUserId) {
      const existing = await ctx.db
        .query("users")
        .withIndex("by_slackUserId", (q) => q.eq("slackUserId", slackUserId))
        .unique();
      if (existing && existing._id !== args.userId) {
        throw new Error(
          `That Slack id is already linked to ${existing.name ?? existing.username ?? "another user"}`,
        );
      }
    }
    await ctx.db.patch(args.userId, { slackUserId });
    return {
      updated: args.userId,
      name: target.name,
      slackUserId: slackUserId ?? null,
    };
  },
});

/** Internal: list users (for CLI debugging). */
export const internalListUsers = internalQuery({
  args: {},
  handler: async (ctx) => {
    const users = await ctx.db.query("users").collect();
    return users.map((u) => ({ _id: u._id, name: u.name, username: u.username, role: u.role }));
  },
});

/**
 * Dev-only: the set of users you can `/dev-login` as on THIS deployment
 * (anyone with a username — devLogin resolves by username). Powers the
 * self-describing `/dev-login` index + the bad-username error so neither an
 * agent nor a human ever has to guess a username from drifting docs.
 *
 * Same prod guards as the `devLogin` provider (convex/auth.ts): never on
 * prod, requires the dev secret. Returns `[]` for prod / wrong-secret callers
 * so they learn nothing — the page renders "unavailable" in that case.
 */
export const listDevLoginUsers = query({
  args: { secret: v.string() },
  handler: async (ctx, args) => {
    const isProductionDeployment = (() => {
      const cloudUrl = process.env.CONVEX_CLOUD_URL;
      if (!cloudUrl) return false;
      return isPublicProductionDeployment("RABBITHOLE_ALLOW_DEV_LOGIN");
    })();
    if (isProductionDeployment) return [];
    const secret = process.env.DEV_TEST_LOGIN_SECRET;
    if (!secret || args.secret !== secret) return [];
    const users = await ctx.db.query("users").collect();
    return users
      .flatMap((u) =>
        u.username
          ? [{ username: u.username, name: u.name ?? null, role: u.role ?? ROLES.SCHOLAR }]
          : [],
      )
      .sort((a, b) => `${a.role}\u0000${a.username}`.localeCompare(`${b.role}\u0000${b.username}`));
  },
});

/**
 * List all users (admin only).
 */
export const listAllUsers = platformAdminQuery({
  args: {},
  handler: async (ctx) => {
    const users = await ctx.db.query("users").collect();
    const learnerMemberships = await ctx.db
      .query("memberships")
      .withIndex("by_role", (q) => q.eq("role", ROLES.SCHOLAR))
      .collect();
    const learnerByUser = new Map(
      learnerMemberships.map((membership) => [membership.userId, membership]),
    );
    return users.map((u) => ({
      _id: u._id,
      username: u.username ?? null,
      name: u.name ?? null,
      // Photo for the canonical <PersonCell> used by person-list rows.
      image: u.image ?? null,
      role: u.role ?? ROLES.SCHOLAR,
      email: u.email ?? null,
      slackUserId: u.slackUserId ?? null,
      institutionId: u.institutionId ?? null,
      learnerMembershipId:
        u.role === ROLES.SCHOLAR
          ? null
          : (learnerByUser.get(u._id)?._id ?? null),
      learnerInstitutionId:
        u.role === ROLES.SCHOLAR
          ? null
          : (learnerByUser.get(u._id)?.institutionId ?? null),
      _creationTime: u._creationTime,
    }));
  },
});

/**
 * List the STAFF in the caller's institution(s) — the roster behind the
 * `/school/directory/staff` surface. Scholar-admin gate (read-only for any
 * scholar-admin — teacher / operations staff / school_admin / platform_admin), matching
 * the sibling Scholars/Guardians directory reads; a platform admin sees all
 * institutions' staff. MANAGING staff (add / remove / send enroll link) stays
 * school-admin-only via schoolAdminMutation. Staff are identified by their
 * membership row (teacher / operations staff / curriculum_designer / school_admin), so
 * this reflects who actually belongs to the institution, not a denormalized
 * `users.role`. Scoped to the caller's institution lens (the hard per-scholar
 * boundary is separate; this is a staff directory).
 */
export const listInstitutionStaff = scholarAdminQuery({
  args: { scope: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const lens = await resolveInstitutionLens(ctx, ctx.user, args.scope);
    const staffRoles = new Set<string>([
      ROLES.TEACHER,
      ROLES.STAFF,
      ROLES.CURRICULUM_DESIGNER,
      ROLES.SCHOOL_ADMIN,
    ]);
    const allInstitutions = await ctx.db.query("institutions").collect();
    // With an active institution lens (?inst=<slug>), narrow to the single
    // resolved school — the resolver only honors an institution the caller may
    // see, so a school_admin passing another school's scope falls back to their
    // home (never the other school). With no scope (or "all") keep today's
    // behavior: a platform admin sees every institution's staff, a school-scoped
    // staffer sees the institution(s) they belong to.
    const institutionIds =
      args.scope !== undefined && lens.scope === "institution" && lens.institution
        ? [lens.institution._id]
        : lens.isAdmin
          ? allInstitutions.map((i) => i._id)
          : [...lens.allowedInstitutionIds];

    const instById = new Map(allInstitutions.map((i) => [i._id, i]));
    const seen = new Set<string>();
    const out: Array<{
      id: Id<"users">;
      name: string | null;
      username: string | null;
      email: string | null;
      image: string | null;
      role: string;
      institutionId: Id<"institutions">;
      institutionName: string | null;
    }> = [];
    for (const instId of institutionIds) {
      const mems = await ctx.db
        .query("memberships")
        .withIndex("by_institution", (q) => q.eq("institutionId", instId))
        .collect();
      for (const m of mems) {
        if (!staffRoles.has(m.role) || seen.has(m.userId)) continue;
        const u = await ctx.db.get(m.userId);
        if (!u) continue;
        seen.add(m.userId);
        out.push({
          id: u._id,
          name: u.name ?? null,
          username: u.username ?? null,
          email: u.email ?? null,
          image: u.image ?? null,
          role: m.role,
          institutionId: instId,
          institutionName: instById.get(instId)?.name ?? null,
        });
      }
    }
    out.sort((a, b) => (a.name ?? "").localeCompare(b.name ?? ""));
    return out;
  },
});

/**
 * Delete a user and all associated data (admin only).
 * Cascading delete: projects (with messages, artifacts, analyses, processState),
 * observations, mastery, seeds, signals, connections, dossiers,
 * assignments, and auth sessions/accounts.
 */
/**
 * Cascade-delete a user and every record that references them. Shared core so
 * both the public `deleteUser` (admin dashboard) and the AI bot tool
 * (`internal.teacherAide.deleteScholar`) destroy a scholar identically.
 *
 * `callerUserId` is the actor; self-deletion is refused here regardless of
 * caller path. Role gating happens at the call site (platformAdminMutation / the
 * tool assembler's platform-admin gate).
 */
export async function deleteUserCore(
  ctx: MutationCtx,
  userId: Id<"users">,
  callerUserId: Id<"users">,
): Promise<{ deleted: boolean; name: string }> {
  // Prevent self-deletion
  if (userId === callerUserId) {
    throw new Error("Cannot delete yourself");
  }

  const targetUser = await ctx.db.get(userId);
  if (!targetUser) throw new Error("User not found");

  const args = { userId };

  // 1. Delete all projects and their children (messages, artifacts, analyses, processState)
    const sessions = await ctx.db
      .query("sessions")
      .withIndex("by_user", (q) => q.eq("userId", args.userId))
      .collect();

    for (const session of sessions) {
      const messages = await ctx.db
        .query("messages")
        .withIndex("by_session", (q) => q.eq("sessionId", session._id))
        .collect();
      for (const msg of messages) await ctx.db.delete(msg._id);

      const artifacts = await ctx.db
        .query("artifacts")
        .withIndex("by_session", (q) => q.eq("sessionId", session._id))
        .collect();
      for (const a of artifacts) await ctx.db.delete(a._id);

      const analyses = await ctx.db
        .query("analyses")
        .withIndex("by_session", (q) => q.eq("sessionId", session._id))
        .collect();
      for (const a of analyses) await ctx.db.delete(a._id);

      const processStates = await ctx.db
        .query("processState")
        .withIndex("by_session", (q) => q.eq("sessionId", session._id))
        .collect();
      for (const ps of processStates) await ctx.db.delete(ps._id);

      await ctx.db.delete(session._id);
    }

    // 2. Delete observations (as scholar or teacher)
    const obsAsScholar = await ctx.db
      .query("observations")
      .withIndex("by_scholar", (q) => q.eq("scholarId", args.userId))
      .collect();
    for (const o of obsAsScholar) await ctx.db.delete(o._id);

    const obsAsTeacher = await ctx.db
      .query("observations")
      .withIndex("by_teacher", (q) => q.eq("teacherId", args.userId))
      .collect();
    for (const o of obsAsTeacher) await ctx.db.delete(o._id);

    // 3. Delete mastery observations + teacher overrides
    const mastery = await ctx.db
      .query("masteryObservations")
      .withIndex("by_scholar", (q) => q.eq("scholarId", args.userId))
      .collect();
    for (const m of mastery) {
      // Delete any teacher overrides for this observation
      const overrides = await ctx.db
        .query("teacherMasteryOverrides")
        .withIndex("by_scholar", (q) => q.eq("scholarId", args.userId))
        .collect();
      for (const ov of overrides) await ctx.db.delete(ov._id);
      await ctx.db.delete(m._id);
    }

    // 4. Delete seeds
    const seeds = await ctx.db
      .query("seeds")
      .withIndex("by_scholar_status", (q) => q.eq("scholarId", args.userId))
      .collect();
    for (const s of seeds) await ctx.db.delete(s._id);

    // 5. Delete session signals
    const signals = await ctx.db
      .query("sessionSignals")
      .withIndex("by_scholar", (q) => q.eq("scholarId", args.userId))
      .collect();
    for (const s of signals) await ctx.db.delete(s._id);

    // 6. Delete cross-domain connections
    const connections = await ctx.db
      .query("crossDomainConnections")
      .withIndex("by_scholar", (q) => q.eq("scholarId", args.userId))
      .collect();
    for (const c of connections) await ctx.db.delete(c._id);

    // 7. Delete scholar dossiers
    const dossiers = await ctx.db
      .query("scholarDossiers")
      .withIndex("by_scholar", (q) => q.eq("scholarId", args.userId))
      .collect();
    for (const d of dossiers) await ctx.db.delete(d._id);

    // 8. Delete assignments (post Assignments split — used to be
    // focusSettings).
    const assignments = await ctx.db
      .query("assignments")
      .withIndex("by_teacher", (q) => q.eq("teacherId", args.userId))
      .collect();
    for (const a of assignments) await ctx.db.delete(a._id);

    // 9. Delete auth sessions and accounts
    const authSessions = await ctx.db
      .query("authSessions")
      .filter((q) => q.eq(q.field("userId"), args.userId))
      .collect();
    for (const s of authSessions) {
      // Delete refresh tokens for this session
      const refreshTokens = await ctx.db
        .query("authRefreshTokens")
        .filter((q) => q.eq(q.field("sessionId"), s._id))
        .collect();
      for (const rt of refreshTokens) await ctx.db.delete(rt._id);
      await ctx.db.delete(s._id);
    }

    const accounts = await ctx.db
      .query("authAccounts")
      .filter((q) => q.eq(q.field("userId"), args.userId))
      .collect();
    for (const a of accounts) {
      // Delete verification codes for this account
      const codes = await ctx.db
        .query("authVerificationCodes")
        .filter((q) => q.eq(q.field("accountId"), a._id))
        .collect();
      for (const c of codes) await ctx.db.delete(c._id);
      await ctx.db.delete(a._id);
    }

    // 9b. Delete institution memberships (role/institution context rows).
    // Not scholar-keyed, so it belongs in the CORE — both the admin-dashboard
    // deleteUser and the internal cascade benefit, and no membership row is
    // left dangling to a now-deleted user.
    const memberships = await ctx.db
      .query("memberships")
      .withIndex("by_user", (q) => q.eq("userId", args.userId))
      .collect();
    for (const m of memberships) await ctx.db.delete(m._id);

    // 9c. Delete guardianship links in BOTH directions. The family directory
    // (parents.listAllParents) derives its guardian set from this whole table,
    // so a dangling link to a deleted parent or scholar must not linger.
    const asGuardian = await ctx.db
      .query("guardianships")
      .withIndex("by_parent", (q) => q.eq("parentUserId", args.userId))
      .collect();
    for (const g of asGuardian) await ctx.db.delete(g._id);
    const asWard = await ctx.db
      .query("guardianships")
      .withIndex("by_scholar", (q) => q.eq("scholarUserId", args.userId))
      .collect();
    for (const g of asWard) await ctx.db.delete(g._id);

    // 9d. A deleted scholar can never again be "authorized", but nothing else
    // in this cascade tells an already-unlocked managed device to re-lock —
    // schedule that BEFORE the user row disappears so the durable relock
    // record survives regardless of what happens to the user/claim rows next.
    await scheduleClaimDecommissionLocksForScholar(ctx, args.userId);

    // 10. Finally, delete the user
    await ctx.db.delete(args.userId);

    return { deleted: true, name: targetUser.name ?? targetUser.username ?? "Unknown" };
}

export const deleteUser = platformAdminMutation({
  args: {
    userId: v.id("users"),
  },
  handler: async (ctx, args) => {
    return await deleteUserCore(ctx, args.userId, ctx.user._id);
  },
});

/**
 * Update the current user's profile.
 * Scholars can update their own name, dateOfBirth, image.
 * Reading level is teacher-only (use scholars.updateReadingLevel).
 */
export const updateProfile = authedMutation({
  args: {
    name: v.optional(v.string()),
    dateOfBirth: v.optional(v.string()),
    imageStorageId: v.optional(v.id("_storage")),
    profileSetupComplete: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const patch: Record<string, string | boolean | undefined | null> = {};
    if (args.name !== undefined) patch.name = args.name.trim();
    if (args.dateOfBirth !== undefined) patch.dateOfBirth = args.dateOfBirth;
    if (args.imageStorageId !== undefined) {
      patch.image = await resolveValidatedProfileImageUrl(
        ctx,
        args.imageStorageId,
      );
    }
    if (args.profileSetupComplete !== undefined) {
      patch.profileSetupComplete = args.profileSetupComplete;
    }

    if (Object.keys(patch).length > 0) {
      await ctx.db.patch(ctx.user._id, patch);
    }
  },
});

/**
 * Update the current user's preferred font.
 */
export const updatePreferredFont = authedMutation({
  args: { preferredFont: v.union(v.string(), v.null()) },
  handler: async (ctx, args) => {
    await ctx.db.patch(ctx.user._id, {
      preferredFont: args.preferredFont ?? undefined,
    });
  },
});

/**
 * Create a new scholar user (any scholar-admin: teacher / operations staff /
 * school_admin / platform_admin).
 *
 * Institution stamping: the scholar is filed into the CALLER's institution —
 * resolved from the active institution lens (the `?inst=` the roster is scoped
 * to), preferring the lensed school, then the caller's home, then the primary
 * as a last resort. This mirrors `createInstitutionStaff`. Without it the
 * scholar routed through `ensureDefaultMembershipForUser`, whose
 * no-`institutionId` fallback stamps the GLOBAL PRIMARY school — so a
 * non-primary school admin (an outside partner school) creating a scholar would
 * silently file that child into the primary institution. A primary-school
 * caller is unaffected (their home already resolves to the primary).
 */
export const createScholar = scholarAdminMutation({
  args: {
    name: v.string(),
    username: v.optional(v.string()),
    // Honors the active institution lens so a platform admin acting under a
    // lens files the scholar into the lensed school. Absent → the caller's
    // home institution.
    scope: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const lens = await resolveInstitutionLens(ctx, ctx.user, args.scope);
    const institutionId =
      lens.institution?._id ??
      lens.homeInstitution?._id ??
      lens.primaryInstitution?._id;
    if (!institutionId) {
      throw new Error("No institution to assign this scholar to");
    }

    // Usernames are a login key (`by_username` unique lookups back /dev-login,
    // auth, and the directory), so refuse a collision up front now that the
    // school-admin "Add scholar" surface lets a username be typed. Mirrors
    // createInstitutionStaff / adminCreateUser.
    const username = args.username?.trim()
      ? assertValidUsername(args.username)
      : undefined;
    if (username) {
      const existing = await ctx.db
        .query("users")
        .withIndex("by_username", (q) => q.eq("username", username))
        .unique();
      if (existing) throw new Error(`Username "${username}" is already taken`);
    }

    const userId = await ctx.db.insert("users", {
      name: args.name.trim(),
      username,
      role: ROLES.SCHOLAR,
      // Stamp the user row so ensureDefaultMembershipForUser mints the
      // membership on the SAME school (it reads users.institutionId for
      // scholars) — keeping user.institutionId and the membership consistent.
      institutionId,
    });
    await ensureDefaultMembershipForUser(ctx, userId);
    // Seed the scholar's home launcher with the default External Apps
    // (any flagged default provider). Idempotent. See review/external-apps-launcher.html §3.
    await seedDefaultAppsForScholar(ctx, userId, ctx.user._id);
    await ctx.scheduler.runAfter(0, internal.onboarding.enrollScholar, {
      scholarId: userId,
    });
    return { userId };
  },
});

/**
 * Create a STAFF account inside the caller's own institution. School-admin
 * only (the institution leader) — operations staff administer scholars/families but
 * do NOT grant staff roles, and granting another `school_admin` or
 * `platform_admin` stays platform-only (those are not in the allowed set).
 *
 * The new staffer is stamped to the caller's active institution (resolved via
 * the institution lens — their home institution; a platform admin acting here
 * falls back to the primary). Returns the userId so the caller can immediately
 * mint a passkey enrollment link (`enrollment.issueStaffEnrollLink`).
 */
export const createInstitutionStaff = schoolAdminMutation({
  args: {
    name: v.string(),
    username: v.optional(v.string()),
    email: v.optional(v.string()),
    role: v.union(
      v.literal(ROLES.TEACHER),
      v.literal(ROLES.STAFF),
      v.literal(ROLES.CURRICULUM_DESIGNER),
    ),
  },
  handler: async (ctx, args) => {
    const name = args.name.trim();
    if (!name) throw new Error("Name is required");

    // The caller's institution — what every staffer they create belongs to.
    const lens = await resolveInstitutionLens(ctx, ctx.user);
    const institutionId = lens.homeInstitution?._id ?? lens.primaryInstitution?._id;
    if (!institutionId) {
      throw new Error("No institution to assign this staff member to");
    }

    const username = args.username?.trim()
      ? assertValidUsername(args.username)
      : undefined;
    if (username) {
      const existing = await ctx.db
        .query("users")
        .withIndex("by_username", (q) => q.eq("username", username))
        .unique();
      if (existing) throw new Error(`Username "${username}" is already taken`);
    }

    let email: string | undefined;
    if (args.email && args.email.trim()) {
      email = normalizeEmail(args.email);
      if (!isValidEmail(email)) throw new Error(`Invalid email "${args.email}"`);
      // Emails must be globally unique — magic-link resolution + eligibility
      // checks do a `by_email…unique()` that THROWS on a collision, which would
      // break sign-in for both accounts. (Mirrors patchUserEmail.)
      const emailClash = await ctx.db
        .query("users")
        .withIndex("by_email", (q) => q.eq("email", email))
        .first();
      if (emailClash) throw new Error(`Email "${email}" is already in use`);
    }

    const userId = await ctx.db.insert("users", {
      name,
      username,
      email,
      role: args.role,
      ...(email ? { emailVerificationTime: Date.now() } : {}),
    });
    // Stamp the staffer to the CALLER's institution (not the primary default).
    await ensureMembership(ctx, {
      userId,
      role: args.role,
      institutionId,
      createdBy: ctx.user._id,
    });
    return { userId };
  },
});

/**
 * Remove a non-admin staffer's membership in the caller's own institution.
 *
 * This is intentionally NOT account deletion: the user row, auth credentials,
 * and any memberships in other schools remain. It only revokes the school-local
 * staff access row(s), and refuses protected operator roles.
 */
export const removeStaffFromInstitution = schoolAdminMutation({
  args: { userId: v.id("users") },
  handler: async (ctx, args) => {
    if (args.userId === ctx.user._id) {
      throw new Error("Cannot remove yourself from school");
    }

    const target = await ctx.db.get(args.userId);
    if (!target) throw new Error("Staff account not found");
    if (
      target.role === ROLES.SCHOOL_ADMIN ||
      isPlatformAdminRole(target.role as Role | undefined)
    ) {
      throw new Error("Cannot remove school or platform admins");
    }

    const lens = await resolveInstitutionLens(ctx, ctx.user);
    if (lens.allowedInstitutionIds.size === 0) {
      throw new Error("No institution to remove this staff member from");
    }

    const memberships = await ctx.db
      .query("memberships")
      .withIndex("by_user", (q) => q.eq("userId", args.userId))
      .collect();

    if (
      memberships.some(
        (m) =>
          m.role === ROLES.SCHOOL_ADMIN ||
          isPlatformAdminRole(m.role as Role | undefined),
      )
    ) {
      throw new Error("Cannot remove school or platform admins");
    }

    const removableRoles = new Set<string>([
      ROLES.TEACHER,
      ROLES.STAFF,
      ROLES.CURRICULUM_DESIGNER,
    ]);
    // Scope to ANY institution the caller administers — matches the staff list
    // (listInstitutionStaff) and the "Send link" action (issueStaffEnrollLink),
    // which both use allowedInstitutionIds. (Only homeInstitution would make the
    // Remove button hard-fail for a multi-institution admin's non-home staff.)
    const scopedMemberships = memberships.filter(
      (m) => !!m.institutionId && lens.allowedInstitutionIds.has(m.institutionId),
    );
    if (scopedMemberships.length === 0) {
      throw new Error("Staff account not found in your institution");
    }
    const removable = scopedMemberships.filter((m) => removableRoles.has(m.role));
    if (removable.length === 0) {
      throw new Error("No removable staff membership found");
    }

    for (const membership of removable) {
      await ctx.db.delete(membership._id);
    }
    const removedInstitutionIds = new Set(
      removable.flatMap((membership) =>
        membership.institutionId ? [membership.institutionId] : [],
      ),
    );
    const now = Date.now();
    for (const capability of STAFF_CAPABILITIES) {
      const grants = await ctx.db
        .query("staffCapabilityGrants")
        .withIndex("by_grantee_capability", (q) =>
          q.eq("granteeUserId", args.userId).eq("capability", capability),
        )
        .collect();
      for (const grant of grants) {
        if (
          grant.revokedAt === undefined &&
          removedInstitutionIds.has(grant.institutionId)
        ) {
          await ctx.db.patch(grant._id, {
            revokedAt: now,
            revokedBy: ctx.user._id,
          });
        }
      }
    }
    return { removed: removable.length };
  },
});

/**
 * Scholar-admin: edit a scholar's basic profile (name / DOB / grade / avatar).
 * Allowed for teacher, admin, operations staff. Target must be a scholar.
 * Reading level and other measurements are NOT editable here — those
 * stay teacher-only (scholars.updateReadingLevel).
 */
export const adminUpdateScholarProfile = scholarAdminMutation({
  args: {
    scholarId: v.id("users"),
    name: v.optional(v.string()),
    dateOfBirth: v.optional(v.string()),
    // Chronological grade ("K"–"8"), or null to clear. This is the reference
    // notch on the Knowledge Tree / Acceleration view, NOT a measurement —
    // roster info like DOB, so it lives here (and operations staff may set it).
    gradeLevel: v.optional(v.union(v.string(), v.null())),
    imageStorageId: v.optional(v.id("_storage")),
  },
  handler: async (ctx, args) => {
    await requireActiveScholarAccess(ctx, ctx.user, args.scholarId);
    const scholar = await ctx.db.get(args.scholarId);
    if (!scholar || scholar.role !== ROLES.SCHOLAR) {
      throw new Error("Scholar not found");
    }
    const patch: Record<string, string | undefined> = {};
    if (args.name !== undefined) {
      const trimmed = args.name.trim();
      // Don't let a cleared field blank the scholar's name everywhere.
      if (trimmed === "") throw new Error("Name cannot be empty");
      patch.name = trimmed;
    }
    if (args.dateOfBirth !== undefined) patch.dateOfBirth = args.dateOfBirth;
    if (args.gradeLevel !== undefined) {
      if (args.gradeLevel !== null && !isValidGradeLevel(args.gradeLevel)) {
        throw new Error("Invalid grade level");
      }
      patch.gradeLevel = args.gradeLevel ?? undefined;
    }
    if (args.imageStorageId !== undefined) {
      patch.image = await resolveValidatedProfileImageUrl(
        ctx,
        args.imageStorageId,
      );
    }
    if (Object.keys(patch).length > 0) {
      await ctx.db.patch(args.scholarId, patch);
    }
  },
});

/**
 * Flip a scholar between full enrollment and Extended education
 * (program-guest) standing. `enrollmentStanding` is the ONE canonical
 * participation discriminator (isProgramGuest/isEnrolledScholar) — group
 * membership never classifies a scholar. Historically only the
 * programFamilies onboarding stamped it, so scholars onboarded through the
 * enrolled flow but who actually attend Extended education only had no
 * correction path and leaked into enrolled-only rosters.
 *
 * ADMIN-ONLY, like setScholarInstitution: standing gates which staff
 * workflows include the scholar (health forms, attendance, family sharing,
 * enrolled rosters), so it is an access-shaped fact, not routine profile
 * editing.
 */
async function setEnrollmentStandingCore(
  ctx: MutationCtx,
  scholarId: Id<"users">,
  enrollmentStanding: (typeof ENROLLMENT_STANDINGS)[keyof typeof ENROLLMENT_STANDINGS],
) {
  const scholar = await ctx.db.get(scholarId);
  if (!scholar || scholar.role !== ROLES.SCHOLAR) {
    throw new Error("Scholar not found");
  }
  if (enrollmentStanding === ENROLLMENT_STANDINGS.PROGRAM_GUEST) {
    // Mirror scholarGroups' invariant (assertProgramGuestMembership): guests
    // may only belong to Extended education groups. Refuse legibly instead of
    // leaving the group in a state its own mutations would reject.
    const groups = await ctx.db.query("scholarGroups").collect();
    const blocking = groups.filter(
      (group) =>
        group.scholarIds.includes(scholarId) && !includesProgramGuests(group),
    );
    if (blocking.length > 0) {
      throw new Error(
        `${EXTENDED_EDUCATION_LABEL} scholars can only belong to an ` +
          `${EXTENDED_EDUCATION_LABEL} group. First remove this scholar from ${blocking
            .map((group) => `"${group.name}"`)
            .join(", ")}, or mark ${
            blocking.length === 1 ? "that group" : "those groups"
          } as ${EXTENDED_EDUCATION_LABEL} in Manage groups.`,
      );
    }
  }
  await ctx.db.patch(scholarId, { enrollmentStanding });
  return {
    updated: scholarId,
    name: scholar.name,
    enrollmentStanding,
  };
}

export const setScholarEnrollmentStanding = platformAdminMutation({
  args: {
    scholarId: v.id("users"),
    enrollmentStanding: v.union(
      v.literal(ENROLLMENT_STANDINGS.ENROLLED),
      v.literal(ENROLLMENT_STANDINGS.PROGRAM_GUEST),
    ),
  },
  handler: async (ctx, args) =>
    setEnrollmentStandingCore(ctx, args.scholarId, args.enrollmentStanding),
});

/**
 * Internal CLI twin (the fixRole pattern) for operator corrections.
 * Usage: npx convex run users:fixEnrollmentStanding
 *   '{"userId":"<id>","enrollmentStanding":"program_guest"}'
 */
export const fixEnrollmentStanding = internalMutation({
  args: {
    userId: v.id("users"),
    enrollmentStanding: v.union(
      v.literal(ENROLLMENT_STANDINGS.ENROLLED),
      v.literal(ENROLLMENT_STANDINGS.PROGRAM_GUEST),
    ),
  },
  handler: async (ctx, args) =>
    setEnrollmentStandingCore(ctx, args.userId, args.enrollmentStanding),
});

/**
 * ASSIGNMENTS-layer read for one scholar: active cohort assignment
 * memberships plus whether they're targeted by the active class focus.
 * Quests and scholar-scoped Independent Study units are derived elsewhere,
 * never from this query.
 */
export const assignmentsForScholar = teacherQuery({
  args: { scholarId: v.id("users") },
  handler: async (ctx, args) => {
    await requireScholarsAccessible(ctx, ctx.user, [args.scholarId]);
    const candidates = await ctx.db.query("assignments").collect();
    const scholarAssignments = candidates.filter(
      (a) => !a.archivedAt && a.scholarIds.includes(args.scholarId),
    );
    const assignments = await Promise.all(
      [...scholarAssignments]
        .sort((a, b) => b.startedAt - a.startedAt)
        .map(async (a) => {
          const unit = a.unitId ? await ctx.db.get(a.unitId) : null;
          const title =
            a.title?.trim() ||
            unit?.title ||
            (a.practiceMode === "standing" ? "Standing practice" : "Assignment");
          return {
            assignmentId: a._id,
            title,
            unitTitle: unit?.title ?? null,
            unitEmoji: unit?.emoji ?? null,
          };
        }),
    );

    // Active CLASS-focus Assignment for this scholar (post Assignments
    // split). Find any non-archived assignment targeting this scholar
    // with a populated classFocus slot whose endsAt hasn't elapsed.
    const now = Date.now();
    // Find any assignment targeting this scholar with an active
    // classFocus push in its schedule.
    let focus:
      | {
          unitId: Id<"units"> | null;
          unitTitle: string | null;
          activityId: Id<"activities"> | null;
          activityTitle: string | null;
        }
      | null = null;
    for (const a of scholarAssignments) {
      const active = (a.activitySchedule ?? []).find(
        (e) =>
          e.mode === "classFocus" &&
          entryTargetsScholar(e, args.scholarId) &&
          e.setAt != null &&
          (!e.endsAt || e.endsAt > now),
      );
      if (!active) continue;
      // Ad-hoc dispatches (kind: "adHocDispatch") are unit-less yet DO
      // populate activitySchedule, so an active classFocus entry does not
      // imply a unitId — null-guard the read (a bare get(undefined) throws).
      const unit = a.unitId ? await ctx.db.get(a.unitId) : null;
      const activity = await ctx.db.get(active.activityId);
      focus = {
        unitId: a.unitId ?? null,
        unitTitle: unit?.title ?? null,
        activityId: active.activityId,
        activityTitle: activity?.title ?? null,
      };
      break;
    }

    return { assignments, focus };
  },
});
