import { v } from "convex/values";
import {
  curriculumMutation,
  curriculumQuery,
  teacherMutation,
  teacherQuery,
} from "./lib/customFunctions";
import {
  internalQuery,
  internalMutation,
  type QueryCtx,
} from "./_generated/server";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";

// ─────────────────────────────────────────────────────────────────────
// Share Back activity — backend.
//
// A Share Back is its own top-level activity kind (kind="shareBack"),
// with a `shareBackRecipe` (reflection / galleryWalk / exitTicket /
// debateDebrief / custom), a `sourceActivityIds` array pointing at
// earlier ONLINE activities, and an optional `facilitationFocus`
// free-text steer for the AI digest.
//
// This file owns: source wiring (setSources), the collation read
// (collateSources — input to the AI action), the source picker query,
// and the digest read/write surface. The AI generation action itself
// lives in shareBackActions.ts ("use node").
//
// See review/shareback-offline-activity.md.
// ─────────────────────────────────────────────────────────────────────

/**
 * Set the source activities a Share Back collates from.
 * Curriculum-gated. Activity must be kind="shareBack" — flipping kind
 * happens via the regular activity update path.
 */
export const setSources = curriculumMutation({
  args: {
    activityId: v.id("activities"),
    sourceActivityIds: v.array(v.id("activities")),
  },
  handler: async (ctx, args) => {
    const activity = await ctx.db.get(args.activityId);
    if (!activity) throw new Error("Activity not found");
    if (activity.kind !== "shareBack") {
      throw new Error("Sources can only be set on a Share Back activity");
    }
    // A Share Back may not reference itself.
    const sources = args.sourceActivityIds.filter(
      (id) => id !== args.activityId,
    );
    await ctx.db.patch(args.activityId, {
      sourceActivityIds: sources,
    });
  },
});

/**
 * Set the Share Back recipe (reflection / galleryWalk / etc).
 * Defaults to "reflection" — the editor calls this when the teacher
 * flips an activity to kind="shareBack" without one set.
 */
export const setRecipe = curriculumMutation({
  args: {
    activityId: v.id("activities"),
    recipe: v.union(
      v.literal("reflection"),
      v.literal("galleryWalk"),
      v.literal("exitTicket"),
      v.literal("debateDebrief"),
      v.literal("custom"),
    ),
  },
  handler: async (ctx, args) => {
    const activity = await ctx.db.get(args.activityId);
    if (!activity) throw new Error("Activity not found");
    if (activity.kind !== "shareBack") {
      throw new Error("Recipe only applies to a Share Back activity");
    }
    await ctx.db.patch(args.activityId, { shareBackRecipe: args.recipe });
  },
});

/**
 * Set the facilitation focus — the teacher's free-text steer for the
 * AI digest ("focus on word choice", "find pieces that took emotional
 * risks", etc.). This is what shows up where Description usually does
 * on Share Back activities. Empty string clears it.
 */
export const setFacilitationFocus = curriculumMutation({
  args: {
    activityId: v.id("activities"),
    facilitationFocus: v.string(),
  },
  handler: async (ctx, args) => {
    const activity = await ctx.db.get(args.activityId);
    if (!activity) throw new Error("Activity not found");
    if (activity.kind !== "shareBack") {
      throw new Error("Facilitation focus only applies to a Share Back");
    }
    const trimmed = args.facilitationFocus.trim();
    await ctx.db.patch(args.activityId, {
      facilitationFocus: trimmed.length > 0 ? trimmed : undefined,
    });
  },
});

/**
 * Source picker: activities the teacher can pick as Share Back sources.
 * Returns same-unit activities first (the common "share back this unit's
 * homework" case), then other units. Excludes the Share Back activity
 * itself and other Share Backs. Includes BOTH online activities (digital
 * deliverables) and offline activities (scanned work materialized into
 * deliverables — see portfolioMaterialize.ts). Each row carries a
 * deliverable count so the picker can show "(3 submitted)".
 */
export const listSourceCandidates = curriculumQuery({
  args: { shareBackActivityId: v.id("activities") },
  handler: async (ctx, args) => {
    const self = await ctx.db.get(args.shareBackActivityId);
    const selfLessonId = self?.lessonId ?? null;
    const selfUnitId = selfLessonId
      ? (await ctx.db.get(selfLessonId))?.unitId ?? null
      : null;

    // Walk all units → lessons → activities. The activity set is small
    // enough (hundreds) that a full scan is fine; if this grows, add a
    // by_kind index.
    const units = await ctx.db.query("units").collect();
    const rows: Array<{
      _id: Id<"activities">;
      title: string;
      kind: "online" | "offline";
      unitId: Id<"units">;
      unitTitle: string;
      unitEmoji: string | null;
      lessonTitle: string;
      sameUnit: boolean;
      deliverableCount: number;
      hasScholarAngles: boolean;
    }> = [];

    for (const unit of units) {
      const lessons = await ctx.db
        .query("lessons")
        .withIndex("by_unit", (q) => q.eq("unitId", unit._id))
        .collect();
      for (const lesson of lessons) {
        const acts = await ctx.db
          .query("activities")
          .withIndex("by_lesson", (q) => q.eq("lessonId", lesson._id))
          .collect();
        for (const a of acts) {
          // Share Backs can't source other Share Backs (incl. themselves).
          // Web activities have no transcripts/deliverables to digest, and
          // problem sets are adaptive practice (no deliverable to share back).
          if (
            a.kind === "shareBack" ||
            a.kind === "web" ||
            a.kind === "problem_set" ||
            // A game's evidence lives in its digest, not a deliverable, so it
            // is not a share-back source. A simulator's exhibition path is its own
            // gallery submission (plan §8), not this digest. A vibecode app is
            // its own artifact, likewise not a share-back deliverable.
            a.kind === "game" ||
            a.kind === "simulator" ||
            a.kind === "vibecode"
          )
            continue;
          const deliverables = await ctx.db
            .query("deliverables")
            .withIndex("by_activity", (q) => q.eq("activityId", a._id))
            .collect();
          rows.push({
            _id: a._id,
            title: a.title,
            kind: a.kind,
            unitId: unit._id,
            unitTitle: unit.title,
            unitEmoji: unit.emoji ?? null,
            lessonTitle: lesson.title,
            sameUnit: !!selfUnitId && unit._id === selfUnitId,
            deliverableCount: deliverables.length,
            hasScholarAngles: a.hasScholarAngles ?? false,
          });
        }
      }
    }

    // Same-unit first, then by deliverable count desc (most-submitted
    // activities are the likeliest share-back targets), then title.
    rows.sort(
      (x, y) =>
        Number(y.sameUnit) - Number(x.sameUnit) ||
        y.deliverableCount - x.deliverableCount ||
        x.title.localeCompare(y.title),
    );
    return rows;
  },
});

/**
 * Lightweight read of a Share Back activity's currently-wired sources,
 * with title + deliverable count per source. Backs the editor chips.
 */
export const getSources = curriculumQuery({
  args: { activityId: v.id("activities") },
  handler: async (ctx, args) => {
    const activity = await ctx.db.get(args.activityId);
    const ids = activity?.sourceActivityIds ?? [];
    return Promise.all(
      ids.map(async (id) => {
        const a = await ctx.db.get(id);
        const deliverables = a
          ? await ctx.db
              .query("deliverables")
              .withIndex("by_activity", (q) => q.eq("activityId", id))
              .collect()
          : [];
        return {
          _id: id,
          title: a?.title ?? "(deleted activity)",
          exists: !!a,
          deliverableCount: deliverables.length,
          hasScholarAngles: a?.hasScholarAngles ?? false,
        };
      }),
    );
  },
});

/**
 * Internal: collate every submitted deliverable across a Share Back's
 * source activities. This is the input the AI digest action consumes.
 * For each deliverable we join the scholar name, the source activity
 * title, the scholar's angle (when the source had angles), the rubric
 * verdict, and the text/artifact content.
 *
 * Returns `null` when the activity isn't a Share Back.
 */
export const collateSources = internalQuery({
  args: {
    shareBackActivityId: v.id("activities"),
    // Scope to a specific Assignment when present — the digest only
    // sees deliverables from THAT cohort. Required for the post-
    // Assignments world; defaults to "all-time" when absent so the
    // legacy editor preview keeps working during Phase 2 rollout.
    assignmentId: v.optional(v.id("assignments")),
  },
  handler: async (ctx, args) => {
    const activity = await ctx.db.get(args.shareBackActivityId);
    if (!activity || activity.kind !== "shareBack") return null;
    const sourceIds = activity.sourceActivityIds ?? [];
    if (sourceIds.length === 0) return null;

    type CollatedDeliverable = {
      deliverableId: Id<"deliverables">;
      scholarId: Id<"users">;
      scholarName: string;
      sessionId: Id<"sessions">;
      sourceActivityId: Id<"activities">;
      sourceActivityTitle: string;
      angleTitle: string | null;
      angleDescription: string | null;
      submittedAt: number;
      rubricPassed: boolean | null;
      overall: "not" | "half" | "full" | null;
      content: string | null; // text or artifact body; null for binary files
      contentKind: "text" | "artifact" | "file" | "portfolio" | "none";
    };

    const perSource: Array<{
      activityId: Id<"activities">;
      title: string;
      deliverableCount: number;
    }> = [];
    const deliverables: CollatedDeliverable[] = [];

    for (const sid of sourceIds) {
      const src = await ctx.db.get(sid);
      const srcTitle = src?.title ?? "(deleted activity)";
      // Scope to the Assignment when provided so each cohort gets
      // its own digest. When absent (legacy callers), fall through to
      // every deliverable ever submitted against this activity.
      const allRows = await ctx.db
        .query("deliverables")
        .withIndex("by_activity", (q) => q.eq("activityId", sid))
        .collect();
      const rows = args.assignmentId
        ? allRows.filter((r) => r.assignmentId === args.assignmentId)
        : allRows;
      perSource.push({
        activityId: sid,
        title: srcTitle,
        deliverableCount: rows.length,
      });
      for (const d of rows) {
        const scholar = await ctx.db.get(d.scholarId);
        // Angle for this scholar on this source activity (jigsaw).
        let angleTitle: string | null = null;
        let angleDescription: string | null = null;
        if (src?.hasScholarAngles) {
          const angle = await ctx.db
            .query("scholarActivityAngles")
            .withIndex("by_scholar_activity", (q) =>
              q.eq("scholarId", d.scholarId).eq("activityId", sid),
            )
            .first();
          angleTitle = angle?.title ?? null;
          angleDescription = angle?.description ?? null;
        }
        // Resolve content for the AI: text directly, artifact body,
        // scanned-work caption + transcription (offline projects), else
        // flag it as a binary file (photo / audio / slides).
        let content: string | null = null;
        let contentKind: CollatedDeliverable["contentKind"] = "none";
        if (d.textContent) {
          content = d.textContent;
          contentKind = "text";
        } else if (d.artifactId) {
          const artifact = await ctx.db.get(d.artifactId);
          content = artifact?.content ?? null;
          contentKind = "artifact";
        } else if (d.portfolioItemId) {
          // Materialized scan: content lives on the portfolio item.
          const item = await ctx.db.get(d.portfolioItemId);
          const parts = [item?.aiCaption, item?.extractedText].filter(
            (s): s is string => !!s && s.trim().length > 0,
          );
          content = parts.length > 0 ? parts.join("\n\n") : null;
          contentKind = "portfolio";
        } else if (d.fileStorageId) {
          contentKind = "file";
        }
        deliverables.push({
          deliverableId: d._id,
          scholarId: d.scholarId,
          scholarName: scholar?.name ?? scholar?.username ?? "(unknown)",
          sessionId: d.sessionId as Id<"sessions">,
          sourceActivityId: sid,
          sourceActivityTitle: srcTitle,
          angleTitle,
          angleDescription,
          submittedAt: d.submittedAt,
          rubricPassed: d.rubricPassed ?? null,
          overall: d.overall ?? null,
          content,
          contentKind,
        });
      }
    }

    return {
      shareBackActivityId: args.shareBackActivityId,
      shareBackTitle: activity?.title ?? "Share Back",
      shareBackRecipe: activity?.shareBackRecipe ?? "reflection",
      facilitationFocus: activity?.facilitationFocus ?? null,
      perSource,
      deliverables,
    };
  },
});

/**
 * Teacher read of a Share Back's digest (or null if none yet).
 * Also computes a `stale` flag: true when any source has more
 * deliverables now than the snapshot taken at generation time.
 */
export const getDigest = teacherQuery({
  args: {
    activityId: v.id("activities"),
    // Per-Assignment scope. When provided, returns THIS cohort's
    // digest (one digest row per (assignment, activity)). When absent,
    // returns the most-recent unscoped digest (legacy).
    assignmentId: v.optional(v.id("assignments")),
  },
  handler: async (ctx, args) => {
    let digest = null as Doc<"shareBackDigests"> | null;
    if (args.assignmentId) {
      digest = await ctx.db
        .query("shareBackDigests")
        .withIndex("by_assignment_activity", (q) =>
          q
            .eq("assignmentId", args.assignmentId)
            .eq("activityId", args.activityId),
        )
        .first();
    } else {
      digest = await ctx.db
        .query("shareBackDigests")
        .withIndex("by_activity", (q) => q.eq("activityId", args.activityId))
        .first();
    }
    if (!digest) return null;

    // Staleness: compare snapshot counts to current counts. Scope by
    // assignmentId when we know it.
    let stale = false;
    let newSubmissions = 0;
    if (digest.sourceSnapshot) {
      for (const snap of digest.sourceSnapshot) {
        const allRows = await ctx.db
          .query("deliverables")
          .withIndex("by_activity", (q) =>
            q.eq("activityId", snap.activityId),
          )
          .collect();
        const rows = args.assignmentId
          ? allRows.filter((r) => r.assignmentId === args.assignmentId)
          : allRows;
        if (rows.length > snap.deliverableCount) {
          stale = true;
          newSubmissions += rows.length - snap.deliverableCount;
        }
      }
    }

    return { ...digest, stale, newSubmissions };
  },
});

/**
 * Teacher entry point: (re)generate the digest for a Share Back.
 * Snapshots the current per-source deliverable counts, flips the
 * digest row to `pending`, and schedules the "use node" generation
 * action. Re-runnable ("Regenerate"). Throws if the activity isn't a
 * Share Back with at least one source.
 */
export const requestDigest = teacherMutation({
  args: {
    activityId: v.id("activities"),
    // The Assignment whose cohort this digest is for. Required for
    // new generations; the digest row is keyed by (activity,
    // assignment) so two cohorts running the same Share Back get
    // independent digests.
    assignmentId: v.optional(v.id("assignments")),
  },
  handler: async (ctx, args) => {
    const activity = await ctx.db.get(args.activityId);
    if (!activity || activity.kind !== "shareBack") {
      throw new Error("This is not a Share Back activity.");
    }
    const sourceIds = activity.sourceActivityIds ?? [];
    if (sourceIds.length === 0) {
      throw new Error("This Share Back has no source activities to digest.");
    }
    // Snapshot per-source deliverable counts, scoped to the cohort
    // when an assignmentId is provided. Drives the staleness nudge.
    const sourceSnapshot = await Promise.all(
      sourceIds.map(async (sid) => {
        const src = await ctx.db.get(sid);
        const allRows = await ctx.db
          .query("deliverables")
          .withIndex("by_activity", (q) => q.eq("activityId", sid))
          .collect();
        const rows = args.assignmentId
          ? allRows.filter((r) => r.assignmentId === args.assignmentId)
          : allRows;
        return {
          activityId: sid,
          title: src?.title ?? "(deleted activity)",
          deliverableCount: rows.length,
        };
      }),
    );
    // Look up the existing digest for this (activity, assignment) pair.
    const existing = args.assignmentId
      ? await ctx.db
          .query("shareBackDigests")
          .withIndex("by_assignment_activity", (q) =>
            q
              .eq("assignmentId", args.assignmentId)
              .eq("activityId", args.activityId),
          )
          .first()
      : await ctx.db
          .query("shareBackDigests")
          .withIndex("by_activity", (q) =>
            q.eq("activityId", args.activityId),
          )
          .first();
    if (existing) {
      await ctx.db.patch(existing._id, {
        status: "pending",
        error: undefined,
        sourceSnapshot,
        // Stamp the assignmentId on legacy rows that don't have it.
        ...(args.assignmentId && !existing.assignmentId
          ? { assignmentId: args.assignmentId }
          : {}),
      });
    } else {
      await ctx.db.insert("shareBackDigests", {
        activityId: args.activityId,
        assignmentId: args.assignmentId,
        status: "pending",
        sourceSnapshot,
      });
    }
    await ctx.scheduler.runAfter(
      0,
      internal.shareBackActions.generateDigest,
      {
        shareBackActivityId: args.activityId,
        assignmentId: args.assignmentId,
      },
    );
  },
});

// ── Internal mutations used by the AI generation action ──────────────

const digestContentValidator = {
  summary: v.string(),
  themes: v.array(v.object({ title: v.string(), body: v.string() })),
  highlights: v.array(
    v.object({
      deliverableId: v.id("deliverables"),
      scholarId: v.id("users"),
      scholarName: v.string(),
      sourceActivityTitle: v.string(),
      angleTitle: v.optional(v.string()),
      reason: v.string(),
      excerpt: v.string(),
      sessionId: v.optional(v.id("sessions")),
    }),
  ),
  discussionPrompts: v.array(v.string()),
};

/** Write a successful digest (status → ready). */
async function findDigestRow(
  ctx: { db: { query: (t: "shareBackDigests") => never } } | { db: QueryCtx["db"] },
  activityId: Id<"activities">,
  assignmentId: Id<"assignments"> | undefined,
) {
  if (assignmentId) {
    const a = await (ctx as { db: QueryCtx["db"] }).db
      .query("shareBackDigests")
      .withIndex("by_assignment_activity", (q) =>
        q.eq("assignmentId", assignmentId).eq("activityId", activityId),
      )
      .first();
    if (a) return a;
  }
  return (ctx as { db: QueryCtx["db"] }).db
    .query("shareBackDigests")
    .withIndex("by_activity", (q) => q.eq("activityId", activityId))
    .first();
}

export const setDigestReady = internalMutation({
  args: {
    activityId: v.id("activities"),
    assignmentId: v.optional(v.id("assignments")),
    ...digestContentValidator,
  },
  handler: async (ctx, args) => {
    const existing = await findDigestRow(
      ctx,
      args.activityId,
      args.assignmentId,
    );
    const patch = {
      status: "ready" as const,
      error: undefined,
      generatedAt: Date.now(),
      summary: args.summary,
      themes: args.themes,
      highlights: args.highlights,
      discussionPrompts: args.discussionPrompts,
    };
    if (existing) {
      await ctx.db.patch(existing._id, {
        ...patch,
        ...(args.assignmentId && !existing.assignmentId
          ? { assignmentId: args.assignmentId }
          : {}),
      });
    } else {
      await ctx.db.insert("shareBackDigests", {
        activityId: args.activityId,
        assignmentId: args.assignmentId,
        ...patch,
      });
    }
  },
});

export const setDigestError = internalMutation({
  args: {
    activityId: v.id("activities"),
    assignmentId: v.optional(v.id("assignments")),
    error: v.string(),
  },
  handler: async (ctx, args) => {
    const existing = await findDigestRow(
      ctx,
      args.activityId,
      args.assignmentId,
    );
    if (existing) {
      await ctx.db.patch(existing._id, {
        status: "error",
        error: args.error,
        ...(args.assignmentId && !existing.assignmentId
          ? { assignmentId: args.assignmentId }
          : {}),
      });
    } else {
      await ctx.db.insert("shareBackDigests", {
        activityId: args.activityId,
        assignmentId: args.assignmentId,
        status: "error",
        error: args.error,
      });
    }
  },
});
