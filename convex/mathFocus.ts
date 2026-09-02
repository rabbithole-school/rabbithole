/**
 * Teacher-owned Math-plan checkpoints: group targets plus scholar overrides.
 * A checkpoint is always a domain × optional strand × grade band, never one
 * skill; the teacher matrix projects that band into cell-corner flags.
 */

import { v } from "convex/values";
import { type MutationCtx, type QueryCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import {
  filterToAccessibleScholars,
  requireActiveScholarAccess,
  requireScholarsAccessible,
} from "./lib/access";
import {
  institutionIdInLens,
  resolveInstitutionLens,
} from "./lib/institutionLens";
import { ROLES } from "./lib/roles";
import {
  authedQuery,
  teacherMutation,
  teacherQuery,
} from "./lib/customFunctions";
import { PRACTICE_DOMAINS } from "./lib/practice/domains";
import {
  practiceDomainLabel,
  strandHeadlineFor,
} from "../shared/practiceDomainLabels";
import {
  bandModeForScholar,
  checkpointRowsForGroup,
  overrideRowsForScholar,
  resolveRawGroupCheckpoint,
  resolveEffectiveCheckpoint,
  resolveStoredCheckpoint,
  type CheckpointTarget,
} from "./lib/practice/checkpointFocus";
import {
  practiceScopeAllowsCheckpoint,
  resolvePracticeScope,
} from "./lib/practice/mathPlan";

const REGISTERED_DOMAINS = new Set(PRACTICE_DOMAINS.map(({ domain }) => domain));
type MathFocusCtx = (QueryCtx | MutationCtx) & { user: Doc<"users"> };

type NamedScholarRef = {
  scholarId: Id<"users">;
  name: string;
};

type GroupCheckpointPreview = {
  total: number;
  following: number;
  keepingOwn: number;
  none: number;
  blockedByScope: NamedScholarRef[];
  blockedByGroup: Array<NamedScholarRef & { groupName: string }>;
  firstBlockedGroupName?: string;
};

function scholarDisplayName(scholar: Doc<"users">) {
  return scholar.name ?? scholar.username ?? "Unnamed scholar";
}

function namedScholarList(scholars: Array<{ name: string }>) {
  const names = scholars.slice(0, 3).map((scholar) => scholar.name);
  const others = scholars.length - names.length;
  return `${names.join(", ")}${others ? ` and ${others} other${others === 1 ? "" : "s"}` : ""}`;
}

function newest<T extends { updatedAt: number }>(rows: T[]) {
  return rows.reduce<T | undefined>(
    (latest, row) => (!latest || row.updatedAt > latest.updatedAt ? row : latest),
    undefined,
  );
}

/**
 * Previews the stored-policy outcome for every durable group member. `following`
 * means no individual suppression or override wins the precedence chain, so the
 * member would inherit a supplied target (or remains eligible for the current
 * group checkpoint). Blockers are independent preconditions and can overlap
 * these outcome counts because a mutation will reject rather than apply them.
 */
async function previewGroupCheckpointMembers(
  ctx: MathFocusCtx,
  group: Doc<"scholarGroups">,
  scholarIds: Id<"users">[],
  target?: CheckpointTarget,
): Promise<GroupCheckpointPreview> {
  const memberRows = await Promise.all(
    scholarIds.map(async (scholarId) => [scholarId, await ctx.db.get(scholarId)] as const),
  );
  const membersById = new Map(
    memberRows.flatMap(([scholarId, scholar]) =>
      scholar
        ? [[scholarId, { scholarId, name: scholarDisplayName(scholar) }] as const]
        : [],
    ),
  );
  const [plansAndOverrides, allGroups, groupCheckpoints] = await Promise.all([
    Promise.all(
      scholarIds.map(async (scholarId) => ({
        scholarId,
        plans: await ctx.db
          .query("scholarMathPlans")
          .withIndex("by_scholar", (q) => q.eq("scholarId", scholarId))
          .collect(),
        overrides: await overrideRowsForScholar(ctx, scholarId),
      })),
    ),
    ctx.db.query("scholarGroups").collect(),
    ctx.db.query("mathGroupCheckpoint").collect(),
  ]);

  let following = 0;
  let keepingOwn = 0;
  let none = 0;
  for (const { plans, overrides } of plansAndOverrides) {
    if (newest(plans)?.checkpointSuppressed) {
      none += 1;
    } else if (newest(overrides)) {
      keepingOwn += 1;
    } else {
      following += 1;
    }
  }

  const blockedByScope = target
    ? (
        await Promise.all(
          memberRows.map(async ([scholarId, scholar]) => {
            if (!scholar) return null;
            const { practiceScope } = await resolvePracticeScope(ctx, scholarId);
            return practiceScopeAllowsCheckpoint(practiceScope, target)
              ? null
              : { scholarId, name: scholarDisplayName(scholar) };
          }),
        )
      ).filter((scholar): scholar is NamedScholarRef => scholar !== null)
    : [];

  const groupsById = new Map(allGroups.map((candidate) => [candidate._id, candidate]));
  const seenBlockedMembers = new Set<string>();
  const blockedByGroup: Array<NamedScholarRef & { groupName: string }> = [];
  let firstBlockedGroupName: string | undefined;
  for (const checkpoint of groupCheckpoints) {
    if (checkpoint.groupId === group._id) continue;
    const otherGroup = groupsById.get(checkpoint.groupId);
    if (!otherGroup) continue;
    const overlappingIds = otherGroup.scholarIds.filter((scholarId) =>
      membersById.has(scholarId),
    );
    if (overlappingIds.length > 0 && firstBlockedGroupName === undefined) {
      firstBlockedGroupName = otherGroup.name;
    }
    for (const scholarId of overlappingIds) {
      const key = `${scholarId}:${otherGroup._id}`;
      if (seenBlockedMembers.has(key)) continue;
      seenBlockedMembers.add(key);
      const scholar = membersById.get(scholarId);
      if (scholar) blockedByGroup.push({ ...scholar, groupName: otherGroup.name });
    }
  }

  return {
    total: scholarIds.length,
    following,
    keepingOwn,
    none,
    blockedByScope,
    blockedByGroup,
    firstBlockedGroupName,
  };
}

async function requireCheckpointGroupInstitutionAccess(
  ctx: MathFocusCtx,
  groupId: Id<"scholarGroups">,
) {
  const group = await ctx.db.get(groupId);
  if (!group) throw new Error("Group not found.");
  const lens = await resolveInstitutionLens(ctx, ctx.user, "all");
  if (!institutionIdInLens(lens, group.institutionId)) {
    throw new Error("Forbidden: group is not in your institution");
  }
  return group;
}

/** Writes must refuse malformed durable membership instead of silently narrowing it. */
async function requireWritableGroupMembers(
  ctx: MutationCtx & { user: Doc<"users"> },
  group: Doc<"scholarGroups">,
) {
  await requireScholarsAccessible(ctx, ctx.user, group.scholarIds);
  const members = await Promise.all(
    group.scholarIds.map((scholarId) => ctx.db.get(scholarId)),
  );
  if (members.some((member) => !member || member.role !== ROLES.SCHOLAR)) {
    throw new Error("Group contains an invalid scholar member.");
  }
}

async function unsuppressCanonicalMathPlan(
  ctx: MutationCtx & { user: Doc<"users"> },
  scholarId: Id<"users">,
  updatedBy: Id<"users">,
) {
  const plans = await ctx.db
    .query("scholarMathPlans")
    .withIndex("by_scholar", (q) => q.eq("scholarId", scholarId))
    .collect();
  plans.sort((a, b) => b.updatedAt - a.updatedAt);
  const canonical = plans[0];
  if (!canonical) return;

  const updatedAt = Date.now();
  await ctx.db.patch(canonical._id, {
    checkpointSuppressed: false,
    updatedBy,
    updatedAt,
  });
  for (const duplicate of plans.slice(1)) {
    await ctx.db.delete(duplicate._id);
  }
}

function validateDomain(domain: string) {
  if (!REGISTERED_DOMAINS.has(domain)) {
    throw new Error(`Unknown practice domain "${domain}".`);
  }
}

async function validateCheckpoint(
  ctx: Pick<QueryCtx | MutationCtx, "db">,
  target: CheckpointTarget,
) {
  validateDomain(target.domain);
  const nodes = await ctx.db
    .query("knowledgeNodes")
    .withIndex("by_domain", (q) => q.eq("domain", target.domain))
    .collect();
  if (
    !nodes.some(
      (node) =>
        (target.strand === undefined || node.strand === target.strand) &&
        node.grade === target.grade,
    )
  ) {
    const altitude =
      target.strand === undefined
        ? practiceDomainLabel(target.domain)
        : target.strand;
    throw new Error(
      `Checkpoint "${altitude}" at grade "${target.grade}" does not exist in practice domain "${target.domain}".`,
    );
  }
}

export const checkpointOptions = teacherQuery({
  args: { domain: v.string() },
  handler: async (ctx, args) => {
    validateDomain(args.domain);
    const nodes = await ctx.db
      .query("knowledgeNodes")
      .withIndex("by_domain", (q) => q.eq("domain", args.domain))
      .collect();
    const domainCounts = new Map<string, number>();
    const strandCounts = new Map<string, number>();
    for (const node of nodes) {
      if (!node.grade) continue;
      domainCounts.set(node.grade, (domainCounts.get(node.grade) ?? 0) + 1);
      if (!node.strand) continue;
      const strandKey = `${node.strand}\u0000${node.grade}`;
      strandCounts.set(strandKey, (strandCounts.get(strandKey) ?? 0) + 1);
    }
    const options: {
      domain: string;
      strand?: string;
      grade: string;
      nodeCount: number;
    }[] = [
      ...[...domainCounts.entries()].map(([grade, nodeCount]) => ({
        domain: args.domain,
        grade,
        nodeCount,
      })),
      ...[...strandCounts.entries()].map(([key, nodeCount]) => {
        const [strand, grade] = key.split("\u0000");
        return { domain: args.domain, strand, grade, nodeCount };
      }),
    ];
    return options.sort((a, b) => {
      if (a.strand === undefined && b.strand !== undefined) return -1;
      if (a.strand !== undefined && b.strand === undefined) return 1;
      return (
        (a.strand ?? "").localeCompare(b.strand ?? "") ||
        a.grade.localeCompare(b.grade, undefined, { numeric: true })
      );
    });
  },
});

export const checkpointForGroup = teacherQuery({
  args: {
    groupId: v.id("scholarGroups"),
    target: v.optional(
      v.object({
        domain: v.string(),
        strand: v.optional(v.string()),
        grade: v.string(),
      }),
    ),
  },
  handler: async (ctx, args) => {
    const group = await requireCheckpointGroupInstitutionAccess(ctx, args.groupId);
    // A group row can outlive a scholar deletion or an institution move. Reads
    // narrow that stale durable membership rather than crashing the whole
    // reactive surface or exposing a foreign scholar; writes below stay strict.
    const accessibleScholarIds = [
      ...new Set(await filterToAccessibleScholars(ctx, ctx.user, group.scholarIds)),
    ];
    const scholarIds = (
      await Promise.all(accessibleScholarIds.map((scholarId) => ctx.db.get(scholarId)))
    ).flatMap((scholar) =>
      scholar?.role === ROLES.SCHOLAR ? [scholar._id] : [],
    );
    if (args.target) await validateCheckpoint(ctx, args.target);
    const rows = await checkpointRowsForGroup(ctx, args.groupId);
    rows.sort((a, b) => b.updatedAt - a.updatedAt);
    const checkpoint = rows[0];
    const members = await previewGroupCheckpointMembers(
      ctx,
      group,
      scholarIds,
      args.target,
    );
    return {
      groupId: group._id,
      groupName: group.name,
      checkpoint: checkpoint
        ? {
            domain: checkpoint.domain,
            strand: checkpoint.strand,
            grade: checkpoint.grade,
            updatedAt: checkpoint.updatedAt,
          }
        : null,
      duplicateCount: Math.max(0, rows.length - 1),
      members: {
        total: members.total,
        following: members.following,
        keepingOwn: members.keepingOwn,
        none: members.none,
        blockedByScope: members.blockedByScope,
        blockedByGroup: members.blockedByGroup,
      },
    };
  },
});

// Teacher-only: exposes a scholar's exact steering target AND the teacher-facing
// internals — source/group/conflicts/duplicate rows. The scholar's own,
// goal-only view (strand × grade, no steering internals) is `myMathCheckpoint`
// below; this teacher query stays the one surface that reveals HOW/WHERE the
// checkpoint was set.
export const checkpointForScholar = teacherQuery({
  args: { scholarId: v.id("users") },
  handler: async (ctx, args) => {
    const scholarId = args.scholarId;
    await requireActiveScholarAccess(ctx, ctx.user, scholarId);
    const stored = await resolveStoredCheckpoint(ctx, scholarId);
    const { practiceScope } = await resolvePracticeScope(ctx, scholarId);
    const conflict =
      stored !== null &&
      !practiceScopeAllowsCheckpoint(practiceScope, stored);
    const bandMode = await bandModeForScholar(
      ctx,
      scholarId,
      conflict ? null : stored,
    );
    const overrides = await overrideRowsForScholar(ctx, scholarId);
    overrides.sort((a, b) => b.updatedAt - a.updatedAt);
    return {
      effective: stored,
      conflict,
      override: overrides[0]
        ? {
            domain: overrides[0].domain,
            strand: overrides[0].strand,
            grade: overrides[0].grade,
            source: overrides[0].source,
            updatedAt: overrides[0].updatedAt,
          }
        : null,
      duplicateOverrideCount: Math.max(0, overrides.length - 1),
      ...bandMode,
    };
  },
});

// Scholar-facing: MY current checkpoint, framed as the "working toward" goal the
// scholar's playlist card shows above its daily set. The self-readable twin of
// `checkpointForScholar`, but deliberately GOAL-ONLY — it returns just the
// destination (domain/strand/grade + humanized labels), never the teacher
// steering internals (which group set it, the source, conflicts). A learning
// target is forward-looking and scholar-appropriate ("here's where we're
// headed"); the teacher's HOW/WHERE stays teacher-only. Returns null when the
// scholar has no effective checkpoint.
export const myMathCheckpoint = authedQuery({
  args: {},
  handler: async (ctx) => {
    const effective = await resolveEffectiveCheckpoint(ctx, ctx.user._id);
    if (!effective) return null;
    const bandMode = await bandModeForScholar(ctx, ctx.user._id, effective);
    return {
      domain: effective.domain,
      domainLabel: practiceDomainLabel(effective.domain),
      strand: effective.strand,
      strandLabel:
        effective.strand === undefined
          ? practiceDomainLabel(effective.domain)
          : strandHeadlineFor(effective.domain, effective.strand),
      grade: effective.grade,
      ...bandMode,
    };
  },
});

export const checkpointModesForScope = teacherQuery({
  args: { groupId: v.id("scholarGroups") },
  handler: async (ctx, args) => {
    const group = await requireCheckpointGroupInstitutionAccess(ctx, args.groupId);
    return await Promise.all(
      group.scholarIds.map(async (scholarId) => {
        const effective = await resolveEffectiveCheckpoint(ctx, scholarId);
        return {
          scholarId,
          domain: effective?.domain,
          strand: effective?.strand,
          grade: effective?.grade,
          ...(await bandModeForScholar(ctx, scholarId, effective)),
        };
      }),
    );
  },
});

export const setGroupCheckpoint = teacherMutation({
  args: {
    groupId: v.id("scholarGroups"),
    domain: v.string(),
    strand: v.optional(v.string()),
    grade: v.string(),
    // Optional only for existing non-UI callers. Every confirmation UI write
    // supplies the revision returned by its current preview.
    expectedUpdatedAt: v.optional(v.union(v.number(), v.null())),
  },
  handler: async (ctx, args) => {
    const group = await requireCheckpointGroupInstitutionAccess(ctx, args.groupId);
    const target = {
      domain: args.domain,
      strand: args.strand,
      grade: args.grade,
    };
    await validateCheckpoint(ctx, target);
    await requireWritableGroupMembers(ctx, group);
    const members = await previewGroupCheckpointMembers(
      ctx,
      group,
      group.scholarIds,
      target,
    );
    if (members.firstBlockedGroupName) {
      throw new Error(
        `A scholar is already in the math group "${members.firstBlockedGroupName}". Remove them there before adding them to another checkpoint-bearing math group.`,
      );
    }
    if (members.blockedByScope.length) {
      const verb = members.blockedByScope.length === 1 ? "has" : "have";
      throw new Error(
        `Not set: ${namedScholarList(members.blockedByScope)} ${verb} a Practice scope that excludes this checkpoint.`,
      );
    }
    const rows = await checkpointRowsForGroup(ctx, args.groupId);
    rows.sort((a, b) => b.updatedAt - a.updatedAt);
    const actualUpdatedAt = rows[0]?.updatedAt ?? null;
    if (
      args.expectedUpdatedAt !== undefined &&
      args.expectedUpdatedAt !== actualUpdatedAt
    ) {
      throw new Error(
        "Group checkpoint changed while this confirmation was open. Review it and try again.",
      );
    }
    // The revision is a concurrency token, not merely a display timestamp: two
    // writes in one millisecond must still invalidate an already-open confirm.
    const updatedAt = Math.max(Date.now(), (actualUpdatedAt ?? 0) + 1);
    if (rows[0]) {
      await ctx.db.patch(rows[0]._id, {
        ...target,
        nodeKey: undefined,
        updatedBy: ctx.user._id,
        updatedAt,
      });
      for (const duplicate of rows.slice(1)) {
        await ctx.db.delete(duplicate._id);
      }
      return rows[0]._id;
    }
    return await ctx.db.insert("mathGroupCheckpoint", {
      groupId: args.groupId,
      ...target,
      updatedBy: ctx.user._id,
      updatedAt,
    });
  },
});

export const clearGroupCheckpoint = teacherMutation({
  args: {
    groupId: v.id("scholarGroups"),
    // Optional only for existing non-UI callers. Every confirmation UI write
    // supplies the revision returned by its current preview.
    expectedUpdatedAt: v.optional(v.union(v.number(), v.null())),
  },
  handler: async (ctx, args) => {
    await requireCheckpointGroupInstitutionAccess(ctx, args.groupId);
    const rows = await checkpointRowsForGroup(ctx, args.groupId);
    rows.sort((a, b) => b.updatedAt - a.updatedAt);
    const actualUpdatedAt = rows[0]?.updatedAt ?? null;
    if (
      args.expectedUpdatedAt !== undefined &&
      args.expectedUpdatedAt !== actualUpdatedAt
    ) {
      throw new Error(
        "Group checkpoint changed while this confirmation was open. Review it and try again.",
      );
    }
    for (const row of rows) await ctx.db.delete(row._id);
    return { removed: rows.length };
  },
});

export const setScholarCheckpointOverride = teacherMutation({
  args: {
    scholarId: v.id("users"),
    domain: v.string(),
    strand: v.optional(v.string()),
    grade: v.string(),
  },
  handler: async (ctx, args) => {
    await requireActiveScholarAccess(ctx, ctx.user, args.scholarId);
    const target = {
      domain: args.domain,
      strand: args.strand,
      grade: args.grade,
    };
    await validateCheckpoint(ctx, target);
    const { practiceScope } = await resolvePracticeScope(ctx, args.scholarId);
    if (!practiceScopeAllowsCheckpoint(practiceScope, target)) {
      throw new Error("Checkpoint must be inside the Practice scope.");
    }
    const rows = await overrideRowsForScholar(ctx, args.scholarId);
    rows.sort((a, b) => b.updatedAt - a.updatedAt);
    const updatedAt = Date.now();
    if (rows[0]) {
      await ctx.db.patch(rows[0]._id, {
        ...target,
        nodeKey: undefined,
        source: "teacher",
        updatedBy: ctx.user._id,
        updatedAt,
      });
      for (const duplicate of rows.slice(1)) {
        await ctx.db.delete(duplicate._id);
      }
      await unsuppressCanonicalMathPlan(ctx, args.scholarId, ctx.user._id);
      return rows[0]._id;
    }
    const id = await ctx.db.insert("scholarCheckpointOverride", {
      scholarId: args.scholarId,
      ...target,
      nodeKey: undefined,
      source: "teacher",
      updatedBy: ctx.user._id,
      updatedAt,
    });
    await unsuppressCanonicalMathPlan(ctx, args.scholarId, ctx.user._id);
    return id;
  },
});

export const clearScholarCheckpointOverride = teacherMutation({
  args: { scholarId: v.id("users") },
  handler: async (ctx, args) => {
    await requireActiveScholarAccess(ctx, ctx.user, args.scholarId);
    const { practiceScope } = await resolvePracticeScope(ctx, args.scholarId);
    const inherited = await resolveRawGroupCheckpoint(ctx, args.scholarId);
    if (inherited && !practiceScopeAllowsCheckpoint(practiceScope, inherited)) {
      throw new Error("Clearing this override would reveal a checkpoint outside the Practice scope.");
    }
    const rows = await overrideRowsForScholar(ctx, args.scholarId);
    for (const row of rows) await ctx.db.delete(row._id);
    await unsuppressCanonicalMathPlan(ctx, args.scholarId, ctx.user._id);
    return { removed: rows.length };
  },
});
