import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "../../schema";
import type { Id } from "../../_generated/dataModel";
import { requireAssignmentAccessible, requireStaffAccessible } from "../access";

/**
 * Direct unit coverage for `requireStaffAccessible` (convex/lib/access.ts) —
 * the STAFF-side twin of `requireGroupScholarAccess`. Exercised via `t.run`
 * against a bare ctx rather than through a handler, since the helper itself
 * takes no dependency on any particular caller.
 */

const modules = (
  import.meta as ImportMeta & {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("../../**/*.ts");

async function seedInstitution(
  t: ReturnType<typeof convexTest>,
  slug: string,
  isPrimary = false,
) {
  return await t.run(async (ctx) =>
    ctx.db.insert("institutions", { name: slug, slug, kind: "school", isPrimary }),
  );
}

async function seedTeacherIn(
  t: ReturnType<typeof convexTest>,
  institutionId: Id<"institutions">,
  username: string,
) {
  const teacherId = await t.run(async (ctx) =>
    ctx.db.insert("users", { name: username, username, role: "teacher" }),
  );
  await t.run(async (ctx) =>
    ctx.db.insert("memberships", {
      userId: teacherId,
      role: "teacher",
      institutionId,
    }),
  );
  return teacherId;
}

async function seedPlatformAdmin(t: ReturnType<typeof convexTest>) {
  return await t.run(async (ctx) =>
    ctx.db.insert("users", {
      name: "Admin",
      username: `admin-${Math.random().toString(36).slice(2)}`,
      role: "platform_admin",
    }),
  );
}

describe("requireStaffAccessible", () => {
  test("passes when staffId names the caller itself, even with no membership", async () => {
    const t = convexTest(schema, modules);
    const teacherId = await t.run(async (ctx) =>
      ctx.db.insert("users", { name: "Lonely", username: "lonely-teacher", role: "teacher" }),
    );
    const caller = await t.run(async (ctx) => ctx.db.get(teacherId));
    await t.run(async (ctx) => requireStaffAccessible(ctx, caller!, teacherId));
  });

  test("passes when the target staffer shares an institution with the caller", async () => {
    const t = convexTest(schema, modules);
    const instA = await seedInstitution(t, "school-a");
    const callerId = await seedTeacherIn(t, instA, "teacherA");
    const targetId = await seedTeacherIn(t, instA, "teacherA2");
    const caller = await t.run(async (ctx) => ctx.db.get(callerId));

    await t.run(async (ctx) => requireStaffAccessible(ctx, caller!, targetId));
  });

  test("throws when the target staffer is at a wholly different institution", async () => {
    const t = convexTest(schema, modules);
    const instA = await seedInstitution(t, "school-a");
    const instB = await seedInstitution(t, "school-b");
    const callerId = await seedTeacherIn(t, instA, "teacherA");
    const foreignId = await seedTeacherIn(t, instB, "teacherB");
    const caller = await t.run(async (ctx) => ctx.db.get(callerId));

    await expect(
      t.run(async (ctx) => requireStaffAccessible(ctx, caller!, foreignId)),
    ).rejects.toThrow(/forbidden/i);
  });

  test("platform_admin passes for any staffer, regardless of institution", async () => {
    const t = convexTest(schema, modules);
    const instB = await seedInstitution(t, "school-b");
    const adminId = await seedPlatformAdmin(t);
    const foreignId = await seedTeacherIn(t, instB, "teacherB");
    const admin = await t.run(async (ctx) => ctx.db.get(adminId));

    await t.run(async (ctx) => requireStaffAccessible(ctx, admin!, foreignId));
  });
});

/**
 * Direct unit coverage for `requireAssignmentAccessible` (convex/lib/access.ts) —
 * the ASSIGNMENT-side twin the masterSchedule.ts write surface (`placeClass`,
 * `placeHomework`, `cascadeUnit`) uses to authorize a client-supplied
 * `assignmentId` before it's linked into a placement or cascaded. End-to-end
 * coverage through the actual handlers lives in
 * `convex/__tests__/scheduleTenantGuards.test.ts`.
 */
describe("requireAssignmentAccessible", () => {
  async function seedScholarIn(
    t: ReturnType<typeof convexTest>,
    institutionId: Id<"institutions"> | undefined,
    username: string,
  ) {
    return await t.run(async (ctx) =>
      ctx.db.insert("users", {
        name: username,
        username,
        role: "scholar",
        institutionId,
      }),
    );
  }

  async function seedUnitIn(
    t: ReturnType<typeof convexTest>,
    teacherId: Id<"users">,
    institutionId: Id<"institutions"> | undefined,
  ) {
    return await t.run(async (ctx) =>
      ctx.db.insert("units", {
        teacherId,
        institutionId,
        title: "Fractions",
        isActive: true,
      }),
    );
  }

  async function seedIndependentStudyUnit(
    t: ReturnType<typeof convexTest>,
    teacherId: Id<"users">,
    authorScholarId: Id<"users">,
  ) {
    return await t.run(async (ctx) =>
      ctx.db.insert("units", {
        teacherId,
        authorScholarId,
        title: "Kai's Study",
        isActive: true,
      }),
    );
  }

  async function seedGroupIn(
    t: ReturnType<typeof convexTest>,
    teacherId: Id<"users">,
    institutionId: Id<"institutions"> | undefined,
    scholarIds: Id<"users">[] = [],
  ) {
    return await t.run(async (ctx) =>
      ctx.db.insert("scholarGroups", {
        teacherId,
        institutionId,
        name: "Geckos",
        scholarIds,
      }),
    );
  }

  async function seedAssignment(
    t: ReturnType<typeof convexTest>,
    teacherId: Id<"users">,
    overrides: {
      scholarGroupId?: Id<"scholarGroups">;
      unitId?: Id<"units">;
      scholarIds?: Id<"users">[];
    } = {},
  ) {
    return await t.run(async (ctx) =>
      ctx.db.insert("assignments", {
        teacherId,
        scholarIds: overrides.scholarIds ?? [],
        scholarGroupId: overrides.scholarGroupId,
        unitId: overrides.unitId,
        startedAt: Date.now(),
      }),
    );
  }

  test("returns null for a missing assignment without throwing", async () => {
    const t = convexTest(schema, modules);
    const instA = await seedInstitution(t, "school-a");
    const callerId = await seedTeacherIn(t, instA, "teacherA");
    const caller = await t.run(async (ctx) => ctx.db.get(callerId));
    const teacherId = await seedTeacherIn(t, instA, "teacherA2");
    const realId = await seedAssignment(t, teacherId);
    await t.run(async (ctx) => ctx.db.delete(realId));

    const result = await t.run((ctx) =>
      requireAssignmentAccessible(ctx, caller!, realId),
    );
    expect(result).toBeNull();
  });

  test("a bare ad-hoc/standing shell (no group, unit, or scholars) falls back to the STAFF boundary on its owner — self passes", async () => {
    const t = convexTest(schema, modules);
    const instA = await seedInstitution(t, "school-a");
    const callerId = await seedTeacherIn(t, instA, "teacherA");
    const caller = await t.run(async (ctx) => ctx.db.get(callerId));
    const assignmentId = await seedAssignment(t, callerId);

    const result = await t.run((ctx) =>
      requireAssignmentAccessible(ctx, caller!, assignmentId),
    );
    expect(result).not.toBeNull();
  });

  test("a bare ad-hoc/standing shell owned by a same-institution colleague passes", async () => {
    const t = convexTest(schema, modules);
    const instA = await seedInstitution(t, "school-a");
    const callerId = await seedTeacherIn(t, instA, "teacherA");
    const colleagueId = await seedTeacherIn(t, instA, "teacherA2");
    const caller = await t.run(async (ctx) => ctx.db.get(callerId));
    const assignmentId = await seedAssignment(t, colleagueId);

    const result = await t.run((ctx) =>
      requireAssignmentAccessible(ctx, caller!, assignmentId),
    );
    expect(result).not.toBeNull();
  });

  test("a bare ad-hoc/standing shell owned by a FOREIGN teacher throws — the assignment itself is a mutable resource even with an empty roster", async () => {
    const t = convexTest(schema, modules);
    // Not a no-op read: reconcilePlacementById -> applyScheduleActivity
    // patches the linked assignment's own activitySchedule as soon as a
    // placement materializes, even with an empty roster. So a signal-less
    // assignment must still fall back to a real ownership boundary, not
    // pass through unconditionally.
    const instA = await seedInstitution(t, "school-a");
    const instB = await seedInstitution(t, "school-b");
    const callerId = await seedTeacherIn(t, instA, "teacherA");
    const foreignTeacherId = await seedTeacherIn(t, instB, "teacherB");
    const caller = await t.run(async (ctx) => ctx.db.get(callerId));
    const assignmentId = await seedAssignment(t, foreignTeacherId);

    await expect(
      t.run((ctx) => requireAssignmentAccessible(ctx, caller!, assignmentId)),
    ).rejects.toThrow(/forbidden/i);
  });

  test("a bare ad-hoc/standing shell owned by a teacher with NO membership at all fails closed (not self, not shared)", async () => {
    const t = convexTest(schema, modules);
    const instA = await seedInstitution(t, "school-a");
    const callerId = await seedTeacherIn(t, instA, "teacherA");
    const caller = await t.run(async (ctx) => ctx.db.get(callerId));
    const orphanTeacherId = await t.run((ctx) =>
      ctx.db.insert("users", {
        name: "orphan",
        username: "orphan-teacher",
        role: "teacher",
      }),
    );
    const assignmentId = await seedAssignment(t, orphanTeacherId);

    await expect(
      t.run((ctx) => requireAssignmentAccessible(ctx, caller!, assignmentId)),
    ).rejects.toThrow(/forbidden/i);
  });

  test("platform_admin passes a bare shell owned by a foreign teacher", async () => {
    const t = convexTest(schema, modules);
    const instB = await seedInstitution(t, "school-b");
    const adminId = await seedPlatformAdmin(t);
    const admin = await t.run(async (ctx) => ctx.db.get(adminId));
    const foreignTeacherId = await seedTeacherIn(t, instB, "teacherB");
    const assignmentId = await seedAssignment(t, foreignTeacherId);

    const result = await t.run((ctx) =>
      requireAssignmentAccessible(ctx, admin!, assignmentId),
    );
    expect(result).not.toBeNull();
  });

  test("passes when the assignment's scholarGroupId is in the caller's institution", async () => {
    const t = convexTest(schema, modules);
    const instA = await seedInstitution(t, "school-a");
    const callerId = await seedTeacherIn(t, instA, "teacherA");
    const otherTeacherId = await seedTeacherIn(t, instA, "teacherA2");
    const caller = await t.run(async (ctx) => ctx.db.get(callerId));
    const groupId = await seedGroupIn(t, otherTeacherId, instA);
    const assignmentId = await seedAssignment(t, otherTeacherId, {
      scholarGroupId: groupId,
    });

    const result = await t.run((ctx) =>
      requireAssignmentAccessible(ctx, caller!, assignmentId),
    );
    expect(result).not.toBeNull();
  });

  test("throws when the assignment's scholarGroupId is at a different institution", async () => {
    const t = convexTest(schema, modules);
    const instA = await seedInstitution(t, "school-a");
    const instB = await seedInstitution(t, "school-b");
    const callerId = await seedTeacherIn(t, instA, "teacherA");
    const foreignTeacherId = await seedTeacherIn(t, instB, "teacherB");
    const caller = await t.run(async (ctx) => ctx.db.get(callerId));
    const foreignGroupId = await seedGroupIn(t, foreignTeacherId, instB);
    const assignmentId = await seedAssignment(t, foreignTeacherId, {
      scholarGroupId: foreignGroupId,
    });

    await expect(
      t.run((ctx) => requireAssignmentAccessible(ctx, caller!, assignmentId)),
    ).rejects.toThrow(/forbidden/i);
  });

  test("throws when only the unit is foreign (no group, empty roster)", async () => {
    const t = convexTest(schema, modules);
    const instA = await seedInstitution(t, "school-a");
    const instB = await seedInstitution(t, "school-b");
    const callerId = await seedTeacherIn(t, instA, "teacherA");
    const foreignTeacherId = await seedTeacherIn(t, instB, "teacherB");
    const caller = await t.run(async (ctx) => ctx.db.get(callerId));
    const foreignUnitId = await seedUnitIn(t, foreignTeacherId, instB);
    const assignmentId = await seedAssignment(t, foreignTeacherId, {
      unitId: foreignUnitId,
    });

    await expect(
      t.run((ctx) => requireAssignmentAccessible(ctx, caller!, assignmentId)),
    ).rejects.toThrow(/forbidden/i);
  });

  test("an unstamped (legacy) unit belongs to the PRIMARY institution — a non-primary caller throws, a primary caller passes", async () => {
    const t = convexTest(schema, modules);
    // Mirrors requireUnitAccessForUser's own rule (convex/lib/unitAccess.ts) +
    // the "legacy unstamped units belong to the primary institution" case in
    // convex/__tests__/unitPrivacy.test.ts. An unstamped unit is NOT
    // "no institution" — it's the PRIMARY school's, and treating it as
    // unresolved would let any other school cascade it.
    const instPrimary = await seedInstitution(t, "school-primary", true);
    const instB = await seedInstitution(t, "school-b");
    const primaryCallerId = await seedTeacherIn(t, instPrimary, "teacherPrimary");
    const nonPrimaryCallerId = await seedTeacherIn(t, instB, "teacherB");
    const primaryCaller = await t.run((ctx) => ctx.db.get(primaryCallerId));
    const nonPrimaryCaller = await t.run((ctx) => ctx.db.get(nonPrimaryCallerId));
    const unstampedUnitId = await seedUnitIn(t, primaryCallerId, undefined);
    const assignmentId = await seedAssignment(t, primaryCallerId, {
      unitId: unstampedUnitId,
    });

    const result = await t.run((ctx) =>
      requireAssignmentAccessible(ctx, primaryCaller!, assignmentId),
    );
    expect(result).not.toBeNull();
    await expect(
      t.run((ctx) =>
        requireAssignmentAccessible(ctx, nonPrimaryCaller!, assignmentId),
      ),
    ).rejects.toThrow(/forbidden/i);
  });

  test("an unstamped Independent Study unit belongs to its AUTHOR SCHOLAR's institution, not primary", async () => {
    const t = convexTest(schema, modules);
    // Mirrors requireUnitAccessForUser's dedicated Independent Study branch
    // (convex/lib/unitAccess.ts) — an IS unit is scholar-owned, so it must
    // NOT fall into the catalog-unit "legacy unstamped == primary" rule
    // above, even though it too has no institutionId of its own.
    const instPrimary = await seedInstitution(t, "school-primary", true);
    const instB = await seedInstitution(t, "school-b");
    const primaryCallerId = await seedTeacherIn(t, instPrimary, "teacherPrimary");
    const scholarBId = await t.run((ctx) =>
      ctx.db.insert("users", {
        name: "scholarB",
        username: "scholarB",
        role: "scholar",
        institutionId: instB,
      }),
    );
    const primaryCaller = await t.run((ctx) => ctx.db.get(primaryCallerId));
    const isUnitId = await seedIndependentStudyUnit(t, primaryCallerId, scholarBId);
    const assignmentId = await seedAssignment(t, primaryCallerId, {
      unitId: isUnitId,
    });

    // The PRIMARY-institution teacher does NOT get a free pass just because
    // primary is the fallback for unstamped CATALOG units — the unit is
    // owned by scholarB's school (instB), not primary.
    await expect(
      t.run((ctx) => requireAssignmentAccessible(ctx, primaryCaller!, assignmentId)),
    ).rejects.toThrow(/forbidden/i);

    // A teacher actually at the scholar's own institution passes.
    const instBCallerId = await seedTeacherIn(t, instB, "teacherB");
    const instBCaller = await t.run((ctx) => ctx.db.get(instBCallerId));
    const result = await t.run((ctx) =>
      requireAssignmentAccessible(ctx, instBCaller!, assignmentId),
    );
    expect(result).not.toBeNull();
  });

  test("throws when only the roster (no group/unit) is entirely foreign", async () => {
    const t = convexTest(schema, modules);
    const instA = await seedInstitution(t, "school-a");
    const instB = await seedInstitution(t, "school-b");
    const callerId = await seedTeacherIn(t, instA, "teacherA");
    const foreignTeacherId = await seedTeacherIn(t, instB, "teacherB");
    const caller = await t.run(async (ctx) => ctx.db.get(callerId));
    const foreignScholarId = await seedScholarIn(t, instB, "scholarB");
    const assignmentId = await seedAssignment(t, foreignTeacherId, {
      scholarIds: [foreignScholarId],
    });

    await expect(
      t.run((ctx) => requireAssignmentAccessible(ctx, caller!, assignmentId)),
    ).rejects.toThrow(/forbidden/i);
  });

  test("throws when the roster resolves its institution ONLY via a scholar membership row, not users.institutionId", async () => {
    const t = convexTest(schema, modules);
    // Mirrors scholarEnrollment.ts's own `scholarInstitutionId` widen-phase
    // rule: a scholar's institution can come from a `memberships` row alone
    // (e.g. an adult learner account, or a scholar mid-migration) with NO
    // `users.institutionId` set at all. Reading the bare field directly
    // would silently drop such a scholar out of roster resolution and
    // misroute a real foreign-roster assignment into the weaker owner-only
    // fallback instead of the roster's actual (foreign) institution.
    const instA = await seedInstitution(t, "school-a");
    const instB = await seedInstitution(t, "school-b");
    const callerId = await seedTeacherIn(t, instA, "teacherA");
    // The OWNER shares an institution with the caller — if the roster
    // resolution under-resolved to "no signal", the weaker owner-only
    // fallback would wrongly PASS this (same-institution "colleague").
    const ownerId = await seedTeacherIn(t, instA, "teacherA2");
    const caller = await t.run(async (ctx) => ctx.db.get(callerId));
    const membershipOnlyScholarId = await t.run(async (ctx) => {
      const scholarId = await ctx.db.insert("users", {
        name: "scholarB-membership-only",
        username: "scholarB-membership-only",
        role: "scholar",
        // Deliberately NO institutionId on the user row.
      });
      await ctx.db.insert("memberships", {
        userId: scholarId,
        role: "scholar",
        institutionId: instB,
      });
      return scholarId;
    });
    const assignmentId = await seedAssignment(t, ownerId, {
      scholarIds: [membershipOnlyScholarId],
    });

    await expect(
      t.run((ctx) => requireAssignmentAccessible(ctx, caller!, assignmentId)),
    ).rejects.toThrow(/forbidden/i);
  });

  test("passes a same-institution colleague's assignment (owner is not the caller)", async () => {
    const t = convexTest(schema, modules);
    const instA = await seedInstitution(t, "school-a");
    const callerId = await seedTeacherIn(t, instA, "teacherA");
    const colleagueId = await seedTeacherIn(t, instA, "teacherA2");
    const caller = await t.run(async (ctx) => ctx.db.get(callerId));
    const scholarId = await seedScholarIn(t, instA, "scholarA");
    const assignmentId = await seedAssignment(t, colleagueId, {
      scholarIds: [scholarId],
    });

    const result = await t.run((ctx) =>
      requireAssignmentAccessible(ctx, caller!, assignmentId),
    );
    expect(result).not.toBeNull();
  });

  test("throws when the roster spans more than one institution (ambiguous, fails closed)", async () => {
    const t = convexTest(schema, modules);
    const instA = await seedInstitution(t, "school-a");
    const instB = await seedInstitution(t, "school-b");
    const callerId = await seedTeacherIn(t, instA, "teacherA");
    const caller = await t.run(async (ctx) => ctx.db.get(callerId));
    const scholarA = await seedScholarIn(t, instA, "scholarA");
    const scholarB = await seedScholarIn(t, instB, "scholarB");
    const assignmentId = await seedAssignment(t, callerId, {
      scholarIds: [scholarA, scholarB],
    });

    await expect(
      t.run((ctx) => requireAssignmentAccessible(ctx, caller!, assignmentId)),
    ).rejects.toThrow(/forbidden/i);
  });

  test("platform_admin passes for a wholly-foreign assignment", async () => {
    const t = convexTest(schema, modules);
    const instB = await seedInstitution(t, "school-b");
    const adminId = await seedPlatformAdmin(t);
    const admin = await t.run(async (ctx) => ctx.db.get(adminId));
    const foreignTeacherId = await seedTeacherIn(t, instB, "teacherB");
    const foreignGroupId = await seedGroupIn(t, foreignTeacherId, instB);
    const assignmentId = await seedAssignment(t, foreignTeacherId, {
      scholarGroupId: foreignGroupId,
    });

    const result = await t.run((ctx) =>
      requireAssignmentAccessible(ctx, admin!, assignmentId),
    );
    expect(result).not.toBeNull();
  });
});
