import { v } from "convex/values";
import { internalQuery, internalMutation } from "./_generated/server";
import type { QueryCtx } from "./_generated/server";
import { Id } from "./_generated/dataModel";
import { curriculumQuery, curriculumMutation, staffQuery, staffMutation } from "./lib/customFunctions";
import {
  ROLES,
  isNonTeachingOperationsRole,
  isPlatformAdminRole,
  isTeacherRole,
  type Role,
} from "./lib/roles";
import { schoolOperationsInstitutionIds } from "./lib/staffCapabilities";
import { requireActiveScholarAccess } from "./lib/access";
import {
  readScholarRoster,
  readScholarGroups,
  readScholarMastery,
  readScholarSignals,
  readScholarSeeds,
  readScholarObservations,
  readScholarDossier,
  readScholarSessions,
  readSessionTranscript,
  readScholarWebActivity,
  readScholarPractice,
  readScholarMathCheckIn,
  readScholarChronology,
} from "./lib/scholarReads";
import {
  resolveInstitutionLens,
  scholarIdsInLens,
} from "./lib/institutionLens";
import { toKeyedGranules } from "./lib/granules";
import { activityHasScholarWork, deleteActivityCascade } from "./lib/activityCascade";
import { presentationState } from "./lib/activityPresentationResources";

// Validator for a Google Drive doc LINKED via the composer's Drive picker
// (reference-only; the file stays in the teacher's Drive). Shared by both send
// mutations. Shape mirrors the curriculumMessages.driveAttachments schema.
const driveAttachmentValidator = v.array(
  v.object({
    driveFileId: v.string(),
    url: v.string(),
    name: v.string(),
    mimeType: v.string(),
    thumbnailUrl: v.optional(v.string()),
  }),
);

// ── Shared scholar-context loader ───────────────────────────────────
// The redacted, prompt-ready snapshot of a scholar we pre-load so the aide
// doesn't have to tool-call to remember who it's talking about. Used in
// three places: getContext (legacy scholarId arg), getContextForChat
// (session-bound scholar), and getScholarFocusContext (the ephemeral
// "currently viewing" focus from the docked chat). Callers are responsible
// for the ACL gate (operations staff never get this) before calling.
export type ScholarPromptContext = {
  scholarId: Id<"users">;
  scholarName: string;
  readingLevel: string | null;
  dateOfBirth: string | null;
  currentAge: number | null;
  currentAgeAsOf: string;
  dossier: string;
  directives: { label: string; content: string }[];
  seeds: {
    topic: string;
    domain: string | null;
    rationale: string;
    approachHint: string | null;
  }[];
  recentObservations: { note: string; type: string; createdAt: number }[];
};

async function loadScholarPromptContext(
  ctx: QueryCtx,
  scholarId: Id<"users">,
): Promise<ScholarPromptContext | null> {
  const scholar = await ctx.db.get(scholarId);
  if (!scholar) return null;

  const dossier = await ctx.db
    .query("scholarDossiers")
    .withIndex("by_scholar", (q) => q.eq("scholarId", scholarId))
    .first();

  const directives = await ctx.db
    .query("teacherDirectives")
    .withIndex("by_scholar_active", (q) =>
      q.eq("scholarId", scholarId).eq("isActive", true),
    )
    .collect();
  directives.sort((a, b) => a._creationTime - b._creationTime);

  const allSeeds = await ctx.db
    .query("seeds")
    .withIndex("by_scholar_status", (q) => q.eq("scholarId", scholarId))
    .collect();
  const seeds = allSeeds
    .filter((s) => s.status === "active" || s.status === "pending")
    .map((s) => ({
      topic: s.topic,
      domain: s.domain ?? null,
      rationale: s.rationale,
      approachHint: s.approachHint ?? null,
    }));

  const observations = await ctx.db
    .query("observations")
    .withIndex("by_scholar", (q) => q.eq("scholarId", scholarId))
    .order("desc")
    .take(20);
  const chronology = await readScholarChronology(ctx, scholar);

  return {
    scholarId,
    scholarName: scholar.name ?? "this scholar",
    readingLevel: scholar.readingLevel ?? null,
    ...chronology,
    dossier: dossier?.content ?? "No dossier data available yet.",
    directives: directives.map((d) => ({ label: d.label, content: d.content })),
    seeds,
    recentObservations: observations.map((o) => ({
      note: o.note,
      type: o.type,
      createdAt: o._creationTime,
    })),
  };
}

// ── Public (teacher-authed) ─────────────────────────────────────────

export const getMessages = curriculumQuery({
  args: {},
  handler: async (ctx) => {
    // Global (unscoped) thread: only rows without a scholarId.
    const messages = await ctx.db
      .query("curriculumMessages")
      .withIndex("by_teacher", (q) => q.eq("teacherId", ctx.user._id))
      .order("asc")
      .take(200);
    return messages.filter((m) => m.scholarId === undefined && m.unitId === undefined);
  },
});

/**
 * Messages for a scholar-scoped thread. Teacher/admin/curriculum_designer only.
 *
 * `threadLabel` is reserved for multi-thread-per-scholar — for now, pass
 * nothing (or an empty string) and we return messages with no threadLabel
 * (the primary thread).
 */
export const listMessagesForScholar = curriculumQuery({
  args: {
    scholarId: v.id("users"),
    threadLabel: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const label = args.threadLabel?.trim() || undefined;
    const messages = await ctx.db
      .query("curriculumMessages")
      .withIndex("by_scholar_and_creation", (q) =>
        q.eq("scholarId", args.scholarId)
      )
      .order("asc")
      .take(400);
    // Only show messages authored by the current teacher for their own thread.
    // Admins can see everything (useful for debugging / supervision).
    const teacherFiltered = isPlatformAdminRole(ctx.user.role)
      ? messages
      : messages.filter((m) => m.teacherId === ctx.user._id);
    return teacherFiltered.filter(
      (m) => (m.threadLabel ?? undefined) === label
    );
  },
});

export const sendMessage = curriculumMutation({
  args: {
    message: v.string(),
    // Optional scholar scoping — when set, this message joins the
    // scholar-scoped thread (see listMessagesForScholar).
    scholarId: v.optional(v.id("users")),
    threadLabel: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const label = args.threadLabel?.trim() || undefined;

    // Insert user message
    await ctx.db.insert("curriculumMessages", {
      teacherId: ctx.user._id,
      scholarId: args.scholarId,
      threadLabel: label,
      role: "user",
      content: args.message,
    });

    // Create stream ID + placeholder assistant message
    const streamId = crypto.randomUUID();
    const assistantMsgId = await ctx.db.insert("curriculumMessages", {
      teacherId: ctx.user._id,
      scholarId: args.scholarId,
      threadLabel: label,
      role: "assistant",
      content: "",
      streamId,
    });

    return { streamId, assistantMsgId: String(assistantMsgId) };
  },
});

export const clearHistory = curriculumMutation({
  args: {
    // When set, clears only the scholar-scoped thread; otherwise clears the
    // global (unscoped) thread for this teacher.
    scholarId: v.optional(v.id("users")),
    threadLabel: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const label = args.threadLabel?.trim() || undefined;

    if (args.scholarId) {
      const messages = await ctx.db
        .query("curriculumMessages")
        .withIndex("by_scholar_and_creation", (q) =>
          q.eq("scholarId", args.scholarId)
        )
        .collect();
      for (const msg of messages) {
        if (msg.teacherId !== ctx.user._id && !isPlatformAdminRole(ctx.user.role)) continue;
        if ((msg.threadLabel ?? undefined) !== label) continue;
        await ctx.db.delete(msg._id);
      }
      return;
    }

    const messages = await ctx.db
      .query("curriculumMessages")
      .withIndex("by_teacher", (q) => q.eq("teacherId", ctx.user._id))
      .collect();
    for (const msg of messages) {
      if (msg.scholarId !== undefined || msg.unitId !== undefined) continue;
      await ctx.db.delete(msg._id);
    }
  },
});

// ── Unit-scoped messages (for Unit Designer chat) ───────────────────

export const getMessagesByUnit = curriculumQuery({
  args: { unitId: v.id("units") },
  handler: async (ctx, args) => {
    const messages = await ctx.db
      .query("curriculumMessages")
      .withIndex("by_teacher_unit", (q) =>
        q.eq("teacherId", ctx.user._id).eq("unitId", args.unitId)
      )
      .order("asc")
      .take(200);
    return messages;
  },
});

export const sendMessageForUnit = curriculumMutation({
  args: {
    message: v.string(),
    unitId: v.id("units"),
    /** Test-drive flag snapshots — when one or more flags were pending
     *  when the teacher sent, snapshot them onto the user message so
     *  they persist in chat history. Each entry renders as a chip above
     *  the user bubble. */
    flagSnapshots: v.optional(
      v.array(
        v.object({
          kind: v.union(v.literal("good"), v.literal("bad")),
          snippet: v.string(),
        }),
      ),
    ),
  },
  handler: async (ctx, args) => {
    await ctx.db.insert("curriculumMessages", {
      teacherId: ctx.user._id,
      unitId: args.unitId,
      role: "user",
      content: args.message,
      flagSnapshots:
        args.flagSnapshots && args.flagSnapshots.length > 0
          ? args.flagSnapshots
          : undefined,
    });

    const streamId = crypto.randomUUID();
    const assistantMsgId = await ctx.db.insert("curriculumMessages", {
      teacherId: ctx.user._id,
      unitId: args.unitId,
      role: "assistant",
      content: "",
      streamId,
    });

    return { streamId, assistantMsgId: String(assistantMsgId) };
  },
});

/**
 * Mark an in-flight assistant message as stopped by the user.
 * Appends a "[stream stopped by user]" marker so the next turn picks up cleanly,
 * and clears the streamId so the message is no longer considered in-progress.
 * If the message has no content yet, it is deleted.
 */
export const markMessageStopped = curriculumMutation({
  args: { messageId: v.id("curriculumMessages") },
  handler: async (ctx, args) => {
    const message = await ctx.db.get(args.messageId);
    if (!message) return;
    // If the stream already finalized between the client calling stop()
    // and this mutation reaching the DB, leave the completed message alone
    // — don't append a "stopped" marker to text the bot finished writing.
    if (!message.streamId) return;
    if (message.teacherId !== ctx.user._id && !isPlatformAdminRole(ctx.user.role)) {
      return;
    }
    const trimmed = (message.content ?? "").trim();
    if (!trimmed) {
      await ctx.db.delete(args.messageId);
    } else {
      await ctx.db.patch(args.messageId, {
        content: `${message.content}\n\n_[stream stopped by user]_`,
        streamId: undefined,
      });
    }
    if (message.chatId) {
      const session = await ctx.db.get(message.chatId);
      if (session?.activeStreamId) {
        await ctx.db.patch(message.chatId, { activeStreamId: undefined });
      }
    }
  },
});

export const clearHistoryForUnit = curriculumMutation({
  args: { unitId: v.id("units") },
  handler: async (ctx, args) => {
    const messages = await ctx.db
      .query("curriculumMessages")
      .withIndex("by_teacher_unit", (q) =>
        q.eq("teacherId", ctx.user._id).eq("unitId", args.unitId)
      )
      .collect();
    for (const msg of messages) {
      await ctx.db.delete(msg._id);
    }
  },
});

export const getUnitDesignerContext = internalQuery({
  args: { teacherId: v.id("users"), unitId: v.id("units") },
  handler: async (ctx, args) => {
    const teacher = await ctx.db.get(args.teacherId);
    const unit = await ctx.db.get(args.unitId);
    if (!unit) return null;

    const messages = await ctx.db
      .query("curriculumMessages")
      .withIndex("by_teacher_unit", (q) =>
        q.eq("teacherId", args.teacherId).eq("unitId", args.unitId)
      )
      .order("asc")
      .take(200);

    // Get lessons for this unit
    const lessons = await ctx.db
      .query("lessons")
      .withIndex("by_unit", (q) => q.eq("unitId", args.unitId))
      .collect();

    const lessonsWithProcess = await Promise.all(
      lessons.sort((a, b) => a.order - b.order).map(async (l) => {
        const process = l.processId ? await ctx.db.get(l.processId) : null;
        const activities = await ctx.db
          .query("activities")
          .withIndex("by_lesson", (q) => q.eq("lessonId", l._id))
          .collect();
        const sortedActs = await Promise.all(
          activities
            .sort((a, b) => a.order - b.order)
            .map(async (a) => {
              const presentations = await presentationState(ctx, a);
              return {
                _id: a._id,
                title: a.title,
                description: a.description ?? null,
                kind: a.kind,
                systemPrompt: a.systemPrompt ?? null,
                deliverable: a.deliverable ?? null,
                processId: a.processId ? String(a.processId) : null,
                durationMinutes: a.durationMinutes ?? null,
                googleSlidesPresentationId:
                  presentations.google?.presentationId ?? null,
                googleSlidesUrl: presentations.google?.url ?? null,
                googleSlidesOwnerId:
                  presentations.google?.principal.kind === "personal_oauth"
                    ? presentations.google.principal.userId
                    : null,
                recipe: a.recipe ?? null,
              };
            }),
        );
        return {
          ...l,
          processTitle: process?.title ?? null,
          processEmoji: process?.emoji ?? null,
          activities: sortedActs,
        };
      })
    );

    // Get available processes
    const processes = await ctx.db
      .query("processes")
      .withIndex("by_active", (q) => q.eq("isActive", true))
      .collect();

    return {
      teacherName: teacher?.name ?? "Teacher",
      unit,
      lessons: lessonsWithProcess,
      processes: processes.map((p) => ({
        id: String(p._id),
        title: p.title,
        emoji: p.emoji ?? "",
        steps: p.steps.map((s) => s.title).join(" → "),
      })),
      messages: messages.map((m) => ({
        role: m.role as "user" | "assistant",
        content: m.content,
      })),
    };
  },
});

// ── Internal (called by HTTP action) ────────────────────────────────

/**
 * Action-context adapter for the narrow school-operations tool surface.
 *
 * ActionCtx cannot read the database, so every transport (aide, MCP, Slack)
 * asks this query for the caller's *currently granted* institutions and the
 * scholars inside them. Do not broaden this into a general staff lens: a base
 * staff role has no scholar authority without the capability grant.
 */
export const schoolOperationsScopeForUser = internalQuery({
  args: { callerUserId: v.id("users") },
  handler: async (ctx, args) => {
    const user = await ctx.db.get(args.callerUserId);
    if (!user || user.role !== ROLES.STAFF) {
      return { institutionIds: [], scholarIds: [] };
    }
    const resolvedInstitutionIds = await schoolOperationsInstitutionIds(ctx, user);
    // `school:operations` is never global for a base staff account. Fail
    // closed if a future helper broadens its return type with "all".
    const institutionIds =
      resolvedInstitutionIds === "all"
        ? new Set<Id<"institutions">>()
        : resolvedInstitutionIds;
    const scholarIds: Id<"users">[] = [];
    for (const institutionId of institutionIds) {
      const scholars = await ctx.db
        .query("users")
        .withIndex("by_institution", (q) => q.eq("institutionId", institutionId))
        .collect();
      scholarIds.push(
        ...scholars
          .filter((candidate) => candidate.role === ROLES.SCHOLAR)
          .map((candidate) => candidate._id),
      );
    }
    return { institutionIds: [...institutionIds], scholarIds };
  },
});

export const getContext = internalQuery({
  args: {
    teacherId: v.id("users"),
    scholarId: v.optional(v.id("users")),
    threadLabel: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const teacher = await ctx.db.get(args.teacherId);
    const label = args.threadLabel?.trim() || undefined;

    // Pick the right thread. If scholarId is set, we want messages with
    // (scholarId, threadLabel). Otherwise the global (unscoped) thread.
    let messages;
    if (args.scholarId) {
      const scholarMessages = await ctx.db
        .query("curriculumMessages")
        .withIndex("by_scholar_and_creation", (q) =>
          q.eq("scholarId", args.scholarId)
        )
        .order("asc")
        .take(400);
      messages = scholarMessages.filter(
        (m) =>
          m.teacherId === args.teacherId &&
          (m.threadLabel ?? undefined) === label
      );
    } else {
      const teacherMessages = await ctx.db
        .query("curriculumMessages")
        .withIndex("by_teacher", (q) => q.eq("teacherId", args.teacherId))
        .order("asc")
        .take(400);
      messages = teacherMessages.filter(
        (m) => m.scholarId === undefined && m.unitId === undefined
      );
    }

    // Scholar context (pre-loaded so the system prompt can include it).
    let scholarContext: ScholarPromptContext | null = null;

    // Operations-only staff are walled off from sensitive learning data —
    // never pre-load a scholar's dossier/directives/seeds/observations for
    // them, even though they pass the isStaffRole gate on /curriculum-stream.
    // (`teacher` here is the authenticated caller — getContext is called
    // with teacherId = callerUserId.)
    const callerIsOperationsStaff = teacher?.role === ROLES.STAFF;

    if (args.scholarId && !callerIsOperationsStaff) {
      scholarContext = await loadScholarPromptContext(ctx, args.scholarId);
    }

    return {
      teacherName: teacher?.name ?? "Teacher",
      messages: messages.map((m) => ({
        role: m.role as "user" | "assistant",
        content: m.content,
        attachments: [] as {
          storageId: Id<"_storage">;
          fileName: string;
          mimeType: string | null;
          sizeBytes: number | null;
          url: string | null;
        }[],
      })),
      scholarContext,
    };
  },
});

export const updateStreamContent = internalMutation({
  args: {
    messageId: v.id("curriculumMessages"),
    content: v.string(),
  },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.messageId, { content: args.content });
  },
});

export const finalizeStream = internalMutation({
  args: {
    messageId: v.id("curriculumMessages"),
    content: v.string(),
    model: v.optional(v.string()),
    tokensUsed: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const message = await ctx.db.get(args.messageId);
    if (!args.content.trim()) {
      await ctx.db.delete(args.messageId);
    } else {
      await ctx.db.patch(args.messageId, {
        content: args.content,
        model: args.model,
        tokensUsed: args.tokensUsed,
        streamId: undefined,
      });
    }
    // Clear the in-progress indicator on the chat session
    if (message?.chatId) {
      await ctx.db.patch(message.chatId, { activeStreamId: undefined });
    }
  },
});

// ── Chats ────────────────────────────────────────────────────

export const createChat = staffMutation({
  args: {
    scholarId: v.optional(v.id("users")),
  },
  handler: async (ctx, args) => {
    if (args.scholarId) {
      await requireActiveScholarAccess(ctx, ctx.user, args.scholarId);
    }
    const sessionId = await ctx.db.insert("chats", {
      teacherId: ctx.user._id,
      title: "New chat",
      scholarId: args.scholarId,
      pinned: false,
      lastMessageAt: Date.now(),
    });
    return sessionId;
  },
});

/**
 * The GENERIC chat library — every ordinary thread of this teacher's (global,
 * scholar-scoped, Slack), and deliberately NOT the unit-design ones.
 *
 * A unit-scoped chat is only continuable where a `unitId` is in hand: the
 * unit-designer surfaces send through `sendUnitSessionMessage`, which is what
 * gives the thread the unit tools + prompt and stamps `unitId` on its messages.
 * The generic full-screen surface has no unit context, so continuing such a
 * thread there would silently fall through `sendSessionMessage` and drop both.
 * Unit-design chats therefore live with their unit, and
 * `listSessionsForUnit` is their canonical history — so this list excludes
 * them at the source rather than trusting every caller to filter.
 */
export const listSessions = staffQuery({
  args: {},
  handler: async (ctx) => {
    const sessions = await ctx.db
      .query("chats")
      .withIndex("by_teacher_unit", (q) =>
        q.eq("teacherId", ctx.user._id).eq("unitId", undefined),
      )
      .order("desc")
      .collect();
    // Pinned first, then by lastMessageAt desc
    const pinned = sessions.filter((s) => s.pinned).sort((a, b) => b.lastMessageAt - a.lastMessageAt);
    const recent = sessions.filter((s) => !s.pinned).sort((a, b) => b.lastMessageAt - a.lastMessageAt);
    return [...pinned, ...recent];
  },
});

/**
 * The last few generic chats by activity, for shortcut surfaces (the teacher
 * home's Recent chats module). Deliberately NOT `listSessions`: this reads a
 * recency-ordered index and takes `limit` rows, so a teacher with a long chat
 * history doesn't pay a full `.collect()` + client-side sort on every home
 * render. No pinning — pinning is a chat-library concern.
 */
export const listRecentChats = staffQuery({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const limit = Math.min(Math.max(args.limit ?? 3, 1), 20);
    const chats = await ctx.db
      .query("chats")
      .withIndex("by_teacher_unit_activity", (q) =>
        q.eq("teacherId", ctx.user._id).eq("unitId", undefined),
      )
      .order("desc")
      .take(limit);
    return chats.map((chat) => ({
      _id: chat._id,
      title: chat.title,
      lastMessageAt: chat.lastMessageAt,
    }));
  },
});

export const listSessionsForScholar = curriculumQuery({
  args: { scholarId: v.id("users") },
  handler: async (ctx, args) => {
    const sessions = await ctx.db
      .query("chats")
      .withIndex("by_scholar", (q) => q.eq("scholarId", args.scholarId))
      .collect();
    // Only sessions owned by this teacher (or admin sees all)
    const filtered = isPlatformAdminRole(ctx.user.role)
      ? sessions
      : sessions.filter((s) => s.teacherId === ctx.user._id);
    return filtered.sort((a, b) => b.lastMessageAt - a.lastMessageAt);
  },
});

export const renameChat = staffMutation({
  args: { sessionId: v.id("chats"), title: v.string() },
  handler: async (ctx, args) => {
    const session = await ctx.db.get(args.sessionId);
    if (!session || (session.teacherId !== ctx.user._id && !isPlatformAdminRole(ctx.user.role))) {
      throw new Error("Not found");
    }
    await ctx.db.patch(args.sessionId, { title: args.title.trim() || "Untitled" });
  },
});

export const togglePin = staffMutation({
  args: { sessionId: v.id("chats") },
  handler: async (ctx, args) => {
    const session = await ctx.db.get(args.sessionId);
    if (!session || (session.teacherId !== ctx.user._id && !isPlatformAdminRole(ctx.user.role))) {
      throw new Error("Not found");
    }
    await ctx.db.patch(args.sessionId, { pinned: !session.pinned });
  },
});

export const deleteSession = staffMutation({
  args: { sessionId: v.id("chats") },
  handler: async (ctx, args) => {
    const session = await ctx.db.get(args.sessionId);
    if (!session || (session.teacherId !== ctx.user._id && !isPlatformAdminRole(ctx.user.role))) {
      throw new Error("Not found");
    }
    // Cascade: delete all messages in this session
    const messages = await ctx.db
      .query("curriculumMessages")
      .withIndex("by_chat", (q) => q.eq("chatId", args.sessionId))
      .collect();
    for (const msg of messages) {
      await ctx.db.delete(msg._id);
    }
    await ctx.db.delete(args.sessionId);
  },
});

export const getChatMessages = staffQuery({
  args: { sessionId: v.id("chats") },
  handler: async (ctx, args) => {
    const session = await ctx.db.get(args.sessionId);
    if (!session || (session.teacherId !== ctx.user._id && !isPlatformAdminRole(ctx.user.role))) {
      return [];
    }
    return await ctx.db
      .query("curriculumMessages")
      .withIndex("by_chat", (q) => q.eq("chatId", args.sessionId))
      .order("asc")
      .take(400);
  },
});

export const sendSessionMessage = staffMutation({
  args: {
    sessionId: v.id("chats"),
    message: v.string(),
    attachments: v.optional(
      v.array(
        v.object({
          storageId: v.id("_storage"),
          fileName: v.string(),
          mimeType: v.optional(v.string()),
          sizeBytes: v.optional(v.number()),
        }),
      ),
    ),
    driveAttachments: v.optional(driveAttachmentValidator),
  },
  handler: async (ctx, args) => {
    const session = await ctx.db.get(args.sessionId);
    if (!session || (session.teacherId !== ctx.user._id && !isPlatformAdminRole(ctx.user.role))) {
      throw new Error("Session not found");
    }

    await ctx.db.insert("curriculumMessages", {
      teacherId: ctx.user._id,
      chatId: args.sessionId,
      scholarId: session.scholarId,
      role: "user",
      content: args.message,
      attachments:
        args.attachments && args.attachments.length > 0
          ? args.attachments
          : undefined,
      driveAttachments:
        args.driveAttachments && args.driveAttachments.length > 0
          ? args.driveAttachments
          : undefined,
    });

    const streamId = crypto.randomUUID();
    const assistantMsgId = await ctx.db.insert("curriculumMessages", {
      teacherId: ctx.user._id,
      chatId: args.sessionId,
      scholarId: session.scholarId,
      role: "assistant",
      content: "",
      streamId,
    });

    await ctx.db.patch(args.sessionId, { lastMessageAt: Date.now(), activeStreamId: streamId });
    return { streamId, assistantMsgId: String(assistantMsgId) };
  },
});

/**
 * Upload URL for a chat attachment (the composer's "+" button). Staff-gated
 * — the same set that can open the curriculum aide. The client PUTs the file
 * bytes here, then passes the returned storageId in `sendSessionMessage`'s
 * `attachments`.
 */
export const generateUploadUrl = staffMutation({
  args: {},
  handler: async (ctx) => {
    return await ctx.storage.generateUploadUrl();
  },
});

// Internal mutation called by tag_session AI tool and auto-name action
export const tagSession = internalMutation({
  args: {
    sessionId: v.id("chats"),
    scholarId: v.id("users"),
    callerUserId: v.id("users"),
  },
  handler: async (ctx, args) => {
    const session = await ctx.db.get(args.sessionId);
    if (!session || session.scholarId) return; // idempotent — don't overwrite
    const caller = await ctx.db.get(args.callerUserId);
    if (
      !caller ||
      (session.teacherId !== caller._id && !isPlatformAdminRole(caller.role))
    ) {
      throw new Error("Forbidden");
    }
    await requireActiveScholarAccess(ctx, caller, args.scholarId);
    await ctx.db.patch(args.sessionId, { scholarId: args.scholarId });
    // Backfill messages so they show up in scholar queries
    const messages = await ctx.db
      .query("curriculumMessages")
      .withIndex("by_chat", (q) => q.eq("chatId", args.sessionId))
      .collect();
    for (const msg of messages) {
      await ctx.db.patch(msg._id, { scholarId: args.scholarId });
    }
  },
});

// ── Unit-scoped chat sessions (Curriculum Bot per unit) ────────────────

export const createUnitSession = curriculumMutation({
  args: { unitId: v.id("units") },
  handler: async (ctx, args) => {
    const sessionId = await ctx.db.insert("chats", {
      teacherId: ctx.user._id,
      title: "New chat",
      unitId: args.unitId,
      pinned: false,
      lastMessageAt: Date.now(),
    });
    return sessionId;
  },
});

/**
 * The canonical history for ONE unit's design chats — the counterpart to the
 * exclusion in `listSessions`. These threads are reachable (and continuable)
 * only from the unit-designer surfaces, which hold the `unitId` that
 * `sendUnitSessionMessage` needs.
 */
export const listSessionsForUnit = curriculumQuery({
  args: { unitId: v.id("units") },
  handler: async (ctx, args) => {
    const sessions = await ctx.db
      .query("chats")
      .withIndex("by_teacher_unit", (q) =>
        q.eq("teacherId", ctx.user._id).eq("unitId", args.unitId),
      )
      .collect();
    const pinned = sessions
      .filter((s) => s.pinned)
      .sort((a, b) => b.lastMessageAt - a.lastMessageAt);
    const recent = sessions
      .filter((s) => !s.pinned)
      .sort((a, b) => b.lastMessageAt - a.lastMessageAt);
    return [...pinned, ...recent];
  },
});

export const sendUnitSessionMessage = curriculumMutation({
  args: {
    sessionId: v.id("chats"),
    unitId: v.id("units"),
    message: v.string(),
    flagSnapshots: v.optional(
      v.array(
        v.object({
          kind: v.union(v.literal("good"), v.literal("bad")),
          snippet: v.string(),
        }),
      ),
    ),
    // Parity with sendSessionMessage — the unified composer can attach files
    // in unit scope too (the /aide-stream unit branch reads them the same way).
    attachments: v.optional(
      v.array(
        v.object({
          storageId: v.id("_storage"),
          fileName: v.string(),
          mimeType: v.optional(v.string()),
          sizeBytes: v.optional(v.number()),
        }),
      ),
    ),
    driveAttachments: v.optional(driveAttachmentValidator),
  },
  handler: async (ctx, args) => {
    const session = await ctx.db.get(args.sessionId);
    if (
      !session ||
      session.unitId !== args.unitId ||
      (session.teacherId !== ctx.user._id && !isPlatformAdminRole(ctx.user.role))
    ) {
      throw new Error("Session not found");
    }

    await ctx.db.insert("curriculumMessages", {
      teacherId: ctx.user._id,
      unitId: args.unitId,
      chatId: args.sessionId,
      role: "user",
      content: args.message,
      flagSnapshots:
        args.flagSnapshots && args.flagSnapshots.length > 0
          ? args.flagSnapshots
          : undefined,
      attachments:
        args.attachments && args.attachments.length > 0
          ? args.attachments
          : undefined,
      driveAttachments:
        args.driveAttachments && args.driveAttachments.length > 0
          ? args.driveAttachments
          : undefined,
    });

    const streamId = crypto.randomUUID();
    const assistantMsgId = await ctx.db.insert("curriculumMessages", {
      teacherId: ctx.user._id,
      unitId: args.unitId,
      chatId: args.sessionId,
      role: "assistant",
      content: "",
      streamId,
    });

    await ctx.db.patch(args.sessionId, {
      lastMessageAt: Date.now(),
      activeStreamId: streamId,
    });
    return { streamId, assistantMsgId: String(assistantMsgId) };
  },
});

export const getUnitDesignerContextForSession = internalQuery({
  args: { sessionId: v.id("chats"), callerUserId: v.id("users") },
  handler: async (ctx, args) => {
    const session = await ctx.db.get(args.sessionId);
    if (!session || !session.unitId) return null;

    // Ownership: only the session's owner (or an admin) may read it —
    // mirrors getContextForChat. Without this, an authenticated staffer
    // could pass another teacher's chats._id and get that session's
    // Curriculum-Bot transcript back as AI context (cross-staff leak).
    const caller = await ctx.db.get(args.callerUserId);
    if (
      !caller ||
      (session.teacherId !== args.callerUserId && !isPlatformAdminRole(caller.role))
    ) {
      return null;
    }

    const teacher = await ctx.db.get(session.teacherId);
    const unit = await ctx.db.get(session.unitId);
    if (!unit) return null;

    const messages = await ctx.db
      .query("curriculumMessages")
      .withIndex("by_chat", (q) => q.eq("chatId", args.sessionId))
      .order("asc")
      .take(400);

    const lessons = await ctx.db
      .query("lessons")
      .withIndex("by_unit", (q) => q.eq("unitId", session.unitId!))
      .collect();

    const lessonsWithProcess = await Promise.all(
      lessons.sort((a, b) => a.order - b.order).map(async (l) => {
        const process = l.processId ? await ctx.db.get(l.processId) : null;
        const activities = await ctx.db
          .query("activities")
          .withIndex("by_lesson", (q) => q.eq("lessonId", l._id))
          .collect();
        const sortedActs = await Promise.all(
          activities
            .sort((a, b) => a.order - b.order)
            .map(async (a) => {
              const presentations = await presentationState(ctx, a);
              return {
                _id: a._id,
                title: a.title,
                description: a.description ?? null,
                kind: a.kind,
                systemPrompt: a.systemPrompt ?? null,
                deliverable: a.deliverable ?? null,
                processId: a.processId ? String(a.processId) : null,
                durationMinutes: a.durationMinutes ?? null,
                googleSlidesPresentationId:
                  presentations.google?.presentationId ?? null,
                googleSlidesUrl: presentations.google?.url ?? null,
                googleSlidesOwnerId:
                  presentations.google?.principal.kind === "personal_oauth"
                    ? presentations.google.principal.userId
                    : null,
              };
            }),
        );
        return {
          ...l,
          processTitle: process?.title ?? null,
          processEmoji: process?.emoji ?? null,
          activities: sortedActs,
        };
      }),
    );

    const processes = await ctx.db
      .query("processes")
      .withIndex("by_active", (q) => q.eq("isActive", true))
      .collect();

    return {
      teacherId: session.teacherId,
      teacherName: teacher?.name ?? "Teacher",
      unit,
      lessons: lessonsWithProcess,
      processes: processes.map((p) => ({
        id: String(p._id),
        title: p.title,
        emoji: p.emoji ?? "",
        steps: p.steps.map((s) => s.title).join(" → "),
      })),
      messages: await Promise.all(
        messages
          // Keep a message if it has text OR attachments OR a linked Drive doc
          // (an attachment-only "here's the file" turn has empty content but
          // must not be dropped — the bot needs to see the file).
          .filter(
            (m) =>
              m.content.trim() !== "" ||
              (m.attachments && m.attachments.length > 0) ||
              (m.driveAttachments && m.driveAttachments.length > 0),
          )
          .map(async (m) => ({
            role: m.role as "user" | "assistant",
            content: m.content,
            attachments: m.attachments
              ? await Promise.all(
                  m.attachments.map(async (a) => ({
                    storageId: a.storageId,
                    fileName: a.fileName,
                    mimeType: a.mimeType ?? null,
                    sizeBytes: a.sizeBytes ?? null,
                    url: await ctx.storage.getUrl(a.storageId),
                  })),
                )
              : [],
            driveAttachments: m.driveAttachments ?? [],
          })),
      ),
    };
  },
});

export const setChatTitle = internalMutation({
  args: { sessionId: v.id("chats"), title: v.string() },
  handler: async (ctx, args) => {
    const session = await ctx.db.get(args.sessionId);
    if (!session || session.title !== "New chat") return; // don't overwrite manual renames
    await ctx.db.patch(args.sessionId, { title: args.title });
  },
});

export const getSessionFirstExchange = internalQuery({
  args: { sessionId: v.id("chats") },
  handler: async (ctx, args) => {
    const session = await ctx.db.get(args.sessionId);
    if (!session) {
      return {
        teacherId: null,
        firstUserMessage: null,
        firstAssistantMessage: null,
      };
    }
    const messages = await ctx.db
      .query("curriculumMessages")
      .withIndex("by_chat", (q) => q.eq("chatId", args.sessionId))
      .order("asc")
      .take(4);
    const userMsg = messages.find((m) => m.role === "user");
    const assistantMsg = messages.find((m) => m.role === "assistant" && m.content.trim());
    return {
      teacherId: session.teacherId,
      firstUserMessage: userMsg?.content ?? null,
      firstAssistantMessage: assistantMsg?.content ?? null,
    };
  },
});

export const getContextForChat = internalQuery({
  args: { sessionId: v.id("chats"), callerUserId: v.id("users") },
  handler: async (ctx, args) => {
    const session = await ctx.db.get(args.sessionId);
    if (!session) return null;

    // Ownership: only the session's owner (or an admin) may read it.
    // Mirrors getChatMessages — the public sibling enforces this, and
    // the streaming endpoint must not be a weaker door to the same data.
    const caller = await ctx.db.get(args.callerUserId);
    if (
      !caller ||
      (session.teacherId !== args.callerUserId && !isPlatformAdminRole(caller.role))
    ) {
      return null;
    }
    // Non-teaching operations staff never get a scholar's sensitive context
    // pre-loaded, even for a session they own.
    const callerIsNonTeachingOperations = isNonTeachingOperationsRole(
      caller.role,
    );

    const teacher = await ctx.db.get(session.teacherId);

    const messages = await ctx.db
      .query("curriculumMessages")
      .withIndex("by_chat", (q) => q.eq("chatId", args.sessionId))
      .order("asc")
      .take(400);

    // Re-use scholar context loading from the shared helper.
    let scholarContext: ScholarPromptContext | null = null;

    if (session.scholarId && !callerIsNonTeachingOperations) {
      scholarContext = await loadScholarPromptContext(ctx, session.scholarId);
    }

    return {
      teacherId: session.teacherId,
      teacherName: teacher?.name ?? "Teacher",
      sessionId: args.sessionId,
      scholarId: session.scholarId ?? null,
      messages: await Promise.all(
        messages
          // Keep a message if it has text OR attachments (an attachment-only
          // "here's the file" turn has empty content but must not be dropped).
          .filter(
            (m) =>
              m.content.trim() !== "" ||
              (m.attachments && m.attachments.length > 0) ||
              (m.driveAttachments && m.driveAttachments.length > 0),
          )
          .map(async (m) => ({
            role: m.role as "user" | "assistant",
            content: m.content,
            attachments: m.attachments
              ? await Promise.all(
                  m.attachments.map(async (a) => ({
                    storageId: a.storageId,
                    fileName: a.fileName,
                    mimeType: a.mimeType ?? null,
                    sizeBytes: a.sizeBytes ?? null,
                    url: await ctx.storage.getUrl(a.storageId),
                  })),
                )
              : [],
            driveAttachments: m.driveAttachments ?? [],
          })),
      ),
      scholarContext,
    };
  },
});

/**
 * Load a scholar's redacted prompt context for the EPHEMERAL "currently
 * viewing" focus in the docked chat — a scholar the teacher is looking at
 * right now, NOT one the chat thread is bound to. Unlike getContextForChat
 * (session-bound scholar), this is passed per-request from the dock scope so
 * the same persistent thread re-contextualizes as the teacher navigates.
 *
 * ACL: teacher-role only (operations staff + curriculum_designers are walled off
 * from sensitive scholar data). The /aide-stream caller additionally gates on
 * the institution lens before injecting this. Body ids are NEVER trusted for
 * auth — this only pre-loads already-authorized data for prompt convenience.
 */
export const getScholarFocusContext = internalQuery({
  args: { scholarId: v.id("users"), callerUserId: v.id("users") },
  handler: async (ctx, args) => {
    const caller = await ctx.db.get(args.callerUserId);
    if (!caller || !isTeacherRole(caller.role)) return null;
    return await loadScholarPromptContext(ctx, args.scholarId);
  },
});

// ── Tool data helpers (internal) ────────────────────────────────────
// Thin internalQuery wrappers so the aide streams (action ctx) can call
// the shared scholar-read layer. The implementations live in
// lib/scholarReads.ts, shared with convex/parents.ts and convex/mcp.ts —
// one definition of "what an agent surface reads about a scholar."

// `includeProgramGuests` is deliberately REQUIRED (not optional): every call
// site must state its participation decision — enumeration edges pass the
// model's opt-in through, name-keyed resolvers pass true (naming IS the
// opt-in; see lib/scholarParticipationTooling.ts).
// `allowedScholarIds` (the caller's institution-lens set) narrows the roster
// BEFORE the guest filter, so `extendedEducationOmitted` counts only guests
// the caller could actually see — never other schools' — and out-of-lens
// scholars skip the per-scholar count queries entirely.
export const listScholarsInternal = internalQuery({
  args: {
    includeProgramGuests: v.boolean(),
    allowedScholarIds: v.optional(v.array(v.id("users"))),
  },
  handler: async (ctx, args) =>
    readScholarRoster(
      ctx,
      args.allowedScholarIds ? new Set(args.allowedScholarIds) : null,
      { includeProgramGuests: args.includeProgramGuests },
    ),
});

/**
 * Resolve the active institution lens for the staff aide and return the set of
 * scholar userIds visible under it.
 *
 * The aide runs in an ActionCtx (the /aide-stream HTTP action), which can't
 * call resolveInstitutionLens directly (it needs a QueryCtx), so the action
 * runs this and hands the result into the scholar-read tool layer.
 *
 * `unrestricted: true` (scholarIds null) means "this caller's lens shows their
 * whole allowed universe" — an "all" lens for a platform admin. In that case
 * the caller passes NO allowedScholarIds, staying byte-identical to the
 * pre-lens behavior (no membership filtering). Otherwise the explicit id set
 * scopes the roster + every named lookup, and `lensLabel` is a human string
 * the aide can cite ("you're scoped to Moli School").
 *
 * The requested slug is never trusted beyond what resolveInstitutionLens
 * enforces — it only honors institutions the caller may actually see.
 *
 * The lens is ACCESS scope only, so it includes Extended Education
 * (program-guest) scholars: the enrolled-only default is enforced at the
 * tool layer (lib/scholarReadTools.ts / scholarParticipationTooling.ts),
 * where the model's explicit opt-in can widen it — and where a named
 * lookup must still be able to resolve a guest inside the lens.
 */
export const resolveAideScholarLens = internalQuery({
  args: { callerUserId: v.id("users"), scope: v.string() },
  handler: async (ctx, { callerUserId, scope }) => {
    const caller = await ctx.db.get(callerUserId);
    if (!caller) {
      return { scholarIds: null, lensLabel: null, unrestricted: true } as const;
    }
    const lens = await resolveInstitutionLens(ctx, caller, scope);
    // An "all" lens for a caller who may see every institution (platform
    // admin) is functionally unrestricted — mirror pre-lens behavior exactly
    // rather than materialize a set of every scholar.
    if (lens.scope === "all" && lens.isAdmin) {
      return { scholarIds: null, lensLabel: null, unrestricted: true } as const;
    }
    const ids = await scholarIdsInLens(ctx, lens, { includeProgramGuests: true });
    const lensLabel =
      lens.scope === "all"
        ? "all institutions you can access"
        : lens.institution?.name ?? null;
    return { scholarIds: [...ids], lensLabel, unrestricted: false } as const;
  },
});

// Required for the same reason as listScholarsInternal above.
export const listScholarGroupsInternal = internalQuery({
  args: {
    includeProgramGuests: v.boolean(),
    allowedScholarIds: v.optional(v.array(v.id("users"))),
  },
  handler: async (ctx, args) =>
    readScholarGroups(
      ctx,
      args.allowedScholarIds
        ? new Set<Id<"users">>(args.allowedScholarIds)
        : null,
      { includeProgramGuests: args.includeProgramGuests },
    ),
});

export const getScholarMastery = internalQuery({
  args: { scholarId: v.id("users"), role: v.optional(v.string()) },
  handler: async (ctx, args) =>
    readScholarMastery(ctx, args.scholarId, args.role as Role | undefined),
});

export const getScholarSignals = internalQuery({
  args: { scholarId: v.id("users") },
  handler: async (ctx, args) => readScholarSignals(ctx, args.scholarId),
});

export const getScholarSeeds = internalQuery({
  args: { scholarId: v.id("users") },
  handler: async (ctx, args) => readScholarSeeds(ctx, args.scholarId),
});

export const getScholarObservations = internalQuery({
  args: { scholarId: v.id("users") },
  handler: async (ctx, args) => readScholarObservations(ctx, args.scholarId),
});

export const getScholarDossier = internalQuery({
  args: { scholarId: v.id("users") },
  handler: async (ctx, args) => readScholarDossier(ctx, args.scholarId),
});

export const getScholarSessions = internalQuery({
  args: { scholarId: v.id("users") },
  handler: async (ctx, args) => readScholarSessions(ctx, args.scholarId),
});

export const getSessionTranscript = internalQuery({
  args: {
    scholarId: v.id("users"),
    sessionId: v.optional(v.id("sessions")),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) =>
    readSessionTranscript(ctx, args.scholarId, {
      sessionId: args.sessionId,
      limit: args.limit,
    }),
});

export const getScholarWebActivity = internalQuery({
  args: { scholarId: v.id("users") },
  handler: async (ctx, args) => readScholarWebActivity(ctx, args.scholarId),
});

export const getScholarPractice = internalQuery({
  args: { scholarId: v.id("users") },
  handler: async (ctx, args) => readScholarPractice(ctx, args.scholarId),
});

// The authoritative check-in read. Internal-only, and every caller must have
// resolved the scholar through a lens-scoped chokepoint first — this query
// takes a bare id and does no scoping of its own (same contract as every other
// read in this block; see the section header above).
export const getScholarMathCheckIn = internalQuery({
  args: { scholarId: v.id("users") },
  handler: async (ctx, args) => readScholarMathCheckIn(ctx, args.scholarId),
});

export const listUnitsInternal = internalQuery({
  args: {},
  handler: async (ctx) => {
    const units = await ctx.db.query("units").collect();
    const result = [];
    for (const u of units) {
      const persona = u.personaId ? await ctx.db.get(u.personaId) : null;
      const perspective = u.perspectiveId ? await ctx.db.get(u.perspectiveId) : null;
      const process = u.processId ? await ctx.db.get(u.processId) : null;
      result.push({
        id: u._id,
        title: u.title,
        description: u.description ?? null,
        targetBloomLevel: u.targetBloomLevel ?? null,
        isActive: u.isActive,
        personaTitle: persona?.title ?? null,
        perspectiveTitle: perspective?.title ?? null,
        processTitle: process?.title ?? null,
      });
    }
    return result;
  },
});

/**
 * Test-drive context for the unit-designer stream. When the bot drawer is
 * opened from a test drive, the FE forwards the project id + the calling
 * teacher's id; this query returns the activity's current systemPrompt,
 * the last N messages of the drive, and any teacher flags pinned to those
 * messages. The stream handler folds it into the system prompt so
 * Curriculum Bot can ground prompt-refinement suggestions in the actual
 * conversation.
 *
 * Cross-teacher exfil guard: returns null unless the caller is the
 * project's owner. The http action passes `teacherId` from the caller's
 * verified session — internal queries can't read auth themselves, so the
 * action is the trust boundary. Without this check, a teacher could
 * forge a `testDriveProjectId` over the wire and read another teacher's
 * test-drive transcript + flags.
 */
export const getTestDriveContext = internalQuery({
  args: {
    sessionId: v.id("sessions"),
    teacherId: v.id("users"),
    limit: v.optional(v.number()), // last N messages; default 30
  },
  handler: async (ctx, args) => {
    const session = await ctx.db.get(args.sessionId);
    if (!session || !session.isTestDrive) return null;
    if (session.userId !== args.teacherId) return null;

    const limit = args.limit ?? 30;

    // Activity that's being driven — its systemPrompt is what produced the
    // tutor's behavior. Useful for the bot to map "this was rambling" →
    // "your prompt says X, so the tutor did Y."
    const activity = session.activityId
      ? await ctx.db.get(session.activityId)
      : null;

    // Last N user/assistant messages, in chronological order. Full scan
    // of the project's messages — bounded by per-project message count
    // (the `by_project` index keeps it scoped, not table-wide). Cheap
    // today since most test drives are < 50 messages. If a teacher leaves
    // a long drive open and chats hundreds of times, switch to
    // `.order("desc").take(limit + 1)` then reverse, with a separate
    // count query if `totalCount` is still wanted in the prompt.
    const allMessages = await ctx.db
      .query("messages")
      .withIndex("by_session", (q) => q.eq("sessionId", args.sessionId))
      .order("asc")
      .collect();
    const conversational = allMessages.filter(
      (m) => m.role === "user" || m.role === "assistant",
    );
    const truncated =
      conversational.length > limit
        ? conversational.slice(-limit)
        : conversational;
    const totalCount = conversational.length;

    // Flags inline-annotate matching tutor messages. Map by messageId.
    const flagRows = await ctx.db
      .query("testDriveFlags")
      .withIndex("by_session", (q) => q.eq("sessionId", args.sessionId))
      .collect();
    const flagsByMessageId = new Map<
      string,
      { kind: "good" | "bad"; note: string | null }
    >();
    for (const f of flagRows) {
      flagsByMessageId.set(String(f.messageId), {
        kind: f.kind,
        note: f.note ?? null,
      });
    }

    return {
      activity: activity
        ? {
            title: activity.title,
            systemPrompt: activity.systemPrompt ?? null,
          }
        : null,
      messages: truncated.map((m) => ({
        id: String(m._id),
        role: m.role as "user" | "assistant",
        content: m.content,
        flag: flagsByMessageId.get(String(m._id)) ?? null,
      })),
      totalCount,
      truncated: conversational.length > limit,
    };
  },
});

// ── Internal mutations (called by unit-designer-stream HTTP action) ───

export const updateUnitInternal = internalMutation({
  args: {
    unitId: v.id("units"),
    bigIdea: v.optional(v.union(v.string(), v.null())),
    essentialQuestions: v.optional(v.array(v.string())),
    enduringUnderstandings: v.optional(v.array(v.string())),
    subject: v.optional(v.union(v.string(), v.null())),
    gradeLevel: v.optional(v.union(v.string(), v.null())),
  },
  handler: async (ctx, args) => {
    const { unitId, ...fields } = args;
    const unit = await ctx.db.get(unitId);
    if (!unit) throw new Error("Unit not found");
    const updates: Record<string, unknown> = {};
    if (fields.bigIdea !== undefined) updates.bigIdea = fields.bigIdea ?? undefined;
    if (fields.essentialQuestions !== undefined)
      updates.essentialQuestions = toKeyedGranules(
        fields.essentialQuestions, unit.essentialQuestions, "eq");
    if (fields.enduringUnderstandings !== undefined)
      updates.enduringUnderstandings = toKeyedGranules(
        fields.enduringUnderstandings, unit.enduringUnderstandings, "eu");
    if (fields.subject !== undefined) updates.subject = fields.subject ?? undefined;
    if (fields.gradeLevel !== undefined) updates.gradeLevel = fields.gradeLevel ?? undefined;
    await ctx.db.patch(unitId, updates);
  },
});

export const createLessonInternal = internalMutation({
  args: {
    unitId: v.id("units"),
    title: v.string(),
    strand: v.optional(v.union(
      v.literal("core"), v.literal("connections"),
      v.literal("practice"), v.literal("identity")
    )),
    processId: v.optional(v.id("processes")),
    systemPrompt: v.optional(v.string()),
    durationMinutes: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("lessons")
      .withIndex("by_unit", (q) => q.eq("unitId", args.unitId))
      .collect();
    const maxOrder = existing.reduce((max, l) => Math.max(max, l.order), -1);

    return await ctx.db.insert("lessons", {
      unitId: args.unitId,
      title: args.title.trim(),
      strand: args.strand,
      systemPrompt: args.systemPrompt?.trim() || undefined,
      processId: args.processId,
      order: maxOrder + 1,
      durationMinutes: args.durationMinutes,
    });
  },
});

export const updateLessonInternal = internalMutation({
  args: {
    lessonId: v.id("lessons"),
    title: v.optional(v.string()),
    strand: v.optional(v.union(
      v.literal("core"), v.literal("connections"),
      v.literal("practice"), v.literal("identity"),
      v.null()
    )),
    processId: v.optional(v.union(v.id("processes"), v.null())),
    systemPrompt: v.optional(v.union(v.string(), v.null())),
    durationMinutes: v.optional(v.union(v.number(), v.null())),
  },
  handler: async (ctx, args) => {
    const { lessonId, ...fields } = args;
    const updates: Record<string, unknown> = {};
    if (fields.title !== undefined) updates.title = fields.title.trim();
    if (fields.strand !== undefined) updates.strand = fields.strand ?? undefined;
    if (fields.processId !== undefined) updates.processId = fields.processId ?? undefined;
    if (fields.systemPrompt !== undefined) updates.systemPrompt = fields.systemPrompt?.trim() || undefined;
    if (fields.durationMinutes !== undefined) updates.durationMinutes = fields.durationMinutes ?? undefined;
    await ctx.db.patch(lessonId, updates);
  },
});

export const deleteLessonInternal = internalMutation({
  args: { lessonId: v.id("lessons") },
  handler: async (ctx, args) => {
    // Cascade activities. Scholar work on ANY child activity blocks the whole
    // delete — the Curriculum Bot must archive instead (same rule as the
    // teacher-facing lessons.remove).
    const acts = await ctx.db
      .query("activities")
      .withIndex("by_lesson", (q) => q.eq("lessonId", args.lessonId))
      .collect();
    for (const a of acts) {
      if (await activityHasScholarWork(ctx, a._id)) {
        throw new Error(
          `Can't delete this lesson: scholars have worked on "${a.title}". Archive that activity instead.`,
        );
      }
    }
    for (const a of acts) {
      await deleteActivityCascade(ctx, a._id, { skipWorkGuard: true });
    }
    await ctx.db.delete(args.lessonId);
  },
});

/** Direct lesson resolver for the global Curriculum Bot's kind-specific tools. */
export const getLessonForActivityAuthoring = internalQuery({
  args: { lessonId: v.id("lessons") },
  handler: async (ctx, args) => {
    const lesson = await ctx.db.get(args.lessonId);
    if (!lesson) return null;
    const activities = await ctx.db
      .query("activities")
      .withIndex("by_lesson", (q) => q.eq("lessonId", args.lessonId))
      .collect();
    return {
      lesson,
      activities: activities
        .filter((activity) => !activity.archivedAt)
        .sort((a, b) => a.order - b.order),
    };
  },
});

export const getUnitDetails = internalQuery({
  args: {
    unitId: v.string(),
    includeActivityDetails: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const unitId = ctx.db.normalizeId("units", args.unitId);
    const unit = unitId ? await ctx.db.get(unitId) : null;
    if (!unit) return null;
    const activityDetailsIncluded = args.includeActivityDetails ?? false;

    const persona = unit.personaId ? await ctx.db.get(unit.personaId) : null;
    const perspective = unit.perspectiveId ? await ctx.db.get(unit.perspectiveId) : null;
    const process = unit.processId ? await ctx.db.get(unit.processId) : null;
    const lessons = await ctx.db
      .query("lessons")
      .withIndex("by_unit", (q) => q.eq("unitId", unit._id))
      .collect();
    const lessonsWithActivities = await Promise.all(
      lessons
        .sort((a, b) => a.order - b.order)
        .map(async (lesson) => {
          const activities = await ctx.db
            .query("activities")
            .withIndex("by_lesson", (q) => q.eq("lessonId", lesson._id))
            .collect();
          return {
            id: lesson._id,
            title: lesson.title,
            order: lesson.order,
            activities: activities
              .sort((a, b) => a.order - b.order)
              .map((activity) => ({
                id: activity._id,
                title: activity.title,
                kind: activity.kind,
                ...(activityDetailsIncluded
                  ? {
                      description: activity.description ?? null,
                      systemPrompt: activity.systemPrompt ?? null,
                      deliverable: activity.deliverable ?? null,
                      advanceRubric: activity.advanceRubric ?? null,
                    }
                  : {}),
              })),
          };
        }),
    );

    return {
      title: unit.title,
      description: unit.description ?? null,
      systemPrompt: unit.systemPrompt ?? null,
      rubric: unit.rubric ?? null,
      targetBloomLevel: unit.targetBloomLevel ?? null,
      persona: persona ? { title: persona.title, emoji: persona.emoji, systemPrompt: persona.systemPrompt ?? null } : null,
      perspective: perspective ? { title: perspective.title, icon: perspective.icon ?? null, systemPrompt: perspective.systemPrompt ?? null } : null,
      process: process ? { title: process.title, emoji: process.emoji ?? null, steps: process.steps } : null,
      activityDetailsIncluded,
      lessons: lessonsWithActivities,
    };
  },
});

// Quest-scoped Curriculum Bot sessions removed in the kill-quests
// refactor. The unit-scoped Curriculum Bot remains.
