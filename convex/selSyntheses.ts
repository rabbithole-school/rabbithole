import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc } from "./_generated/dataModel";
import {
  internalMutation,
  internalQuery,
} from "./_generated/server";
import {
  assertCuratableInstitution,
  requireActiveScholarAccess,
  requireScholarsAccessible,
} from "./lib/access";
import { teacherMutation, teacherQuery } from "./lib/customFunctions";
import {
  SEL_SYNTHESIS_CITATION_KINDS,
  type SelSynthesisEvidence,
} from "./lib/selSynthesisPrompt";

const windowValidator = v.object({
  startMs: v.number(),
  endMs: v.number(),
});

const citationKindValidator = v.union(
  ...SEL_SYNTHESIS_CITATION_KINDS.map((kind) => v.literal(kind)),
);

const claimValidator = v.object({
  text: v.string(),
  cites: v.array(
    v.object({
      kind: citationKindValidator,
      id: v.string(),
      label: v.string(),
      at: v.number(),
    }),
  ),
});

const EVIDENCE_PER_KIND_LIMIT = 20;
const EVIDENCE_TEXT_LIMIT = 500;
const SESSION_FANOUT_LIMIT = 40;
const SESSION_WINDOW_MARGIN_MS = 24 * 60 * 60 * 1000;

function assertValidWindow(window: { startMs: number; endMs: number }): void {
  if (!Number.isFinite(window.startMs) || !Number.isFinite(window.endMs)) {
    throw new Error("SEL synthesis window must use finite timestamps");
  }
  if (window.endMs <= window.startMs) {
    throw new Error("SEL synthesis window end must be after its start");
  }
}

function truncateEvidenceText(text: string | undefined): string | undefined {
  if (text === undefined || text.length <= EVIDENCE_TEXT_LIMIT) return text;
  return text.slice(0, EVIDENCE_TEXT_LIMIT);
}

/**
 * Collect the bounded weekly evidence passed to the teacher-facing model.
 * Each evidence kind contributes at most its 20 newest rows, long free text is
 * capped at 500 characters, and analyses fan out across at most 40 sessions
 * created within the weekly window plus a one-day margin.
 */
export const collectEvidenceForScholar = internalQuery({
  args: {
    scholarId: v.id("users"),
    window: windowValidator,
  },
  handler: async (ctx, args) => {
    assertValidWindow(args.window);
    const scholar = await ctx.db.get(args.scholarId);
    if (
      !scholar ||
      scholar.role !== "scholar" ||
      !scholar.institutionId
    ) {
      throw new Error("SEL synthesis requires an institution-enrolled scholar");
    }

    const [signals, observations, alerts, sessions] = await Promise.all([
      ctx.db
        .query("sessionSignals")
        .withIndex("by_scholar", (q) =>
          q
            .eq("scholarId", args.scholarId)
            .gte("_creationTime", args.window.startMs)
            .lt("_creationTime", args.window.endMs),
        )
        .order("desc")
        .take(EVIDENCE_PER_KIND_LIMIT),
      ctx.db
        .query("observations")
        .withIndex("by_scholar", (q) =>
          q
            .eq("scholarId", args.scholarId)
            .gte("_creationTime", args.window.startMs)
            .lt("_creationTime", args.window.endMs),
        )
        .filter((q) =>
          q.or(
            q.eq(q.field("type"), "concern"),
            q.eq(q.field("type"), "intervention"),
            q.neq(q.field("category"), undefined),
          ),
        )
        .order("desc")
        .take(EVIDENCE_PER_KIND_LIMIT),
      ctx.db
        .query("alerts")
        .withIndex("by_scholar_created", (q) =>
          q
            .eq("scholarId", args.scholarId)
            .gte("createdAt", args.window.startMs)
            .lt("createdAt", args.window.endMs),
        )
        .order("desc")
        .take(EVIDENCE_PER_KIND_LIMIT),
      ctx.db
        .query("sessions")
        .withIndex("by_user", (q) =>
          q
            .eq("userId", args.scholarId)
            .gte(
              "_creationTime",
              args.window.startMs - SESSION_WINDOW_MARGIN_MS,
            )
            .lt(
              "_creationTime",
              args.window.endMs + SESSION_WINDOW_MARGIN_MS,
            ),
        )
        .order("desc")
        .take(SESSION_FANOUT_LIMIT),
    ]);

    const eligibleSessions = sessions.filter(
      (session) =>
        !session.isTestDrive && !session.isArchived && !session.isOffline,
    );
    const analyses = (
      await Promise.all(
        eligibleSessions.map((session) =>
          ctx.db
            .query("analyses")
            .withIndex("by_session", (q) =>
              q
                .eq("sessionId", session._id)
                .gte("_creationTime", args.window.startMs)
                .lt("_creationTime", args.window.endMs),
            )
            .order("desc")
            .take(EVIDENCE_PER_KIND_LIMIT),
        ),
      )
    )
      .flat()
      .sort((a, b) => b._creationTime - a._creationTime)
      .slice(0, EVIDENCE_PER_KIND_LIMIT);

    const evidence: SelSynthesisEvidence[] = [
      ...signals.map((row) => ({
        citation: {
          kind: "sessionSignal" as const,
          id: String(row._id),
          label: row.signalType,
          at: row._creationTime,
        },
        details: {
          signalType: row.signalType,
          description: truncateEvidenceText(row.description),
          intensity: row.intensity,
          pcmDimension: row.pcmDimension,
          transcriptExcerpt: truncateEvidenceText(row.transcriptExcerpt),
          sessionId: String(row.sessionId),
        },
      })),
      ...analyses.map((row) => ({
        citation: {
          kind: "analysis" as const,
          id: String(row._id),
          label: "Observer analysis",
          at: row._creationTime,
        },
        details: {
          sessionId: String(row.sessionId),
          engagement: row.engagementScore,
          onTask: row.onTaskScore,
          concernFlags: row.concernFlags ?? [],
          summary: truncateEvidenceText(row.summary),
          suggestedIntervention: truncateEvidenceText(
            row.suggestedIntervention,
          ),
        },
      })),
      ...alerts.map((row) => ({
        citation: {
          kind: "alert" as const,
          id: String(row._id),
          label: row.title,
          at: row.createdAt,
        },
        details: {
          kind: row.kind,
          severity: row.severity,
          title: row.title,
          body: truncateEvidenceText(row.body),
          sessionId: row.sessionId ? String(row.sessionId) : undefined,
        },
      })),
      ...observations.map((row) => ({
        citation: {
          kind: "observation" as const,
          id: String(row._id),
          label: row.category
            ? `${row.type} · ${row.category}`
            : row.type,
          at: row._creationTime,
        },
        details: {
          type: row.type,
          category: row.category,
          note: truncateEvidenceText(row.note),
          weight: row.weight,
          sessionId: row.sessionId ? String(row.sessionId) : undefined,
        },
      })),
    ];

    return {
      scholarId: scholar._id,
      scholarName: scholar.name ?? scholar.username ?? "Scholar",
      institutionId: scholar.institutionId,
      evidence,
    };
  },
});

/** Enrolled scholars only; Extended Education guests have a separate context. */
export const eligibleScholarsForWeek = internalQuery({
  args: { institutionId: v.id("institutions") },
  handler: async (ctx, args) => {
    const institution = await ctx.db.get(args.institutionId);
    if (!institution) throw new Error("Institution not found");
    const scholars = await ctx.db
      .query("users")
      .withIndex("by_institution_role", (q) =>
        q.eq("institutionId", args.institutionId).eq("role", "scholar"),
      )
      .collect();
    return scholars
      .filter((scholar) => scholar.enrollmentStanding !== "program_guest")
      .sort(
        (a, b) =>
          (a.name ?? a.username ?? "").localeCompare(
            b.name ?? b.username ?? "",
          ) || String(a._id).localeCompare(String(b._id)),
      )
      .map((scholar) => scholar._id);
  },
});

/** Replace the stable scholar/week artifact rather than appending generations. */
export const upsert = internalMutation({
  args: {
    scholarId: v.id("users"),
    institutionId: v.id("institutions"),
    weekKey: v.string(),
    strengths: v.array(claimValidator),
    watch: v.array(claimValidator),
    quiet: v.boolean(),
    window: windowValidator,
    model: v.string(),
    promptVersion: v.string(),
    generatedAt: v.number(),
  },
  handler: async (ctx, args) => {
    assertValidWindow(args.window);
    const existing = await ctx.db
      .query("selSyntheses")
      .withIndex("by_scholar_week", (q) =>
        q.eq("scholarId", args.scholarId).eq("weekKey", args.weekKey),
      )
      .unique();
    if (existing) {
      await ctx.db.patch(existing._id, args);
      return await ctx.db.get(existing._id);
    }
    const id = await ctx.db.insert("selSyntheses", args);
    return await ctx.db.get(id);
  },
});

/** The sole public read for this table; no tutor or scholar consumer exists. */
export const forScholarWeek = teacherQuery({
  args: { scholarId: v.id("users"), weekKey: v.string() },
  handler: async (ctx, args) => {
    await requireActiveScholarAccess(ctx, ctx.user, args.scholarId);
    return await ctx.db
      .query("selSyntheses")
      .withIndex("by_scholar_week", (q) =>
        q.eq("scholarId", args.scholarId).eq("weekKey", args.weekKey),
      )
      .unique();
  },
});

/** Mirrors the board's other batched roster reads (figures, levels): a bounded
 *  fan-out capped at 60, throwing over rather than truncating the projected
 *  roster, so the SEL board reads one synthesis per scholar in a batch instead
 *  of N per-scholar subscriptions. */
export const SEL_SYNTHESES_MAX_SCHOLARS = 60;

export const forScholarsWeek = teacherQuery({
  args: { scholarIds: v.array(v.id("users")), weekKey: v.string() },
  handler: async (ctx, args) => {
    // De-duplicate before bounding so a caller repeating an id can't be
    // spuriously rejected — the same discipline the figures/levels reads use.
    const scholarIds = Array.from(new Set(args.scholarIds));
    if (scholarIds.length === 0) return { rows: [] };
    if (scholarIds.length > SEL_SYNTHESES_MAX_SCHOLARS) {
      throw new Error(
        `forScholarsWeek: ${scholarIds.length} scholars requested, limit is ${SEL_SYNTHESES_MAX_SCHOLARS}. Page the roster rather than truncating it.`,
      );
    }
    // The auth wrapper checks role only; prove every roster row is genuinely
    // readable in this caller's institution context before a single read.
    await requireScholarsAccessible(ctx, ctx.user, scholarIds);

    const rows: Array<
      Pick<
        Doc<"selSyntheses">,
        "strengths" | "watch" | "quiet" | "generatedAt" | "model" | "promptVersion"
      > & { scholarId: string }
    > = [];
    for (const scholarId of scholarIds) {
      const synthesis = await ctx.db
        .query("selSyntheses")
        .withIndex("by_scholar_week", (q) =>
          q.eq("scholarId", scholarId).eq("weekKey", args.weekKey),
        )
        .unique();
      if (!synthesis) continue;
      rows.push({
        scholarId: String(scholarId),
        strengths: synthesis.strengths,
        watch: synthesis.watch,
        quiet: synthesis.quiet,
        generatedAt: synthesis.generatedAt,
        model: synthesis.model,
        promptVersion: synthesis.promptVersion,
      });
    }
    return { rows };
  },
});

/** Rehearsal-only trigger. Scheduling remains a separate cadence-lane concern. */
export const generateForWeek = teacherMutation({
  args: {
    institutionId: v.id("institutions"),
    weekKey: v.string(),
    window: windowValidator,
  },
  handler: async (ctx, args) => {
    assertValidWindow(args.window);
    await assertCuratableInstitution(ctx, ctx.user, args.institutionId);
    await ctx.scheduler.runAfter(
      0,
      internal.selSynthesisActions.generateSelSynthesesForWeek,
      args,
    );
    return { scheduled: true };
  },
});
