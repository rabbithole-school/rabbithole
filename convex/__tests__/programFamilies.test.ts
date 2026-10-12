import { convexTest, type TestConvex } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "../schema";
import { internal } from "../_generated/api";
import { makeScholar, makeWorld } from "./factories/world";

const modules = (
  import.meta as ImportMeta & {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("../**/*.ts");

const OWNER_EMAIL = "owner@example.invalid";
const FAMILY = {
  scholar: {
    name: "Test scholar",
    dateOfBirth: "2000-01-01",
    grade: "4",
    externalSchoolName: "Test external school",
  },
  guardian: {
    name: "Test guardian",
    email: "guardian@example.invalid",
    phone: "0000000000",
  },
};

function args(overrides: Record<string, unknown> = {}) {
  return {
    programGroupName: "Test program group",
    instructionalKind: "extended",
    ownerStaffEmail: OWNER_EMAIL,
    families: [FAMILY],
    ...overrides,
  };
}

async function setup(t: TestConvex<typeof schema>, ownerHasMembership = true) {
  const world = await makeWorld(t, {
    schools: 2,
    scholarsPerSchool: 0,
    parentsPerSchool: 0,
    includePlatformAdmin: false,
  });
  const institution = world.schools[0];
  const foreignInstitution = world.schools[1];

  await t.run(async (ctx) => {
    await ctx.db.patch(institution.teacher.id, {
      name: "Test owner",
      email: OWNER_EMAIL,
    });
    if (!ownerHasMembership) {
      const membership = await ctx.db
        .query("memberships")
        .withIndex("by_user_role", (q) =>
          q.eq("userId", institution.teacher.id).eq("role", "teacher"),
        )
        .unique();
      if (membership) {
        await ctx.db.delete(membership._id);
      }
    }
  });

  return {
    institutionId: institution.id,
    foreignInstitutionId: foreignInstitution.id,
    ownerId: institution.teacher.id,
  };
}

describe("seedProgramFamilies", () => {
  test("dry-run defaults to no writes and returns a PII-free review summary", async () => {
    const t = convexTest(schema, modules);
    await setup(t);

    const result = await t.run((ctx) =>
      ctx.runMutation(internal.seed.programFamilies.seedProgramFamilies, args()),
    );

    expect(result).toMatchObject({
      dryRun: true,
      familiesProcessed: 1,
      groupCreated: true,
      groupMembersAdded: 1,
      scholarsCreated: 1,
      parentsCreated: 1,
      guardianshipsCreated: 1,
      warnings: [],
    });
    expect(await t.run((ctx) => ctx.db.query("scholarGroups").collect())).toEqual([]);
    expect(
      await t.run((ctx) =>
        ctx.db
          .query("users")
          .withIndex("by_role", (q) => q.eq("role", "scholar"))
          .collect(),
      ),
    ).toEqual([]);
    expect(await t.run((ctx) => ctx.db.query("guardianships").collect())).toEqual([]);
  });

  test("applies idempotently with memberships, contact phone, and guardianship", async () => {
    const t = convexTest(schema, modules);
    const { institutionId, ownerId } = await setup(t);

    const first = await t.run((ctx) =>
      ctx.runMutation(
        internal.seed.programFamilies.seedProgramFamilies,
        args({ dryRun: false }),
      ),
    );
    expect(first).toMatchObject({
      dryRun: false,
      scholarsCreated: 1,
      parentsCreated: 1,
      guardianshipsCreated: 1,
    });

    const scholar = await t.run((ctx) =>
      ctx.db
        .query("users")
        .withIndex("by_role", (q) => q.eq("role", "scholar"))
        .unique(),
    );
    const parent = await t.run((ctx) =>
      ctx.db
        .query("users")
        .withIndex("by_email", (q) => q.eq("email", FAMILY.guardian.email))
        .unique(),
    );
    const group = await t.run((ctx) => ctx.db.query("scholarGroups").unique());
    expect(scholar).toMatchObject({
      institutionId,
      enrollmentStanding: "program_guest",
      dateOfBirth: FAMILY.scholar.dateOfBirth,
      gradeLevel: FAMILY.scholar.grade,
      externalSchoolName: FAMILY.scholar.externalSchoolName,
    });
    expect(parent).toMatchObject({ role: "parent", phone: FAMILY.guardian.phone });
    expect(group).toMatchObject({
      institutionId,
      ownerId,
      type: "extended",
      participation: "includes_program_guests",
      scholarIds: [scholar!._id],
    });
    expect(
      await t.run((ctx) =>
        ctx.db
          .query("guardianships")
          .withIndex("by_pair", (q) =>
            q.eq("parentUserId", parent!._id).eq("scholarUserId", scholar!._id),
          )
          .unique(),
      ),
    ).toBeTruthy();
    expect(
      await t.run((ctx) =>
        ctx.db
          .query("memberships")
          .withIndex("by_user_role", (q) =>
            q.eq("userId", scholar!._id).eq("role", "scholar"),
          )
          .unique(),
      ),
    ).toMatchObject({ institutionId });
    expect(
      await t.run((ctx) =>
        ctx.db
          .query("memberships")
          .withIndex("by_user_role", (q) =>
            q.eq("userId", parent!._id).eq("role", "parent"),
          )
          .unique(),
      ),
    ).toBeTruthy();

    const second = await t.run((ctx) =>
      ctx.runMutation(
        internal.seed.programFamilies.seedProgramFamilies,
        args({ dryRun: false }),
      ),
    );
    expect(second).toMatchObject({
      scholarsCreated: 0,
      parentsCreated: 0,
      guardianshipsCreated: 0,
      groupMembersAdded: 0,
      scholarsUpdated: 1,
      parentsReused: 1,
    });
    expect(
      await t.run((ctx) => ctx.db.query("guardianships").collect()),
    ).toHaveLength(1);
  });

  test("requires an existing primary-institution staff owner", async () => {
    const t = convexTest(schema, modules);
    await setup(t, false);

    await expect(
      t.run((ctx) =>
        ctx.runMutation(internal.seed.programFamilies.seedProgramFamilies, args()),
      ),
    ).rejects.toThrow(/primary institution/i);
  });

  test("can resolve a unique staff owner by name", async () => {
    const t = convexTest(schema, modules);
    const { ownerId } = await setup(t);

    await t.run((ctx) =>
      ctx.runMutation(
        internal.seed.programFamilies.seedProgramFamilies,
        args({
          ownerStaffEmail: undefined,
          ownerStaffName: "Test owner",
          dryRun: false,
        }),
      ),
    );

    expect(
      await t.run((ctx) => ctx.db.query("scholarGroups").unique()),
    ).toMatchObject({ ownerId });
  });

  test("updates a matching group without dropping its existing members", async () => {
    const t = convexTest(schema, modules);
    const { institutionId, ownerId } = await setup(t);
    const enrolledScholarId = await makeScholar(t, institutionId, {
      name: "Existing scholar",
      enrollmentStanding: "enrolled",
    });
    const groupId = await t.run((ctx) =>
      ctx.db.insert("scholarGroups", {
        teacherId: ownerId,
        ownerId,
        institutionId,
        name: "Test program group",
        type: "other",
        participation: "enrolled_only",
        scholarIds: [enrolledScholarId.id],
      }),
    );

    await t.run((ctx) =>
      ctx.runMutation(
        internal.seed.programFamilies.seedProgramFamilies,
        args({ dryRun: false }),
      ),
    );

    const group = await t.run((ctx) => ctx.db.get(groupId));
    expect(group?.participation).toBe("includes_program_guests");
    expect(group?.ownerId).toBe(ownerId);
    expect(group?.scholarIds).toContain(enrolledScholarId.id);
    expect(group?.scholarIds).toHaveLength(2);
  });

  test("rejects a matched enrolled scholar rather than downgrading it", async () => {
    const t = convexTest(schema, modules);
    const { institutionId } = await setup(t);
    await makeScholar(t, institutionId, {
      name: FAMILY.scholar.name,
      enrollmentStanding: "enrolled",
      dateOfBirth: FAMILY.scholar.dateOfBirth,
    });

    await expect(
      t.run((ctx) =>
        ctx.runMutation(
          internal.seed.programFamilies.seedProgramFamilies,
          args({ dryRun: false }),
        ),
      ),
    ).rejects.toThrow(/collides with an enrolled scholar/i);
    expect(await t.run((ctx) => ctx.db.query("scholarGroups").collect())).toEqual([]);
    expect(await t.run((ctx) => ctx.db.query("guardianships").collect())).toEqual([]);
  });

  test("rejects a same-name-and-DOB guest at another institution", async () => {
    const t = convexTest(schema, modules);
    const { foreignInstitutionId } = await setup(t);
    const foreignGuest = await makeScholar(t, foreignInstitutionId, {
      name: FAMILY.scholar.name,
      enrollmentStanding: "program_guest",
      dateOfBirth: FAMILY.scholar.dateOfBirth,
    });

    await expect(
      t.run((ctx) =>
        ctx.runMutation(
          internal.seed.programFamilies.seedProgramFamilies,
          args({ dryRun: false }),
        ),
      ),
    ).rejects.toThrow(/another institution/i);
    expect(
      await t.run((ctx) => ctx.db.get(foreignGuest.id)),
    ).toMatchObject({ institutionId: foreignInstitutionId });
    expect(await t.run((ctx) => ctx.db.query("scholarGroups").collect())).toEqual([]);
  });
});
