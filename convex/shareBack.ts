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
import { effectiveActivityKind } from "../shared/appSurface";
import { requireUnitEditAccess, unitOwnInstitutionId } from "./lib/auth";
import { requireUnitAccess } from "./lib/unitAccess";
import { primaryInstitutionId } from "./lib/primaryInstitution";

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


// ── Tenancy ──────────────────────────────────────────────────────────
// A Share Back belongs to its unit's school, and so do its sources: the
// picker offers only that school's units, setSources refuses anything else,
// and every read that resolves a source (titles, counts, the AI digest's
// deliverables) drops a source from another school (TRA-653).

/** The unit an activity sits in, or null for an orphan. */
async function unitOfActivity(
  ctx: Pick<QueryCtx, "db">,
  activity: Doc<"activities"> | null,
): Promise<Doc<"units"> | null> {
  if (!activity?.lessonId) return null;
  const lesson = await ctx.db.get(activity.lessonId);
  return lesson ? await ctx.db.get(lesson.unitId) : null;
}

/** Where a Share Back sits: its unit and that unit's school. */
type ShareBackHome = {
  unit: Doc<"units">;
  schoolId: Id<"institutions"> | undefined;
};

async function shareBackHome(
  ctx: QueryCtx,
  activity: Doc<"activities"> | null,
): Promise<ShareBackHome | null> {
  const unit = await unitOfActivity(ctx, activity);
  return unit ? { unit, schoolId: await unitOwnInstitutionId(ctx, unit) } : null;
}

/**
 * Whether a source activity may feed this Share Back: "ok" for a catalog
 * activity in the same school (or in the Share Back's own unit), "missing"
 * for a deleted or orphaned activity, "foreign" for anything else, including
 * another school's activity or a scholar's own Quest unit.
 */
async function sourceStanding(
  ctx: QueryCtx,
  home: ShareBackHome,
  sourceId: Id<"activities">,
): Promise<"ok" | "missing" | "foreign"> {
  const unit = await unitOfActivity(ctx, await ctx.db.get(sourceId));
  if (!unit) return "missing";
  if (unit._id === home.unit._id) return "ok";
  if (unit.authorScholarId) return "foreign";
  return (await unitOwnInstitutionId(ctx, unit)) === home.schoolId
    ? "ok"
    : "foreign";
}

/** The wired sources that may feed this Share Back, in order. */
async function usableSourceIds(
  ctx: QueryCtx,
  home: ShareBackHome,
  sourceIds: Id<"activities">[],
): Promise<Id<"activities">[]> {
  const usable: Id<"activities">[] = [];
  for (const id of sourceIds) {
    if ((await sourceStanding(ctx, home, id)) === "ok") usable.push(id);
  }
  return usable;
}

/**
 * Read-gate a Share Back activity: the caller must be able to read its unit
 * (`requireUnitAccess`). Returns the activity and its school, or null when
 * the activity or its unit is gone.
 */
async function requireShareBackRead(
  ctx: QueryCtx & { user: Doc<"users"> },
  activityId: Id<"activities">,
) {
  const activity = await ctx.db.get(activityId);
  const home = await shareBackHome(ctx, activity);
  if (!activity || !home) return null;
  await requireUnitAccess(ctx, home.unit._id);
  return { activity, ...home };
}

/**
 * Deliverable counts are display hints ("12 submitted"), so they stop
 * reading at a cap: the picker's reads must not grow with every submission.
 */
const DELIVERABLE_COUNT_CAP = 50;

async function boundedDeliverableCount(
  ctx: Pick<QueryCtx, "db">,
  activityId: Id<"activities">,
): Promise<{ deliverableCount: number; deliverableCountCapped: boolean }> {
  const rows = await ctx.db
    .query("deliverables")
    .withIndex("by_activity", (q) => q.eq("activityId", activityId))
    .take(DELIVERABLE_COUNT_CAP + 1);
  return {
    deliverableCount: Math.min(rows.length, DELIVERABLE_COUNT_CAP),
    deliverableCountCapped: rows.length > DELIVERABLE_COUNT_CAP,
  };
}

/**
 * The catalog units of one school. A legacy unstamped unit belongs to the
 * primary school (mirrors `requireUnitAccessForUser`); with no institution
 * rows at all, every unstamped unit is the one legacy school.
 * Independent Study units are a scholar's own Quests, not class sources.
 */
async function schoolCatalogUnits(
  ctx: QueryCtx,
  schoolId: Id<"institutions"> | undefined,
): Promise<Doc<"units">[]> {
  const stamped = schoolId
    ? await ctx.db
        .query("units")
        .withIndex("by_institution", (q) => q.eq("institutionId", schoolId))
        .collect()
    : [];
  const primaryId = await primaryInstitutionId(ctx);
  const unstamped =
    (primaryId ?? undefined) === schoolId
      ? await ctx.db
          .query("units")
          .withIndex("by_institution", (q) => q.eq("institutionId", undefined))
          .collect()
      : [];
  return [...stamped, ...unstamped].filter((unit) => !unit.authorScholarId);
}

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
    const { unit } = await requireUnitEditAccess(ctx, {
      activityId: args.activityId,
    });
    const home = { unit, schoolId: await unitOwnInstitutionId(ctx, unit) };
    const activity = await ctx.db.get(args.activityId);
    if (!activity) throw new Error("Activity not found");
    if (activity.kind !== "shareBack") {
      throw new Error("Sources can only be set on a Share Back activity");
    }
    // A Share Back may not reference itself.
    const requested = args.sourceActivityIds.filter(
      (id) => id !== args.activityId,
    );
    // Only this school's activities. A deleted activity, or one already
    // wired before TRA-653 (legacy cross-school wiring), is dropped rather
    // than refused, so the editor can still add and remove sources around it.
    const wired = new Set(activity.sourceActivityIds ?? []);
    const sources: Id<"activities">[] = [];
    for (const sourceId of requested) {
      const standing = await sourceStanding(ctx, home, sourceId);
      if (standing === "ok") {
        sources.push(sourceId);
      } else if (standing === "foreign" && !wired.has(sourceId)) {
        throw new Error("Sources must be activities in this unit's school");
      }
    }
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
    await requireUnitEditAccess(ctx, { activityId: args.activityId });
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
    await requireUnitEditAccess(ctx, { activityId: args.activityId });
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
    // An editor surface: gate like setSources, at the unit's own school.
    const self = await ctx.db.get(args.shareBackActivityId);
    const shareBack = await shareBackHome(ctx, self);
    if (!shareBack) return [];
    await requireUnitEditAccess(ctx, { unitId: shareBack.unit._id });
    const selfUnitId = shareBack.unit._id;

    // Only the Share Back's own school's catalog (TRA-653), plus its own
    // unit when that is an Independent Study unit.
    const units = await schoolCatalogUnits(ctx, shareBack.schoolId);
    if (!units.some((unit) => unit._id === selfUnitId)) {
      units.push(shareBack.unit);
    }
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
      deliverableCountCapped: boolean;
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
          // Effective kind: an app activity stored as online is still an app.
          const kind = effectiveActivityKind(a);
          if (
            kind === "shareBack" ||
            kind === "web" ||
            kind === "problem_set" ||
            // A game's evidence lives in its digest, not a deliverable, so it
            // is not a share-back source. A simulator's exhibition path is its own
            // gallery submission (plan §8), not this digest. An app is its own
            // artifact, likewise not a share-back deliverable.
            kind === "game" ||
            kind === "simulator" ||
            kind === "vibecode"
          )
            continue;
          const counts = await boundedDeliverableCount(ctx, a._id);
          rows.push({
            _id: a._id,
            title: a.title,
            kind,
            unitId: unit._id,
            unitTitle: unit.title,
            unitEmoji: unit.emoji ?? null,
            lessonTitle: lesson.title,
            sameUnit: unit._id === selfUnitId,
            ...counts,
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
    const shareBack = await requireShareBackRead(ctx, args.activityId);
    if (!shareBack) return [];
    // A source from another school (legacy wiring) is left out entirely, so
    // its title never crosses over; the next setSources drops it.
    const ids: Id<"activities">[] = [];
    for (const id of shareBack.activity.sourceActivityIds ?? []) {
      if ((await sourceStanding(ctx, shareBack, id)) !== "foreign") {
        ids.push(id);
      }
    }
    return Promise.all(
      ids.map(async (id) => {
        const a = await ctx.db.get(id);
        const counts = a
          ? await boundedDeliverableCount(ctx, id)
          : { deliverableCount: 0, deliverableCountCapped: false };
        return {
          _id: id,
          title: a?.title ?? "(deleted activity)",
          exists: !!a,
          ...counts,
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
    const home = await shareBackHome(ctx, activity);
    if (!home) return null;
    // Never digest another school's scholars' work (legacy wiring).
    const sourceIds = await usableSourceIds(
      ctx,
      home,
      activity.sourceActivityIds ?? [],
    );
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
    const shareBack = await requireShareBackRead(ctx, args.activityId);
    if (!shareBack) return null;
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
    // A digest generated before TRA-653 from another school's source carries
    // that school's scholars' work. Withhold it; Regenerate builds a clean one.
    for (const snap of digest.sourceSnapshot ?? []) {
      if ((await sourceStanding(ctx, shareBack, snap.activityId)) === "foreign") {
        return null;
      }
    }

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
    const shareBack = await requireShareBackRead(ctx, args.activityId);
    const activity = shareBack?.activity;
    if (!shareBack || !activity || activity.kind !== "shareBack") {
      throw new Error("This is not a Share Back activity.");
    }
    const sourceIds = await usableSourceIds(
      ctx,
      shareBack,
      activity.sourceActivityIds ?? [],
    );
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
