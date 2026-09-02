import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { includesProgramGuests } from "../../shared/scholarGroupRouting";
import { resolveInstitutionLens } from "./institutionLens";
import { isPlatformAdminRole } from "./roles";
import {
  authorizedGroupIds,
  hasActiveGroupCapability,
} from "./staffCapabilities";

type ProgramAccessCtx = QueryCtx | MutationCtx;

export const PROGRAM_PUBLISH_CAPABILITY = "program:publish" as const;
export const CAPTURE_REVIEW_CAPABILITY = "captures:review" as const;

export type ProgramGroupCapability =
  | typeof PROGRAM_PUBLISH_CAPABILITY
  | typeof CAPTURE_REVIEW_CAPABILITY;

async function hasSameSchoolAdminOverride(
  ctx: ProgramAccessCtx,
  user: Doc<"users">,
  group: Doc<"scholarGroups">,
) {
  if (!group.institutionId) return false;
  if (isPlatformAdminRole(user.role)) return true;

  const lens = await resolveInstitutionLens(ctx, user);
  if (!lens.allowedInstitutionIds.has(group.institutionId)) return false;
  const memberships = await ctx.db
    .query("memberships")
    .withIndex("by_user", (q) => q.eq("userId", user._id))
    .collect();
  return memberships.some(
    (membership) =>
      membership.role === "school_admin" &&
      membership.institutionId === group.institutionId,
  );
}

async function canAccessProgramGroup(
  ctx: ProgramAccessCtx,
  user: Doc<"users">,
  group: Doc<"scholarGroups">,
  capability: ProgramGroupCapability,
  { allowMalformedProgramGroup = false } = {},
): Promise<boolean> {
  if (
    !group.institutionId ||
    (!allowMalformedProgramGroup && !includesProgramGuests(group))
  ) {
    return false;
  }
  const lens = await resolveInstitutionLens(ctx, user);
  if (!lens.allowedInstitutionIds.has(group.institutionId)) return false;
  if (await hasSameSchoolAdminOverride(ctx, user, group)) return true;

  // `hasActiveGroupCapability` is the staff-capability resolver. It must
  // require an active staff membership in this institution and ignore revoked
  // grants; a group's ownerId is deliberately never an authorization input.
  return await hasActiveGroupCapability(ctx, {
    userId: user._id,
    institutionId: group.institutionId,
    scholarGroupId: group._id,
    capability,
  });
}

async function accessibleProgramGroups(
  ctx: QueryCtx,
  user: Doc<"users">,
  capability: ProgramGroupCapability,
  institutionScope?: string,
) {
  const lens = await resolveInstitutionLens(ctx, user, institutionScope);
  const memberships = await ctx.db
    .query("memberships")
    .withIndex("by_user", (q) => q.eq("userId", user._id))
    .collect();
  const schoolAdminInstitutionIds = new Set(
    memberships
      .filter(
        (membership) =>
          membership.role === "school_admin" &&
          membership.institutionId !== undefined,
      )
      .map((membership) => membership.institutionId!),
  );
  const groupIds = new Set<Id<"scholarGroups">>();
  const visibleInstitutionIds =
    lens.scope === "all"
      ? lens.allowedInstitutionIds
      : new Set(lens.institution ? [lens.institution._id] : []);

  for (const institutionId of visibleInstitutionIds) {
    if (
      isPlatformAdminRole(user.role) ||
      schoolAdminInstitutionIds.has(institutionId)
    ) {
      const groups = await ctx.db
        .query("scholarGroups")
        .withIndex("by_institution", (q) => q.eq("institutionId", institutionId))
        .collect();
      for (const group of groups) {
        if (includesProgramGuests(group)) groupIds.add(group._id);
      }
      continue;
    }
    for (const groupId of await authorizedGroupIds(
      ctx,
      user._id,
      institutionId,
      capability,
    )) {
      groupIds.add(groupId);
    }
  }

  const groups = (
    await Promise.all([...groupIds].map((groupId) => ctx.db.get(groupId)))
  ).filter((group): group is Doc<"scholarGroups"> => {
    if (!group?.institutionId) return false;
    return (
      visibleInstitutionIds.has(group.institutionId) &&
      includesProgramGuests(group)
    );
  });
  return groups.sort((a, b) => a.name.localeCompare(b.name));
}

export async function publishableProgramGroups(
  ctx: QueryCtx,
  user: Doc<"users">,
  institutionScope?: string,
) {
  return await accessibleProgramGroups(
    ctx,
    user,
    PROGRAM_PUBLISH_CAPABILITY,
    institutionScope,
  );
}

export async function reviewableProgramGroups(
  ctx: QueryCtx,
  user: Doc<"users">,
  institutionScope?: string,
) {
  return await accessibleProgramGroups(
    ctx,
    user,
    CAPTURE_REVIEW_CAPABILITY,
    institutionScope,
  );
}

export async function canPublishProgramGroup(
  ctx: ProgramAccessCtx,
  user: Doc<"users">,
  group: Doc<"scholarGroups">,
): Promise<boolean> {
  return await canAccessProgramGroup(
    ctx,
    user,
    group,
    PROGRAM_PUBLISH_CAPABILITY,
  );
}

export async function canReviewProgramCaptures(
  ctx: ProgramAccessCtx,
  user: Doc<"users">,
  group: Doc<"scholarGroups">,
): Promise<boolean> {
  return await canAccessProgramGroup(
    ctx,
    user,
    group,
    CAPTURE_REVIEW_CAPABILITY,
  );
}

export async function requireProgramPublishAccess(
  ctx: ProgramAccessCtx,
  user: Doc<"users">,
  group: Doc<"scholarGroups"> | null,
): Promise<Doc<"scholarGroups">> {
  if (!group || !(await canPublishProgramGroup(ctx, user, group))) {
    throw new Error("Forbidden: this program group is not assigned to you.");
  }
  return group;
}

export async function requireProgramCaptureReviewAccess(
  ctx: ProgramAccessCtx,
  user: Doc<"users">,
  group: Doc<"scholarGroups"> | null,
): Promise<Doc<"scholarGroups">> {
  if (!group || !(await canReviewProgramCaptures(ctx, user, group))) {
    throw new Error("Forbidden: this program group is not assigned to you.");
  }
  return group;
}

/** Cleanup stays possible if a legacy/malformed group loses its program flag. */
export async function requireProgramCaptureCleanupAccess(
  ctx: ProgramAccessCtx,
  user: Doc<"users">,
  group: Doc<"scholarGroups"> | null,
): Promise<Doc<"scholarGroups">> {
  if (
    group &&
    (await canAccessProgramGroup(ctx, user, group, CAPTURE_REVIEW_CAPABILITY, {
      allowMalformedProgramGroup: true,
    }))
  ) {
    return group;
  }
  throw new Error("Forbidden: this program group is not assigned to you.");
}
