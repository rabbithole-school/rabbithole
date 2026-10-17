import { v } from "convex/values";
import { internalMutation } from "./_generated/server";
import { authedQuery, authedMutation, teacherQuery } from "./lib/customFunctions";
import { isTeacherRole } from "./lib/roles";
import { requireTeacherOrSelf } from "./lib/auth";
import { requireActiveScholarAccess } from "./lib/access";
import { requireCanRunOwnedAssignment } from "./lib/curriculumRun";

const observationTypeValidator = v.union(
  v.literal("praise"),
  v.literal("concern"),
  v.literal("suggestion"),
  v.literal("intervention"),
  v.literal("note"),
);

const observationWeightValidator = v.union(
  v.literal("minor"),
  v.literal("major"),
);

const observationCategoryValidator = v.union(
  v.literal("execFunction"),
  v.literal("socialEmotional"),
  v.literal("collaboration"),
  v.literal("passions"),
  v.literal("other"),
);

/**
 * List observations for a scholar.
 *
 * Each row carries its AUTHOR (`teacherId` — whoever recorded the note),
 * resolved to `authorName` + `authorImage` (both null when that user no longer
 * exists, or has no name/photo) plus `isSelf` for the caller. Staff read each
 * other's notes, so the reader is often not the author and the UI must not
 * claim otherwise. Authors are resolved once per UNIQUE id, not once per row.
 */
export const listByScholar = authedQuery({
  args: { scholarId: v.id("users") },
  handler: async (ctx, args) => {
    const isTeacher = requireTeacherOrSelf(ctx.user, args.scholarId);
    if (isTeacher) await requireActiveScholarAccess(ctx, ctx.user, args.scholarId);

    const allObservations = await ctx.db
      .query("observations")
      .withIndex("by_scholar", (q) => q.eq("scholarId", args.scholarId))
      .order("desc")
      .collect();
    // Whole Child notes were staff-only in their legacy table. Preserve that
    // boundary when they share the observations table.
    const observations = isTeacher
      ? allObservations
      : allObservations.filter((observation) => observation.category === undefined);

    const authorIds = [...new Set(observations.map((o) => o.teacherId))];
    const authors = await Promise.all(authorIds.map((id) => ctx.db.get(id)));
    const authorById = new Map(
      authors
        .filter((author) => author !== null)
        .map((author) => [
          String(author._id),
          { name: author.name?.trim() || null, image: author.image ?? null },
        ]),
    );

    return observations.map((o) => {
      const author = authorById.get(String(o.teacherId));
      return {
        ...o,
        authorName: author?.name ?? null,
        authorImage: author?.image ?? null,
        isSelf: o.teacherId === ctx.user._id,
      };
    });
  },
});

/**
 * List observations for a project.
 */
export const listBySession = teacherQuery({
  args: { sessionId: v.id("sessions") },
  handler: async (ctx, args) => {
    const session = await ctx.db.get(args.sessionId);
    if (!session) return [];
    if (session.userId !== ctx.user._id) {
      await requireActiveScholarAccess(ctx, ctx.user, session.userId);
    }
    return await ctx.db
      .query("observations")
      .withIndex("by_session", (q) =>
        q.eq("sessionId", args.sessionId)
      )
      .order("desc")
      .collect();
  },
});

/**
 * Add an observation.
 */
export const add = authedMutation({
  args: {
    scholarId: v.id("users"),
    sessionId: v.optional(v.id("sessions")),
    note: v.string(),
    type: observationTypeValidator,
    weight: v.optional(observationWeightValidator),
    category: v.optional(observationCategoryValidator),
    // curriculum:run only: the assignment (run) she owns that this scholar is
    // on — the authority for a non-teacher to log about them. Not stored.
    assignmentId: v.optional(v.id("assignments")),
  },
  handler: async (ctx, args) => {
    const isSelf = ctx.user._id === args.scholarId;
    if (!isTeacherRole(ctx.user.role) && !isSelf && args.assignmentId) {
      // A curriculum:run holder logs from her Debrief, about an assignee on a
      // run she OWNS and can still run. A named session must be that
      // scholar's real session on that same run.
      const assignment = await ctx.db.get(args.assignmentId);
      if (
        !assignment ||
        assignment.teacherId !== ctx.user._id ||
        !assignment.scholarIds.includes(args.scholarId)
      ) {
        throw new Error("Forbidden");
      }
      await requireCanRunOwnedAssignment(ctx, ctx.user, assignment);
      if (args.sessionId) {
        const session = await ctx.db.get(args.sessionId);
        if (
          !session ||
          session.isTestDrive ||
          session.userId !== args.scholarId ||
          session.assignmentId !== args.assignmentId
        ) {
          throw new Error("Forbidden");
        }
      }
    } else {
      const isTeacher = requireTeacherOrSelf(ctx.user, args.scholarId);
      if (isTeacher) await requireActiveScholarAccess(ctx, ctx.user, args.scholarId);
    }

    const id = await ctx.db.insert("observations", {
      teacherId: ctx.user._id,
      scholarId: args.scholarId,
      sessionId: args.sessionId,
      note: args.note.trim(),
      type: args.type,
      weight: args.weight,
      category: args.category,
    });
    return await ctx.db.get(id);
  },
});

/**
 * Add an operator-authored observation without a signed-in user.
 *
 * Use type "note" for neutral operational notes. `source` identifies the
 * calling process but is not persisted because observations have no source
 * field.
 */
export const addSystemNote = internalMutation({
  args: {
    username: v.string(),
    note: v.string(),
    type: observationTypeValidator,
    source: v.optional(v.string()),
    authorUsername: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const scholar = await ctx.db
      .query("users")
      .withIndex("by_username", (q) => q.eq("username", args.username))
      .unique();
    if (!scholar) throw new Error(`Scholar user not found: ${args.username}`);

    if (!args.authorUsername) {
      throw new Error(
        "authorUsername is required because observations require an author user",
      );
    }
    const author = await ctx.db
      .query("users")
      .withIndex("by_username", (q) =>
        q.eq("username", args.authorUsername),
      )
      .unique();
    if (!author) {
      throw new Error(`Observation author user not found: ${args.authorUsername}`);
    }

    const id = await ctx.db.insert("observations", {
      teacherId: author._id,
      scholarId: scholar._id,
      sessionId: undefined,
      note: args.note.trim(),
      type: args.type,
      weight: undefined,
      category: undefined,
    });
    return await ctx.db.get(id);
  },
});

/**
 * Set (or clear) the claim-strength weight on an existing observation.
 * Lets a teacher promote a note to "major" (e.g. after the bot filed it
 * minor) so it surfaces first in the evidence binder (§6/§12).
 */
export const setWeight = authedMutation({
  args: {
    observationId: v.id("observations"),
    weight: observationWeightValidator,
  },
  handler: async (ctx, args) => {
    const obs = await ctx.db.get(args.observationId);
    if (!obs) throw new Error("Observation not found");
    const isTeacher = requireTeacherOrSelf(ctx.user, obs.scholarId);
    if (isTeacher) await requireActiveScholarAccess(ctx, ctx.user, obs.scholarId);
    else throw new Error("Forbidden");
    await ctx.db.patch(args.observationId, { weight: args.weight });
    return await ctx.db.get(args.observationId);
  },
});

/**
 * Correct the type of an existing observation (e.g. a fatigue note filed
 * as "praise" that should be "concern"). Mirrors setWeight — a type-only
 * patch behind the same teacher/self gate, so a teacher (or the observer /
 * staff-aide that filed it) can fix a mis-typed note without deleting it.
 */
export const setType = authedMutation({
  args: {
    observationId: v.id("observations"),
    type: observationTypeValidator,
  },
  handler: async (ctx, args) => {
    const obs = await ctx.db.get(args.observationId);
    if (!obs) throw new Error("Observation not found");
    const isTeacher = requireTeacherOrSelf(ctx.user, obs.scholarId);
    if (isTeacher) await requireActiveScholarAccess(ctx, ctx.user, obs.scholarId);
    else throw new Error("Forbidden");
    await ctx.db.patch(args.observationId, { type: args.type });
    return await ctx.db.get(args.observationId);
  },
});

/**
 * Delete an observation.
 */
export const remove = authedMutation({
  args: { observationId: v.id("observations") },
  handler: async (ctx, args) => {
    const isTeacher = isTeacherRole(ctx.user.role);
    const obs = await ctx.db.get(args.observationId);
    if (!obs) throw new Error("Observation not found");
    if (!isTeacher) {
      if (obs.scholarId !== ctx.user._id) throw new Error("Forbidden");
    } else {
      await requireActiveScholarAccess(ctx, ctx.user, obs.scholarId);
    }
    await ctx.db.delete(args.observationId);
  },
});
