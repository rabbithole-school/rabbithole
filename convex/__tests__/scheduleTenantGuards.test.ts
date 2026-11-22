import { convexTest } from "convex-test";
import { insertAssignmentWithSchedule } from "./scheduleFixtures";
import { asBellAdmin, seedSchoolAdmin } from "./bellScheduleAdmin";
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


/** A class block on a term, for tests that need a placed cell. */
async function seedClassBlock(
  t: ReturnType<typeof convexTest>,
  periodId: Id<"reportingPeriods">,
) {
  return await t.run((ctx) =>
    ctx.db.insert("scheduleBlocks", {
      periodId, key: "guard-a", label: "A", startLocal: "08:30", endLocal: "09:40",
      weekdays: [1, 2, 3, 4, 5], order: 0,
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
    insertAssignmentWithSchedule(ctx, {
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

// Work keys (TRA-582): the teacher grid gives work to a class, so the public
// placeClass / updatePlacement refuse an assignmentId or activityId outright,
// local or foreign, before anything is written. The public placeHomework is
// gone. updatePlacement still takes null, which unlinks an old card's work.
describe("work keys are refused: masterSchedule.placeClass / updatePlacement", () => {
  test("placeClass refuses an assignmentId or an activityId, writing nothing", async () => {
    const t = convexTest(schema, modules);
    const instA = await seedTestInstitution(t, { slug: "school-a" });
    const teacherA = await seedUser(t, "teacher", { username: "teacherA" });
    await grantInstitutionMembership(t, teacherA, instA);
    const groupId = await seedGroupWithRoster(t, teacherA, []);
    const periodId = await seedPeriod(t);
    const asA = await asUser(t, teacherA);
    const { activityId } = await seedUnitWithActivity(t, teacherA, instA);
    const assignmentId = await seedAssignmentRow(t, teacherA);
    const blockId = await seedClassBlock(t, periodId);

    for (const work of [{ assignmentId }, { activityId }]) {
      await expect(
        asA.mutation(api.masterSchedule.placeClass, {
          periodId, groupId, subject: "Math", weekday: 1, blockId, ...work,
        } as never),
      ).rejects.toThrow(/Validator|extra field/i);
    }
    expect(await placementCount(t)).toBe(0);
    // Only the seeded assignment: nothing was auto-provisioned.
    expect(await t.run((ctx) => ctx.db.query("assignments").collect())).toHaveLength(1);
  });

  test("updatePlacement refuses linking work but still unlinks an old card", async () => {
    const t = convexTest(schema, modules);
    const instA = await seedTestInstitution(t, { slug: "school-a" });
    const teacherA = await seedUser(t, "teacher", { username: "teacherA" });
    await grantInstitutionMembership(t, teacherA, instA);
    const groupId = await seedGroupWithRoster(t, teacherA, []);
    const periodId = await seedPeriod(t);
    const asA = await asUser(t, teacherA);
    const { activityId } = await seedUnitWithActivity(t, teacherA, instA);
    const assignmentId = await seedAssignmentRow(t, teacherA);
    const blockId = await seedClassBlock(t, periodId);
    const bare = await asA.mutation(api.masterSchedule.placeClass, {
      periodId, groupId, subject: "Math", weekday: 1, blockId,
    });

    await expect(
      asA.mutation(api.masterSchedule.updatePlacement, { placementId: bare, activityId } as never),
    ).rejects.toThrow(/Validator/i);
    await expect(
      asA.mutation(api.masterSchedule.updatePlacement, { placementId: bare, assignmentId } as never),
    ).rejects.toThrow(/Validator/i);
    expect((await t.run((ctx) => ctx.db.get(bare)))?.activityId).toBeUndefined();

    // A card placed before TRA-582 can still lose its work.
    const card = await t.run((ctx) =>
      ctx.db.insert("schedulePlacements", {
        periodId, groupId, subject: "Math", weekday: 2, blockId, assignmentId, activityId,
      }),
    );
    await asA.mutation(api.masterSchedule.updatePlacement, {
      placementId: card, activityId: null, assignmentId: null,
    });
    const unlinked = await t.run((ctx) => ctx.db.get(card));
    expect(unlinked?.activityId).toBeUndefined();
    expect(unlinked?.assignmentId).toBeUndefined();
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
      } as never),
    ).rejects.toThrow(/Validator/i);
    await expect(
      asB.mutation(api.masterSchedule.updatePlacement, {
        placementId: scheduleB.placementId,
        activityId: activityA,
      } as never),
    ).rejects.toThrow(/Validator/i);

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

    // The bell schedule is school-admin-only, so the owning SCHOOL's admin
    // edits the block; the owning teacher still edits the placement.
    await asBellAdmin(t, api.masterSchedule.updateBlock, {
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

describe("flag ownership", () => {
  test("a foreign teacher cannot dismiss a flag", async () => {
    const t = convexTest(schema, modules);
    const instA = await seedTestInstitution(t, { slug: "flag-school-a" });
    const instB = await seedTestInstitution(t, { slug: "flag-school-b" });
    const teacherA = await seedUser(t, "teacher", { username: "flag-teacher-a" });
    const teacherB = await seedUser(t, "teacher", { username: "flag-teacher-b" });
    const scholarA = await seedUser(t, "scholar", { username: "flag-scholar-a" });
    const scheduleA = await seedOwnedSchedule(t, {
      institutionId: instA,
      teacherId: teacherA,
      scholarId: scholarA,
      sequenceId: "foreign-flag",
    });
    await grantInstitutionMembership(t, teacherB, instB);
    const asB = await asUser(t, teacherB);
    await expect(
      asB.mutation(api.masterSchedule.dismissFlag, {
        placementIds: [scheduleA.placementId],
        flagId: "slot:foreign",
      }),
    ).rejects.toThrow(/forbidden/i);
    const placement = await t.run((ctx) => ctx.db.get(scheduleA.placementId));
    expect(placement?.dismissedFlags).toBeUndefined();
  });

  test("every placement is checked before a dismiss writes", async () => {
    const t = convexTest(schema, modules);
    const instA = await seedTestInstitution(t, { slug: "mixed-flag-a" });
    const instB = await seedTestInstitution(t, { slug: "mixed-flag-b" });
    const teacherA = await seedUser(t, "teacher", { username: "mixed-flag-teacher-a" });
    const teacherB = await seedUser(t, "teacher", { username: "mixed-flag-teacher-b" });
    const scholarA = await seedUser(t, "scholar", { username: "mixed-flag-scholar-a" });
    const scholarB = await seedUser(t, "scholar", { username: "mixed-flag-scholar-b" });
    const local = await seedOwnedSchedule(t, {
      institutionId: instA, teacherId: teacherA, scholarId: scholarA, sequenceId: "mixed-flag",
    });
    const foreign = await seedOwnedSchedule(t, {
      institutionId: instB, teacherId: teacherB, scholarId: scholarB, sequenceId: "mixed-flag",
    });
    const asA = await asUser(t, teacherA);
    await expect(
      asA.mutation(api.masterSchedule.dismissFlag, {
        placementIds: [local.placementId, foreign.placementId],
        flagId: "slot:mixed",
      }),
    ).rejects.toThrow(/forbidden/i);
    const localPlacement = await t.run((ctx) => ctx.db.get(local.placementId));
    expect(localPlacement?.dismissedFlags).toBeUndefined();
  });

  test("platform admin can still dismiss a flag", async () => {
    const t = convexTest(schema, modules);
    const instA = await seedTestInstitution(t, { slug: "flag-owner-school" });
    const teacherA = await seedUser(t, "teacher", { username: "flag-owner-teacher" });
    const scholarA = await seedUser(t, "scholar", { username: "flag-owner-scholar" });
    const scheduleA = await seedOwnedSchedule(t, {
      institutionId: instA, teacherId: teacherA, scholarId: scholarA, sequenceId: "owned-flag",
    });
    const admin = await seedUser(t, "platform_admin", { username: "flag-admin" });
    const asAdmin = await asUser(t, admin);
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

    await asBellAdmin(t, api.masterSchedule.updateBlock, {
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
  test("a foreign teacher cannot mutate block, placement, or flag rows", async () => {
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

    // The bell schedule is school-admin-only (2026-11-08): the teacher's aide
    // is refused, and the school's admin makes the change.
    await expect(
      t.mutation(internal.masterSchedule.aideUpdateBlock, {
        callerUserId: teacherA,
        blockId: scheduleA.blockId,
        label: "Teacher changed",
      }),
    ).rejects.toThrow(/Only a school admin can change the bell schedule/);
    await t.mutation(internal.masterSchedule.aideUpdateBlock, {
      callerUserId: await seedSchoolAdmin(t, instA),
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
      dismissedFlags: ["slot:aide-owner"],
    });
  });
});
