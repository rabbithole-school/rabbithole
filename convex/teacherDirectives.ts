import { v } from "convex/values";
import { internalQuery, internalMutation } from "./_generated/server";
import { authedQuery } from "./lib/customFunctions";
import { teacherMutation } from "./lib/customFunctions";
import { requireTeacherOrSelf } from "./lib/auth";
import { requireActiveScholarAccess } from "./lib/access";
import type { MutationCtx } from "./_generated/server";
import type { Id } from "./_generated/dataModel";

/**
 * Guidance — persistent pedagogical instructions the tutor AI is expected to
 * follow for a specific scholar. These live in their own table (as of Phase
 * 1.5) rather than as marker blocks inside the scholar dossier. The table name
 * (`teacherDirectives`) is unchanged; the human-facing name is "guidance".
 *
 * The dossier is for observer/tutor-authored learning notes; guidance is for
 * teacher/admin-authored "standing rules" that govern tutor behavior.
 *
 * A row may carry an `expiresAt`. Absent means STANDING — which is what every
 * row written before that field existed means — so nothing needed migrating.
 * The four verbs the weekly meeting needs (keep another week, make it standing,
 * end now, bring it back) are all `setExpiry` below.
 */

/**
 * Return active directives for a scholar, oldest-first (by _creationTime).
 * Used by buildSystemPrompt when rendering the DIRECTIVES section.
 */
export const listActiveByScholarInternal = internalQuery({
  args: { scholarId: v.id("users") },
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query("teacherDirectives")
      .withIndex("by_scholar_active", (q) =>
        q.eq("scholarId", args.scholarId).eq("isActive", true)
      )
      .collect();
    rows.sort((a, b) => a._creationTime - b._creationTime);
    return rows;
  },
});

/**
 * List directives for UI. Teachers/admins see all directives (active +
 * inactive). Scholars can see their own active ones only.
 */
export const listByScholar = authedQuery({
  args: { scholarId: v.id("users") },
  handler: async (ctx, args) => {
    const isTeacher = requireTeacherOrSelf(ctx.user, args.scholarId);
    if (isTeacher) await requireActiveScholarAccess(ctx, ctx.user, args.scholarId);

    const rows = await ctx.db
      .query("teacherDirectives")
      .withIndex("by_scholar", (q) => q.eq("scholarId", args.scholarId))
      .collect();
    rows.sort((a, b) => a._creationTime - b._creationTime);

    if (!isTeacher) {
      return rows.filter((r) => r.isActive);
    }
    return rows;
  },
});

/**
 * Shared upsert-by-label logic. Case-insensitive label match. If one exists,
 * patch content + authorId + updatedAt. Otherwise insert a new active row.
 *
 * `expiresAt` and `sourceMeetingId` use `undefined` as "leave unchanged" on an
 * update, so writing the same label from the weekly meeting refreshes the words
 * without silently re-dating a piece of standing guidance. Pass `null` to make
 * an existing row standing explicitly.
 */
async function upsertByLabelHelper(
  ctx: MutationCtx,
  args: {
    scholarId: Id<"users">;
    label: string;
    content: string;
    authorId: Id<"users">;
    expiresAt?: number | null;
    sourceMeetingId?: Id<"scholarReviewMeetings">;
  }
) {
  const label = args.label.trim();
  if (!label) throw new Error("label must be a non-empty string");
  const content = args.content.trim();

  const existing = await ctx.db
    .query("teacherDirectives")
    .withIndex("by_scholar", (q) => q.eq("scholarId", args.scholarId))
    .collect();

  const labelLower = label.toLowerCase();
  const match = existing.find((r) => r.label.toLowerCase() === labelLower);

  const now = Date.now();

  if (match) {
    await ctx.db.patch(match._id, {
      content,
      authorId: args.authorId,
      updatedAt: now,
      // Preserve label casing of the existing row; don't reformat.
      ...(args.expiresAt === undefined
        ? {}
        : { expiresAt: args.expiresAt ?? undefined }),
      ...(args.sourceMeetingId === undefined
        ? {}
        : { sourceMeetingId: args.sourceMeetingId }),
    });
    return { action: "updated" as const, id: match._id, label: match.label };
  }

  const id = await ctx.db.insert("teacherDirectives", {
    scholarId: args.scholarId,
    label,
    content,
    authorId: args.authorId,
    isActive: true,
    updatedAt: now,
    expiresAt: args.expiresAt ?? undefined,
    sourceMeetingId: args.sourceMeetingId,
  });
  return { action: "created" as const, id, label };
}

/**
 * Upsert a directive by (scholarId, label). Called by AI tools (teacherAide).
 * Accepts authorId explicitly because the AI tool infers the author from the
 * teacher context, not from the Convex auth user (it's an internal invocation).
 */
export const upsertByLabel = internalMutation({
  args: {
    scholarId: v.id("users"),
    label: v.string(),
    content: v.string(),
    authorId: v.id("users"),
  },
  handler: async (ctx, args) => {
    return await upsertByLabelHelper(ctx, args);
  },
});

/**
 * Upsert guidance by (scholarId, label). UI-callable. authorId is inferred from
 * the authenticated teacher via the teacherMutation wrapper.
 *
 * `expiresAt`/`sourceMeetingId` are how the weekly meeting writes guidance
 * without stacking a duplicate every week: the same label updates in place, and
 * the meeting stamps itself as the source. Omitting `expiresAt` leaves an
 * existing row's expiry alone; passing `null` makes it standing.
 */
export const upsertByTeacher = teacherMutation({
  args: {
    scholarId: v.id("users"),
    label: v.string(),
    content: v.string(),
    expiresAt: v.optional(v.union(v.number(), v.null())),
    sourceMeetingId: v.optional(v.id("scholarReviewMeetings")),
  },
  handler: async (ctx, args) => {
    await requireActiveScholarAccess(ctx, ctx.user, args.scholarId);
    if (args.sourceMeetingId) {
      await requireMeetingForScholar(ctx, args.sourceMeetingId, args.scholarId);
    }
    return await upsertByLabelHelper(ctx, {
      scholarId: args.scholarId,
      label: args.label,
      content: args.content,
      authorId: ctx.user._id,
      expiresAt: args.expiresAt,
      sourceMeetingId: args.sourceMeetingId,
    });
  },
});

/**
 * Prove a meeting id may be stamped onto this scholar's guidance: same
 * institution, and the scholar really is on that meeting's agenda. Without this
 * the client could attribute guidance to another school's meeting.
 */
async function requireMeetingForScholar(
  ctx: MutationCtx,
  meetingId: Id<"scholarReviewMeetings">,
  scholarId: Id<"users">,
) {
  const meeting = await ctx.db.get(meetingId);
  if (!meeting) throw new Error("Rounds meeting not found");
  const entry = await ctx.db
    .query("scholarReviewEntries")
    .withIndex("by_meeting_scholar", (q) =>
      q.eq("meetingId", meetingId).eq("scholarId", scholarId),
    )
    .first();
  if (!entry) {
    throw new Error("That scholar is not on this Rounds agenda");
  }
  return meeting;
}

/**
 * Set or clear when a piece of guidance stops being injected into the tutor
 * prompt. This one mutation is all four verbs the weekly meeting needs:
 *
 *  - keep another week   → `expiresAt` a week out
 *  - make it standing    → `expiresAt: null`
 *  - end now             → `expiresAt` now (or in the past)
 *  - bring it back       → `expiresAt` in the future on a lapsed row
 *
 * "Bring it back" also reactivates a row that was switched off, because the
 * teacher has just said this is what the tutor should be doing; leaving
 * `isActive: false` would make the verb a silent no-op.
 */
export const setExpiry = teacherMutation({
  args: {
    id: v.id("teacherDirectives"),
    /** null == standing. */
    expiresAt: v.union(v.number(), v.null()),
    sourceMeetingId: v.optional(v.id("scholarReviewMeetings")),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db.get(args.id);
    if (!existing) throw new Error("Guidance not found");
    await requireActiveScholarAccess(ctx, ctx.user, existing.scholarId);
    if (args.sourceMeetingId) {
      await requireMeetingForScholar(ctx, args.sourceMeetingId, existing.scholarId);
    }
    const now = Date.now();
    const reviving = args.expiresAt === null || args.expiresAt > now;
    await ctx.db.patch(args.id, {
      expiresAt: args.expiresAt ?? undefined,
      updatedAt: now,
      ...(reviving && !existing.isActive ? { isActive: true } : {}),
      ...(args.sourceMeetingId ? { sourceMeetingId: args.sourceMeetingId } : {}),
    });
    return await ctx.db.get(args.id);
  },
});

/**
 * Activate or deactivate guidance. Teacher-only.
 */
export const setActive = teacherMutation({
  args: {
    id: v.id("teacherDirectives"),
    isActive: v.boolean(),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db.get(args.id);
    if (!existing) throw new Error("Directive not found");
    await requireActiveScholarAccess(ctx, ctx.user, existing.scholarId);
    await ctx.db.patch(args.id, {
      isActive: args.isActive,
      updatedAt: Date.now(),
    });
  },
});

/**
 * Hard-delete a directive. Teacher-only.
 */
export const remove = teacherMutation({
  args: { id: v.id("teacherDirectives") },
  handler: async (ctx, args) => {
    const existing = await ctx.db.get(args.id);
    if (!existing) return;
    await requireActiveScholarAccess(ctx, ctx.user, existing.scholarId);
    await ctx.db.delete(args.id);
  },
});
