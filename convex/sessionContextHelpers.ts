/**
 * Pure context-shaping helpers for `sessionHelpers.getSessionContext`.
 *
 * `getSessionContext` is a large `internalQuery` that does ~20 DB reads and then
 * shapes the results into the typed context the tutor system-prompt builder
 * consumes. The reads must stay in the query (they touch `ctx.db`), but the
 * *shaping* — view-as identity resolution, reading-level precedence, mastery /
 * signal / seed aggregation, timing-window selection, prior-activity enrichment
 * — is pure. Splitting it out here keeps the query a thin "read tables → call
 * shaper" shell and lets the branching/aggregation/ordering logic (the parts
 * that actually carry bugs) be unit-tested without a deployment.
 *
 * These helpers take already-fetched rows (typed structurally, so tests can pass
 * plain objects) and return the same shapes the query returned inline before.
 * Types only flow in one direction at runtime: this module imports only *types*
 * from `./sessionHelpers`; `sessionHelpers` imports these functions.
 */
import type { Id } from "./_generated/dataModel";
import type { ActivityKind } from "../lib/activityKinds";
import type { GameSessionDigest } from "../lib/games/digest";
import { getGame } from "../lib/games/catalog";
import { renderDigestForModel } from "../lib/games/promptContext";
import type {
  GameRoundContext,
  MasteryContextEntry,
  SignalContext,
  SeedData,
  TimingContext,
  PriorActivityContext,
} from "./sessionHelpers";

// ── View-as identity ──────────────────────────────────────────────────

/** Project fields that determine whose scholar-scoped data the tutor sees. */
export type ContextIdentitySession = {
  isTestDrive?: boolean;
  testDriveAsScholarId?: Id<"users">;
  testDriveSyntheticName?: string;
  testDriveSyntheticReadingLevel?: string;
  testDriveSyntheticDossier?: string;
  userId: Id<"users">;
};

/**
 * Resolve the "context identity" — whose dossier / mastery / signals / seeds /
 * directives / reading level the tutor should see, and whether this is a
 * fully-synthetic test-drive view (which skips all scholar-keyed DB reads).
 *
 * - `testDriveAsScholarId` set → render as that real scholar.
 * - any synthetic field set (and no real-scholar override) → synthetic view.
 * - neither → render as the project owner.
 */
export function resolveContextIdentity(session: ContextIdentitySession): {
  isSyntheticView: boolean;
  contextUserId: Id<"users">;
} {
  const isSyntheticView =
    !!session.isTestDrive &&
    !session.testDriveAsScholarId &&
    (session.testDriveSyntheticName !== undefined ||
      session.testDriveSyntheticReadingLevel !== undefined ||
      session.testDriveSyntheticDossier !== undefined);
  const contextUserId =
    session.isTestDrive && session.testDriveAsScholarId
      ? session.testDriveAsScholarId
      : session.userId;
  return { isSyntheticView, contextUserId };
}

/**
 * Reading-level precedence: a per-project override always wins; then in a
 * synthetic view the synthetic level, otherwise the context scholar's stored
 * level; else null.
 */
export function resolveReadingLevel(args: {
  isSyntheticView: boolean;
  readingLevelOverride: string | undefined;
  syntheticReadingLevel: string | undefined;
  scholarReadingLevel: string | null | undefined;
}): string | null {
  if (args.isSyntheticView) {
    return args.readingLevelOverride ?? args.syntheticReadingLevel ?? null;
  }
  return args.readingLevelOverride ?? args.scholarReadingLevel ?? null;
}

/**
 * Return a human display name suitable for the AI's greeting, or null if the
 * stored name looks like an auto-generated username (digits, underscores, or
 * identical to username). Real first names don't contain digits/underscores.
 */
export function friendlyScholarName(
  name: string | null | undefined,
  username: string | null | undefined,
): string | null {
  if (!name) return null;
  if (username && name === username) return null;
  if (/[_0-9]/.test(name)) return null;
  return name;
}

// ── Session history ────────────────────────────────────────────────────

export type SessionRow = {
  _id: Id<"sessions">;
  isTestDrive?: boolean;
  isOffline?: boolean;
  lastMessageAt?: number;
  _creationTime: number;
};

/**
 * From all of the scholar's projects, decide whether this is their first-ever
 * real session and (if not) the timestamp of their most recent prior one. Skips
 * the current project, test drives, and offline projects.
 */
export function resolveSessionHistory(
  scholarSessions: SessionRow[],
  currentProjectId: Id<"sessions">,
): { isFirstSession: boolean; lastSessionAt: number | null } {
  const priorSessions = scholarSessions.filter(
    (p) => p._id !== currentProjectId && !p.isTestDrive && !p.isOffline,
  );
  let lastSessionAt: number | null = null;
  for (const p of priorSessions) {
    const ts = p.lastMessageAt ?? p._creationTime;
    if (lastSessionAt === null || ts > lastSessionAt) lastSessionAt = ts;
  }
  return { isFirstSession: priorSessions.length === 0, lastSessionAt };
}

// ── Mastery / signals ──────────────────────────────────────────────────

export type MasteryObservationRow = {
  conceptLabel: string;
  domain: string;
  masteryLevel: number;
  confidenceScore: number;
  evidenceSummary: string;
  studentInitiated: boolean;
};

/** Shape current (non-superseded) mastery observations for the prompt. */
export function buildMasteryContext(
  masteryObs: MasteryObservationRow[],
): MasteryContextEntry[] | null {
  if (masteryObs.length === 0) return null;
  return masteryObs.map((o) => ({
    concept: o.conceptLabel,
    domain: o.domain,
    level: o.masteryLevel,
    confidence: o.confidenceScore,
    evidence: o.evidenceSummary,
    studentInitiated: o.studentInitiated,
  }));
}

/** Aggregate recent session signals into per-type {count, highCount}. */
export function buildSignalContext(
  recentSignals: { signalType: string; intensity: string }[],
): SignalContext | null {
  const signalProfile: SignalContext = {};
  for (const s of recentSignals) {
    if (!signalProfile[s.signalType]) {
      signalProfile[s.signalType] = { count: 0, highCount: 0 };
    }
    signalProfile[s.signalType].count++;
    if (s.intensity === "high") signalProfile[s.signalType].highCount++;
  }
  return Object.keys(signalProfile).length > 0 ? signalProfile : null;
}

// ── Seeds ──────────────────────────────────────────────────────────────

export type SeedRow = {
  topic: string;
  domain?: string;
  approachHint?: string;
  suggestionType: string;
};

/**
 * Merge active (teacher-approved) and pending (unreviewed) seeds into one list,
 * approved first, each stamped with an `approved` flag for the prompt builder.
 */
export function mergeSeeds(
  activeSeeds: SeedRow[],
  pendingSeeds: SeedRow[],
): SeedData[] {
  const shape = (s: SeedRow, approved: boolean): SeedData => ({
    topic: s.topic,
    domain: s.domain ?? null,
    approachHint: s.approachHint ?? null,
    suggestionType: s.suggestionType,
    approved,
  });
  return [
    ...activeSeeds.map((s) => shape(s, true)),
    ...pendingSeeds.map((s) => shape(s, false)),
  ];
}

// ── Timing ─────────────────────────────────────────────────────────────

export type ScheduleEntryLite = {
  mode: string;
  endsAt?: number;
  activityId?: Id<"activities">;
};

/**
 * Resolve the tutor's pacing window. Picks the soonest-ending, still-active
 * `classFocus` push in the assignment's schedule that targets this project's
 * activity (or any active push when the project isn't activity-specific). Falls
 * back to the unit's soft duration when no active focus exists; null when
 * neither applies. `now` is injected for determinism.
 */
export function resolveTimingContext(args: {
  activitySchedule: ScheduleEntryLite[] | undefined;
  sessionActivityId: Id<"activities"> | undefined;
  sessionStartedAt: number;
  unitDurationMinutes: number | null | undefined;
  now: number;
}): TimingContext | null {
  const { activitySchedule, sessionActivityId, sessionStartedAt, now } = args;
  const unitDurationMinutes = args.unitDurationMinutes ?? null;

  let classFocusEndsAt: number | null = null;
  if (activitySchedule) {
    for (const entry of activitySchedule) {
      if (entry.mode !== "classFocus") continue;
      if (!entry.endsAt || entry.endsAt <= now) continue;
      if (sessionActivityId && entry.activityId !== sessionActivityId) continue;
      if (classFocusEndsAt === null || entry.endsAt < classFocusEndsAt) {
        classFocusEndsAt = entry.endsAt;
      }
    }
  }

  if (classFocusEndsAt && now <= classFocusEndsAt) {
    return {
      unitEndsAt: classFocusEndsAt,
      sessionStartedAt,
      unitDurationMinutes,
    };
  }
  if (unitDurationMinutes) {
    return {
      unitEndsAt: null,
      sessionStartedAt,
      unitDurationMinutes,
    };
  }
  return null;
}

// ── Prior activities ───────────────────────────────────────────────────

export type ActivityLite = {
  title: string;
  kind: ActivityKind;
  description?: string;
};

export type CompletionRow = {
  activityId: Id<"activities">;
  lessonId?: Id<"lessons">;
  completedAt: number;
  note?: string;
};

/**
 * Enrich the scholar's prior completions in this unit into the prompt shape,
 * sorted oldest-first. Completions whose activity can't be resolved are dropped;
 * scholar-scoped completions (no lesson) render with a "(scholar task)" label.
 * Returns null when nothing survives enrichment.
 */
export function enrichPriorActivities(args: {
  completions: CompletionRow[];
  activityById: Map<Id<"activities">, ActivityLite | null | undefined>;
  lessonById: Map<Id<"lessons">, { title: string } | null | undefined>;
}): PriorActivityContext[] | null {
  const enriched: PriorActivityContext[] = [];
  for (const c of args.completions) {
    const a = args.activityById.get(c.activityId);
    if (!a) continue;
    const l = c.lessonId ? args.lessonById.get(c.lessonId) : null;
    enriched.push({
      title: a.title,
      kind: a.kind,
      description: a.description ?? null,
      lessonTitle: l?.title ?? "(scholar task)",
      completedAt: c.completedAt,
      note: c.note ?? null,
    });
  }
  enriched.sort((a, b) => a.completedAt - b.completedAt);
  return enriched.length > 0 ? enriched : null;
}

// ── Recent game rounds ──────────────────────────────────────────────────

export type GameDigestRow = {
  activityId: Id<"activities">;
  gameId: string;
  digestJson: string;
};

export type GameDigestActivityLite = {
  title: string;
  lessonId?: Id<"lessons">;
};

/**
 * Keep the newest round per distinct game activity in the current lesson,
 * capped at two, and render each through the canonical model-facing formatter.
 * `digestRows` must already be newest-first and capped by the query.
 */
export function buildGameRoundContexts(args: {
  currentLessonId: Id<"lessons">;
  digestRows: GameDigestRow[];
  activityById: Map<
    Id<"activities">,
    GameDigestActivityLite | null | undefined
  >;
}): GameRoundContext[] | null {
  const contexts: GameRoundContext[] = [];
  const seenActivities = new Set<Id<"activities">>();

  for (const row of args.digestRows) {
    if (seenActivities.has(row.activityId)) continue;
    const activity = args.activityById.get(row.activityId);
    if (!activity || activity.lessonId !== args.currentLessonId) continue;

    // A context read must never be able to take down the tutor stream: skip a
    // digest row that cannot be parsed and rendered rather than throwing.
    let rendered: string;
    try {
      const digest = JSON.parse(row.digestJson) as GameSessionDigest;
      rendered = renderDigestForModel(digest, { maxLines: 14 });
    } catch {
      continue;
    }
    seenActivities.add(row.activityId);
    contexts.push({
      activityTitle: activity.title,
      gameTitle: getGame(row.gameId)?.title ?? row.gameId,
      rendered,
    });
    if (contexts.length === 2) break;
  }

  return contexts.length > 0 ? contexts : null;
}
