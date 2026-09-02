import { v } from "convex/values";
import { internalMutation } from "./_generated/server";
import { authedQuery, authedMutation } from "./lib/customFunctions";
import { requireTeacherOrSelf } from "./lib/auth";
import { requireActiveScholarAccess } from "./lib/access";
import type { Id } from "./_generated/dataModel";

/**
 * Physical tasks — the tutor's hands-on invitations (Phase 2 of
 * review/physical-environment-teaching-tool-plan.html). The tutor's
 * `suggest_physical_task` tool writes a row here so the invitation renders as a
 * "Go do this" card, persists, and is visible to teachers; the scholar taps
 * "I'm back" to mark it done and then reports what they noticed in chat.
 *
 * Access: a scholar sees/completes their OWN tasks; teachers/admins see any
 * scholar's (remote view-as, the learning record). Registrars are excluded via
 * requireTeacherOrSelf.
 */

/**
 * Create a physical task (called by the tutor tool in http.ts — INTERNAL, the
 * HTTP action has already authed the caller + verified session access). Best-
 * effort links `equipmentId` by matching the scholar's institution inventory on
 * name, so a completed task can attach to the concept graph in Phase 3 — but the
 * durable record is the NAME (a later rename/archive never orphans it).
 */
export const create = internalMutation({
  args: {
    sessionId: v.id("sessions"),
    scholarId: v.id("users"),
    assignmentId: v.optional(v.id("assignments")),
    equipmentName: v.string(),
    spaceName: v.optional(v.string()),
    prompt: v.string(),
  },
  handler: async (ctx, args) => {
    // Best-effort resolve the equipment id from the scholar's institution.
    let equipmentId: Id<"equipment"> | undefined;
    let equipmentName = args.equipmentName.trim();
    const scholar = await ctx.db.get(args.scholarId);
    const institutionId = scholar?.institutionId;
    if (institutionId) {
      const inventory = await ctx.db
        .query("equipment")
        .withIndex("by_institution", (q) =>
          q.eq("institutionId", institutionId),
        )
        .collect();
      const match = inventory.find(
        (e) => e.name.toLowerCase() === equipmentName.toLowerCase(),
      );
      if (match) {
        equipmentId = match._id;
        // Canonicalize to the inventory's spelling/casing.
        equipmentName = match.name;
      }
    }

    return await ctx.db.insert("physicalTasks", {
      sessionId: args.sessionId,
      scholarId: args.scholarId,
      assignmentId: args.assignmentId,
      equipmentId,
      equipmentName,
      spaceName: args.spaceName?.trim() || undefined,
      prompt: args.prompt.trim(),
      status: "suggested",
      suggestedAt: Date.now(),
    });
  },
});

/** The single task behind a "Go do this" card (keyed by the tool row). */
export const getForCard = authedQuery({
  args: { id: v.id("physicalTasks") },
  handler: async (ctx, args) => {
    const task = await ctx.db.get(args.id);
    if (!task) return null;
    // Owner or teacher/admin only.
    const isTeacher = requireTeacherOrSelf(ctx.user, task.scholarId);
    if (isTeacher) await requireActiveScholarAccess(ctx, ctx.user, task.scholarId);
    return {
      id: task._id,
      equipmentName: task.equipmentName,
      spaceName: task.spaceName ?? null,
      prompt: task.prompt,
      status: task.status,
      completedAt: task.completedAt ?? null,
      photoStorageId: task.photoStorageId ?? null,
    };
  },
});

/** All physical tasks for a session (teacher visibility + the record). */
export const listForSession = authedQuery({  args: { sessionId: v.id("sessions") },
  handler: async (ctx, args) => {
    const session = await ctx.db.get(args.sessionId);
    if (!session) return [];
    const isTeacher = requireTeacherOrSelf(ctx.user, session.userId);
    if (isTeacher && session.userId !== ctx.user._id) {
      await requireActiveScholarAccess(ctx, ctx.user, session.userId);
    }
    const tasks = await ctx.db
      .query("physicalTasks")
      .withIndex("by_session", (q) => q.eq("sessionId", args.sessionId))
      .collect();
    return tasks
      .sort((a, b) => a.suggestedAt - b.suggestedAt)
      .map((t) => ({
        id: t._id,
        equipmentName: t.equipmentName,
        spaceName: t.spaceName ?? null,
        prompt: t.prompt,
        status: t.status,
        suggestedAt: t.suggestedAt,
        completedAt: t.completedAt ?? null,
      }));
  },
});

/**
 * A scholar's completed hands-on explorations across all their sessions — the
 * "portrait" payoff (Total Talent Portfolio: interests × how they work). Powers
 * the ScholarFeed. Owner or teacher/admin only.
 */
export const listForScholar = authedQuery({
  args: { scholarId: v.id("users") },
  handler: async (ctx, args) => {
    const isTeacher = requireTeacherOrSelf(ctx.user, args.scholarId);
    if (isTeacher) await requireActiveScholarAccess(ctx, ctx.user, args.scholarId);
    const tasks = await ctx.db
      .query("physicalTasks")
      .withIndex("by_scholar", (q) => q.eq("scholarId", args.scholarId))
      .collect();
    return tasks
      .filter((t) => t.status === "completed")
      .sort((a, b) => (b.completedAt ?? 0) - (a.completedAt ?? 0))
      .map((t) => ({
        id: t._id,
        sessionId: t.sessionId,
        equipmentName: t.equipmentName,
        spaceName: t.spaceName ?? null,
        prompt: t.prompt,
        completedAt: t.completedAt ?? t.suggestedAt,
        photoStorageId: t.photoStorageId ?? null,
      }));
  },
});

/** Scholar taps "I'm back" — mark the task done. Idempotent. */
export const markDone = authedMutation({
  args: { id: v.id("physicalTasks") },
  handler: async (ctx, args) => {
    const task = await ctx.db.get(args.id);
    if (!task) throw new Error("Physical task not found");
    const isTeacher = requireTeacherOrSelf(ctx.user, task.scholarId);
    if (isTeacher) await requireActiveScholarAccess(ctx, ctx.user, task.scholarId);
    if (task.status !== "completed") {
      await ctx.db.patch(args.id, {
        status: "completed",
        completedAt: Date.now(),
      });
    }
  },
});

/**
 * "📸 Show what I found" — the scholar returns from a hands-on task with a PHOTO
 * of what they built/found. The image was already uploaded to file storage by
 * the client (`api.files.generateUploadUrl`, the SAME path the chat image
 * attachment uses); this mutation:
 *
 *   1. gates on ownership (same rule as markDone),
 *   2. stamps the photo + completed state onto the task row (durable evidence
 *      for the portrait / ScholarFeed),
 *   3. inserts the return turn as EXACTLY ONE `role:"user"` chat message
 *      carrying the same storage id in `imageId`.
 *
 * That last step is the whole trick: `imageId` on a `role:"user"` message IS the
 * existing vision path — `convex/http.ts` (`/project-stream`) fetches it and
 * feeds it to the model as base64 vision input. So the tutor reasons from the
 * actual artifact on its NEXT turn with zero streaming changes. We intentionally
 * do NOT create an assistant placeholder / kick a stream here (markDone-style: a
 * return flips the card to ✓, the report-back turn is what the scholar sends
 * next) — hence exactly one inserted message.
 */
const PHOTO_RETURN_STUB = "I'm back! Here's what I found.";

export const attachPhoto = authedMutation({
  args: {
    id: v.id("physicalTasks"),
    photoStorageId: v.id("_storage"),
  },
  handler: async (ctx, args) => {
    const task = await ctx.db.get(args.id);
    if (!task) throw new Error("Physical task not found");
    // Owner or teacher/admin only (same gate as markDone).
    const isTeacher = requireTeacherOrSelf(ctx.user, task.scholarId);
    if (isTeacher) await requireActiveScholarAccess(ctx, ctx.user, task.scholarId);

    // 1 + 2: stamp the evidence + completed state onto the task row.
    await ctx.db.patch(args.id, {
      status: "completed",
      completedAt: task.completedAt ?? Date.now(),
      photoStorageId: args.photoStorageId,
    });

    // 3: land the return turn as a single user image message on the existing
    // vision path. Snapshot the dimension refs the same way sessions.sendMessage
    // does so the message is indistinguishable from a normal scholar upload.
    const session = await ctx.db.get(task.sessionId);
    const unit = session?.unitId ? await ctx.db.get(session.unitId) : null;
    await ctx.db.insert("messages", {
      sessionId: task.sessionId,
      role: "user",
      content: PHOTO_RETURN_STUB,
      unitId: session?.unitId ? String(session.unitId) : undefined,
      perspectiveId: unit?.perspectiveId ? String(unit.perspectiveId) : undefined,
      processId: unit?.processId ? String(unit.processId) : undefined,
      flagged: false,
      imageId: args.photoStorageId,
    });

    // Keep the teacher dashboard's denormalized last-message fields fresh.
    if (session) {
      await ctx.db.patch(task.sessionId, {
        lastMessageAt: Date.now(),
        lastMessageRole: "user",
        lastMessagePreview: PHOTO_RETURN_STUB.slice(0, 120),
      });
    }
  },
});
