import { v } from "convex/values";
import { authedQuery, scholarAdminQuery, teacherMutation, teacherQuery } from "./lib/customFunctions";
import { internalQuery, internalMutation } from "./_generated/server";
import { isNonTeachingOperationsRole } from "./lib/roles";
import { requireScholarAdminOrSelf } from "./lib/auth";
import {
  requireActiveScholarAccess,
  requireScholarsAccessible,
  filterToAccessibleScholars,
} from "./lib/access";
import {
  decideEstimateWrite,
  isPreReader,
  isValidReadingLevel,
  type EstimateWriteDecision,
} from "./lib/readingLevels";
import { scholarHasPasswordCredential } from "./lib/scholarCredential";
import { underscoreUsername } from "./lib/username";
import { isValidGradeLevel } from "./lib/standardStrand";
import {
  resolveInstitutionLens,
  scholarIdsInLens,
} from "./lib/institutionLens";
import {
  computeRosterPulse,
  type RosterAnalysisRow,
  type ScholarPulse,
} from "./lib/rosterPulse";
import { timeZoneForInstitution } from "./lib/institutionTime";
import { dayStartForTimezone } from "../shared/institutionDay";
import type { Id } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { hasScholarMembership } from "./lib/scholarEnrollment";

/**
 * Resolve a scholar URL slug → its non-sensitive header identity. The slug is normally the
 * friendly username (a `by_username` indexed point read), but we ALSO fall back
 * to a raw user id (via `normalizeId`, which never throws) so resolution is
 * total. That matters because the per-scholar detail fires this in PARALLEL with
 * the (heavier) roster query (`users.listScholars`): on a cold deep-link the
 * detail resolves before the roster's username map is ready, so a URL the layout
 * builds in that window (e.g. clicking a sub-tab) can still carry the raw id —
 * which must resolve, not 404. Returning the `username` lets the layout emit the
 * friendly URL for the selected scholar even before the roster loads. Returns
 * null for an unknown slug or a non-scholar.
 */
export const resolveSlug = scholarAdminQuery({
  args: { slug: v.string() },
  handler: async (ctx, { slug }) => {
    // Prefer the username (the canonical, friendly URL form).
    let u = await ctx.db
      .query("users")
      .withIndex("by_username", (q) => q.eq("username", slug))
      .first();
    // Fall back to a raw user id. normalizeId returns null (never throws) for a
    // non-id string, so a stray username miss can't error.
    if (!u) {
      const id = ctx.db.normalizeId("users", slug);
      if (id) u = await ctx.db.get(id);
    }
    // Stale-link fallback, in the SAME direction as the migration: a handful of
    // scholars were created before usernames rejected spaces, and
    // `migrations.normalizeSpacedUsernames` rewrote those to the underscore
    // form. A bookmark or Slack link minted before that carries the spaced name
    // (arriving here decoded from `%20`), which no longer matches any username —
    // so retry the underscore form the migration would have produced. This is
    // the exact inverse of the rename, never a guess: we do NOT map underscores
    // BACK to spaces, because `_` and `-` are legitimate username characters and
    // that direction is ambiguous (slug `mary-jane_doe` would match a different
    // scholar named `mary jane doe`).
    if (!u && /\s/.test(slug)) {
      const underscored = underscoreUsername(slug);
      if (underscored && underscored !== slug) {
        u = await ctx.db
          .query("users")
          .withIndex("by_username", (q) => q.eq("username", underscored))
          .first();
      }
    }
    if (!u || !(await hasScholarMembership(ctx, u._id))) return null;
    // Institution boundary. `scholarAdminQuery` checks ROLE only, so without
    // this a teacher at school A could resolve a scholar at school B and read
    // back their raw user id + username — the enumeration oracle every other
    // scholar-keyed query in this file already closes with the access helpers.
    // Use the FILTERING form: an out-of-context slug should look indistinguish-
    // able from a nonexistent one (null), not raise.
    const [accessible] = await filterToAccessibleScholars(ctx, ctx.user, [u._id]);
    if (!accessible) return null;
    return {
      id: u._id,
      username: u.username ?? null,
      name: u.name ?? null,
      image: u.image ?? null,
      enrollmentStanding: u.enrollmentStanding ?? "enrolled",
    };
  },
});

/**
 * Get a scholar's profile with stats.
 * Topics and suggestions have been replaced by masteryObservations and seeds.
 */
export const getProfile = authedQuery({
  args: { scholarId: v.id("users") },
  handler: async (ctx, args) => {
    // Non-sensitive (identity + counts) → operations staff is allowed here too.
    const isScholarAdmin = await requireScholarAdminOrSelf(
      ctx,
      ctx.user,
      args.scholarId,
    );
    // Boundary: a staff caller may only read a scholar in their active
    // context (their institution). Self-reads bypass. No-op until enforcement
    // is enabled. See convex/lib/access.ts.
    if (isScholarAdmin) {
      await requireActiveScholarAccess(ctx, ctx.user, args.scholarId);
    }

    // Reading level is a sensitive measurement operations staff must not see —
    // stripped from the operations staff roster (users.listScholars) and the UI,
    // so redact it on this direct-read path as well.
    const redactReadingLevel = isNonTeachingOperationsRole(ctx.user.role);

    const scholar = await ctx.db.get(args.scholarId);
    if (!scholar || !(await hasScholarMembership(ctx, args.scholarId))) {
      throw new Error("Scholar not found");
    }

    // Get project stats
    const sessions = (await ctx.db
      .query("sessions")
      .withIndex("by_user", (q) => q.eq("userId", args.scholarId))
      .collect())
      // Offline projects (scanned-deliverable containers) and test-drive
      // dry-runs aren't real chat sessions — keep them out of the stats.
      .filter((p) => !p.isOffline && !p.isTestDrive);

    let messageCount = 0;
    for (const proj of sessions) {
      const msgs = await ctx.db
        .query("messages")
        .withIndex("by_session", (q) =>
          q.eq("sessionId", proj._id)
        )
        .collect();
      messageCount += msgs.length;
    }

    // Count mastery observations (replaces topicCount)
    const observations = await ctx.db
      .query("masteryObservations")
      .withIndex("by_scholar_current", (q) =>
        q.eq("scholarId", args.scholarId).eq("isSuperseded", false)
      )
      .collect();

    // Whether a stored PIN exists — drives "Create PIN" vs "Reset PIN" on the
    // profile's Account card, matching the roster (users.listScholars). Boolean
    // only, non-sensitive (operations-staff-safe). See lib/scholarCredential.ts.
    const hasCredential = await scholarHasPasswordCredential(
      ctx,
      args.scholarId,
    );

    return {
      scholar: {
        id: scholar._id,
        name: scholar.name,
        username: scholar.username ?? null,
        image: scholar.image,
        hasCredential,
        dateOfBirth: scholar.dateOfBirth ?? null,
        // Chronological grade notch (Knowledge Tree). Roster info, not a
        // measurement — not redacted from operations staff.
        gradeLevel: scholar.gradeLevel ?? null,
        enrollmentStanding: scholar.enrollmentStanding ?? "enrolled",
        externalSchoolName: scholar.externalSchoolName ?? null,
        // Which institution (school) the scholar belongs to. Roster info, not
        // a measurement — operations staff manage it. See convex/institutions.ts.
        institutionId: scholar.institutionId ?? null,
        readingLevel: redactReadingLevel ? null : scholar.readingLevel ?? null,
        readingLevelSuggestion: redactReadingLevel
          ? null
          : scholar.readingLevelSuggestion ?? null,
        // When the pending estimate was computed. Without it the UI cannot tell
        // a disagreement recorded this morning from one recorded in March.
        // DEPENDS ON pending schema addition users.readingLevelSuggestionAt.
        readingLevelSuggestionAt: redactReadingLevel
          ? null
          : scholar.readingLevelSuggestionAt ?? null,
        ttsEnabled: scholar.ttsEnabled ?? true,
        sttEnabled: scholar.sttEnabled ?? true,
        createdAt: scholar._creationTime,
      },
      stats: {
        sessionCount: sessions.length,
        messageCount,
        observationCount: observations.length,
      },
    };
  },
});

/**
 * Update a scholar's reading level (teachers only).
 */
export const updateReadingLevel = teacherMutation({
  args: {
    scholarId: v.id("users"),
    readingLevel: v.union(v.string(), v.null()),
  },
  handler: async (ctx, args) => {
    await requireActiveScholarAccess(ctx, ctx.user, args.scholarId);
    if (args.readingLevel !== null && !isValidReadingLevel(args.readingLevel)) {
      throw new Error("Invalid reading level");
    }

    const scholar = await ctx.db.get(args.scholarId);
    if (!scholar || !(await hasScholarMembership(ctx, args.scholarId))) {
      throw new Error("Scholar not found");
    }

    await ctx.db.patch(args.scholarId, {
      readingLevel: args.readingLevel ?? undefined,
      // Clear the pending writing-derived estimate: the teacher has now ruled on
      // it, so any stored disagreement is superseded. Clearing the stamp too
      // keeps "no estimate" and "an estimate of unknown age" distinguishable.
      // DEPENDS ON pending schema addition users.readingLevelSuggestionAt.
      readingLevelSuggestion: undefined,
      readingLevelSuggestionAt: undefined,
    });
    if (args.readingLevel !== null) {
      await ctx.db.insert("readingLevelHistory", {
        scholarId: args.scholarId,
        level: args.readingLevel,
        source: "teacher",
        changedBy: ctx.user._id,
      });
    }
  },
});

/**
 * Internal: set a scholar's CHRONOLOGICAL grade-level notch (users.gradeLevel).
 * Exists for CLI/admin backfills (`npx convex run`), since the teacher-facing
 * setter (users.adminUpdateScholarProfile) requires an auth identity the CLI
 * doesn't carry. Pass null to clear. See convex/acceleration.ts for the notch.
 */
export const setGradeLevelInternal = internalMutation({
  args: {
    scholarId: v.id("users"),
    gradeLevel: v.union(v.string(), v.null()),
  },
  handler: async (ctx, args) => {
    if (args.gradeLevel !== null && !isValidGradeLevel(args.gradeLevel)) {
      throw new Error("Invalid grade level");
    }
    const scholar = await ctx.db.get(args.scholarId);
    if (!scholar || !(await hasScholarMembership(ctx, args.scholarId))) {
      throw new Error("Scholar not found");
    }
    await ctx.db.patch(args.scholarId, {
      gradeLevel: args.gradeLevel ?? undefined,
    });
  },
});

/**
 * Internal: correct a scholar's enrollment standing from the CLI.
 *
 * Extended Education boundaries key off this field, so legacy scholars must be
 * explicitly marked before enrolled-only rosters and agents can exclude them.
 */
export const setEnrollmentStandingInternal = internalMutation({
  args: {
    scholarId: v.id("users"),
    enrollmentStanding: v.union(
      v.literal("enrolled"),
      v.literal("program_guest"),
    ),
  },
  handler: async (ctx, args) => {
    const scholar = await ctx.db.get(args.scholarId);
    if (!scholar || !(await hasScholarMembership(ctx, args.scholarId))) {
      throw new Error("Scholar not found");
    }
    await ctx.db.patch(args.scholarId, {
      enrollmentStanding: args.enrollmentStanding,
    });
    return {
      scholarId: args.scholarId,
      enrollmentStanding: args.enrollmentStanding,
    };
  },
});

/**
 * Internal query to get a scholar's user record (for observer).
 */
export const getInternal = internalQuery({
  args: { scholarId: v.id("users") },
  handler: async (ctx, args) => {
    return await ctx.db.get(args.scholarId);
  },
});

/**
 * Fan-out bound for `levelSignalsForScholars`. Over this, throw rather than
 * truncate — a silently short roster on a projected board is a wrong number.
 */
export const LEVEL_SIGNALS_MAX_SCHOLARS = 60;

/** One scholar's level signals. See `levelSignalsForScholars` for the contract. */
export interface LevelSignalRow {
  scholarId: Id<"users">;
  /** The human-ratified setting the tutor acts on. */
  confirmed: {
    level: string | null;
    isPreReader: boolean;
    /** When a human last ratified this exact value; null if unrecorded. */
    setAt: number | null;
    setBy: "teacher" | "observer" | null;
  };
  /** The writing-derived estimate. Present only while it disagrees. */
  estimate: {
    level: string | null;
    computedAt: number | null;
    ageDays: number | null;
    disagreesWithConfirmed: boolean;
  };
}

/**
 * Record a **writing-derived** grade-level estimate for a scholar.
 *
 * ⚠️ This is the single writer for `users.readingLevelSuggestion`. It is named
 * for the stored field, but what it stores is an estimate produced entirely from
 * the scholar's own PRODUCTION — typed tutor-chat messages plus OCR-transcribed
 * handwritten work. Nothing in its evidence chain observes what the scholar can
 * READ. It is not a Lexile measure, not a normed assessment, not a screener
 * result. See `convex/lib/readingLevels.ts` for the full record of what the two
 * reading-level values are and are not.
 *
 * The confirmed level (`users.readingLevel`) is a different real thing: a
 * human-ratified setting the tutor acts on. This function never touches it.
 *
 * The decision itself — including recording AGREEMENT, which the observer used
 * to drop on the floor — is the pure `decideEstimateWrite`; this is only the
 * database half. Returns what it did, so callers can log or test it.
 */
async function recordWritingDerivedEstimate(
  ctx: { db: MutationCtx["db"] },
  args: {
    scholarId: Id<"users">;
    estimate: string;
    now: number;
    /** Skip the freshness guard — for explicit, teacher-initiated analysis. */
    force?: boolean;
  },
): Promise<EstimateWriteDecision["action"] | "not_found"> {
  const scholar = await ctx.db.get(args.scholarId);
  if (!scholar || !(await hasScholarMembership(ctx, args.scholarId))) {
    return "not_found";
  }

  const decision = decideEstimateWrite({
    confirmed: scholar.readingLevel ?? null,
    pending: scholar.readingLevelSuggestion ?? null,
    // DEPENDS ON pending schema addition users.readingLevelSuggestionAt (routed
    // separately) — see the report accompanying this change.
    pendingAt: scholar.readingLevelSuggestionAt ?? null,
    estimate: args.estimate,
    now: args.now,
    force: args.force,
  });
  if (decision.action === "skipped") return "skipped";

  await ctx.db.patch(args.scholarId, {
    readingLevelSuggestion: decision.nextSuggestion,
    readingLevelSuggestionAt: args.now,
  });
  return decision.action;
}

/**
 * Internal: record the observer's writing-derived grade-level estimate.
 *
 * Called on the tutor-session hot path. Agreement with the confirmed level is
 * recorded too (by clearing any superseded suggestion), so what a teacher sees is
 * always current evidence rather than a stale disagreement. Bounded by
 * `ESTIMATE_REFRESH_MS` so repeated sessions do not thrash the doc.
 */
export const setReadingLevelSuggestion = internalMutation({
  args: {
    scholarId: v.id("users"),
    suggestion: v.string(),
  },
  handler: async (ctx, args) => {
    return await recordWritingDerivedEstimate(ctx, {
      scholarId: args.scholarId,
      estimate: args.suggestion,
      now: Date.now(),
    });
  },
});

/**
 * Teacher accepts the pending writing-derived estimate — promotes it to the
 * confirmed level (a human-ratified setting the tutor acts on) and clears the
 * estimate, which is now superseded by the teacher's ruling.
 */
export const acceptReadingLevelSuggestion = teacherMutation({
  args: { scholarId: v.id("users") },
  handler: async (ctx, args) => {
    await requireActiveScholarAccess(ctx, ctx.user, args.scholarId);
    const scholar = await ctx.db.get(args.scholarId);
    if (!scholar || !scholar.readingLevelSuggestion) return;
    await ctx.db.patch(args.scholarId, {
      readingLevel: scholar.readingLevelSuggestion,
      readingLevelSuggestion: undefined,
      // DEPENDS ON pending schema addition users.readingLevelSuggestionAt.
      readingLevelSuggestionAt: undefined,
    });
    await ctx.db.insert("readingLevelHistory", {
      scholarId: args.scholarId,
      level: scholar.readingLevelSuggestion,
      source: "observer",
      changedBy: ctx.user._id,
    });
  },
});

/**
 * Get the scholar's CONFIRMED reading-level history (teachers only).
 *
 * Every row here is a human-ratified transition — a teacher setting the level, or
 * a teacher accepting an estimate. Machine estimates are deliberately NOT written
 * to this table: it is the record of settings the system acted on, and mixing
 * unratified guesses in would make existing consumers plot guesses as decisions.
 */
export const getReadingLevelHistory = teacherQuery({
  args: { scholarId: v.id("users") },
  handler: async (ctx, args) => {
    await requireActiveScholarAccess(ctx, ctx.user, args.scholarId);
    const history = await ctx.db
      .query("readingLevelHistory")
      .withIndex("by_scholar", (q) => q.eq("scholarId", args.scholarId))
      .order("desc")
      .collect();
    return history;
  },
});

/**
 * Weekly board read model for a scholar's **level signals**, roster-shaped.
 *
 * ⚠️ This returns TWO STRUCTURALLY DISTINCT THINGS, and they must stay distinct
 * on screen. They are not two measurements of one quantity:
 *
 *  • `confirmed` — the human-ratified SETTING the system acts on. It is rendered
 *    into the tutor's prompt, and `pre-reader` switches the tutor to a K register
 *    with voice-first defaults. A teacher owns it. `setAt` is when a human last
 *    ratified it (from `readingLevelHistory`), NOT when anything was measured.
 *
 *  • `estimate` — a WRITING-DERIVED grade-level estimate. Every input is the
 *    scholar's own production: typed tutor-chat messages plus OCR-transcribed
 *    handwritten work. Nothing in it observes what the scholar can READ. Not a
 *    Lexile measure, not a normed assessment, not a screener result. It exists
 *    only while it DISAGREES with the confirmed level — agreement clears it (see
 *    `setReadingLevelSuggestion`), so a present estimate always means "current
 *    evidence disagrees with the setting".
 *
 * Deliberately NOT returned:
 *  • Any week-over-week movement of the estimate. Only the latest value is
 *    stored, so a delta cannot be computed honestly today; the retained series
 *    proposed alongside this change is what would make one possible.
 *  • Any reading-COMPREHENSION claim. No reception evidence exists anywhere in
 *    this system, so there is no honest number to render.
 *  • The mechanical writing trend — that is a separate instrument
 *    (`lib/readingTrend.ts`: Flesch–Kincaid over 90 days of typed messages in
 *    seven-day buckets). Two instruments, kept legibly distinct, never merged.
 *
 * Tenancy: `teacherQuery` checks ROLE only, so the handler gates every requested
 * id through `requireScholarsAccessible`. Fan-out is bounded; over the cap this
 * throws rather than silently truncating a roster.
 */
export const levelSignalsForScholars = teacherQuery({
  args: { scholarIds: v.array(v.id("users")) },
  handler: async (ctx, args) => {
    const unique = Array.from(new Set(args.scholarIds));
    if (unique.length > LEVEL_SIGNALS_MAX_SCHOLARS) {
      throw new Error(
        `Too many scholars requested (${unique.length} > ${LEVEL_SIGNALS_MAX_SCHOLARS}). Page the roster.`,
      );
    }
    await requireScholarsAccessible(ctx, ctx.user, unique);

    // The reading level is a sensitive measurement operations staff must not
    // see — same boundary the scholar profile enforces.
    if (isNonTeachingOperationsRole(ctx.user.role)) {
      throw new Error("Forbidden: reading level is not visible to this role");
    }

    const now = Date.now();
    const rows: LevelSignalRow[] = [];
    for (const scholarId of unique) {
      const scholar = await ctx.db.get(scholarId);
      if (!scholar || !(await hasScholarMembership(ctx, scholarId))) continue;

      const ratified = await ctx.db
        .query("readingLevelHistory")
        .withIndex("by_scholar", (q) => q.eq("scholarId", scholarId))
        .order("desc")
        .first();

      const confirmedLevel = scholar.readingLevel ?? null;
      const estimateLevel = scholar.readingLevelSuggestion ?? null;
      // DEPENDS ON pending schema addition users.readingLevelSuggestionAt.
      const estimateAt = scholar.readingLevelSuggestionAt ?? null;

      rows.push({
        scholarId,
        confirmed: {
          level: confirmedLevel,
          isPreReader: isPreReader(confirmedLevel),
          // Only meaningful when the latest history row matches the live value;
          // a level set before this table existed has no ratification record.
          setAt:
            ratified && ratified.level === confirmedLevel
              ? ratified._creationTime
              : null,
          setBy:
            ratified && ratified.level === confirmedLevel
              ? ratified.source
              : null,
        },
        estimate: {
          level: estimateLevel,
          computedAt: estimateAt,
          ageDays:
            estimateAt === null
              ? null
              : Math.floor((now - estimateAt) / 86_400_000),
          // An estimate is only stored while it disagrees, so its presence IS
          // the disagreement. Made explicit so no consumer has to infer it.
          disagreesWithConfirmed: estimateLevel !== null,
        },
      });
    }

    return { now, rows };
  },
});

/**
 * Teacher dismisses the pending writing-derived estimate.
 */
export const dismissReadingLevelSuggestion = teacherMutation({
  args: { scholarId: v.id("users") },
  handler: async (ctx, args) => {
    await requireActiveScholarAccess(ctx, ctx.user, args.scholarId);
    await ctx.db.patch(args.scholarId, {
      readingLevelSuggestion: undefined,
      // DEPENDS ON pending schema addition users.readingLevelSuggestionAt.
      readingLevelSuggestionAt: undefined,
    });
  },
});

/**
 * Public wrapper so the teacher-triggered analysis action can record its
 * writing-derived estimate. `force`d past the observer's freshness guard: this
 * path is an explicit human action, not a hot path, and the teacher who just
 * pressed the button must see a fresh timestamp.
 *
 * The observer uses the internal version (`setReadingLevelSuggestion`); both go
 * through the same writer, so agreement is recorded on both paths.
 */
export const setReadingLevelSuggestionFromAnalysis = teacherMutation({
  args: { scholarId: v.id("users"), suggestion: v.string() },
  handler: async (ctx, args) => {
    await requireActiveScholarAccess(ctx, ctx.user, args.scholarId);
    return await recordWritingDerivedEstimate(ctx, {
      scholarId: args.scholarId,
      estimate: args.suggestion,
      now: Date.now(),
      force: true,
    });
  },
});

/**
 * Toggle TTS or STT for a scholar (teachers only).
 */
export const updateAudioSettings = teacherMutation({
  args: {
    scholarId: v.id("users"),
    ttsEnabled: v.optional(v.boolean()),
    sttEnabled: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    await requireActiveScholarAccess(ctx, ctx.user, args.scholarId);
    const scholar = await ctx.db.get(args.scholarId);
    if (!scholar || !(await hasScholarMembership(ctx, args.scholarId))) {
      throw new Error("Scholar not found");
    }
    const patch: Record<string, boolean> = {};
    if (args.ttsEnabled !== undefined) patch.ttsEnabled = args.ttsEnabled;
    if (args.sttEnabled !== undefined) patch.sttEnabled = args.sttEnabled;
    if (Object.keys(patch).length > 0) {
      await ctx.db.patch(args.scholarId, patch);
    }
  },
});

// How far back the roster's "Lately" lens reads observer signals. A scholar's
// engagement sparkline is the most recent readings WITHIN this window; the
// trend + recurring-concern aggregates are computed over it too. Three weeks is
// long enough to show a real slope, recent enough to stay actionable.
export const ROSTER_PULSE_WINDOW_DAYS = 21;
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Indexed collector shared by the Scholars roster and the Today inbox. The
 * pure attention model remains `computeRosterPulse`; this only gathers the
 * same in-scope analysis rows without widening the reactive dependency set.
 */
export async function rosterPulseForScholarIds(
  ctx: QueryCtx,
  scholarIds: Iterable<Id<"users">>,
  since: number,
  // Exclusive upper bound. The roster's "Lately" pulse wants everything since a
  // cutoff, so it leaves this open. Rounds reads a FIXED past week, where an
  // open end would fold every later analysis into the week being discussed —
  // a week the room is asked to treat as settled would keep changing, and a
  // genuinely quiet week would look busy.
  until: number = Number.POSITIVE_INFINITY,
): Promise<ScholarPulse[]> {
  const rows: RosterAnalysisRow[] = [];
  for (const uid of scholarIds) {
    const sessions = await ctx.db
      .query("sessions")
      .withIndex("by_user", (q) => q.eq("userId", uid))
      .collect();
    for (const session of sessions) {
      // Same exclusions as the Today lane's stalled-quest session lookup:
      // archived/offline work shouldn't narrate a scholar's "Lately" pulse.
      if (session.isTestDrive || session.isArchived || session.isOffline)
        continue;
      const analyses = await ctx.db
        .query("analyses")
        .withIndex("by_session", (q) => q.eq("sessionId", session._id))
        .collect();
      for (const analysis of analyses) {
        if (analysis._creationTime < since) continue;
        if (analysis._creationTime >= until) continue;
        rows.push({
          scholarId: String(uid),
          sessionId: String(session._id),
          createdAt: analysis._creationTime,
          engagement: analysis.engagementScore ?? null,
          onTask: analysis.onTaskScore ?? null,
          concernFlags: analysis.concernFlags ?? [],
          summary: analysis.summary ?? null,
          suggestedIntervention: analysis.suggestedIntervention ?? null,
        });
      }
    }
  }

  return Object.values(computeRosterPulse(rows).byScholar);
}

/**
 * Which scholars in `scholarIds` practised TODAY — the presence signal folded
 * into the roster read (spec §3.2), adopted from the retired cohort frontier
 * table so the group page keeps a "who hasn't done their reps today" glance
 * without a per-row subscription. Returns the set of scholarIds with any
 * `practiceMastery` row updated since their INSTITUTION-LOCAL midnight (the same
 * day boundary scholar practice + dailyRecap use — not UTC midnight; see
 * FIX_WAVE_PLAN.md T5). The timezone is resolved once per institution.
 *
 * Trivially removable: one field on the roster read, one dot on the row (§3.2's
 * strike option) — nothing else depends on it.
 */
export async function practicedTodayScholarIds(
  ctx: QueryCtx,
  scholarIds: Iterable<Id<"users">>,
  // The reference "now" — a client-passed minute-rounded clock so the live
  // subscription re-runs across institution-local midnight (T11 — match the
  // clock to the claim). Convex reruns a query on changed arguments or database
  // writes, never because wall-clock `Date.now()` advanced; a roster left open
  // would otherwise keep yesterday's dots until an unrelated write. Defaults to
  // `Date.now()` for a server/test caller that doesn't thread a clock.
  nowMs: number = Date.now(),
): Promise<string[]> {
  const dayStartByInstitution = new Map<string, number>();
  const practicedToday: string[] = [];
  for (const scholarId of scholarIds) {
    const scholar = await ctx.db.get(scholarId);
    if (!scholar) continue;
    const instKey = scholar.institutionId ? String(scholar.institutionId) : "";
    let dayStart = dayStartByInstitution.get(instKey);
    if (dayStart === undefined) {
      const timeZone = await timeZoneForInstitution(ctx, scholar.institutionId);
      dayStart = dayStartForTimezone(nowMs, timeZone);
      dayStartByInstitution.set(instKey, dayStart);
    }
    const rows = await ctx.db
      .query("practiceMastery")
      .withIndex("by_scholar", (q) => q.eq("scholarId", scholarId))
      .collect();
    if (rows.some((r) => r.updatedAt >= dayStart)) {
      practicedToday.push(String(scholarId));
    }
  }
  return practicedToday;
}

/**
 * Per-scholar "Lately" pulse for the Scholars roster board — the low-hanging
 * fruit from review/observer-assessment-redesign.md (§"Teacher roster view"):
 * an engagement sparkline, a recent-vs-earlier trend, recurring concern flags,
 * and an attention score/level, all trended off the observer's EXISTING
 * `analyses` rows. No observer redesign, no new writes.
 *
 * The "Now" half (live pulse, current activity, lastMessageAt) already rides
 * `users.listScholars`; this query is the companion "Lately" half, keyed by
 * scholarId so the board can merge them client-side.
 *
 * Scope mirrors `listScholars`: the caller's institution lens (`institutionScope`
 * — a pretty slug, "all", or ""/"primary" for the home school). REGISTRARS get
 * nothing — this is learning data, which they must not see (parity with the
 * operations staff stripping in `users.listScholars`; see registrarGates.test.ts).
 *
 * This is a live `useQuery` subscription mounted on the persistently-visible
 * Scholars tab, so its reactive dependency set matters: rather than
 * `.collect()`ing the whole `analyses` table (which would re-run for every
 * teacher on every observer write, anywhere), we walk each in-lens scholar's own
 * sessions via `by_user` → `by_session` — the same indexed walk `scholarPulse`
 * makes — so an unrelated scholar's write can't invalidate the subscription.
 */
export const rosterPulse = scholarAdminQuery({
  args: {
    institutionScope: v.optional(v.string()),
    /** Override the "Lately" lookback (days). Defaults to 21. */
    windowDays: v.optional(v.number()),
    /** Client-passed minute-rounded clock (T11). An intentional reactive
     *  dependency so the live subscription re-runs across institution-local
     *  midnight — driving both the "Lately" lookback and the practiced-today
     *  day boundary. Defaults to `Date.now()` for a caller that omits it. */
    now: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const windowDays = args.windowDays ?? ROSTER_PULSE_WINDOW_DAYS;
    const nowMs = args.now ?? Date.now();

    // Registrars administer accounts but must never see learning data.
    if (isNonTeachingOperationsRole(ctx.user.role)) {
      return {
        windowDays,
        scholars: [] as ScholarPulse[],
        practicedToday: [] as string[],
      };
    }

    const lens = await resolveInstitutionLens(
      ctx,
      ctx.user,
      args.institutionScope ?? "",
    );
    const scholarIds = await scholarIdsInLens(ctx, lens);

    const since = nowMs - windowDays * DAY_MS;

    return {
      windowDays,
      scholars: await rosterPulseForScholarIds(ctx, scholarIds, since),
      // The practiced-today presence dots (spec §3.2) — one cohort read folded
      // into the same batched subscription, never a per-row query.
      practicedToday: await practicedTodayScholarIds(ctx, scholarIds, nowMs),
    };
  },
});

/**
 * The engagement pulse for a SINGLE scholar — the detail-page version of
 * `rosterPulse`. Powers the "Engagement" tile on the scholar Feed: the same
 * canonical sparkline the roster shows, computed for just this scholar.
 *
 * Like `rosterPulse`, this walks only the scholar's own sessions via the
 * `by_user` / `by_session` indexes (rosterPulse just does it for every scholar
 * in the lens); running it for a single scholar is cheap enough to mount on a
 * detail page without the roster. Access is gated the same way `sessions.list`
 * gates a teacher reading another user's work (`requireActiveScholarAccess`);
 * operations staff get nothing.
 */
export const scholarPulse = scholarAdminQuery({
  args: {
    scholarId: v.id("users"),
    /** Override the "Lately" lookback (days). Defaults to 21. */
    windowDays: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const windowDays = args.windowDays ?? ROSTER_PULSE_WINDOW_DAYS;

    // Registrars administer accounts but must never see learning data.
    if (isNonTeachingOperationsRole(ctx.user.role)) {
      return { windowDays, pulse: null as ScholarPulse | null };
    }
    await requireActiveScholarAccess(ctx, ctx.user, args.scholarId);

    const since = Date.now() - windowDays * DAY_MS;

    const pulses = await rosterPulseForScholarIds(ctx, [args.scholarId], since);
    return {
      windowDays,
      pulse: pulses[0] ?? null,
    };
  },
});
