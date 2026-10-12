import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "../schema";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { seedTestInstitution } from "./institutionTestHelpers";

const modules = (
  import.meta as ImportMeta & {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("../**/*.ts");

// Fixture builders ---------------------------------------------------------

async function seedActor(t: ReturnType<typeof convexTest>): Promise<Id<"users">> {
  return await t.run((ctx) =>
    ctx.db.insert("users", { name: "Admin", role: "platform_admin" }),
  );
}

async function seedBaseFixtures(t: ReturnType<typeof convexTest>) {
  const primary = await seedTestInstitution(t, {
    isPrimary: true,
    slug: "primary-school",
  });
  const albatross = await seedTestInstitution(t, { slug: "albatross-society" });
  const actor = await seedActor(t);
  return { primary, albatross, actor };
}

/** A source unit at `institutionId` with one lesson and one online activity. */
async function seedSourceUnit(
  t: ReturnType<typeof convexTest>,
  teacherId: Id<"users">,
  institutionId: Id<"institutions">,
  title = "Fractions 101",
) {
  return await t.run(async (ctx) => {
    const unitId = await ctx.db.insert("units", {
      title,
      teacherId,
      institutionId,
      isActive: true,
    });
    const lessonId = await ctx.db.insert("lessons", {
      unitId,
      title: "Lesson One",
      order: 0,
    });
    const activityId = await ctx.db.insert("activities", {
      lessonId,
      title: "Activity One",
      kind: "online" as const,
      order: 0,
    });
    return { unitId, lessonId, activityId };
  });
}

describe("orgDemo — setupPartnerOrg", () => {
  test("dryRun (default) writes nothing", async () => {
    const t = convexTest(schema, modules);
    const { primary, albatross, actor } = await seedBaseFixtures(t);
    void primary;
    void albatross;

    const usersBefore = await t.run((ctx) => ctx.db.query("users").collect());
    const institutionsBefore = await t.run((ctx) =>
      ctx.db.query("institutions").collect(),
    );

    const result = await t.mutation(internal.orgDemo.setupPartnerOrg, {
      org: { name: "Punahou School" },
      staff: [{ email: "teacher@punahou.example", name: "Teacher T", role: "teacher" }],
      testScholars: [
        { name: "Scholar S", username: "scholar-s", gradeLevel: "5" },
      ],
      copyUnitIds: [],
      actorUserId: actor,
    });

    expect(result.dryRun).toBe(true);
    expect(result.plan.length).toBeGreaterThan(0);

    const usersAfter = await t.run((ctx) => ctx.db.query("users").collect());
    const institutionsAfter = await t.run((ctx) =>
      ctx.db.query("institutions").collect(),
    );
    expect(usersAfter.length).toBe(usersBefore.length);
    expect(institutionsAfter.length).toBe(institutionsBefore.length);
  });

  test("creates the institution with kind school, isPrimary false, timeZone, and a derived slug", async () => {
    const t = convexTest(schema, modules);
    const { actor } = await seedBaseFixtures(t);

    const result = await t.mutation(internal.orgDemo.setupPartnerOrg, {
      org: { name: "Punahou School", timeZone: "Pacific/Honolulu" },
      staff: [],
      actorUserId: actor,
      dryRun: false,
    });

    expect(result.institution.slug).toBe("punahou-school");
    const inst = await t.run((ctx) => ctx.db.get(result.institution.id!));
    expect(inst?.kind).toBe("school");
    expect(inst?.isPrimary).toBeFalsy();
    expect(inst?.timeZone).toBe("Pacific/Honolulu");
    expect(inst?.slug).toBe("punahou-school");
  });

  test("staff: teacher gets exactly org+albatross memberships, no primary membership; grants land", async () => {
    const t = convexTest(schema, modules);
    const { actor } = await seedBaseFixtures(t);

    const result = await t.mutation(internal.orgDemo.setupPartnerOrg, {
      org: { name: "Punahou School" },
      staff: [
        { email: "Teacher@Punahou.example", name: "Teacher T", role: "teacher" },
        {
          email: "ops@punahou.example",
          name: "Ops O",
          role: "staff",
          canManageSchoolOperations: true,
          canEditCurriculum: true,
        },
      ],
      actorUserId: actor,
      dryRun: false,
    });

    const orgId = result.institution.id!;
    const teacherReport = result.staff.find((s) => s.email === "teacher@punahou.example");
    expect(teacherReport?.userId).toBeTruthy();
    const teacherId = teacherReport!.userId!;

    const teacherUser = await t.run((ctx) => ctx.db.get(teacherId));
    expect(teacherUser?.email).toBe("teacher@punahou.example");
    expect(teacherUser?.emailVerificationTime).toBeTruthy();
    expect(teacherUser?.readingLevel).toBe("college");

    const teacherMemberships = await t.run((ctx) =>
      ctx.db
        .query("memberships")
        .withIndex("by_user", (q) => q.eq("userId", teacherId))
        .collect(),
    );
    expect(teacherMemberships.length).toBe(2);
    const institutionIds = teacherMemberships.map((m) => m.institutionId).sort();
    const expected = [orgId, result.learnerInstitution.id].sort();
    expect(institutionIds).toEqual(expected);
    const roles = teacherMemberships.map((m) => m.role).sort();
    expect(roles).toEqual(["scholar", "teacher"]);
    const allInstitutions = await t.run((ctx) => ctx.db.query("institutions").collect());
    const primaryInstitutionId = allInstitutions.find((i) => i.isPrimary)?._id;
    const primaryMembership = teacherMemberships.find(
      (m) => m.institutionId === primaryInstitutionId,
    );
    expect(primaryMembership).toBeUndefined();

    const opsReport = result.staff.find((s) => s.email === "ops@punahou.example");
    const opsId = opsReport!.userId!;
    const grants = await t.run((ctx) =>
      ctx.db
        .query("staffCapabilityGrants")
        .withIndex("by_grantee_capability", (q) => q.eq("granteeUserId", opsId))
        .collect(),
    );
    expect(grants.length).toBe(2);
    const byCapability = Object.fromEntries(grants.map((g) => [g.capability, g]));
    expect(byCapability["school:operations"]).toBeTruthy();
    expect(byCapability["school:operations"].institutionId).toBe(orgId);
    expect(byCapability["school:operations"].revokedAt).toBeUndefined();
    expect(byCapability["curriculum:edit"]).toBeTruthy();
    expect(byCapability["curriculum:edit"].institutionId).toBe(orgId);
    expect(byCapability["curriculum:edit"].revokedAt).toBeUndefined();
  });

  test("idempotent: calling twice creates no duplicate users, memberships, or units", async () => {
    const t = convexTest(schema, modules);
    const { primary, actor } = await seedBaseFixtures(t);
    const { unitId } = await seedSourceUnit(t, actor, primary);

    const args = {
      org: { name: "Punahou School" },
      staff: [{ email: "teacher@punahou.example", name: "Teacher T", role: "teacher" as const }],
      testScholars: [{ name: "Scholar S", username: "scholar-s", gradeLevel: "5" }],
      copyUnitIds: [unitId],
      actorUserId: actor,
      dryRun: false,
    };

    await t.mutation(internal.orgDemo.setupPartnerOrg, args);

    const usersAfterFirst = await t.run((ctx) => ctx.db.query("users").collect());
    const membershipsAfterFirst = await t.run((ctx) => ctx.db.query("memberships").collect());
    const unitsAfterFirst = await t.run((ctx) => ctx.db.query("units").collect());

    await t.mutation(internal.orgDemo.setupPartnerOrg, args);

    const usersAfterSecond = await t.run((ctx) => ctx.db.query("users").collect());
    const membershipsAfterSecond = await t.run((ctx) => ctx.db.query("memberships").collect());
    const unitsAfterSecond = await t.run((ctx) => ctx.db.query("units").collect());

    expect(usersAfterSecond.length).toBe(usersAfterFirst.length);
    expect(membershipsAfterSecond.length).toBe(membershipsAfterFirst.length);
    expect(unitsAfterSecond.length).toBe(unitsAfterFirst.length);
  });

  test("existing dual-role protection: leaves the elsewhere scholar membership alone and warns", async () => {
    const t = convexTest(schema, modules);
    const { actor } = await seedBaseFixtures(t);
    const thirdInstitution = await seedTestInstitution(t, { slug: "third-school" });

    const email = "teacher@punahou.example";
    const existingUserId = await t.run((ctx) =>
      ctx.db.insert("users", { name: "Existing Teacher", email, role: "teacher" }),
    );
    const existingMembershipId = await t.run((ctx) =>
      ctx.db.insert("memberships", {
        userId: existingUserId,
        role: "scholar",
        institutionId: thirdInstitution,
      }),
    );

    const result = await t.mutation(internal.orgDemo.setupPartnerOrg, {
      org: { name: "Punahou School" },
      staff: [{ email, name: "Teacher T", role: "teacher" }],
      actorUserId: actor,
      dryRun: false,
    });

    // Original membership at the third institution is untouched.
    const stillThere = await t.run((ctx) => ctx.db.get(existingMembershipId));
    expect(stillThere).toBeTruthy();
    expect(stillThere?.institutionId).toBe(thirdInstitution);

    // No scholar membership was created at albatross.
    const memberships = await t.run((ctx) =>
      ctx.db
        .query("memberships")
        .withIndex("by_user", (q) => q.eq("userId", existingUserId))
        .collect(),
    );
    const scholarAtAlbatross = memberships.find(
      (m) => m.role === "scholar" && m.institutionId === result.learnerInstitution.id,
    );
    expect(scholarAtAlbatross).toBeUndefined();

    expect(result.warnings.some((w) => w.includes(email))).toBe(true);
  });

  test("test scholars: created with expected fields + membership; invalid username throws", async () => {
    const t = convexTest(schema, modules);
    const { actor } = await seedBaseFixtures(t);

    const result = await t.mutation(internal.orgDemo.setupPartnerOrg, {
      org: { name: "Punahou School" },
      staff: [],
      testScholars: [
        { name: "Scholar S", username: "scholar-s", gradeLevel: "5", readingLevel: "5.2" },
      ],
      actorUserId: actor,
      dryRun: false,
    });

    const orgId = result.institution.id!;
    const scholarReport = result.testScholars.find((s) => s.username === "scholar-s");
    expect(scholarReport?.userId).toBeTruthy();
    const scholarId = scholarReport!.userId!;

    const scholarUser = await t.run((ctx) => ctx.db.get(scholarId));
    expect(scholarUser?.role).toBe("scholar");
    expect(scholarUser?.institutionId).toBe(orgId);
    expect(scholarUser?.gradeLevel).toBe("5");
    expect(scholarUser?.readingLevel).toBe("5.2");

    const memberships = await t.run((ctx) =>
      ctx.db
        .query("memberships")
        .withIndex("by_user", (q) => q.eq("userId", scholarId))
        .collect(),
    );
    expect(memberships.some((m) => m.role === "scholar" && m.institutionId === orgId)).toBe(true);

    await expect(
      t.mutation(internal.orgDemo.setupPartnerOrg, {
        org: { name: "Punahou School" },
        staff: [],
        testScholars: [
          { name: "Bad", username: "bad@name", gradeLevel: "5" },
        ],
        actorUserId: actor,
        dryRun: false,
      }),
    ).rejects.toThrow();
  });

  test("curriculum copy: same title, lessons + activities copied, not copied twice", async () => {
    const t = convexTest(schema, modules);
    const { primary, actor } = await seedBaseFixtures(t);
    const { unitId: sourceUnitId } = await seedSourceUnit(t, actor, primary, "Fractions 101");

    const args = {
      org: { name: "Punahou School" },
      staff: [],
      copyUnitIds: [sourceUnitId],
      actorUserId: actor,
      dryRun: false,
    };

    const result = await t.mutation(internal.orgDemo.setupPartnerOrg, args);
    const copyId = result.units.find((u) => u.sourceId === sourceUnitId)?.copyId;
    expect(copyId).toBeTruthy();

    const copy = await t.run((ctx) => ctx.db.get(copyId!));
    expect(copy?.title).toBe("Fractions 101");
    expect(copy?.institutionId).toBe(result.institution.id);
    expect(copy?.teacherId).toBe(actor);

    const copiedLessons = await t.run((ctx) =>
      ctx.db.query("lessons").withIndex("by_unit", (q) => q.eq("unitId", copyId!)).collect(),
    );
    expect(copiedLessons.length).toBe(1);
    const copiedActivities = await t.run((ctx) =>
      ctx.db
        .query("activities")
        .withIndex("by_lesson", (q) => q.eq("lessonId", copiedLessons[0]._id))
        .collect(),
    );
    expect(copiedActivities.length).toBe(1);

    // Second run does not copy again.
    const result2 = await t.mutation(internal.orgDemo.setupPartnerOrg, args);
    const copyId2 = result2.units.find((u) => u.sourceId === sourceUnitId)?.copyId;
    expect(copyId2).toBe(copyId);
    const allUnitsAtOrg = await t.run((ctx) =>
      ctx.db
        .query("units")
        .withIndex("by_institution", (q) => q.eq("institutionId", result.institution.id!))
        .collect(),
    );
    expect(allUnitsAtOrg.filter((u) => u.title === "Fractions 101").length).toBe(1);
  });

  test("learner assignments: pushed LIVE (setAt defined); throws when unit isn't at albatross", async () => {
    const t = convexTest(schema, modules);
    const { albatross, primary, actor } = await seedBaseFixtures(t);
    const { unitId, activityId } = await seedSourceUnit(t, actor, albatross, "Albatross Unit");
    const { unitId: wrongUnitId, activityId: wrongActivityId } = await seedSourceUnit(
      t,
      actor,
      primary,
      "Wrong Institution Unit",
    );

    const result = await t.mutation(internal.orgDemo.setupPartnerOrg, {
      org: { name: "Punahou School" },
      staff: [{ email: "teacher@punahou.example", name: "Teacher T", role: "teacher" }],
      learnerAssignments: [{ unitId, activityId }],
      actorUserId: actor,
      dryRun: false,
    });

    expect(result.assignments.length).toBe(1);
    const assignmentId = result.assignments[0].assignmentId;
    expect(assignmentId).toBeTruthy();
    const assignment = await t.run((ctx) => ctx.db.get(assignmentId!));
    const entry = assignment?.activitySchedule?.find((e) => e.activityId === activityId);
    expect(entry).toBeTruthy();
    expect(entry?.setAt).toBeDefined();

    await expect(
      t.mutation(internal.orgDemo.setupPartnerOrg, {
        org: { name: "Punahou School 2" },
        staff: [{ email: "teacher2@punahou.example", name: "Teacher T2", role: "teacher" }],
        learnerAssignments: [{ unitId: wrongUnitId, activityId: wrongActivityId }],
        actorUserId: actor,
        dryRun: false,
      }),
    ).rejects.toThrow(/not stamped/);
  });
});

describe("orgDemo — partnerOrgReport", () => {
  test("returns found, lists staff atPrimary:false, and lists copied unit title", async () => {
    const t = convexTest(schema, modules);
    const { primary, actor } = await seedBaseFixtures(t);
    const { unitId } = await seedSourceUnit(t, actor, primary, "Fractions 101");

    await t.mutation(internal.orgDemo.setupPartnerOrg, {
      org: { name: "Punahou School" },
      staff: [{ email: "teacher@punahou.example", name: "Teacher T", role: "teacher" }],
      copyUnitIds: [unitId],
      actorUserId: actor,
      dryRun: false,
    });

    const report = await t.query(internal.orgDemo.partnerOrgReport, {
      slug: "punahou-school",
    });
    expect(report.found).toBe(true);
    if (!report.found) throw new Error("unreachable");
    const teacherEntry = report.people.find((p) => p.email === "teacher@punahou.example");
    expect(teacherEntry).toBeTruthy();
    expect(teacherEntry?.atPrimary).toBe(false);
    expect(report.units).toContain("Fractions 101");
  });
});
