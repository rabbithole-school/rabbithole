import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "../schema";
import { internal } from "../_generated/api";

const modules = (
  import.meta as ImportMeta & { glob: (pattern: string) => Record<string, () => Promise<unknown>> }
).glob("../**/*.ts");
const DAY = 86_400_000;

async function setup(t: ReturnType<typeof convexTest>) {
  return t.run(async ctx => {
    const institutionId = await ctx.db.insert("institutions", {
      slug: "moli", name: "Primary", kind: "school", isPrimary: true, timeZone: "Pacific/Honolulu",
    });
    const people = await Promise.all(["Humanities", "Science", "PE"].map(async (name) => {
      const id = await ctx.db.insert("users", { name, username: name.toLowerCase(), role: "teacher" });
      await ctx.db.insert("memberships", { userId: id, role: "teacher", institutionId });
      return id;
    }));
    const groups = await Promise.all(["Geckos", "Seals"].map(name => ctx.db.insert("scholarGroups", {
      institutionId, teacherId: people[0]!, name, scholarIds: [],
    })));
    const periodId = await ctx.db.insert("reportingPeriods", {
      institutionId, label: "Current", startsAt: Date.now() - DAY, endsAt: Date.now() + DAY, status: "open",
    });
    return { institutionId, people, groups, periodId };
  });
}

const scheduleArgs = {
  humanitiesStaffName: "Humanities", scienceStaffName: "Science", physicalEducationStaffName: "PE",
};

describe("production block schedule seed", () => {
  test("roster dry run is write-free and apply is idempotent", async () => {
    const t = convexTest(schema, modules);
    const { institutionId } = await setup(t);
    const payload = {
      people: [
        { key: "teacher", name: "Roster Teacher", username: "roster-teacher", role: "teacher" as const },
        { key: "scholar", name: "Roster Scholar", username: "roster-scholar", role: "scholar" as const },
      ],
      groups: [{ name: "Roster Group", scholarKeys: ["scholar"], creatorKey: "teacher" }],
    };
    const dry = await t.mutation(internal.seed.prodBlockSchedule.importDevRoster, { ...payload, dryRun: true });
    expect(dry).toMatchObject({ usersCreated: 2, groupsCreated: 1 });
    expect(await t.run(ctx => ctx.db.query("users").withIndex("by_username", q => q.eq("username", "roster-scholar")).collect())).toEqual([]);
    await t.mutation(internal.seed.prodBlockSchedule.importDevRoster, payload);
    const again = await t.mutation(internal.seed.prodBlockSchedule.importDevRoster, payload);
    expect(again).toMatchObject({ usersCreated: 0, groupsCreated: 0, groupsUpdated: 0 });
    const scholar = await t.run(ctx => ctx.db.query("users").withIndex("by_username", q => q.eq("username", "roster-scholar")).unique());
    expect(scholar?.institutionId).toEqual(institutionId);
  });

  test("roster import never moves a scholar between institutions", async () => {
    const t = convexTest(schema, modules);
    await setup(t);
    const guestInstitutionId = await t.run((ctx) =>
      ctx.db.insert("institutions", {
        slug: "guests",
        name: "Guests",
        kind: "guest",
        isPrimary: false,
        timeZone: "Pacific/Honolulu",
      }),
    );
    await t.run((ctx) =>
      ctx.db.insert("users", {
        name: "Existing guest",
        username: "existing-guest",
        role: "scholar",
        institutionId: guestInstitutionId,
      }),
    );

    await expect(
      t.mutation(internal.seed.prodBlockSchedule.importDevRoster, {
        people: [
          {
            key: "scholar",
            name: "Existing guest",
            username: "existing-guest",
            role: "scholar",
          },
        ],
        groups: [],
        dryRun: true,
      }),
    ).rejects.toThrow("belongs to another institution");
    const scholar = await t.run((ctx) =>
      ctx.db
        .query("users")
        .withIndex("by_username", (q) => q.eq("username", "existing-guest"))
        .unique(),
    );
    expect(scholar?.institutionId).toEqual(guestInstitutionId);
  });

  test("dry run is write-free; apply builds the 48-cell matrix and rerun is a no-op", async () => {
    const t = convexTest(schema, modules);
    const { institutionId, periodId, groups } = await setup(t);
    const {
      foreignPeriodId,
      foreignPlacementId,
      unrelatedPeriodId,
      unrelatedPlacementId,
    } = await t.run(async (ctx) => {
      const foreignInstitutionId = await ctx.db.insert("institutions", {
        slug: "guests",
        name: "Guests",
        kind: "guest",
        isPrimary: false,
        timeZone: "Pacific/Honolulu",
      });
      const foreignTeacherId = await ctx.db.insert("users", {
        name: "Humanities",
        username: "foreign-humanities",
        role: "teacher",
      });
      await ctx.db.insert("memberships", {
        userId: foreignTeacherId,
        role: "teacher",
        institutionId: foreignInstitutionId,
      });
      const foreignGroupId = await ctx.db.insert("scholarGroups", {
        institutionId: foreignInstitutionId,
        teacherId: foreignTeacherId,
        name: "Foreign group",
        scholarIds: [],
      });
      const foreignPeriodId = await ctx.db.insert("reportingPeriods", {
        institutionId: foreignInstitutionId,
        label: "Foreign",
        startsAt: Date.now() - DAY,
        endsAt: Date.now() + DAY,
        status: "open",
      });
      const foreignBlockId = await ctx.db.insert("scheduleBlocks", {
        periodId: foreignPeriodId,
        key: "foreign",
        label: "Foreign",
        startLocal: "08:00",
        endLocal: "09:00",
        weekdays: [1],
        order: 0,
      });
      const foreignPlacementId = await ctx.db.insert("schedulePlacements", {
        periodId: foreignPeriodId,
        groupId: foreignGroupId,
        weekday: 1,
        blockId: foreignBlockId,
        subject: "Foreign",
      });
      const unrelatedPeriodId = await ctx.db.insert("reportingPeriods", {
        institutionId,
        label: "Prior",
        startsAt: Date.now() - 3 * DAY,
        endsAt: Date.now() - 2 * DAY,
        status: "closed",
      });
      const unrelatedBlockId = await ctx.db.insert("scheduleBlocks", {
        periodId: unrelatedPeriodId,
        key: "prior",
        label: "Prior",
        startLocal: "08:00",
        endLocal: "09:00",
        weekdays: [1],
        order: 0,
      });
      const unrelatedPlacementId = await ctx.db.insert("schedulePlacements", {
        periodId: unrelatedPeriodId,
        groupId: groups[0]!,
        weekday: 1,
        blockId: unrelatedBlockId,
        subject: "Prior",
      });
      return {
        foreignPeriodId,
        foreignPlacementId,
        unrelatedPeriodId,
        unrelatedPlacementId,
      };
    });
    const dry = await t.mutation(internal.seed.prodBlockSchedule.reconcileBlockSchedule, { ...scheduleArgs, dryRun: true });
    expect(dry).toMatchObject({ blocksCreated: 9, placementsCreated: 48, managedPlacements: 48 });
    expect(await t.run(ctx => ctx.db.query("scheduleBlocks").withIndex("by_period", q => q.eq("periodId", periodId)).collect())).toHaveLength(0);
    const applied = await t.mutation(internal.seed.prodBlockSchedule.reconcileBlockSchedule, scheduleArgs);
    expect(applied).toMatchObject({ blocksCreated: 9, placementsCreated: 48, managedPlacements: 48 });
    const rows = await t.run(ctx => ctx.db.query("schedulePlacements").withIndex("by_period", q => q.eq("periodId", periodId)).collect());
    expect(rows).toHaveLength(48);
    expect(await t.run(ctx => ctx.db.get(foreignPlacementId))).toMatchObject({ periodId: foreignPeriodId });
    expect(await t.run(ctx => ctx.db.get(unrelatedPlacementId))).toMatchObject({ periodId: unrelatedPeriodId });
    const blocks = await t.run(ctx => ctx.db.query("scheduleBlocks").withIndex("by_period", q => q.eq("periodId", periodId)).collect());
    const byKey = new Map(blocks.map(b => [b.key, b]));
    const holoholo = rows.filter(r => r.weekday === 5 && r.blockId === byKey.get("block-c")?._id);
    expect(holoholo.map(r => [r.groupId, r.subject, r.spanBlocks]).sort()).toEqual(
      [[groups[0], "Holoholo", 5], [groups[1], "Holoholo", 5]].sort(),
    );
    const rerun = await t.mutation(internal.seed.prodBlockSchedule.reconcileBlockSchedule, scheduleArgs);
    expect(rerun).toMatchObject({ blocksCreated: 0, blocksUpdated: 0, placementsCreated: 0, placementsDeleted: 0 });
  });

  test("resolves and stamps legacy groups only from primary-institution scholars", async () => {
    const t = convexTest(schema, modules);
    const { institutionId, groups } = await setup(t);
    const scholars = await t.run(async (ctx) =>
      Promise.all(
        groups.map((_, index) =>
          ctx.db.insert("users", {
            name: `Primary scholar ${index}`,
            username: `primary-scholar-${index}`,
            role: "scholar",
            institutionId,
          }),
        ),
      ),
    );
    await t.run(async (ctx) => {
      for (let index = 0; index < groups.length; index++) {
        await ctx.db.patch(groups[index]!, {
          institutionId: undefined,
          scholarIds: [scholars[index]!],
        });
      }
    });

    const dry = await t.mutation(
      internal.seed.prodBlockSchedule.reconcileBlockSchedule,
      { ...scheduleArgs, dryRun: true },
    );
    expect(dry).toMatchObject({ groupsStamped: 2, placementsCreated: 48 });
    expect(
      await t.run(async (ctx) =>
        Promise.all(
          groups.map(
            async (groupId) =>
              (await ctx.db.get(groupId))?.institutionId === undefined,
          ),
        ),
      ),
    ).toEqual([true, true]);

    const applied = await t.mutation(
      internal.seed.prodBlockSchedule.reconcileBlockSchedule,
      scheduleArgs,
    );
    expect(applied).toMatchObject({ groupsStamped: 2, placementsCreated: 48 });
    const stamped = await t.run(async (ctx) =>
      Promise.all(groups.map((groupId) => ctx.db.get(groupId))),
    );
    expect(stamped.every((group) => group?.institutionId === institutionId)).toBe(true);
  });

  test("resolves stamped and legacy target groups from one candidate snapshot", async () => {
    const t = convexTest(schema, modules);
    const { institutionId, groups, people } = await setup(t);
    const foreignInstitutionId = await t.run((ctx) =>
      ctx.db.insert("institutions", {
        slug: "foreign",
        name: "Foreign",
        kind: "school",
        isPrimary: false,
        timeZone: "Pacific/Honolulu",
      }),
    );
    const [primaryScholarId, foreignScholarId] = await t.run(async (ctx) => [
      await ctx.db.insert("users", {
        name: "Primary scholar",
        username: "primary-scholar",
        role: "scholar",
        institutionId,
      }),
      await ctx.db.insert("users", {
        name: "Foreign scholar",
        username: "foreign-scholar",
        role: "scholar",
        institutionId: foreignInstitutionId,
      }),
    ]);
    await t.run(async (ctx) => {
      await ctx.db.patch(groups[1]!, {
        institutionId: undefined,
        scholarIds: [primaryScholarId],
      });
      await ctx.db.insert("scholarGroups", {
        teacherId: people[0]!,
        name: "Seals",
        scholarIds: [foreignScholarId],
      });
    });

    await expect(
      t.mutation(internal.seed.prodBlockSchedule.reconcileBlockSchedule, {
        ...scheduleArgs,
        dryRun: true,
      }),
    ).resolves.toMatchObject({
      groupsStamped: 1,
      placementsCreated: 48,
    });
  });

  test("never resolves an unstamped group whose scholars belong elsewhere", async () => {
    const t = convexTest(schema, modules);
    const { groups } = await setup(t);
    const foreignInstitutionId = await t.run((ctx) =>
      ctx.db.insert("institutions", {
        slug: "foreign",
        name: "Foreign",
        kind: "school",
        isPrimary: false,
        timeZone: "Pacific/Honolulu",
      }),
    );
    const foreignScholarId = await t.run((ctx) =>
      ctx.db.insert("users", {
        name: "Foreign scholar",
        username: "foreign-scholar",
        role: "scholar",
        institutionId: foreignInstitutionId,
      }),
    );
    await t.run((ctx) =>
      ctx.db.patch(groups[0]!, {
        institutionId: undefined,
        scholarIds: [foreignScholarId],
      }),
    );

    await expect(
      t.mutation(
        internal.seed.prodBlockSchedule.reconcileBlockSchedule,
        { ...scheduleArgs, dryRun: true },
      ),
    ).rejects.toThrow('group "Geckos": expected exactly one, found 0');
    expect(await t.run((ctx) => ctx.db.query("scheduleBlocks").collect())).toHaveLength(0);
  });

  test("preserves concrete rows, rejects work-linked conflicts, and only removes an empty Block E", async () => {
    const t = convexTest(schema, modules);
    const { periodId, groups, people } = await setup(t);
    const blockE = await t.run(ctx => ctx.db.insert("scheduleBlocks", {
      periodId, key: "block.e", label: "Block E", startLocal: "15:00", endLocal: "15:30", weekdays: [1, 2, 3, 4, 5], order: 10,
    }));
    await t.mutation(internal.seed.prodBlockSchedule.reconcileBlockSchedule, scheduleArgs);
    expect(await t.run(ctx => ctx.db.get(blockE))).toBeNull();
    const blocks = await t.run(ctx => ctx.db.query("scheduleBlocks").withIndex("by_period", q => q.eq("periodId", periodId)).collect());
    const a = blocks.find(b => b.key === "block-a")!;
    const unitId = await t.run(ctx => ctx.db.insert("units", { teacherId: people[0]!, title: "U", isActive: true }));
    const assignmentId = await t.run(ctx => ctx.db.insert("assignments", { teacherId: people[0]!, unitId, scholarIds: [], startedAt: Date.now(), activitySchedule: [] }));
    await t.run(ctx => ctx.db.insert("schedulePlacements", {
      periodId, groupId: groups[0]!, weekday: 1, blockId: a._id, subject: "Concrete", weekStartMs: 1,
    }));
    await t.run(ctx => ctx.db.insert("schedulePlacements", {
      periodId, groupId: groups[0]!, weekday: 1, blockId: a._id, subject: "Linked", assignmentId,
    }));
    await expect(t.mutation(internal.seed.prodBlockSchedule.reconcileBlockSchedule, scheduleArgs)).rejects.toThrow("Work-linked");
    const concrete = await t.run(ctx => ctx.db.query("schedulePlacements").collect());
    expect(concrete.some(r => r.weekStartMs === 1 && r.subject === "Concrete")).toBe(true);

    const occupiedE = await t.run(ctx => ctx.db.insert("scheduleBlocks", {
      periodId, key: "block.e", label: "Block E", startLocal: "15:00", endLocal: "15:30", weekdays: [1], order: 10,
    }));
    await t.run(ctx => ctx.db.insert("schedulePlacements", { periodId, groupId: groups[0]!, weekday: 1, blockId: occupiedE, subject: "Keep" }));
    await expect(t.mutation(internal.seed.prodBlockSchedule.reconcileBlockSchedule, scheduleArgs)).rejects.toThrow("occupied");
  });

  test("fails safely on ambiguous target groups", async () => {
    const t = convexTest(schema, modules);
    const { institutionId, people } = await setup(t);
    await t.run(ctx => ctx.db.insert("scholarGroups", {
      institutionId, teacherId: people[0]!, name: "Geckos", scholarIds: [],
    }));
    await expect(t.mutation(internal.seed.prodBlockSchedule.reconcileBlockSchedule, scheduleArgs)).rejects.toThrow("expected exactly one");
    expect(await t.run(ctx => ctx.db.query("scheduleBlocks").collect())).toHaveLength(0);
  });

  test("fails safely when reporting periods overlap today", async () => {
    const t = convexTest(schema, modules);
    const { institutionId } = await setup(t);
    await t.run((ctx) =>
      ctx.db.insert("reportingPeriods", {
        institutionId,
        label: "Overlapping",
        startsAt: Date.now() - DAY,
        endsAt: Date.now() + DAY,
        status: "writing",
      }),
    );

    await expect(
      t.mutation(
        internal.seed.prodBlockSchedule.reconcileBlockSchedule,
        scheduleArgs,
      ),
    ).rejects.toThrow("current reporting period");
    expect(await t.run((ctx) => ctx.db.query("scheduleBlocks").collect())).toHaveLength(0);
  });

  test("cleans only strict exact placed duplicates, dry-run first, then is idempotent", async () => {
    const t = convexTest(schema, modules);
    const { periodId, groups } = await setup(t);
    const blockId = await t.run((ctx) =>
      ctx.db.insert("scheduleBlocks", {
        periodId, key: "a", label: "A", startLocal: "08:00", endLocal: "09:00",
        weekdays: [1, 2, 3, 4, 5], order: 0,
      }),
    );
    const base = {
      periodId, groupId: groups[0]!, weekday: 1, blockId, subject: " Humanities ",
      teacherId: undefined, mode: undefined, spanBlocks: undefined, note: " plan ",
      sequenceId: undefined, sequenceIndex: undefined, orderOverride: undefined,
      dismissedFlags: undefined, createdFromStrategy: undefined,
    };
    await t.run(async (ctx) => {
      await ctx.db.insert("schedulePlacements", base);
      await ctx.db.insert("schedulePlacements", { ...base, subject: "humanities", note: "plan" });
    });

    const dry = await t.mutation(internal.seed.prodBlockSchedule.cleanupExactScheduleDuplicates, {});
    expect(dry).toMatchObject({
      dryRun: true, scannedPlacedRows: 2, duplicateClusters: 1, duplicateRows: 1, deleted: 0,
    });
    expect(await t.run((ctx) => ctx.db.query("schedulePlacements").collect())).toHaveLength(2);

    const applied = await t.mutation(internal.seed.prodBlockSchedule.cleanupExactScheduleDuplicates, {
      dryRun: false,
    });
    expect(applied).toMatchObject({ dryRun: false, duplicateClusters: 1, duplicateRows: 1, deleted: 1 });
    expect(await t.run((ctx) => ctx.db.query("schedulePlacements").collect())).toHaveLength(1);
    await expect(
      t.mutation(internal.seed.prodBlockSchedule.cleanupExactScheduleDuplicates, { dryRun: false }),
    ).resolves.toMatchObject({ duplicateClusters: 0, duplicateRows: 0, deleted: 0 });
  });

  test("dry-runs by default, then removes every exact dated bare shadow and is idempotent", async () => {
    const t = convexTest(schema, modules);
    const { periodId, groups, people } = await setup(t);
    const blockId = await t.run((ctx) =>
      ctx.db.insert("scheduleBlocks", {
        periodId, key: "a", label: "A", startLocal: "08:00", endLocal: "09:00",
        weekdays: [1, 2, 3, 4, 5], order: 0,
      }),
    );
    const recurringId = await t.run((ctx) =>
      ctx.db.insert("schedulePlacements", {
        periodId, groupId: groups[0]!, weekday: 1, blockId, subject: " Humanities ",
        teacherId: people[0]!, note: " plan ", mode: "classFocus",
      }),
    );
    await t.run(async (ctx) => {
      await ctx.db.insert("schedulePlacements", {
        periodId, groupId: groups[0]!, weekday: 1, blockId, subject: "humanities",
        teacherId: people[0]!, note: "plan", weekStartMs: 100,
      });
      await ctx.db.insert("schedulePlacements", {
        periodId, groupId: groups[0]!, weekday: 1, blockId, subject: "HUMANITIES",
        teacherId: people[0]!, note: " plan ", mode: "classFocus", weekStartMs: 200,
      });
    });

    const dry = await t.mutation(
      internal.seed.prodBlockSchedule.cleanupBareRecurringShadows,
      { periodId },
    );
    expect(dry).toMatchObject({
      dryRun: true,
      scope: { periodId, groupId: null },
      scannedRows: 3,
      recurringRows: 1,
      candidateClusters: 1,
      candidateDatedRows: 2,
      deletedRows: 0,
      isDone: true,
      nextCursor: null,
    });
    expect(await t.run((ctx) => ctx.db.query("schedulePlacements").collect())).toHaveLength(3);

    const applied = await t.mutation(
      internal.seed.prodBlockSchedule.cleanupBareRecurringShadows,
      { periodId, dryRun: false },
    );
    expect(applied).toMatchObject({
      dryRun: false, candidateClusters: 1, candidateDatedRows: 2, deletedRows: 2,
    });
    expect(await t.run((ctx) => ctx.db.get(recurringId))).not.toBeNull();
    expect(await t.run((ctx) => ctx.db.query("schedulePlacements").collect())).toHaveLength(1);
    await expect(
      t.mutation(internal.seed.prodBlockSchedule.cleanupBareRecurringShadows, {
        periodId,
        dryRun: false,
      }),
    ).resolves.toMatchObject({
      recurringRows: 1, candidateClusters: 0, candidateDatedRows: 0, deletedRows: 0,
    });
  });

  test("limits bare-shadow cleanup by period and group", async () => {
    const t = convexTest(schema, modules);
    const { periodId, groups } = await setup(t);
    const blockId = await t.run((ctx) =>
      ctx.db.insert("scheduleBlocks", {
        periodId, key: "a", label: "A", startLocal: "08:00", endLocal: "09:00",
        weekdays: [1, 2, 3, 4, 5], order: 0,
      }),
    );
    await t.run(async (ctx) => {
      for (const [groupId, subject] of [
        [groups[0]!, "One"],
        [groups[1]!, "Two"],
      ] as const) {
        await ctx.db.insert("schedulePlacements", {
          periodId, groupId, weekday: 1, blockId, subject,
        });
        await ctx.db.insert("schedulePlacements", {
          periodId, groupId, weekday: 1, blockId, subject, weekStartMs: 100,
        });
      }
    });

    const narrowDry = await t.mutation(
      internal.seed.prodBlockSchedule.cleanupBareRecurringShadows,
      { periodId, groupId: groups[0]! },
    );
    expect(narrowDry).toMatchObject({
      scope: { periodId, groupId: groups[0]! },
      scannedRows: 2, candidateClusters: 1, candidateDatedRows: 1, deletedRows: 0,
    });
    await t.mutation(internal.seed.prodBlockSchedule.cleanupBareRecurringShadows, {
      periodId, groupId: groups[0]!, dryRun: false,
    });
    expect(
      await t.run((ctx) =>
        ctx.db.query("schedulePlacements").withIndex("by_period_group", (q) =>
          q.eq("periodId", periodId).eq("groupId", groups[1]!),
        ).collect(),
      ),
    ).toHaveLength(2);

    await t.mutation(internal.seed.prodBlockSchedule.cleanupBareRecurringShadows, {
      periodId, groupId: groups[1]!, dryRun: false,
    });
    expect(await t.run((ctx) => ctx.db.query("schedulePlacements").collect())).toHaveLength(2);
  });

  test("uses bounded cursor batches within a period and group", async () => {
    const t = convexTest(schema, modules);
    const { periodId, groups } = await setup(t);
    const blockId = await t.run((ctx) =>
      ctx.db.insert("scheduleBlocks", {
        periodId, key: "a", label: "A", startLocal: "08:00", endLocal: "09:00",
        weekdays: [1, 2, 3, 4, 5], order: 0,
      }),
    );
    await t.run(async (ctx) => {
      for (const [subject, weekStartMs] of [
        ["First", 100],
        ["Second", 200],
      ] as const) {
        await ctx.db.insert("schedulePlacements", {
          periodId, groupId: groups[0]!, weekday: 1, blockId, subject,
        });
        await ctx.db.insert("schedulePlacements", {
          periodId, groupId: groups[0]!, weekday: 1, blockId, subject, weekStartMs,
        });
      }
    });

    const firstDry = await t.mutation(
      internal.seed.prodBlockSchedule.cleanupBareRecurringShadows,
      { periodId, groupId: groups[0]!, batchSize: 2 },
    );
    expect(firstDry).toMatchObject({
      dryRun: true, scannedRows: 2, candidateDatedRows: 1, deletedRows: 0, isDone: false,
    });
    expect(firstDry.nextCursor).toEqual(expect.any(String));
    expect(await t.run((ctx) => ctx.db.query("schedulePlacements").collect())).toHaveLength(4);

    const firstApply = await t.mutation(
      internal.seed.prodBlockSchedule.cleanupBareRecurringShadows,
      { periodId, groupId: groups[0]!, batchSize: 2, dryRun: false },
    );
    const secondApply = await t.mutation(
      internal.seed.prodBlockSchedule.cleanupBareRecurringShadows,
      {
        periodId,
        groupId: groups[0]!,
        batchSize: 2,
        dryRun: false,
        cursor: firstApply.nextCursor!,
      },
    );
    expect(firstApply).toMatchObject({ deletedRows: 1, candidateDatedRows: 1, isDone: false });
    expect(secondApply).toMatchObject({
      deletedRows: 1, candidateDatedRows: 1, isDone: true, nextCursor: null,
    });
    expect(await t.run((ctx) => ctx.db.query("schedulePlacements").collect())).toHaveLength(2);

    const finalApply = await t.mutation(
      internal.seed.prodBlockSchedule.cleanupBareRecurringShadows,
      { periodId, groupId: groups[0]!, dryRun: false },
    );
    expect(finalApply).toMatchObject({ candidateDatedRows: 0, deletedRows: 0, isDone: true });
    await expect(
      t.mutation(internal.seed.prodBlockSchedule.cleanupBareRecurringShadows, {
        periodId, groupId: groups[0]!, dryRun: false,
      }),
    ).resolves.toMatchObject({ candidateDatedRows: 0, deletedRows: 0 });
  });

  test("finds cross-page recurring twins throughout dry-run and apply continuations", async () => {
    const t = convexTest(schema, modules);
    const { periodId, groups } = await setup(t);
    const blockId = await t.run((ctx) =>
      ctx.db.insert("scheduleBlocks", {
        periodId, key: "a", label: "A", startLocal: "08:00", endLocal: "09:00",
        weekdays: [1, 2, 3, 4, 5], order: 0,
      }),
    );
    await t.run(async (ctx) => {
      for (const [weekday, subject] of [
        [1, "First"],
        [2, "Second"],
        [3, "Third"],
      ] as const) {
        await ctx.db.insert("schedulePlacements", {
          periodId, groupId: groups[0]!, weekday, blockId, subject,
        });
      }
      for (const [weekday, subject, weekStartMs] of [
        [1, "First", 100],
        [2, "Second", 200],
        [3, "Third", 300],
      ] as const) {
        await ctx.db.insert("schedulePlacements", {
          periodId, groupId: groups[0]!, weekday, blockId, subject, weekStartMs,
        });
      }
    });

    const firstDry = await t.mutation(
      internal.seed.prodBlockSchedule.cleanupBareRecurringShadows,
      { periodId, groupId: groups[0]!, batchSize: 3 },
    );
    expect(firstDry).toMatchObject({
      scannedRows: 3, recurringRows: 3, candidateDatedRows: 0, isDone: false,
    });
    const secondDry = await t.mutation(
      internal.seed.prodBlockSchedule.cleanupBareRecurringShadows,
      { periodId, groupId: groups[0]!, batchSize: 3, cursor: firstDry.nextCursor! },
    );
    expect(secondDry).toMatchObject({
      scannedRows: 3, recurringRows: 3, candidateClusters: 3,
      candidateDatedRows: 3, deletedRows: 0, isDone: true, nextCursor: null,
    });
    expect(await t.run((ctx) => ctx.db.query("schedulePlacements").collect())).toHaveLength(6);

    const firstApply = await t.mutation(
      internal.seed.prodBlockSchedule.cleanupBareRecurringShadows,
      { periodId, groupId: groups[0]!, batchSize: 3, dryRun: false },
    );
    const secondApply = await t.mutation(
      internal.seed.prodBlockSchedule.cleanupBareRecurringShadows,
      {
        periodId,
        groupId: groups[0]!,
        batchSize: 3,
        dryRun: false,
        cursor: firstApply.nextCursor!,
      },
    );
    expect(firstApply).toMatchObject({
      candidateDatedRows: 0, deletedRows: 0, isDone: false,
    });
    expect(secondApply).toMatchObject({
      candidateClusters: 3, candidateDatedRows: 3, deletedRows: 3, isDone: true,
    });
    expect(await t.run((ctx) => ctx.db.query("schedulePlacements").collect())).toHaveLength(3);
  });

  test("preserves linked, shelf, unmatched, and metadata-distinct dated rows", async () => {
    const t = convexTest(schema, modules);
    const { periodId, groups, people } = await setup(t);
    const otherTeacher = await t.run((ctx) =>
      ctx.db.insert("users", { name: "Other", username: "other-shadow", role: "teacher" }),
    );
    const blockId = await t.run((ctx) =>
      ctx.db.insert("scheduleBlocks", {
        periodId, key: "a", label: "A", startLocal: "08:00", endLocal: "09:00",
        weekdays: [1, 2, 3, 4, 5], order: 0,
      }),
    );
    const unitId = await t.run((ctx) =>
      ctx.db.insert("units", { teacherId: people[0]!, title: "U", isActive: true }),
    );
    const [assignmentId, activityId] = await t.run(async (ctx) => [
      await ctx.db.insert("assignments", {
        teacherId: people[0]!, unitId, scholarIds: [], startedAt: 1, activitySchedule: [],
      }),
      await ctx.db.insert("activities", { title: "A", kind: "online", systemPrompt: "...", order: 0 }),
    ]);
    const base = {
      periodId, groupId: groups[0]!, weekday: 1, blockId, subject: "Base",
      teacherId: people[0]!, note: "note", spanBlocks: 1, sequenceId: "sequence",
      sequenceIndex: 0, createdFromStrategy: "daily" as const,
    };
    await t.run(async (ctx) => {
      await ctx.db.insert("schedulePlacements", base);
      await ctx.db.insert("schedulePlacements", {
        ...base, subject: "Linked", assignmentId, activityId,
      });
      await ctx.db.insert("schedulePlacements", {
        ...base, subject: "Linked", assignmentId, activityId, weekStartMs: 100,
      });
      await ctx.db.insert("schedulePlacements", {
        ...base, subject: "No recurring twin", weekStartMs: 100,
      });
      for (const patch of [
        { teacherId: otherTeacher },
        { mode: "homework" as const },
        { spanBlocks: 2 },
        { note: "different note" },
        { sequenceId: "different-sequence" },
        { sequenceIndex: 1 },
        { orderOverride: true },
        { dismissedFlags: ["conflict"] },
        { createdFromStrategy: "sameDay" as const },
      ]) {
        await ctx.db.insert("schedulePlacements", { ...base, ...patch, weekStartMs: 100 });
      }
      await ctx.db.insert("schedulePlacements", { ...base, weekday: undefined, blockId: undefined });
      await ctx.db.insert("schedulePlacements", {
        ...base, weekday: undefined, blockId: undefined, weekStartMs: 100,
      });
    });

    const result = await t.mutation(
      internal.seed.prodBlockSchedule.cleanupBareRecurringShadows,
      { periodId, dryRun: false },
    );
    expect(result).toMatchObject({
      candidateClusters: 0, candidateDatedRows: 0, deletedRows: 0,
    });
    expect(await t.run((ctx) => ctx.db.query("schedulePlacements").collect())).toHaveLength(15);
  });

  test("preserves shells, concrete weeks, and every differing exact-key field including shelf rows", async () => {
    const t = convexTest(schema, modules);
    const { periodId, groups, people } = await setup(t);
    const otherTeacher = await t.run((ctx) =>
      ctx.db.insert("users", { name: "Other", username: "other", role: "teacher" }),
    );
    const blockId = await t.run((ctx) =>
      ctx.db.insert("scheduleBlocks", {
        periodId, key: "a", label: "A", startLocal: "08:00", endLocal: "09:00",
        weekdays: [1, 2, 3, 4, 5], order: 0,
      }),
    );
    const unitId = await t.run((ctx) =>
      ctx.db.insert("units", { teacherId: people[0]!, title: "U", isActive: true }),
    );
    const [assignmentId, otherAssignmentId, activityId, otherActivityId] = await t.run(async (ctx) => [
      await ctx.db.insert("assignments", { teacherId: people[0]!, unitId, scholarIds: [], startedAt: Date.now(), activitySchedule: [] }),
      await ctx.db.insert("assignments", { teacherId: people[0]!, unitId, scholarIds: [], startedAt: Date.now(), activitySchedule: [] }),
      await ctx.db.insert("activities", { title: "A1", kind: "online", systemPrompt: "...", order: 0 }),
      await ctx.db.insert("activities", { title: "A2", kind: "online", systemPrompt: "...", order: 1 }),
    ]);
    const common = {
      periodId, groupId: groups[0]!, weekday: 1, blockId, subject: "Humanities",
      teacherId: people[0]!, assignmentId, activityId, mode: "classFocus" as const,
      spanBlocks: 1, note: "note", sequenceId: "sequence", sequenceIndex: 0,
      orderOverride: false, dismissedFlags: ["a", "b"], createdFromStrategy: "classMeetings" as const,
    };
    await t.run(async (ctx) => {
      // A recurring linked chip and a concrete one intentionally coexist.
      await ctx.db.insert("schedulePlacements", common);
      await ctx.db.insert("schedulePlacements", { ...common, weekStartMs: 10 });
      // Different concrete weeks coexist.
      await ctx.db.insert("schedulePlacements", { ...common, weekStartMs: 17 });
      // Every remaining key-field variation is a distinct row.
      await ctx.db.insert("schedulePlacements", { ...common, teacherId: otherTeacher });
      await ctx.db.insert("schedulePlacements", { ...common, assignmentId: otherAssignmentId });
      await ctx.db.insert("schedulePlacements", { ...common, activityId: otherActivityId });
      await ctx.db.insert("schedulePlacements", { ...common, mode: "homework" });
      await ctx.db.insert("schedulePlacements", { ...common, spanBlocks: 2 });
      await ctx.db.insert("schedulePlacements", { ...common, note: "other" });
      await ctx.db.insert("schedulePlacements", { ...common, sequenceId: "other-sequence" });
      await ctx.db.insert("schedulePlacements", { ...common, sequenceIndex: 1 });
      await ctx.db.insert("schedulePlacements", { ...common, orderOverride: true });
      await ctx.db.insert("schedulePlacements", { ...common, dismissedFlags: ["a"] });
      await ctx.db.insert("schedulePlacements", { ...common, createdFromStrategy: "sameDay" });
      // Shelf rows are deliberately outside the cleanup scan.
      await ctx.db.insert("schedulePlacements", { ...common, weekday: undefined, blockId: undefined });
      await ctx.db.insert("schedulePlacements", { ...common, weekday: undefined, blockId: undefined });
    });

    const result = await t.mutation(internal.seed.prodBlockSchedule.cleanupExactScheduleDuplicates, {
      dryRun: false,
    });
    expect(result).toMatchObject({ duplicateClusters: 0, duplicateRows: 0, deleted: 0 });
    expect(await t.run((ctx) => ctx.db.query("schedulePlacements").collect())).toHaveLength(16);
  });

  test("collapses exact linked duplicates without changing the assignment schedule", async () => {
    const t = convexTest(schema, modules);
    const { periodId, groups, people } = await setup(t);
    const blockId = await t.run((ctx) =>
      ctx.db.insert("scheduleBlocks", {
        periodId, key: "a", label: "A", startLocal: "08:00", endLocal: "09:00",
        weekdays: [1, 2, 3, 4, 5], order: 0,
      }),
    );
    const unitId = await t.run((ctx) =>
      ctx.db.insert("units", { teacherId: people[0]!, title: "U", isActive: true }),
    );
    const activityId = await t.run((ctx) =>
      ctx.db.insert("activities", { title: "Activity", kind: "online", systemPrompt: "...", order: 0 }),
    );
    const assignmentId = await t.run((ctx) =>
      ctx.db.insert("assignments", {
        teacherId: people[0]!, unitId, scholarIds: [], startedAt: Date.now(),
        activitySchedule: [{ activityId, mode: "classFocus", startsAt: 1, setAt: 1 }],
      }),
    );
    const linked = {
      periodId, groupId: groups[0]!, weekday: 1, blockId, subject: "Humanities",
      teacherId: people[0]!, assignmentId, activityId, mode: "classFocus" as const,
    };
    await t.run(async (ctx) => {
      await ctx.db.insert("schedulePlacements", linked);
      await ctx.db.insert("schedulePlacements", linked);
    });

    await t.mutation(internal.seed.prodBlockSchedule.cleanupExactScheduleDuplicates, { dryRun: false });
    const assignment = await t.run((ctx) => ctx.db.get(assignmentId));
    expect(assignment!.activitySchedule).toEqual([
      { activityId, mode: "classFocus", startsAt: 1, setAt: 1 },
    ]);
    expect(await t.run((ctx) => ctx.db.query("schedulePlacements").collect())).toHaveLength(1);
  });

  test("refuses partial or broken links before deleting any duplicate", async () => {
    const t = convexTest(schema, modules);
    const { periodId, groups, people } = await setup(t);
    const blockId = await t.run((ctx) =>
      ctx.db.insert("scheduleBlocks", {
        periodId, key: "a", label: "A", startLocal: "08:00", endLocal: "09:00",
        weekdays: [1, 2, 3, 4, 5], order: 0,
      }),
    );
    const duplicate = { periodId, groupId: groups[0]!, weekday: 1, blockId, subject: "Duplicate" };
    await t.run(async (ctx) => {
      await ctx.db.insert("schedulePlacements", duplicate);
      await ctx.db.insert("schedulePlacements", duplicate);
      await ctx.db.insert("schedulePlacements", {
        periodId, groupId: groups[0]!, weekday: 2, blockId, subject: "Partial",
        assignmentId: await ctx.db.insert("assignments", {
          teacherId: people[0]!, scholarIds: [], startedAt: Date.now(), activitySchedule: [],
        }),
      });
    });
    await expect(
      t.mutation(internal.seed.prodBlockSchedule.cleanupExactScheduleDuplicates, { dryRun: false }),
    ).rejects.toThrow("partial assignment/activity link");
    expect(await t.run((ctx) => ctx.db.query("schedulePlacements").collect())).toHaveLength(3);

    await t.run(async (ctx) => {
      const partial = (await ctx.db.query("schedulePlacements").collect()).find((row) => row.subject === "Partial")!;
      await ctx.db.delete(partial._id);
      const activityId = await ctx.db.insert("activities", {
        title: "Deleted", kind: "online", systemPrompt: "...", order: 0,
      });
      const assignmentId = await ctx.db.insert("assignments", {
        teacherId: people[0]!, scholarIds: [], startedAt: Date.now(), activitySchedule: [],
      });
      await ctx.db.delete(activityId);
      await ctx.db.insert("schedulePlacements", {
        periodId, groupId: groups[0]!, weekday: 2, blockId, subject: "Broken", assignmentId, activityId,
      });
    });
    await expect(
      t.mutation(internal.seed.prodBlockSchedule.cleanupExactScheduleDuplicates, { dryRun: false }),
    ).rejects.toThrow("missing linked assignment or activity");
    expect(await t.run((ctx) => ctx.db.query("schedulePlacements").collect())).toHaveLength(3);
  });

  async function redundantAssignmentWorld() {
    const t = convexTest(schema, modules);
    const { institutionId, periodId, groups, people } = await setup(t);
    const scholars = await t.run(async (ctx) => Promise.all(
      Array.from({ length: 5 }, (_, index) =>
        ctx.db.insert("users", {
          name: `Scholar ${index}`, username: `schedule-scholar-${index}`, role: "scholar", institutionId,
        }),
      ),
    ));
    await t.run((ctx) => ctx.db.patch(groups[0]!, { scholarIds: scholars }));
    const [blockId, unitId, activityId] = await t.run(async (ctx) => [
      await ctx.db.insert("scheduleBlocks", {
        periodId, key: "a", label: "A", startLocal: "08:00", endLocal: "09:00",
        weekdays: [1, 2, 3, 4, 5], order: 0,
      }),
      await ctx.db.insert("units", { teacherId: people[0]!, title: "U", isActive: true }),
      await ctx.db.insert("activities", { title: "A", kind: "online", systemPrompt: "...", order: 0 }),
    ]);
    const [canonicalAssignmentId, redundantAssignmentId] = await t.run(async (ctx) => [
      await ctx.db.insert("assignments", {
        teacherId: people[0]!, unitId, scholarIds: scholars, startedAt: Date.now(), activitySchedule: [],
      }),
      await ctx.db.insert("assignments", {
        teacherId: people[0]!, unitId, scholarIds: scholars, startedAt: Date.now(),
        activitySchedule: [{ activityId, mode: "classFocus", startsAt: Date.now() - DAY }],
      }),
    ]);
    await t.run(async (ctx) => {
      await ctx.db.insert("sessions", {
        userId: scholars[0]!, unitId, activityId, assignmentId: canonicalAssignmentId,
        title: "Canonical work", isArchived: false,
      });
    });
    const canonicalPlacementId = await t.run((ctx) => ctx.db.insert("schedulePlacements", {
      periodId, groupId: groups[0]!, weekday: 1, blockId, weekStartMs: 1,
      subject: "Humanities", teacherId: people[0]!, assignmentId: canonicalAssignmentId, activityId,
    }));
    const redundantPlacementId = await t.run((ctx) => ctx.db.insert("schedulePlacements", {
      periodId, groupId: groups[0]!, weekday: 2, blockId, weekStartMs: 1,
      subject: "Humanities", teacherId: people[0]!, assignmentId: redundantAssignmentId, activityId,
      sequenceId: "redundant-sequence", sequenceIndex: 0,
    }));
    const args = {
      canonicalAssignmentId, redundantAssignmentId, expectedUnitId: unitId,
      expectedGroupName: "Geckos", expectedPlacementCount: 1, expectedPlannedEntryCount: 1,
    };
    return {
      t, institutionId, periodId, groups, people, scholars, blockId, unitId, activityId,
      canonicalAssignmentId, redundantAssignmentId, canonicalPlacementId, redundantPlacementId, args,
    };
  }

  test("archives only a proven redundant assignment schedule and is idempotent", async () => {
    const world = await redundantAssignmentWorld();
    await world.t.run((ctx) =>
      ctx.db.patch(world.groups[0]!, { institutionId: undefined }),
    );
    const dry = await world.t.mutation(
      internal.seed.prodBlockSchedule.archiveRedundantAssignmentSchedule,
      world.args,
    );
    expect(dry).toMatchObject({
      dryRun: true, alreadyApplied: false, plannedPlacementDeletes: 1, archived: false,
    });
    expect(
      await world.t.run(async (ctx) =>
        (await ctx.db.get(world.groups[0]!))?.institutionId === undefined,
      ),
    ).toBe(true);
    expect(await world.t.run((ctx) => ctx.db.get(world.redundantPlacementId))).not.toBeNull();

    const applied = await world.t.mutation(
      internal.seed.prodBlockSchedule.archiveRedundantAssignmentSchedule,
      { ...world.args, dryRun: false },
    );
    expect(applied).toMatchObject({
      dryRun: false, alreadyApplied: false, plannedPlacementDeletes: 1, archived: true,
    });
    const state = await world.t.run(async (ctx) => ({
      canonical: await ctx.db.get(world.canonicalAssignmentId),
      redundant: await ctx.db.get(world.redundantAssignmentId),
      canonicalPlacement: await ctx.db.get(world.canonicalPlacementId),
      redundantPlacement: await ctx.db.get(world.redundantPlacementId),
      sessions: await ctx.db.query("sessions").withIndex("by_assignment", q => q.eq("assignmentId", world.canonicalAssignmentId)).collect(),
    }));
    expect(state.canonical?.archivedAt).toBeUndefined();
    expect(state.redundant?.archivedAt).toBeDefined();
    expect(state.redundant?.activitySchedule).toEqual([]);
    expect(state.canonicalPlacement).not.toBeNull();
    expect(state.redundantPlacement).toBeNull();
    expect(state.sessions).toHaveLength(1);
    await expect(
      world.t.mutation(internal.seed.prodBlockSchedule.archiveRedundantAssignmentSchedule, {
        ...world.args, dryRun: false,
      }),
    ).resolves.toMatchObject({ alreadyApplied: true, plannedPlacementDeletes: 0, archived: false });
  });

  test("refuses assignment identity, schedule state, count, and placement-shape drift", async () => {
    const cases = [
      "roster", "unit", "group", "redundant-session", "live-entry", "scheduled-entry",
      "future-entry", "count", "planned-count", "cross-group", "cross-period", "shelf", "bare", "partial",
    ] as const;
    for (const kind of cases) {
      const world = await redundantAssignmentWorld();
      if (kind === "roster") {
        await world.t.run(async (ctx) => {
          const assignment = await ctx.db.get(world.redundantAssignmentId);
          await ctx.db.patch(world.redundantAssignmentId, { scholarIds: assignment!.scholarIds.slice(1) });
        });
      } else if (kind === "unit") {
        await world.t.run(async (ctx) => {
          const otherUnit = await ctx.db.insert("units", { teacherId: world.people[0]!, title: "Other", isActive: true });
          await ctx.db.patch(world.redundantAssignmentId, { unitId: otherUnit });
        });
      } else if (kind === "group") {
        await world.t.run((ctx) => ctx.db.patch(world.groups[0]!, { scholarIds: world.scholars.slice(1) }));
      } else if (kind === "redundant-session") {
        await world.t.run((ctx) => ctx.db.insert("sessions", {
          userId: world.scholars[0]!, assignmentId: world.redundantAssignmentId,
          title: "Unsafe work", isArchived: false,
        }));
      } else if (kind === "live-entry" || kind === "scheduled-entry" || kind === "future-entry") {
        await world.t.run(async (ctx) => {
          const assignment = await ctx.db.get(world.redundantAssignmentId);
          const entry = assignment!.activitySchedule![0]!;
          const scheduledFnId =
            kind === "scheduled-entry"
              ? await ctx.scheduler.runAfter(
                  DAY,
                  internal.seed.prodBlockSchedule.cleanupExactScheduleDuplicates,
                  {},
                )
              : undefined;
          await ctx.db.patch(world.redundantAssignmentId, {
            activitySchedule: [{
              ...entry,
              ...(kind === "live-entry" ? { setAt: Date.now() } : {}),
              ...(scheduledFnId ? { scheduledFnId } : {}),
              ...(kind === "future-entry" ? { startsAt: Date.now() + DAY } : {}),
            }],
          });
        });
      } else if (kind === "count") {
        world.args.expectedPlacementCount = 2;
      } else if (kind === "planned-count") {
        world.args.expectedPlannedEntryCount = 2;
      } else {
        await world.t.run(async (ctx) => {
          const patch =
            kind === "cross-group" ? { groupId: world.groups[1]! } :
            kind === "cross-period" ? { periodId: await ctx.db.insert("reportingPeriods", {
              institutionId: world.institutionId, label: "Other", startsAt: 0, endsAt: 1, status: "closed",
            }) } :
            kind === "shelf" ? { weekday: undefined, blockId: undefined } :
            kind === "bare" ? { assignmentId: undefined, activityId: undefined } :
            { activityId: undefined };
          await ctx.db.patch(world.redundantPlacementId, patch);
        });
      }
      await expect(
        world.t.mutation(internal.seed.prodBlockSchedule.archiveRedundantAssignmentSchedule, {
          ...world.args, dryRun: false,
        }),
      ).rejects.toThrow();
      expect(await world.t.run((ctx) => ctx.db.get(world.redundantPlacementId))).not.toBeNull();
      expect((await world.t.run((ctx) => ctx.db.get(world.redundantAssignmentId)))?.archivedAt).toBeUndefined();
    }
  });
});
