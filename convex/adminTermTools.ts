/**
 * One-shot internal tools for a production Summer Session dry run.
 *
 * These mutations intentionally bypass the teacher schedule helpers: copied
 * placements are bare recurring shells, so no assignment cascade runs until a
 * teacher explicitly uses the normal schedule flow.
 */
import { v } from "convex/values";
import { internalMutation } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";
import { settlePlacementAppPush } from "./masterSchedule";

async function periodByExactLabel(
  ctx: MutationCtx,
  label: string,
) {
  const periods = await ctx.db.query("reportingPeriods").collect();
  return periods.find((period) => period.label === label) ?? null;
}

export const createTestTerm = internalMutation({
  args: {
    fromPeriodLabel: v.string(),
    label: v.string(),
    startsAt: v.number(),
    endsAt: v.number(),
    groupName: v.string(),
    dryRun: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const existing = await periodByExactLabel(ctx, args.label);
    if (existing) {
      throw new Error(`Reporting period "${args.label}" already exists`);
    }

    const sourcePeriod = await periodByExactLabel(ctx, args.fromPeriodLabel);
    if (!sourcePeriod) {
      throw new Error(
        `Source reporting period "${args.fromPeriodLabel}" not found`,
      );
    }
    if (args.endsAt <= args.startsAt) {
      throw new Error("Test term end must be after its start");
    }
    const overlapsSource =
      args.startsAt <= sourcePeriod.endsAt &&
      args.endsAt >= sourcePeriod.startsAt;
    if (overlapsSource) {
      throw new Error(
        `Test term overlaps source period "${sourcePeriod.label}"`,
      );
    }

    const groups = await ctx.db.query("scholarGroups").collect();
    const group = groups.find((candidate) => candidate.name === args.groupName);
    if (!group) {
      throw new Error(`Scholar group "${args.groupName}" not found`);
    }

    const sourceBlocks = await ctx.db
      .query("scheduleBlocks")
      .withIndex("by_period", (q) => q.eq("periodId", sourcePeriod._id))
      .collect();
    const sourceBlockIds = new Set(sourceBlocks.map((block) => String(block._id)));
    const sourcePlacements = (
      await ctx.db
        .query("schedulePlacements")
        .withIndex("by_period_group", (q) =>
          q.eq("periodId", sourcePeriod._id).eq("groupId", group._id),
        )
        .collect()
    ).filter(
      (placement) =>
        placement.weekStartMs === undefined &&
        placement.weekday !== undefined &&
        placement.blockId !== undefined &&
        placement.mode !== "homework",
    );

    for (const placement of sourcePlacements) {
      if (
        placement.blockId === undefined ||
        !sourceBlockIds.has(String(placement.blockId))
      ) {
        throw new Error(
          `Placement ${placement._id} has no source block to remap by key`,
        );
      }
    }

    if (args.dryRun) {
      return {
        periodId: null,
        blocks: sourceBlocks.length,
        placements: sourcePlacements.length,
      };
    }

    const periodId = await ctx.db.insert("reportingPeriods", {
      label: args.label,
      startsAt: args.startsAt,
      endsAt: args.endsAt,
      status: "writing",
      institutionId: sourcePeriod.institutionId,
    });
    const blockIdMap = new Map<string, Id<"scheduleBlocks">>();
    for (const block of sourceBlocks) {
      const newBlockId = await ctx.db.insert("scheduleBlocks", {
        periodId,
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
      blockIdMap.set(String(block._id), newBlockId);
    }

    for (const placement of sourcePlacements) {
      const blockId = blockIdMap.get(String(placement.blockId));
      if (!blockId) {
        throw new Error(
          `Placement ${placement._id} has no copied block matching its source key`,
        );
      }
      await ctx.db.insert("schedulePlacements", {
        periodId,
        blockId,
        subject: placement.subject,
        weekday: placement.weekday,
        teacherId: placement.teacherId,
        mode: placement.mode,
        spanBlocks: placement.spanBlocks,
        note: placement.note,
        groupId: placement.groupId,
      });
    }

    return {
      periodId,
      blocks: sourceBlocks.length,
      placements: sourcePlacements.length,
    };
  },
});

export const endTestTerm = internalMutation({
  args: {
    label: v.string(),
    expectSourceLabel: v.string(),
    deleteRows: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const period = await periodByExactLabel(ctx, args.label);
    if (!period) {
      throw new Error(`Reporting period "${args.label}" not found`);
    }
    if (period.status !== "writing") {
      throw new Error(
        `Reporting period "${args.label}" must have status writing`,
      );
    }

    const sourcePeriod = await periodByExactLabel(ctx, args.expectSourceLabel);
    if (!sourcePeriod || sourcePeriod.status !== "open") {
      throw new Error(
        `Expected source period "${args.expectSourceLabel}" to exist with status open`,
      );
    }

    const blocks = await ctx.db
      .query("scheduleBlocks")
      .withIndex("by_period", (q) => q.eq("periodId", period._id))
      .collect();
    const placements = await ctx.db
      .query("schedulePlacements")
      .withIndex("by_period", (q) => q.eq("periodId", period._id))
      .collect();

    await ctx.db.patch(period._id, { status: "closed" });
    if (args.deleteRows) {
      for (const placement of placements) {
        // Not scoped to activity/assignment-linked rows the way the teacher
        // schedule helpers usually are — a standing-assignment app placement
        // (schedulePlacements.externalAppId) can be among these, and its
        // push must be settled before the row disappears (see
        // masterSchedule.settlePlacementAppPush).
        await settlePlacementAppPush(ctx, placement);
        await ctx.db.delete(placement._id);
      }
      for (const block of blocks) {
        await ctx.db.delete(block._id);
      }
    }

    return {
      periodId: period._id,
      blocks: args.deleteRows ? blocks.length : 0,
      placements: args.deleteRows ? placements.length : 0,
    };
  },
});

export const unassignAssignment = internalMutation({
  args: {
    assignmentId: v.id("assignments"),
    expectUnitTitle: v.string(),
    expectTeacherEmail: v.string(),
    dryRun: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const assignment = await ctx.db.get(args.assignmentId);
    if (!assignment) {
      throw new Error(`Assignment ${args.assignmentId} not found`);
    }
    if (!assignment.unitId) {
      throw new Error(`Assignment ${args.assignmentId} has no unit`);
    }

    const unit = await ctx.db.get(assignment.unitId);
    if (!unit) {
      throw new Error(`Unit ${assignment.unitId} not found`);
    }
    if (
      !unit.title
        .toLowerCase()
        .includes(args.expectUnitTitle.toLowerCase())
    ) {
      throw new Error(
        `Unit title "${unit.title}" does not contain expected title "${args.expectUnitTitle}"`,
      );
    }

    const teacher = await ctx.db.get(assignment.teacherId);
    if (!teacher) {
      throw new Error(`Teacher ${assignment.teacherId} not found`);
    }
    if (teacher.email !== args.expectTeacherEmail) {
      throw new Error(
        `Teacher email does not match expected email "${args.expectTeacherEmail}"`,
      );
    }

    const activityCompletions = await ctx.db
      .query("activityCompletions")
      .withIndex("by_assignment", (q) =>
        q.eq("assignmentId", assignment._id),
      )
      .collect();
    const deliverables = await ctx.db
      .query("deliverables")
      .withIndex("by_assignment_activity", (q) =>
        q.eq("assignmentId", assignment._id),
      )
      .collect();
    const sessions = await ctx.db
      .query("sessions")
      .withIndex("by_assignment", (q) =>
        q.eq("assignmentId", assignment._id),
      )
      .collect();
    if (
      activityCompletions.length > 0 ||
      deliverables.length > 0 ||
      sessions.length > 0
    ) {
      throw new Error(
        "Assignment has attached scholar work: " +
          `activityCompletions=${activityCompletions.length}, ` +
          `deliverables=${deliverables.length}, sessions=${sessions.length}`,
      );
    }

    const placements = (
      await ctx.db.query("schedulePlacements").collect()
    ).filter((placement) => placement.assignmentId === assignment._id);
    if (args.dryRun) {
      const periods = await ctx.db.query("reportingPeriods").collect();
      const periodLabels = new Map(
        periods.map((period) => [String(period._id), period.label]),
      );
      const placementsByPeriod: Record<string, number> = {};
      for (const placement of placements) {
        const label =
          periodLabels.get(String(placement.periodId)) ??
          `missing:${placement.periodId}`;
        placementsByPeriod[label] = (placementsByPeriod[label] ?? 0) + 1;
      }
      return {
        deletedPlacements: placements.length,
        deletedAssignment: false,
        unitTitle: unit.title,
        cohortSize: assignment.scholarIds.length,
        placementsByPeriod,
      };
    }

    for (const placement of placements) {
      // `placements` is filtered to `assignmentId === assignment._id`
      // (above), which is mutually exclusive with an app-target placement's
      // externalAppId — so this is provably a no-op here. Called anyway so
      // every schedulePlacements deletion path in the codebase routes
      // through the one shared settle helper, not just the ones a reviewer
      // happened to reason through by hand.
      await settlePlacementAppPush(ctx, placement);
      await ctx.db.delete(placement._id);
    }
    await ctx.db.delete(assignment._id);
    return {
      deletedPlacements: placements.length,
      deletedAssignment: true,
    };
  },
});

/**
 * Add one scholar to ONE specific assignment's roster (assignments snapshot
 * their roster at creation, so joining a scholarGroup later does not join its
 * existing assignments). devPilot.addToAssignmentByUnitTitle patches every
 * live assignment on the unit — too blunt when two cohorts share a unit.
 */
export const addScholarToAssignment = internalMutation({
  args: {
    assignmentId: v.id("assignments"),
    username: v.string(),
  },
  handler: async (ctx, args) => {
    const assignment = await ctx.db.get(args.assignmentId);
    if (!assignment) {
      throw new Error(`Assignment ${args.assignmentId} not found`);
    }
    const user = await ctx.db
      .query("users")
      .withIndex("by_username", (q) => q.eq("username", args.username))
      .unique();
    if (!user) throw new Error(`No user with username "${args.username}"`);
    if (user.role !== "scholar") {
      throw new Error(`User "${args.username}" is not a scholar`);
    }
    const already = assignment.scholarIds.some(
      (id) => String(id) === String(user._id),
    );
    if (!already) {
      await ctx.db.patch(assignment._id, {
        scholarIds: [...assignment.scholarIds, user._id],
      });
    }
    return {
      added: !already,
      rosterSize: assignment.scholarIds.length + (already ? 0 : 1),
    };
  },
});
