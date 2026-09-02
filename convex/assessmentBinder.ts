import { v } from "convex/values";
import { teacherQuery } from "./lib/customFunctions";
import { requireActiveScholarAccess } from "./lib/access";
import {
  type EvidenceItem,
  type BinderDimension,
  buildDimensionBriefs,
  clusterEpisodes,
  coverageLabel,
} from "./lib/assessmentBinder";

/**
 * The evidence binder (review/assessment-and-goals-plan.html §6): a per-scholar
 * × period (× subject via unitIds) assembly of everything the record holds,
 * organized by PCM dimension, ready to brief a narrative. A computed read (no
 * stored artifact) — always current; a BME snapshot is just this with a frozen
 * range. The weighting rules (episodes/contexts/major/thin) live in
 * lib/assessmentBinder.ts so they're unit-tested and shared with differentiation.
 */
export const forScholar = teacherQuery({
  args: {
    scholarId: v.id("users"),
    periodId: v.id("reportingPeriods"),
    subject: v.optional(v.string()),
    // The subject's units this period (from the narrative setup). Scopes
    // granule + deliverable evidence; when empty, those lanes are skipped.
    unitIds: v.optional(v.array(v.id("units"))),
  },
  handler: async (ctx, args) => {
    await requireActiveScholarAccess(ctx, ctx.user, args.scholarId);
    const period = await ctx.db.get(args.periodId);
    if (!period) throw new Error("Reporting period not found");
    const { startsAt, endsAt } = period;
    const inWindow = (t: number) => t >= startsAt && t <= endsAt;
    const unitIds = args.unitIds ?? [];

    const items: EvidenceItem[] = [];
    const counterEvidence: {
      source: string;
      summary: string;
      at: number;
      dimension: BinderDimension | null;
    }[] = [];
    let onPlatform = 0;
    let offPlatform = 0;

    const pcmOf = (
      tag: string | undefined,
      source: string,
      hint?: { signalType?: string },
    ): BinderDimension | null => {
      if (tag === "core" || tag === "connections" || tag === "practice" || tag === "identity")
        return tag;
      // Lazy import avoided — heuristic inlined via the shared helper.
      return heuristic(source, hint);
    };

    // ── Mastery (Core) ── non-superseded, in window. Misconceptions → counter.
    const mastery = await ctx.db
      .query("masteryObservations")
      .withIndex("by_scholar_current", (q) =>
        q.eq("scholarId", args.scholarId).eq("isSuperseded", false),
      )
      .collect();
    for (const m of mastery) {
      if (!inWindow(m.observedAt)) continue;
      onPlatform++;
      if (m.evidenceType === "misconception_signal") {
        counterEvidence.push({
          source: "misconception",
          summary: `${m.conceptLabel}: ${m.evidenceSummary}`,
          at: m.observedAt,
          dimension: "core",
        });
        continue;
      }
      items.push({
        dimension: pcmOf(m.pcmDimension, "mastery"),
        source: "mastery",
        summary: `${m.conceptLabel} (${m.domain})`,
        detail: m.evidenceSummary,
        at: m.observedAt,
        context: m.domain,
        studentInitiated: m.studentInitiated,
      });
    }

    // ── Granules (Core) ── per provided unit.
    for (const unitId of unitIds) {
      const granules = await ctx.db
        .query("granuleEvidence")
        .withIndex("by_scholar_unit", (q) =>
          q.eq("scholarId", args.scholarId).eq("unitId", unitId),
        )
        .collect();
      for (const g of granules) {
        if (!inWindow(g.observedAt)) continue;
        onPlatform++;
        items.push({
          dimension: "core",
          source: "granule",
          summary: `${g.outcome === "demonstrated" ? "Demonstrated" : "Probed"}: ${g.evidenceSummary}`,
          detail: g.transcriptExcerpt,
          at: g.observedAt,
          context: `unit:${unitId}`,
        });
      }
    }

    // ── Connections ──
    const connections = await ctx.db
      .query("crossDomainConnections")
      .withIndex("by_scholar", (q) => q.eq("scholarId", args.scholarId))
      .collect();
    for (const c of connections) {
      if (!inWindow(c._creationTime)) continue;
      onPlatform++;
      items.push({
        dimension: pcmOf(c.pcmDimension, "connection"),
        source: "connection",
        summary: c.description,
        detail: c.transcriptExcerpt,
        at: c._creationTime,
        context: [...c.domains].sort().join("+"),
        studentInitiated: c.studentInitiated,
      });
    }

    // ── Signals (Practice / Identity) ──
    const signals = await ctx.db
      .query("sessionSignals")
      .withIndex("by_scholar", (q) => q.eq("scholarId", args.scholarId))
      .collect();
    for (const s of signals) {
      if (!inWindow(s._creationTime)) continue;
      onPlatform++;
      items.push({
        dimension: pcmOf(s.pcmDimension, "signal", { signalType: s.signalType }),
        source: "signal",
        summary: `${s.signalType.replace(/_/g, " ")}: ${s.description}`,
        at: s._creationTime,
        context: s.signalType,
      });
    }

    // ── Deliverables (Practice) ──
    const deliverables = await ctx.db
      .query("deliverables")
      .withIndex("by_scholar", (q) => q.eq("scholarId", args.scholarId))
      .collect();
    for (const d of deliverables) {
      if (!inWindow(d.submittedAt)) continue;
      if (unitIds.length > 0) {
        const activity = await ctx.db.get(d.activityId);
        const lessonId = activity?.lessonId;
        const lesson = lessonId ? await ctx.db.get(lessonId) : null;
        // Only exclude when we can positively place it OUTSIDE the subject's
        // units; unresolvable links are kept rather than silently dropped.
        if (lesson && !unitIds.includes(lesson.unitId)) continue;
      }
      onPlatform++;
      const metCount = (d.verdicts ?? []).filter((verd) => verd.level === "full").length;
      const total = (d.verdicts ?? []).length;
      items.push({
        dimension: "practice",
        source: "deliverable",
        summary:
          total > 0
            ? `Deliverable: ${metCount}/${total} criteria met`
            : `Deliverable submitted${d.overall ? ` (${d.overall})` : ""}`,
        detail: d.rubricFeedback,
        at: d.submittedAt,
        context: `activity:${d.activityId}`,
      });
    }

    // ── Seeds explored (Identity) ──
    const seeds = await ctx.db
      .query("seeds")
      .withIndex("by_scholar_status", (q) => q.eq("scholarId", args.scholarId))
      .collect();
    for (const seed of seeds) {
      const at = seed.completedAt ?? seed._creationTime;
      if (!inWindow(at)) continue;
      if (seed.status !== "completed" && seed.status !== "active") continue;
      onPlatform++;
      items.push({
        dimension: "identity",
        source: "seed",
        summary: `Explored: ${seed.topic}`,
        at,
        context: seed.domain ?? seed.topic,
      });
    }

    // ── Anecdotes (teacher observations — major first) ── OFF-platform.
    const observations = await ctx.db
      .query("observations")
      .withIndex("by_scholar", (q) => q.eq("scholarId", args.scholarId))
      .collect();
    const anecdoteItems: EvidenceItem[] = [];
    for (const o of observations) {
      if (!inWindow(o._creationTime)) continue;
      offPlatform++;
      if (o.type === "concern" || o.type === "intervention") {
        counterEvidence.push({
          source: `obs:${o.type}`,
          summary: o.note,
          at: o._creationTime,
          dimension: null,
        });
      }
      anecdoteItems.push({
        dimension: null,
        source: `obs:${o.type}`,
        summary: o.note,
        at: o._creationTime,
        context: o.type,
        weight: o.weight ?? "minor",
      });
    }
    const anecdotes = clusterEpisodes(anecdoteItems);

    // ── Last period's goals + everything recorded against them ──
    const goals = await ctx.db
      .query("scholarGoals")
      .withIndex("by_scholar", (q) => q.eq("scholarId", args.scholarId))
      .collect();
    const relevantGoals = goals.filter(
      (g) => g.status === "active" || g.status === "achieved",
    );
    const lastGoals = await Promise.all(
      relevantGoals.map(async (g) => {
        const checkins = await ctx.db
          .query("goalCheckins")
          .withIndex("by_goal", (q) => q.eq("goalId", g._id))
          .order("desc")
          .collect();
        return {
          _id: g._id,
          title: g.title,
          kind: g.kind,
          status: g.status,
          checkins: checkins.map((c) => ({
            note: c.note,
            at: c._creationTime,
            authorType: c.authorType,
          })),
        };
      }),
    );

    const byDimension = buildDimensionBriefs(items);
    const scholar = await ctx.db.get(args.scholarId);

    return {
      scholar: { _id: args.scholarId, name: scholar?.name ?? "Scholar" },
      period: { _id: period._id, label: period.label, startsAt, endsAt },
      subject: args.subject ?? null,
      byDimension,
      anecdotes,
      counterEvidence: counterEvidence.sort((a, b) => b.at - a.at),
      lastGoals,
      coverage: coverageLabel(onPlatform, offPlatform),
      counts: {
        core: byDimension.core.episodeCount,
        connections: byDimension.connections.episodeCount,
        practice: byDimension.practice.episodeCount,
        identity: byDimension.identity.episodeCount,
        anecdotes: anecdotes.length,
        counterEvidence: counterEvidence.length,
        onPlatform,
        offPlatform,
      },
    };
  },
});

// Inlined heuristic (kept local to avoid a cross-module import cycle in the
// query; mirrors lib/assessmentBinder.heuristicDimension).
function heuristic(
  source: string,
  hint?: { signalType?: string },
): BinderDimension | null {
  switch (source) {
    case "mastery":
    case "granule":
      return "core";
    case "connection":
      return "connections";
    case "deliverable":
      return "practice";
    case "seed":
      return "identity";
    case "signal": {
      const st = hint?.signalType ?? "";
      return ["productive_struggle", "metacognition", "task_commitment"].includes(st)
        ? "practice"
        : "identity";
    }
    default:
      return null;
  }
}
