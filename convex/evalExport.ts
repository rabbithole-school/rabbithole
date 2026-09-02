import { v } from "convex/values";
import { internalQuery } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";

/**
 * Eval-only export of real transcripts for the observer eval harness
 * (`evals/observer/`). Internal query — invoke via:
 *
 *   CONVEX_DEPLOYMENT=<development-deployment> \
 *     npx convex run evalExport:transcripts '{"minMessages":6,"limit":20}'
 *
 * Returns non-test-drive projects that have enough conversation to be worth
 * analyzing, each with its transcript and a snapshot of the observer output it
 * already produced in production (so the harness can show "what shipped" beside
 * "what the eval models produce"). Never run against prod without approval — and
 * there's no reason to; the harness only needs sample shapes, not real kids' data.
 */
export const transcripts = internalQuery({
  args: {
    minMessages: v.optional(v.number()),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const minMessages = args.minMessages ?? 6;
    const limit = args.limit ?? 25;

    const sessions = await ctx.db.query("sessions").collect();
    const out: Array<Record<string, unknown>> = [];

    for (const session of sessions) {
      if (out.length >= limit) break;
      if (session.isTestDrive) continue;

      const messages = await ctx.db
        .query("messages")
        .withIndex("by_session", (q) => q.eq("sessionId", session._id))
        .order("asc")
        .collect();

      const convo = messages
        .filter((m) => m.role === "user" || m.role === "assistant")
        .map((m) => ({ role: m.role, content: m.content }));

      if (convo.length < minMessages) continue;

      const scholar = await ctx.db.get(session.userId);
      const unit = session.unitId ? await ctx.db.get(session.unitId) : null;

      // Snapshot what production already wrote for this project.
      const analysis = await ctx.db
        .query("analyses")
        .withIndex("by_session", (q) => q.eq("sessionId", session._id))
        .order("desc")
        .first();

      const shippedObservations = await ctx.db
        .query("masteryObservations")
        .withIndex("by_session", (q) => q.eq("sessionId", session._id))
        .collect();

      const shippedSignals = await ctx.db
        .query("sessionSignals")
        .withIndex("by_session", (q) => q.eq("sessionId", session._id))
        .collect();

      out.push({
        sessionId: session._id,
        title: session.title ?? "Untitled",
        scholarName: scholar?.name ?? null,
        unitTitle: unit?.title ?? null,
        messageCount: convo.length,
        transcript: convo,
        shipped: {
          pulse: analysis
            ? {
                summary: analysis.summary ?? null,
                topics: analysis.topics ?? [],
                concernFlags: analysis.concernFlags ?? [],
              }
            : null,
          observations: shippedObservations.map((o) => ({
            conceptLabel: o.conceptLabel,
            domain: o.domain,
            masteryLevel: o.masteryLevel,
            confidenceScore: o.confidenceScore,
            evidenceType: o.evidenceType,
            isSuperseded: o.isSuperseded,
          })),
          signals: shippedSignals.map((s) => ({
            signalType: s.signalType,
            intensity: s.intensity,
          })),
        },
      });
    }

    return out;
  },
});

/**
 * Single-project transcript export for the tutor-quality eval harness
 * (`evals/tutor-quality/`). Internal query — invoke via:
 *
 *   CONVEX_DEPLOYMENT=<production-deployment> \
 *     npx convex run evalExport:transcript '{"sessionId":"..."}'
 *
 * Unlike `transcripts` (above), this is meant to be runnable against prod with
 * explicit per-turn approval — the eval is FOR judging shipped sessions, so it
 * has to be able to fetch them. Returns just enough scholar + anchor context
 * for the judge to score age-appropriateness and on-task-ness; no scholar PII
 * beyond `name` and `readingLevel` (already what the live tutor sees).
 */
export const transcript = internalQuery({
  args: { sessionId: v.id("sessions") },
  handler: async (ctx, { sessionId }) => {
    const session = await ctx.db.get(sessionId);
    if (!session) return null;

    const messages = await ctx.db
      .query("messages")
      .withIndex("by_session", (q) => q.eq("sessionId", sessionId))
      .order("asc")
      .collect();

    const scholar = await ctx.db.get(session.userId);
    const unit = session.unitId ? await ctx.db.get(session.unitId) : null;
    const lesson = session.lessonId ? await ctx.db.get(session.lessonId) : null;
    const activity = session.activityId
      ? ((await ctx.db.get(session.activityId)) as Doc<"activities"> | null)
      : null;

    return {
      session: {
        id: session._id,
        title: session.title ?? "Untitled",
        isTestDrive: session.isTestDrive ?? false,
        createdAt: session._creationTime,
      },
      scholar: {
        name: scholar?.name ?? null,
        readingLevel: scholar?.readingLevel ?? null,
      },
      anchor: unit || lesson || activity
        ? {
            unitTitle: unit?.title ?? null,
            lessonTitle: lesson?.title ?? null,
            activityTitle: activity?.title ?? null,
            activityKind: activity?.kind ?? null,
          }
        : null,
      messages: messages
        .filter((m) => m.role === "user" || m.role === "assistant")
        .map((m) => ({
          id: m._id,
          role: m.role,
          content: m.content,
          createdAt: m._creationTime,
        })),
    };
  },
});

/**
 * Harvest the human weak-labels we already collect — teacher 👍/👎 rehearsal
 * flags (`testDriveFlags`) and scholar "Rabbithole got this wrong" flags
 * (`messageFlags`) — into eval-ready rows. Internal query — invoke via:
 *
 *   CONVEX_DEPLOYMENT=<development-deployment> \
 *     npx convex run evalExport:flaggedTurns '{"since": 0}'
 *
 * Feeds evals/tutor-quality/harvest-flags.ts, which turns each 👎/wrong flag
 * into a tutor-quality fixture + a triage list (see
 * review/continuous-eval-plan.html §7 quick-win #2). Never run against prod
 * without approval per rabbithole-convex-deploys.md — the harness only needs
 * sample shapes, and harvested output stays out of git (it can contain a
 * minor's transcript text; a human curates/redacts before promotion).
 *
 * PII discipline: NO scholar display name is emitted anywhere — a scholar's
 * identity is the literal "Scholar". (The message CONTENT still contains
 * whatever the kid typed, which is exactly why harvested fixtures are
 * gitignored until a human redacts them.) Supports an optional `{ since }`
 * lower bound (ms epoch) on the flag's creation time.
 */
const MAX_CONTEXT_MESSAGES = 12;

export const flaggedTurns = internalQuery({
  args: { since: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const since = args.since ?? 0;

    // Ordered user/assistant transcript for a session, cached across flags that
    // share a session. The scholar is only ever the "user" role — no name.
    const transcriptCache = new Map<
      string,
      Array<{ id: Id<"messages">; role: "user" | "assistant"; content: string }>
    >();
    const anchorCache = new Map<
      string,
      { isTestDrive: boolean; unitTitle: string | null; activityTitle: string | null }
    >();

    async function transcriptFor(sessionId: Id<"sessions">) {
      const key = sessionId as unknown as string;
      const cached = transcriptCache.get(key);
      if (cached) return cached;
      const messages = await ctx.db
        .query("messages")
        .withIndex("by_session", (q) => q.eq("sessionId", sessionId))
        .order("asc")
        .collect();
      const convo = messages
        .filter((m) => m.role === "user" || m.role === "assistant")
        .map((m) => ({
          id: m._id,
          role: m.role as "user" | "assistant",
          content: m.content,
        }));
      transcriptCache.set(key, convo);
      return convo;
    }

    async function anchorFor(sessionId: Id<"sessions">) {
      const key = sessionId as unknown as string;
      const cached = anchorCache.get(key);
      if (cached) return cached;
      const session = await ctx.db.get(sessionId);
      const unit = session?.unitId ? await ctx.db.get(session.unitId) : null;
      const activity = session?.activityId
        ? ((await ctx.db.get(session.activityId)) as Doc<"activities"> | null)
        : null;
      const anchor = {
        isTestDrive: session?.isTestDrive ?? false,
        unitTitle: unit?.title ?? null,
        activityTitle: activity?.title ?? null,
      };
      anchorCache.set(key, anchor);
      return anchor;
    }

    // Locate the flagged message in its transcript and slice up to
    // MAX_CONTEXT_MESSAGES preceding turns. Falls back to the flagged message's
    // own row if it was filtered out (e.g. a tool/system message).
    async function assemble(
      sessionId: Id<"sessions">,
      messageId: Id<"messages">,
    ): Promise<{
      flaggedMessage: { role: string; content: string } | null;
      context: Array<{ role: string; content: string }>;
    }> {
      const convo = await transcriptFor(sessionId);
      const idx = convo.findIndex(
        (m) => (m.id as unknown as string) === (messageId as unknown as string),
      );
      if (idx === -1) {
        const raw = await ctx.db.get(messageId);
        return {
          flaggedMessage: raw ? { role: raw.role, content: raw.content } : null,
          context: [],
        };
      }
      const start = Math.max(0, idx - MAX_CONTEXT_MESSAGES);
      return {
        flaggedMessage: { role: convo[idx].role, content: convo[idx].content },
        context: convo
          .slice(start, idx)
          .map((m) => ({ role: m.role, content: m.content })),
      };
    }

    const out: Array<Record<string, unknown>> = [];

    const teacherFlags = await ctx.db.query("testDriveFlags").collect();
    for (const flag of teacherFlags) {
      if (flag._creationTime < since) continue;
      const { flaggedMessage, context } = await assemble(
        flag.sessionId,
        flag.messageId,
      );
      const anchor = await anchorFor(flag.sessionId);
      out.push({
        source: "testDriveFlag",
        flagId: flag._id,
        kind: flag.kind, // "good" (👍) | "bad" (👎)
        note: flag.note ?? null,
        flaggedMessage,
        context,
        sessionId: flag.sessionId,
        isTestDrive: anchor.isTestDrive,
        unitTitle: anchor.unitTitle,
        activityTitle: anchor.activityTitle,
        createdAt: flag._creationTime,
      });
    }

    const scholarFlags = await ctx.db.query("messageFlags").collect();
    for (const flag of scholarFlags) {
      if (flag._creationTime < since) continue;
      const { flaggedMessage, context } = await assemble(
        flag.sessionId,
        flag.messageId,
      );
      const anchor = await anchorFor(flag.sessionId);
      out.push({
        source: "messageFlag",
        flagId: flag._id,
        // Scholar "got this wrong" flags carry no 👍/👎 — they're always a
        // negative signal on the tutor's message.
        kind: "wrong",
        note: flag.reason ?? null,
        flaggedMessage,
        context,
        sessionId: flag.sessionId,
        isTestDrive: anchor.isTestDrive,
        unitTitle: anchor.unitTitle,
        activityTitle: anchor.activityTitle,
        createdAt: flag._creationTime,
      });
    }

    out.sort((a, b) => (a.createdAt as number) - (b.createdAt as number));
    return out;
  },
});
