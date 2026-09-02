// Memberships — a user's roles/contexts (see schema.ts `memberships`).
//
// Granting/revoking a membership is an ADMIN act (it grants access to an
// institution's scholars), so the write surfaces are admin-only. Reads:
// admins inspect anyone's memberships; a user can read their OWN (the future
// context switcher). The single source of truth for "which scholars a
// context can see" is convex/lib/access.ts.

import { v } from "convex/values";
import { platformAdminMutation, platformAdminQuery, authedQuery } from "./lib/customFunctions";
import { ROLES, type Role } from "./lib/roles";
import type { MutationCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import {
  institutionLensClientPayload,
  resolveInstitutionLens,
} from "./lib/institutionLens";
import {
  invalidatePendingGroupWork,
  reconcileScholarEnrollment,
} from "./lib/scholarEnrollment";
import { scheduleClaimDecommissionLocksForScholar } from "./lib/deviceAppUnlockScheduling";

const ROLE_VALUES = [
  ROLES.SCHOLAR,
  ROLES.TEACHER,
  ROLES.PLATFORM_ADMIN,
  ROLES.SCHOOL_ADMIN,
  ROLES.CURRICULUM_DESIGNER,
  ROLES.STAFF,
  ROLES.PARENT,
] as const;

const roleValidator = v.union(
  v.literal(ROLES.SCHOLAR),
  v.literal(ROLES.TEACHER),
  v.literal(ROLES.PLATFORM_ADMIN),
  v.literal(ROLES.SCHOOL_ADMIN),
  v.literal(ROLES.CURRICULUM_DESIGNER),
  v.literal(ROLES.STAFF),
  v.literal(ROLES.PARENT),
);

/**
 * Find-or-create a (user, role, institution) membership. Idempotent on the
 * triple so re-granting / backfilling is safe. Shared by the admin mutation,
 * the backfill migration, and the dev seed. `institutionId === undefined`
 * matches an existing row that also has no institution.
 */
export async function ensureMembership(
  ctx: MutationCtx,
  args: {
    userId: Id<"users">;
    role: Role;
    institutionId?: Id<"institutions">;
    createdBy?: Id<"users">;
    // Provenance: the institution invite whose redemption created this
    // membership (institution invite-code flow). Additive — only stamped on a
    // freshly inserted row, never onto an existing match.
    inviteId?: Id<"institutionInvites">;
  },
): Promise<Id<"memberships">> {
  if (args.role === ROLES.SCHOLAR) {
    if (!args.institutionId) {
      throw new Error("A scholar membership requires an institution");
    }
    await reconcileScholarEnrollment(ctx, {
      scholarId: args.userId,
      institutionId: args.institutionId,
      createdBy: args.createdBy,
      inviteId: args.inviteId,
    });
    const membership = await ctx.db
      .query("memberships")
      .withIndex("by_user_role", (q) =>
        q.eq("userId", args.userId).eq("role", ROLES.SCHOLAR),
      )
      .unique();
    if (!membership) throw new Error("Scholar enrollment reconciliation failed");
    return membership._id;
  }
  const existing = await ctx.db
    .query("memberships")
    .withIndex("by_user_role", (q) =>
      q.eq("userId", args.userId).eq("role", args.role),
    )
    .collect();
  const match = existing.find((m) => m.institutionId === args.institutionId);
  if (match) return match._id;
  return await ctx.db.insert("memberships", {
    userId: args.userId,
    role: args.role,
    institutionId: args.institutionId,
    createdBy: args.createdBy,
    ...(args.inviteId ? { inviteId: args.inviteId } : {}),
  });
}

/**
 * Keep a user's default membership (and, for scholars, their `institutionId`)
 * in sync with their current `users.role`. Call this from every account
 * creation / role-change path so the membership↔institution invariant the
 * access boundary relies on holds for accounts minted AFTER the one-time
 * backfill — otherwise they'd silently lose access when enforcement flips on.
 *
 * Institution resolution mirrors the backfill: scholar → their school (stamped
 * to the primary if unset, so an enforced teacher can see a freshly-created
 * scholar); teacher/staff/school_admin → the primary;
 * platform_admin/parent/curriculum_designer → none. Additive + idempotent (a
 * separately granted memberships remain independent contexts).
 */
export async function ensureDefaultMembershipForUser(
  ctx: MutationCtx,
  userId: Id<"users">,
): Promise<void> {
  const user = await ctx.db.get(userId);
  if (!user || !user.role) return;
  const role = user.role;

  let institutionId: Id<"institutions"> | undefined;
  if (role === ROLES.SCHOLAR) {
    institutionId = user.institutionId;
    if (!institutionId) {
      const primary = await ctx.db
        .query("institutions")
        .collect()
        .then((rows) => rows.find((i) => i.isPrimary));
      institutionId = primary?._id;
      // During the enrollment widen, the legacy field remains a mirror. The
      // reconciliation helper makes the scholar membership canonical.
    }
    if (!institutionId) return;
    await reconcileScholarEnrollment(ctx, { scholarId: userId, institutionId });
    return;
  } else if (
    role === ROLES.TEACHER ||
    role === ROLES.STAFF ||
    role === ROLES.SCHOOL_ADMIN
  ) {
    const primary = await ctx.db
      .query("institutions")
      .collect()
      .then((rows) => rows.find((i) => i.isPrimary));
    institutionId = primary?._id;
  } else {
    // platform_admin (global), parent (guardianship), curriculum_designer →
    // no institution.
    institutionId = undefined;
  }

  await ensureMembership(ctx, { userId, role, institutionId });
}

/**
 * Retire every context in a user's former denormalized role. A role change is
 * a demotion/promotion of that default role, so leaving another membership in
 * the old role (including one at a non-primary school) would retain the stale
 * authority. Memberships in separately granted *other* roles remain intact.
 */
export async function retireDefaultMembershipForRole(
  ctx: MutationCtx,
  user: Pick<Doc<"users">, "_id" | "role" | "institutionId">,
): Promise<void> {
  if (!user.role) return;

  const memberships = await ctx.db
    .query("memberships")
    .withIndex("by_user_role", (q) =>
      q.eq("userId", user._id).eq("role", user.role!),
    )
    .collect();
  await Promise.all(memberships.map((membership) => ctx.db.delete(membership._id)));
}

// ── Admin: grant / revoke ─────────────────────────────────────────────

/**
 * Grant a membership. Admin-only — adding a (teacher, institution) row gives
 * that user access to the institution's scholars. Validates the role and
 * that institution-scoped roles carry an institution.
 */
export const addMembership = platformAdminMutation({
  args: {
    userId: v.id("users"),
    role: roleValidator,
    institutionId: v.optional(v.id("institutions")),
  },
  handler: async (ctx, args) => {
    const user = await ctx.db.get(args.userId);
    if (!user) throw new Error("User not found");

    // platform_admin/parent are global / guardianship-scoped → no institution.
    // teacher/staff/school_admin/scholar are institution-
    // scoped → require one.
    const institutionScoped =
      args.role === ROLES.TEACHER ||
      args.role === ROLES.STAFF ||
      args.role === ROLES.SCHOOL_ADMIN ||
      args.role === ROLES.SCHOLAR;
    if (institutionScoped && !args.institutionId) {
      throw new Error(`Role "${args.role}" requires an institution`);
    }
    if (args.institutionId) {
      const inst = await ctx.db.get(args.institutionId);
      if (!inst) throw new Error("Institution not found");
    }

    const membershipId = await ensureMembership(ctx, {
      userId: args.userId,
      role: args.role,
      institutionId: args.institutionId,
      createdBy: ctx.user._id,
    });
    return { membershipId };
  },
});

/** Revoke a membership. Admin-only. */
export const removeMembership = platformAdminMutation({
  args: { membershipId: v.id("memberships") },
  handler: async (ctx, args) => {
    const m = await ctx.db.get(args.membershipId);
    if (!m) return; // idempotent
    if (m.role === ROLES.SCHOLAR) {
      const user = await ctx.db.get(m.userId);
      if (user?.role === ROLES.SCHOLAR) {
        throw new Error("Use scholar institution transfer to change a school enrollment");
      }
      // Removing the learner context revokes every app route, not only grants
      // inherited through the groups scrubbed below.
      await scheduleClaimDecommissionLocksForScholar(ctx, m.userId);
      const groups = await ctx.db.query("scholarGroups").collect();
      const changedGroupIds = new Set<Id<"scholarGroups">>();
      for (const group of groups) {
        if (group.scholarIds.includes(m.userId)) {
          await ctx.db.patch(group._id, {
            scholarIds: group.scholarIds.filter((id) => id !== m.userId),
          });
          changedGroupIds.add(group._id);
        }
      }
      await invalidatePendingGroupWork(ctx, changedGroupIds);
    }
    await ctx.db.delete(args.membershipId);
  },
});

// ── Reads ─────────────────────────────────────────────────────────────

function isRole(value: string): value is Role {
  return (ROLE_VALUES as readonly string[]).includes(value);
}

async function hydrate(
  ctx: { db: { get: (id: Id<"institutions">) => Promise<unknown> } },
  m: { _id: Id<"memberships">; role: string; institutionId?: Id<"institutions"> },
) {
  const inst = m.institutionId
    ? ((await ctx.db.get(m.institutionId)) as
        | {
            name: string;
            slug: string;
            kind: "school" | "guest" | "community";
            emoji?: string;
            isPrimary?: boolean;
          }
        | null)
    : null;
  return {
    _id: m._id,
    role: m.role,
    institutionId: m.institutionId ?? null,
    institutionName: inst?.name ?? null,
    institutionSlug: inst?.slug ?? null,
    institutionKind: inst?.kind ?? null,
    institutionIsPrimary: inst?.isPrimary ?? false,
    institutionEmoji: inst?.emoji ?? null,
  };
}

/** Admin: list a user's memberships (with institution names). */
export const listForUser = platformAdminQuery({
  args: { userId: v.id("users") },
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query("memberships")
      .withIndex("by_user", (q) => q.eq("userId", args.userId))
      .collect();
    return await Promise.all(rows.map((m) => hydrate(ctx, m)));
  },
});

/**
 * The caller's own memberships — the contexts the future switcher offers.
 * Any authenticated user may read their own.
 */
export const myMemberships = authedQuery({
  args: {},
  handler: async (ctx) => {
    const rows = await ctx.db
      .query("memberships")
      .withIndex("by_user", (q) => q.eq("userId", ctx.user._id))
      .collect();
    const hydrated = await Promise.all(rows.map((m) => hydrate(ctx, m)));
    // Keep only valid roles (defensive against legacy/odd data).
    return hydrated.filter((m) => isRole(m.role));
  },
});

/**
 * Resolve the caller's active institution from the shareable `?inst=<slug>`
 * value. The returned id/slug is server-validated against the caller's
 * memberships (admins may resolve any institution); invalid/non-member slugs
 * fall back to the user's home membership.
 */
export const resolveActiveInstitution = authedQuery({
  args: { scope: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const lens = await resolveInstitutionLens(ctx, ctx.user, args.scope);
    return institutionLensClientPayload(lens);
  },
});
