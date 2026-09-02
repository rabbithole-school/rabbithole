import { v } from "convex/values";
import { schoolAdminMutation, schoolAdminQuery } from "./lib/customFunctions";
import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import {
  isCurriculumRole,
  isPlatformAdminRole,
  isSchoolAdminRole,
  ROLES,
} from "./lib/roles";
import {
  authorizedGroupIds,
  ensureActiveStaffCapabilityGrant,
  hasActiveInstitutionCapability,
  hasHealthAccessAtInstitution,
  hasSchoolOperationsAccessAtInstitution,
  hasActiveStaffMembershipAtInstitution,
  type StaffCapability,
} from "./lib/staffCapabilities";

const programGroupAccessValidator = v.object({
  groupId: v.id("scholarGroups"),
  canPublish: v.boolean(),
  canReviewCaptures: v.boolean(),
});

async function requireEditorAuthority(
  ctx: QueryCtx | MutationCtx,
  actorId: Id<"users">,
  actorRole: Doc<"users">["role"],
  institutionId: Id<"institutions">,
) {
  const institution = await ctx.db.get(institutionId);
  if (!institution || institution.disabledAt !== undefined) {
    throw new Error("Institution is not active");
  }
  if (isPlatformAdminRole(actorRole)) return;
  const memberships = await ctx.db
    .query("memberships")
    .withIndex("by_user", (q) => q.eq("userId", actorId))
    .collect();
  if (
    !memberships.some(
      (membership) =>
        membership.institutionId === institutionId &&
        isSchoolAdminRole(membership.role),
    )
  ) {
    throw new Error("Forbidden: school admin access is limited to your institution");
  }
}

async function requireStaffRecipient(
  ctx: QueryCtx | MutationCtx,
  userId: Id<"users">,
  institutionId: Id<"institutions">,
) {
  if (!(await hasActiveStaffMembershipAtInstitution(ctx, userId, institutionId))) {
    throw new Error("Capability recipient must be active staff at this institution");
  }
}

async function curriculumAccessIncludedInRole(
  ctx: QueryCtx | MutationCtx,
  userId: Id<"users">,
  institutionId: Id<"institutions">,
) {
  const user = await ctx.db.get(userId);
  if (isCurriculumRole(user?.role)) return true;
  const memberships = await ctx.db
    .query("memberships")
    .withIndex("by_user", (q) => q.eq("userId", userId))
    .collect();
  return memberships.some(
    (membership) =>
      membership.institutionId === institutionId &&
      isCurriculumRole(membership.role),
  );
}

async function schoolOperationsIncludedInRole(
  ctx: QueryCtx | MutationCtx,
  userId: Id<"users">,
  institutionId: Id<"institutions">,
) {
  const user = await ctx.db.get(userId);
  if (isPlatformAdminRole(user?.role)) return true;
  const memberships = await ctx.db
    .query("memberships")
    .withIndex("by_user", (q) => q.eq("userId", userId))
    .collect();
  return memberships.some(
    (membership) =>
      membership.institutionId === institutionId &&
      (membership.role === ROLES.TEACHER ||
        membership.role === ROLES.SCHOOL_ADMIN),
  );
}

async function healthAccessIncludedInRole(
  ctx: QueryCtx | MutationCtx,
  userId: Id<"users">,
  institutionId: Id<"institutions">,
) {
  const user = await ctx.db.get(userId);
  if (isPlatformAdminRole(user?.role)) return true;
  const memberships = await ctx.db
    .query("memberships")
    .withIndex("by_user", (q) => q.eq("userId", userId))
    .collect();
  return memberships.some(
    (membership) =>
      membership.institutionId === institutionId &&
      (membership.role === ROLES.TEACHER ||
        membership.role === ROLES.SCHOOL_ADMIN),
  );
}

async function programGroupsForInstitution(
  ctx: QueryCtx | MutationCtx,
  institutionId: Id<"institutions">,
) {
  return (
    await ctx.db
      .query("scholarGroups")
      .withIndex("by_institution", (q) => q.eq("institutionId", institutionId))
      .collect()
  )
    .filter((group) => group.participation === "includes_program_guests")
    .sort((a, b) => a.name.localeCompare(b.name));
}

export const editorForStaff = schoolAdminQuery({
  args: {
    userId: v.id("users"),
    institutionId: v.id("institutions"),
  },
  handler: async (ctx, args) => {
    await requireEditorAuthority(ctx, ctx.user._id, ctx.user.role, args.institutionId);
    await requireStaffRecipient(ctx, args.userId, args.institutionId);
    const [
      canEditCurriculum,
      curriculumAccessIncluded,
      canManageSchoolOperations,
      schoolOperationsIncluded,
      canManageHealthRecords,
      healthAccessIncluded,
      publishingGroupIds,
      captureReviewGroupIds,
      groups,
    ] = await Promise.all([
        hasActiveInstitutionCapability(
          ctx,
          args.userId,
          args.institutionId,
          "curriculum:edit",
        ),
        curriculumAccessIncludedInRole(ctx, args.userId, args.institutionId),
        hasSchoolOperationsAccessAtInstitution(
          ctx,
          (await ctx.db.get(args.userId))!,
          args.institutionId,
        ),
        schoolOperationsIncludedInRole(
          ctx,
          args.userId,
          args.institutionId,
        ),
        hasHealthAccessAtInstitution(
          ctx,
          (await ctx.db.get(args.userId))!,
          args.institutionId,
        ),
        healthAccessIncludedInRole(ctx, args.userId, args.institutionId),
        authorizedGroupIds(
          ctx,
          args.userId,
          args.institutionId,
          "program:publish",
        ),
        authorizedGroupIds(
          ctx,
          args.userId,
          args.institutionId,
          "captures:review",
        ),
        programGroupsForInstitution(ctx, args.institutionId),
      ]);
    return {
      canEditCurriculum,
      curriculumAccessIncludedInRole: curriculumAccessIncluded,
      canManageSchoolOperations,
      schoolOperationsIncludedInRole: schoolOperationsIncluded,
      canManageHealthRecords,
      healthAccessIncludedInRole: healthAccessIncluded,
      programGroups: groups.map((group) => ({
        groupId: group._id,
        name: group.name,
        canPublish: publishingGroupIds.has(group._id),
        canReviewCaptures: captureReviewGroupIds.has(group._id),
      })),
    };
  },
});

export const updateForStaff = schoolAdminMutation({
  args: {
    userId: v.id("users"),
    institutionId: v.id("institutions"),
    canEditCurriculum: v.boolean(),
    canManageSchoolOperations: v.optional(v.boolean()),
    canManageHealthRecords: v.optional(v.boolean()),
    programGroupAccess: v.array(programGroupAccessValidator),
  },
  handler: async (ctx, args) => {
    await requireEditorAuthority(ctx, ctx.user._id, ctx.user.role, args.institutionId);
    if (args.userId === ctx.user._id) {
      throw new Error("You cannot grant yourself staff capabilities");
    }
    await requireStaffRecipient(ctx, args.userId, args.institutionId);
    const desiredSchoolOperations =
      args.canManageSchoolOperations ??
      (await hasSchoolOperationsAccessAtInstitution(
        ctx,
        (await ctx.db.get(args.userId))!,
        args.institutionId,
      ));
    const desiredHealthRecords =
      args.canManageHealthRecords ??
      (await hasHealthAccessAtInstitution(
        ctx,
        (await ctx.db.get(args.userId))!,
        args.institutionId,
      ));

    const groups = await programGroupsForInstitution(ctx, args.institutionId);
    const allowedGroupIds = new Set(groups.map((group) => group._id));
    const desired = new Map<
      Id<"scholarGroups">,
      { canPublish: boolean; canReviewCaptures: boolean }
    >();
    for (const access of args.programGroupAccess) {
      if (!allowedGroupIds.has(access.groupId)) {
        throw new Error("Program group must belong to this institution");
      }
      if (desired.has(access.groupId)) {
        throw new Error("Program group access entries must be unique");
      }
      desired.set(access.groupId, {
        canPublish: access.canPublish,
        canReviewCaptures: access.canReviewCaptures,
      });
    }
    const publishesAnyProgram = [...desired.values()].some(
      (access) => access.canPublish,
    );
    if (
      publishesAnyProgram &&
      !args.canEditCurriculum &&
      !(await curriculumAccessIncludedInRole(
        ctx,
        args.userId,
        args.institutionId,
      ))
    ) {
      throw new Error(
        "Assigning program activities requires curriculum access at this institution",
      );
    }

    const capabilities: StaffCapability[] = [
      "curriculum:edit",
      "school:operations",
      "health:manage",
      "program:publish",
      "captures:review",
    ];
    const activeGrants = (
      await Promise.all(
        capabilities.map((capability) =>
          ctx.db
            .query("staffCapabilityGrants")
            .withIndex("by_grantee_capability", (q) =>
              q
                .eq("granteeUserId", args.userId)
                .eq("capability", capability),
            )
            .collect(),
        ),
      )
    )
      .flat()
      .filter(
        (grant) =>
          grant.institutionId === args.institutionId &&
          grant.revokedAt === undefined,
      );

    const desiredGrant = (capability: StaffCapability, groupId?: Id<"scholarGroups">) =>
      capability === "curriculum:edit" ||
      capability === "school:operations" ||
      capability === "health:manage"
        ? (capability === "curriculum:edit"
            ? args.canEditCurriculum
            : capability === "school:operations"
              ? desiredSchoolOperations
              : desiredHealthRecords) && groupId === undefined
        : !!groupId &&
          (capability === "program:publish"
            ? desired.get(groupId)?.canPublish
            : desired.get(groupId)?.canReviewCaptures);

    const retained = new Set<string>();
    for (const grant of activeGrants) {
      const key = `${grant.capability}:${grant.scholarGroupId ?? "institution"}`;
      if (!desiredGrant(grant.capability, grant.scholarGroupId) || retained.has(key)) {
        await ctx.db.patch(grant._id, {
          revokedBy: ctx.user._id,
          revokedAt: Date.now(),
        });
      } else {
        retained.add(key);
      }
    }

    if (args.canEditCurriculum) {
      await ensureActiveStaffCapabilityGrant(ctx, {
        granteeUserId: args.userId,
        institutionId: args.institutionId,
        capability: "curriculum:edit",
        grantedBy: ctx.user._id,
      });
    }
    if (
      desiredSchoolOperations &&
      !(await schoolOperationsIncludedInRole(
        ctx,
        args.userId,
        args.institutionId,
      ))
    ) {
      await ensureActiveStaffCapabilityGrant(ctx, {
        granteeUserId: args.userId,
        institutionId: args.institutionId,
        capability: "school:operations",
        grantedBy: ctx.user._id,
      });
    }
    if (
      desiredHealthRecords &&
      !(await healthAccessIncludedInRole(
        ctx,
        args.userId,
        args.institutionId,
      ))
    ) {
      await ensureActiveStaffCapabilityGrant(ctx, {
        granteeUserId: args.userId,
        institutionId: args.institutionId,
        capability: "health:manage",
        grantedBy: ctx.user._id,
      });
    }
    for (const [groupId, access] of desired) {
      if (access.canPublish) {
        await ensureActiveStaffCapabilityGrant(ctx, {
          granteeUserId: args.userId,
          institutionId: args.institutionId,
          capability: "program:publish",
          scholarGroupId: groupId,
          grantedBy: ctx.user._id,
        });
      }
      if (access.canReviewCaptures) {
        await ensureActiveStaffCapabilityGrant(ctx, {
          granteeUserId: args.userId,
          institutionId: args.institutionId,
          capability: "captures:review",
          scholarGroupId: groupId,
          grantedBy: ctx.user._id,
        });
      }
    }

    return null;
  },
});
