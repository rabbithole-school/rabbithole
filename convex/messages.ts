import { v } from "convex/values";
import { internalMutation } from "./_generated/server";
import type { QueryCtx } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import { authedQuery, teacherQuery } from "./lib/customFunctions";
import {
  canReadScholarAsTeacher,
  requireActiveScholarAccess,
} from "./lib/access";
import { isTeacherRole, ROLES } from "./lib/roles";
import { readabilityStats } from "../lib/readability";
import { buildScholarReadingTrend, isSyntheticStartMessage } from "../lib/readingTrend";
import { vocabularyWins } from "../lib/vocabulary";
import {
  buildPortfolioWritingSamples,
  type PortfolioProseCandidate,
  type PortfolioWritingSample,
} from "../lib/portfolioWriting";

const RECENT_TUTOR_READABILITY_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
const DEFAULT_TUTOR_READABILITY_LIMIT = 20;
const MAX_TUTOR_READABILITY_LIMIT = 50;
const MAX_TUTOR_READABILITY_SESSIONS = 25;
const MAX_TUTOR_MESSAGES_PER_SESSION = 100;
const MIN_TUTOR_RESPONSE_WORDS = 5;
const SCHOLAR_READING_TREND_WINDOW_DAYS = 90;
const SCHOLAR_READING_TREND_BUCKET_DAYS = 7;
const SCHOLAR_READING_TREND_WINDOW_MS = SCHOLAR_READING_TREND_WINDOW_DAYS * 24 * 60 * 60 * 1000;
const MAX_SCHOLAR_READING_TREND_SESSIONS = MAX_TUTOR_READABILITY_SESSIONS;
const MAX_SCHOLAR_MESSAGES_PER_SESSION = MAX_TUTOR_MESSAGES_PER_SESSION;
const MIN_SCHOLAR_MESSAGE_WORDS = 3;
const VOCABULARY_WIN_LIMIT = 8;

// ─── Portfolio writing samples (scanned work → writing level) ───────────
// A scholar's scanned portfolio prose (portfolioItems.extractedText) is a
// better sample of composed writing than short tutor-chat messages. Both the
// AI grade estimate (readingLevelAnalysis) and the writing-over-time portrait
// read it through this one helper so the prose gate stays in a single place.
const PORTFOLIO_ITEMS_SCAN_CAP = 200; // most-recent items to consider
const PORTFOLIO_TREND_SAMPLE_LIMIT = 8; // portrait samples (kin to vocab wins)
const PORTFOLIO_ANALYSIS_WINDOW_DAYS = 30; // matches getScholarUserMessages30d
const PORTFOLIO_ANALYSIS_SAMPLE_LIMIT = 30; // pieces fed to the AI estimate

/**
 * A scholar's recent scanned-work prose, gated to attributed items (matched or
 * confirmed) whose extracted text clears the prose floor. Shared by the AI
 * grade estimate and the reading-trend portrait; callers strip `text` when a
 * client only needs the scored sample.
 */
async function readScholarPortfolioSamples(
  ctx: QueryCtx,
  scholarId: Id<"users">,
  opts: { now: number; windowDays: number; limit: number },
): Promise<PortfolioWritingSample[]> {
  const items = await ctx.db
    .query("portfolioItems")
    .withIndex("by_scholar", (q) => q.eq("scholarId", scholarId))
    .order("desc")
    .take(PORTFOLIO_ITEMS_SCAN_CAP);

  const candidates: PortfolioProseCandidate[] = [];
  for (const item of items) {
    // Only attributed scans — an unmatched/ambiguous item has no reliable
    // author, so its writing must never move a specific scholar's level.
    if (item.matchStatus !== "matched" && item.matchStatus !== "confirmed") continue;
    const text = item.extractedText?.trim();
    if (!text) continue;
    candidates.push({
      id: item._id,
      text,
      caption: item.aiCaption ?? null,
      createdAt: item._creationTime,
    });
  }

  return buildPortfolioWritingSamples(candidates, opts);
}

function roundOneDecimal(value: number): number {
  return Math.round((value + Number.EPSILON) * 10) / 10;
}

/**
 * List messages for a project (used by reactive subscribers).
 */
export const listBySession = authedQuery({
  args: { sessionId: v.id("sessions") },
  handler: async (ctx, args) => {
    const session = await ctx.db.get(args.sessionId);
    if (!session) return [];

    // Access check
    const isTeacher =
      isTeacherRole(ctx.user.role);
    if (!isTeacher && session.userId !== ctx.user._id) {
      return [];
    }
    if (isTeacher && session.userId !== ctx.user._id) {
      await requireActiveScholarAccess(ctx, ctx.user, session.userId);
    }

    const messages = await ctx.db
      .query("messages")
      .withIndex("by_session", (q) =>
        q.eq("sessionId", args.sessionId)
      )
      .order("asc")
      .collect();

    return messages.map((m) => ({
      ...m,
      id: m._id,
      createdAt: m._creationTime,
    }));
  },
});

/**
 * Insert a user message (internal, called from chat mutation).
 */
export const insertUserMessage = internalMutation({
  args: {
    sessionId: v.id("sessions"),
    content: v.string(),
    personaId: v.optional(v.string()),
    unitId: v.optional(v.string()),
    perspectiveId: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    return await ctx.db.insert("messages", {
      sessionId: args.sessionId,
      role: "user",
      content: args.content,
      personaId: args.personaId,
      unitId: args.unitId,
      perspectiveId: args.perspectiveId,
      flagged: false,
    });
  },
});

/**
 * Insert an assistant message placeholder (internal, called from chat action).
 */
export const insertAssistantPlaceholder = internalMutation({
  args: {
    sessionId: v.id("sessions"),
    streamId: v.string(),
    personaId: v.optional(v.string()),
    unitId: v.optional(v.string()),
    perspectiveId: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    return await ctx.db.insert("messages", {
      sessionId: args.sessionId,
      role: "assistant",
      content: "",
      streamId: args.streamId,
      personaId: args.personaId,
      unitId: args.unitId,
      perspectiveId: args.perspectiveId,
      flagged: false,
    });
  },
});

/**
 * Finalize an assistant message after streaming completes.
 */
export const finalizeAssistantMessage = internalMutation({
  args: {
    messageId: v.id("messages"),
    content: v.string(),
    model: v.optional(v.string()),
    tokensUsed: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.messageId, {
      content: args.content,
      model: args.model,
      tokensUsed: args.tokensUsed,
      streamId: undefined, // Clear stream ID to mark as done
    });
  },
});

/**
 * Insert a whisper record into the message history.
 * Stored as role:"tool" with toolAction:"whisper" so it's visible
 * to teachers in remote mode but filterable for scholars.
 */
export const insertWhisper = internalMutation({
  args: {
    sessionId: v.id("sessions"),
    content: v.string(),
  },
  handler: async (ctx, args) => {
    await ctx.db.insert("messages", {
      sessionId: args.sessionId,
      role: "tool",
      content: args.content,
      toolAction: "whisper",
      flagged: false,
    });
  },
});

/**
 * Recent messages across all of a scholar's projects (for Activity tab).
 * Returns last 10 user/assistant messages with project context.
 */
export const getRecentByScholar = authedQuery({
  args: { scholarId: v.id("users") },
  handler: async (ctx, args) => {
    const isTeacher = isTeacherRole(ctx.user.role);
    if (!isTeacher && ctx.user._id !== args.scholarId) return [];
    if (isTeacher) await requireActiveScholarAccess(ctx, ctx.user, args.scholarId);

    const sessions = await ctx.db
      .query("sessions")
      .withIndex("by_user", (q) => q.eq("userId", args.scholarId))
      .collect();

    // Gather recent messages from each project, then sort globally
    const allMessages: {
      _id: string;
      role: string;
      content: string;
      sessionId: string;
      sessionTitle: string;
      unitTitle: string | null;
      _creationTime: number;
    }[] = [];

    for (const session of sessions) {
      let unitTitle: string | null = null;
      if (session.unitId) {
        const unit = await ctx.db.get(session.unitId);
        unitTitle = unit?.title ?? null;
      }

      const msgs = await ctx.db
        .query("messages")
        .withIndex("by_session", (q) => q.eq("sessionId", session._id))
        .order("desc")
        .take(10);

      for (const m of msgs) {
        if (m.role === "user" || m.role === "assistant") {
          allMessages.push({
            _id: m._id,
            role: m.role,
            content: m.content,
            sessionId: session._id,
            sessionTitle: session.title,
            unitTitle,
            _creationTime: m._creationTime,
          });
        }
      }
    }

    // Sort by creation time descending, take 10
    allMessages.sort((a, b) => b._creationTime - a._creationTime);
    return allMessages.slice(0, 10);
  },
});

/**
 * All user-role message texts for a scholar from the last 30 days.
 * Used by the AI reading-level analysis action.
 */
export const getScholarUserMessages30d = teacherQuery({
  args: { scholarId: v.id("users") },
  handler: async (ctx, args) => {
    if (!(await canReadScholarAsTeacher(ctx, ctx.user, args.scholarId))) {
      return [];
    }
    const since = Date.now() - 30 * 24 * 60 * 60 * 1000;
    const sessions = await ctx.db
      .query("sessions")
      .withIndex("by_user", (q) => q.eq("userId", args.scholarId))
      .collect();

    const texts: string[] = [];
    for (const session of sessions) {
      const msgs = await ctx.db
        .query("messages")
        .withIndex("by_session", (q) => q.eq("sessionId", session._id))
        .filter((q) =>
          q.and(
            q.eq(q.field("role"), "user"),
            q.gte(q.field("_creationTime"), since)
          )
        )
        .collect();
      for (const m of msgs) {
        if (typeof m.content === "string") texts.push(m.content);
      }
    }
    return texts;
  },
});

/**
 * A scholar's recent scanned-work PROSE (portfolio extractedText), gated to
 * attributed items clearing the prose floor. Companion to
 * getScholarUserMessages30d — the AI reading-level estimate reads both so the
 * grade reflects the scholar's composed writing, not just tutor chat. Returns
 * the raw texts; institution-scoped like getScholarReadingTrend (empty on a
 * denied cross-institution read rather than throwing).
 */
export const getScholarPortfolioProse30d = teacherQuery({
  args: { scholarId: v.id("users") },
  handler: async (ctx, args): Promise<string[]> => {
    if (!(await canReadScholarAsTeacher(ctx, ctx.user, args.scholarId))) {
      return [];
    }
    const samples = await readScholarPortfolioSamples(ctx, args.scholarId, {
      now: Date.now(),
      windowDays: PORTFOLIO_ANALYSIS_WINDOW_DAYS,
      limit: PORTFOLIO_ANALYSIS_SAMPLE_LIMIT,
    });
    return samples.map((s) => s.text);
  },
});

/**
 * Mean readability of a scholar's recent tutor responses.
 * Teacher-facing, read-only signal for checking whether the tutor's output is
 * landing near the configured scholar reading level.
 */
export const getRecentTutorReadabilityByScholar = teacherQuery({
  args: {
    scholarId: v.id("users"),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const scholar = await ctx.db.get(args.scholarId);
    if (!scholar || scholar.role !== ROLES.SCHOLAR) {
      throw new Error("Scholar not found");
    }

    // The teacher-facing empty shape — also the graceful fallback for an
    // access-denied read (see below).
    const emptyResult = (availableResponseCount = 0) => ({
      meanGradeLevel: null,
      meanReadingEase: null,
      sampledResponseCount: 0,
      availableResponseCount,
      wordCount: 0,
      windowDays: 30,
      minWordsPerResponse: MIN_TUTOR_RESPONSE_WORDS,
      latestAt: null,
    });

    // Institution scope — match the rest of the app. Degrade to the empty
    // shape rather than throwing, so a denied / not-yet-backfilled read never
    // takes out the whole Guidance tab via the route error boundary.
    if (!(await canReadScholarAsTeacher(ctx, ctx.user, args.scholarId))) {
      return emptyResult();
    }

    const since = Date.now() - RECENT_TUTOR_READABILITY_WINDOW_MS;
    const limit = Math.min(
      MAX_TUTOR_READABILITY_LIMIT,
      Math.max(1, Math.trunc(args.limit ?? DEFAULT_TUTOR_READABILITY_LIMIT)),
    );
    const perSessionMessageLimit = Math.min(
      MAX_TUTOR_MESSAGES_PER_SESSION,
      Math.max(20, limit * 4),
    );

    const sessions = await ctx.db
      .query("sessions")
      .withIndex("by_user_last_message", (q) =>
        q.eq("userId", args.scholarId).gte("lastMessageAt", since)
      )
      .order("desc")
      .take(MAX_TUTOR_READABILITY_SESSIONS);

    const tutorMessages: {
      content: string;
      _creationTime: number;
    }[] = [];

    for (const session of sessions) {
      const messages = await ctx.db
        .query("messages")
        .withIndex("by_session", (q) => q.eq("sessionId", session._id))
        .order("desc")
        .take(perSessionMessageLimit);

      for (const message of messages) {
        if (message.role !== "assistant" || message._creationTime < since) continue;
        if (message.streamId || !message.content.trim()) continue;
        tutorMessages.push({
          content: message.content,
          _creationTime: message._creationTime,
        });
      }
    }

    const recentMessages = tutorMessages
      .sort((a, b) => b._creationTime - a._creationTime)
      .slice(0, limit);

    const scoredMessages = recentMessages
      .map((message) => ({
        ...message,
        stats: readabilityStats(message.content),
      }))
      .filter((message) => message.stats.wordCount >= MIN_TUTOR_RESPONSE_WORDS);

    if (scoredMessages.length === 0) {
      return emptyResult(recentMessages.length);
    }

    const gradeTotal = scoredMessages.reduce(
      (total, message) => total + message.stats.fleschKincaidGrade,
      0,
    );
    const easeTotal = scoredMessages.reduce(
      (total, message) => total + message.stats.fleschReadingEase,
      0,
    );
    const wordCount = scoredMessages.reduce(
      (total, message) => total + message.stats.wordCount,
      0,
    );

    return {
      meanGradeLevel: roundOneDecimal(gradeTotal / scoredMessages.length),
      meanReadingEase: roundOneDecimal(easeTotal / scoredMessages.length),
      sampledResponseCount: scoredMessages.length,
      availableResponseCount: recentMessages.length,
      wordCount,
      windowDays: 30,
      minWordsPerResponse: MIN_TUTOR_RESPONSE_WORDS,
      latestAt: scoredMessages[0]?._creationTime ?? null,
    };
  },
});

/**
 * Scholar-authored reading-level trend and vocabulary wins.
 * Teacher-facing portrait signal: how the scholar's own writing is stretching
 * over time, not a comparison against peers.
 */
export const getScholarReadingTrend = teacherQuery({
  args: {
    scholarId: v.id("users"),
  },
  handler: async (ctx, args) => {
    const emptyResult = () => ({
      trend: [],
      vocabularyWins: [],
      portfolioSamples: [],
      sampledMessageCount: 0,
      availableMessageCount: 0,
      wordCount: 0,
      windowDays: SCHOLAR_READING_TREND_WINDOW_DAYS,
      bucketDays: SCHOLAR_READING_TREND_BUCKET_DAYS,
      minWordsPerMessage: MIN_SCHOLAR_MESSAGE_WORDS,
      latestAt: null,
    });

    const scholar = await ctx.db.get(args.scholarId);
    if (!scholar || scholar.role !== ROLES.SCHOLAR) {
      return emptyResult();
    }

    // Institution scope — match getRecentTutorReadabilityByScholar exactly:
    // only enforce while the rollout flag is on, and return the safe empty
    // shape instead of throwing so the teacher profile keeps rendering.
    if (!(await canReadScholarAsTeacher(ctx, ctx.user, args.scholarId))) {
      return emptyResult();
    }

    const now = Date.now();
    const since = now - SCHOLAR_READING_TREND_WINDOW_MS;
    const sessions = await ctx.db
      .query("sessions")
      .withIndex("by_user_last_message", (q) =>
        q.eq("userId", args.scholarId).gte("lastMessageAt", since)
      )
      .order("desc")
      .take(MAX_SCHOLAR_READING_TREND_SESSIONS);

    const scholarMessages: {
      content: string;
      createdAt: number;
    }[] = [];

    for (const session of sessions) {
      const messages = await ctx.db
        .query("messages")
        .withIndex("by_session", (q) => q.eq("sessionId", session._id))
        .order("desc")
        .take(MAX_SCHOLAR_MESSAGES_PER_SESSION);

      for (const message of messages) {
        if (message.role !== "user" || message._creationTime < since) continue;
        if (!message.content.trim() || isSyntheticStartMessage(message.content)) continue;
        scholarMessages.push({
          content: message.content,
          createdAt: message._creationTime,
        });
      }
    }

    const trend = buildScholarReadingTrend(scholarMessages, {
      now,
      windowDays: SCHOLAR_READING_TREND_WINDOW_DAYS,
      bucketDays: SCHOLAR_READING_TREND_BUCKET_DAYS,
      minWordsPerMessage: MIN_SCHOLAR_MESSAGE_WORDS,
    });

    // Portfolio writing samples — the scholar's scanned composed work, scored
    // as a DISTINCT source (never blended into the chat buckets above). Drop the
    // full OCR blob (payload minimization) but keep the bounded ~140-char
    // `snippet` for teacher-facing provenance, mirroring Vocabulary wins' chat
    // snippet. Safe: this query is teacher-gated + institution-scoped, and the
    // teacher already has full access to these scans in the Portfolio tab.
    const portfolioSamples = (
      await readScholarPortfolioSamples(ctx, args.scholarId, {
        now,
        windowDays: SCHOLAR_READING_TREND_WINDOW_DAYS,
        limit: PORTFOLIO_TREND_SAMPLE_LIMIT,
      })
    ).map(({ text: _text, ...rest }) => rest);

    return {
      trend: trend.buckets,
      vocabularyWins: vocabularyWins(scholarMessages, {
        now,
        windowDays: SCHOLAR_READING_TREND_WINDOW_DAYS,
        limit: VOCABULARY_WIN_LIMIT,
      }),
      portfolioSamples,
      sampledMessageCount: trend.sampledMessageCount,
      availableMessageCount: trend.availableMessageCount,
      wordCount: trend.wordCount,
      windowDays: trend.windowDays,
      bucketDays: trend.bucketDays,
      minWordsPerMessage: trend.minWordsPerMessage,
      latestAt: trend.latestAt,
    };
  },
});

/**
 * Update streaming message content (called periodically during stream).
 */
export const updateStreamContent = internalMutation({
  args: {
    messageId: v.id("messages"),
    content: v.string(),
  },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.messageId, {
      content: args.content,
    });
  },
});
