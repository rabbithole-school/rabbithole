import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { authedQuery, teacherMutation, teacherQuery } from "./lib/customFunctions";
import { filterToAccessibleScholars, requireActiveScholarAccess } from "./lib/access";
import {
  practiceScopeAllowsCheckpoint,
  resolvePracticeScope,
  validatePracticeScope,
  type PracticeScope,
} from "./lib/practice/mathPlan";
import {
  bandModeForScholar,
  overrideRowsForScholar,
  resolveEffectiveCheckpoint,
  resolveRawGroupCheckpoint,
  resolveStoredCheckpoint,
  type CheckpointTarget,
} from "./lib/practice/checkpointFocus";
import { PRACTICE_DOMAINS } from "./lib/practice/domains";
import { gradeRank } from "../shared/gradeRange";
import { humanizeStrand } from "../shared/practiceDomainLabels";

const targetValidator = v.object({
  domain: v.string(),
  strand: v.optional(v.string()),
  grade: v.string(),
});
const scopeValidator = v.union(
  v.object({ kind: v.literal("open") }),
  v.object({
    kind: v.literal("limited"),
    domains: v.array(v.object({ domain: v.string(), strands: v.optional(v.array(v.string())) })),
  }),
);

type DbCtx = Pick<QueryCtx | MutationCtx, "db">;
type MathPlanMutationCtx = MutationCtx & { user: Doc<"users"> };

async function migrationIssueForScholar(ctx: DbCtx, scholarId: Id<"users">) {
  const issue = await ctx.db
    .query("scholarMathPlanMigrationIssues")
    .withIndex("by_scholar", (q) => q.eq("scholarId", scholarId))
    .first();
  return issue ? { reason: issue.reason } : null;
}

async function validateCheckpoint(ctx: DbCtx, target: CheckpointTarget) {
  if (!PRACTICE_DOMAINS.some((item) => item.domain === target.domain)) {
    throw new Error(`Unknown practice domain "${target.domain}".`);
  }
  const nodes = await ctx.db
    .query("knowledgeNodes")
    .withIndex("by_domain", (q) => q.eq("domain", target.domain))
    .collect();
  if (
    !nodes.some(
      (node) =>
        node.grade === target.grade &&
        (target.strand === undefined || node.strand === target.strand),
    )
  ) {
    throw new Error("Checkpoint does not exist in the current practice graph.");
  }
}

function sortGrades(grades: Iterable<string>): string[] {
  return [...grades].sort(
    (a, b) => (gradeRank(a) ?? Number.MAX_SAFE_INTEGER) - (gradeRank(b) ?? Number.MAX_SAFE_INTEGER),
  );
}

async function savePlan(
  ctx: MathPlanMutationCtx,
  scholarId: Id<"users">,
  practiceScope: PracticeScope,
  checkpointSuppressed?: boolean,
) {
  const rows = await ctx.db
    .query("scholarMathPlans")
    .withIndex("by_scholar", (q) => q.eq("scholarId", scholarId))
    .collect();
  rows.sort((a, b) => b.updatedAt - a.updatedAt);
  const data = { practiceScope, checkpointSuppressed, updatedBy: ctx.user._id, updatedAt: Date.now() };
  if (rows[0]) {
    await ctx.db.patch(rows[0]._id, data);
    for (const duplicate of rows.slice(1)) await ctx.db.delete(duplicate._id);
    return rows[0]._id;
  }
  return await ctx.db.insert("scholarMathPlans", { scholarId, ...data });
}

export const forScholars = teacherQuery({
  args: { scholarIds: v.array(v.id("users")) },
  handler: async (ctx, args) => {
    const requestedScholarIds = [...new Set(args.scholarIds)];
    if (requestedScholarIds.length > 64) {
      throw new Error("At most 64 scholars.");
    }
    const scholarIds = await filterToAccessibleScholars(
      ctx,
      ctx.user,
      requestedScholarIds,
    );
    return await Promise.all(scholarIds.map(async (scholarId) => {
      const { practiceScope, source: scopeSource } = await resolvePracticeScope(ctx, scholarId);
      const migrationIssue =
        scopeSource === "math_plan" ? null : await migrationIssueForScholar(ctx, scholarId);
      const checkpoint = await resolveStoredCheckpoint(ctx, scholarId);
      const conflict =
        checkpoint !== null &&
        !practiceScopeAllowsCheckpoint(practiceScope, checkpoint);
      const band = await bandModeForScholar(
        ctx,
        scholarId,
        conflict ? null : checkpoint,
      );
      return {
        scholarId,
        practiceScope,
        scopeSource,
        migrationIssue,
        checkpoint,
        conflict,
        ...band,
      };
    }));
  },
});

/**
 * Everything the teacher-facing "Edit Math plan" editor needs for ONE scholar,
 * in one bounded read: the authored plan as stored (so an invalid plan stays
 * visible), the inherited group target behind any scholar override, and the
 * domain × strand × grade tree the scope checkboxes and the checkpoint selects
 * both draw from. Read-model only — no serving behaviour lives here.
 */
export const planEditor = teacherQuery({
  args: { scholarId: v.id("users") },
  handler: async (ctx, args) => {
    await requireActiveScholarAccess(ctx, ctx.user, args.scholarId);
    const { practiceScope, source: scopeSource } = await resolvePracticeScope(
      ctx,
      args.scholarId,
    );
    const migrationIssue =
      scopeSource === "math_plan"
        ? null
        : await migrationIssueForScholar(ctx, args.scholarId);
    const checkpoint = await resolveStoredCheckpoint(ctx, args.scholarId);
    const groupCheckpoint = await resolveRawGroupCheckpoint(ctx, args.scholarId);
    const conflict =
      checkpoint !== null &&
      !practiceScopeAllowsCheckpoint(practiceScope, checkpoint);

    const domains: {
      domain: string;
      label: string;
      grades: string[];
      strands: { strand: string; label: string; grades: string[] }[];
    }[] = [];
    for (const { domain, label } of PRACTICE_DOMAINS) {
      const nodes = await ctx.db
        .query("knowledgeNodes")
        .withIndex("by_domain", (q) => q.eq("domain", domain))
        .collect();
      if (nodes.length === 0) continue;
      const domainGrades = new Set<string>();
      const strandGrades = new Map<string, Set<string>>();
      for (const node of nodes) {
        if (node.grade) domainGrades.add(node.grade);
        if (!node.strand) continue;
        const grades = strandGrades.get(node.strand) ?? new Set<string>();
        if (node.grade) grades.add(node.grade);
        strandGrades.set(node.strand, grades);
      }
      domains.push({
        domain,
        label,
        grades: sortGrades(domainGrades),
        strands: [...strandGrades.entries()]
          .map(([strand, grades]) => ({
            strand,
            label: humanizeStrand(strand),
            grades: sortGrades(grades),
          }))
          .sort((a, b) => a.label.localeCompare(b.label)),
      });
    }

    return {
      scholarId: args.scholarId,
      practiceScope,
      scopeSource,
      migrationIssue,
      checkpoint,
      groupCheckpoint,
      conflict,
      domains,
    };
  },
});

export const myPlan = authedQuery({
  args: { scholarId: v.optional(v.id("users")) },
  handler: async (ctx, args) => {
    const scholarId = args.scholarId ?? ctx.user._id;
    if (scholarId !== ctx.user._id) {
      await requireActiveScholarAccess(ctx, ctx.user, scholarId);
    }
    const { practiceScope, source: scopeSource } = await resolvePracticeScope(ctx, scholarId);
    const effective = await resolveEffectiveCheckpoint(ctx, scholarId);
    return {
      practiceScope,
      scopeSource,
      checkpoint:
        effective && {
          domain: effective.domain,
          strand: effective.strand,
          grade: effective.grade,
        },
    };
  },
});

export const saveForScholar = teacherMutation({
  args: { scholarId: v.id("users"), practiceScope: scopeValidator, checkpoint: v.union(targetValidator, v.null()) },
  handler: async (ctx, args) => {
    await requireActiveScholarAccess(ctx, ctx.user, args.scholarId);
    const practiceScope = await validatePracticeScope(ctx, args.practiceScope);
    if (args.checkpoint && !practiceScopeAllowsCheckpoint(practiceScope, args.checkpoint)) {
      throw new Error("Checkpoint must be inside the Practice scope.");
    }
    if (args.checkpoint) await validateCheckpoint(ctx, args.checkpoint);
    const rawGroup = await resolveRawGroupCheckpoint(ctx, args.scholarId);
    const overrides = await overrideRowsForScholar(ctx, args.scholarId);
    const sameTarget = !!rawGroup && !!args.checkpoint &&
      rawGroup.domain === args.checkpoint.domain && rawGroup.strand === args.checkpoint.strand && rawGroup.grade === args.checkpoint.grade;
    if (args.checkpoint === null || sameTarget) {
      for (const row of overrides) await ctx.db.delete(row._id);
    } else {
      const rows = [...overrides].sort((a, b) => b.updatedAt - a.updatedAt);
      const data = {
        ...args.checkpoint,
        nodeKey: undefined,
        source: "teacher" as const,
        updatedBy: ctx.user._id,
        updatedAt: Date.now(),
      };
      if (rows[0]) {
        await ctx.db.patch(rows[0]._id, data);
        for (const duplicate of rows.slice(1)) await ctx.db.delete(duplicate._id);
      } else await ctx.db.insert("scholarCheckpointOverride", { scholarId: args.scholarId, ...data });
    }
    await savePlan(ctx, args.scholarId, practiceScope, args.checkpoint === null ? !!rawGroup : false);
    return { practiceScope, checkpoint: args.checkpoint };
  },
});
