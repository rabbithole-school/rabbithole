import { convexTest } from "convex-test";
import { describe, expect, test, vi } from "vitest";
import schema from "../schema";
import { api, internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { placementStartMs } from "../masterSchedule";
import { dayKeyForWeekday } from "../../shared/schoolClosures";
import { scheduleWeekStartMs } from "../../shared/scheduleWeek";
import { dayKeyForTimezone } from "../../shared/institutionDay";
import {
  grantInstitutionMembership,
  seedOperationsStaff,
  seedScholarInInstitution,
  seedStaffWithMembership,
  seedTestInstitution,
} from "./institutionTestHelpers";

const modules = (
  import.meta as ImportMeta & {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("../**/*.ts");

async function asUser(t: ReturnType<typeof convexTest>, userId: Id<"users">) {
  const sessionId = await t.run((ctx) =>
    ctx.db.insert("authSessions", {
      userId,
      expirationTime: Date.now() + 3_600_000,
    }),
  );
  return t.withIdentity({
    subject: `${userId}|${sessionId}`,
    issuer: "https://convex.dev",
  });
}

async function giveCurriculumAccess(
  t: ReturnType<typeof convexTest>,
  userId: Id<"users">,
  institutionId: Id<"institutions">,
) {
  await t.run((ctx) =>
    ctx.db.insert("staffCapabilityGrants", {
      granteeUserId: userId,
      institutionId,
      capability: "curriculum:edit",
      grantedBy: userId,
      grantedAt: Date.now(),
    }),
  );
}

async function grantProgramPublish(
  t: ReturnType<typeof convexTest>,
  {
    userId,
    institutionId,
    groupId,
    revokedAt,
  }: {
    userId: Id<"users">;
    institutionId: Id<"institutions">;
    groupId: Id<"scholarGroups">;
    revokedAt?: number;
  },
) {
  return await t.run((ctx) =>
    ctx.db.insert("staffCapabilityGrants", {
      granteeUserId: userId,
      institutionId,
      scholarGroupId: groupId,
      capability: "program:publish",
      grantedBy: userId,
      grantedAt: Date.now(),
      revokedAt,
    }),
  );
}

async function seedActivity(
  t: ReturnType<typeof convexTest>,
  teacherId: Id<"users">,
  institutionId: Id<"institutions">,
  title = "Robotics",
) {
  return await t.run(async (ctx) => {
    const unitId = await ctx.db.insert("units", {
      teacherId,
      institutionId,
      title,
      isActive: true,
    });
    const lessonId = await ctx.db.insert("lessons", {
      unitId,
      title: "Build",
      order: 0,
    });
    const activityId = await ctx.db.insert("activities", {
      lessonId,
      title: "Motor challenge",
      kind: "online",
      order: 0,
    });
    await ctx.db.insert("activityResources", {
      activityId,
      title: "Build guide",
      source: { kind: "link", url: "https://example.com/build-guide" },
      order: 0,
      uploadedBy: teacherId,
    });
    return { unitId, activityId };
  });
}

describe("program publishing", () => {
  test("searches active program curriculum at unit, lesson, and activity altitude", async () => {
    const t = convexTest(schema, modules);
    const institutionId = await seedTestInstitution(t);
    const specialist = await seedStaffWithMembership(t, {
      institutionId,
      role: "teacher",
      username: "curriculum-search-specialist",
    });
    const otherStaff = await seedStaffWithMembership(t, {
      institutionId,
      role: "teacher",
      username: "curriculum-search-other",
    });
    const scholar = await seedScholarInInstitution(t, { institutionId });
    const groupId = await t.run((ctx) =>
      ctx.db.insert("scholarGroups", {
        teacherId: specialist,
        institutionId,
        name: "Solar program",
        participation: "includes_program_guests",
        scholarIds: [scholar],
      }),
    );
    const otherGroupId = await t.run((ctx) =>
      ctx.db.insert("scholarGroups", {
        teacherId: otherStaff,
        institutionId,
        name: "Other program",
        participation: "includes_program_guests",
        scholarIds: [scholar],
      }),
    );
    await grantProgramPublish(t, { userId: specialist, institutionId, groupId });
    const { unitId, lessonId, activityId } = await t.run(async (ctx) => {
      const unitId = await ctx.db.insert("units", {
        teacherId: otherStaff,
        institutionId,
        title: "Solar engineering",
        isActive: true,
      });
      const lessonId = await ctx.db.insert("lessons", {
        unitId,
        title: "Turbine mechanics",
        order: 0,
      });
      const activityId = await ctx.db.insert("activities", {
        lessonId,
        title: "Rotor prototype",
        kind: "offline",
        order: 0,
      });
      await ctx.db.insert("activityResources", {
        activityId,
        title: "Rotor diagram",
        source: { kind: "link", url: "https://example.com/rotor" },
        order: 0,
        uploadedBy: otherStaff,
      });
      await ctx.db.insert("units", {
        teacherId: otherStaff,
        institutionId,
        title: "Solar archive",
        isActive: false,
      });
      const archivedLessonId = await ctx.db.insert("lessons", {
        unitId,
        title: "Archived activities",
        order: 1,
      });
      await ctx.db.insert("activities", {
        lessonId: archivedLessonId,
        title: "Rotor archive",
        kind: "offline",
        order: 0,
        archivedAt: Date.now(),
      });
      return { unitId, lessonId, activityId };
    });
    const asSpecialist = await asUser(t, specialist);

    await expect(
      asSpecialist.query(api.masterSchedule.searchProgramCurriculum, {
        groupId,
        query: "s",
      }),
    ).rejects.toThrow(/at least 2 characters/i);
    await expect(
      asSpecialist.query(api.masterSchedule.searchProgramCurriculum, {
        groupId: otherGroupId,
        query: "solar",
      }),
    ).rejects.toThrow(/program group/i);
    const foreignInstitutionId = await seedTestInstitution(t, {
      slug: "search-foreign-school",
    });
    const foreignScholar = await seedScholarInInstitution(t, {
      institutionId: foreignInstitutionId,
    });
    const foreignGroupId = await t.run((ctx) =>
      ctx.db.insert("scholarGroups", {
        teacherId: otherStaff,
        institutionId: foreignInstitutionId,
        name: "Foreign program",
        participation: "includes_program_guests",
        scholarIds: [foreignScholar],
      }),
    );
    await expect(
      asSpecialist.query(api.masterSchedule.searchProgramCurriculum, {
        groupId: foreignGroupId,
        query: "solar",
      }),
    ).rejects.toThrow(/program group/i);

    expect(
      await asSpecialist.query(api.masterSchedule.searchProgramCurriculum, {
        groupId,
        query: "solar",
      }),
    ).toEqual([
      { kind: "unit", unitId, unitTitle: "Solar engineering" },
    ]);
    expect(
      await asSpecialist.query(api.masterSchedule.searchProgramCurriculum, {
        groupId,
        query: "turbine",
      }),
    ).toEqual([
      {
        kind: "lesson",
        unitId,
        unitTitle: "Solar engineering",
        lessonId,
        lessonTitle: "Turbine mechanics",
      },
    ]);
    expect(
      await asSpecialist.query(api.masterSchedule.searchProgramCurriculum, {
        groupId,
        query: "rotor",
      }),
    ).toEqual([
      {
        kind: "activity",
        unitId,
        unitTitle: "Solar engineering",
        lessonId,
        lessonTitle: "Turbine mechanics",
        activityId,
        activityTitle: "Rotor prototype",
        activityKind: "offline",
        materialCount: 1,
      },
    ]);
  });

  test("creates, edits, places, and discards a group-scoped unit-less handout", async () => {
    const t = convexTest(schema, modules);
    const institutionId = await seedTestInstitution(t);
    const specialist = await seedStaffWithMembership(t, {
      institutionId,
      role: "teacher",
      username: "program-specialist",
    });
    const otherStaff = await seedStaffWithMembership(t, {
      institutionId,
      role: "teacher",
      username: "other-specialist",
    });
    const scholar = await seedScholarInInstitution(t, { institutionId });
    const groupId = await t.run((ctx) =>
      ctx.db.insert("scholarGroups", {
        teacherId: specialist,
        institutionId,
        name: "Robotics program",
        participation: "includes_program_guests",
        scholarIds: [scholar],
      }),
    );
    const otherGroupId = await t.run((ctx) =>
      ctx.db.insert("scholarGroups", {
        teacherId: otherStaff,
        institutionId,
        name: "Other program",
        participation: "includes_program_guests",
        scholarIds: [scholar],
      }),
    );
    await grantProgramPublish(t, { userId: specialist, institutionId, groupId });
    const { periodId, blockId, weekStartMs } = await t.run(async (ctx) => {
      const periodId = await ctx.db.insert("reportingPeriods", {
        institutionId,
        label: "Program term",
        startsAt: Date.now() - 86_400_000,
        endsAt: Date.now() + 60 * 86_400_000,
        status: "open",
      });
      const blockId = await ctx.db.insert("scheduleBlocks", {
        periodId,
        key: "block-e",
        label: "Block E",
        startLocal: "13:00",
        endLocal: "14:00",
        weekdays: [1],
        order: 4,
      });
      const weekStartMs = scheduleWeekStartMs(Date.now()) + 7 * 86_400_000;
      await ctx.db.insert("schedulePlacements", {
        periodId,
        groupId,
        weekday: 1,
        blockId,
        subject: "Robotics",
      });
      return { periodId, blockId, weekStartMs };
    });
    const asSpecialist = await asUser(t, specialist);

    // The same program-publishing capability works for the staffer's own
    // session. An admin View As session deliberately fails before this gate so
    // its writes cannot be attributed to the impersonated staffer.
    const previousImpersonationFlag = process.env.IMPERSONATION_ENABLED;
    process.env.IMPERSONATION_ENABLED = "on";
    try {
      const admin = await t.run((ctx) =>
        ctx.db.insert("users", {
          name: "Fixture platform admin",
          username: "fixture-platform-admin",
          role: "platform_admin",
        }),
      );
      const asAdmin = await asUser(t, admin);
      await asAdmin.mutation(api.impersonation.startImpersonation, {
        targetUserId: specialist,
      });
      await expect(
        asAdmin.mutation(api.masterSchedule.createProgramHandoutDraft, {
          periodId,
          groupId,
          title: "Read-only handout",
        }),
      ).rejects.toThrow(/read-only while viewing/i);
    } finally {
      if (previousImpersonationFlag === undefined) {
        delete process.env.IMPERSONATION_ENABLED;
      } else {
        process.env.IMPERSONATION_ENABLED = previousImpersonationFlag;
      }
    }

    const first = await asSpecialist.mutation(
      api.masterSchedule.createProgramHandoutDraft,
      { periodId, groupId, title: "Servo worksheet" },
    );
    const retry = await asSpecialist.mutation(
      api.masterSchedule.createProgramHandoutDraft,
      { periodId, groupId, title: "Servo worksheet" },
    );
    expect(retry).toEqual(first);
    const draft = await t.run(async (ctx) => ({
      activity: await ctx.db.get(first.activityId),
      assignment: await ctx.db.get(first.assignmentId),
    }));
    expect(draft.activity).toMatchObject({
      title: "Servo worksheet",
      kind: "offline",
    });
    expect(draft.activity?.lessonId).toBeUndefined();
    expect(draft.assignment).toMatchObject({
      kind: "adHocDispatch",
      scholarGroupId: groupId,
      scholarIds: [],
      activitySchedule: [{ activityId: first.activityId, mode: "classFocus" }],
    });
    expect(draft.assignment?.unitId).toBeUndefined();

    await expect(
      (await asUser(t, otherStaff)).mutation(
        api.masterSchedule.updateProgramHandout,
        { ...first, title: "Unauthorized rename" },
      ),
    ).rejects.toThrow(/program group/i);
    await expect(
      asSpecialist.mutation(api.masterSchedule.updateProgramHandout, {
        ...first,
        title: "  Servo handout  ",
      }),
    ).resolves.toEqual({ ...first, title: "Servo handout" });
    const renamedDraft = await t.run(async (ctx) => ({
      activity: await ctx.db.get(first.activityId),
      assignment: await ctx.db.get(first.assignmentId),
    }));
    expect(renamedDraft.activity?.title).toBe("Servo handout");
    expect(renamedDraft.assignment?.title).toBe("Servo handout");
    await expect(
      asSpecialist.mutation(api.masterSchedule.updateProgramHandout, {
        ...first,
        title: "   ",
      }),
    ).rejects.toThrow(/title is required/i);

    await asSpecialist.mutation(api.activityResources.addLink, {
      activityId: first.activityId,
      assignmentId: first.assignmentId,
      title: "Servo guide",
      url: "https://example.com/servo-guide",
    });
    await expect(
      (await asUser(t, otherStaff)).query(api.activityResources.listForActivity, {
        activityId: first.activityId,
        assignmentId: first.assignmentId,
      }),
    ).rejects.toThrow(/program group/i);
    await expect(
      asSpecialist.mutation(api.masterSchedule.createProgramHandoutDraft, {
        periodId,
        groupId: otherGroupId,
        title: "Unauthorized",
      }),
    ).rejects.toThrow(/program group/i);
    const foreignInstitutionId = await seedTestInstitution(t, {
      slug: "foreign-program-school",
    });
    const foreignPeriodId = await t.run(async (ctx) => {
      const foreignPeriodId = await ctx.db.insert("reportingPeriods", {
        institutionId: foreignInstitutionId,
        label: "Foreign term",
        startsAt: Date.now() - 86_400_000,
        endsAt: Date.now() + 60 * 86_400_000,
        status: "open",
      });
      return foreignPeriodId;
    });
    await expect(
      asSpecialist.mutation(api.masterSchedule.createProgramHandoutDraft, {
        periodId: foreignPeriodId,
        groupId,
        title: "Cross-tenant",
      }),
    ).rejects.toThrow(/same school/i);
    const scholarWhoJoinedAfterDraft = await seedScholarInInstitution(t, {
      institutionId,
    });
    await t.run((ctx) =>
      ctx.db.patch(groupId, {
        scholarIds: [scholar, scholarWhoJoinedAfterDraft],
      }),
    );

    const classPlacement = await asSpecialist.mutation(
      api.masterSchedule.placeProgramHandout,
      {
        periodId,
        groupId,
        activityId: first.activityId,
        assignmentId: first.assignmentId,
        target: { mode: "classFocus", blockId, weekday: 1, weekStartMs },
      },
    );
    expect(classPlacement).toMatchObject({
      assignmentId: first.assignmentId,
      activityId: first.activityId,
      weekStartMs,
      mode: "classFocus",
    });
    const savedClassPlacement = await t.run((ctx) =>
      ctx.db.get(classPlacement.placementId),
    );
    expect(savedClassPlacement).toMatchObject({
      blockId,
      weekday: 1,
      weekStartMs,
      mode: "classFocus",
    });
    expect(
      (await t.run((ctx) => ctx.db.get(first.assignmentId)))?.scholarIds,
    ).toEqual([scholar, scholarWhoJoinedAfterDraft]);
    const programGrid = await asSpecialist.query(
      api.masterSchedule.programGrid,
      { periodId, weekStartMs },
    );
    expect(
      programGrid?.weekPlacements.find(
        (placement) => placement._id === classPlacement.placementId,
      ),
    ).toMatchObject({ isProgramHandout: true });
    const recurringHandoutSlot = await t.run(async (ctx) =>
      (await ctx.db
        .query("schedulePlacements")
        .withIndex("by_period_group", (q) =>
          q.eq("periodId", periodId).eq("groupId", groupId),
        )
        .collect()).find(
        (placement) =>
          placement.blockId === blockId &&
          placement.weekday === 1 &&
          placement.weekStartMs == null,
      ),
    );
    expect(recurringHandoutSlot).toMatchObject({ subject: "Robotics" });
    expect(recurringHandoutSlot?.activityId).toBeUndefined();
    expect(recurringHandoutSlot?.assignmentId).toBeUndefined();
    await expect(
      asSpecialist.mutation(api.masterSchedule.placeProgramHandout, {
        periodId,
        groupId,
        activityId: first.activityId,
        assignmentId: first.assignmentId,
        target: { mode: "classFocus", blockId, weekday: 1, weekStartMs },
      }),
    ).resolves.toMatchObject({ placementId: classPlacement.placementId });
    await expect(
      asSpecialist.mutation(api.masterSchedule.updateProgramHandout, {
        ...first,
        title: "Servo build checklist",
      }),
    ).resolves.toEqual({ ...first, title: "Servo build checklist" });
    const renamedScheduledHandout = await t.run(async (ctx) => ({
      activity: await ctx.db.get(first.activityId),
      assignment: await ctx.db.get(first.assignmentId),
    }));
    expect(renamedScheduledHandout.activity?.title).toBe(
      "Servo build checklist",
    );
    expect(renamedScheduledHandout.assignment?.title).toBe(
      "Servo build checklist",
    );
    await expect(
      asSpecialist.mutation(api.masterSchedule.discardProgramHandoutDraft, first),
    ).rejects.toThrow(/unscheduled/i);

    const stacked = await asSpecialist.mutation(
      api.masterSchedule.createProgramHandoutDraft,
      { periodId, groupId, title: "Stacked worksheet" },
    );
    await asSpecialist.mutation(api.activityResources.addLink, {
      activityId: stacked.activityId,
      assignmentId: stacked.assignmentId,
      title: "Stacked guide",
      url: "https://example.com/stacked-guide",
    });
    const stackedPlacement = await asSpecialist.mutation(
      api.masterSchedule.placeProgramHandout,
      {
        periodId,
        groupId,
        ...stacked,
        target: { mode: "classFocus", blockId, weekday: 1, weekStartMs },
      },
    );
    // A previously-created dated placement is a distinct Layer 2 row even
    // though Layer 3 has one activity entry. Removing this week's chip must
    // leave that other week intact.
    const futurePlacementId = await t.run((ctx) =>
      ctx.db.insert("schedulePlacements", {
        periodId,
        groupId,
        subject: "Robotics",
        weekday: 1,
        blockId,
        weekStartMs: weekStartMs + 7 * 86_400_000,
        assignmentId: first.assignmentId,
        activityId: first.activityId,
      }),
    );
    await expect(
      (await asUser(t, otherStaff)).mutation(
        api.masterSchedule.removeProgramHandoutPlacement,
        { placementId: classPlacement.placementId, ...first },
      ),
    ).rejects.toThrow(/program group/i);
    await expect(
      asSpecialist.mutation(api.masterSchedule.removeProgramHandoutPlacement, {
        placementId: classPlacement.placementId,
        ...first,
      }),
    ).resolves.toEqual({ removed: true });
    expect(await t.run((ctx) => ctx.db.get(classPlacement.placementId))).toBeNull();
    expect(await t.run((ctx) => ctx.db.get(stackedPlacement.placementId))).not.toBeNull();
    expect(await t.run((ctx) => ctx.db.get(futurePlacementId))).not.toBeNull();
    expect(
      await t.run(async (ctx) =>
        (await ctx.db
          .query("schedulePlacements")
          .withIndex("by_activity", (q) => q.eq("activityId", first.activityId))
          .collect()).some(
          (placement) => placement.weekday == null && placement.blockId == null,
        ),
      ),
    ).toBe(true);
    const scholarWhoJoinedAfterPublication = await seedScholarInInstitution(t, {
      institutionId,
    });
    await t.run((ctx) =>
      ctx.db.patch(groupId, {
        scholarIds: [
          scholar,
          scholarWhoJoinedAfterDraft,
          scholarWhoJoinedAfterPublication,
        ],
      }),
    );
    await asSpecialist.mutation(api.masterSchedule.placeProgramHandout, {
      periodId,
      groupId,
      ...first,
      target: { mode: "classFocus", blockId, weekday: 1, weekStartMs },
    });
    expect(
      (await t.run((ctx) => ctx.db.get(first.assignmentId)))?.scholarIds,
    ).toEqual([scholar, scholarWhoJoinedAfterDraft]);

    const homework = await asSpecialist.mutation(
      api.masterSchedule.createProgramHandoutDraft,
      { periodId, groupId, title: "Robotics reflection" },
    );
    await asSpecialist.mutation(api.activityResources.addLink, {
      activityId: homework.activityId,
      assignmentId: homework.assignmentId,
      title: "Reflection prompt",
      url: "https://example.com/reflection",
    });
    // Three weeks from the displayed week proves this is a calendar date, not a
    // weekday from the five-day grid.
    const dueDateMs = weekStartMs + 23 * 86_400_000 + 12 * 60 * 60_000;
    const homeworkPlacement = await asSpecialist.mutation(
      api.masterSchedule.placeProgramHandout,
      {
        periodId,
        groupId,
        activityId: homework.activityId,
        assignmentId: homework.assignmentId,
        target: { mode: "homework", dueDateMs },
      },
    );
    const savedHomeworkPlacement = await t.run((ctx) =>
      ctx.db.get(homeworkPlacement.placementId),
    );
    expect(savedHomeworkPlacement).toMatchObject({
      mode: "homework",
      assignmentId: homework.assignmentId,
      activityId: homework.activityId,
    });
    expect(
      (await t.run((ctx) => ctx.db.get(homework.assignmentId)))?.activitySchedule,
    ).toContainEqual(
      expect.objectContaining({
        activityId: homework.activityId,
        mode: "homework",
        startsAt: placementStartMs(
          homeworkPlacement.weekStartMs,
          savedHomeworkPlacement!.weekday!,
          "08:00",
        ),
        dueAt: homeworkPlacement.dueAt,
      }),
    );

    const closedDraft = await asSpecialist.mutation(
      api.masterSchedule.createProgramHandoutDraft,
      { periodId, groupId, title: "Closed day handout" },
    );
    const closureDateMs = dueDateMs + 7 * 86_400_000;
    await t.run((ctx) =>
      ctx.db.insert("schoolClosures", {
        institutionId,
        startDayKey: dayKeyForTimezone(closureDateMs, "Pacific/Honolulu"),
        endDayKey: dayKeyForTimezone(closureDateMs, "Pacific/Honolulu"),
        label: "Holiday",
        kind: "holiday",
      }),
    );
    await expect(
      asSpecialist.mutation(api.masterSchedule.placeProgramHandout, {
        periodId,
        groupId,
        activityId: closedDraft.activityId,
        assignmentId: closedDraft.assignmentId,
        target: { mode: "homework", dueDateMs: closureDateMs },
      }),
    ).rejects.toThrow(/school is closed/i);

    const discarded = await asSpecialist.mutation(
      api.masterSchedule.createProgramHandoutDraft,
      { periodId, groupId, title: "Discard me" },
    );
    await expect(
      asSpecialist.mutation(api.masterSchedule.discardProgramHandoutDraft, discarded),
    ).resolves.toEqual({ discarded: true });
    expect(await t.run((ctx) => ctx.db.get(discarded.activityId))).toBeNull();
    expect(await t.run((ctx) => ctx.db.get(discarded.assignmentId))).toBeNull();
  });

  test("keeps this week's recurring handout plan when placing its dated future override", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-17T19:00:00.000Z"));
    const t = convexTest(schema, modules);
    const institutionId = await seedTestInstitution(t);
    const coach = await seedStaffWithMembership(t, { institutionId, role: "teacher" });
    const scholar = await seedScholarInInstitution(t, { institutionId });
    const groupId = await t.run((ctx) =>
      ctx.db.insert("scholarGroups", {
        teacherId: coach,
        institutionId,
        name: "Override program",
        participation: "includes_program_guests",
        scholarIds: [scholar],
      }),
    );
    await grantProgramPublish(t, { userId: coach, institutionId, groupId });
    const { periodId, blockId, activityId, assignmentId, currentWeekStartMs } =
      await t.run(async (ctx) => {
        const periodId = await ctx.db.insert("reportingPeriods", {
          institutionId,
          label: "Program term",
          startsAt: Date.now() - 7 * 86_400_000,
          endsAt: Date.now() + 60 * 86_400_000,
          status: "open",
        });
        const blockId = await ctx.db.insert("scheduleBlocks", {
          periodId,
          key: "program",
          label: "Program",
          startLocal: "13:00",
          endLocal: "14:00",
          weekdays: [1],
          order: 0,
        });
        const activityId = await ctx.db.insert("activities", {
          title: "Build notes",
          kind: "offline",
          order: 0,
        });
        const assignmentId = await ctx.db.insert("assignments", {
          teacherId: coach,
          scholarGroupId: groupId,
          scholarIds: [scholar],
          kind: "adHocDispatch",
          startedAt: Date.now(),
          activitySchedule: [{
            activityId,
            mode: "classFocus",
            startsAt: placementStartMs(scheduleWeekStartMs(Date.now()), 1, "13:00")!,
          }],
        });
        await ctx.db.insert("schedulePlacements", {
          periodId,
          groupId,
          weekday: 1,
          blockId,
          subject: "Program",
          assignmentId,
          activityId,
        });
        await ctx.db.insert("schedulePlacements", {
          periodId,
          groupId,
          subject: "Build notes",
          assignmentId,
          activityId,
        });
        return {
          periodId,
          blockId,
          activityId,
          assignmentId,
          currentWeekStartMs: scheduleWeekStartMs(Date.now()),
        };
      });
    const futureWeekStartMs = currentWeekStartMs + 7 * 86_400_000;
    await (await asUser(t, coach)).mutation(api.masterSchedule.placeProgramHandout, {
      periodId,
      groupId,
      activityId,
      assignmentId,
      target: {
        mode: "classFocus",
        blockId,
        weekday: 1,
        weekStartMs: futureWeekStartMs,
      },
    });
    expect(
      (await t.run((ctx) => ctx.db.get(assignmentId)))?.activitySchedule,
    ).toEqual([
      expect.objectContaining({
        activityId,
        startsAt: placementStartMs(currentWeekStartMs, 1, "13:00"),
      }),
    ]);
    vi.useRealTimers();
  });

  test("archiving a scheduled assignment removes only its linked chips and cannot rematerialize it", async () => {
    const t = convexTest(schema, modules);
    const institutionId = await seedTestInstitution(t);
    const teacher = await seedStaffWithMembership(t, { institutionId, role: "teacher" });
    const scholar = await seedScholarInInstitution(t, { institutionId });
    const { periodId, shellId, linkedPlacementId, assignmentId } = await t.run(
      async (ctx) => {
        const groupId = await ctx.db.insert("scholarGroups", {
          teacherId: teacher,
          institutionId,
          name: "Archive program",
          participation: "includes_program_guests",
          scholarIds: [scholar],
        });
        const periodId = await ctx.db.insert("reportingPeriods", {
          institutionId,
          label: "Archive term",
          startsAt: Date.now() - 86_400_000,
          endsAt: Date.now() + 86_400_000,
          status: "open",
        });
        const blockId = await ctx.db.insert("scheduleBlocks", {
          periodId,
          key: "archive",
          label: "Archive",
          startLocal: "13:00",
          endLocal: "14:00",
          weekdays: [1],
          order: 0,
        });
        const activityId = await ctx.db.insert("activities", {
          title: "Archive work",
          kind: "offline",
          order: 0,
        });
        const assignmentId = await ctx.db.insert("assignments", {
          teacherId: teacher,
          scholarGroupId: groupId,
          scholarIds: [scholar],
          kind: "adHocDispatch",
          startedAt: Date.now(),
          activitySchedule: [{
            activityId,
            mode: "classFocus",
            startsAt: placementStartMs(scheduleWeekStartMs(Date.now()), 1, "13:00")!,
          }],
        });
        const shellId = await ctx.db.insert("schedulePlacements", {
          periodId,
          groupId,
          weekday: 1,
          blockId,
          subject: "Archive",
        });
        const linkedPlacementId = await ctx.db.insert("schedulePlacements", {
          periodId,
          groupId,
          weekday: 1,
          blockId,
          subject: "Archive",
          assignmentId,
          activityId,
        });
        return { periodId, shellId, linkedPlacementId, assignmentId };
      },
    );
    await (await asUser(t, teacher)).mutation(api.assignments.archive, { assignmentId });
    expect(await t.run((ctx) => ctx.db.get(linkedPlacementId))).toBeNull();
    expect(await t.run((ctx) => ctx.db.get(shellId))).not.toBeNull();
    expect((await t.run((ctx) => ctx.db.get(assignmentId)))?.activitySchedule).toEqual([]);
    await t.run((ctx) => ctx.runMutation(internal.masterSchedule.autoMaterializeTick, {}));
    expect((await t.run((ctx) => ctx.db.get(assignmentId)))?.activitySchedule).toEqual([]);
    expect(
      await t.run(async (ctx) =>
        (await ctx.db
          .query("schedulePlacements")
          .withIndex("by_period", (q) => q.eq("periodId", periodId))
          .collect()).map((placement) => placement._id),
      ),
    ).toEqual([shellId]);
  });

  test("places a material-backed activity into a dated override of an authorized program's recurring slot", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-17T19:00:00.000Z")); // Monday, 9 AM HST
    const t = convexTest(schema, modules);
    const institutionId = await seedTestInstitution(t);
    const coach = await seedStaffWithMembership(t, { institutionId, role: "teacher" });
    await giveCurriculumAccess(t, coach, institutionId);
    const scholar = await seedScholarInInstitution(t, { institutionId });
    const { unitId, activityId } = await seedActivity(
      t,
      coach,
      institutionId,
      "Program handouts",
    );
    const groupId = await t.run((ctx) =>
      ctx.db.insert("scholarGroups", {
        teacherId: coach,
        institutionId,
        name: "Handout program",
        participation: "includes_program_guests",
        scholarIds: [scholar],
      }),
    );
    await grantProgramPublish(t, { userId: coach, institutionId, groupId });
    const weekStartMs = scheduleWeekStartMs(Date.now()) + 7 * 86_400_000;
    const { periodId, blockId } = await t.run(async (ctx) => {
      const periodId = await ctx.db.insert("reportingPeriods", {
        institutionId,
        label: "Program term",
        startsAt: Date.now() - 7 * 86_400_000,
        endsAt: Date.now() + 90 * 86_400_000,
        status: "open",
      });
      await ctx.db.patch(activityId, {
        kind: "offline",
        description: "Complete the materials in class.",
      });
      const blockId = await ctx.db.insert("scheduleBlocks", {
        periodId,
        key: "program-workshop",
        label: "Program workshop",
        startLocal: "13:00",
        endLocal: "14:00",
        weekdays: [3],
        order: 1,
      });
      await ctx.db.insert("schedulePlacements", {
        periodId,
        groupId,
        weekday: 3,
        blockId,
        subject: "Workshop",
      });
      return { periodId, blockId };
    });
    const homeworkWeekStartMs = weekStartMs + 14 * 86_400_000;
    const dueDateMs = homeworkWeekStartMs + 12 * 60 * 60_000;
    const asCoach = await asUser(t, coach);

    const result = await asCoach.mutation(api.masterSchedule.placeProgramActivity, {
      activityId,
      groupId,
      periodId,
      target: { mode: "homework", dueDateMs },
      subject: "Workshop",
    });

    expect(result).toMatchObject({
      activityId,
      weekStartMs: homeworkWeekStartMs,
      mode: "homework",
      liveNow: false,
    });
    const placement = await t.run((ctx) => ctx.db.get(result.placementId));
    expect(placement).toMatchObject({
      periodId,
      groupId,
      assignmentId: result.assignmentId,
      activityId,
      subject: "Workshop",
      weekday: 1,
      weekStartMs: homeworkWeekStartMs,
      mode: "homework",
    });
    const assignment = await t.run((ctx) => ctx.db.get(result.assignmentId));
    expect(assignment).toMatchObject({
      unitId,
      scholarGroupId: groupId,
      scholarIds: [scholar],
      selfPaced: true,
    });
    expect(assignment?.activitySchedule).toContainEqual(
      expect.objectContaining({
        activityId,
        mode: "homework",
        startsAt: placementStartMs(homeworkWeekStartMs, 1, "08:00"),
      }),
    );
    expect(assignment?.activitySchedule?.[0]?.setAt).toBeUndefined();
    const grid = await asCoach.query(api.masterSchedule.programGrid, {
      periodId,
      weekStartMs: homeworkWeekStartMs,
    });
    expect(grid?.weekPlacements).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          _id: result.placementId,
          activityId,
          assignmentId: result.assignmentId,
        }),
      ]),
    );
    const retry = await asCoach.mutation(api.masterSchedule.placeProgramActivity, {
      activityId,
      groupId,
      periodId,
      target: { mode: "homework", dueDateMs },
      subject: "Workshop",
    });
    expect(retry.placementId).toBe(result.placementId);
    expect(
      await t.run(async (ctx) =>
        (await ctx.db
          .query("schedulePlacements")
          .withIndex("by_period_group", (q) =>
            q.eq("periodId", periodId).eq("groupId", groupId),
          )
          .collect()).filter(
            (placement) => placement.weekStartMs === homeworkWeekStartMs,
          ),
      ),
    ).toHaveLength(1);
    await t.run((ctx) =>
      ctx.db.insert("schoolClosures", {
        institutionId,
        startDayKey: dayKeyForWeekday(homeworkWeekStartMs, 2, "Pacific/Honolulu"),
        endDayKey: dayKeyForWeekday(homeworkWeekStartMs, 2, "Pacific/Honolulu"),
        label: "Holiday",
        kind: "holiday",
      }),
    );
    await expect(
      asCoach.mutation(api.masterSchedule.placeProgramActivity, {
        activityId,
        groupId,
        periodId,
        target: {
          mode: "homework",
          dueDateMs: homeworkWeekStartMs + 86_400_000 + 12 * 60 * 60_000,
        },
        subject: "Workshop",
      }),
    ).rejects.toThrow(/school is closed/i);
    const handout = await asCoach.mutation(
      api.masterSchedule.createProgramHandoutDraft,
      { periodId, groupId, title: "Build checklist" },
    );
    await asCoach.mutation(api.activityResources.addLink, {
      activityId: handout.activityId,
      assignmentId: handout.assignmentId,
      title: "Checklist",
      url: "https://example.com/checklist",
    });
    const handoutPlacement = await asCoach.mutation(
      api.masterSchedule.placeProgramHandout,
      {
        periodId,
        groupId,
        ...handout,
        target: { mode: "classFocus", blockId, weekday: 3, weekStartMs },
      },
    );
    const classFocus = await asCoach.mutation(api.masterSchedule.placeProgramActivity, {
      activityId,
      groupId,
      periodId,
      target: { mode: "classFocus", blockId, weekday: 3, weekStartMs },
      subject: "Workshop",
    });
    expect(classFocus).toMatchObject({
      activityId,
      mode: "classFocus",
      weekStartMs,
      liveNow: false,
    });
    expect(classFocus.placementId).not.toBe(handoutPlacement.placementId);
    expect(await t.run((ctx) => ctx.db.get(classFocus.placementId))).toMatchObject({
      blockId,
      weekday: 3,
      weekStartMs,
      assignmentId: classFocus.assignmentId,
      activityId,
      mode: "classFocus",
    });
    const recurringActivitySlot = await t.run(async (ctx) =>
      (await ctx.db
        .query("schedulePlacements")
        .withIndex("by_period_group", (q) =>
          q.eq("periodId", periodId).eq("groupId", groupId),
        )
        .collect()).find(
        (placement) =>
          placement.blockId === blockId &&
          placement.weekday === 3 &&
          placement.weekStartMs == null,
      ),
    );
    expect(recurringActivitySlot).toMatchObject({ subject: "Workshop" });
    expect(recurringActivitySlot?.activityId).toBeUndefined();
    expect(recurringActivitySlot?.assignmentId).toBeUndefined();
    const stackedGrid = await asCoach.query(api.masterSchedule.programGrid, {
      periodId,
      weekStartMs,
    });
    expect(
      stackedGrid?.weekPlacements.filter(
        (placement) =>
          placement.blockId === blockId &&
          placement.weekday === 3 &&
          placement.weekStartMs === weekStartMs,
      ),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          _id: handoutPlacement.placementId,
          activityId: handout.activityId,
        }),
        expect.objectContaining({
          _id: classFocus.placementId,
          activityId,
        }),
      ]),
    );
    await expect(
      asCoach.mutation(api.masterSchedule.placeProgramActivity, {
        activityId,
        groupId,
        periodId,
        target: { mode: "classFocus", blockId, weekday: 3, weekStartMs },
        subject: "Workshop",
      }),
    ).resolves.toMatchObject({ placementId: classFocus.placementId });
    const today = await asCoach.mutation(api.masterSchedule.placeProgramActivity, {
      activityId,
      groupId,
      periodId,
      dueWeekday: 1,
      weekStartMs: scheduleWeekStartMs(Date.now()),
      subject: "Workshop",
    });
    const liveAssignment = await t.run((ctx) => ctx.db.get(today.assignmentId));
    expect(liveAssignment?.activitySchedule).toContainEqual(
      expect.objectContaining({
        activityId,
        mode: "homework",
        setAt: Date.now(),
      }),
    );
    expect(today.liveNow).toBe(true);
    vi.useRealTimers();
  });

  test("rejects an empty offline activity but publishes instructions- or material-backed handouts", async () => {
    const t = convexTest(schema, modules);
    const institutionId = await seedTestInstitution(t);
    const coach = await seedStaffWithMembership(t, { institutionId, role: "teacher" });
    await giveCurriculumAccess(t, coach, institutionId);
    const scholar = await seedScholarInInstitution(t, { institutionId });
    const { activityId } = await seedActivity(t, coach, institutionId);
    const groupId = await t.run((ctx) =>
      ctx.db.insert("scholarGroups", {
        teacherId: coach,
        institutionId,
        name: "Handout group",
        participation: "includes_program_guests",
        scholarIds: [scholar],
      }),
    );
    await grantProgramPublish(t, { userId: coach, institutionId, groupId });
    await t.run(async (ctx) => {
      await ctx.db.patch(activityId, { kind: "offline" });
      const resources = await ctx.db
        .query("activityResources")
        .withIndex("by_activity", (q) => q.eq("activityId", activityId))
        .collect();
      await Promise.all(resources.map((resource) => ctx.db.delete(resource._id)));
    });
    const asCoach = await asUser(t, coach);

    await expect(
      asCoach.mutation(api.assignments.assignProgramActivity, {
        activityId,
        scholarGroupId: groupId,
      }),
    ).rejects.toThrow(/empty offline homework/i);

    await t.run((ctx) =>
      ctx.db.patch(activityId, {
        scholarDescription: "Sketch the mechanism on paper.",
      }),
    );
    await expect(
      asCoach.mutation(api.assignments.assignProgramActivity, {
        activityId,
        scholarGroupId: groupId,
      }),
    ).resolves.toMatchObject({ shared: true });

    const materialOnlyId = await t.run(async (ctx) => {
      const activity = await ctx.db.get(activityId);
      const resourceActivityId = await ctx.db.insert("activities", {
        lessonId: activity!.lessonId,
        title: "Shared source",
        kind: "offline",
        order: 1,
      });
      const resourceId = await ctx.db.insert("activityResources", {
        activityId: resourceActivityId,
        title: "Build guide",
        source: { kind: "link", url: "https://example.com/build-guide" },
        order: 0,
        uploadedBy: coach,
      });
      const handoutId = await ctx.db.insert("activities", {
        lessonId: activity!.lessonId,
        title: "Material-only handout",
        kind: "offline",
        referencedResourceIds: [resourceId],
        order: 2,
      });
      return handoutId;
    });
    await expect(
      asCoach.mutation(api.assignments.assignProgramActivity, {
        activityId: materialOnlyId,
        scholarGroupId: groupId,
      }),
    ).resolves.toMatchObject({ shared: true });
  });

  test("shares a coached guest-inclusive group as immutable live homework", async () => {
    const t = convexTest(schema, modules);
    const institutionId = await seedTestInstitution(t);
    const coach = await seedStaffWithMembership(t, { institutionId, role: "teacher" });
    await giveCurriculumAccess(t, coach, institutionId);
    const enrolled = await seedScholarInInstitution(t, { institutionId });
    const guest = await seedScholarInInstitution(t, { institutionId });
    await t.run((ctx) =>
      ctx.db.patch(guest, { enrollmentStanding: "program_guest" }),
    );
    const { unitId, activityId } = await seedActivity(t, coach, institutionId);
    const groupId = await t.run((ctx) =>
      ctx.db.insert("scholarGroups", {
        teacherId: coach,
        institutionId,
        name: "Saturday robotics",
        participation: "includes_program_guests",
        scholarIds: [enrolled, guest],
      }),
    );
    await grantProgramPublish(t, { userId: coach, institutionId, groupId });
    const asCoach = await asUser(t, coach);

    await expect(
      asCoach.query(api.assignments.programScheduleOverview, {}),
    ).resolves.toEqual({
      groups: [{ groupId, groupName: "Saturday robotics" }],
      scheduled: [],
    });

    const first = await asCoach.mutation(
      api.assignments.assignProgramActivity,
      { activityId, scholarGroupId: groupId },
    );
    expect(first.created).toBe(true);
    const assignment = await t.run((ctx) => ctx.db.get(first.assignmentId));
    expect(assignment).toMatchObject({
      unitId,
      scholarGroupId: groupId,
      scholarIds: [enrolled, guest],
      selfPaced: true,
    });
    expect(assignment!.activitySchedule).toHaveLength(1);
    expect(assignment!.activitySchedule![0]).toMatchObject({
      activityId,
      mode: "homework",
    });
    expect(assignment!.activitySchedule![0].setAt).toBeTypeOf("number");

    const second = await asCoach.mutation(
      api.assignments.assignProgramActivity,
      { activityId, scholarGroupId: groupId },
    );
    expect(second).toMatchObject({ assignmentId: first.assignmentId, created: false });
    expect((await t.run((ctx) => ctx.db.get(first.assignmentId)))!.activitySchedule).toHaveLength(1);

    const laterScholar = await seedScholarInInstitution(t, { institutionId });
    const laterActivityId = await t.run(async (ctx) => {
      await ctx.db.patch(groupId, {
        scholarIds: [enrolled, guest, laterScholar],
      });
      const activity = await ctx.db.get(activityId);
      return await ctx.db.insert("activities", {
        lessonId: activity!.lessonId,
        title: "Sensor challenge",
        kind: "online",
        order: 1,
      });
    });
    await asCoach.mutation(api.assignments.assignProgramActivity, {
      activityId: laterActivityId,
      scholarGroupId: groupId,
    });
    const widened = (await t.run((ctx) =>
      ctx.db.get(first.assignmentId),
    ))!;
    expect(widened.scholarIds).toEqual([enrolled, guest, laterScholar]);
    expect(
      widened.activitySchedule?.find((entry) => entry.activityId === activityId)
        ?.scholarIds,
    ).toEqual([enrolled, guest]);
    expect(
      widened.activitySchedule?.find(
        (entry) => entry.activityId === laterActivityId,
      )?.scholarIds,
    ).toBeUndefined();

    for (const scholarId of [enrolled, guest]) {
      const homework = await (await asUser(t, scholarId)).query(
        api.assignments.homeworkForMe,
        {},
      );
      expect(homework.some((row) => row.activityId === activityId)).toBe(true);
      expect(homework.some((row) => row.activityId === laterActivityId)).toBe(
        true,
      );
    }
    const laterHomework = await (await asUser(t, laterScholar)).query(
      api.assignments.homeworkForMe,
      {},
    );
    expect(laterHomework.some((row) => row.activityId === activityId)).toBe(
      false,
    );
    expect(
      laterHomework.some((row) => row.activityId === laterActivityId),
    ).toBe(true);
    const coachOverview = await asCoach.query(
      api.assignments.programScheduleOverview,
      {},
    );
    expect(coachOverview.groups).toEqual([
      { groupId, groupName: "Saturday robotics" },
    ]);
    expect(coachOverview.scheduled).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          assignmentId: first.assignmentId,
          groupId,
          groupName: "Saturday robotics",
          unitId,
          unitTitle: "Robotics",
          activityId: laterActivityId,
          activityTitle: "Sensor challenge",
        }),
        expect.objectContaining({
          assignmentId: first.assignmentId,
          groupId,
          groupName: "Saturday robotics",
          unitId,
          unitTitle: "Robotics",
          activityId,
          activityTitle: "Motor challenge",
        }),
      ]),
    );
    expect(
      coachOverview.scheduled
        .find((row) => row.activityId === activityId)
        ?.recipientCount,
    ).toBe(2);
    expect(
      coachOverview.scheduled.find((row) => row.activityId === activityId)
        ?.materialCount,
    ).toBe(1);
    expect(
      coachOverview.scheduled.find((row) => row.activityId === laterActivityId)
        ?.materialCount,
    ).toBe(0);

    const nextCoach = await seedStaffWithMembership(t, {
      institutionId,
      role: "curriculum_designer",
      name: "Next robotics coach",
    });
    await giveCurriculumAccess(t, nextCoach, institutionId);
    await grantProgramPublish(t, {
      userId: nextCoach,
      institutionId,
      groupId,
    });
    const asNextCoach = await asUser(t, nextCoach);
    await expect(
      asNextCoach.mutation(api.assignments.assignProgramActivity, {
        activityId: laterActivityId,
        scholarGroupId: groupId,
      }),
    ).resolves.toMatchObject({
      assignmentId: first.assignmentId,
      created: false,
    });
    const handoffOverview = await asNextCoach.query(
      api.assignments.programScheduleOverview,
      {},
    );
    expect(handoffOverview.scheduled.map((row) => row.activityId)).toEqual([
      laterActivityId,
      activityId,
    ]);

    await asNextCoach.mutation(api.assignments.endProgramActivity, {
      assignmentId: first.assignmentId,
      activityId,
    });
    expect(
      (
        await asNextCoach.query(api.assignments.programScheduleOverview, {})
      ).scheduled.map((row) => row.activityId),
    ).toEqual([laterActivityId]);
    expect(
      (
        await (await asUser(t, enrolled)).query(
          api.assignments.homeworkForMe,
          {},
        )
      ).some((row) => row.activityId === activityId),
    ).toBe(false);
    // …and its mirror closes with it. The push shape carries `dueAt` but has
    // no field for "withdrawn early", so a mirror left open here would hand
    // this work straight back to the scholar the moment reads switch over.
    await t.run(async (ctx) => {
      const open = (
        await ctx.db
          .query("pushes")
          .withIndex("by_assignment", (q) =>
            q.eq("assignmentId", first.assignmentId),
          )
          .collect()
      ).filter(
        (p) =>
          p.scheduleMirror === true &&
          p.clearedAt === undefined &&
          p.target.kind === "activity" &&
          String(p.target.activityId) === String(activityId),
      );
      expect(open, "ended homework kept an open mirror").toEqual([]);
    });
    await expect(
      asCoach.mutation(api.scholarGroups.setScholars, {
        groupId,
        scholarIds: [enrolled, laterScholar],
        participation: "enrolled_only",
      }),
    ).rejects.toThrow(/end this program's available activities/i);
    const { periodId, linkedPlacementId } = await t.run(async (ctx) => {
      const periodId = await ctx.db.insert("reportingPeriods", {
        institutionId,
        label: "Deletion term",
        startsAt: Date.now() - 86_400_000,
        endsAt: Date.now() + 86_400_000,
        status: "open",
      });
      const blockId = await ctx.db.insert("scheduleBlocks", {
        periodId,
        key: "program",
        label: "Program",
        startLocal: "13:00",
        endLocal: "14:00",
        weekdays: [1],
        order: 0,
      });
      const linkedPlacementId = await ctx.db.insert("schedulePlacements", {
        periodId,
        groupId,
        weekday: 1,
        blockId,
        subject: "Robotics",
        assignmentId: first.assignmentId,
        activityId: laterActivityId,
      });
      return { periodId, linkedPlacementId };
    });
    const orphanedHandout = await asCoach.mutation(
      api.masterSchedule.createProgramHandoutDraft,
      { periodId, groupId, title: "Delete with group" },
    );
    await asCoach.mutation(api.activityResources.addLink, {
      activityId: orphanedHandout.activityId,
      assignmentId: orphanedHandout.assignmentId,
      title: "Temporary guide",
      url: "https://example.com/temporary-guide",
    });
    const orphanResourceId = await t.run(async (ctx) =>
      (await ctx.db
        .query("activityResources")
        .withIndex("by_activity", (q) => q.eq("activityId", orphanedHandout.activityId))
        .unique())!._id,
    );
    await expect(
      asCoach.mutation(api.scholarGroups.remove, { groupId }),
    ).resolves.toBeNull();
    expect(await t.run((ctx) => ctx.db.get(groupId))).toBeNull();
    expect(await t.run((ctx) => ctx.db.get(linkedPlacementId))).toBeNull();
    expect(
      await t.run(async (ctx) =>
        (await ctx.db.query("schedulePlacements").collect()).filter(
          (placement) => placement.groupId === groupId,
        ),
      ),
    ).toEqual([]);
    expect(await t.run((ctx) => ctx.db.get(orphanedHandout.activityId))).toBeNull();
    expect(await t.run((ctx) => ctx.db.get(orphanResourceId))).toBeNull();
    expect(await t.run((ctx) => ctx.db.get(first.assignmentId))).toMatchObject({
      archivedAt: expect.any(Number),
      activitySchedule: expect.arrayContaining([
        expect.objectContaining({
          activityId: laterActivityId,
          endsAt: expect.any(Number),
        }),
      ]),
    });
    expect(
      (await t.run((ctx) => ctx.db.get(first.assignmentId)))?.scholarGroupId,
    ).toBeUndefined();
  });

  test("requires curriculum access, an explicit coach grant, and matching schools", async () => {
    const t = convexTest(schema, modules);
    const schoolA = await seedTestInstitution(t, { slug: "school-a" });
    const schoolB = await seedTestInstitution(t, { slug: "school-b" });
    const coach = await seedStaffWithMembership(t, { institutionId: schoolA, role: "teacher" });
    await giveCurriculumAccess(t, coach, schoolA);
    await grantInstitutionMembership(t, coach, schoolB, "teacher");
    await giveCurriculumAccess(t, coach, schoolB);
    const otherCoach = await seedStaffWithMembership(t, { institutionId: schoolA, role: "teacher" });
    await giveCurriculumAccess(t, otherCoach, schoolA);
    const ownerOnly = await seedStaffWithMembership(t, { institutionId: schoolA, role: "teacher" });
    await giveCurriculumAccess(t, ownerOnly, schoolA);
    // Operations staff (base `staff` + `school:operations` — the retired
    // registrar role's successor) has scholar-admin access but no curriculum
    // grant, so it still cannot assign a program activity.
    const opsStaff = await seedOperationsStaff(t, { institutionId: schoolA });
    const scholarA = await seedScholarInInstitution(t, { institutionId: schoolA });
    const scholarB = await seedScholarInInstitution(t, { institutionId: schoolB });
    const a = await seedActivity(t, coach, schoolA);
    const b = await seedActivity(t, coach, schoolB, "Foreign robotics");
    const groupA = await t.run((ctx) =>
      ctx.db.insert("scholarGroups", {
        teacherId: coach, institutionId: schoolA, name: "A", scholarIds: [scholarA],
        participation: "includes_program_guests", ownerId: ownerOnly,
      }),
    );
    const groupB = await t.run((ctx) =>
      ctx.db.insert("scholarGroups", {
        teacherId: coach, institutionId: schoolB, name: "B", scholarIds: [scholarB],
        participation: "includes_program_guests",
      }),
    );
    await grantProgramPublish(t, { userId: coach, institutionId: schoolA, groupId: groupA });
    await grantProgramPublish(t, { userId: coach, institutionId: schoolB, groupId: groupB });
    const schoolBUnits = await (await asUser(t, coach)).query(api.units.list, {
      scope: "school-b",
    });
    expect(schoolBUnits.map((unit) => unit._id)).toContain(b.unitId);
    expect(schoolBUnits.map((unit) => unit._id)).not.toContain(a.unitId);

    await expect((await asUser(t, opsStaff)).mutation(
      api.assignments.assignProgramActivity, { activityId: a.activityId, scholarGroupId: groupA },
    )).rejects.toThrow();
    await expect((await asUser(t, ownerOnly)).mutation(
      api.assignments.assignProgramActivity, { activityId: a.activityId, scholarGroupId: groupA },
    )).rejects.toThrow(/program group/i);
    await expect((await asUser(t, otherCoach)).mutation(
      api.assignments.assignProgramActivity, { activityId: a.activityId, scholarGroupId: groupA },
    )).rejects.toThrow(/program group/i);
    await expect((await asUser(t, coach)).mutation(
      api.assignments.assignProgramActivity, { activityId: a.activityId, scholarGroupId: groupB },
    )).rejects.toThrow(/same school/i);
    await expect((await asUser(t, coach)).mutation(
      api.assignments.assignProgramActivity, { activityId: b.activityId, scholarGroupId: groupA },
    )).rejects.toThrow(/same school/i);
    await expect((await asUser(t, coach)).mutation(
      api.assignments.assignProgramActivity,
      { activityId: a.activityId, scholarGroupId: groupA, scholarIds: [scholarB] } as never,
    )).rejects.toThrow();
  });

  test("requires an active, same-school publish grant for the exact group", async () => {
    const t = convexTest(schema, modules);
    const schoolA = await seedTestInstitution(t, { slug: "scope-a" });
    const schoolB = await seedTestInstitution(t, { slug: "scope-b" });
    const coach = await seedStaffWithMembership(t, { institutionId: schoolA, role: "teacher" });
    await giveCurriculumAccess(t, coach, schoolA);
    const scholarA = await seedScholarInInstitution(t, { institutionId: schoolA });
    const scholarB = await seedScholarInInstitution(t, { institutionId: schoolB });
    const { activityId } = await seedActivity(t, coach, schoolA);
    const [groupA, groupB] = await t.run(async (ctx) => [
      await ctx.db.insert("scholarGroups", {
        teacherId: coach,
        institutionId: schoolA,
        name: "Allowed",
        participation: "includes_program_guests",
        scholarIds: [scholarA],
      }),
      await ctx.db.insert("scholarGroups", {
        teacherId: coach,
        institutionId: schoolB,
        name: "Foreign",
        participation: "includes_program_guests",
        scholarIds: [scholarB],
      }),
    ]);
    const revokedGrantId = await grantProgramPublish(t, {
      userId: coach,
      institutionId: schoolA,
      groupId: groupA,
    });
    await t.run((ctx) => ctx.db.patch(revokedGrantId, { revokedAt: Date.now() }));

    await expect(
      (await asUser(t, coach)).mutation(api.assignments.assignProgramActivity, {
        activityId,
        scholarGroupId: groupA,
      }),
    ).rejects.toThrow(/program group/i);

    await grantProgramPublish(t, {
      userId: coach,
      institutionId: schoolB,
      groupId: groupB,
    });
    await expect(
      (await asUser(t, coach)).mutation(api.assignments.assignProgramActivity, {
        activityId,
        scholarGroupId: groupB,
      }),
    ).rejects.toThrow(/program group/i);
    await grantInstitutionMembership(t, coach, schoolB, "teacher");
    const asCoach = await asUser(t, coach);
    await expect(asCoach.query(api.users.currentUser, {})).resolves.toMatchObject({
      hasProgramPublishingAccess: true,
    });
    await expect(
      asCoach.query(api.assignments.programScheduleOverview, {
        institutionScope: "scope-a",
      }),
    ).resolves.toEqual({ groups: [], scheduled: [] });
    await expect(
      asCoach.query(api.assignments.programScheduleOverview, {
        institutionScope: "scope-b",
      }),
    ).resolves.toMatchObject({
      groups: [{ groupId: groupB, groupName: "Foreign" }],
    });
    await expect(
      asCoach.mutation(api.assignments.assignProgramActivity, {
        activityId,
        scholarGroupId: groupB,
      }),
    ).rejects.toThrow(/same school/i);

    const noMembership = await t.run((ctx) =>
      ctx.db.insert("users", {
        name: "No membership",
        username: "no-membership",
        role: "curriculum_designer",
      }),
    );
    await grantProgramPublish(t, {
      userId: noMembership,
      institutionId: schoolA,
      groupId: groupA,
    });
    await expect(
      (await asUser(t, noMembership)).query(
        api.assignments.programScheduleOverview,
        {},
      ),
    ).resolves.toEqual({ groups: [], scheduled: [] });
  });

  test("allows a school admin to publish without becoming the group coach", async () => {
    const t = convexTest(schema, modules);
    const institutionId = await seedTestInstitution(t);
    const coach = await seedStaffWithMembership(t, { institutionId, role: "teacher" });
    const admin = await seedStaffWithMembership(t, {
      institutionId,
      role: "school_admin",
    });
    const scholar = await seedScholarInInstitution(t, { institutionId });
    const { activityId } = await seedActivity(t, coach, institutionId);
    const groupId = await t.run((ctx) =>
      ctx.db.insert("scholarGroups", {
        teacherId: coach,
        institutionId,
        name: "Admin-published program",
        scholarIds: [scholar],
        participation: "includes_program_guests",
      }),
    );

    const result = await (await asUser(t, admin)).mutation(
      api.assignments.assignProgramActivity,
      { activityId, scholarGroupId: groupId },
    );
    expect((await t.run((ctx) => ctx.db.get(result.assignmentId)))?.teacherId).toBe(
      admin,
    );
    await expect(
      (await asUser(t, admin)).query(api.users.currentUser, {}),
    ).resolves.toMatchObject({
      hasProgramPublishingAccess: true,
    });
  });

  test("does not carry school-admin authority into a teacher-only membership", async () => {
    const t = convexTest(schema, modules);
    const schoolA = await seedTestInstitution(t, { slug: "admin-home" });
    const schoolB = await seedTestInstitution(t, { slug: "teacher-only" });
    const admin = await seedStaffWithMembership(t, {
      institutionId: schoolA,
      role: "school_admin",
    });
    await grantInstitutionMembership(t, admin, schoolB, "teacher");
    const scholar = await seedScholarInInstitution(t, {
      institutionId: schoolB,
    });
    const { activityId } = await seedActivity(
      t,
      admin,
      schoolB,
      "Second-school program",
    );
    const groupId = await t.run((ctx) =>
      ctx.db.insert("scholarGroups", {
        teacherId: admin,
        institutionId: schoolB,
        name: "Second-school program",
        scholarIds: [scholar],
        participation: "includes_program_guests",
      }),
    );
    const asAdmin = await asUser(t, admin);

    await expect(
      asAdmin.query(api.assignments.programScheduleOverview, {
        institutionScope: "teacher-only",
      }),
    ).resolves.toEqual({ groups: [], scheduled: [] });
    await expect(
      asAdmin.mutation(api.assignments.assignProgramActivity, {
        activityId,
        scholarGroupId: groupId,
      }),
    ).rejects.toThrow(/program group/i);
  });

  test("exposes only granted program schedule rows without planning metadata", async () => {
    const t = convexTest(schema, modules);
    const schoolA = await seedTestInstitution(t, { slug: "schedule-a" });
    const schoolB = await seedTestInstitution(t, { slug: "schedule-b" });
    const specialist = await seedStaffWithMembership(t, {
      institutionId: schoolA,
      role: "curriculum_designer",
      name: "Robotics specialist",
    });
    const roboticsTeacher = await seedStaffWithMembership(t, {
      institutionId: schoolA,
      role: "teacher",
      name: "Robotics teacher",
    });
    const unrelatedTeacher = await seedStaffWithMembership(t, {
      institutionId: schoolA,
      role: "teacher",
      name: "Unrelated teacher",
    });
    const roboticsScholar = await seedScholarInInstitution(t, {
      institutionId: schoolA,
    });
    const unrelatedScholar = await seedScholarInInstitution(t, {
      institutionId: schoolA,
    });
    const foreignScholar = await seedScholarInInstitution(t, {
      institutionId: schoolB,
    });
    const [periodA, periodB, legacyPeriod] = await t.run(async (ctx) => [
      await ctx.db.insert("reportingPeriods", {
        label: "School A",
        startsAt: Date.now(),
        endsAt: Date.now() + 90 * 86_400_000,
        status: "open",
        institutionId: schoolA,
      }),
      await ctx.db.insert("reportingPeriods", {
        label: "School B",
        startsAt: Date.now(),
        endsAt: Date.now() + 90 * 86_400_000,
        status: "open",
        institutionId: schoolB,
      }),
      await ctx.db.insert("reportingPeriods", {
        label: "Legacy",
        startsAt: Date.now(),
        endsAt: Date.now() + 90 * 86_400_000,
        status: "open",
      }),
    ]);
    const [roboticsGroup, unplacedProgramGroup, unrelatedGroup, foreignGroup] = await t.run(
      async (ctx) => [
        await ctx.db.insert("scholarGroups", {
          teacherId: roboticsTeacher,
          institutionId: schoolA,
          name: "Robotics",
          participation: "includes_program_guests",
          scholarIds: [roboticsScholar],
        }),
        await ctx.db.insert("scholarGroups", {
          teacherId: roboticsTeacher,
          institutionId: schoolA,
          name: "Robotics future",
          participation: "includes_program_guests",
          scholarIds: [roboticsScholar],
        }),
        await ctx.db.insert("scholarGroups", {
          teacherId: unrelatedTeacher,
          institutionId: schoolA,
          name: "Woodworking",
          participation: "includes_program_guests",
          scholarIds: [unrelatedScholar],
        }),
        await ctx.db.insert("scholarGroups", {
          teacherId: unrelatedTeacher,
          institutionId: schoolB,
          name: "Foreign robotics",
          participation: "includes_program_guests",
          scholarIds: [foreignScholar],
        }),
      ],
    );
    const { roboticsBlock, unrelatedBlock, roboticsPlacement, unrelatedPlacement } =
      await t.run(async (ctx) => {
        const sharedBlock = await ctx.db.insert("scheduleBlocks", {
          periodId: periodA,
          key: "morning",
          label: "Morning",
          startLocal: "09:00",
          endLocal: "10:00",
          weekdays: [1],
          order: 0,
        });
        const roboticsBlock = await ctx.db.insert("scheduleBlocks", {
          periodId: periodA,
          groupId: roboticsGroup,
          key: "robotics-lab",
          label: "Robotics lab",
          startLocal: "10:00",
          endLocal: "11:00",
          weekdays: [1],
          order: 1,
        });
        const unrelatedBlock = await ctx.db.insert("scheduleBlocks", {
          periodId: periodA,
          groupId: unrelatedGroup,
          key: "woodworking-lab",
          label: "Woodworking lab",
          startLocal: "10:00",
          endLocal: "11:00",
          weekdays: [1],
          order: 1,
        });
        const roboticsPlacement = await ctx.db.insert("schedulePlacements", {
          periodId: periodA,
          groupId: roboticsGroup,
          weekday: 1,
          blockId: sharedBlock,
          subject: "Robotics",
          teacherId: roboticsTeacher,
        });
        const unrelatedPlacement = await ctx.db.insert("schedulePlacements", {
          periodId: periodA,
          groupId: unrelatedGroup,
          weekday: 1,
          blockId: sharedBlock,
          subject: "Woodworking",
          teacherId: unrelatedTeacher,
        });
        await ctx.db.insert("schedulePlacements", {
          periodId: periodB,
          groupId: foreignGroup,
          weekday: 1,
          blockId: (
            await ctx.db.insert("scheduleBlocks", {
              periodId: periodB,
              key: "morning",
              label: "Morning",
              startLocal: "09:00",
              endLocal: "10:00",
              weekdays: [1],
              order: 0,
            })
          ),
          subject: "Foreign robotics",
          teacherId: unrelatedTeacher,
        });
        return {
          roboticsBlock,
          unrelatedBlock,
          roboticsPlacement,
          unrelatedPlacement,
        };
      });
    const grantId = await grantProgramPublish(t, {
      userId: specialist,
      institutionId: schoolA,
      groupId: roboticsGroup,
    });
    const unplacedGrantId = await grantProgramPublish(t, {
      userId: specialist,
      institutionId: schoolA,
      groupId: unplacedProgramGroup,
    });

    const programGrid = await (await asUser(t, specialist)).query(
      api.masterSchedule.programGrid,
      { periodId: periodA },
    );
    const programPeriods = await (await asUser(t, specialist)).query(
      api.masterSchedule.programPeriods,
      {},
    );
    expect(programPeriods.periods.map((period) => period._id)).toEqual([
      periodA,
    ]);
    expect(programPeriods.current?._id).toBe(periodA);
    expect(programGrid).not.toBeNull();
    expect(programGrid!.groups).toEqual([
      { _id: roboticsGroup, name: "Robotics", emoji: null },
      { _id: unplacedProgramGroup, name: "Robotics future", emoji: null },
    ]);
    expect(programGrid!.placements.map((placement) => placement._id)).toEqual([
      roboticsPlacement,
    ]);
    expect(programGrid!.weekPlacements.map((placement) => placement._id)).toEqual([
      roboticsPlacement,
    ]);
    expect(programGrid!.teachers).toEqual([
      {
        _id: roboticsTeacher,
        name: "Robotics teacher",
        username: expect.any(String),
      },
    ]);
    expect(programGrid!.blocks.map((block) => block._id)).toContain(roboticsBlock);
    expect(programGrid!.blocks.map((block) => block._id)).not.toContain(unrelatedBlock);
    expect(programGrid!.coverage).toEqual([]);
    expect(programGrid!.conflicts).toEqual([]);
    expect(programGrid!.overloaded).toEqual([]);
    expect(programGrid!.outOfOrder).toEqual([]);

    const teacherGridBefore = await (await asUser(t, roboticsTeacher)).query(
      api.masterSchedule.grid,
      { periodId: periodA },
    );
    expect(teacherGridBefore.placements.map((placement) => placement._id)).toEqual(
      expect.arrayContaining([roboticsPlacement, unrelatedPlacement]),
    );
    expect(teacherGridBefore.groups.map((group) => group._id)).toEqual(
      expect.arrayContaining([roboticsGroup, unrelatedGroup]),
    );
    await (await asUser(t, specialist)).query(api.masterSchedule.programGrid, {
      periodId: periodA,
    });
    await expect(
      (await asUser(t, roboticsTeacher)).query(api.masterSchedule.grid, {
        periodId: periodA,
      }),
    ).resolves.toEqual(teacherGridBefore);

    const noGrant = await seedStaffWithMembership(t, {
      institutionId: schoolA,
      role: "curriculum_designer",
    });
    await expect(
      (await asUser(t, noGrant)).query(api.masterSchedule.programGrid, {
        periodId: periodA,
      }),
    ).resolves.toBeNull();
    await t.run((ctx) => ctx.db.patch(grantId, { revokedAt: Date.now() }));
    await t.run((ctx) =>
      ctx.db.patch(unplacedGrantId, { revokedAt: Date.now() }),
    );
    await grantProgramPublish(t, {
      userId: specialist,
      institutionId: schoolB,
      groupId: foreignGroup,
    });
    await expect(
      (await asUser(t, specialist)).query(api.masterSchedule.programPeriods, {}),
    ).resolves.toEqual({ periods: [], current: null });
    await expect(
      (await asUser(t, specialist)).query(api.masterSchedule.programGrid, {
        periodId: periodA,
      }),
    ).resolves.toBeNull();
    await expect(
      (await asUser(t, specialist)).query(api.masterSchedule.programGrid, {
        periodId: periodB,
      }),
    ).resolves.toBeNull();
    await expect(
      (await asUser(t, specialist)).query(api.masterSchedule.programGrid, {
        periodId: legacyPeriod,
      }),
    ).resolves.toBeNull();
  });
});
