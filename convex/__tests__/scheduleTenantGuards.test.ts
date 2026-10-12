import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "../schema";
import { api, internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import {
  grantInstitutionMembership,
  grantStaffAccessToScholars,
  seedTestInstitution,
} from "./institutionTestHelpers";

/**
 * Tenant-isolation coverage for the group-keyed schedule/planning handlers
 * guarded by `requireGroupScholarAccess` (+ `requireStaffAccessible` for the
 * teacherId write-key shape): convex/masterSchedule.ts and convex/metaChat.ts.
 * classResolver.test.ts's "listGroupClasses institution boundary" describe
 * block is the precedent this mirrors.
 *
 * One representative handler per shape is exercised end to end here; the
 * pure guard logic itself has direct unit coverage in
 * convex/lib/__tests__/access.test.ts.
 */

const modules = (
  import.meta as ImportMeta & {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("../**/*.ts");

const DAY = 86_400_000;

async function seedUser(
  t: ReturnType<typeof convexTest>,
  role = "teacher",
  overrides: { name?: string; username?: string } = {},
) {
  return await t.run(async (ctx) =>
    ctx.db.insert("users", {
      name: overrides.name ?? `Test ${role}`,
      username:
        overrides.username ?? `test-${role}-${Math.random().toString(36).slice(2)}`,
      role,
    }),
  );
}

async function asUser(t: ReturnType<typeof convexTest>, userId: Id<"users">) {
  const sessionId = await t.run(async (ctx) => {
    const session: Omit<Doc<"authSessions">, "_id" | "_creationTime"> = {
      userId,
      expirationTime: Date.now() + 1000 * 60 * 60,
    };
    return ctx.db.insert("authSessions", session);
  });
  return t.withIdentity({
    subject: `${userId}|${sessionId}`,
    issuer: "https://convex.dev",
  });
}

async function seedPeriod(
  t: ReturnType<typeof convexTest>,
  institutionId?: Id<"institutions">,
) {
  return await t.run(async (ctx) => {
    if (!institutionId) {
      const institutions = await ctx.db.query("institutions").collect();
      if (!institutions.some((institution) => institution.isPrimary)) {
        if (institutions[0]) {
          await ctx.db.patch(institutions[0]._id, { isPrimary: true });
        } else {
          await ctx.db.insert("institutions", {
            name: "Fixture School",
            slug: `fixture-school-${Math.random().toString(36).slice(2)}`,
            kind: "school",
            isPrimary: true,
          });
        }
      }
    }
    return ctx.db.insert("reportingPeriods", {
      label: "Fall 2026",
      startsAt: Date.now(),
      endsAt: Date.now() + 90 * DAY,
      status: "open",
      institutionId,
    });
  });
}

async function seedGroupWithRoster(
  t: ReturnType<typeof convexTest>,
  teacherId: Id<"users">,
  scholarIds: Id<"users">[],
) {
  return await t.run(async (ctx) =>
    ctx.db.insert("scholarGroups", {
      teacherId,
      name: "Geckos",
      emoji: "🦎",
      scholarIds,
    }),
  );
}

describe("group+teacherId mutation: masterSchedule.placeClass", () => {
  test("a same-institution teacher + group succeeds", async () => {
    const t = convexTest(schema, modules);
    const instA = await seedTestInstitution(t, { slug: "school-a" });
    const teacherA = await seedUser(t, "teacher", { username: "teacherA" });
    const otherTeacherA = await seedUser(t, "teacher", { username: "teacherA2" });
    await grantInstitutionMembership(t, teacherA, instA);
    await grantInstitutionMembership(t, otherTeacherA, instA);
    const scholar = await seedUser(t, "scholar", { username: "scholarA" });
    await grantStaffAccessToScholars(t, {
      staffUserId: teacherA,
      scholarIds: [scholar],
      institutionId: instA,
    });
    const groupId = await seedGroupWithRoster(t, teacherA, [scholar]);
    const periodId = await seedPeriod(t);
    const asA = await asUser(t, teacherA);

    const placementId = await asA.mutation(api.masterSchedule.placeClass, {
      periodId,
      groupId,
      subject: "Math",
      teacherId: otherTeacherA,
    });
    expect(placementId).toBeTruthy();
  });

  test("a wholly-foreign group throws", async () => {
    const t = convexTest(schema, modules);
    const instA = await seedTestInstitution(t, { slug: "school-a" });
    const instB = await seedTestInstitution(t, { slug: "school-b" });
    const teacherA = await seedUser(t, "teacher", { username: "teacherA" });
    await grantInstitutionMembership(t, teacherA, instA);
    const teacherB = await seedUser(t, "teacher", { username: "teacherB" });
    await grantInstitutionMembership(t, teacherB, instB);
    const scholarB = await seedUser(t, "scholar", { username: "scholarB" });
    await grantStaffAccessToScholars(t, {
      staffUserId: teacherB,
      scholarIds: [scholarB],
      institutionId: instB,
    });
    const foreignGroupId = await seedGroupWithRoster(t, teacherB, [scholarB]);
    const periodId = await seedPeriod(t);
    const asA = await asUser(t, teacherA);

    await expect(
      asA.mutation(api.masterSchedule.placeClass, {
        periodId,
        groupId: foreignGroupId,
        subject: "Math",
      }),
    ).rejects.toThrow(/forbidden/i);
  });

  test("an empty group still passes", async () => {
    const t = convexTest(schema, modules);
    const teacherA = await seedUser(t, "teacher", { username: "teacherA" });
    const emptyGroupId = await seedGroupWithRoster(t, teacherA, []);
    const periodId = await seedPeriod(t);
    const asA = await asUser(t, teacherA);

    const placementId = await asA.mutation(api.masterSchedule.placeClass, {
      periodId,
      groupId: emptyGroupId,
      subject: "Math",
    });
    expect(placementId).toBeTruthy();
  });

  test("a foreign teacherId throws even when the group is fine", async () => {
    const t = convexTest(schema, modules);
    const instA = await seedTestInstitution(t, { slug: "school-a" });
    const instB = await seedTestInstitution(t, { slug: "school-b" });
    const teacherA = await seedUser(t, "teacher", { username: "teacherA" });
    await grantInstitutionMembership(t, teacherA, instA);
    const teacherB = await seedUser(t, "teacher", { username: "teacherB" });
    await grantInstitutionMembership(t, teacherB, instB);
    const emptyGroupId = await seedGroupWithRoster(t, teacherA, []);
    const periodId = await seedPeriod(t);
    const asA = await asUser(t, teacherA);

    await expect(
      asA.mutation(api.masterSchedule.placeClass, {
        periodId,
        groupId: emptyGroupId,
        subject: "Math",
        teacherId: teacherB,
      }),
    ).rejects.toThrow(/forbidden/i);
  });

  test("an undefined teacherId is a no-op — the caller's own group is enough", async () => {
    const t = convexTest(schema, modules);
    const teacherA = await seedUser(t, "teacher", { username: "teacherA" });
    const groupId = await seedGroupWithRoster(t, teacherA, []);
    const periodId = await seedPeriod(t);
    const asA = await asUser(t, teacherA);

    const placementId = await asA.mutation(api.masterSchedule.placeClass, {
      periodId,
      groupId,
      subject: "Math",
    });
    expect(placementId).toBeTruthy();
  });

  test("platform_admin passes with a foreign group and a foreign teacherId", async () => {
    const t = convexTest(schema, modules);
    const instB = await seedTestInstitution(t, { slug: "school-b" });
    const teacherB = await seedUser(t, "teacher", { username: "teacherB" });
    await grantInstitutionMembership(t, teacherB, instB);
    const scholarB = await seedUser(t, "scholar", { username: "scholarB" });
    await grantStaffAccessToScholars(t, {
      staffUserId: teacherB,
      scholarIds: [scholarB],
      institutionId: instB,
    });
    const foreignGroupId = await seedGroupWithRoster(t, teacherB, [scholarB]);
    const admin = await seedUser(t, "platform_admin", { username: "admin" });
    const periodId = await seedPeriod(t);
    const asAdmin = await asUser(t, admin);

    const placementId = await asAdmin.mutation(api.masterSchedule.placeClass, {
      periodId,
      groupId: foreignGroupId,
      subject: "Math",
      teacherId: teacherB,
    });
    expect(placementId).toBeTruthy();
  });
});

describe("group-only mutation: metaChat.setGroupDailyBlock", () => {
  test("a same-institution teacher succeeds", async () => {
    const t = convexTest(schema, modules);
    const instA = await seedTestInstitution(t, { slug: "school-a" });
    const teacherA = await seedUser(t, "teacher", { username: "teacherA" });
    await grantInstitutionMembership(t, teacherA, instA);
    const scholar = await seedUser(t, "scholar", { username: "scholarA" });
    await grantStaffAccessToScholars(t, {
      staffUserId: teacherA,
      scholarIds: [scholar],
      institutionId: instA,
    });
    const groupId = await seedGroupWithRoster(t, teacherA, [scholar]);
    const asA = await asUser(t, teacherA);

    const result = await asA.mutation(api.metaChat.setGroupDailyBlock, {
      groupId,
      label: "Scholar's Prep",
    });
    expect(result.removed).toBe(false);
  });

  test("a wholly-foreign group throws", async () => {
    const t = convexTest(schema, modules);
    const instA = await seedTestInstitution(t, { slug: "school-a" });
    const instB = await seedTestInstitution(t, { slug: "school-b" });
    const teacherA = await seedUser(t, "teacher", { username: "teacherA" });
    await grantInstitutionMembership(t, teacherA, instA);
    const teacherB = await seedUser(t, "teacher", { username: "teacherB" });
    await grantInstitutionMembership(t, teacherB, instB);
    const scholarB = await seedUser(t, "scholar", { username: "scholarB" });
    await grantStaffAccessToScholars(t, {
      staffUserId: teacherB,
      scholarIds: [scholarB],
      institutionId: instB,
    });
    const foreignGroupId = await seedGroupWithRoster(t, teacherB, [scholarB]);
    const asA = await asUser(t, teacherA);

    await expect(
      asA.mutation(api.metaChat.setGroupDailyBlock, { groupId: foreignGroupId }),
    ).rejects.toThrow(/forbidden/i);
  });

  test("an empty group still passes", async () => {
    const t = convexTest(schema, modules);
    const teacherA = await seedUser(t, "teacher", { username: "teacherA" });
    const emptyGroupId = await seedGroupWithRoster(t, teacherA, []);
    const asA = await asUser(t, teacherA);

    const result = await asA.mutation(api.metaChat.setGroupDailyBlock, {
      groupId: emptyGroupId,
    });
    expect(result.removed).toBe(false);
  });
});

describe("group-only query: metaChat.groupPrepControl", () => {
  test("a same-institution teacher succeeds", async () => {
    const t = convexTest(schema, modules);
    const instA = await seedTestInstitution(t, { slug: "school-a" });
    const teacherA = await seedUser(t, "teacher", { username: "teacherA" });
    await grantInstitutionMembership(t, teacherA, instA);
    const scholar = await seedUser(t, "scholar", { username: "scholarA" });
    await grantStaffAccessToScholars(t, {
      staffUserId: teacherA,
      scholarIds: [scholar],
      institutionId: instA,
    });
    const groupId = await seedGroupWithRoster(t, teacherA, [scholar]);
    const asA = await asUser(t, teacherA);

    const result = await asA.query(api.metaChat.groupPrepControl, { groupId });
    expect(result).toEqual({ participates: false, window: null });
  });

  test("a wholly-foreign group throws", async () => {
    const t = convexTest(schema, modules);
    const instA = await seedTestInstitution(t, { slug: "school-a" });
    const instB = await seedTestInstitution(t, { slug: "school-b" });
    const teacherA = await seedUser(t, "teacher", { username: "teacherA" });
    await grantInstitutionMembership(t, teacherA, instA);
    const teacherB = await seedUser(t, "teacher", { username: "teacherB" });
    await grantInstitutionMembership(t, teacherB, instB);
    const scholarB = await seedUser(t, "scholar", { username: "scholarB" });
    await grantStaffAccessToScholars(t, {
      staffUserId: teacherB,
      scholarIds: [scholarB],
      institutionId: instB,
    });
    const foreignGroupId = await seedGroupWithRoster(t, teacherB, [scholarB]);
    const asA = await asUser(t, teacherA);

    await expect(
      asA.query(api.metaChat.groupPrepControl, { groupId: foreignGroupId }),
    ).rejects.toThrow(/forbidden/i);
  });

  test("an empty group returns its existing (non-participating) shape", async () => {
    const t = convexTest(schema, modules);
    const teacherA = await seedUser(t, "teacher", { username: "teacherA" });
    const emptyGroupId = await seedGroupWithRoster(t, teacherA, []);
    const asA = await asUser(t, teacherA);

    const result = await asA.query(api.metaChat.groupPrepControl, {
      groupId: emptyGroupId,
    });
    expect(result).toEqual({ participates: false, window: null });
  });

  test("a missing group still returns null", async () => {
    const t = convexTest(schema, modules);
    const teacherA = await seedUser(t, "teacher", { username: "teacherA" });
    const groupId = await seedGroupWithRoster(t, teacherA, []);
    await t.run(async (ctx) => ctx.db.delete(groupId));
    const asA = await asUser(t, teacherA);

    const result = await asA.query(api.metaChat.groupPrepControl, { groupId });
    expect(result).toBeNull();
  });
});

// ── assignmentId write key (the #3559 follow-up: an accessible local group
// combined with a foreign assignmentId) ────────────────────────────────────
//
// `placeClass`/`placeHomework`/`cascadeUnit` accept a client-supplied
// `assignmentId` that's stored on the placement (and, for cascadeUnit, used
// to fetch the assignment's unit + activities) without #3559's groupId/
// teacherId checks ever touching it. `requireAssignmentAccessible` closes
// that gap; direct unit coverage for the helper itself lives in
// convex/lib/__tests__/access.test.ts. These tests exercise it through the
// real handlers so the end-to-end write path (not just the pure guard) is
// covered, and prove rejection happens BEFORE any placement/assignment write.

async function seedUnitWithActivity(
  t: ReturnType<typeof convexTest>,
  teacherId: Id<"users">,
  institutionId?: Id<"institutions">,
) {
  return await t.run(async (ctx) => {
    const unitId = await ctx.db.insert("units", {
      teacherId,
      institutionId,
      title: "Fractions",
      isActive: true,
    });
    const lessonId = await ctx.db.insert("lessons", { unitId, title: "L", order: 0 });
    const activityId = await ctx.db.insert("activities", {
      lessonId,
      title: "Act",
      kind: "online",
      systemPrompt: "...",
      order: 0,
    });
    return { unitId, activityId };
  });
}

async function seedAssignmentRow(
  t: ReturnType<typeof convexTest>,
  teacherId: Id<"users">,
  overrides: {
    scholarGroupId?: Id<"scholarGroups">;
    unitId?: Id<"units">;
    scholarIds?: Id<"users">[];
    archivedAt?: number;
  } = {},
) {
  return await t.run(async (ctx) =>
    ctx.db.insert("assignments", {
      teacherId,
      scholarIds: overrides.scholarIds ?? [],
      scholarGroupId: overrides.scholarGroupId,
      unitId: overrides.unitId,
      archivedAt: overrides.archivedAt,
      startedAt: Date.now(),
      activitySchedule: [],
    }),
  );
}

const placementCount = async (t: ReturnType<typeof convexTest>) =>
  (await t.run((ctx) => ctx.db.query("schedulePlacements").collect())).length;

describe("assignmentId write key: masterSchedule.placeClass", () => {
  test("a foreign assignment throws even when the group is local, before any placement is written", async () => {
    const t = convexTest(schema, modules);
    const instA = await seedTestInstitution(t, { slug: "school-a" });
    const instB = await seedTestInstitution(t, { slug: "school-b" });
    const teacherA = await seedUser(t, "teacher", { username: "teacherA" });
    await grantInstitutionMembership(t, teacherA, instA);
    const teacherB = await seedUser(t, "teacher", { username: "teacherB" });
    await grantInstitutionMembership(t, teacherB, instB);
    const scholarB = await seedUser(t, "scholar", { username: "scholarB" });
    await grantStaffAccessToScholars(t, {
      staffUserId: teacherB,
      scholarIds: [scholarB],
      institutionId: instB,
    });
    const localGroupId = await seedGroupWithRoster(t, teacherA, []);
    const foreignAssignmentId = await seedAssignmentRow(t, teacherB, {
      scholarIds: [scholarB],
    });
    const periodId = await seedPeriod(t);
    const asA = await asUser(t, teacherA);

    await expect(
      asA.mutation(api.masterSchedule.placeClass, {
        periodId,
        groupId: localGroupId,
        subject: "Math",
        assignmentId: foreignAssignmentId,
      }),
    ).rejects.toThrow(/forbidden/i);
    expect(await placementCount(t)).toBe(0);
    // Not just no NEW row — the foreign assignment itself was never touched.
    const foreign = await t.run((ctx) => ctx.db.get(foreignAssignmentId));
    expect(foreign?.scholarIds).toEqual([scholarB]);
  });

  test("a same-institution colleague's assignment succeeds", async () => {
    const t = convexTest(schema, modules);
    const instA = await seedTestInstitution(t, { slug: "school-a" });
    const teacherA = await seedUser(t, "teacher", { username: "teacherA" });
    await grantInstitutionMembership(t, teacherA, instA);
    const colleagueA = await seedUser(t, "teacher", { username: "teacherA2" });
    await grantInstitutionMembership(t, colleagueA, instA);
    const scholarA = await seedUser(t, "scholar", { username: "scholarA" });
    await grantStaffAccessToScholars(t, {
      staffUserId: teacherA,
      scholarIds: [scholarA],
      institutionId: instA,
    });
    const groupId = await seedGroupWithRoster(t, teacherA, [scholarA]);
    // Owned by the COLLEAGUE, not the caller — masterSchedule deliberately
    // supports naming a colleague's assignment.
    const assignmentId = await seedAssignmentRow(t, colleagueA, {
      scholarIds: [scholarA],
    });
    const periodId = await seedPeriod(t);
    const asA = await asUser(t, teacherA);

    const placementId = await asA.mutation(api.masterSchedule.placeClass, {
      periodId,
      groupId,
      subject: "Math",
      assignmentId,
    });
    expect(placementId).toBeTruthy();
    const row = await t.run((ctx) => ctx.db.get(placementId));
    expect(row?.assignmentId).toBe(assignmentId);
  });

  test("platform_admin passes with a foreign group AND a foreign assignment", async () => {
    const t = convexTest(schema, modules);
    const instB = await seedTestInstitution(t, { slug: "school-b" });
    const teacherB = await seedUser(t, "teacher", { username: "teacherB" });
    await grantInstitutionMembership(t, teacherB, instB);
    const scholarB = await seedUser(t, "scholar", { username: "scholarB" });
    await grantStaffAccessToScholars(t, {
      staffUserId: teacherB,
      scholarIds: [scholarB],
      institutionId: instB,
    });
    const foreignGroupId = await seedGroupWithRoster(t, teacherB, [scholarB]);
    const foreignAssignmentId = await seedAssignmentRow(t, teacherB, {
      scholarIds: [scholarB],
    });
    const admin = await seedUser(t, "platform_admin", { username: "admin" });
    const periodId = await seedPeriod(t);
    const asAdmin = await asUser(t, admin);

    const placementId = await asAdmin.mutation(api.masterSchedule.placeClass, {
      periodId,
      groupId: foreignGroupId,
      subject: "Math",
      assignmentId: foreignAssignmentId,
    });
    expect(placementId).toBeTruthy();
  });

  test("an undefined assignmentId is a no-op — the caller's own group is enough", async () => {
    const t = convexTest(schema, modules);
    const teacherA = await seedUser(t, "teacher", { username: "teacherA" });
    const groupId = await seedGroupWithRoster(t, teacherA, []);
    const periodId = await seedPeriod(t);
    const asA = await asUser(t, teacherA);

    const placementId = await asA.mutation(api.masterSchedule.placeClass, {
      periodId,
      groupId,
      subject: "Math",
    });
    expect(placementId).toBeTruthy();
  });
});

describe("assignmentId write key: masterSchedule.placeHomework", () => {
  test("a foreign assignment throws even when the group is local", async () => {
    const t = convexTest(schema, modules);
    const instA = await seedTestInstitution(t, { slug: "school-a" });
    const instB = await seedTestInstitution(t, { slug: "school-b" });
    const teacherA = await seedUser(t, "teacher", { username: "teacherA" });
    await grantInstitutionMembership(t, teacherA, instA);
    const teacherB = await seedUser(t, "teacher", { username: "teacherB" });
    await grantInstitutionMembership(t, teacherB, instB);
    const scholarB = await seedUser(t, "scholar", { username: "scholarB" });
    await grantStaffAccessToScholars(t, {
      staffUserId: teacherB,
      scholarIds: [scholarB],
      institutionId: instB,
    });
    const localGroupId = await seedGroupWithRoster(t, teacherA, []);
    const foreignAssignmentId = await seedAssignmentRow(t, teacherB, {
      scholarIds: [scholarB],
    });
    const periodId = await seedPeriod(t);
    const asA = await asUser(t, teacherA);

    await expect(
      asA.mutation(api.masterSchedule.placeHomework, {
        periodId,
        groupId: localGroupId,
        subject: "Math",
        assignmentId: foreignAssignmentId,
      }),
    ).rejects.toThrow(/forbidden/i);
    expect(await placementCount(t)).toBe(0);
  });

  test("a same-institution colleague's assignment succeeds", async () => {
    const t = convexTest(schema, modules);
    const instA = await seedTestInstitution(t, { slug: "school-a" });
    const teacherA = await seedUser(t, "teacher", { username: "teacherA" });
    await grantInstitutionMembership(t, teacherA, instA);
    const colleagueA = await seedUser(t, "teacher", { username: "teacherA2" });
    await grantInstitutionMembership(t, colleagueA, instA);
    const scholarA = await seedUser(t, "scholar", { username: "scholarA" });
    await grantStaffAccessToScholars(t, {
      staffUserId: teacherA,
      scholarIds: [scholarA],
      institutionId: instA,
    });
    const groupId = await seedGroupWithRoster(t, teacherA, [scholarA]);
    const assignmentId = await seedAssignmentRow(t, colleagueA, {
      scholarIds: [scholarA],
    });
    const periodId = await seedPeriod(t);
    const asA = await asUser(t, teacherA);

    const placementId = await asA.mutation(api.masterSchedule.placeHomework, {
      periodId,
      groupId,
      subject: "Math",
      assignmentId,
    });
    expect(placementId).toBeTruthy();
  });
});

// ── activityId auto-provision (no assignmentId, an owner set): placeClass /
// placeHomework both auto-ensure a NEW local assignment against the
// activity's OWN unit (ensureAssignmentForGroupUnit) when no assignmentId is
// supplied. A foreign activityId reaches the exact same escape as a foreign
// assignmentId/unitId — just one derivation hop further away.
describe("activityId auto-provision write key: masterSchedule.placeClass / placeHomework", () => {
  async function seedUnitWithActivityIn(
    t: ReturnType<typeof convexTest>,
    teacherId: Id<"users">,
    institutionId: Id<"institutions">,
  ) {
    const { activityId } = await seedUnitWithActivity(t, teacherId, institutionId);
    return activityId;
  }

  test("placeClass: a foreign activityId throws before any assignment/placement is written", async () => {
    const t = convexTest(schema, modules);
    const instA = await seedTestInstitution(t, { slug: "school-a" });
    const instB = await seedTestInstitution(t, { slug: "school-b" });
    const teacherA = await seedUser(t, "teacher", { username: "teacherA" });
    await grantInstitutionMembership(t, teacherA, instA);
    const teacherB = await seedUser(t, "teacher", { username: "teacherB" });
    await grantInstitutionMembership(t, teacherB, instB);
    const groupId = await seedGroupWithRoster(t, teacherA, []);
    const periodId = await seedPeriod(t);
    const asA = await asUser(t, teacherA);
    const foreignActivityId = await seedUnitWithActivityIn(t, teacherB, instB);

    await expect(
      asA.mutation(api.masterSchedule.placeClass, {
        periodId,
        groupId,
        subject: "Math",
        activityId: foreignActivityId,
      }),
    ).rejects.toThrow(/forbidden/i);
    expect(await placementCount(t)).toBe(0);
    const assignments = await t.run((ctx) => ctx.db.query("assignments").collect());
    expect(assignments).toHaveLength(0);
  });

  test("placeClass: a same-institution activityId succeeds", async () => {
    const t = convexTest(schema, modules);
    const instA = await seedTestInstitution(t, { slug: "school-a" });
    const teacherA = await seedUser(t, "teacher", { username: "teacherA" });
    await grantInstitutionMembership(t, teacherA, instA);
    const groupId = await seedGroupWithRoster(t, teacherA, []);
    const periodId = await seedPeriod(t);
    const asA = await asUser(t, teacherA);
    const activityId = await seedUnitWithActivityIn(t, teacherA, instA);

    const placementId = await asA.mutation(api.masterSchedule.placeClass, {
      periodId,
      groupId,
      subject: "Math",
      activityId,
    });
    expect(placementId).toBeTruthy();
  });

  test("placeHomework: a foreign activityId throws only once teacherId (the owner) is supplied", async () => {
    const t = convexTest(schema, modules);
    const instA = await seedTestInstitution(t, { slug: "school-a" });
    const instB = await seedTestInstitution(t, { slug: "school-b" });
    const teacherA = await seedUser(t, "teacher", { username: "teacherA" });
    await grantInstitutionMembership(t, teacherA, instA);
    const teacherB = await seedUser(t, "teacher", { username: "teacherB" });
    await grantInstitutionMembership(t, teacherB, instB);
    const groupId = await seedGroupWithRoster(t, teacherA, []);
    const periodId = await seedPeriod(t);
    const asA = await asUser(t, teacherA);
    const foreignActivityId = await seedUnitWithActivityIn(t, teacherB, instB);

    await expect(
      asA.mutation(api.masterSchedule.placeHomework, {
        periodId,
        groupId,
        subject: "Math",
        activityId: foreignActivityId,
        teacherId: teacherA,
      }),
    ).rejects.toThrow(/forbidden/i);
  });
});

describe("required assignmentId write key: masterSchedule.cascadeUnit", () => {
  async function seedBlock(
    t: ReturnType<typeof convexTest>,
    asTeacher: Awaited<ReturnType<typeof asUser>>,
    periodId: Id<"reportingPeriods">,
  ) {
    return await asTeacher.mutation(api.masterSchedule.createBlock, {
      periodId,
      label: "A",
      startLocal: "08:30",
      endLocal: "09:40",
    });
  }

  test("a foreign assignment throws before any placement or assignment write", async () => {
    const t = convexTest(schema, modules);
    const instA = await seedTestInstitution(t, { slug: "school-a" });
    const instB = await seedTestInstitution(t, { slug: "school-b" });
    const teacherA = await seedUser(t, "teacher", { username: "teacherA" });
    await grantInstitutionMembership(t, teacherA, instA);
    const teacherB = await seedUser(t, "teacher", { username: "teacherB" });
    await grantInstitutionMembership(t, teacherB, instB);
    const scholarB = await seedUser(t, "scholar", { username: "scholarB" });
    await grantStaffAccessToScholars(t, {
      staffUserId: teacherB,
      scholarIds: [scholarB],
      institutionId: instB,
    });
    const localGroupId = await seedGroupWithRoster(t, teacherA, []);
    const periodId = await seedPeriod(t);
    const asA = await asUser(t, teacherA);
    const blockId = await seedBlock(t, asA, periodId);
    // The foreign assignment carries a real unit — this is exactly the
    // exploit shape: naming a foreign unit's assignment from a local group
    // would otherwise cascade that unit's activities onto the local grid.
    const { unitId: foreignUnitId } = await seedUnitWithActivity(t, teacherB, instB);
    const foreignAssignmentId = await seedAssignmentRow(t, teacherB, {
      unitId: foreignUnitId,
      scholarIds: [scholarB],
    });

    await expect(
      asA.mutation(api.masterSchedule.cascadeUnit, {
        periodId,
        groupId: localGroupId,
        assignmentId: foreignAssignmentId,
        startWeekday: 1,
        startBlockId: blockId,
      }),
    ).rejects.toThrow(/forbidden/i);
    expect(await placementCount(t)).toBe(0);
  });

  test("a same-institution colleague's assignment succeeds", async () => {
    const t = convexTest(schema, modules);
    const instA = await seedTestInstitution(t, { slug: "school-a" });
    const teacherA = await seedUser(t, "teacher", { username: "teacherA" });
    await grantInstitutionMembership(t, teacherA, instA);
    const colleagueA = await seedUser(t, "teacher", { username: "teacherA2" });
    await grantInstitutionMembership(t, colleagueA, instA);
    const scholarA = await seedUser(t, "scholar", { username: "scholarA" });
    await grantStaffAccessToScholars(t, {
      staffUserId: teacherA,
      scholarIds: [scholarA],
      institutionId: instA,
    });
    const groupId = await seedGroupWithRoster(t, teacherA, [scholarA]);
    const periodId = await seedPeriod(t);
    const asA = await asUser(t, teacherA);
    const blockId = await seedBlock(t, asA, periodId);
    const { unitId } = await seedUnitWithActivity(t, colleagueA, instA);
    const assignmentId = await seedAssignmentRow(t, colleagueA, {
      unitId,
      scholarIds: [scholarA],
    });

    const result = await asA.mutation(api.masterSchedule.cascadeUnit, {
      periodId,
      groupId,
      assignmentId,
      startWeekday: 1,
      startBlockId: blockId,
    });
    expect(result.placementIds.length).toBeGreaterThan(0);
  });

  test("platform_admin passes with a foreign group AND a foreign assignment", async () => {
    const t = convexTest(schema, modules);
    const instB = await seedTestInstitution(t, { slug: "school-b" });
    const teacherB = await seedUser(t, "teacher", { username: "teacherB" });
    await grantInstitutionMembership(t, teacherB, instB);
    const scholarB = await seedUser(t, "scholar", { username: "scholarB" });
    await grantStaffAccessToScholars(t, {
      staffUserId: teacherB,
      scholarIds: [scholarB],
      institutionId: instB,
    });
    const foreignGroupId = await seedGroupWithRoster(t, teacherB, [scholarB]);
    const admin = await seedUser(t, "platform_admin", { username: "admin" });
    const periodId = await seedPeriod(t);
    const asAdmin = await asUser(t, admin);
    const blockId = await seedBlock(t, asAdmin, periodId);
    const { unitId } = await seedUnitWithActivity(t, teacherB, instB);
    const foreignAssignmentId = await seedAssignmentRow(t, teacherB, {
      unitId,
      scholarIds: [scholarB],
    });

    const result = await asAdmin.mutation(api.masterSchedule.cascadeUnit, {
      periodId,
      groupId: foreignGroupId,
      assignmentId: foreignAssignmentId,
      startWeekday: 1,
      startBlockId: blockId,
    });
    expect(result.placementIds.length).toBeGreaterThan(0);
  });

  test("a missing assignment surfaces the core's own 'not found', not a Forbidden", async () => {
    const t = convexTest(schema, modules);
    const teacherA = await seedUser(t, "teacher", { username: "teacherA" });
    const groupId = await seedGroupWithRoster(t, teacherA, []);
    const periodId = await seedPeriod(t);
    const asA = await asUser(t, teacherA);
    const blockId = await seedBlock(t, asA, periodId);
    const assignmentId = await seedAssignmentRow(t, teacherA);
    await t.run((ctx) => ctx.db.delete(assignmentId));

    await expect(
      asA.mutation(api.masterSchedule.cascadeUnit, {
        periodId,
        groupId,
        assignmentId,
        startWeekday: 1,
        startBlockId: blockId,
      }),
    ).rejects.toThrow(/assignment not found/i);
  });

  test("an empty-roster ad-hoc assignment from a different institution's teacher still passes (nothing to leak)", async () => {
    const t = convexTest(schema, modules);
    const instA = await seedTestInstitution(t, { slug: "school-a" });
    const instB = await seedTestInstitution(t, { slug: "school-b" });
    const teacherA = await seedUser(t, "teacher", { username: "teacherA" });
    await grantInstitutionMembership(t, teacherA, instA);
    const teacherB = await seedUser(t, "teacher", { username: "teacherB" });
    await grantInstitutionMembership(t, teacherB, instB);
    const groupId = await seedGroupWithRoster(t, teacherA, []);
    const periodId = await seedPeriod(t);
    const asA = await asUser(t, teacherA);
    const blockId = await seedBlock(t, asA, periodId);
    const { unitId } = await seedUnitWithActivity(t, teacherA, instA);
    // No scholarGroupId, no scholars — only the (LOCAL) unit resolves an
    // institution, so this is decidable and local; the case with truly no
    // signal at all is covered directly in access.test.ts.
    const assignmentId = await seedAssignmentRow(t, teacherB, { unitId });

    const result = await asA.mutation(api.masterSchedule.cascadeUnit, {
      periodId,
      groupId,
      assignmentId,
      startWeekday: 1,
      startBlockId: blockId,
    });
    expect(result.placementIds.length).toBeGreaterThan(0);
  });

  test("an archived local assignment is not newly rejected by the guard", async () => {
    const t = convexTest(schema, modules);
    const instA = await seedTestInstitution(t, { slug: "school-a" });
    const teacherA = await seedUser(t, "teacher", { username: "teacherA" });
    await grantInstitutionMembership(t, teacherA, instA);
    const scholarA = await seedUser(t, "scholar", { username: "scholarA" });
    await grantStaffAccessToScholars(t, {
      staffUserId: teacherA,
      scholarIds: [scholarA],
      institutionId: instA,
    });
    const groupId = await seedGroupWithRoster(t, teacherA, [scholarA]);
    const periodId = await seedPeriod(t);
    const asA = await asUser(t, teacherA);
    const blockId = await seedBlock(t, asA, periodId);
    const { unitId } = await seedUnitWithActivity(t, teacherA, instA);
    const assignmentId = await seedAssignmentRow(t, teacherA, {
      unitId,
      scholarIds: [scholarA],
      archivedAt: Date.now(),
    });

    // Pre-existing (unrelated to this guard) behavior: coreCascadeUnit itself
    // doesn't reject an archived assignment. The guard must not add a NEW
    // rejection here — it should pass the institution check and let whatever
    // happens next be exactly what happened before this PR.
    const result = await asA.mutation(api.masterSchedule.cascadeUnit, {
      periodId,
      groupId,
      assignmentId,
      startWeekday: 1,
      startBlockId: blockId,
    });
    expect(result.placementIds.length).toBeGreaterThan(0);
  });
});

// ── client-supplied unitId: masterSchedule.cascadeUnitForGroup ─────────────
//
// Unlike cascadeUnit, this handler derives its assignmentId server-side (via
// ensureAssignmentForGroupUnit) rather than accepting one from the client —
// but it takes a client-supplied `unitId` directly, which reaches the SAME
// underlying escape: ensureAssignmentForGroupUnit will happily provision a
// LOCAL assignment against a FOREIGN institution's curriculum unit, and
// coreCascadeUnit then materializes that foreign unit's activities as real
// placements. Guarded with the same `requireUnitAccess` boundary every other
// curriculum surface (activities.ts, lessons.ts, units.ts) already uses.
describe("client-supplied unitId: masterSchedule.cascadeUnitForGroup", () => {
  async function seedBlock(
    asTeacher: Awaited<ReturnType<typeof asUser>>,
    periodId: Id<"reportingPeriods">,
  ) {
    return await asTeacher.mutation(api.masterSchedule.createBlock, {
      periodId,
      label: "A",
      startLocal: "08:30",
      endLocal: "09:40",
    });
  }

  test("a foreign unit throws before any assignment or placement is written", async () => {
    const t = convexTest(schema, modules);
    const instA = await seedTestInstitution(t, { slug: "school-a" });
    const instB = await seedTestInstitution(t, { slug: "school-b" });
    const teacherA = await seedUser(t, "teacher", { username: "teacherA" });
    await grantInstitutionMembership(t, teacherA, instA);
    const teacherB = await seedUser(t, "teacher", { username: "teacherB" });
    await grantInstitutionMembership(t, teacherB, instB);
    const groupId = await seedGroupWithRoster(t, teacherA, []);
    const periodId = await seedPeriod(t);
    const asA = await asUser(t, teacherA);
    const blockId = await seedBlock(asA, periodId);
    const { unitId: foreignUnitId } = await seedUnitWithActivity(t, teacherB, instB);

    await expect(
      asA.mutation(api.masterSchedule.cascadeUnitForGroup, {
        periodId,
        groupId,
        unitId: foreignUnitId,
        startWeekday: 1,
        startBlockId: blockId,
      }),
    ).rejects.toThrow(/forbidden/i);
    expect(await placementCount(t)).toBe(0);
    const assignments = await t.run((ctx) => ctx.db.query("assignments").collect());
    expect(assignments.filter((a) => a.unitId === foreignUnitId)).toHaveLength(0);
  });

  test("a same-institution unit succeeds", async () => {
    const t = convexTest(schema, modules);
    const instA = await seedTestInstitution(t, { slug: "school-a" });
    const teacherA = await seedUser(t, "teacher", { username: "teacherA" });
    await grantInstitutionMembership(t, teacherA, instA);
    const scholarA = await seedUser(t, "scholar", { username: "scholarA" });
    await grantStaffAccessToScholars(t, {
      staffUserId: teacherA,
      scholarIds: [scholarA],
      institutionId: instA,
    });
    const groupId = await seedGroupWithRoster(t, teacherA, [scholarA]);
    const periodId = await seedPeriod(t);
    const asA = await asUser(t, teacherA);
    const blockId = await seedBlock(asA, periodId);
    const { unitId } = await seedUnitWithActivity(t, teacherA, instA);

    const result = await asA.mutation(api.masterSchedule.cascadeUnitForGroup, {
      periodId,
      groupId,
      unitId,
      startWeekday: 1,
      startBlockId: blockId,
    });
    expect(result.placementIds.length).toBeGreaterThan(0);
  });

  test("an unstamped (legacy) unit succeeds for the PRIMARY institution's teacher, throws for anyone else", async () => {
    const t = convexTest(schema, modules);
    const instPrimary = await seedTestInstitution(t, {
      slug: "school-primary",
      isPrimary: true,
    });
    const instB = await seedTestInstitution(t, { slug: "school-b" });
    const primaryTeacher = await seedUser(t, "teacher", { username: "teacherPrimary" });
    await grantInstitutionMembership(t, primaryTeacher, instPrimary);
    const nonPrimaryTeacher = await seedUser(t, "teacher", { username: "teacherB" });
    await grantInstitutionMembership(t, nonPrimaryTeacher, instB);
    const { unitId: unstampedUnitId } = await seedUnitWithActivity(
      t,
      primaryTeacher,
      undefined,
    );
    const periodId = await seedPeriod(t);

    const primaryGroupId = await seedGroupWithRoster(t, primaryTeacher, []);
    const asPrimary = await asUser(t, primaryTeacher);
    const primaryBlockId = await seedBlock(asPrimary, periodId);
    const primaryResult = await asPrimary.mutation(api.masterSchedule.cascadeUnitForGroup, {
      periodId,
      groupId: primaryGroupId,
      unitId: unstampedUnitId,
      startWeekday: 1,
      startBlockId: primaryBlockId,
    });
    expect(primaryResult.placementIds.length).toBeGreaterThan(0);

    const otherGroupId = await seedGroupWithRoster(t, nonPrimaryTeacher, []);
    const asOther = await asUser(t, nonPrimaryTeacher);
    const otherBlockId = await seedBlock(asOther, periodId);
    await expect(
      asOther.mutation(api.masterSchedule.cascadeUnitForGroup, {
        periodId,
        groupId: otherGroupId,
        unitId: unstampedUnitId,
        startWeekday: 1,
        startBlockId: otherBlockId,
      }),
    ).rejects.toThrow(/forbidden/i);
  });

  test("platform_admin passes with a foreign group AND a foreign unit", async () => {
    const t = convexTest(schema, modules);
    const instB = await seedTestInstitution(t, { slug: "school-b" });
    const teacherB = await seedUser(t, "teacher", { username: "teacherB" });
    await grantInstitutionMembership(t, teacherB, instB);
    const scholarB = await seedUser(t, "scholar", { username: "scholarB" });
    await grantStaffAccessToScholars(t, {
      staffUserId: teacherB,
      scholarIds: [scholarB],
      institutionId: instB,
    });
    const foreignGroupId = await seedGroupWithRoster(t, teacherB, [scholarB]);
    const admin = await seedUser(t, "platform_admin", { username: "admin" });
    const periodId = await seedPeriod(t);
    const asAdmin = await asUser(t, admin);
    const blockId = await seedBlock(asAdmin, periodId);
    const { unitId: foreignUnitId } = await seedUnitWithActivity(t, teacherB, instB);

    const result = await asAdmin.mutation(api.masterSchedule.cascadeUnitForGroup, {
      periodId,
      groupId: foreignGroupId,
      unitId: foreignUnitId,
      startWeekday: 1,
      startBlockId: blockId,
    });
    expect(result.placementIds.length).toBeGreaterThan(0);
  });
});

async function seedOwnedSchedule(
  t: ReturnType<typeof convexTest>,
  args: {
    institutionId: Id<"institutions">;
    teacherId: Id<"users">;
    scholarId: Id<"users">;
    sequenceId?: string;
  },
) {
  await grantStaffAccessToScholars(t, {
    staffUserId: args.teacherId,
    scholarIds: [args.scholarId],
    institutionId: args.institutionId,
  });
  const periodId = await seedPeriod(t, args.institutionId);
  const groupId = await seedGroupWithRoster(t, args.teacherId, [args.scholarId]);
  return await t.run(async (ctx) => {
    const blockId = await ctx.db.insert("scheduleBlocks", {
      periodId,
      key: `block-${args.sequenceId ?? "single"}`,
      label: "Block A",
      startLocal: "08:30",
      endLocal: "09:40",
      weekdays: [1, 2, 3, 4, 5],
      order: 0,
    });
    const placementId = await ctx.db.insert("schedulePlacements", {
      periodId,
      groupId,
      subject: "Mathematics",
      teacherId: args.teacherId,
      weekday: 1,
      blockId,
      weekStartMs: Date.now() + 28 * DAY,
      sequenceId: args.sequenceId,
      sequenceIndex: args.sequenceId ? 0 : undefined,
    });
    return { periodId, groupId, blockId, placementId };
  });
}

describe("resolved Master Schedule row ownership", () => {
  test("a foreign teacher cannot mutate block or placement ids, including a foreign target block", async () => {
    const t = convexTest(schema, modules);
    const instA = await seedTestInstitution(t, { slug: "schedule-school-a" });
    const instB = await seedTestInstitution(t, { slug: "schedule-school-b" });
    const teacherA = await seedUser(t, "teacher", { username: "schedule-teacher-a" });
    const teacherB = await seedUser(t, "teacher", { username: "schedule-teacher-b" });
    const scholarA = await seedUser(t, "scholar", { username: "schedule-scholar-a" });
    const scholarB = await seedUser(t, "scholar", { username: "schedule-scholar-b" });
    const scheduleA = await seedOwnedSchedule(t, {
      institutionId: instA,
      teacherId: teacherA,
      scholarId: scholarA,
    });
    const scheduleB = await seedOwnedSchedule(t, {
      institutionId: instB,
      teacherId: teacherB,
      scholarId: scholarB,
    });
    const { unitId: unitA, activityId: activityA } =
      await seedUnitWithActivity(t, teacherA, instA);
    const assignmentA = await seedAssignmentRow(t, teacherA, {
      unitId: unitA,
      scholarIds: [scholarA],
    });
    const asB = await asUser(t, teacherB);

    await expect(
      asB.mutation(api.masterSchedule.updateBlock, {
        blockId: scheduleA.blockId,
        label: "Changed",
      }),
    ).rejects.toThrow(/forbidden/i);
    await expect(
      asB.mutation(api.masterSchedule.removeBlock, {
        blockId: scheduleA.blockId,
      }),
    ).rejects.toThrow(/forbidden/i);
    await expect(
      asB.mutation(api.masterSchedule.updatePlacement, {
        placementId: scheduleA.placementId,
        subject: "Changed",
      }),
    ).rejects.toThrow(/forbidden/i);
    await expect(
      asB.mutation(api.masterSchedule.movePlacement, {
        placementId: scheduleA.placementId,
        weekday: null,
        blockId: null,
      }),
    ).rejects.toThrow(/forbidden/i);
    await expect(
      asB.mutation(api.masterSchedule.shiftPlacement, {
        placementId: scheduleA.placementId,
        deltaDays: 1,
      }),
    ).rejects.toThrow(/forbidden/i);
    await expect(
      asB.mutation(api.masterSchedule.removePlacement, {
        placementId: scheduleA.placementId,
      }),
    ).rejects.toThrow(/forbidden/i);
    await expect(
      asB.mutation(api.masterSchedule.movePlacement, {
        placementId: scheduleB.placementId,
        weekday: 2,
        blockId: scheduleA.blockId,
      }),
    ).rejects.toThrow(/forbidden/i);
    await expect(
      asB.mutation(api.masterSchedule.updatePlacement, {
        placementId: scheduleB.placementId,
        assignmentId: assignmentA,
      }),
    ).rejects.toThrow(/forbidden/i);
    await expect(
      asB.mutation(api.masterSchedule.updatePlacement, {
        placementId: scheduleB.placementId,
        activityId: activityA,
      }),
    ).rejects.toThrow(/forbidden/i);

    const [blockA, placementA, placementB] = await t.run(async (ctx) =>
      Promise.all([
        ctx.db.get(scheduleA.blockId),
        ctx.db.get(scheduleA.placementId),
        ctx.db.get(scheduleB.placementId),
      ]),
    );
    expect(blockA?.label).toBe("Block A");
    expect(placementA?.subject).toBe("Mathematics");
    expect(placementA?.weekday).toBe(1);
    expect(placementB?.blockId).toBe(scheduleB.blockId);
  });

  test("an empty foreign group is still denied by its stamped group and period", async () => {
    const t = convexTest(schema, modules);
    const instA = await seedTestInstitution(t, { slug: "empty-group-school-a" });
    const instB = await seedTestInstitution(t, { slug: "empty-group-school-b" });
    const teacherA = await seedUser(t, "teacher", {
      username: "empty-group-teacher-a",
    });
    const teacherB = await seedUser(t, "teacher", {
      username: "empty-group-teacher-b",
    });
    await grantInstitutionMembership(t, teacherA, instA);
    await grantInstitutionMembership(t, teacherB, instB);
    const periodId = await seedPeriod(t, instA);
    const groupId = await t.run((ctx) =>
      ctx.db.insert("scholarGroups", {
        teacherId: teacherA,
        institutionId: instA,
        name: "Empty Group",
        scholarIds: [],
      }),
    );
    const placementId = await t.run((ctx) =>
      ctx.db.insert("schedulePlacements", {
        periodId,
        groupId,
        subject: "Mathematics",
      }),
    );
    const asB = await asUser(t, teacherB);

    await expect(
      asB.mutation(api.masterSchedule.updatePlacement, {
        placementId,
        subject: "Changed",
      }),
    ).rejects.toThrow(/forbidden/i);
  });

  test("the owning institution and platform admin can still mutate schedule rows", async () => {
    const t = convexTest(schema, modules);
    const instA = await seedTestInstitution(t, { slug: "schedule-owner-school" });
    const teacherA = await seedUser(t, "teacher", {
      username: "schedule-owner-teacher",
    });
    const scholarA = await seedUser(t, "scholar", {
      username: "schedule-owner-scholar",
    });
    const scheduleA = await seedOwnedSchedule(t, {
      institutionId: instA,
      teacherId: teacherA,
      scholarId: scholarA,
    });
    const admin = await seedUser(t, "platform_admin", {
      username: "schedule-platform-admin",
    });
    const asA = await asUser(t, teacherA);
    const asAdmin = await asUser(t, admin);

    await asA.mutation(api.masterSchedule.updateBlock, {
      blockId: scheduleA.blockId,
      label: "Owner changed",
    });
    await asA.mutation(api.masterSchedule.updatePlacement, {
      placementId: scheduleA.placementId,
      subject: "Owner subject",
    });
    await asAdmin.mutation(api.masterSchedule.updateBlock, {
      blockId: scheduleA.blockId,
      label: "Admin changed",
    });
    await asAdmin.mutation(api.masterSchedule.updatePlacement, {
      placementId: scheduleA.placementId,
      subject: "Admin subject",
    });

    const [block, placement] = await t.run(async (ctx) =>
      Promise.all([
        ctx.db.get(scheduleA.blockId),
        ctx.db.get(scheduleA.placementId),
      ]),
    );
    expect(block?.label).toBe("Admin changed");
    expect(placement?.subject).toBe("Admin subject");
  });
});

describe("sequence and flag ownership", () => {
  test("a foreign teacher cannot mutate any sequence or flag operation", async () => {
    const t = convexTest(schema, modules);
    const instA = await seedTestInstitution(t, { slug: "sequence-school-a" });
    const instB = await seedTestInstitution(t, { slug: "sequence-school-b" });
    const teacherA = await seedUser(t, "teacher", { username: "sequence-teacher-a" });
    const teacherB = await seedUser(t, "teacher", { username: "sequence-teacher-b" });
    const scholarA = await seedUser(t, "scholar", { username: "sequence-scholar-a" });
    const scheduleA = await seedOwnedSchedule(t, {
      institutionId: instA,
      teacherId: teacherA,
      scholarId: scholarA,
      sequenceId: "foreign-sequence",
    });
    await grantInstitutionMembership(t, teacherB, instB);
    const asB = await asUser(t, teacherB);

    await expect(
      asB.mutation(api.masterSchedule.acceptReorder, {
        sequenceId: "foreign-sequence",
      }),
    ).rejects.toThrow(/forbidden/i);
    await expect(
      asB.mutation(api.masterSchedule.moveSequence, {
        sequenceId: "foreign-sequence",
        deltaDays: 1,
      }),
    ).rejects.toThrow(/forbidden/i);
    await expect(
      asB.mutation(api.masterSchedule.reflowSequence, {
        sequenceId: "foreign-sequence",
        fromIndex: 0,
      }),
    ).rejects.toThrow(/forbidden/i);
    await expect(
      asB.mutation(api.masterSchedule.dismissFlag, {
        placementIds: [scheduleA.placementId],
        flagId: "slot:foreign",
      }),
    ).rejects.toThrow(/forbidden/i);

    const placement = await t.run((ctx) => ctx.db.get(scheduleA.placementId));
    expect(placement?.orderOverride).toBeUndefined();
    expect(placement?.weekday).toBe(1);
    expect(placement?.dismissedFlags).toBeUndefined();
  });

  test("every affected placement is checked before sequence or flag writes begin", async () => {
    const t = convexTest(schema, modules);
    const instA = await seedTestInstitution(t, { slug: "mixed-sequence-a" });
    const instB = await seedTestInstitution(t, { slug: "mixed-sequence-b" });
    const teacherA = await seedUser(t, "teacher", { username: "mixed-teacher-a" });
    const teacherB = await seedUser(t, "teacher", { username: "mixed-teacher-b" });
    const scholarA = await seedUser(t, "scholar", { username: "mixed-scholar-a" });
    const scholarB = await seedUser(t, "scholar", { username: "mixed-scholar-b" });
    const local = await seedOwnedSchedule(t, {
      institutionId: instA,
      teacherId: teacherA,
      scholarId: scholarA,
      sequenceId: "mixed-sequence",
    });
    const foreign = await seedOwnedSchedule(t, {
      institutionId: instB,
      teacherId: teacherB,
      scholarId: scholarB,
      sequenceId: "mixed-sequence",
    });
    const asA = await asUser(t, teacherA);

    await expect(
      asA.mutation(api.masterSchedule.acceptReorder, {
        sequenceId: "mixed-sequence",
      }),
    ).rejects.toThrow(/forbidden/i);
    await expect(
      asA.mutation(api.masterSchedule.dismissFlag, {
        placementIds: [local.placementId, foreign.placementId],
        flagId: "slot:mixed",
      }),
    ).rejects.toThrow(/forbidden/i);
    await expect(
      asA.mutation(api.masterSchedule.moveSequence, {
        sequenceId: "mixed-sequence",
        deltaDays: 1,
      }),
    ).rejects.toThrow(/forbidden/i);
    await expect(
      asA.mutation(api.masterSchedule.reflowSequence, {
        sequenceId: "mixed-sequence",
        fromIndex: 0,
      }),
    ).rejects.toThrow(/forbidden/i);

    const localPlacement = await t.run((ctx) => ctx.db.get(local.placementId));
    expect(localPlacement?.orderOverride).toBeUndefined();
    expect(localPlacement?.dismissedFlags).toBeUndefined();
    expect(localPlacement?.weekday).toBe(1);
  });

  test("the owning institution and platform admin can still mutate a sequence", async () => {
    const t = convexTest(schema, modules);
    const instA = await seedTestInstitution(t, { slug: "sequence-owner-school" });
    const teacherA = await seedUser(t, "teacher", {
      username: "sequence-owner-teacher",
    });
    const scholarA = await seedUser(t, "scholar", {
      username: "sequence-owner-scholar",
    });
    const scheduleA = await seedOwnedSchedule(t, {
      institutionId: instA,
      teacherId: teacherA,
      scholarId: scholarA,
      sequenceId: "owned-sequence",
    });
    const admin = await seedUser(t, "platform_admin", {
      username: "sequence-admin",
    });
    const asA = await asUser(t, teacherA);
    const asAdmin = await asUser(t, admin);

    expect(
      await asA.mutation(api.masterSchedule.acceptReorder, {
        sequenceId: "owned-sequence",
      }),
    ).toBe(1);
    expect(
      await asAdmin.mutation(api.masterSchedule.dismissFlag, {
        placementIds: [scheduleA.placementId],
        flagId: "slot:admin",
      }),
    ).toBe(1);
  });
});

describe("period-scoped reassignTeacher ownership", () => {
  test("foreign teachers are denied while the owning institution and platform admin still succeed", async () => {
    const t = convexTest(schema, modules);
    const instA = await seedTestInstitution(t, { slug: "reassign-school-a" });
    const instB = await seedTestInstitution(t, { slug: "reassign-school-b" });
    const teacherA = await seedUser(t, "teacher", { username: "reassign-teacher-a" });
    const colleagueA = await seedUser(t, "teacher", {
      username: "reassign-colleague-a",
    });
    const teacherB = await seedUser(t, "teacher", { username: "reassign-teacher-b" });
    const scholarA = await seedUser(t, "scholar", { username: "reassign-scholar-a" });
    const scheduleA = await seedOwnedSchedule(t, {
      institutionId: instA,
      teacherId: teacherA,
      scholarId: scholarA,
    });
    await grantInstitutionMembership(t, colleagueA, instA);
    await grantInstitutionMembership(t, teacherB, instB);
    const admin = await seedUser(t, "platform_admin", {
      username: "reassign-platform-admin",
    });
    const asA = await asUser(t, teacherA);
    const asB = await asUser(t, teacherB);
    const asAdmin = await asUser(t, admin);

    await expect(
      asB.mutation(api.masterSchedule.reassignTeacher, {
        periodId: scheduleA.periodId,
        fromTeacherId: teacherA,
        toTeacherId: null,
      }),
    ).rejects.toThrow(/forbidden/i);

    expect(
      await asA.mutation(api.masterSchedule.reassignTeacher, {
        periodId: scheduleA.periodId,
        fromTeacherId: teacherA,
        toTeacherId: colleagueA,
      }),
    ).toMatchObject({ count: 1 });
    expect(
      await asAdmin.mutation(api.masterSchedule.reassignTeacher, {
        periodId: scheduleA.periodId,
        fromTeacherId: colleagueA,
        toTeacherId: teacherA,
      }),
    ).toMatchObject({ count: 1 });
  });

  test("legacy unstamped periods belong to the primary institution", async () => {
    const t = convexTest(schema, modules);
    const primaryInstitution = await seedTestInstitution(t, {
      slug: "legacy-period-primary",
      isPrimary: true,
    });
    const otherInstitution = await seedTestInstitution(t, {
      slug: "legacy-period-other",
    });
    const primaryTeacher = await seedUser(t, "teacher", {
      username: "legacy-period-primary-teacher",
    });
    const otherTeacher = await seedUser(t, "teacher", {
      username: "legacy-period-other-teacher",
    });
    await grantInstitutionMembership(t, primaryTeacher, primaryInstitution);
    await grantInstitutionMembership(t, otherTeacher, otherInstitution);
    const periodId = await seedPeriod(t);
    const blockId = await t.run((ctx) =>
      ctx.db.insert("scheduleBlocks", {
        periodId,
        key: "legacy-shared-block",
        label: "Legacy Shared",
        startLocal: "08:30",
        endLocal: "09:40",
        weekdays: [1, 2, 3, 4, 5],
        order: 0,
      }),
    );
    const asPrimary = await asUser(t, primaryTeacher);
    const asOther = await asUser(t, otherTeacher);

    await expect(
      asOther.mutation(api.masterSchedule.updateBlock, {
        blockId,
        label: "Foreign change",
      }),
    ).rejects.toThrow(/forbidden/i);
    await expect(
      asOther.mutation(api.masterSchedule.reassignTeacher, {
        periodId,
        fromTeacherId: otherTeacher,
        toTeacherId: null,
      }),
    ).rejects.toThrow(/forbidden/i);

    await asPrimary.mutation(api.masterSchedule.updateBlock, {
      blockId,
      label: "Primary change",
    });
    expect(
      await asPrimary.mutation(api.masterSchedule.reassignTeacher, {
        periodId,
        fromTeacherId: primaryTeacher,
        toTeacherId: null,
      }),
    ).toMatchObject({ count: 0 });
    expect((await t.run((ctx) => ctx.db.get(blockId)))?.label).toBe(
      "Primary change",
    );
  });
});

describe("internal aide row ownership", () => {
  test("a foreign teacher cannot mutate block, placement, sequence, or flag rows", async () => {
    const t = convexTest(schema, modules);
    const instA = await seedTestInstitution(t, { slug: "aide-school-a" });
    const instB = await seedTestInstitution(t, { slug: "aide-school-b" });
    const teacherA = await seedUser(t, "teacher", { username: "aide-teacher-a" });
    const teacherB = await seedUser(t, "teacher", { username: "aide-teacher-b" });
    const scholarA = await seedUser(t, "scholar", { username: "aide-scholar-a" });
    const scholarB = await seedUser(t, "scholar", { username: "aide-scholar-b" });
    const scheduleA = await seedOwnedSchedule(t, {
      institutionId: instA,
      teacherId: teacherA,
      scholarId: scholarA,
      sequenceId: "aide-foreign-sequence",
    });
    const scheduleB = await seedOwnedSchedule(t, {
      institutionId: instB,
      teacherId: teacherB,
      scholarId: scholarB,
    });

    await expect(
      t.mutation(internal.masterSchedule.aideUpdateBlock, {
        callerUserId: teacherB,
        blockId: scheduleA.blockId,
        label: "Changed",
      }),
    ).rejects.toThrow(/forbidden/i);
    await expect(
      t.mutation(internal.masterSchedule.aideRemoveBlock, {
        callerUserId: teacherB,
        blockId: scheduleA.blockId,
      }),
    ).rejects.toThrow(/forbidden/i);
    await expect(
      t.mutation(internal.masterSchedule.aideMovePlacement, {
        callerUserId: teacherB,
        placementId: scheduleA.placementId,
        weekday: null,
        blockId: null,
      }),
    ).rejects.toThrow(/forbidden/i);
    await expect(
      t.mutation(internal.masterSchedule.aideMovePlacement, {
        callerUserId: teacherB,
        placementId: scheduleB.placementId,
        weekday: 2,
        blockId: scheduleA.blockId,
      }),
    ).rejects.toThrow(/forbidden/i);
    await expect(
      t.mutation(internal.masterSchedule.aideShiftPlacement, {
        callerUserId: teacherB,
        placementId: scheduleA.placementId,
        deltaDays: 1,
      }),
    ).rejects.toThrow(/forbidden/i);
    await expect(
      t.mutation(internal.masterSchedule.aideRemovePlacement, {
        callerUserId: teacherB,
        placementId: scheduleA.placementId,
      }),
    ).rejects.toThrow(/forbidden/i);
    await expect(
      t.mutation(internal.masterSchedule.aideAcceptReorder, {
        callerUserId: teacherB,
        sequenceId: "aide-foreign-sequence",
      }),
    ).rejects.toThrow(/forbidden/i);
    await expect(
      t.mutation(internal.masterSchedule.aideMoveSequence, {
        callerUserId: teacherB,
        sequenceId: "aide-foreign-sequence",
        deltaDays: 1,
      }),
    ).rejects.toThrow(/forbidden/i);
    await expect(
      t.mutation(internal.masterSchedule.aideReflowSequence, {
        callerUserId: teacherB,
        sequenceId: "aide-foreign-sequence",
        fromIndex: 0,
      }),
    ).rejects.toThrow(/forbidden/i);
    await expect(
      t.mutation(internal.masterSchedule.aideDismissFlag, {
        callerUserId: teacherB,
        placementIds: [scheduleA.placementId],
        flagId: "slot:aide-foreign",
      }),
    ).rejects.toThrow(/forbidden/i);

    const [blockA, placementA, placementB] = await t.run(async (ctx) =>
      Promise.all([
        ctx.db.get(scheduleA.blockId),
        ctx.db.get(scheduleA.placementId),
        ctx.db.get(scheduleB.placementId),
      ]),
    );
    expect(blockA?.label).toBe("Block A");
    expect(placementA?.weekday).toBe(1);
    expect(placementA?.blockId).toBe(scheduleA.blockId);
    expect(placementA?.orderOverride).toBeUndefined();
    expect(placementA?.dismissedFlags).toBeUndefined();
    expect(placementB).toMatchObject({
      weekday: 1,
      blockId: scheduleB.blockId,
    });
  });

  test("a same-institution teacher can use the guarded aide variants", async () => {
    const t = convexTest(schema, modules);
    const instA = await seedTestInstitution(t, { slug: "aide-owner-school" });
    const teacherA = await seedUser(t, "teacher", {
      username: "aide-owner-teacher",
    });
    const scholarA = await seedUser(t, "scholar", {
      username: "aide-owner-scholar",
    });
    const scheduleA = await seedOwnedSchedule(t, {
      institutionId: instA,
      teacherId: teacherA,
      scholarId: scholarA,
      sequenceId: "aide-owned-sequence",
    });

    await t.mutation(internal.masterSchedule.aideUpdateBlock, {
      callerUserId: teacherA,
      blockId: scheduleA.blockId,
      label: "Owner changed",
    });
    expect(
      await t.mutation(internal.masterSchedule.aideShiftPlacement, {
        callerUserId: teacherA,
        placementId: scheduleA.placementId,
        deltaDays: 1,
      }),
    ).toEqual({ ok: true, weekday: 2 });
    expect(
      await t.mutation(internal.masterSchedule.aideAcceptReorder, {
        callerUserId: teacherA,
        sequenceId: "aide-owned-sequence",
      }),
    ).toBe(1);
    expect(
      await t.mutation(internal.masterSchedule.aideDismissFlag, {
        callerUserId: teacherA,
        placementIds: [scheduleA.placementId],
        flagId: "slot:aide-owner",
      }),
    ).toBe(1);

    const [block, placement] = await t.run(async (ctx) =>
      Promise.all([
        ctx.db.get(scheduleA.blockId),
        ctx.db.get(scheduleA.placementId),
      ]),
    );
    expect(block?.label).toBe("Owner changed");
    expect(placement).toMatchObject({
      weekday: 2,
      orderOverride: true,
      dismissedFlags: ["slot:aide-owner"],
    });
  });
});
