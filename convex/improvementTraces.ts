import { v } from "convex/values";
import { staffMutation, staffQuery } from "./lib/customFunctions";
import { resolveInstitutionLens } from "./lib/institutionLens";
import { assertCuratableInstitution } from "./lib/access";
import type { Doc } from "./_generated/dataModel";
import { internalMutation, type QueryCtx } from "./_generated/server";
import { isPlatformAdminRole } from "./lib/roles";

const policyValidator = v.union(
  v.literal("rounds"),
  v.literal("dieter"),
  v.literal("coherence"),
);

const lifecycleValidator = v.union(
  v.literal("discovered"),
  v.literal("proposed"),
  v.literal("approved"),
  v.literal("executing"),
  v.literal("completed"),
  v.literal("declined"),
);

const referenceValidator = v.object({ kind: v.string(), ref: v.string() });
const MAX_EVIDENCE_REFS = 20;
const MAX_REFERENCE_TOKEN_LENGTH = 512;
const REFERENCE_KIND = /^[A-Za-z][A-Za-z0-9_.:-]{0,63}$/;
const REFERENCE_TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:/@=+-]*$/;
const URL_REFERENCE = /^https?:\/\/[^\s\x00-\x1f]{1,480}$/i;

const executionValidator = v.object({
  provider: v.union(
    v.literal("github-cloud"),
    v.literal("autonomous-coordinator"),
  ),
  executionId: v.string(),
  attemptId: v.optional(v.string()),
  workerId: v.optional(v.string()),
  workspaceId: v.optional(v.string()),
  copilotSessionId: v.optional(v.string()),
  eventCursor: v.optional(v.string()),
});

type Reference = { kind: string; ref: string };

function assertReference(reference: Reference, label: string) {
  if (
    !REFERENCE_KIND.test(reference.kind) ||
    reference.ref.length === 0 ||
    reference.ref.length > MAX_REFERENCE_TOKEN_LENGTH ||
    /[\s\x00-\x1f]/.test(reference.ref) ||
    (!REFERENCE_TOKEN.test(reference.ref) && !URL_REFERENCE.test(reference.ref))
  ) {
    throw new Error(`${label} must use compact identifier or URL-like tokens`);
  }
}

function assertEvidenceRefs(evidenceRefs: Reference[]) {
  if (evidenceRefs.length > MAX_EVIDENCE_REFS) {
    throw new Error(`evidenceRefs may contain at most ${MAX_EVIDENCE_REFS} references`);
  }
  evidenceRefs.forEach((reference, index) =>
    assertReference(reference, `evidenceRefs[${index}]`),
  );
}

async function activeInstitutionId(
  ctx: QueryCtx,
  user: Doc<"users">,
  requestedScope?: string,
) {
  const lens = await resolveInstitutionLens(ctx, user, requestedScope);
  if (!lens.institution) {
    throw new Error("No active institution context");
  }
  return lens.institution._id;
}

async function requireTraceInActiveInstitution(
  ctx: QueryCtx,
  user: Doc<"users">,
  traceId: Doc<"improvementTraces">["_id"],
) {
  const trace = await ctx.db.get(traceId);
  if (!trace) throw new Error("Improvement trace not found");
  await assertCuratableInstitution(ctx, user, trace.institutionId);
  return trace;
}

/**
 * Creates a references-only ledger row. Lifecycle values are recorded facts,
 * not transitions: this module deliberately imposes no workflow ordering.
 */
export const create = staffMutation({
  args: {
    policy: policyValidator,
    lifecycle: v.optional(lifecycleValidator),
    chatId: v.optional(v.id("chats")),
    evidenceRefs: v.array(referenceValidator),
    scope: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    assertEvidenceRefs(args.evidenceRefs);
    if (args.chatId) {
      const chat = await ctx.db.get(args.chatId);
      if (!chat || chat.teacherId !== ctx.user._id) {
        throw new Error("Forbidden: chat is not owned by the current staff member");
      }
    }
    const now = Date.now();
    return await ctx.db.insert("improvementTraces", {
      institutionId: await activeInstitutionId(ctx, ctx.user, args.scope),
      policy: args.policy,
      lifecycle: args.lifecycle ?? "discovered",
      createdBy: ctx.user._id,
      chatId: args.chatId,
      evidenceRefs: args.evidenceRefs,
      createdAt: now,
      updatedAt: now,
    });
  },
});

/**
 * The scheduled Coherence bridge can only create a references-only trace for a
 * platform administrator's Slack-backed standing thread. The finding stays in
 * Convex; GitHub receives only the fixed, redacted rule brief.
 */
export const claimCoherenceProposal = internalMutation({
  args: {
    institutionId: v.id("institutions"),
    findingIds: v.array(v.id("sweepFindings")),
    requestedByUserId: v.id("users"),
    chatId: v.id("chats"),
  },
  handler: async (ctx, args) => {
    const [requester, chat] = await Promise.all([
      ctx.db.get(args.requestedByUserId),
      ctx.db.get(args.chatId),
    ]);
    if (!requester || !isPlatformAdminRole(requester.role)) {
      throw new Error("Coherence proposal requester must be a platform admin");
    }
    if (!chat || chat.teacherId !== requester._id || chat.source !== "slack") {
      throw new Error("Coherence proposal chat must be requester-owned and Slack-backed");
    }

    const now = Date.now();
    const leaseExpiredBefore = now - 15 * 60_000;
    const candidates = await Promise.all(args.findingIds.map((id) => ctx.db.get(id)));
    const finding = candidates
      .filter((row): row is NonNullable<typeof row> => Boolean(row))
      .filter(
        (row) =>
          row.institutionId === args.institutionId &&
          row.reproducedAt !== undefined &&
          row.consequence.includes("grade:grade_a") &&
          row.disposition === "repair_proposed" &&
          row.proposalId === undefined &&
          (row.proposalClaimedAt === undefined ||
            row.proposalClaimedAt < leaseExpiredBefore) &&
          (row.proposalClaimAttempts ?? 0) < 2,
      )
      .sort((a, b) =>
        `${a.stateRef.field}:${a._id}`.localeCompare(`${b.stateRef.field}:${b._id}`),
      )[0];
    if (!finding) return null;

    let traceId = finding.proposalTraceId;
    if (!traceId) {
      traceId = await ctx.db.insert("improvementTraces", {
        institutionId: args.institutionId,
        policy: "coherence",
        lifecycle: "proposed",
        createdBy: requester._id,
        chatId: args.chatId,
        evidenceRefs: [{ kind: "sweepFinding", ref: String(finding._id) }],
        createdAt: now,
        updatedAt: now,
      });
    }
    await ctx.db.patch(finding._id, {
      proposalTraceId: traceId,
      proposalClaimedAt: now,
      proposalClaimAttempts: (finding.proposalClaimAttempts ?? 0) + 1,
    });
    return {
      findingId: finding._id,
      traceId,
      rule: finding.stateRef.field,
      dedupKey: `coherence:${finding.stateRef.field}`,
    };
  },
});

/** Current-institution ledger rows only, newest first. */
export const list = staffQuery({
  args: {
    policy: v.optional(policyValidator),
    limit: v.optional(v.number()),
    scope: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const institutionId = await activeInstitutionId(ctx, ctx.user, args.scope);
    const limit = Math.min(Math.max(Math.trunc(args.limit ?? 50), 1), 100);
    const rows = args.policy
      ? await ctx.db
          .query("improvementTraces")
          .withIndex("by_institution_policy_createdAt", (q) =>
            q.eq("institutionId", institutionId).eq("policy", args.policy!),
          )
          .order("desc")
          .take(limit)
      : (await ctx.db
          .query("improvementTraces")
          .withIndex("by_institution_createdAt", (q) =>
            q.eq("institutionId", institutionId),
          )
          .order("desc")
          .take(limit));
    return rows;
  },
});

/** Returns a reference-only row only when it belongs to the active institution. */
export const get = staffQuery({
  args: { traceId: v.id("improvementTraces") },
  handler: (ctx, args) =>
    requireTraceInActiveInstitution(ctx, ctx.user, args.traceId),
});

export const setLifecycle = staffMutation({
  args: { traceId: v.id("improvementTraces"), lifecycle: lifecycleValidator },
  handler: async (ctx, args) => {
    await requireTraceInActiveInstitution(ctx, ctx.user, args.traceId);
    await ctx.db.patch(args.traceId, {
      lifecycle: args.lifecycle,
      updatedAt: Date.now(),
    });
  },
});

export const recordExecution = staffMutation({
  args: { traceId: v.id("improvementTraces"), execution: executionValidator },
  handler: async (ctx, args) => {
    const trace = await requireTraceInActiveInstitution(ctx, ctx.user, args.traceId);
    if (
      trace.execution &&
      (trace.execution.provider !== args.execution.provider ||
        trace.execution.executionId !== args.execution.executionId)
    ) {
      throw new Error("Execution correlation is immutable once recorded");
    }
    await ctx.db.patch(args.traceId, {
      execution: args.execution,
      updatedAt: Date.now(),
    });
  },
});

export const recordOutcome = staffMutation({
  args: { traceId: v.id("improvementTraces"), outcomeRef: referenceValidator },
  handler: async (ctx, args) => {
    await requireTraceInActiveInstitution(ctx, ctx.user, args.traceId);
    assertReference(args.outcomeRef, "outcomeRef");
    await ctx.db.patch(args.traceId, {
      outcomeRef: args.outcomeRef,
      updatedAt: Date.now(),
    });
  },
});
