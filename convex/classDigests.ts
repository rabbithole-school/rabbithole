import { v } from "convex/values";
import { teacherQuery, teacherMutation } from "./lib/customFunctions";
import {
  internalQuery,
  internalMutation,
  type QueryCtx,
  type MutationCtx,
} from "./_generated/server";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import {
  resolveInstitutionLens,
  scholarIdsInLens,
} from "./lib/institutionLens";
import {
  digestStaleness,
  watermarkAdvanced,
} from "./lib/digestStaleness";

// ─────────────────────────────────────────────────────────────────────
// Class Digest — backend (default runtime).
//
// A glanceable AI synthesis of what a cohort did, at two scopes off ONE
// engine (DRY): "activity" (one assigned activity × one cohort) and
// "cohort" (the whole assignment, recent window — the "today's read").
//
// This file owns the collation reads (input to the AI), the digest
// read/request surface, the auto-generation policy (threshold + debounce
// so we never loop or spam Claude), and the cron sweep. The AI action
// itself lives in classDigestActions.ts ("use node").
//
// Mirrors the shareBackDigests pattern (pending → ready/error, snapshot
// for staleness, regenerate). See review/activity-digest-feature.md.
// ─────────────────────────────────────────────────────────────────────

const AUTO_DEBOUNCE_MS = 5 * 60_000; // don't auto-regenerate within 5 min

export type DigestScope = "activity" | "cohort";

// ── Content resolution (shared with shareBack's approach) ──────────────

async function resolveDeliverableContent(
  ctx: QueryCtx,
  d: Doc<"deliverables">,
): Promise<{ content: string | null; kind: string }> {
  if (d.textContent) return { content: d.textContent, kind: "text" };
  if (d.artifactId) {
    const a = await ctx.db.get(d.artifactId);
    return { content: a?.content ?? null, kind: "artifact" };
  }
  if (d.portfolioItemId) {
    const item = await ctx.db.get(d.portfolioItemId);
    const parts = [item?.aiCaption, item?.extractedText].filter(
      (s): s is string => !!s && s.trim().length > 0,
    );
    return {
      content: parts.length > 0 ? parts.join("\n\n") : null,
      kind: "portfolio",
    };
  }
  if (d.fileStorageId) return { content: null, kind: "file" };
  return { content: null, kind: "none" };
}

// ── Count helpers (snapshot + staleness + auto-trigger threshold) ──────

export async function activityCounts(
  ctx: QueryCtx,
  assignmentId: Id<"assignments">,
  activityId: Id<"activities">,
): Promise<{ completedCount: number; startedCount: number; deliverableCount: number }> {
  const completions = (
    await ctx.db
      .query("activityCompletions")
      .withIndex("by_assignment", (q) => q.eq("assignmentId", assignmentId))
      .collect()
  ).filter((c) => c.activityId === activityId);
  const sessions = (
    await ctx.db
      .query("sessions")
      .withIndex("by_assignment", (q) => q.eq("assignmentId", assignmentId))
      .collect()
  ).filter((p) => !p.isOffline && p.activityId === activityId);
  const deliverables = (
    await ctx.db
      .query("deliverables")
      .withIndex("by_activity", (q) => q.eq("activityId", activityId))
      .collect()
  ).filter((d) => d.assignmentId === assignmentId);
  const started = new Set<string>([
    ...sessions.map((p) => String(p.userId)),
    ...completions.map((c) => String(c.scholarId)),
  ]);
  return {
    completedCount: new Set(completions.map((c) => String(c.scholarId))).size,
    startedCount: started.size,
    deliverableCount: deliverables.length,
  };
}

async function cohortCounts(
  ctx: QueryCtx,
  assignmentId: Id<"assignments">,
): Promise<{ completedCount: number; startedCount: number; deliverableCount: number }> {
  const completions = await ctx.db
    .query("activityCompletions")
    .withIndex("by_assignment", (q) => q.eq("assignmentId", assignmentId))
    .collect();
  const sessions = (
    await ctx.db
      .query("sessions")
      .withIndex("by_assignment", (q) => q.eq("assignmentId", assignmentId))
      .collect()
  ).filter((p) => !p.isOffline);
  return {
    completedCount: completions.length,
    startedCount: new Set(sessions.map((p) => String(p.userId))).size,
    deliverableCount: 0, // not tracked at cohort altitude
  };
}

async function countsFor(
  ctx: QueryCtx,
  scope: DigestScope,
  assignmentId: Id<"assignments">,
  activityId: Id<"activities"> | undefined,
) {
  return scope === "activity" && activityId
    ? activityCounts(ctx, assignmentId, activityId)
    : cohortCounts(ctx, assignmentId);
}

/**
 * Source watermark for a digest: the newest observer-analysis time and the
 * newest message time across the sessions this digest collates (same session
 * set as the count helpers above — non-offline, activity-filtered for the
 * activity scope). Stamped into `sourceSnapshot` at generation time so a
 * later analysis / message can stale + regenerate a digest whose completion /
 * deliverable counts never move.
 */
export async function sourceWatermark(
  ctx: QueryCtx,
  scope: DigestScope,
  assignmentId: Id<"assignments">,
  activityId: Id<"activities"> | undefined,
): Promise<{ latestAnalysisAt: number; latestMessageAt: number }> {
  const sessions = (
    await ctx.db
      .query("sessions")
      .withIndex("by_assignment", (q) => q.eq("assignmentId", assignmentId))
      .collect()
  ).filter(
    (p) =>
      !p.isOffline &&
      (scope === "activity" && activityId ? p.activityId === activityId : true),
  );
  let latestMessageAt = 0;
  let latestAnalysisAt = 0;
  for (const s of sessions) {
    if ((s.lastMessageAt ?? 0) > latestMessageAt) {
      latestMessageAt = s.lastMessageAt ?? 0;
    }
    const analyses = await ctx.db
      .query("analyses")
      .withIndex("by_session", (q) => q.eq("sessionId", s._id))
      .collect();
    for (const a of analyses) {
      if (a._creationTime > latestAnalysisAt) {
        latestAnalysisAt = a._creationTime;
      }
    }
  }
  return { latestAnalysisAt, latestMessageAt };
}

function hasMaterial(counts: {
  completedCount: number;
  startedCount: number;
  deliverableCount: number;
}): boolean {
  return (
    counts.completedCount >= 1 ||
    counts.deliverableCount >= 1 ||
    counts.startedCount >= 1
  );
}

// ── Row lookup ─────────────────────────────────────────────────────────

async function findRow(
  ctx: QueryCtx,
  scope: DigestScope,
  assignmentId: Id<"assignments">,
  activityId: Id<"activities"> | undefined,
): Promise<Doc<"classDigests"> | null> {
  if (scope === "activity" && activityId) {
    return ctx.db
      .query("classDigests")
      .withIndex("by_assignment_activity", (q) =>
        q.eq("assignmentId", assignmentId).eq("activityId", activityId),
      )
      .first();
  }
  return ctx.db
    .query("classDigests")
    .withIndex("by_assignment_scope", (q) =>
      q.eq("assignmentId", assignmentId).eq("scope", "cohort"),
    )
    .first();
}

// ── Shared: snapshot + upsert pending + schedule the AI action ─────────

async function scheduleGeneration(
  ctx: MutationCtx,
  scope: DigestScope,
  assignmentId: Id<"assignments">,
  activityId: Id<"activities"> | undefined,
) {
  const counts = await countsFor(ctx, scope, assignmentId, activityId);
  const watermark = await sourceWatermark(ctx, scope, assignmentId, activityId);
  const existing = await findRow(ctx, scope, assignmentId, activityId);
  const patch = {
    status: "pending" as const,
    error: undefined,
    sourceSnapshot: { ...counts, ...watermark },
  };
  if (existing) {
    await ctx.db.patch(existing._id, patch);
  } else {
    await ctx.db.insert("classDigests", {
      scope,
      assignmentId,
      activityId: scope === "activity" ? activityId : undefined,
      ...patch,
    });
  }
  await ctx.scheduler.runAfter(0, internal.classDigestActions.generate, {
    scope,
    assignmentId,
    activityId: scope === "activity" ? activityId : undefined,
  });
}

// ── Collation reads (input to the AI action) ───────────────────────────

export const collateActivity = internalQuery({
  args: {
    assignmentId: v.id("assignments"),
    activityId: v.id("activities"),
  },
  handler: async (ctx, args) => {
    const assignment = await ctx.db.get(args.assignmentId);
    if (!assignment) return null;
    const activity = await ctx.db.get(args.activityId);
    const lesson = activity?.lessonId
      ? await ctx.db.get(activity.lessonId)
      : null;
    const unit = lesson ? await ctx.db.get(lesson.unitId) : null;

    const sessions = (
      await ctx.db
        .query("sessions")
        .withIndex("by_assignment", (q) =>
          q.eq("assignmentId", args.assignmentId),
        )
        .collect()
    ).filter((p) => !p.isOffline && p.activityId === args.activityId);
    const sessionByScholar = new Map(sessions.map((p) => [String(p.userId), p]));

    const completions = (
      await ctx.db
        .query("activityCompletions")
        .withIndex("by_assignment", (q) =>
          q.eq("assignmentId", args.assignmentId),
        )
        .collect()
    ).filter((c) => c.activityId === args.activityId);
    const doneSet = new Set(completions.map((c) => String(c.scholarId)));

    const deliverables = (
      await ctx.db
        .query("deliverables")
        .withIndex("by_activity", (q) => q.eq("activityId", args.activityId))
        .collect()
    ).filter((d) => d.assignmentId === args.assignmentId);
    const delivByScholar = new Map(
      deliverables.map((d) => [String(d.scholarId), d]),
    );

    const scholars = await Promise.all(
      assignment.scholarIds.map(async (sid) => {
        const s = await ctx.db.get(sid);
        const session = sessionByScholar.get(String(sid)) ?? null;
        const deliv = delivByScholar.get(String(sid)) ?? null;
        const delivContent = deliv
          ? await resolveDeliverableContent(ctx, deliv)
          : null;
        return {
          scholarId: sid,
          name: s?.name ?? s?.username ?? "(unknown)",
          started: !!session,
          completed: doneSet.has(String(sid)),
          sessionId: session?._id ?? null,
          analysisSummary: session?.analysisSummary ?? null,
          pulseScore: session?.pulseScore ?? null,
          deliverableContent: delivContent?.content ?? null,
          deliverableOverall: deliv?.overall ?? null,
        };
      }),
    );

    return {
      activityTitle: activity?.title ?? "Activity",
      activityKind: activity?.kind ?? "online",
      lessonTitle: lesson?.title ?? null,
      unitTitle: unit?.title ?? null,
      rosterSize: assignment.scholarIds.length,
      scholars,
    };
  },
});

export const collateCohort = internalQuery({
  args: { assignmentId: v.id("assignments") },
  handler: async (ctx, args) => {
    const assignment = await ctx.db.get(args.assignmentId);
    if (!assignment) return null;
    // A standing (unitId-less) assignment has no unit to resolve.
    const unit = assignment.unitId ? await ctx.db.get(assignment.unitId) : null;

    const sessions = (
      await ctx.db
        .query("sessions")
        .withIndex("by_assignment", (q) =>
          q.eq("assignmentId", args.assignmentId),
        )
        .collect()
    ).filter((p) => !p.isOffline);
    // Newest project per scholar (their most recent line of work).
    const latestByScholar = new Map<string, Doc<"sessions">>();
    for (const p of sessions) {
      const k = String(p.userId);
      const prev = latestByScholar.get(k);
      if (!prev || (p.lastMessageAt ?? 0) > (prev.lastMessageAt ?? 0)) {
        latestByScholar.set(k, p);
      }
    }
    const completions = await ctx.db
      .query("activityCompletions")
      .withIndex("by_assignment", (q) =>
        q.eq("assignmentId", args.assignmentId),
      )
      .collect();
    const doneByScholar = new Map<string, number>();
    for (const c of completions) {
      const k = String(c.scholarId);
      doneByScholar.set(k, (doneByScholar.get(k) ?? 0) + 1);
    }

    const scholars = await Promise.all(
      assignment.scholarIds.map(async (sid) => {
        const s = await ctx.db.get(sid);
        const session = latestByScholar.get(String(sid)) ?? null;
        const activity = session?.activityId
          ? await ctx.db.get(session.activityId)
          : null;
        return {
          scholarId: sid,
          name: s?.name ?? s?.username ?? "(unknown)",
          sessionId: session?._id ?? null,
          currentActivityTitle: activity?.title ?? null,
          analysisSummary: session?.analysisSummary ?? null,
          pulseScore: session?.pulseScore ?? null,
          lastMessageAt: session?.lastMessageAt ?? null,
          completedCount: doneByScholar.get(String(sid)) ?? 0,
        };
      }),
    );

    return {
      unitTitle: unit?.title ?? "this unit",
      rosterSize: assignment.scholarIds.length,
      completionsTotal: completions.length,
      scholars,
    };
  },
});

// ── Teacher reads ──────────────────────────────────────────────────────

function withStaleness(
  digest: Doc<"classDigests">,
  current: {
    completedCount: number;
    startedCount: number;
    deliverableCount: number;
  },
  watermark: { latestAnalysisAt: number; latestMessageAt: number },
) {
  const { stale, newSince } = digestStaleness(digest.sourceSnapshot, {
    ...current,
    ...watermark,
  });
  return { ...digest, stale, newSince, currentCounts: current };
}

/**
 * Whether a ready digest's source watermark trails current source — i.e. a
 * later analysis / message has landed since it was generated, so its headline
 * may be contradicted (the Leilani "cut off" vs. "resolved" case). Used by
 * teacherToday to SUPPRESS such a digest rather than surface a stale claim.
 *
 * Watermark-only by design: a digest with no watermark snapshot (generated
 * before this field existed) returns false and is left exactly as today.
 */
export async function digestWatermarkTrails(
  ctx: QueryCtx,
  digest: Doc<"classDigests">,
): Promise<boolean> {
  const snap = digest.sourceSnapshot;
  if (
    !snap ||
    (snap.latestAnalysisAt === undefined && snap.latestMessageAt === undefined)
  ) {
    return false;
  }
  const current = await sourceWatermark(
    ctx,
    // Stored rows still carry a `scope` union that includes the retired
    // "class" literal (schema unchanged; prod has zero such rows). A legacy
    // class row keys its watermark off its representative assignment — the
    // same generic path "cohort" takes — so map it there.
    digest.scope === "activity" ? "activity" : "cohort",
    digest.assignmentId,
    digest.activityId,
  );
  return watermarkAdvanced(snap, current);
}

/**
 * Institution-lens scoping for a digest read (design 2 — see
 * review/activity-digest-feature.md / the PR body).
 *
 * A digest is a FULL-COHORT artifact: its AI synthesis and its
 * `sourceSnapshot` staleness baseline are both captured across the whole
 * cohort. So lens-scoping the visible COUNTS would desync them from the
 * full-cohort snapshot and make the "N new since" nudge lie (it could even go
 * negative). Instead:
 *
 *   - No scope arg (`requestedScope === undefined`) → do nothing; the read
 *     behaves EXACTLY as it did before the lens existed.
 *   - Scope present → resolve the active lens. If it does NOT narrow this
 *     assignment's cohort (every cohort scholar is inside the lens — the
 *     common case), this is a no-op and behavior is identical to today.
 *   - Scope present AND the lens narrows the cohort → hide the per-scholar
 *     roster rows (`moments`) for out-of-lens scholars, but leave counts +
 *     staleness computed from the FULL cohort so the nudge stays honest.
 *
 * `lensNarrowed` is surfaced so the UI can note that the counts/synthesis
 * still cover the full cohort even though the roster rows are filtered.
 */
async function scopeDigestToLens(
  ctx: QueryCtx,
  user: Doc<"users">,
  assignment: Doc<"assignments">,
  digest: Doc<"classDigests"> | null,
  requestedScope: string | undefined,
): Promise<{ digest: Doc<"classDigests"> | null; lensNarrowed: boolean }> {
  if (requestedScope === undefined) return { digest, lensNarrowed: false };
  const lens = await resolveInstitutionLens(ctx, user, requestedScope);
  const lensScholarIds = await scholarIdsInLens(ctx, lens);
  const lensNarrowed = assignment.scholarIds.some(
    (id) => !lensScholarIds.has(id),
  );
  if (!lensNarrowed || !digest) return { digest, lensNarrowed };
  // Narrowing lens: hide roster rows (moments) for scholars outside the lens.
  const moments = digest.moments?.filter((m) => lensScholarIds.has(m.scholarId));
  return { digest: { ...digest, moments }, lensNarrowed };
}

export const getActivityDigest = teacherQuery({
  args: {
    assignmentId: v.id("assignments"),
    activityId: v.id("activities"),
    // Active institution lens (see hooks/useActiveInstitution). Optional so a
    // caller that omits it gets exactly today's full-cohort behavior.
    scope: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const assignment = await ctx.db.get(args.assignmentId);
    if (!assignment || assignment.teacherId !== ctx.user._id) return null;
    const row = await findRow(
      ctx,
      "activity",
      args.assignmentId,
      args.activityId,
    );
    const current = await activityCounts(
      ctx,
      args.assignmentId,
      args.activityId,
    );
    const currentWatermark = await sourceWatermark(
      ctx,
      "activity",
      args.assignmentId,
      args.activityId,
    );
    const { digest, lensNarrowed } = await scopeDigestToLens(
      ctx,
      ctx.user,
      assignment,
      row,
      args.scope,
    );
    if (!digest) return { digest: null, current, lensNarrowed };
    return {
      digest: withStaleness(digest, current, currentWatermark),
      current,
      lensNarrowed,
    };
  },
});

export const getCohortDigest = teacherQuery({
  args: {
    assignmentId: v.id("assignments"),
    scope: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const assignment = await ctx.db.get(args.assignmentId);
    if (!assignment || assignment.teacherId !== ctx.user._id) return null;
    const row = await findRow(ctx, "cohort", args.assignmentId, undefined);
    const current = await cohortCounts(ctx, args.assignmentId);
    const currentWatermark = await sourceWatermark(
      ctx,
      "cohort",
      args.assignmentId,
      undefined,
    );
    const { digest, lensNarrowed } = await scopeDigestToLens(
      ctx,
      ctx.user,
      assignment,
      row,
      args.scope,
    );
    if (!digest) return { digest: null, current, lensNarrowed };
    return {
      digest: withStaleness(digest, current, currentWatermark),
      current,
      lensNarrowed,
    };
  },
});

// ── Teacher request (manual regenerate) ────────────────────────────────

export const requestActivityDigest = teacherMutation({
  args: {
    assignmentId: v.id("assignments"),
    activityId: v.id("activities"),
  },
  handler: async (ctx, args) => {
    const assignment = await ctx.db.get(args.assignmentId);
    if (!assignment || assignment.teacherId !== ctx.user._id) {
      throw new Error("Forbidden");
    }
    // Same exclusion as the auto path: Share Backs and games own their digest
    // flows, and web activities have no transcript/deliverable to synthesize.
    const activity = await ctx.db.get(args.activityId);
    if (!activity || activity.kind === "shareBack" ||
      activity.kind === "web" ||
      // A game has no conversation transcript to digest — its record is its
      // own evidence digest (convex/games.ts).
      activity.kind === "game") {
      throw new Error(
        "Class digests aren't available for Share Back, web, or game activities.",
      );
    }
    await scheduleGeneration(
      ctx,
      "activity",
      args.assignmentId,
      args.activityId,
    );
  },
});

export const requestCohortDigest = teacherMutation({
  args: { assignmentId: v.id("assignments") },
  handler: async (ctx, args) => {
    const assignment = await ctx.db.get(args.assignmentId);
    if (!assignment || assignment.teacherId !== ctx.user._id) {
      throw new Error("Forbidden");
    }
    await scheduleGeneration(ctx, "cohort", args.assignmentId, undefined);
  },
});

// ── Close the loop: turn an activity digest into a Share Back debrief ───

/**
 * Spin a ready activity digest into a Share Back "debrief" activity,
 * pre-shaped by what the digest already learned. Creates a kind=shareBack
 * activity in the same lesson, sourced from this activity, with a custom
 * facilitation focus built from the digest's summary + themes, and kicks
 * its digest generation so the debrief is ready to facilitate. Idempotent
 * — reuses an existing debrief for this (activity, lesson) if present.
 *
 * This is the connective tissue between the "review what happened" digest
 * and the "what do we open with next" Share Back (TODO: Teacher
 * Reflection / prebrief-debrief).
 */
export const createDebriefFromDigest = teacherMutation({
  args: {
    assignmentId: v.id("assignments"),
    activityId: v.id("activities"),
  },
  handler: async (ctx, args) => {
    const assignment = await ctx.db.get(args.assignmentId);
    if (!assignment || assignment.teacherId !== ctx.user._id) {
      throw new Error("Forbidden");
    }
    const activity = await ctx.db.get(args.activityId);
    if (!activity || !activity.lessonId) {
      throw new Error("Activity not found or not lesson-anchored");
    }
    const lessonId = activity.lessonId;

    const digest = await findRow(ctx, "activity", args.assignmentId, args.activityId);
    if (!digest || digest.status !== "ready") {
      throw new Error("Generate the digest first.");
    }

    const debriefTitle = `Debrief: ${activity.title}`;

    // Idempotency: reuse an existing debrief for this source in this lesson.
    const lessonActs = await ctx.db
      .query("activities")
      .withIndex("by_lesson", (q) => q.eq("lessonId", lessonId))
      .collect();
    const existing = lessonActs.find(
      (a) =>
        a.kind === "shareBack" &&
        (a.sourceActivityIds ?? []).includes(args.activityId) &&
        a.title === debriefTitle,
    );
    if (existing) return { shareBackActivityId: existing._id, reused: true };

    // Build a facilitation focus from what the digest already surfaced, so
    // the debrief is shaped by the class's actual work (custom recipe =
    // facilitationFocus drives the share-back generator).
    const focusParts = [digest.summary?.trim()].filter(Boolean) as string[];
    if (digest.themes && digest.themes.length > 0) {
      focusParts.push(
        `Surface these in discussion: ${digest.themes.map((t) => t.title).join("; ")}.`,
      );
    }
    const facilitationFocus = focusParts.join("\n\n").slice(0, 2000);

    const maxOrder = lessonActs.reduce((m, a) => Math.max(m, a.order), -1);
    const shareBackActivityId = await ctx.db.insert("activities", {
      lessonId,
      title: debriefTitle,
      kind: "shareBack",
      order: maxOrder + 1,
      shareBackRecipe: "custom",
      sourceActivityIds: [args.activityId],
      facilitationFocus,
    });

    // Kick the Share Back digest so the debrief is ready to facilitate.
    const sourceDeliverables = (
      await ctx.db
        .query("deliverables")
        .withIndex("by_activity", (q) => q.eq("activityId", args.activityId))
        .collect()
    ).filter((d) => d.assignmentId === args.assignmentId);
    await ctx.db.insert("shareBackDigests", {
      activityId: shareBackActivityId,
      assignmentId: args.assignmentId,
      status: "pending",
      sourceSnapshot: [
        {
          activityId: args.activityId,
          title: activity.title,
          deliverableCount: sourceDeliverables.length,
        },
      ],
    });
    await ctx.scheduler.runAfter(0, internal.shareBackActions.generateDigest, {
      shareBackActivityId,
      assignmentId: args.assignmentId,
    });

    return { shareBackActivityId, reused: false };
  },
});

// ── Auto-generation policy (threshold + debounce) ──────────────────────

/**
 * Decide whether to (re)generate a digest and, if so, snapshot + schedule
 * it. Idempotent + debounced so completion pings and the cron sweep can
 * call it freely without looping or spamming Claude:
 *   - no row yet     → generate once there's material to synthesize.
 *   - ready + stale  → regenerate, but not within AUTO_DEBOUNCE_MS.
 *   - pending        → skip (already running).
 *   - error          → retry after the debounce window.
 */
export const maybeAutoGenerate = internalMutation({
  args: {
    scope: v.union(v.literal("activity"), v.literal("cohort")),
    assignmentId: v.id("assignments"),
    activityId: v.optional(v.id("activities")),
  },
  handler: async (ctx, args) => {
    const assignment = await ctx.db.get(args.assignmentId);
    if (!assignment || assignment.archivedAt) return { scheduled: false };
    // Activity scope: skip Share Backs (they own their digest flow) and
    // web activities (no transcript/deliverable to synthesize).
    if (args.scope === "activity") {
      if (!args.activityId) return { scheduled: false };
      const activity = await ctx.db.get(args.activityId);
      if (!activity || activity.kind === "shareBack" ||
      activity.kind === "web" ||
      // A game has no conversation transcript to digest — its record is its
      // own evidence digest (convex/games.ts).
      activity.kind === "game") {
        return { scheduled: false };
      }
    }
    const counts = await countsFor(
      ctx,
      args.scope,
      args.assignmentId,
      args.activityId,
    );
    if (!hasMaterial(counts)) return { scheduled: false };
    const watermark = await sourceWatermark(
      ctx,
      args.scope,
      args.assignmentId,
      args.activityId,
    );

    const existing = await findRow(
      ctx,
      args.scope,
      args.assignmentId,
      args.activityId,
    );
    if (existing) {
      if (existing.status === "pending") return { scheduled: false };
      const age = Date.now() - (existing.generatedAt ?? 0);
      if (age < AUTO_DEBOUNCE_MS) return { scheduled: false };
      // Regenerate on completion/deliverable growth OR a source-watermark
      // advance (a later analysis / message), so a resolved session doesn't
      // linger behind a mid-session digest with unchanged counts.
      const grew =
        !existing.sourceSnapshot ||
        digestStaleness(existing.sourceSnapshot, { ...counts, ...watermark })
          .stale;
      if (existing.status === "ready" && !grew) return { scheduled: false };
    }

    await scheduleGeneration(
      ctx,
      args.scope,
      args.assignmentId,
      args.activityId,
    );
    return { scheduled: true };
  },
});

/**
 * Cron safety-net: sweep active assignments and auto-(re)generate any
 * digest that's earned one. Catches every completion path (manual mark,
 * AI rubric pass, scanned work, web sessions) without hooking each call
 * site. Capped per run so a big school never thunders Claude in one tick.
 */
export const sweepAutoGenerate = internalMutation({
  args: {},
  handler: async (ctx) => {
    // Each candidate is checked in its OWN transaction (scheduler, not
    // runMutation) so this sweep's read set stays small — just curriculum
    // structure (assignments/lessons/activities), never the per-assignment
    // projects/completions/deliverables or classDigests rows that
    // concurrent completions write. That avoids a giant single-transaction
    // read set + OCC contention as a school grows. The per-digest debounce
    // inside maybeAutoGenerate is what actually bounds Claude calls; this
    // cap only bounds how many cheap checks we fan out per tick.
    const MAX_CHECKS_PER_RUN = 60;
    let scheduled = 0;
    const assignments = await ctx.db.query("assignments").collect();
    for (const a of assignments) {
      if (a.archivedAt) continue;
      if (scheduled >= MAX_CHECKS_PER_RUN) break;
      await ctx.scheduler.runAfter(
        0,
        internal.classDigests.maybeAutoGenerate,
        { scope: "cohort", assignmentId: a._id },
      );
      scheduled++;
      // A standing (unitId-less) assignment has no lessons/activities to
      // walk for per-activity digest checks — only the cohort-scope check
      // above applies to it.
      const lessons = a.unitId
        ? await ctx.db
            .query("lessons")
            .withIndex("by_unit", (q) => q.eq("unitId", a.unitId!))
            .collect()
        : [];
      for (const l of lessons) {
        if (scheduled >= MAX_CHECKS_PER_RUN) break;
        const acts = await ctx.db
          .query("activities")
          .withIndex("by_lesson", (q) => q.eq("lessonId", l._id))
          .collect();
        for (const act of acts) {
          // Skip kinds the digest doesn't cover — saves a no-op scheduled
          // check (maybeAutoGenerate would skip them anyway).
          if (act.kind === "shareBack" || act.kind === "web" || act.kind === "game")
            continue;
          if (scheduled >= MAX_CHECKS_PER_RUN) break;
          await ctx.scheduler.runAfter(
            0,
            internal.classDigests.maybeAutoGenerate,
            { scope: "activity", assignmentId: a._id, activityId: act._id },
          );
          scheduled++;
        }
      }
    }
    return { scheduled };
  },
});

// ── Internal writes used by the AI action ──────────────────────────────

const momentValidator = v.object({
  kind: v.union(
    v.literal("breakthrough"),
    v.literal("misconception"),
    v.literal("offTask"),
    v.literal("insight"),
    v.literal("needsHelp"),
  ),
  scholarId: v.id("users"),
  scholarName: v.string(),
  sessionId: v.optional(v.id("sessions")),
  headline: v.string(),
  detail: v.string(),
});

type DigestRowArgs = {
  scope: DigestScope;
  // Optional so setError can record a failure whose row must be inserted
  // (there is no existing row to patch); the insert path requires it.
  assignmentId?: Id<"assignments">;
  activityId?: Id<"activities">;
};

/** Locate the existing row for a write. */
async function findRowForArgs(
  ctx: QueryCtx,
  args: DigestRowArgs,
): Promise<Doc<"classDigests"> | null> {
  if (!args.assignmentId) return null;
  return findRow(ctx, args.scope, args.assignmentId, args.activityId);
}

/** The identity columns for a fresh classDigests insert, per scope. Requires a
 *  concrete assignmentId (a required column on the row). */
function rowIdentity(args: DigestRowArgs & { assignmentId: Id<"assignments"> }) {
  return {
    scope: args.scope,
    assignmentId: args.assignmentId,
    activityId: args.scope === "activity" ? args.activityId : undefined,
  };
}

export const setReady = internalMutation({
  args: {
    scope: v.union(v.literal("activity"), v.literal("cohort")),
    assignmentId: v.id("assignments"),
    activityId: v.optional(v.id("activities")),
    headline: v.string(),
    summary: v.string(),
    themes: v.array(v.object({ title: v.string(), body: v.string() })),
    moments: v.array(momentValidator),
    discussionPrompts: v.array(v.string()),
  },
  handler: async (ctx, args) => {
    const existing = await findRowForArgs(ctx, args);
    const content = {
      status: "ready" as const,
      error: undefined,
      generatedAt: Date.now(),
      headline: args.headline,
      summary: args.summary,
      themes: args.themes,
      moments: args.moments,
      discussionPrompts: args.discussionPrompts,
    };
    if (existing) {
      await ctx.db.patch(existing._id, content);
    } else {
      await ctx.db.insert("classDigests", {
        ...rowIdentity(args),
        ...content,
      });
    }
  },
});

export const setError = internalMutation({
  args: {
    scope: v.union(v.literal("activity"), v.literal("cohort")),
    // Optional so a failure can be recorded even when there's no existing row
    // to patch (the insert path below requires it).
    assignmentId: v.optional(v.id("assignments")),
    activityId: v.optional(v.id("activities")),
    error: v.string(),
  },
  handler: async (ctx, args) => {
    const existing = await findRowForArgs(ctx, args);
    // Stamp generatedAt as a last-ATTEMPT time even on failure, so the
    // auto-regen debounce in maybeAutoGenerate backs off a persistently
    // failing digest (5-min retry cadence) instead of re-firing Claude
    // every cron tick. (UI only surfaces this as "generated" for ready
    // rows.)
    if (existing) {
      await ctx.db.patch(existing._id, {
        status: "error",
        error: args.error,
        generatedAt: Date.now(),
      });
    } else if (args.assignmentId) {
      // No existing row to patch — insert one. Requires the assignmentId
      // (a required column); without it there's nothing to record and nothing
      // stuck, so we no-op.
      await ctx.db.insert("classDigests", {
        ...rowIdentity({ ...args, assignmentId: args.assignmentId }),
        status: "error",
        error: args.error,
        generatedAt: Date.now(),
      });
    }
  },
});
