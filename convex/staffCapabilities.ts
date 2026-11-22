import { v } from "convex/values";
import { internalQuery } from "./_generated/server";
import { schoolAdminMutation, schoolAdminQuery } from "./lib/customFunctions";
import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import {
  isCurriculumRole,
  isPlatformAdminRole,
  isScholarAdminRole,
  isSchoolAdminRole,
  ROLES,
  SCHOOL_STANDING_ROLES,
} from "./lib/roles";
import { curatableInstitutionIds } from "./lib/access";
import { resolveInstitutionLens } from "./lib/institutionLens";
import {
  admissionsCapabilityForTier,
  admissionsTierAtInstitution,
  assertNever,
  authorizedGroupIds,
  ensureActiveStaffCapabilityGrant,
  hasActiveInstitutionCapability,
  hasHealthAccessAtInstitution,
  hasSchoolOperationsAccessAtInstitution,
  hasActiveStaffMembershipAtInstitution,
  hasValidScope,
  schoolOperationsInstitutionIds,
  STAFF_CAPABILITIES,
  type StaffCapability,
} from "./lib/staffCapabilities";

const admissionsTierValidator = v.union(
  v.literal("none"),
  v.literal("scheduling"),
  v.literal("full"),
);

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

/** Base `staff` standing at this school and no other staff role there. */
async function isBaseStaffAtInstitution(
  ctx: QueryCtx | MutationCtx,
  userId: Id<"users">,
  institutionId: Id<"institutions">,
) {
  const memberships = (
    await ctx.db
      .query("memberships")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .collect()
  ).filter((membership) => membership.institutionId === institutionId);
  return (
    memberships.some((membership) => membership.role === ROLES.STAFF) &&
    memberships.every(
      (membership) =>
        membership.role === ROLES.STAFF || membership.role === ROLES.PARENT,
    )
  );
}

/** An active institution-wide `scholars:mentor` grant at this school. */
async function hasInstitutionMentorGrant(
  ctx: QueryCtx | MutationCtx,
  userId: Id<"users">,
  institutionId: Id<"institutions">,
) {
  const grants = await ctx.db
    .query("staffCapabilityGrants")
    .withIndex("by_grantee_capability", (q) =>
      q.eq("granteeUserId", userId).eq("capability", "scholars:mentor"),
    )
    .collect();
  return grants.some(
    (grant) =>
      grant.institutionId === institutionId &&
      grant.scholarGroupId === undefined &&
      grant.revokedAt === undefined,
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
      canRunCurriculum,
      curriculumAccessIncluded,
      canManageSchoolOperations,
      schoolOperationsIncluded,
      canManageHealthRecords,
      healthAccessIncluded,
      publishingGroupIds,
      captureReviewGroupIds,
      groups,
      canMentorScholars,
      admissionsTier,
    ] = await Promise.all([
        hasActiveInstitutionCapability(
          ctx,
          args.userId,
          args.institutionId,
          "curriculum:edit",
        ),
        hasActiveInstitutionCapability(
          ctx,
          args.userId,
          args.institutionId,
          "curriculum:run",
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
        hasInstitutionMentorGrant(ctx, args.userId, args.institutionId),
        admissionsTierAtInstitution(
          ctx,
          (await ctx.db.get(args.userId))!,
          args.institutionId,
        ),
      ]);
    return {
      canEditCurriculum,
      // Run the units she can edit (assign, push/schedule her own assignments,
      // synthetic Preflight). Only meaningful with canEditCurriculum.
      canRunCurriculum,
      curriculumAccessIncludedInRole: curriculumAccessIncluded,
      canManageSchoolOperations,
      schoolOperationsIncludedInRole: schoolOperationsIncluded,
      canManageHealthRecords,
      healthAccessIncludedInRole: healthAccessIncluded,
      // Mentor threads with every ENROLLED scholar at this school (never a
      // role default — teachers already reach mentor threads by role).
      canMentorScholars,
      // "full" for a platform admin by role; otherwise from the explicit
      // grant. Only a platform admin may change it (updateForStaff).
      admissionsTier,
      admissionsIncludedInRole: isPlatformAdminRole(
        (await ctx.db.get(args.userId))!.role,
      ),
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
    // `curriculum:run` — run the units she can edit. Omitted = keep the
    // current grant (an older client can never revoke it by accident); it is
    // always revoked with curriculum:edit, and only base staff may hold it
    // (teachers and school admins already run curriculum by role).
    canRunCurriculum: v.optional(v.boolean()),
    canManageSchoolOperations: v.optional(v.boolean()),
    canManageHealthRecords: v.optional(v.boolean()),
    // Institution-wide `scholars:mentor`. Omitted = leave every existing mentor
    // grant (including a group-scoped one) exactly as it is, so an older client
    // that doesn't know the field can never revoke it by accident.
    canMentorScholars: v.optional(v.boolean()),
    // Admissions tier. Omitted = leave the admissions grants exactly as they
    // are (a school admin saving other toggles must never revoke them).
    // Setting it is reserved to a platform admin; a tier replaces the other
    // admissions grant, so a user holds at most one.
    admissionsTier: v.optional(admissionsTierValidator),
    programGroupAccess: v.array(programGroupAccessValidator),
  },
  handler: async (ctx, args) => {
    await requireEditorAuthority(ctx, ctx.user._id, ctx.user.role, args.institutionId);
    if (args.userId === ctx.user._id) {
      throw new Error("You cannot grant yourself staff capabilities");
    }
    await requireStaffRecipient(ctx, args.userId, args.institutionId);
    if (
      args.admissionsTier !== undefined &&
      !isPlatformAdminRole(ctx.user.role)
    ) {
      throw new Error("Only a platform admin can change admissions access");
    }
    if (
      args.canMentorScholars === true &&
      !(await isBaseStaffAtInstitution(ctx, args.userId, args.institutionId))
    ) {
      // Teachers and school admins already reach mentor threads by role, and
      // other staff roles aren't routed to Messages — the grant is for base
      // staff (an outside mentor) only. Revoking stays allowed for cleanup.
      throw new Error("Only base staff can be made a mentor");
    }
    if (args.canRunCurriculum === true) {
      if (!args.canEditCurriculum) {
        throw new Error("Running curriculum requires curriculum access");
      }
      if (!(await isBaseStaffAtInstitution(ctx, args.userId, args.institutionId))) {
        throw new Error("Only base staff can be given curriculum running");
      }
    }
    const desiredCurriculumRun =
      args.canEditCurriculum &&
      (args.canRunCurriculum ??
        (await hasActiveInstitutionCapability(
          ctx,
          args.userId,
          args.institutionId,
          "curriculum:run",
        )));
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

    const capabilities: readonly StaffCapability[] = STAFF_CAPABILITIES;
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

    // Exhaustive: a new capability fails typecheck here instead of falling
    // through to a branch that silently revokes its grants on every save.
    const desiredGrant = (
      capability: StaffCapability,
      groupId?: Id<"scholarGroups">,
    ): boolean => {
      switch (capability) {
        case "scholars:mentor":
          // The toggle is the INSTITUTION-WIDE grant only; a group-scoped
          // mentor grant is never touched from here.
          return groupId !== undefined || (args.canMentorScholars ?? true);
        case "curriculum:edit":
          return args.canEditCurriculum && groupId === undefined;
        case "curriculum:run":
          return desiredCurriculumRun && groupId === undefined;
        case "school:operations":
          return desiredSchoolOperations && groupId === undefined;
        case "health:manage":
          return desiredHealthRecords && groupId === undefined;
        case "program:publish":
          return !!groupId && !!desired.get(groupId)?.canPublish;
        case "captures:review":
          return !!groupId && !!desired.get(groupId)?.canReviewCaptures;
        case "admissions:full":
        case "admissions:scheduling":
          return args.admissionsTier === undefined
            ? groupId === undefined
            : groupId === undefined &&
                admissionsCapabilityForTier(args.admissionsTier) === capability;
        case "finance:read":
          // Not on this editor: finance.setAccess owns it, and a save here keeps it.
          return true;
        default:
          return assertNever(capability);
      }
    };

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
    if (desiredCurriculumRun) {
      await ensureActiveStaffCapabilityGrant(ctx, {
        granteeUserId: args.userId,
        institutionId: args.institutionId,
        capability: "curriculum:run",
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
    const admissionsCapability =
      args.admissionsTier === undefined
        ? null
        : admissionsCapabilityForTier(args.admissionsTier);
    if (admissionsCapability) {
      await ensureActiveStaffCapabilityGrant(ctx, {
        granteeUserId: args.userId,
        institutionId: args.institutionId,
        capability: admissionsCapability,
        grantedBy: ctx.user._id,
      });
    }
    if (args.canMentorScholars === true) {
      await ensureActiveStaffCapabilityGrant(ctx, {
        granteeUserId: args.userId,
        institutionId: args.institutionId,
        capability: "scholars:mentor",
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

// Bounds the reply; the result says when it was hit.
const STAFF_LOOKUP_MAX_MATCHES = 10;

/**
 * Internal: the reader behind the `find_staff_account` aide tool — does this
 * person have a staff account at my school, under what username and role, is
 * it linked to Slack, and which capability grants (`staffCapabilityGrants`)
 * does it hold? Before this the aide had no way to see a staff account at all
 * and told a school admin to "check /admin" for a colleague who did exist.
 *
 * Audience: a scholar-admin ROLE or school-operations standing admits the
 * caller. Schools searched are narrower than the staff directory's lens: only
 * those where the caller has SCHOLAR-READ standing (`scholarReadInstitutionIds`
 * — teacher / school_admin membership, or staff with institution-wide
 * school:operations), because grants are more than the directory shows and a
 * narrow grant such as health:manage at a second school is not authority to
 * read its staff's access. The scope set comes from `curatableInstitutionIds` /
 * `schoolOperationsInstitutionIds`, whose "all" has no liveness filter, so it
 * is only ever intersected with `resolveInstitutionLens` plus a `disabledAt`
 * check below. Candidates are SCHOOL_STANDING_ROLES memberships there; MCP
 * service accounts are not people.
 *
 * Grants are reported only when they would actually take effect: active, at a
 * searched school where the grantee holds staff standing, and validly scoped
 * (`hasValidScope`) — so "can they do Y" is never overstated. No email,
 * phone, ids, or scholar data is returned.
 */
export const aideFindStaffAccounts = internalQuery({
  args: {
    callerUserId: v.id("users"),
    institutionScope: v.optional(v.string()),
    name: v.string(),
  },
  handler: async (ctx, args) => {
    const caller = await ctx.db.get(args.callerUserId);
    if (!caller) throw new Error("Staff lookup requires a staff account");
    const allowed = isScholarAdminRole(caller.role)
      ? await curatableInstitutionIds(ctx, caller)
      : await schoolOperationsInstitutionIds(ctx, caller);
    if (allowed !== "all" && allowed.size === 0) {
      throw new Error("Staff lookup requires scholar-admin or school-operations access");
    }
    const lens = await resolveInstitutionLens(ctx, caller, args.institutionScope ?? "");
    const lensIds =
      lens.scope === "institution"
        ? lens.institution
          ? [lens.institution._id]
          : []
        : [...lens.allowedInstitutionIds];
    const institutions: Doc<"institutions">[] = [];
    for (const id of lensIds) {
      if (allowed !== "all" && !allowed.has(id)) continue;
      if (!lens.scholarReadInstitutionIds.has(id)) continue;
      const inst = await ctx.db.get(id);
      if (inst && !inst.disabledAt) institutions.push(inst);
    }
    if (institutions.length === 0) {
      throw new Error(
        "Staff lookup is scoped to your school, and no school where you manage scholars is in your current view.",
      );
    }
    const institutionById = new Map(institutions.map((i) => [i._id, i]));

    const needle = args.name.trim().toLowerCase();
    if (!needle) throw new Error("Give a name or username to look up");
    const nameMatches = (u: Doc<"users">) =>
      [u.name, u.username].some((s) => !!s && s.toLowerCase().includes(needle));

    type Match = {
      userId: Id<"users">;
      name: string | null;
      username: string | null;
      linkedToSlack: boolean;
      // Every staff role held at each school (a school_admin who is also a
      // teacher is both), keyed by institution so same-named schools stay apart.
      schools: Map<Id<"institutions">, { school: string; roles: string[] }>;
    };
    const matches = new Map<Id<"users">, Match>();
    for (const institution of institutions) {
      for (const role of SCHOOL_STANDING_ROLES) {
        const memberships = await ctx.db
          .query("memberships")
          .withIndex("by_institution_role", (q) =>
            q.eq("institutionId", institution._id).eq("role", role),
          )
          .collect();
        for (const m of memberships) {
          let match = matches.get(m.userId);
          if (!match) {
            const u = await ctx.db.get(m.userId);
            if (!u || u.isSystem === true || !nameMatches(u)) continue;
            match = {
              userId: u._id,
              name: u.name ?? null,
              username: u.username ?? null,
              linkedToSlack: !!u.slackUserId,
              schools: new Map(),
            };
            matches.set(u._id, match);
          }
          const atSchool = match.schools.get(institution._id) ?? {
            school: institution.name,
            roles: [],
          };
          if (!atSchool.roles.includes(m.role)) atSchool.roles.push(m.role);
          match.schools.set(institution._id, atSchool);
        }
      }
    }

    const all = [...matches.values()].sort((a, b) =>
      (a.name ?? a.username ?? "").localeCompare(b.name ?? b.username ?? ""),
    );
    const staff = [];
    for (const match of all.slice(0, STAFF_LOOKUP_MAX_MATCHES)) {
      const grants = (
        await ctx.db
          .query("staffCapabilityGrants")
          .withIndex("by_grantee_capability", (q) =>
            q.eq("granteeUserId", match.userId),
          )
          .collect()
      ).filter(
        (g) =>
          g.revokedAt === undefined &&
          match.schools.has(g.institutionId) &&
          hasValidScope(g.capability, g.scholarGroupId),
      );
      const capabilityGrants = [];
      for (const grant of grants) {
        const group = grant.scholarGroupId ? await ctx.db.get(grant.scholarGroupId) : null;
        // A group grant covers nothing once its group is gone or belongs to
        // another school (`mentorCoversScholar` / `authorizedGroupIds`).
        if (grant.scholarGroupId && group?.institutionId !== grant.institutionId) continue;
        capabilityGrants.push({
          capability: grant.capability,
          school: institutionById.get(grant.institutionId)!.name,
          // Absent group = the whole school.
          group: group?.name ?? null,
        });
      }
      staff.push({
        name: match.name,
        username: match.username,
        linkedToSlack: match.linkedToSlack,
        schools: [...match.schools.values()],
        capabilityGrants,
      });
    }
    return {
      schoolsSearched: institutions.map((i) => i.name),
      staff,
      more: all.length > STAFF_LOOKUP_MAX_MATCHES,
    };
  },
});
