import type { Doc, Id } from "../../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../../_generated/server";
import {
  isFluent,
  latencyBaselineFromSkillMedians,
} from "./scheduler";
import {
  practiceScopeAllowsCheckpoint,
  resolvePracticeScope,
} from "./mathPlan";

export type CheckpointTarget = {
  domain: string;
  strand?: string;
  grade: string;
};

export type EffectiveCheckpoint = CheckpointTarget & {
  source: "teacher" | "group";
  groupId?: Id<"scholarGroups">;
  groupName?: string;
  conflictGroupIds: Id<"scholarGroups">[];
};

type DbCtx = Pick<QueryCtx | MutationCtx, "db">;

type CheckpointBandMode = {
  mode: "toward" | "deeper";
  bandSolid: number;
  bandTotal: number;
};

function newest<T extends { updatedAt: number }>(rows: T[]): T | undefined {
  return [...rows].sort((a, b) => b.updatedAt - a.updatedAt)[0];
}

export async function checkpointRowsForGroup(
  ctx: DbCtx,
  groupId: Id<"scholarGroups">,
): Promise<Doc<"mathGroupCheckpoint">[]> {
  return await ctx.db
    .query("mathGroupCheckpoint")
    .withIndex("by_group", (q) => q.eq("groupId", groupId))
    .collect();
}

export async function overrideRowsForScholar(
  ctx: DbCtx,
  scholarId: Id<"users">,
): Promise<Doc<"scholarCheckpointOverride">[]> {
  return await ctx.db
    .query("scholarCheckpointOverride")
    .withIndex("by_scholar", (q) => q.eq("scholarId", scholarId))
    .collect();
}

export async function bandModeForScholar(
  ctx: DbCtx,
  scholarId: Id<"users">,
  checkpoint: CheckpointTarget | null,
): Promise<CheckpointBandMode> {
  if (!checkpoint) {
    return { mode: "toward", bandSolid: 0, bandTotal: 0 };
  }

  const bandQuery =
    checkpoint.strand === undefined
      ? ctx.db
          .query("knowledgeNodes")
          .withIndex("by_domain_strand", (q) =>
            q.eq("domain", checkpoint.domain),
          )
          .filter((q) => q.eq(q.field("grade"), checkpoint.grade))
          .collect()
      : ctx.db
          .query("knowledgeNodes")
          .withIndex("by_domain_strand", (q) =>
            q
              .eq("domain", checkpoint.domain)
              .eq("strand", checkpoint.strand),
          )
          .filter((q) => q.eq(q.field("grade"), checkpoint.grade))
          .collect();
  const [band, masteryRows] = await Promise.all([
    bandQuery,
    ctx.db
      .query("practiceMastery")
      .withIndex("by_scholar", (q) => q.eq("scholarId", scholarId))
      .collect(),
  ]);
  const masteryBySkill = new Map(
    masteryRows.map((row) => [row.skillKey, row]),
  );
  const fluencyContext = {
    now: Date.now(),
    latencyBaseline: latencyBaselineFromSkillMedians(
      masteryRows.map((row) => row.latencyMedianMs ?? NaN),
    ),
  };
  const bandSolid = band.filter((node) => {
    const mastery = masteryBySkill.get(node.nodeKey);
    return mastery ? isFluent(mastery, fluencyContext) : false;
  }).length;
  const bandTotal = band.length;
  return {
    mode: bandTotal > 0 && bandSolid === bandTotal ? "deeper" : "toward",
    bandSolid,
    bandTotal,
  };
}

export async function assertCheckpointGroupMembershipAvailable(
  ctx: DbCtx,
  groupId: Id<"scholarGroups">,
  scholarIds: readonly Id<"users">[],
): Promise<void> {
  if (scholarIds.length === 0) return;
  const wanted = new Set(scholarIds.map(String));
  const checkpoints = await ctx.db.query("mathGroupCheckpoint").collect();
  for (const checkpoint of checkpoints) {
    if (checkpoint.groupId === groupId) continue;
    const otherGroup = await ctx.db.get(checkpoint.groupId);
    if (!otherGroup) continue;
    const overlap = otherGroup.scholarIds.find((id) => wanted.has(String(id)));
    if (overlap) {
      throw new Error(
        `A scholar is already in the math group "${otherGroup.name}". Remove them there before adding them to another checkpoint-bearing math group.`,
      );
    }
  }
}

export async function resolveEffectiveCheckpoint(
  ctx: DbCtx,
  scholarId: Id<"users">,
): Promise<EffectiveCheckpoint | null> {
  const checkpoint = await resolveStoredCheckpoint(ctx, scholarId);
  if (!checkpoint) return null;
  const { practiceScope } = await resolvePracticeScope(ctx, scholarId);
  return practiceScopeAllowsCheckpoint(practiceScope, checkpoint)
    ? checkpoint
    : null;
}

/**
 * The authored checkpoint after scholar suppression/override precedence, before
 * Practice scope suspends an invalid target. Teacher inspection uses this form
 * so a conflict stays visible; serving uses `resolveEffectiveCheckpoint`.
 */
export async function resolveStoredCheckpoint(
  ctx: DbCtx,
  scholarId: Id<"users">,
): Promise<EffectiveCheckpoint | null> {
  const planRows = await ctx.db
    .query("scholarMathPlans")
    .withIndex("by_scholar", (q) => q.eq("scholarId", scholarId))
    .collect();
  const plan = newest(planRows);
  if (plan?.checkpointSuppressed) return null;
  const overrideRows = await overrideRowsForScholar(ctx, scholarId);
  const teacherOverride = newest(
    overrideRows.filter((row) => row.source === "teacher"),
  );

  const groups = (await ctx.db.query("scholarGroups").collect()).filter((group) =>
    group.scholarIds.includes(scholarId),
  );
  const groupCandidates: {
    checkpoint: Doc<"mathGroupCheckpoint">;
    group: Doc<"scholarGroups">;
  }[] = [];
  for (const group of groups) {
    const checkpoint = newest(await checkpointRowsForGroup(ctx, group._id));
    if (checkpoint) groupCandidates.push({ checkpoint, group });
  }

  groupCandidates.sort(
    (a, b) => b.checkpoint.updatedAt - a.checkpoint.updatedAt,
  );
  const selectedGroup = groupCandidates[0];
  const conflictGroupIds = groupCandidates.slice(1).map(({ group }) => group._id);
  if (selectedGroup) {
    if (conflictGroupIds.length > 0) {
      console.error("Scholar belongs to multiple checkpoint-bearing math groups", {
        scholarId,
        selectedGroupId: selectedGroup.group._id,
        conflictGroupIds,
      });
    }
  }
  if (teacherOverride) {
    return {
      domain: teacherOverride.domain,
      strand: teacherOverride.strand,
      grade: teacherOverride.grade,
      source: "teacher",
      conflictGroupIds,
    };
  }
  if (selectedGroup) {
    return {
      domain: selectedGroup.checkpoint.domain,
      strand: selectedGroup.checkpoint.strand,
      grade: selectedGroup.checkpoint.grade,
      source: "group",
      groupId: selectedGroup.group._id,
      groupName: selectedGroup.group.name,
      conflictGroupIds,
    };
  }

  return null;
}

/** The inherited group target before scholar overrides or plan suppression. */
export async function resolveRawGroupCheckpoint(
  ctx: DbCtx,
  scholarId: Id<"users">,
): Promise<EffectiveCheckpoint | null> {
  const groups = (await ctx.db.query("scholarGroups").collect()).filter((group) =>
    group.scholarIds.includes(scholarId),
  );
  const candidates: Array<{ checkpoint: Doc<"mathGroupCheckpoint">; group: Doc<"scholarGroups"> }> = [];
  for (const group of groups) {
    const checkpoint = newest(await checkpointRowsForGroup(ctx, group._id));
    if (checkpoint) candidates.push({ checkpoint, group });
  }
  candidates.sort((a, b) => b.checkpoint.updatedAt - a.checkpoint.updatedAt);
  const selected = candidates[0];
  if (!selected) return null;
  return {
    domain: selected.checkpoint.domain,
    strand: selected.checkpoint.strand,
    grade: selected.checkpoint.grade,
    source: "group",
    groupId: selected.group._id,
    groupName: selected.group.name,
    conflictGroupIds: candidates.slice(1).map(({ group }) => group._id),
  };
}
