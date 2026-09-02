// AUTH GATING:
// - All `*Public` queries (e.g. `listByUnitPublic`, `getPublic`) are
//   scholar-safe (`authedQuery`). Use these from any scholar surface.
// - Everything else (`listByUnit`, `get`, `create`, `update`,
//   `remove`, `reorder`) goes through `requireUnitEditAccess` — the
//   gate passes for curriculum users (teacher/admin/curriculum_designer)
//   AND for scholars who authored the unit themselves (IS Units).

import { v } from "convex/values";
import { authedMutation, authedQuery } from "./lib/customFunctions";
import { internalMutation, internalQuery, type MutationCtx } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import { requireUnitEditAccess } from "./lib/auth";
import { requireUnitAccess } from "./lib/unitAccess";
import { activityHasScholarWork, deleteActivityCascade } from "./lib/activityCascade";
import {
  duplicateActivitiesIntoLesson,
  duplicateLessonDesign,
  remapCopiedActivityReferences,
} from "./lib/curriculumDuplication";

/** Lean query accessible to all authenticated users (scholars need this for UnitPickerDialog). */
export const listByUnitPublic = authedQuery({
  args: { unitId: v.id("units") },
  handler: async (ctx, args) => {
    const lessons = await ctx.db
      .query("lessons")
      .withIndex("by_unit", (q) => q.eq("unitId", args.unitId))
      .collect();

    return Promise.all(
      lessons.sort((a, b) => a.order - b.order).map(async (l) => {
        const process = l.processId ? await ctx.db.get(l.processId) : null;
        return {
          _id: l._id,
          title: l.title,
          strand: l.strand ?? null,
          order: l.order,
          processTitle: process?.title ?? null,
          processEmoji: process?.emoji ?? null,
          durationMinutes: l.durationMinutes ?? null,
        };
      })
    );
  },
});

export const listByUnit = authedQuery({
  args: { unitId: v.id("units") },
  handler: async (ctx, args) => {
    // Tolerate a stale unitId — return empty rather than throwing.
    const unit = await ctx.db.get(args.unitId);
    if (!unit) return [];
    await requireUnitEditAccess(ctx, { unitId: args.unitId });
    const lessons = await ctx.db
      .query("lessons")
      .withIndex("by_unit", (q) => q.eq("unitId", args.unitId))
      .collect();

    // Resolve process names
    return Promise.all(
      lessons
        .sort((a, b) => a.order - b.order)
        .map(async (l) => {
          const process = l.processId ? await ctx.db.get(l.processId) : null;
          return {
            ...l,
            processTitle: process?.title ?? null,
            processEmoji: process?.emoji ?? null,
          };
        })
    );
  },
});

export const get = authedQuery({
  args: { id: v.id("lessons") },
  handler: async (ctx, args) => {
    // Read-then-gate so a stale URL param pointing at a just-deleted
    // lesson returns null cleanly instead of throwing.
    const lesson = await ctx.db.get(args.id);
    if (!lesson) return null;
    await requireUnitAccess(ctx, lesson.unitId);
    return lesson;
  },
});

/** Lean public lesson fetch — scholars need this for the progress navigator. */
export const getPublic = authedQuery({
  args: { id: v.id("lessons") },
  handler: async (ctx, args) => {
    const lesson = await ctx.db.get(args.id);
    if (!lesson) return null;
    return {
      _id: lesson._id,
      unitId: lesson.unitId,
      title: lesson.title,
      strand: lesson.strand ?? null,
      durationMinutes: lesson.durationMinutes ?? null,
      selectionMode: lesson.selectionMode ?? null,
      choicePickCount: lesson.choicePickCount ?? null,
    };
  },
});

export const create = authedMutation({
  args: {
    unitId: v.id("units"),
    title: v.string(),
    strand: v.optional(v.union(
      v.literal("core"), v.literal("connections"),
      v.literal("practice"), v.literal("identity")
    )),
    systemPrompt: v.optional(v.string()),
    processId: v.optional(v.id("processes")),
    durationMinutes: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    await requireUnitEditAccess(ctx, { unitId: args.unitId });
    // Get next order number for this unit
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

export const duplicate = authedMutation({
  args: { lessonId: v.id("lessons") },
  handler: async (ctx, args) => {
    const source = await ctx.db.get(args.lessonId);
    if (!source) throw new Error("Lesson not found");
    await requireUnitEditAccess(ctx, { lessonId: args.lessonId });

    const siblings = await ctx.db
      .query("lessons")
      .withIndex("by_unit", (q) => q.eq("unitId", source.unitId))
      .collect();
    for (const sibling of siblings) {
      if (sibling._id !== source._id && sibling.order > source.order) {
        await ctx.db.patch(sibling._id, { order: sibling.order + 1 });
      }
    }

    const copyId = await ctx.db.insert(
      "lessons",
      duplicateLessonDesign(
        source,
        source.unitId,
        source.order + 1,
        `${source.title} (copy)`,
      ),
    );
    const activityIdMap = new Map<string, Id<"activities">>();
    const copiedActivities = await duplicateActivitiesIntoLesson(
      ctx,
      source._id,
      copyId,
      activityIdMap,
    );
    await remapCopiedActivityReferences(
      ctx,
      copiedActivities,
      activityIdMap,
    );
    return copyId;
  },
});

export const update = authedMutation({
  args: {
    id: v.id("lessons"),
    title: v.optional(v.string()),
    strand: v.optional(v.union(
      v.literal("core"), v.literal("connections"),
      v.literal("practice"), v.literal("identity"),
      v.null()
    )),
    systemPrompt: v.optional(v.union(v.string(), v.null())),
    processId: v.optional(v.union(v.id("processes"), v.null())),
    durationMinutes: v.optional(v.union(v.number(), v.null())),
    selectionMode: v.optional(
      v.union(v.literal("sequence"), v.literal("choice"), v.null()),
    ),
    choicePickCount: v.optional(v.union(v.number(), v.null())),
  },
  handler: async (ctx, args) => {
    await requireUnitEditAccess(ctx, { lessonId: args.id });
    const { id, ...updates } = args;
    const cleaned: Record<string, unknown> = {};
    if (updates.title !== undefined) cleaned.title = updates.title.trim();
    if (updates.strand !== undefined) cleaned.strand = updates.strand ?? undefined;
    if (updates.systemPrompt !== undefined)
      cleaned.systemPrompt = updates.systemPrompt?.trim() || undefined;
    if (updates.processId !== undefined)
      cleaned.processId = updates.processId ?? undefined;
    if (updates.durationMinutes !== undefined)
      cleaned.durationMinutes = updates.durationMinutes ?? undefined;
    if (updates.selectionMode !== undefined)
      cleaned.selectionMode = updates.selectionMode ?? undefined;
    if (updates.choicePickCount !== undefined)
      cleaned.choicePickCount =
        updates.choicePickCount == null
          ? undefined
          : Math.max(1, Math.round(updates.choicePickCount));

    await ctx.db.patch(id, cleaned);
  },
});


export const remove = authedMutation({
  args: { id: v.id("lessons") },
  handler: async (ctx, args) => {
    await requireUnitEditAccess(ctx, { lessonId: args.id });
    // Cascade: drop all activities under this lesson. Scholar work on ANY
    // child activity blocks the whole delete (the mutation is transactional,
    // so a mid-loop throw would roll back anyway — the pre-check just gives a
    // lesson-level message).
    const acts = await ctx.db
      .query("activities")
      .withIndex("by_lesson", (q) => q.eq("lessonId", args.id))
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
    await ctx.db.delete(args.id);
  },
});

export const reorder = authedMutation({
  args: {
    lessonIds: v.array(v.id("lessons")),
    /**
     * Optional strand reassignments — used by cross-strand drags in the
     * unit outline. Each entry patches the lesson's `strand` before the
     * order pass runs.
     */
    strandUpdates: v.optional(
      v.array(
        v.object({
          id: v.id("lessons"),
          strand: v.union(
            v.literal("core"),
            v.literal("connections"),
            v.literal("practice"),
            v.literal("identity"),
          ),
        }),
      ),
    ),
  },
  handler: async (ctx, args) => {
    if (args.lessonIds.length === 0) return;

    // Fetch every lesson in the request and validate up front. The reorder
    // touches `order` (and optionally `strand`) on each, so we want to fail
    // fast on a partial / cross-unit / unknown-id payload before any patch
    // lands.
    const lessons = await Promise.all(
      args.lessonIds.map((id) => ctx.db.get(id)),
    );
    const unitIds = new Set<string>();
    lessons.forEach((l, i) => {
      if (!l) {
        throw new Error(
          `lessons.reorder: lesson ${args.lessonIds[i]} not found`,
        );
      }
      unitIds.add(String(l.unitId));
    });
    if (unitIds.size !== 1) {
      throw new Error(
        "lessons.reorder: all lessonIds must belong to the same unit",
      );
    }
    const unitId = lessons[0]!.unitId;
    await requireUnitEditAccess(ctx, { unitId });

    // Strand updates must reference lessons in the same payload — otherwise
    // we'd be patching a lesson the caller may not have asked to reorder.
    if (args.strandUpdates) {
      const idSet = new Set(args.lessonIds.map(String));
      for (const u of args.strandUpdates) {
        if (!idSet.has(String(u.id))) {
          throw new Error(
            "lessons.reorder: strandUpdates contains an id not in lessonIds",
          );
        }
      }
    }

    // Require a complete cover — `lessonIds` should list every lesson in
    // the unit. The client always rebuilds the full layout; a partial list
    // would silently leave other lessons with stale `order` values.
    const allInUnit = await ctx.db
      .query("lessons")
      .withIndex("by_unit", (q) => q.eq("unitId", unitId))
      .collect();
    if (allInUnit.length !== args.lessonIds.length) {
      throw new Error(
        `lessons.reorder: expected ${allInUnit.length} lessonIds for unit, got ${args.lessonIds.length}`,
      );
    }

    if (args.strandUpdates) {
      for (const u of args.strandUpdates) {
        await ctx.db.patch(u.id, { strand: u.strand });
      }
    }
    for (let i = 0; i < args.lessonIds.length; i++) {
      await ctx.db.patch(args.lessonIds[i], { order: i });
    }
  },
});

/**
 * Shared DB logic for moving a lesson (and, implicitly, its activities —
 * they only reference `lessonId`, never `unitId`, so they follow for free)
 * to a different unit. No auth checks here — callers are responsible for
 * gating (the public `moveToUnit` mutation via `requireUnitEditAccess`; the
 * `teacherAide.moveLesson` internal mutation via the aide tool's role ACL).
 *
 * Appends the lesson to the end of the target unit's lesson order. A
 * same-unit "move" is a safe no-op (returns `moved: false` instead of
 * bumping `order`, so re-running it is idempotent).
 */
export async function moveLessonToUnitCore(
  ctx: MutationCtx,
  args: { id: Id<"lessons">; targetUnitId: Id<"units"> },
) {
  const lesson = await ctx.db.get(args.id);
  if (!lesson) throw new Error("Lesson not found");

  if (lesson.unitId === args.targetUnitId) {
    return {
      movedLessonId: args.id,
      lessonTitle: lesson.title,
      fromUnitId: lesson.unitId,
      toUnitId: args.targetUnitId,
      moved: false as const,
    };
  }

  const existingInTarget = await ctx.db
    .query("lessons")
    .withIndex("by_unit", (q) => q.eq("unitId", args.targetUnitId))
    .collect();
  const maxOrder = existingInTarget.reduce((max, l) => Math.max(max, l.order), -1);

  const fromUnitId = lesson.unitId;
  await ctx.db.patch(args.id, { unitId: args.targetUnitId, order: maxOrder + 1 });

  return {
    movedLessonId: args.id,
    lessonTitle: lesson.title,
    fromUnitId,
    toUnitId: args.targetUnitId,
    moved: true as const,
  };
}

/**
 * Move a lesson (with its activities) to a different unit. Requires edit
 * access on BOTH the source unit (via the lesson) and the destination unit —
 * a scholar's IS-authored unit can't be used to pull in or donate lessons
 * to/from a unit they don't control.
 */
export const moveToUnit = authedMutation({
  args: {
    id: v.id("lessons"),
    targetUnitId: v.id("units"),
  },
  handler: async (ctx, args) => {
    await requireUnitEditAccess(ctx, { lessonId: args.id });
    await requireUnitEditAccess(ctx, { unitId: args.targetUnitId });
    return await moveLessonToUnitCore(ctx, args);
  },
});

/**
 * Internal: lesson-create variant invoked by the scholar IS planning
 * tutor (called from convex/http.ts /project-stream tool runner).
 * Verifies the scholar is the unit's IS author before writing —
 * defense in depth even though the http action only exposes this
 * when project.unitContext.isOwnIsUnit is true.
 */
export const aiCreateForIsUnit = internalMutation({
  args: {
    unitId: v.id("units"),
    scholarId: v.id("users"),
    title: v.string(),
    strand: v.optional(v.union(
      v.literal("core"), v.literal("connections"),
      v.literal("practice"), v.literal("identity")
    )),
  },
  handler: async (ctx, args) => {
    const unit = await ctx.db.get(args.unitId);
    if (!unit) throw new Error("Unit not found");
    if (unit.authorScholarId !== args.scholarId) {
      throw new Error("Forbidden: not your IS unit");
    }
    const existing = await ctx.db
      .query("lessons")
      .withIndex("by_unit", (q) => q.eq("unitId", args.unitId))
      .collect();
    const maxOrder = existing.reduce((m, l) => Math.max(m, l.order), -1);
    return await ctx.db.insert("lessons", {
      unitId: args.unitId,
      title: args.title.trim() || "New lesson",
      strand: args.strand,
      order: maxOrder + 1,
    });
  },
});

// Internal query for use in HTTP actions
export const listByUnitInternal = internalQuery({
  args: { unitId: v.id("units") },
  handler: async (ctx, args) => {
    const lessons = await ctx.db
      .query("lessons")
      .withIndex("by_unit", (q) => q.eq("unitId", args.unitId))
      .collect();

    return Promise.all(
      lessons
        .sort((a, b) => a.order - b.order)
        .map(async (l) => {
          const process = l.processId ? await ctx.db.get(l.processId) : null;
          return {
            ...l,
            processTitle: process?.title ?? null,
            processEmoji: process?.emoji ?? null,
          };
        })
    );
  },
});

// Note: one-off scholar IS work used to live on lessons via
// lesson.scholarId. Post-refactor (Apr 2026) it lives on
// activities.scholarId; see activities.createForScholar and friends.
