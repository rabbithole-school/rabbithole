import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "../schema";
import { grantInstitutionMembership, seedTestInstitution } from "./institutionTestHelpers";
import { api } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";

const modules = (
  import.meta as ImportMeta & {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("../**/*.ts");

async function seedUser(
  t: ReturnType<typeof convexTest>,
  role: "scholar" | "teacher" | "platform_admin" | "curriculum_designer" = "scholar",
  overrides: Partial<Doc<"users">> = {},
) {
  const institutionId = await seedTestInstitution(t);
  const userId = await t.run(async (ctx) => {
    return await ctx.db.insert("users", {
      name:
        overrides.name ??
        (role === "scholar" ? "Test Scholar" : `Test ${role}`),
      username:
        overrides.username ??
        (role === "scholar" ? "testscholar" : `test${role}`),
      role,
      readingLevel: overrides.readingLevel,
      image: overrides.image,
    });
  });

  await t.run((ctx) => ctx.db.patch(userId, { institutionId }));
  if (role === "teacher") {
    await grantInstitutionMembership(t, userId, institutionId, role);
  }
  return userId;
}

async function withUser(
  t: ReturnType<typeof convexTest>,
  userId: Id<"users">,
) {
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

async function seedUnit(
  t: ReturnType<typeof convexTest>,
  teacherId: Id<"users">,
  title = "Test Unit",
) {
  return await t.run(async (ctx) =>
    ctx.db.insert("units", { teacherId, title, isActive: true }),
  );
}

describe("assignments.listForUnit", () => {
  test("returns this unit's assignments, active before archived", async () => {
    const t = convexTest(schema, modules);
    const teacherId = await seedUser(t, "teacher");
    const scholarId = await seedUser(t, "scholar");
    const unitId = await seedUnit(t, teacherId);
    const asTeacher = await withUser(t, teacherId);

    // Two runs of the same unit; archive one.
    const activeId = await asTeacher.mutation(api.assignments.create, {
      unitId,
      scholarIds: [scholarId],
    });
    const archivedId = await asTeacher.mutation(api.assignments.create, {
      unitId,
      scholarIds: [scholarId],
    });
    await asTeacher.mutation(api.assignments.archive, {
      assignmentId: archivedId,
    });

    const rows = await asTeacher.query(api.assignments.listForUnit, {
      unitId,
    });
    expect(rows).toHaveLength(2);
    // Active sorts ahead of archived.
    expect(String(rows[0]._id)).toBe(String(activeId));
    expect(rows[0].archivedAt).toBeNull();
    expect(String(rows[1]._id)).toBe(String(archivedId));
    expect(rows[1].archivedAt).not.toBeNull();
    expect(rows[0].scholarCount).toBe(1);
  });

  test("excludes assignments of other units", async () => {
    const t = convexTest(schema, modules);
    const teacherId = await seedUser(t, "teacher");
    const scholarId = await seedUser(t, "scholar");
    const unitA = await seedUnit(t, teacherId, "Unit A");
    const unitB = await seedUnit(t, teacherId, "Unit B");
    const asTeacher = await withUser(t, teacherId);

    await asTeacher.mutation(api.assignments.create, {
      unitId: unitA,
      scholarIds: [scholarId],
    });
    await asTeacher.mutation(api.assignments.create, {
      unitId: unitB,
      scholarIds: [scholarId],
    });

    const rows = await asTeacher.query(api.assignments.listForUnit, {
      unitId: unitA,
    });
    expect(rows).toHaveLength(1);
    expect(String(rows[0].unitId)).toBe(String(unitA));
  });

  test("scopes to the calling teacher", async () => {
    const t = convexTest(schema, modules);
    const teacherA = await seedUser(t, "teacher", { username: "teacherA" });
    const teacherB = await seedUser(t, "teacher", { username: "teacherB" });
    const scholarId = await seedUser(t, "scholar");
    // Same unit; an assignment created by teacher A only.
    const unitId = await seedUnit(t, teacherA);

    const asA = await withUser(t, teacherA);
    await asA.mutation(api.assignments.create, {
      unitId,
      scholarIds: [scholarId],
    });

    const asB = await withUser(t, teacherB);
    const rowsForB = await asB.query(api.assignments.listForUnit, { unitId });
    expect(rowsForB).toHaveLength(0);

    const rowsForA = await asA.query(api.assignments.listForUnit, { unitId });
    expect(rowsForA).toHaveLength(1);
  });

  test("blocks curriculum_designer (execution is teacher-only)", async () => {
    // listForUnit is intentionally teacher/admin-only — assignments are an
    // execution concept. The curriculum_designer dashboard fix hides this
    // query in the UI rather than loosening the gate, so the gate must hold.
    const t = convexTest(schema, modules);
    const teacherId = await seedUser(t, "teacher");
    const designerId = await seedUser(t, "curriculum_designer");
    const unitId = await seedUnit(t, teacherId);
    const asDesigner = await withUser(t, designerId);
    await expect(
      asDesigner.query(api.assignments.listForUnit, { unitId }),
    ).rejects.toThrow();
  });
});
