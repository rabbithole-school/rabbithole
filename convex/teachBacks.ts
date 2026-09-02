/**
 * Teach-the-Tutor — "explain it back" viva mode — the Convex wiring.
 *
 * The tutor's start_teach_back / finish_teach_back tools call the INTERNAL
 * mutations here from the /project-stream handler (which has already authed the
 * caller + verified session access). A teach-back row records that the scholar
 * TAUGHT a concept to the tutor; a scheduled grading action
 * (teachBackGrading.gradeTeachBack) later scores the explanation and writes the
 * TEACHER-ONLY rubric onto the row.
 *
 * Access: the `rubric` is teacher-facing analysis (same contract as observer
 * scores / tune-ups) — it is read ONLY through the teacherQuery below, so a
 * scholar or parent can never fetch it. The pure logic (gate, tool specs, prompt
 * section, grading prompt, rubric validation) lives in lib/teachBack.ts.
 */

import { v } from "convex/values";
import { internalMutation, internalQuery } from "./_generated/server";
import { internal } from "./_generated/api";
import { teacherQuery, teacherMutation } from "./lib/customFunctions";
import { requireActiveScholarAccess } from "./lib/access";
import type { Doc } from "./_generated/dataModel";

// ── Internal writes (called by the tutor tools + grading action) ─────────────

/**
 * Open a teach-back: the scholar is about to teach `conceptLabel` to the tutor.
 *
 * INVARIANT: at most ONE active teach-back per session. If an active row already
 * exists (an accidental double-start, or an earlier teach-back the scholar never
 * finished), we REUSE the newest — repointing it at the new concept + opening
 * message — and delete any other stray active rows. That guarantees `finish`
 * resolves deterministically and no orphan lingers forever as "grading in
 * progress." `startedAtMessageId` is the assistant bubble live when the mode
 * opened, so the grader can pull the explanation transcript from there forward.
 */
export const start = internalMutation({
  args: {
    sessionId: v.id("sessions"),
    scholarId: v.id("users"),
    conceptLabel: v.string(),
    nodeKey: v.optional(v.string()),
    startedAtMessageId: v.optional(v.id("messages")),
  },
  handler: async (ctx, args) => {
    const fields = {
      conceptLabel: args.conceptLabel.trim(),
      nodeKey: args.nodeKey?.trim() || undefined,
      startedAtMessageId: args.startedAtMessageId,
      createdAt: Date.now(),
    };

    // Enforce one active teach-back per session. Reuse the newest active row;
    // delete any older stray active rows (defensive cleanup of pre-existing dups).
    const existingActive = (
      await ctx.db
        .query("teachBacks")
        .withIndex("by_session", (q) => q.eq("sessionId", args.sessionId))
        .collect()
    )
      .filter((t) => t.status === "active")
      .sort((a, b) => b.createdAt - a.createdAt);

    if (existingActive.length > 0) {
      const [keep, ...stray] = existingActive;
      for (const s of stray) await ctx.db.delete(s._id);
      await ctx.db.patch(keep._id, { ...fields, status: "active" });
      return keep._id;
    }

    return await ctx.db.insert("teachBacks", {
      sessionId: args.sessionId,
      scholarId: args.scholarId,
      status: "active",
      ...fields,
    });
  },
});

/**
 * Close a teach-back and schedule grading. Resolves the target: an explicit id,
 * else the session's active teach-back (there is at most one — `start` enforces
 * the invariant — so resolution is deterministic; we still take the newest
 * defensively). Leaves status `active` — the async grader owns the
 * active→graded transition so a grading FAILURE simply leaves the record
 * re-gradeable (never a false "graded" with no rubric). Returns whether a
 * teach-back was found to finish.
 */
export const finish = internalMutation({
  args: {
    sessionId: v.id("sessions"),
    teachBackId: v.optional(v.id("teachBacks")),
  },
  handler: async (ctx, args) => {
    let target: Doc<"teachBacks"> | null = null;
    if (args.teachBackId) {
      const tb = await ctx.db.get(args.teachBackId);
      if (tb && tb.sessionId === args.sessionId && tb.status === "active") {
        target = tb;
      }
    } else {
      const active = await ctx.db
        .query("teachBacks")
        .withIndex("by_session", (q) => q.eq("sessionId", args.sessionId))
        .collect();
      target =
        active
          .filter((t) => t.status === "active")
          .sort((a, b) => b.createdAt - a.createdAt)[0] ?? null;
    }
    if (!target) return { ok: false as const };

    await ctx.scheduler.runAfter(0, internal.teachBackGrading.gradeTeachBack, {
      teachBackId: target._id,
    });
    return { ok: true as const, teachBackId: target._id };
  },
});

/**
 * Write the graded rubric onto a teach-back (active→graded). Idempotent: a
 * no-op if the row is already graded or gone. Called ONLY by the grading action
 * on a successful, validated rubric.
 */
export const recordGrade = internalMutation({
  args: {
    teachBackId: v.id("teachBacks"),
    rubric: v.object({
      completeness: v.number(),
      causalChain: v.number(),
      example: v.number(),
      handledProbes: v.number(),
      summary: v.string(),
    }),
  },
  handler: async (ctx, args) => {
    const tb = await ctx.db.get(args.teachBackId);
    if (!tb || tb.status === "graded") return;
    await ctx.db.patch(args.teachBackId, {
      status: "graded",
      rubric: args.rubric,
      gradedAt: Date.now(),
    });
  },
});

// ── Grading read (used by the grading action) ────────────────────────────────

/**
 * Everything the grader needs for one teach-back: the row's status + concept and
 * the rendered transcript of the explanation (messages from startedAtMessageId
 * forward — falling back to the whole session when it's absent). Deliberately
 * NARROW — grading writes ONLY the teacher-only rubric, so this returns no
 * scholar-identifying / mastery-shaped fields (see the redaction note in
 * teachBackGrading.ts).
 */
export const getForGrading = internalQuery({
  args: { teachBackId: v.id("teachBacks") },
  handler: async (ctx, args) => {
    const tb = await ctx.db.get(args.teachBackId);
    if (!tb) return null;

    // Floor the transcript at the message the mode opened on (inclusive of what
    // came after it). Absent/deleted → grade the whole session.
    let floor = 0;
    if (tb.startedAtMessageId) {
      const startMsg = await ctx.db.get(tb.startedAtMessageId);
      if (startMsg) floor = startMsg._creationTime;
    }

    const messages = await ctx.db
      .query("messages")
      .withIndex("by_session", (q) => q.eq("sessionId", tb.sessionId))
      .collect();
    const session = await ctx.db.get(tb.sessionId);

    const lines: string[] = [];
    for (const m of messages) {
      if (m._creationTime < floor) continue;
      if (m.role !== "user" && m.role !== "assistant") continue;
      const text = m.content.trim();
      if (!text) continue;
      lines.push(`${m.role === "user" ? "Scholar" : "Tutor"}: ${text}`);
    }
    // Cap for cost — a teach-back is a short exchange; keep the tail if long.
    const transcript = lines.slice(-40).join("\n\n");

    return {
      teachBackId: tb._id,
      status: tb.status,
      conceptLabel: tb.conceptLabel,
      sessionId: tb.sessionId,
      scholarId: session?.userId ?? null,
      transcript,
    };
  },
});

// ── Teacher-facing reads/writes (rubric is TEACHER-ONLY) ─────────────────────

/**
 * All teach-backs for a session, WITH the rubric — teacher dashboard card.
 * `teacherQuery` gates out scholars/parents entirely (they can never read the
 * rubric); scoped-teacher access to this scholar is enforced too.
 */
export const listForSession = teacherQuery({
  args: { sessionId: v.id("sessions") },
  handler: async (ctx, args) => {
    const session = await ctx.db.get(args.sessionId);
    if (!session) return [];
    await requireActiveScholarAccess(ctx, ctx.user, session.userId);
    const rows = await ctx.db
      .query("teachBacks")
      .withIndex("by_session", (q) => q.eq("sessionId", args.sessionId))
      .collect();
    return rows
      .sort((a, b) => b.createdAt - a.createdAt)
      .map((t) => ({
        id: t._id,
        conceptLabel: t.conceptLabel,
        status: t.status,
        rubric: t.rubric ?? null,
        teacherReviewed: t.teacherReviewed ?? false,
        createdAt: t.createdAt,
        gradedAt: t.gradedAt ?? null,
      }));
  },
});

/** Teacher toggles the "reviewed" flag on a teach-back. */
export const setReviewed = teacherMutation({
  args: { id: v.id("teachBacks"), reviewed: v.boolean() },
  handler: async (ctx, args) => {
    const tb = await ctx.db.get(args.id);
    if (!tb) throw new Error("Teach-back not found");
    await requireActiveScholarAccess(ctx, ctx.user, tb.scholarId);
    await ctx.db.patch(args.id, { teacherReviewed: args.reviewed });
  },
});
