import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { includesProgramGuests } from "../../shared/scholarGroupRouting";
import { isStaffRole } from "./roles";

export const STAFF_CAPABILITIES = [
  "curriculum:edit",
  "school:operations",
  "health:manage",
  "program:publish",
  "captures:review",
] as const;

export type StaffCapability = (typeof STAFF_CAPABILITIES)[number];

type CapabilityCtx = QueryCtx | MutationCtx;

function isActive(grant: Doc<"staffCapabilityGrants">) {
  return grant.revokedAt === undefined;
}

function hasValidScope(
  capability: StaffCapability,
  scholarGroupId: Id<"scholarGroups"> | undefined,
) {
  return (
    ((capability === "curriculum:edit" ||
      capability === "school:operations" ||
      capability === "health:manage") &&
      scholarGroupId === undefined) ||
    ((capability === "program:publish" || capability === "captures:review") &&
      scholarGroupId !== undefined)
  );
}

async function hasActiveInstitution(
  ctx: CapabilityCtx,
  institutionId: Id<"institutions">,
) {
  const institution = await ctx.db.get(institutionId);
  return !!institution && institution.disabledAt === undefined;
}

/**
 * Narrow grants are never a substitute for staff standing at a school. This
 * intentionally does not treat a user's coarse role as standing: the
 * institution-scoped membership is the tenant boundary. `users.role` is only
 * a denormalized default; a user may intentionally hold several staff roles.
 */
export async function hasActiveStaffMembershipAtInstitution(
  ctx: CapabilityCtx,
  userId: Id<"users">,
  institutionId: Id<"institutions">,
): Promise<boolean> {
  if (!(await hasActiveInstitution(ctx, institutionId))) return false;
  const user = await ctx.db.get(userId);
  if (!user) return false;
  const memberships = await ctx.db
    .query("memberships")
    .withIndex("by_user", (q) => q.eq("userId", userId))
    .collect();
  return memberships.some(
    (membership) =>
      membership.institutionId === institutionId &&
      isStaffRole(membership.role),
  );
}

async function activeGrantsFor(
  ctx: CapabilityCtx,
  userId: Id<"users">,
  capability: StaffCapability,
) {
  return (
    await ctx.db
      .query("staffCapabilityGrants")
      .withIndex("by_grantee_capability", (q) =>
        q.eq("granteeUserId", userId).eq("capability", capability),
      )
      .collect()
  ).filter(isActive);
}

/**
 * Check an institution-wide capability grant. Coarse admin overrides belong in
 * the domain wrapper, never here: callers that use this raw primitive get a
 * narrow grant or a denial.
 */
export async function hasActiveInstitutionCapability(
  ctx: CapabilityCtx,
  userId: Id<"users">,
  institutionId: Id<"institutions">,
  capability: StaffCapability,
): Promise<boolean> {
  if (
    capability !== "curriculum:edit" &&
    capability !== "school:operations" &&
    capability !== "health:manage"
  ) {
    return false;
  }
  if (!(await hasActiveStaffMembershipAtInstitution(ctx, userId, institutionId))) {
    return false;
  }
  return (await activeGrantsFor(ctx, userId, capability)).some(
    (grant) =>
      grant.institutionId === institutionId && grant.scholarGroupId === undefined,
  );
}

/**
 * Check a capability scoped to one live group. The group's institution must
 * match the grantee's active staff membership; legacy/unscoped groups deny.
 */
export async function hasActiveGroupCapability(
  ctx: CapabilityCtx,
  args: {
    userId: Id<"users">;
    institutionId: Id<"institutions">;
    scholarGroupId: Id<"scholarGroups">;
    capability: StaffCapability;
  },
): Promise<boolean> {
  if (
    args.capability !== "program:publish" &&
    args.capability !== "captures:review"
  ) {
    return false;
  }
  const group = await ctx.db.get(args.scholarGroupId);
  if (!group?.institutionId || !includesProgramGuests(group)) return false;
  if (
    "institutionId" in args &&
    group.institutionId !== args.institutionId
  ) {
    return false;
  }
  if (
    !(await hasActiveStaffMembershipAtInstitution(
      ctx,
      args.userId,
      group.institutionId,
    ))
  ) {
    return false;
  }
  return (await activeGrantsFor(ctx, args.userId, args.capability)).some(
    (grant) =>
      grant.institutionId === group.institutionId &&
      grant.scholarGroupId === args.scholarGroupId,
  );
}

/** All live group ids for which a staffer holds this capability at one school. */
export async function authorizedGroupIds(
  ctx: CapabilityCtx,
  userId: Id<"users">,
  institutionId: Id<"institutions">,
  capability: StaffCapability,
): Promise<Set<Id<"scholarGroups">>> {
  if (
    capability !== "program:publish" &&
    capability !== "captures:review"
  ) {
    return new Set();
  }
  if (!(await hasActiveStaffMembershipAtInstitution(ctx, userId, institutionId))) {
    return new Set();
  }
  const ids = new Set<Id<"scholarGroups">>();
  for (const grant of await activeGrantsFor(ctx, userId, capability)) {
    if (grant.institutionId !== institutionId || !grant.scholarGroupId) continue;
    const group = await ctx.db.get(grant.scholarGroupId);
    if (
      group?.institutionId === institutionId &&
      includesProgramGuests(group)
    ) {
      ids.add(group._id);
    }
  }
  return ids;
}

/** All active institutions in which this staffer holds an institution-wide grant. */
export async function authorizedInstitutionIds(
  ctx: CapabilityCtx,
  userId: Id<"users">,
  capability: StaffCapability,
): Promise<Set<Id<"institutions">>> {
  if (
    capability !== "curriculum:edit" &&
    capability !== "school:operations" &&
    capability !== "health:manage"
  ) {
    return new Set();
  }
  const ids = new Set<Id<"institutions">>();
  for (const grant of await activeGrantsFor(ctx, userId, capability)) {
    if (grant.scholarGroupId !== undefined) continue;
    if (
      await hasActiveStaffMembershipAtInstitution(
        ctx,
        userId,
        grant.institutionId,
      )
    ) {
      ids.add(grant.institutionId);
    }
  }
  return ids;
}

export type SchoolOperationsPrincipal = Doc<"users"> & {
  schoolOperationsInstitutionIds: Set<Id<"institutions">> | "all";
};

/**
 * Resolve every institution where this user may perform school operations.
 * Teacher/school_admin memberships qualify by role; base `staff` needs the
 * explicit `school:operations` capability grant at the institution.
 */
export async function schoolOperationsInstitutionIds(
  ctx: CapabilityCtx,
  user: Pick<Doc<"users">, "_id" | "role">,
): Promise<Set<Id<"institutions">> | "all"> {
  if (user.role === "platform_admin") return "all";

  const memberships = await ctx.db
    .query("memberships")
    .withIndex("by_user", (q) => q.eq("userId", user._id))
    .collect();
  const ids = new Set<Id<"institutions">>();
  for (const membership of memberships) {
    if (!membership.institutionId) continue;
    if (
      !(await hasActiveStaffMembershipAtInstitution(
        ctx,
        user._id,
        membership.institutionId,
      ))
    ) {
      continue;
    }
    if (
      membership.role === "teacher" ||
      membership.role === "school_admin"
    ) {
      ids.add(membership.institutionId);
      continue;
    }
    if (
      membership.role === "staff" &&
      (await hasActiveInstitutionCapability(
        ctx,
        user._id,
        membership.institutionId,
        "school:operations",
      ))
    ) {
      ids.add(membership.institutionId);
    }
  }
  return ids;
}

export async function hasSchoolOperationsAccessAtInstitution(
  ctx: CapabilityCtx,
  user: Pick<Doc<"users">, "_id" | "role">,
  institutionId: Id<"institutions">,
): Promise<boolean> {
  const institution = await ctx.db.get(institutionId);
  if (!institution || institution.disabledAt) return false;
  const ids = await schoolOperationsInstitutionIds(ctx, user);
  return ids === "all" || ids.has(institutionId);
}

export async function hasAnySchoolOperationsAccess(
  ctx: CapabilityCtx,
  user: Pick<Doc<"users">, "_id" | "role">,
): Promise<boolean> {
  const ids = await schoolOperationsInstitutionIds(ctx, user);
  return ids === "all" || ids.size > 0;
}

/**
 * Resolve the institutions where the caller may read and manage health data.
 * Health records are intentionally independent from generic school operations:
 * a role included here is a clinical/emergency-data authority, while base staff
 * must hold the explicit health:manage capability at the target institution.
 */
export async function healthInstitutionIds(
  ctx: CapabilityCtx,
  user: Pick<Doc<"users">, "_id" | "role">,
): Promise<Set<Id<"institutions">> | "all"> {
  if (user.role === "platform_admin") return "all";

  const memberships = await ctx.db
    .query("memberships")
    .withIndex("by_user", (q) => q.eq("userId", user._id))
    .collect();
  const ids = new Set<Id<"institutions">>();
  for (const membership of memberships) {
    if (!membership.institutionId) continue;
    if (
      !(await hasActiveStaffMembershipAtInstitution(
        ctx,
        user._id,
        membership.institutionId,
      ))
    ) {
      continue;
    }
    if (
      membership.role === "teacher" ||
      membership.role === "school_admin"
    ) {
      ids.add(membership.institutionId);
      continue;
    }
    if (
      membership.role === "staff" &&
      (await hasActiveInstitutionCapability(
        ctx,
        user._id,
        membership.institutionId,
        "health:manage",
      ))
    ) {
      ids.add(membership.institutionId);
    }
  }
  return ids;
}

export async function hasHealthAccessAtInstitution(
  ctx: CapabilityCtx,
  user: Pick<Doc<"users">, "_id" | "role">,
  institutionId: Id<"institutions">,
): Promise<boolean> {
  const institution = await ctx.db.get(institutionId);
  if (!institution || institution.disabledAt) return false;
  const ids = await healthInstitutionIds(ctx, user);
  return ids === "all" || ids.has(institutionId);
}

/** All schools where this staff member has at least one active explicit grant. */
export async function staffCapabilityInstitutionIds(
  ctx: CapabilityCtx,
  userId: Id<"users">,
): Promise<Set<Id<"institutions">>> {
  const ids = new Set<Id<"institutions">>();
  for (const capability of STAFF_CAPABILITIES) {
    for (const grant of await activeGrantsFor(ctx, userId, capability)) {
      if (
        await hasActiveStaffMembershipAtInstitution(
          ctx,
          userId,
          grant.institutionId,
        )
      ) {
        ids.add(grant.institutionId);
      }
    }
  }
  return ids;
}

/**
 * Seed and admin-write primitive. A revoked row is restored in place, so each
 * capability/scope has one canonical row and repeated enables remain idempotent.
 */
export async function ensureActiveStaffCapabilityGrant(
  ctx: MutationCtx,
  args: {
    granteeUserId: Id<"users">;
    institutionId: Id<"institutions">;
    capability: StaffCapability;
    scholarGroupId?: Id<"scholarGroups">;
    grantedBy: Id<"users">;
  },
): Promise<void> {
  if (!hasValidScope(args.capability, args.scholarGroupId)) {
    throw new Error("Invalid capability scope");
  }
  if (
    !(await hasActiveStaffMembershipAtInstitution(
      ctx,
      args.granteeUserId,
      args.institutionId,
    ))
  ) {
    throw new Error("Capability recipient must be active staff at this institution");
  }
  if (args.scholarGroupId) {
    const group = await ctx.db.get(args.scholarGroupId);
    if (
      group?.institutionId !== args.institutionId ||
      !includesProgramGuests(group)
    ) {
      throw new Error(
        "Capability group must be a program group in this institution",
      );
    }
  }
  const matching = (
    await ctx.db
      .query("staffCapabilityGrants")
      .withIndex("by_grantee_capability", (q) =>
        q
          .eq("granteeUserId", args.granteeUserId)
          .eq("capability", args.capability),
      )
      .collect()
  ).filter(
    (grant) =>
      grant.institutionId === args.institutionId &&
      grant.scholarGroupId === args.scholarGroupId,
  );
  if (matching.some(isActive)) return;
  const revoked = matching.find((grant) => !isActive(grant));
  if (revoked) {
    await ctx.db.patch(revoked._id, {
      grantedBy: args.grantedBy,
      grantedAt: Date.now(),
      revokedBy: undefined,
      revokedAt: undefined,
    });
    return;
  }
  await ctx.db.insert("staffCapabilityGrants", {
    ...args,
    grantedAt: Date.now(),
  });
}
