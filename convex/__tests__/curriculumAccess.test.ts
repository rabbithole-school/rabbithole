import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import schema from "../schema";

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
    return await ctx.db.insert("authSessions", session);
  });
  return t.withIdentity({
    subject: `${userId}|${sessionId}`,
    issuer: "https://convex.dev",
  });
}

async function seedWorld(t: ReturnType<typeof convexTest>) {
  return await t.run(async (ctx) => {
    const moli = await ctx.db.insert("institutions", {
      name: "Moli School",
      slug: "moli",
      kind: "school",
      isPrimary: true,
    });
    const guests = await ctx.db.insert("institutions", {
      name: "Guests",
      slug: "guests",
      kind: "guest",
    });
    const teacher = await ctx.db.insert("users", {
      name: "Teacher",
      username: "teacher",
      role: "teacher",
    });
    const supplemental = await ctx.db.insert("users", {
      name: "Supplemental",
      username: "supplemental",
      role: "staff",
    });
    const registrar = await ctx.db.insert("users", {
      name: "Staff",
      username: "staff-role",
      role: "staff",
    });
    const foreignDesigner = await ctx.db.insert("users", {
      name: "Foreign designer",
      username: "foreign-designer",
      role: "staff",
    });
    const membershipRows = [
      { userId: supplemental, role: "staff" as const, institutionId: moli },
      {
        userId: supplemental,
        role: "staff" as const,
        institutionId: guests,
      },
      { userId: registrar, role: "staff" as const, institutionId: moli },
      {
        userId: foreignDesigner,
        role: "staff" as const,
        institutionId: moli,
      },
    ];
    for (const membership of membershipRows) {
      await ctx.db.insert("memberships", membership);
    }
    await ctx.db.insert("staffCapabilityGrants", {
      granteeUserId: supplemental,
      institutionId: moli,
      capability: "curriculum:edit",
      grantedBy: teacher,
      grantedAt: Date.now(),
    });
    const unit = await ctx.db.insert("units", {
      teacherId: teacher,
      institutionId: moli,
      title: "Inactive design catalog",
      subject: "Design",
      isActive: false,
    });
    const foreignUnit = await ctx.db.insert("units", {
      teacherId: teacher,
      institutionId: guests,
      title: "Foreign design catalog",
      subject: "Private foreign subject",
      isActive: false,
    });
    return { supplemental, registrar, foreignDesigner, unit, foreignUnit };
  });
}

describe("scoped curriculum capability", () => {
  test("a staff member with a same-institution curriculum:edit grant may design and edit units", async () => {
    const t = convexTest(schema, modules);
    const { supplemental, unit, foreignUnit } = await seedWorld(t);
    const asSupplemental = await asUser(t, supplemental);

    const me = await asSupplemental.query(api.users.currentUser, {});
    expect(me?.role).toBe("staff");
    expect(me?.hasCurriculumAccess).toBe(true);

    const list = await asSupplemental.query(api.units.list, {});
    expect(list.map((row) => row._id)).toContain(unit);
    expect(list.map((row) => row._id)).not.toContain(foreignUnit);
    const foreignScope = await asSupplemental.query(api.units.list, {
      scope: "guests",
    });
    expect(foreignScope.map((row) => row._id)).not.toContain(foreignUnit);
    const allScope = await asSupplemental.query(api.units.list, {
      scope: "all",
    });
    expect(allScope.map((row) => row._id)).toContain(unit);
    expect(allScope.map((row) => row._id)).not.toContain(foreignUnit);
    await expect(asSupplemental.query(api.units.subjects, {})).resolves.toContain(
      "Design",
    );
    await expect(asSupplemental.query(api.units.subjects, {})).resolves.not.toContain(
      "Private foreign subject",
    );
    await expect(
      asSupplemental.mutation(api.units.setGranules, {
        id: foreignUnit,
        essentialQuestions: [{ text: "Cross-school edit" }],
      }),
    ).rejects.toThrow(/not allowed to edit/i);
    const createdUnit = await asSupplemental.mutation(api.units.create, {
      title: "Supplemental design",
    });
    const lessonId = await asSupplemental.mutation(api.lessons.create, {
      unitId: createdUnit,
      title: "Build session",
    });
    const activityId = await asSupplemental.mutation(api.activities.create, {
      lessonId,
      title: "Robot challenge",
      kind: "offline",
    });
    await asSupplemental.mutation(api.activityResources.addLink, {
      activityId,
      title: "Challenge brief",
      url: "https://example.com/robotics",
    });
    await expect(
      asSupplemental.query(api.activityResources.listForActivity, {
        activityId,
      }),
    ).resolves.toMatchObject([{ title: "Challenge brief" }]);
    await expect(
      asSupplemental.mutation(
        api.activityCompletions.clearForScholarInUnit,
        { scholarId: supplemental, unitId: unit },
      ),
    ).rejects.toThrow(/teacher or admin role required/i);
    await expect(
      asSupplemental.mutation(api.units.setGranules, {
        id: unit,
        essentialQuestions: [{ text: "What makes a design useful?" }],
      }),
    ).resolves.toBeNull();
  });

  test("a plain staff member (no capability grant) is denied curriculum and teacher-only access", async () => {
    const t = convexTest(schema, modules);
    const { registrar, unit } = await seedWorld(t);
    const asRegistrar = await asUser(t, registrar);

    expect((await asRegistrar.query(api.users.currentUser, {}))?.hasCurriculumAccess).toBe(
      false,
    );
    await expect(
      asRegistrar.mutation(api.units.create, { title: "Denied design" }),
    ).rejects.toThrow(/curriculum access required/i);
    await expect(
      asRegistrar.mutation(api.units.setGranules, {
        id: unit,
        essentialQuestions: [{ text: "Denied edit" }],
      }),
    ).rejects.toThrow(/not allowed to edit/i);
    await expect(asRegistrar.query(api.rooms.listOwned, {})).rejects.toThrow(
      /teacher or admin role required/i,
    );
  });

  test("a staff membership in another institution does not grant curriculum access", async () => {
    const t = convexTest(schema, modules);
    const { foreignDesigner, unit } = await seedWorld(t);
    const asForeignDesigner = await asUser(t, foreignDesigner);

    expect(
      (await asForeignDesigner.query(api.users.currentUser, {}))?.hasCurriculumAccess,
    ).toBe(false);
    await expect(
      asForeignDesigner.mutation(api.units.setGranules, {
        id: unit,
        essentialQuestions: [{ text: "Foreign edit" }],
      }),
    ).rejects.toThrow(/not allowed to edit/i);
    await expect(asForeignDesigner.query(api.rooms.listOwned, {})).rejects.toThrow(
      /teacher or admin role required/i,
    );
  });
});
