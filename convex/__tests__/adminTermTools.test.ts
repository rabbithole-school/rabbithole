import { convexTest, type TestConvex } from "convex-test";
import type { FunctionReference } from "convex/server";
import { describe, expect, test } from "vitest";
import { internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import schema from "../schema";

type Rig = TestConvex<typeof schema>;

const modules = (
  import.meta as ImportMeta & {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("../**/*.ts");

type CreateTestTermArgs = {
  fromPeriodLabel: string;
  label: string;
  startsAt: number;
  endsAt: number;
  groupName: string;
  dryRun?: boolean;
};

type CreateTestTermResult = {
  periodId: Id<"reportingPeriods"> | null;
  blocks: number;
  placements: number;
};

type EndTestTermResult = {
  periodId: Id<"reportingPeriods">;
  blocks: number;
  placements: number;
};

type UnassignResult =
  | {
      deletedPlacements: number;
      deletedAssignment: false;
      unitTitle: string;
      cohortSize: number;
      placementsByPeriod: Record<string, number>;
    }
  | {
      deletedPlacements: number;
      deletedAssignment: true;
    };

type AdminTermToolsApi = {
  adminTermTools: {
    createTestTerm: FunctionReference<
      "mutation",
      "internal",
      CreateTestTermArgs,
      CreateTestTermResult
    >;
    endTestTerm: FunctionReference<
      "mutation",
      "internal",
      {
        label: string;
        expectSourceLabel: string;
        deleteRows?: boolean;
      },
      EndTestTermResult
    >;
    addScholarToAssignment: FunctionReference<
      "mutation",
      "internal",
      { assignmentId: Id<"assignments">; username: string },
      { added: boolean; rosterSize: number }
    >;
    unassignAssignment: FunctionReference<
      "mutation",
      "internal",
      {
        assignmentId: Id<"assignments">;
        expectUnitTitle: string;
        expectTeacherEmail: string;
        dryRun?: boolean;
      },
      UnassignResult
    >;
  };
};

const adminTermTools = (internal as typeof internal & AdminTermToolsApi)
  .adminTermTools;

async function seedUser(
  t: Rig,
  role: "scholar" | "teacher",
  overrides: Partial<Doc<"users">> = {},
) {
  return await t.run(async (ctx) =>
    ctx.db.insert("users", {
      name: overrides.name ?? `Test ${role}`,
      username: overrides.username ?? `test-${role}`,
      email: overrides.email,
      role,
    }),
  );
}

async function seedTermFixture(t: Rig) {
  const teacherId = await seedUser(t, "teacher", {
    name: "Lehua Torres",
    username: "lehua",
  });
  const scholarId = await seedUser(t, "scholar", {
    name: "Hoku Makani",
    username: "hoku",
  });
  return await t.run(async (ctx) => {
    const institutionId = await ctx.db.insert("institutions", {
      name: "Moli School",
      slug: "moli",
      kind: "school",
      isPrimary: true,
      timeZone: "Pacific/Honolulu",
    });
    const groupId = await ctx.db.insert("scholarGroups", {
      teacherId,
      name: "Geckos",
      scholarIds: [scholarId],
    });
    const otherGroupId = await ctx.db.insert("scholarGroups", {
      teacherId,
      name: "Honu",
      scholarIds: [],
    });
    const sourcePeriodId = await ctx.db.insert("reportingPeriods", {
      label: "Fall 2026",
      startsAt: 1_000,
      endsAt: 2_000,
      status: "open",
      institutionId,
    });
    const blockAId = await ctx.db.insert("scheduleBlocks", {
      periodId: sourcePeriodId,
      key: "block-a",
      label: "Block A",
      startLocal: "08:30",
      endLocal: "09:40",
      weekdays: [1, 2, 3, 4, 5],
      order: 4,
      staffNeed: 2,
      kind: "class",
    });
    const blockBId = await ctx.db.insert("scheduleBlocks", {
      periodId: sourcePeriodId,
      groupId,
      key: "block-b",
      label: "Block B",
      startLocal: "10:00",
      endLocal: "11:10",
      weekdays: [1, 3, 5],
      order: 9,
      kind: "prep",
    });

    const unitId = await ctx.db.insert("units", {
      teacherId,
      title: "Source Unit",
      isActive: true,
    });
    const lessonId = await ctx.db.insert("lessons", {
      unitId,
      title: "Source Lesson",
      order: 0,
    });
    const activityId = await ctx.db.insert("activities", {
      lessonId,
      title: "Source Activity",
      kind: "online",
      systemPrompt: "Explore.",
      order: 0,
    });
    const assignmentId = await ctx.db.insert("assignments", {
      teacherId,
      unitId,
      scholarIds: [scholarId],
      startedAt: 100,
    });

    const copiedPlacementId = await ctx.db.insert("schedulePlacements", {
      periodId: sourcePeriodId,
      groupId,
      blockId: blockAId,
      weekday: 1,
      subject: "Ocean Physics",
      teacherId,
      mode: "classFocus",
      spanBlocks: 2,
      note: "Bring models",
      assignmentId,
      activityId,
      sequenceId: "source-sequence",
      sequenceIndex: 3,
      createdFromStrategy: "classMeetings",
    });
    await ctx.db.insert("schedulePlacements", {
      periodId: sourcePeriodId,
      groupId,
      blockId: blockBId,
      weekday: 3,
      subject: "Writing Workshop",
    });
    await ctx.db.insert("schedulePlacements", {
      periodId: sourcePeriodId,
      groupId,
      blockId: blockAId,
      weekday: 2,
      subject: "Homework",
      mode: "homework",
    });
    await ctx.db.insert("schedulePlacements", {
      periodId: sourcePeriodId,
      groupId,
      blockId: blockAId,
      weekday: 4,
      subject: "Concrete week",
      weekStartMs: 10_000,
    });
    await ctx.db.insert("schedulePlacements", {
      periodId: sourcePeriodId,
      groupId,
      subject: "Shelf item",
    });
    await ctx.db.insert("schedulePlacements", {
      periodId: sourcePeriodId,
      groupId: otherGroupId,
      blockId: blockAId,
      weekday: 5,
      subject: "Other group",
    });

    return {
      institutionId,
      teacherId,
      scholarId,
      groupId,
      sourcePeriodId,
      blockAId,
      blockBId,
      copiedPlacementId,
    };
  });
}

async function seedAssignmentFixture(t: Rig) {
  const teacherId = await seedUser(t, "teacher", {
    name: "Lehua Torres",
    username: "lehua",
    email: "lehua@moli.school",
  });
  const scholarId = await seedUser(t, "scholar", {
    name: "Hoku Makani",
    username: "hoku",
  });
  return await t.run(async (ctx) => {
    const unitId = await ctx.db.insert("units", {
      teacherId,
      title: "Ocean Physics Lab",
      isActive: true,
    });
    const lessonId = await ctx.db.insert("lessons", {
      unitId,
      title: "Buoyancy",
      order: 0,
    });
    const activityId = await ctx.db.insert("activities", {
      lessonId,
      title: "Build a hull",
      kind: "online",
      systemPrompt: "Investigate buoyancy.",
      order: 0,
    });
    const assignmentId = await ctx.db.insert("assignments", {
      teacherId,
      unitId,
      scholarIds: [scholarId],
      startedAt: 100,
    });
    const groupId = await ctx.db.insert("scholarGroups", {
      teacherId,
      name: "Geckos",
      scholarIds: [scholarId],
    });
    const summerPeriodId = await ctx.db.insert("reportingPeriods", {
      label: "Summer Session",
      startsAt: 100,
      endsAt: 200,
      status: "writing",
    });
    const fallPeriodId = await ctx.db.insert("reportingPeriods", {
      label: "Fall 2026",
      startsAt: 300,
      endsAt: 400,
      status: "open",
    });
    const summerBlockId = await ctx.db.insert("scheduleBlocks", {
      periodId: summerPeriodId,
      key: "block-a",
      label: "Block A",
      startLocal: "08:30",
      endLocal: "09:40",
      weekdays: [1, 2, 3, 4, 5],
      order: 0,
    });
    const fallBlockId = await ctx.db.insert("scheduleBlocks", {
      periodId: fallPeriodId,
      key: "block-a",
      label: "Block A",
      startLocal: "08:30",
      endLocal: "09:40",
      weekdays: [1, 2, 3, 4, 5],
      order: 0,
    });
    for (const [periodId, blockId, weekday] of [
      [summerPeriodId, summerBlockId, 1],
      [summerPeriodId, summerBlockId, 2],
      [fallPeriodId, fallBlockId, 3],
    ] as const) {
      await ctx.db.insert("schedulePlacements", {
        periodId,
        groupId,
        blockId,
        weekday,
        subject: "Ocean Physics",
        assignmentId,
        activityId,
      });
    }
    return {
      teacherId,
      scholarId,
      unitId,
      lessonId,
      activityId,
      assignmentId,
    };
  });
}

describe("adminTermTools.createTestTerm", () => {
  test("copies blocks verbatim and only named-group recurring class meetings", async () => {
    const t = convexTest(schema, modules);
    const fixture = await seedTermFixture(t);

    const result = await t.mutation(adminTermTools.createTestTerm, {
      fromPeriodLabel: "Fall 2026",
      label: "Summer Session",
      startsAt: 100,
      endsAt: 900,
      groupName: "Geckos",
    });

    expect(result).toMatchObject({ blocks: 2, placements: 2 });
    expect(result.periodId).not.toBeNull();
    const stored = await t.run(async (ctx) => {
      const period = await ctx.db.get(result.periodId!);
      const sourceBlocks = await ctx.db
        .query("scheduleBlocks")
        .withIndex("by_period", (q) =>
          q.eq("periodId", fixture.sourcePeriodId),
        )
        .collect();
      const blocks = await ctx.db
        .query("scheduleBlocks")
        .withIndex("by_period", (q) => q.eq("periodId", result.periodId!))
        .collect();
      const placements = await ctx.db
        .query("schedulePlacements")
        .withIndex("by_period", (q) => q.eq("periodId", result.periodId!))
        .collect();
      return { period, sourceBlocks, blocks, placements };
    });

    expect(stored.period).toMatchObject({
      label: "Summer Session",
      status: "writing",
      institutionId: fixture.institutionId,
    });
    const blockFields = (block: Doc<"scheduleBlocks">) => ({
      key: block.key,
      label: block.label,
      startLocal: block.startLocal,
      endLocal: block.endLocal,
      weekdays: block.weekdays,
      order: block.order,
      staffNeed: block.staffNeed,
      kind: block.kind,
      groupId: block.groupId,
    });
    expect(stored.blocks.map(blockFields)).toEqual(
      stored.sourceBlocks.map(blockFields),
    );
    expect(stored.placements.map((placement) => placement.subject).sort()).toEqual(
      ["Ocean Physics", "Writing Workshop"],
    );
    const ocean = stored.placements.find(
      (placement) => placement.subject === "Ocean Physics",
    );
    const copiedBlock = stored.blocks.find((block) => block.key === "block-a");
    expect(ocean).toMatchObject({
      blockId: copiedBlock?._id,
      groupId: fixture.groupId,
      weekday: 1,
      teacherId: fixture.teacherId,
      mode: "classFocus",
      spanBlocks: 2,
      note: "Bring models",
    });
    expect(ocean).not.toHaveProperty("assignmentId");
    expect(ocean).not.toHaveProperty("activityId");
    expect(ocean).not.toHaveProperty("sequenceId");
    expect(ocean).not.toHaveProperty("sequenceIndex");
    expect(ocean).not.toHaveProperty("weekStartMs");
    expect(ocean).not.toHaveProperty("createdFromStrategy");
  });

  test("dry run validates and reports counts without writes", async () => {
    const t = convexTest(schema, modules);
    await seedTermFixture(t);

    const result = await t.mutation(adminTermTools.createTestTerm, {
      fromPeriodLabel: "Fall 2026",
      label: "Summer Session",
      startsAt: 100,
      endsAt: 900,
      groupName: "Geckos",
      dryRun: true,
    });

    expect(result).toEqual({ periodId: null, blocks: 2, placements: 2 });
    const summerRows = await t.run(async (ctx) => {
      const periods = await ctx.db.query("reportingPeriods").collect();
      return periods.filter((period) => period.label === "Summer Session");
    });
    expect(summerRows).toEqual([]);
  });

  test("refuses overlap with the source and duplicate labels", async () => {
    const t = convexTest(schema, modules);
    await seedTermFixture(t);

    await expect(
      t.mutation(adminTermTools.createTestTerm, {
        fromPeriodLabel: "Fall 2026",
        label: "Overlapping Session",
        startsAt: 900,
        endsAt: 1_100,
        groupName: "Geckos",
      }),
    ).rejects.toThrow("overlaps source period");
    await expect(
      t.mutation(adminTermTools.createTestTerm, {
        fromPeriodLabel: "Fall 2026",
        label: "Fall 2026",
        startsAt: 100,
        endsAt: 900,
        groupName: "Geckos",
      }),
    ).rejects.toThrow("already exists");
  });
});

describe("adminTermTools.endTestTerm", () => {
  test("closes the test term and deletes every schedule row", async () => {
    const t = convexTest(schema, modules);
    const fixture = await seedTermFixture(t);
    const created = await t.mutation(adminTermTools.createTestTerm, {
      fromPeriodLabel: "Fall 2026",
      label: "Summer Session",
      startsAt: 100,
      endsAt: 900,
      groupName: "Geckos",
    });
    await t.run(async (ctx) => {
      const block = await ctx.db
        .query("scheduleBlocks")
        .withIndex("by_period", (q) => q.eq("periodId", created.periodId!))
        .first();
      await ctx.db.insert("schedulePlacements", {
        periodId: created.periodId!,
        groupId: fixture.groupId,
        blockId: block!._id,
        weekday: 4,
        subject: "Concrete chip",
        weekStartMs: 50_000,
      });
    });

    const result = await t.mutation(adminTermTools.endTestTerm, {
      label: "Summer Session",
      expectSourceLabel: "Fall 2026",
      deleteRows: true,
    });

    expect(result).toMatchObject({ blocks: 2, placements: 3 });
    const stored = await t.run(async (ctx) => ({
      period: await ctx.db.get(created.periodId!),
      blocks: await ctx.db
        .query("scheduleBlocks")
        .withIndex("by_period", (q) => q.eq("periodId", created.periodId!))
        .collect(),
      placements: await ctx.db
        .query("schedulePlacements")
        .withIndex("by_period", (q) => q.eq("periodId", created.periodId!))
        .collect(),
    }));
    expect(stored.period?.status).toBe("closed");
    expect(stored.blocks).toEqual([]);
    expect(stored.placements).toEqual([]);
  });

  test("refuses before writes when the expected source is not open", async () => {
    const t = convexTest(schema, modules);
    const fixture = await seedTermFixture(t);
    const created = await t.mutation(adminTermTools.createTestTerm, {
      fromPeriodLabel: "Fall 2026",
      label: "Summer Session",
      startsAt: 100,
      endsAt: 900,
      groupName: "Geckos",
    });
    await t.run(async (ctx) => {
      await ctx.db.patch(fixture.sourcePeriodId, { status: "closed" });
    });

    await expect(
      t.mutation(adminTermTools.endTestTerm, {
        label: "Summer Session",
        expectSourceLabel: "Fall 2026",
        deleteRows: true,
      }),
    ).rejects.toThrow("status open");
    const stored = await t.run(async (ctx) => ({
      period: await ctx.db.get(created.periodId!),
      blocks: await ctx.db
        .query("scheduleBlocks")
        .withIndex("by_period", (q) => q.eq("periodId", created.periodId!))
        .collect(),
    }));
    expect(stored.period?.status).toBe("writing");
    expect(stored.blocks).toHaveLength(2);
  });
});

describe("adminTermTools.unassignAssignment", () => {
  test("reports a dry run, then deletes the assignment and all placements", async () => {
    const t = convexTest(schema, modules);
    const fixture = await seedAssignmentFixture(t);

    const dryRun = await t.mutation(adminTermTools.unassignAssignment, {
      assignmentId: fixture.assignmentId,
      expectUnitTitle: "physics",
      expectTeacherEmail: "lehua@moli.school",
      dryRun: true,
    });
    expect(dryRun).toEqual({
      deletedPlacements: 3,
      deletedAssignment: false,
      unitTitle: "Ocean Physics Lab",
      cohortSize: 1,
      placementsByPeriod: {
        "Summer Session": 2,
        "Fall 2026": 1,
      },
    });

    const result = await t.mutation(adminTermTools.unassignAssignment, {
      assignmentId: fixture.assignmentId,
      expectUnitTitle: "OCEAN PHYSICS",
      expectTeacherEmail: "lehua@moli.school",
    });
    expect(result).toEqual({
      deletedPlacements: 3,
      deletedAssignment: true,
    });
    const stored = await t.run(async (ctx) => ({
      assignment: await ctx.db.get(fixture.assignmentId),
      placements: (await ctx.db.query("schedulePlacements").collect()).filter(
        (placement) => placement.assignmentId === fixture.assignmentId,
      ),
    }));
    expect(stored.assignment).toBeNull();
    expect(stored.placements).toEqual([]);
  });

  test("refuses when an activity completion is attached", async () => {
    const t = convexTest(schema, modules);
    const fixture = await seedAssignmentFixture(t);
    await t.run(async (ctx) => {
      await ctx.db.insert("activityCompletions", {
        scholarId: fixture.scholarId,
        activityId: fixture.activityId,
        lessonId: fixture.lessonId,
        unitId: fixture.unitId,
        completedAt: 1_000,
        assignmentId: fixture.assignmentId,
      });
    });

    await expect(
      t.mutation(adminTermTools.unassignAssignment, {
        assignmentId: fixture.assignmentId,
        expectUnitTitle: "Ocean Physics",
        expectTeacherEmail: "lehua@moli.school",
      }),
    ).rejects.toThrow(
      "activityCompletions=1, deliverables=0, sessions=0",
    );
    expect(
      await t.run(async (ctx) => ctx.db.get(fixture.assignmentId)),
    ).not.toBeNull();
  });

  test("refuses a wrong expected unit title", async () => {
    const t = convexTest(schema, modules);
    const fixture = await seedAssignmentFixture(t);

    await expect(
      t.mutation(adminTermTools.unassignAssignment, {
        assignmentId: fixture.assignmentId,
        expectUnitTitle: "Botany",
        expectTeacherEmail: "lehua@moli.school",
      }),
    ).rejects.toThrow("does not contain expected title");
    expect(
      await t.run(async (ctx) => ctx.db.get(fixture.assignmentId)),
    ).not.toBeNull();
  });
});

describe("adminTermTools.addScholarToAssignment", () => {
  test("adds exactly one scholar to one assignment, idempotently", async () => {
    const t = convexTest(schema, modules);
    const ids = await t.run(async (ctx) => {
      const teacherId = await ctx.db.insert("users", {
        username: "t1", name: "T", role: "teacher",
      });
      const scholarId = await ctx.db.insert("users", {
        username: "new_kid", name: "New Kid", role: "scholar",
      });
      const otherId = await ctx.db.insert("users", {
        username: "old_kid", name: "Old Kid", role: "scholar",
      });
      const unitId = await ctx.db.insert("units", { title: "U", teacherId, isActive: true });
      const assignmentId = await ctx.db.insert("assignments", {
        teacherId, unitId, scholarIds: [otherId], startedAt: 1,
        activitySchedule: [],
      });
      const untouchedId = await ctx.db.insert("assignments", {
        teacherId, unitId, scholarIds: [otherId], startedAt: 1,
        activitySchedule: [],
      });
      return { assignmentId, untouchedId, scholarId };
    });
    const first = await t.mutation(
      adminTermTools.addScholarToAssignment,
      { assignmentId: ids.assignmentId, username: "new_kid" },
    );
    expect(first).toEqual({ added: true, rosterSize: 2 });
    const second = await t.mutation(
      adminTermTools.addScholarToAssignment,
      { assignmentId: ids.assignmentId, username: "new_kid" },
    );
    expect(second).toEqual({ added: false, rosterSize: 2 });
    await t.run(async (ctx) => {
      const touched = await ctx.db.get(ids.assignmentId);
      const untouched = await ctx.db.get(ids.untouchedId);
      expect(touched?.scholarIds).toHaveLength(2);
      expect(untouched?.scholarIds).toHaveLength(1);
      expect(untouched?.scholarIds.map(String)).not.toContain(
        String(ids.scholarId),
      );
    });
  });
});
