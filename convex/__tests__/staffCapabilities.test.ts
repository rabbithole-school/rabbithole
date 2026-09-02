import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import schema from "../schema";
import {
  authorizedGroupIds,
  ensureActiveStaffCapabilityGrant,
  hasActiveGroupCapability,
  hasActiveInstitutionCapability,
  hasHealthAccessAtInstitution,
  healthInstitutionIds,
  hasSchoolOperationsAccessAtInstitution,
  schoolOperationsInstitutionIds,
} from "../lib/staffCapabilities";
import { accessibleScholarIds, canReadScholarAsTeacher } from "../lib/access";
import {
  deleteInstitutionScopedBatch,
  purgeUserInner,
} from "../lib/cascade";

const modules = (
  import.meta as ImportMeta & {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("../**/*.ts");

async function asUser(t: ReturnType<typeof convexTest>, userId: Id<"users">) {
  const sessionId = await t.run(async (ctx) => {
    const session: Omit<Doc<"authSessions">, "_id" | "_creationTime"> = {
      userId,
      expirationTime: Date.now() + 60 * 60 * 1000,
    };
    return ctx.db.insert("authSessions", session);
  });
  return t.withIdentity({
    subject: `${userId}|${sessionId}`,
    issuer: "https://convex.dev",
  });
}

async function seedWorld(t: ReturnType<typeof convexTest>) {
  return t.run(async (ctx) => {
    const school = await ctx.db.insert("institutions", {
      name: "Moli School",
      slug: "moli",
      kind: "school",
      isPrimary: true,
    });
    const otherSchool = await ctx.db.insert("institutions", {
      name: "Elsewhere",
      slug: "elsewhere",
      kind: "school",
    });
    const admin = await ctx.db.insert("users", {
      name: "School admin",
      username: "admin",
      role: "school_admin",
    });
    const specialist = await ctx.db.insert("users", {
      name: "Specialist",
      username: "specialist",
      role: "staff",
    });
    await ctx.db.insert("memberships", {
      userId: admin,
      role: "school_admin",
      institutionId: school,
    });
    await ctx.db.insert("memberships", {
      userId: specialist,
      role: "staff",
      institutionId: school,
    });
    const robotics = await ctx.db.insert("scholarGroups", {
      teacherId: admin,
      institutionId: school,
      name: "Robotics",
      scholarIds: [],
      participation: "includes_program_guests",
    });
    const art = await ctx.db.insert("scholarGroups", {
      teacherId: admin,
      institutionId: school,
      name: "Art",
      scholarIds: [],
      participation: "includes_program_guests",
    });
    const ordinaryGroup = await ctx.db.insert("scholarGroups", {
      teacherId: admin,
      institutionId: school,
      name: "Ordinary class",
      scholarIds: [],
      participation: "enrolled_only",
    });
    const foreignGroup = await ctx.db.insert("scholarGroups", {
      teacherId: admin,
      institutionId: otherSchool,
      name: "Foreign Robotics",
      scholarIds: [],
      participation: "includes_program_guests",
    });
    return {
      school,
      otherSchool,
      admin,
      specialist,
      robotics,
      art,
      ordinaryGroup,
      foreignGroup,
    };
  });
}

describe("staff capability grants", () => {
  test("a school admin atomically grants, soft-revokes, and restores scoped capabilities", async () => {
    const t = convexTest(schema, modules);
    const { school, admin, specialist, robotics, art } = await seedWorld(t);
    const asAdmin = await asUser(t, admin);

    await expect(
      asAdmin.query(api.staffCapabilities.editorForStaff, {
        userId: specialist,
        institutionId: school,
      }),
    ).resolves.toMatchObject({
      canEditCurriculum: false,
      canManageSchoolOperations: false,
      canManageHealthRecords: false,
      programGroups: [
        { groupId: art, canPublish: false, canReviewCaptures: false },
        { groupId: robotics, canPublish: false, canReviewCaptures: false },
      ],
    });

    await asAdmin.mutation(api.staffCapabilities.updateForStaff, {
      userId: specialist,
      institutionId: school,
      canEditCurriculum: true,
      canManageSchoolOperations: true,
      canManageHealthRecords: true,
      programGroupAccess: [
        { groupId: robotics, canPublish: true, canReviewCaptures: true },
        { groupId: art, canPublish: false, canReviewCaptures: true },
      ],
    });
    const asSpecialist = await asUser(t, specialist);
    await expect(asSpecialist.query(api.users.currentUser, {})).resolves.toMatchObject({
      hasCurriculumAccess: true,
      hasSchoolOperationsAccess: true,
      schoolOperationsInstitutionIds: [school],
      hasProgramPublishingAccess: true,
      hasCaptureReviewAccess: true,
    });
    await expect(
      asAdmin.query(api.staffCapabilities.editorForStaff, {
        userId: specialist,
        institutionId: school,
      }),
    ).resolves.toMatchObject({
      canEditCurriculum: true,
      canManageSchoolOperations: true,
      canManageHealthRecords: true,
      programGroups: [
        { groupId: art, canPublish: false, canReviewCaptures: true },
        { groupId: robotics, canPublish: true, canReviewCaptures: true },
      ],
    });

    await asAdmin.mutation(api.staffCapabilities.updateForStaff, {
      userId: specialist,
      institutionId: school,
      canEditCurriculum: false,
      canManageSchoolOperations: false,
      canManageHealthRecords: false,
      programGroupAccess: [],
    });
    const revoked = await t.run(async (ctx) =>
      ctx.db
        .query("staffCapabilityGrants")
        .withIndex("by_grantee_capability", (q) =>
          q.eq("granteeUserId", specialist).eq("capability", "curriculum:edit"),
        )
        .collect(),
    );
    expect(revoked).toHaveLength(1);
    expect(revoked[0].revokedAt).toEqual(expect.any(Number));
    expect(revoked[0].revokedBy).toBe(admin);
    expect(
      await t.run(async (ctx) => {
        const user = await ctx.db.get(specialist);
        return user
          ? hasSchoolOperationsAccessAtInstitution(
              ctx,
              user,
              school,
            )
          : false;
      }),
    ).toBe(false);

    await asAdmin.mutation(api.staffCapabilities.updateForStaff, {
      userId: specialist,
      institutionId: school,
      canEditCurriculum: true,
      canManageSchoolOperations: false,
      canManageHealthRecords: false,
      programGroupAccess: [],
    });

    const curriculumGrants = await t.run(async (ctx) =>
      ctx.db
        .query("staffCapabilityGrants")
        .withIndex("by_grantee_capability", (q) =>
          q.eq("granteeUserId", specialist).eq("capability", "curriculum:edit"),
        )
        .collect(),
    );
    expect(curriculumGrants).toHaveLength(1);
    expect(curriculumGrants.filter((grant) => grant.revokedAt === undefined)).toHaveLength(1);
  });

  test("health:manage is institution-scoped and independent of school operations", async () => {
    const t = convexTest(schema, modules);
    const { school, otherSchool, admin, specialist } = await seedWorld(t);
    await t.run(async (ctx) => {
      await ensureActiveStaffCapabilityGrant(ctx, {
        granteeUserId: specialist,
        institutionId: school,
        capability: "health:manage",
        grantedBy: admin,
      });
    });
    const specialistUser = await t.run((ctx) => ctx.db.get(specialist));
    expect(specialistUser).not.toBeNull();
    await expect(
      t.run((ctx) =>
        hasHealthAccessAtInstitution(ctx, specialistUser!, school),
      ),
    ).resolves.toBe(true);
    await expect(
      t.run((ctx) =>
        hasHealthAccessAtInstitution(ctx, specialistUser!, otherSchool),
      ),
    ).resolves.toBe(false);
    await expect(
      t.run(async (ctx) => {
        const ids = await healthInstitutionIds(ctx, specialistUser!);
        return ids === "all" ? [] : [...ids];
      }),
    ).resolves.toEqual([school]);
    await expect(
      t.run((ctx) =>
        hasSchoolOperationsAccessAtInstitution(ctx, specialistUser!, school),
      ),
    ).resolves.toBe(false);
  });

  test("role changes retire only the former default membership", async () => {
    const t = convexTest(schema, modules);
    const { school, otherSchool } = await seedWorld(t);
    const platformAdmin = await t.run((ctx) =>
      ctx.db.insert("users", {
        name: "Platform admin",
        username: "platform-admin",
        role: "platform_admin",
      }),
    );
    const asPlatformAdmin = await asUser(t, platformAdmin);
    const roles = ["teacher", "school_admin", "staff"] as const;
    const userIds = await t.run(async (ctx) => {
      const ids: Id<"users">[] = [];
      for (const role of roles) {
        const userId = await ctx.db.insert("users", {
          name: `Former ${role}`,
          username: `former-${role}`,
          role,
        });
        await ctx.db.insert("memberships", {
          userId,
          institutionId: school,
          role,
        });
        ids.push(userId);
      }
      return ids;
    });

    for (const userId of userIds) {
      await asPlatformAdmin.mutation(api.users.updateRole, {
        userId,
        role: "parent",
      });
      await expect(
        t.run(async (ctx) =>
          (await ctx.db
            .query("memberships")
            .withIndex("by_user", (q) => q.eq("userId", userId))
            .collect()).filter((membership) => membership.role !== "parent"),
        ),
      ).resolves.toEqual([]);
    }

    const multiHat = await t.run(async (ctx) => {
      const userId = await ctx.db.insert("users", {
        name: "Multi-hat staff",
        username: "multi-hat-staff",
        role: "teacher",
      });
      await ctx.db.insert("memberships", {
        userId,
        institutionId: school,
        role: "teacher",
      });
      await ctx.db.insert("memberships", {
        userId,
        institutionId: otherSchool,
        role: "school_admin",
      });
      const scholarId = await ctx.db.insert("users", {
        name: "Other school scholar",
        username: "multi-hat-scholar",
        role: "scholar",
        institutionId: otherSchool,
      });
      return { userId, scholarId };
    });
    await asPlatformAdmin.mutation(api.users.updateRole, {
      userId: multiHat.userId,
      role: "parent",
    });
    await t.run(async (ctx) => {
      const user = await ctx.db.get(multiHat.userId);
      expect(
        user
          ? await schoolOperationsInstitutionIds(ctx, user)
          : new Set<Id<"institutions">>(),
      ).toEqual(new Set([otherSchool]));
      expect(
        await canReadScholarAsTeacher(ctx, user!, multiHat.scholarId),
      ).toBe(true);
      const memberships = await ctx.db
        .query("memberships")
        .withIndex("by_user", (q) => q.eq("userId", multiHat.userId))
        .collect();
      expect(memberships).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            role: "school_admin",
            institutionId: otherSchool,
          }),
          expect.objectContaining({ role: "parent" }),
        ]),
      );
      expect(
        memberships.some(
          (membership) =>
            membership.role === "teacher" && membership.institutionId === school,
        ),
      ).toBe(false);
    });
  });

  test("a suspended institution grants neither school operations nor scholar access", async () => {
    const t = convexTest(schema, modules);
    const { school } = await seedWorld(t);
    const { teacher, scholar } = await t.run(async (ctx) => {
      const teacher = await ctx.db.insert("users", {
        name: "Suspended teacher",
        username: "suspended-teacher",
        role: "teacher",
      });
      const scholar = await ctx.db.insert("users", {
        name: "Suspended scholar",
        username: "suspended-scholar",
        role: "scholar",
        institutionId: school,
      });
      await ctx.db.insert("memberships", {
        userId: teacher,
        institutionId: school,
        role: "teacher",
      });
      await ctx.db.patch(school, { disabledAt: Date.now() });
      return { teacher, scholar };
    });

    await expect(
      t.run(async (ctx) => {
        const user = await ctx.db.get(teacher);
        return user
          ? [...(await schoolOperationsInstitutionIds(ctx, user))]
          : [];
      }),
    ).resolves.toEqual([]);
    await expect(
      t.run(async (ctx) =>
        [...(await accessibleScholarIds(ctx, {
          userId: teacher,
          institutionId: school,
          role: "teacher",
        }))],
      ),
    ).resolves.not.toContain(scholar);
  });

  test("deleting a program group removes its scoped grants", async () => {
    const t = convexTest(schema, modules);
    const { school, admin, specialist, robotics } = await seedWorld(t);
    await t.run((ctx) =>
      ctx.db.insert("staffCapabilityGrants", {
        granteeUserId: specialist,
        institutionId: school,
        scholarGroupId: robotics,
        capability: "program:publish",
        grantedBy: admin,
        grantedAt: Date.now(),
      }),
    );

    await (await asUser(t, admin)).mutation(api.scholarGroups.remove, {
      groupId: robotics,
    });

    expect(
      await t.run((ctx) =>
        ctx.db
          .query("staffCapabilityGrants")
          .withIndex("by_group_capability", (q) =>
            q.eq("scholarGroupId", robotics),
          )
          .collect(),
      ),
    ).toEqual([]);
  });

  test("reports curriculum access that is already included in a staff role", async () => {
    const t = convexTest(schema, modules);
    const { school, admin } = await seedWorld(t);
    const designer = await t.run(async (ctx) => {
      const userId = await ctx.db.insert("users", {
        name: "Curriculum designer",
        username: "curriculum-designer",
        role: "curriculum_designer",
      });
      await ctx.db.insert("memberships", {
        userId,
        institutionId: school,
        role: "curriculum_designer",
      });
      return userId;
    });

    await expect(
      (await asUser(t, admin)).query(api.staffCapabilities.editorForStaff, {
        userId: designer,
        institutionId: school,
      }),
    ).resolves.toMatchObject({
      canEditCurriculum: false,
      curriculumAccessIncludedInRole: true,
    });
  });

  test("denies self-grants and foreign program groups", async () => {
    const t = convexTest(schema, modules);
    const { school, admin, specialist, robotics, foreignGroup } =
      await seedWorld(t);
    const asAdmin = await asUser(t, admin);

    await expect(
      asAdmin.mutation(api.staffCapabilities.updateForStaff, {
        userId: admin,
        institutionId: school,
        canEditCurriculum: true,
        programGroupAccess: [],
      }),
    ).rejects.toThrow(/cannot grant yourself/i);
    await expect(
      asAdmin.mutation(api.staffCapabilities.updateForStaff, {
        userId: specialist,
        institutionId: school,
        canEditCurriculum: false,
        programGroupAccess: [
          {
            groupId: foreignGroup,
            canPublish: true,
            canReviewCaptures: false,
          },
        ],
      }),
    ).rejects.toThrow(/must belong to this institution/i);
    await expect(
      asAdmin.mutation(api.staffCapabilities.updateForStaff, {
        userId: specialist,
        institutionId: school,
        canEditCurriculum: false,
        programGroupAccess: [
          {
            groupId: robotics,
            canPublish: true,
            canReviewCaptures: false,
          },
        ],
      }),
    ).rejects.toThrow(/requires curriculum access/i);
  });

  test("fails closed for malformed scopes and rejects non-program grant targets", async () => {
    const t = convexTest(schema, modules);
    const { school, admin, specialist, robotics, ordinaryGroup } = await seedWorld(t);
    await t.run(async (ctx) => {
      await ctx.db.insert("staffCapabilityGrants", {
        granteeUserId: specialist,
        institutionId: school,
        capability: "program:publish",
        grantedBy: admin,
        grantedAt: Date.now(),
      });
      await ctx.db.insert("staffCapabilityGrants", {
        granteeUserId: specialist,
        institutionId: school,
        capability: "curriculum:edit",
        scholarGroupId: robotics,
        grantedBy: admin,
        grantedAt: Date.now(),
      });
      await ctx.db.insert("staffCapabilityGrants", {
        granteeUserId: specialist,
        institutionId: school,
        capability: "program:publish",
        scholarGroupId: ordinaryGroup,
        grantedBy: admin,
        grantedAt: Date.now(),
      });
    });

    await expect(
      t.run((ctx) =>
        hasActiveInstitutionCapability(
          ctx,
          specialist,
          school,
          "program:publish",
        ),
      ),
    ).resolves.toBe(false);
    await expect(
      t.run((ctx) =>
        hasActiveGroupCapability(ctx, {
          userId: specialist,
          institutionId: school,
          scholarGroupId: robotics,
          capability: "curriculum:edit",
        }),
      ),
    ).resolves.toBe(false);
    await expect(
      t.run((ctx) =>
        authorizedGroupIds(ctx, specialist, school, "program:publish").then(
          (ids) => [...ids],
        ),
      ),
    ).resolves.toEqual([]);
    await expect(
      t.run((ctx) =>
        ensureActiveStaffCapabilityGrant(ctx, {
          granteeUserId: specialist,
          institutionId: school,
          capability: "program:publish",
          scholarGroupId: ordinaryGroup,
          grantedBy: admin,
        }),
      ),
    ).rejects.toThrow(/program group/i);
  });

  test("cascade removes capability grants when referenced users or groups are deleted", async () => {
    const t = convexTest(schema, modules);
    const { school, admin, specialist, robotics } = await seedWorld(t);
    await t.run(async (ctx) => {
      await ctx.db.insert("staffCapabilityGrants", {
        granteeUserId: specialist,
        institutionId: school,
        capability: "curriculum:edit",
        grantedBy: admin,
        grantedAt: Date.now(),
        revokedBy: admin,
        revokedAt: Date.now(),
      });
      await purgeUserInner(ctx, {}, admin, school);
    });
    await expect(
      t.run((ctx) => ctx.db.query("staffCapabilityGrants").collect()),
    ).resolves.toEqual([]);

    await t.run(async (ctx) => {
      await ctx.db.insert("staffCapabilityGrants", {
        granteeUserId: specialist,
        institutionId: school,
        capability: "program:publish",
        scholarGroupId: robotics,
        grantedBy: specialist,
        grantedAt: Date.now(),
      });
      await purgeUserInner(ctx, {}, specialist, school);
    });
    await expect(
      t.run((ctx) => ctx.db.query("staffCapabilityGrants").collect()),
    ).resolves.toEqual([]);

    const second = convexTest(schema, modules);
    const world = await seedWorld(second);
    await second.run(async (ctx) => {
      await ctx.db.insert("staffCapabilityGrants", {
        granteeUserId: world.specialist,
        institutionId: world.school,
        capability: "program:publish",
        scholarGroupId: world.robotics,
        grantedBy: world.admin,
        grantedAt: Date.now(),
      });
      await deleteInstitutionScopedBatch(ctx, {}, world.school, 100);
    });
    await expect(
      second.run(async (ctx) => [
        await ctx.db.query("staffCapabilityGrants").collect(),
        await ctx.db.get(world.robotics),
      ]),
    ).resolves.toEqual([[], null]);
  });
});
