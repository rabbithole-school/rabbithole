/**
 * Golden-set labeling — Convex functions behind the /teacher/labeling surface.
 *
 * Human raters (teachers, at a group meeting) score real tutor turns on the
 * SAME rubric the Opus quality-judge uses (single-sourced in
 * shared/tutorQualityRubric.ts). Comparing human scores against the judge's on
 * identical dimension definitions is how we calibrate the judge — see
 * review/continuous-eval-plan.html §7.
 *
 * Two invariants shape this file:
 *  1. BLIND labeling — while a rater labels, they must never see another
 *     rater's (or the judge's) scores. Every read here returns ONLY the calling
 *     rater's own labels; the sole exception is `agreementReport`, which is the
 *     deliberate "reveal everyone" surface used after labeling.
 *  2. NO scholar identity leaks — the queue + candidate lists show session
 *     title / unit / date only (never the scholar's name), and the transcript
 *     read strips everything but message role + content.
 *
 * All functions are teacherQuery/teacherMutation (requireTeacher): teachers +
 * school_admin + platform_admin pass; scholars, parents, operations staff and
 * curriculum_designers are rejected. (Verified against convex/lib/auth.ts →
 * requireTeacher / isTeacherRole.)
 *
 * WEB-ONLY: this is a staff tooling surface. The native app is scholar-facing,
 * so there is deliberately no React Native implementation.
 */
import { v } from "convex/values";
import { teacherQuery, teacherMutation } from "./lib/customFunctions";
import type { Doc, Id } from "./_generated/dataModel";
import type { QueryCtx } from "./_generated/server";
import {
  PER_TURN_DIMENSIONS,
  DIMENSION_BY_KEY,
  SCORE_MIN,
  SCORE_MAX,
} from "../shared/tutorQualityRubric";
import {
  computeAgreement,
  computeTranscriptAgreement,
  type TurnLabelInput,
} from "./lib/labelAgreement";

/** Preview length for transcript snippets in the agreement report. */
const PREVIEW_CHARS = 140;
/** How many recent sessions to scan when building the candidate list. */
const CANDIDATE_SCAN_WINDOW = 200;
/** A session needs at least this many messages to be a labeling candidate. */
const MIN_MESSAGES_FOR_CANDIDATE = 6;

/**
 * The scoreable tutor turns of a transcript: non-empty assistant messages, in
 * transcript order. One definition used everywhere so queue progress, the
 * labeler, and the agreement report all count turns identically.
 */
function tutorTurns(messages: Doc<"messages">[]): Doc<"messages">[] {
  return messages.filter(
    (m) => m.role === "assistant" && m.content.trim().length > 0,
  );
}

async function orderedMessages(ctx: QueryCtx, sessionId: Id<"sessions">) {
  return await ctx.db
    .query("messages")
    .withIndex("by_session", (q) => q.eq("sessionId", sessionId))
    .collect();
}

// ── Queue ─────────────────────────────────────────────────────────────

/**
 * The labeling queue: each curated session joined with its title/unit and THIS
 * rater's progress (how many tutor turns they've scored / how many exist).
 */
export const listQueue = teacherQuery({
  args: {},
  handler: async (ctx) => {
    const entries = await ctx.db
      .query("qualityLabelQueue")
      .withIndex("by_order")
      .collect();
    entries.sort((a, b) => a.order - b.order);

    const raterId = ctx.user._id;
    const rows = [];
    for (const entry of entries) {
      const session = await ctx.db.get(entry.sessionId);
      if (!session) continue; // orphaned queue row (session deleted)
      const unit = session.unitId ? await ctx.db.get(session.unitId) : null;

      const messages = await orderedMessages(ctx, entry.sessionId);
      const turns = tutorTurns(messages);
      const tutorIds = new Set(turns.map((m) => String(m._id)));

      const myLabels = await ctx.db
        .query("qualityGoldLabels")
        .withIndex("by_rater_and_session", (q) =>
          q.eq("raterId", raterId).eq("sessionId", entry.sessionId),
        )
        .collect();
      // Only count labels that still map to a current tutor turn.
      const labeledTurns = new Set(
        myLabels
          .map((l) => String(l.messageId))
          .filter((id) => tutorIds.has(id)),
      ).size;

      const myTranscript = await ctx.db
        .query("qualityGoldTranscriptLabels")
        .withIndex("by_rater_and_session", (q) =>
          q.eq("raterId", raterId).eq("sessionId", entry.sessionId),
        )
        .first();

      rows.push({
        queueId: entry._id,
        sessionId: entry.sessionId,
        order: entry.order,
        note: entry.note ?? null,
        title: session.title,
        unitTitle: unit?.title ?? null,
        unitEmoji: unit?.emoji ?? null,
        totalTurns: turns.length,
        labeledTurns,
        overallScored: myTranscript?.overall != null,
      });
    }
    return rows;
  },
});

/**
 * Recent labeling candidates: non-test-drive, non-offline sessions with enough
 * conversation to score, newest first. Title + unit + counts + date only — NO
 * scholar name — so Andy can build the queue quickly without exposing identity.
 */
export const addRecentCandidates = teacherQuery({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const limit = Math.min(args.limit ?? 40, 100);

    const queued = await ctx.db.query("qualityLabelQueue").collect();
    const queuedSet = new Set(queued.map((q) => String(q.sessionId)));

    const recent = await ctx.db
      .query("sessions")
      .order("desc")
      .take(CANDIDATE_SCAN_WINDOW);

    const candidates = [];
    for (const session of recent) {
      if (session.isTestDrive || session.isOffline) continue;
      const messages = await orderedMessages(ctx, session._id);
      if (messages.length < MIN_MESSAGES_FOR_CANDIDATE) continue;
      const turns = tutorTurns(messages);
      if (turns.length === 0) continue;
      const unit = session.unitId ? await ctx.db.get(session.unitId) : null;

      candidates.push({
        sessionId: session._id,
        title: session.title,
        unitTitle: unit?.title ?? null,
        unitEmoji: unit?.emoji ?? null,
        messageCount: messages.length,
        tutorTurns: turns.length,
        lastActivityAt: session.lastMessageAt ?? session._creationTime,
        alreadyQueued: queuedSet.has(String(session._id)),
      });
      if (candidates.length >= limit) break;
    }
    return candidates;
  },
});

/** Add a session to the labeling queue (idempotent — skips if already queued). */
export const addToQueue = teacherMutation({
  args: { sessionId: v.id("sessions"), note: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const session = await ctx.db.get(args.sessionId);
    if (!session) throw new Error("Session not found");

    const existing = await ctx.db
      .query("qualityLabelQueue")
      .withIndex("by_session", (q) => q.eq("sessionId", args.sessionId))
      .first();
    if (existing) return existing._id;

    const all = await ctx.db
      .query("qualityLabelQueue")
      .withIndex("by_order")
      .collect();
    const maxOrder = all.reduce((m, e) => Math.max(m, e.order), -1);

    return await ctx.db.insert("qualityLabelQueue", {
      sessionId: args.sessionId,
      addedById: ctx.user._id,
      order: maxOrder + 1,
      note: args.note,
    });
  },
});

/** Remove a session from the queue (labels are left intact). */
export const removeFromQueue = teacherMutation({
  args: { queueId: v.id("qualityLabelQueue") },
  handler: async (ctx, args) => {
    const entry = await ctx.db.get(args.queueId);
    if (!entry) return; // already gone
    await ctx.db.delete(args.queueId);
  },
});

// ── Labeling (blind) ────────────────────────────────────────────────────

/**
 * The transcript to label + THIS rater's existing labels for it. Blind: never
 * returns other raters' labels. Messages are stripped to role + content (no
 * dossier/whisper/model metadata reaches the labeler).
 */
export const getLabelingSession = teacherQuery({
  args: { sessionId: v.id("sessions") },
  handler: async (ctx, args) => {
    const session = await ctx.db.get(args.sessionId);
    if (!session) throw new Error("Session not found");
    const unit = session.unitId ? await ctx.db.get(session.unitId) : null;

    const raw = await orderedMessages(ctx, args.sessionId);
    const messages = raw
      .filter(
        (m) =>
          (m.role === "user" || m.role === "assistant") &&
          m.content.trim().length > 0,
      )
      .map((m) => ({ id: m._id, role: m.role, content: m.content }));
    const tutorTurnCount = tutorTurns(raw).length;

    const raterId = ctx.user._id;
    const myTurnLabels = await ctx.db
      .query("qualityGoldLabels")
      .withIndex("by_rater_and_session", (q) =>
        q.eq("raterId", raterId).eq("sessionId", args.sessionId),
      )
      .collect();
    const turnLabels: Record<
      string,
      { dims: Record<string, number>; note: string | null; cantJudge: string[] }
    > = {};
    for (const l of myTurnLabels) {
      turnLabels[String(l.messageId)] = {
        dims: l.dims,
        note: l.note ?? null,
        cantJudge: l.cantJudge ?? [],
      };
    }

    const myTranscript = await ctx.db
      .query("qualityGoldTranscriptLabels")
      .withIndex("by_rater_and_session", (q) =>
        q.eq("raterId", raterId).eq("sessionId", args.sessionId),
      )
      .first();

    return {
      sessionId: args.sessionId,
      title: session.title,
      unitTitle: unit?.title ?? null,
      unitEmoji: unit?.emoji ?? null,
      messages,
      tutorTurnCount,
      myTurnLabels: turnLabels,
      myTranscriptLabel: myTranscript
        ? { overall: myTranscript.overall ?? null, note: myTranscript.note ?? null }
        : null,
    };
  },
});

function validateDims(dims: Record<string, number>) {
  for (const [key, value] of Object.entries(dims)) {
    if (!DIMENSION_BY_KEY[key]) throw new Error(`Unknown dimension: ${key}`);
    if (!Number.isInteger(value) || value < SCORE_MIN || value > SCORE_MAX) {
      throw new Error(
        `Score for ${key} must be an integer ${SCORE_MIN}–${SCORE_MAX}`,
      );
    }
  }
}

/** Upsert THIS rater's score for one tutor turn. Keyed (rater, message). */
export const saveTurnLabel = teacherMutation({
  args: {
    sessionId: v.id("sessions"),
    messageId: v.id("messages"),
    // dimKey -> 1..5. Only dims the rater scored are included.
    dims: v.record(v.string(), v.number()),
    note: v.optional(v.string()),
    cantJudge: v.optional(v.array(v.string())),
  },
  handler: async (ctx, args) => {
    const message = await ctx.db.get(args.messageId);
    if (!message) throw new Error("Message not found");
    if (String(message.sessionId) !== String(args.sessionId)) {
      throw new Error("Message does not belong to the session");
    }
    if (message.role !== "assistant") {
      throw new Error("Only tutor (assistant) turns can be labeled");
    }
    validateDims(args.dims);
    if (args.cantJudge) {
      for (const key of args.cantJudge) {
        if (!DIMENSION_BY_KEY[key]) {
          throw new Error(`Unknown dimension in cantJudge: ${key}`);
        }
      }
    }

    const raterId = ctx.user._id;
    const existing = await ctx.db
      .query("qualityGoldLabels")
      .withIndex("by_rater_and_message", (q) =>
        q.eq("raterId", raterId).eq("messageId", args.messageId),
      )
      .first();

    const fields = {
      dims: args.dims,
      note: args.note,
      cantJudge: args.cantJudge,
    };
    if (existing) {
      await ctx.db.patch(existing._id, fields);
      return existing._id;
    }
    return await ctx.db.insert("qualityGoldLabels", {
      raterId,
      sessionId: args.sessionId,
      messageId: args.messageId,
      ...fields,
    });
  },
});

/** Upsert THIS rater's whole-transcript verdict. Keyed (rater, session). */
export const saveTranscriptLabel = teacherMutation({
  args: {
    sessionId: v.id("sessions"),
    overall: v.optional(v.number()),
    note: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    if (args.overall !== undefined) {
      if (
        !Number.isInteger(args.overall) ||
        args.overall < SCORE_MIN ||
        args.overall > SCORE_MAX
      ) {
        throw new Error(`overall must be an integer ${SCORE_MIN}–${SCORE_MAX}`);
      }
    }
    const session = await ctx.db.get(args.sessionId);
    if (!session) throw new Error("Session not found");

    const raterId = ctx.user._id;
    const existing = await ctx.db
      .query("qualityGoldTranscriptLabels")
      .withIndex("by_rater_and_session", (q) =>
        q.eq("raterId", raterId).eq("sessionId", args.sessionId),
      )
      .first();

    const fields = { overall: args.overall, note: args.note };
    if (existing) {
      await ctx.db.patch(existing._id, fields);
      return existing._id;
    }
    return await ctx.db.insert("qualityGoldTranscriptLabels", {
      raterId,
      sessionId: args.sessionId,
      ...fields,
    });
  },
});

// ── Agreement (the only reveal-everyone surface) ─────────────────────────

/**
 * The calibration view: every rater's scores for a session (or across all
 * labeled sessions when `sessionId` is omitted), as a per-dim × per-turn matrix
 * with means, max pairwise disagreement, and rows flagged where the spread ≥ 2.
 * Also emits `exportJson` — the shape the calibration script consumes later
 * (raterId → username mapping included). All arithmetic is delegated to the
 * pure helper in convex/lib/labelAgreement.ts (kept a query, no page-side math).
 */
export const agreementReport = teacherQuery({
  args: { sessionId: v.optional(v.id("sessions")) },
  handler: async (ctx, args) => {
    let sessionIds: Id<"sessions">[];
    if (args.sessionId) {
      sessionIds = [args.sessionId];
    } else {
      // Every session that carries any label (turn or transcript), deduped.
      const allTurn = await ctx.db.query("qualityGoldLabels").collect();
      const allTrans = await ctx.db
        .query("qualityGoldTranscriptLabels")
        .collect();
      const seen = new Set<string>();
      sessionIds = [];
      for (const l of [...allTurn, ...allTrans]) {
        const key = String(l.sessionId);
        if (!seen.has(key)) {
          seen.add(key);
          sessionIds.push(l.sessionId);
        }
      }
    }

    const raterNames: Record<string, string> = {};
    const resolveRater = async (id: Id<"users">) => {
      const key = String(id);
      if (raterNames[key]) return;
      const u = await ctx.db.get(id);
      raterNames[key] = u?.username ?? u?.name ?? key;
    };

    const dimKeys = PER_TURN_DIMENSIONS.map((d) => d.key);
    const sessions = [];
    const exportSessions = [];

    for (const sid of sessionIds) {
      const session = await ctx.db.get(sid);
      if (!session) continue;

      const turnRows = await ctx.db
        .query("qualityGoldLabels")
        .withIndex("by_session", (q) => q.eq("sessionId", sid))
        .collect();
      const transRows = await ctx.db
        .query("qualityGoldTranscriptLabels")
        .withIndex("by_session", (q) => q.eq("sessionId", sid))
        .collect();

      const rawMsgs = await orderedMessages(ctx, sid);
      const tutorMsgs = tutorTurns(rawMsgs);
      const messageOrder = tutorMsgs.map((m) => String(m._id));

      const labels: TurnLabelInput[] = turnRows.map((r) => ({
        raterId: String(r.raterId),
        messageId: String(r.messageId),
        dims: r.dims,
      }));
      const matrix = computeAgreement(labels, dimKeys, messageOrder);
      const transcript = computeTranscriptAgreement(
        transRows.map((r) => ({
          raterId: String(r.raterId),
          overall: r.overall ?? null,
        })),
      );

      for (const r of turnRows) await resolveRater(r.raterId);
      for (const r of transRows) await resolveRater(r.raterId);

      sessions.push({
        sessionId: sid,
        title: session.title,
        matrix,
        transcript,
        tutorTurns: tutorMsgs.map((m, i) => ({
          messageId: String(m._id),
          turnIndex: i,
          preview: m.content.slice(0, PREVIEW_CHARS),
        })),
      });

      exportSessions.push({
        sessionId: String(sid),
        title: session.title,
        turnLabels: turnRows.map((r) => ({
          raterId: String(r.raterId),
          messageId: String(r.messageId),
          turnIndex: messageOrder.indexOf(String(r.messageId)),
          dims: r.dims,
          cantJudge: r.cantJudge ?? [],
          note: r.note ?? null,
        })),
        transcriptLabels: transRows.map((r) => ({
          raterId: String(r.raterId),
          overall: r.overall ?? null,
          note: r.note ?? null,
        })),
      });
    }

    return {
      sessions,
      raters: raterNames,
      dimensions: PER_TURN_DIMENSIONS.map((d) => ({
        key: d.key,
        label: d.label,
      })),
      exportJson: {
        generatedAt: Date.now(),
        raters: raterNames,
        dimensions: PER_TURN_DIMENSIONS.map((d) => ({
          key: d.key,
          label: d.label,
        })),
        sessions: exportSessions,
      },
    };
  },
});
