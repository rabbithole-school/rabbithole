// Debrief → Key Moments: the substantive, real-scholar half of Debrief.
//
// After a cohort has done an activity, this rolls up the most interesting
// real moments — mastery breakthroughs, flagged misconceptions, strong
// learning signals, cross-domain insights — from the observer's output
// across that activity's real sessions, scores each (lib/momentInterest),
// and serves a deck the teacher triages (keep / dismiss). Kept moments are
// where the teacher acts (log an observation, add a directive — reusing the
// existing mutations). Pairs with `activityReflections` (the curriculum
// self-reflection). See the TODO + review/curriculum-rehearse-and-maturity.md.
//
// Teacher-gated: it reads scholar records across the cohort.

import { v } from "convex/values";
import {
  teacherQuery,
  teacherMutation,
  authedQuery,
} from "./lib/customFunctions";
import { internalQuery } from "./_generated/server";
import type { QueryCtx } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import { sessionSignalMeta } from "../shared/learningSignals";
import {
  scoreMastery,
  scoreSignal,
  scoreConnection,
  type MomentKind,
} from "./lib/momentInterestingness";
import { requireTeacherOrSelf } from "./lib/auth";
import { requireActiveScholarAccess } from "./lib/access";
import { timeZoneForScholar } from "./lib/institutionTime";
import { dayStartForDayKey, shiftDayKey } from "../shared/institutionDay";

const sourceValidator = v.union(
  v.literal("mastery"),
  v.literal("signal"),
  v.literal("connection"),
);

// "creative_approach" → "Creative approach"
type Moment = {
  source: "mastery" | "signal" | "connection";
  sourceId: string;
  kind: MomentKind;
  score: number;
  scholarId: Id<"users">;
  scholarName: string;
  sessionId: Id<"sessions">;
  label: string; // the headline (concept / signal name / domains)
  excerpt: string; // the evidence/description
  domain: string | null;
};

/**
 * The Key Moments deck for one activity: `pending` (untriaged, sorted by
 * interestingness) + `kept` (saved for action). Dismissed moments are
 * hidden. Scoped to the calling teacher's triage state.
 */
export const forActivity = teacherQuery({
  args: { activityId: v.id("activities"), limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    // Real sessions for this activity (exclude teacher rehearsal drives).
    const sessions = await ctx.db
      .query("sessions")
      .withIndex("by_activity", (q) => q.eq("activityId", args.activityId))
      .collect();
    const realSessions = sessions.filter((s) => !s.isTestDrive);

    // This teacher's existing verdicts for this activity.
    const triaged = await ctx.db
      .query("momentTriage")
      .withIndex("by_activity_teacher", (q) =>
        q.eq("activityId", args.activityId).eq("teacherId", ctx.user._id),
      )
      .collect();
    const verdictByKey = new Map(
      triaged.map((t) => [`${t.source}:${t.sourceId}`, t.verdict]),
    );

    const nameCache = new Map<string, string>();
    const nameOf = async (id: Id<"users">): Promise<string> => {
      const cached = nameCache.get(id);
      if (cached) return cached;
      const u = await ctx.db.get(id);
      const n = u?.name ?? "Scholar";
      nameCache.set(id, n);
      return n;
    };

    const moments: Moment[] = [];
    for (const s of realSessions) {
      const mastery = await ctx.db
        .query("masteryObservations")
        .withIndex("by_session", (q) => q.eq("sessionId", s._id))
        .collect();
      for (const o of mastery) {
        if (o.isSuperseded) continue;
        const { score, kind } = scoreMastery(o);
        moments.push({
          source: "mastery",
          sourceId: o._id,
          kind,
          score,
          scholarId: o.scholarId,
          scholarName: await nameOf(o.scholarId),
          sessionId: s._id,
          label: o.conceptLabel,
          excerpt: o.evidenceSummary || o.transcriptExcerpt,
          domain: o.domain,
        });
      }
      const signals = await ctx.db
        .query("sessionSignals")
        .withIndex("by_session", (q) => q.eq("sessionId", s._id))
        .collect();
      for (const sig of signals) {
        const { score, kind } = scoreSignal(sig);
        moments.push({
          source: "signal",
          sourceId: sig._id,
          kind,
          score,
          scholarId: sig.scholarId,
          scholarName: await nameOf(sig.scholarId),
          sessionId: s._id,
          label: sessionSignalMeta(sig.signalType)?.teacherLabel ?? sig.signalType,
          excerpt: sig.description,
          domain: null,
        });
      }
      const conns = await ctx.db
        .query("crossDomainConnections")
        .withIndex("by_session", (q) => q.eq("sessionId", s._id))
        .collect();
      for (const c of conns) {
        const { score, kind } = scoreConnection(c);
        moments.push({
          source: "connection",
          sourceId: c._id,
          kind,
          score,
          scholarId: c.scholarId,
          scholarName: await nameOf(c.scholarId),
          sessionId: s._id,
          label: c.conceptLabels.join(" ↔ "),
          excerpt: c.description,
          domain: c.domains.join(", "),
        });
      }
    }

    const limit = args.limit ?? 40;
    const verdict = (m: Moment) =>
      verdictByKey.get(`${m.source}:${m.sourceId}`) ?? null;
    const byScore = (a: Moment, b: Moment) => b.score - a.score;

    const pending = moments
      .filter((m) => verdict(m) === null)
      .sort(byScore)
      .slice(0, limit);
    const kept = moments.filter((m) => verdict(m) === "kept").sort(byScore);

    return {
      pending,
      kept,
      sessionCount: realSessions.length,
      totalMoments: moments.length,
    };
  },
});

/**
 * ⚠️ REDACTION BOUNDARY — this read feeds the Special Delivery daily letter, a
 * sheet of paper that goes HOME TO A PARENT. The two kinds of text a moment
 * carries must never be confused, so they are returned under deliberately
 * distinct names (never merged into one "excerpt" field the way `forActivity`
 * does for the teacher deck):
 *
 *   • `scholarVerbatim` — the scholar's OWN words (the observer's
 *     `transcriptExcerpt`). SAFE to quote on the printed letter. May be null
 *     when the observer captured no verbatim excerpt for the row.
 *
 *   • `observerAnalysis` — the observer's ANALYSIS of the scholar (mastery
 *     `evidenceSummary`, signal `description`, connection `description`). This
 *     is TEACHER-FACING and must NEVER be printed on the parent letter. It is
 *     returned only so a teacher-facing caller / the grounded letter generator
 *     can reason over it; the print layer must read `scholarVerbatim` only.
 *
 * `collectScholarDayMoments` (below) always returns the rich, `observerAnalysis`-
 * bearing row — it has no identity to gate on. The boundary is enforced one
 * layer up, in `forScholarDay`: a scholar reading their OWN day gets the field
 * stripped from every row entirely (never nulled/emptied — a client must never
 * see even an empty `observerAnalysis` key on a self read). Teacher reads (via
 * `forScholarDay`) and the no-identity cron read (`forScholarDayInternal`) keep
 * the full row.
 */
type ScholarDayMoment = {
  source: "mastery" | "signal" | "connection";
  sourceId: string;
  kind: MomentKind;
  score: number;
  scholarId: Id<"users">;
  sessionId: Id<"sessions"> | null;
  label: string; // the headline (concept / signal name / domains)
  domain: string | null;
  scholarVerbatim: string | null; // scholar's own words — printable
  observerAnalysis: string; // observer's analysis — TEACHER-FACING, never print
};

/**
 * The most interesting Key Moments for ONE scholar on ONE institution-local
 * day — the by-scholar-and-day counterpart of `forActivity` (which is by
 * activity, across a cohort). Same sources (mastery / signals / connections),
 * same scorer, same exclusions (superseded mastery rows, test-drive sessions).
 * A row belongs to `dayKey` when its own timestamp — mastery `observedAt`,
 * signal/connection `_creationTime` — falls in that local day for the SCHOLAR's
 * institution timezone (never UTC). Sorted by interestingness, capped by limit.
 */
/**
 * The gather → day-filter → score → sort core of the by-scholar-and-day Key
 * Moments read, with NO auth. It has two real consumers with different identity
 * shapes: `forScholarDay` (an `authedQuery`, teacher-/self-facing) gates on the
 * caller and then calls this; the Special Delivery generator runs from a cron
 * as an internal action with no user identity and reaches it via the
 * `forScholarDayInternal` wrapper. Callers MUST enforce access before calling.
 */
export async function collectScholarDayMoments(
  ctx: QueryCtx,
  args: { scholarId: Id<"users">; dayKey: string; limit?: number },
): Promise<ScholarDayMoment[]> {
  const timeZone = await timeZoneForScholar(ctx, args.scholarId);
  // The institution-local day's [start, end) epoch bounds, used to range on
  // an index rather than scanning a scholar's entire lifetime of rows —
  // never a hardcoded UTC boundary (see institutionDay.ts / institutionTime.ts).
  const dayStartMs = dayStartForDayKey(args.dayKey, timeZone);
  const dayEndMs = dayStartForDayKey(shiftDayKey(args.dayKey, 1), timeZone);

  // A moment's session decides test-drive exclusion. Cache lookups; a
  // session-less mastery row (Workshop reflection) is never a test drive.
  const testDriveCache = new Map<string, boolean>();
  const isTestDriveSession = async (
    sessionId: Id<"sessions"> | undefined,
  ): Promise<boolean> => {
    if (!sessionId) return false;
    const cached = testDriveCache.get(sessionId);
    if (cached !== undefined) return cached;
    const s = await ctx.db.get(sessionId);
    const drive = s?.isTestDrive === true;
    testDriveCache.set(sessionId, drive);
    return drive;
  };

  const moments: ScholarDayMoment[] = [];

  // Ranges on `observedAt` (the row's own timestamp), via the dedicated
  // by_scholar_observedAt index — bounded to the one local day instead of an
  // unbounded by_scholar scan over the scholar's whole history.
  const mastery = await ctx.db
    .query("masteryObservations")
    .withIndex("by_scholar_observedAt", (q) =>
      q
        .eq("scholarId", args.scholarId)
        .gte("observedAt", dayStartMs)
        .lt("observedAt", dayEndMs),
    )
    .collect();
  for (const o of mastery) {
    if (o.isSuperseded) continue;
    if (await isTestDriveSession(o.sessionId)) continue;
    const { score, kind } = scoreMastery(o);
    moments.push({
      source: "mastery",
      sourceId: o._id,
      kind,
      score,
      scholarId: o.scholarId,
      sessionId: o.sessionId ?? null,
      label: o.conceptLabel,
      domain: o.domain,
      scholarVerbatim: o.transcriptExcerpt || null,
      observerAnalysis: o.evidenceSummary,
    });
  }

  // Signals/connections have no observedAt of their own; range on the
  // implicit `_creationTime` tiebreak of by_scholar instead — still bounded
  // to the one local day, never an unbounded scan.
  const signals = await ctx.db
    .query("sessionSignals")
    .withIndex("by_scholar", (q) =>
      q
        .eq("scholarId", args.scholarId)
        .gte("_creationTime", dayStartMs)
        .lt("_creationTime", dayEndMs),
    )
    .collect();
  for (const sig of signals) {
    if (await isTestDriveSession(sig.sessionId)) continue;
    const { score, kind } = scoreSignal(sig);
    moments.push({
      source: "signal",
      sourceId: sig._id,
      kind,
      score,
      scholarId: sig.scholarId,
      sessionId: sig.sessionId,
      label: sessionSignalMeta(sig.signalType)?.teacherLabel ?? sig.signalType,
      domain: null,
      scholarVerbatim: sig.transcriptExcerpt || null,
      observerAnalysis: sig.description,
    });
  }

  const conns = await ctx.db
    .query("crossDomainConnections")
    .withIndex("by_scholar", (q) =>
      q
        .eq("scholarId", args.scholarId)
        .gte("_creationTime", dayStartMs)
        .lt("_creationTime", dayEndMs),
    )
    .collect();
  for (const c of conns) {
    if (await isTestDriveSession(c.sessionId)) continue;
    const { score, kind } = scoreConnection(c);
    moments.push({
      source: "connection",
      sourceId: c._id,
      kind,
      score,
      scholarId: c.scholarId,
      sessionId: c.sessionId,
      label: c.conceptLabels.join(" ↔ "),
      domain: c.domains.join(", "),
      scholarVerbatim: c.transcriptExcerpt || null,
      observerAnalysis: c.description,
    });
  }

  const limit = args.limit ?? 12;
  return moments.sort((a, b) => b.score - a.score).slice(0, limit);
}

export const forScholarDay = authedQuery({
  args: {
    scholarId: v.id("users"),
    dayKey: v.string(),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    // Same access vocabulary as the sibling *ForScholar reads
    // (masteryObservations.listForScholar, sessionSignals.signalProfile):
    // self may read their own; a teacher only within their active
    // institution context. A role check alone would be a cross-tenant leak.
    const isTeacher = requireTeacherOrSelf(ctx.user, args.scholarId);
    if (isTeacher) {
      await requireActiveScholarAccess(ctx, ctx.user, args.scholarId);
    }

    const moments = await collectScholarDayMoments(ctx, args);

    // ⚠️ REDACTION BOUNDARY (continued from the type comment above): a
    // scholar reading their OWN day must never receive `observerAnalysis` —
    // it is teacher-facing analysis of the scholar, not something to hand
    // back to them. Strip the field entirely (never null it out) rather than
    // leaving it present-but-empty, so a client can't accidentally surface a
    // falsy-but-present field. Teacher and internal (cron) callers keep the
    // full, rich row.
    if (!isTeacher) {
      return moments.map(({ observerAnalysis: _observerAnalysis, ...safe }) => safe);
    }
    return moments;
  },
});

/**
 * No-identity counterpart of `forScholarDay` for the Special Delivery
 * generator, which runs from a cron as an internal action with no user to gate
 * on. Same gather/day-filter/score/sort core; the redaction boundary
 * (`scholarVerbatim` vs. `observerAnalysis`) is preserved by the shared return
 * shape. Only reachable from trusted server code — internal functions are not
 * exposed to clients.
 */
export const forScholarDayInternal = internalQuery({
  args: {
    scholarId: v.id("users"),
    dayKey: v.string(),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => await collectScholarDayMoments(ctx, args),
});

/** Keep or dismiss a moment (idempotent re-triage). */
export const triage = teacherMutation({
  args: {
    activityId: v.id("activities"),
    source: sourceValidator,
    sourceId: v.string(),
    verdict: v.union(v.literal("kept"), v.literal("dismissed")),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("momentTriage")
      .withIndex("by_source", (q) =>
        q
          .eq("activityId", args.activityId)
          .eq("teacherId", ctx.user._id)
          .eq("source", args.source)
          .eq("sourceId", args.sourceId),
      )
      .first();
    if (existing) {
      await ctx.db.patch(existing._id, {
        verdict: args.verdict,
        triagedAt: Date.now(),
      });
      return existing._id;
    }
    return await ctx.db.insert("momentTriage", {
      teacherId: ctx.user._id,
      activityId: args.activityId,
      source: args.source,
      sourceId: args.sourceId,
      verdict: args.verdict,
      triagedAt: Date.now(),
    });
  },
});

/** The teacher's curriculum reflection on this activity (the self-reflect half). */
export const reflection = teacherQuery({
  args: { activityId: v.id("activities") },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("activityReflections")
      .withIndex("by_activity_teacher", (q) =>
        q.eq("activityId", args.activityId).eq("teacherId", ctx.user._id),
      )
      .first();
  },
});

export const recordReflection = teacherMutation({
  args: { activityId: v.id("activities"), content: v.string() },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("activityReflections")
      .withIndex("by_activity_teacher", (q) =>
        q.eq("activityId", args.activityId).eq("teacherId", ctx.user._id),
      )
      .first();
    if (existing) {
      await ctx.db.patch(existing._id, {
        content: args.content.trim(),
        updatedAt: Date.now(),
      });
      return existing._id;
    }
    return await ctx.db.insert("activityReflections", {
      activityId: args.activityId,
      teacherId: ctx.user._id,
      content: args.content.trim(),
      updatedAt: Date.now(),
    });
  },
});

/**
 * The live RUNS of this activity — one row per assignment a real cohort has
 * worked it under. The curriculum (cohort-agnostic) Debrief uses this to
 * point the teacher DOWN to where the per-run, act-now reads live: the
 * Assignments Run page. Real sessions only (teacher rehearsals excluded);
 * sorted most-recent first.
 */
export const runsForActivity = teacherQuery({
  args: { activityId: v.id("activities") },
  handler: async (ctx, args) => {
    const sessions = await ctx.db
      .query("sessions")
      .withIndex("by_activity", (q) => q.eq("activityId", args.activityId))
      .collect();

    // Group real sessions by the assignment (run) they belong to.
    const byAssignment = new Map<string, Set<string>>();
    for (const s of sessions) {
      if (s.isTestDrive || !s.assignmentId) continue;
      const key = String(s.assignmentId);
      const set = byAssignment.get(key) ?? new Set<string>();
      set.add(String(s.userId));
      byAssignment.set(key, set);
    }

    const runs = await Promise.all(
      [...byAssignment.entries()].map(async ([assignmentId, scholarSet]) => {
        const a = await ctx.db.get(assignmentId as Id<"assignments">);
        if (!a || a.teacherId !== ctx.user._id) return null;
        const unit = a.unitId ? await ctx.db.get(a.unitId) : null;
        const completions = await ctx.db
          .query("activityCompletions")
          .withIndex("by_assignment", (q) =>
            q.eq("assignmentId", a._id),
          )
          .collect();
        const doneCount = completions.filter(
          (c) => String(c.activityId) === String(args.activityId),
        ).length;
        return {
          assignmentId: a._id,
          unitId: a.unitId,
          title: a.title ?? unit?.title ?? "Untitled run",
          startedAt: a.startedAt,
          scholarCount: scholarSet.size,
          doneCount,
        };
      }),
    );

    return runs
      .filter((r): r is NonNullable<typeof r> => r !== null)
      .sort((a, b) => b.startedAt - a.startedAt);
  },
});
