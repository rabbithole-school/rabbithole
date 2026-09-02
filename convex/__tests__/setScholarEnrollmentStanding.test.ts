import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "../schema";
import { api, internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import {
  seedScholarInInstitution,
  seedStaffWithMembership,
  seedTestInstitution,
} from "./institutionTestHelpers";

const modules = (
  import.meta as ImportMeta & {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("../**/*.ts");

async function withUser(t: ReturnType<typeof convexTest>, userId: Id<"users">) {
  const sessionId = await t.run(async (ctx) => {
    const session: Omit<Doc<"authSessions">, "_id" | "_creationTime"> = {
      userId,
      expirationTime: Date.now() + 1000 * 60 * 60,
    };
    return await ctx.db.insert("authSessions", session);
  });
  return t.withIdentity({
    subject: `${userId}|${sessionId}`,
    issuer: "https://convex.dev",
  });
}

async function seedAdmin(t: ReturnType<typeof convexTest>) {
  return t.run((ctx) =>
    ctx.db.insert("users", {
      name: "Fixture Admin",
      username: "fixture-admin",
      role: "platform_admin",
    }),
  );
}

describe("setScholarEnrollmentStanding", () => {
  test("admin flips a scholar to Extended education, and the enrolled roster drops them", async () => {
    const t = convexTest(schema, modules);
    const institutionId = await seedTestInstitution(t, { isPrimary: true });
    const scholarId = await seedScholarInInstitution(t, {
      institutionId,
      name: "Guest Kid",
      username: "guest-kid",
    });
    const teacherId = await seedStaffWithMembership(t, { institutionId });
    const adminId = await seedAdmin(t);

    const asAdmin = await withUser(t, adminId);
    const result = await asAdmin.mutation(api.users.setScholarEnrollmentStanding, {
      scholarId,
      enrollmentStanding: "program_guest",
    });
    expect(result.enrollmentStanding).toBe("program_guest");

    const asTeacher = await withUser(t, teacherId);
    const enrolledOnly = await asTeacher.query(api.users.listScholars, {
      includeProgramGuests: false,
    });
    expect(enrolledOnly.map((s) => s.name)).not.toContain("Guest Kid");
    const withGuests = await asTeacher.query(api.users.listScholars, {
      includeProgramGuests: true,
    });
    expect(withGuests.map((s) => s.name)).toContain("Guest Kid");

    // And back again.
    await asAdmin.mutation(api.users.setScholarEnrollmentStanding, {
      scholarId,
      enrollmentStanding: "enrolled",
    });
    const restored = await asTeacher.query(api.users.listScholars, {
      includeProgramGuests: false,
    });
    expect(restored.map((s) => s.name)).toContain("Guest Kid");
  });

  test("teachers and operations staff (the retired registrar role's successor) may not change standing", async () => {
    const t = convexTest(schema, modules);
    const institutionId = await seedTestInstitution(t);
    const scholarId = await seedScholarInInstitution(t, {
      institutionId,
      name: "Some Kid",
      username: "some-kid",
    });
    const teacherId = await seedStaffWithMembership(t, { institutionId });
    const registrarId = await seedStaffWithMembership(t, {
      institutionId,
      role: "staff",
      username: "fixture-registrar",
    });
    for (const staffId of [teacherId, registrarId]) {
      const asStaff = await withUser(t, staffId);
      await expect(
        asStaff.mutation(api.users.setScholarEnrollmentStanding, {
          scholarId,
          enrollmentStanding: "program_guest",
        }),
      ).rejects.toThrow();
    }
  });

  test("refuses to mark a scholar Extended education while they sit in an enrolled-only group", async () => {
    const t = convexTest(schema, modules);
    const institutionId = await seedTestInstitution(t);
    const scholarId = await seedScholarInInstitution(t, {
      institutionId,
      name: "Clubbed Kid",
      username: "clubbed-kid",
    });
    const teacherId = await seedStaffWithMembership(t, { institutionId });
    await t.run(async (ctx) => {
      await ctx.db.insert("scholarGroups", {
        name: "Homeroom",
        scholarIds: [scholarId],
        participation: "enrolled_only",
        teacherId,
        ownerId: teacherId,
        institutionId,
      });
    });
    const adminId = await seedAdmin(t);
    const asAdmin = await withUser(t, adminId);
    await expect(
      asAdmin.mutation(api.users.setScholarEnrollmentStanding, {
        scholarId,
        enrollmentStanding: "program_guest",
      }),
    ).rejects.toThrow(/Homeroom/);

    // Membership in a guest-inclusive group is fine.
    await t.run(async (ctx) => {
      const group = await ctx.db
        .query("scholarGroups")
        .filter((q) => q.eq(q.field("name"), "Homeroom"))
        .unique();
      if (group) await ctx.db.patch(group._id, { participation: "includes_program_guests" });
    });
    const result = await asAdmin.mutation(api.users.setScholarEnrollmentStanding, {
      scholarId,
      enrollmentStanding: "program_guest",
    });
    expect(result.enrollmentStanding).toBe("program_guest");
  });

  test("rejects a non-scholar target", async () => {
    const t = convexTest(schema, modules);
    const institutionId = await seedTestInstitution(t);
    const teacherId = await seedStaffWithMembership(t, { institutionId });
    const adminId = await seedAdmin(t);
    const asAdmin = await withUser(t, adminId);
    await expect(
      asAdmin.mutation(api.users.setScholarEnrollmentStanding, {
        scholarId: teacherId,
        enrollmentStanding: "program_guest",
      }),
    ).rejects.toThrow(/Scholar not found/);
  });

  test("internal fixEnrollmentStanding twin applies the same guard and patch", async () => {
    const t = convexTest(schema, modules);
    const institutionId = await seedTestInstitution(t);
    const scholarId = await seedScholarInInstitution(t, {
      institutionId,
      name: "CLI Kid",
      username: "cli-kid",
    });
    const teacherId = await seedStaffWithMembership(t, { institutionId });
    // Two enrolled-only groups (one with a legacy undefined participation,
    // which counts as enrolled-only) — the guard must name both.
    await t.run(async (ctx) => {
      await ctx.db.insert("scholarGroups", {
        name: "Homeroom",
        scholarIds: [scholarId],
        participation: "enrolled_only",
        teacherId,
        ownerId: teacherId,
        institutionId,
      });
      await ctx.db.insert("scholarGroups", {
        name: "Legacy Club",
        scholarIds: [scholarId],
        teacherId,
        ownerId: teacherId,
        institutionId,
      });
    });
    await expect(
      t.mutation(internal.users.fixEnrollmentStanding, {
        userId: scholarId,
        enrollmentStanding: "program_guest",
      }),
    ).rejects.toThrow(/"Homeroom", "Legacy Club"/);

    await t.run(async (ctx) => {
      for await (const group of ctx.db.query("scholarGroups")) {
        await ctx.db.patch(group._id, {
          participation: "includes_program_guests",
        });
      }
    });
    const result = await t.mutation(internal.users.fixEnrollmentStanding, {
      userId: scholarId,
      enrollmentStanding: "program_guest",
    });
    expect(result.enrollmentStanding).toBe("program_guest");
    const row = await t.run((ctx) => ctx.db.get(scholarId));
    expect(row?.enrollmentStanding).toBe("program_guest");
  });
});
