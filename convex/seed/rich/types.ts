// ─── Rich-cohort seed: the static fixture shape ───────────────────────────
//
// This is the TYPE CONTRACT for the hand-authored + generator-emitted seed
// data in this directory. Every entity is referenced by a stable STRING KEY
// (not a Convex Id, which doesn't exist until insert time); the inserter
// (convex/seedRichCohort.ts) resolves keys → Ids in dependency order.
//
// Timestamps are RELATIVE OFFSETS (days/minutes BEFORE now). The seed is
// "now-anchored": the inserter computes the absolute ms as `Date.now() -
// offset`, so live widgets ("active now", growth-over-time) always light up.
// Author offsets as POSITIVE numbers meaning "this long ago".
//
// Keep this file in lockstep with convex/schema.ts — the vitest harness
// (convex/__tests__/richSeed.test.ts) runs the inserter through the live
// schema validators, so any drift here vs. the real data model fails CI.

import type { ROLES } from "../../lib/roles";
import type { ActivityKind } from "../../../lib/activityKinds";
import type {
  SeedOrigin,
  SeedStatus,
  SeedSuggestionType,
} from "../../lib/seeds";

export type Role = (typeof ROLES)[keyof typeof ROLES];

// A stable string key used to cross-reference fixture entities.
export type Key = string;

// ── Roster ────────────────────────────────────────────────────────────────

export interface SeedTeacher {
  key: Key;
  username: string;
  name: string;
  email?: string;
  role?: "teacher" | "platform_admin"; // default "teacher"
}

export interface SeedScholar {
  key: Key;
  username: string;
  name: string;
  /** "K" | "Grade 1" … "Grade 5" — the scholar's enrolled grade. */
  grade: string;
  /** Reading level string (may differ from grade — mixed-level school). */
  readingLevel?: string;
  readingLevelSuggestion?: string;
  /** ISO date string, e.g. "2018-03-15". */
  dateOfBirth?: string;
  preferredFont?: string;
  /** Full-time school enrollment or access through one extended-education program. */
  enrollmentStanding?: "enrolled" | "program_guest";
}

export interface SeedParent {
  key: Key;
  username: string;
  name: string;
  email: string;
  /** Scholar keys this parent is a guardian of. */
  childKeys: Key[];
  notificationPrefs?: {
    emailEnabled?: boolean;
    smsEnabled?: boolean;
    weeklyDigest?: boolean;
    homeworkReminders?: boolean;
    digestDay?: string;
  };
}

// A scholar cohort (scholarGroups row). One group is the whole thing: the
// social/peer unit (emoji + name surface in scholar-facing features) AND the
// unit a weekly schedule is stamped onto. Membership is defined here, once.
export interface SeedGroup {
  key: Key;
  name: string;
  emoji?: string;
  type?: string;
  /** Creator teacher key (NOT an ownership gate). */
  teacherKey: Key;
  scholarKeys: Key[];
}

export interface SeedTeacherAffinity {
  teacherKey: Key;
  scholarKeys: Key[];
  groupKeys: Key[];
}

export interface SeedDossier {
  scholarKey: Key;
  content: string;
}

export interface SeedDirective {
  scholarKey: Key;
  label: string;
  content: string;
  authorKey: Key;
  isActive?: boolean;
}

export interface SeedReadingLevelHistory {
  scholarKey: Key;
  level: string;
  source: "teacher" | "observer";
  changedByKey?: Key;
  agoDays: number;
}

// ── Weekly schedule ─────────────────────────────────────────────────────────

export interface SeedReportingPeriod {
  key: Key;
  label: string;
  startsAgoDays: number;
  endsInDays: number;
  status: "upcoming" | "open" | "writing" | "closed";
}

export interface SeedScheduleBlock {
  key: Key;
  periodKey: Key;
  label: string;
  startLocal: string;
  endLocal: string;
  weekdays: number[];
  order: number;
  staffNeed?: number;
  kind?: "class" | "recess" | "lunch" | "prep" | "homework";
}

export interface SeedSchedulePlacement {
  periodKey: Key;
  groupKey: Key;
  weekday: number;
  blockKey: Key;
  subject: string;
  teacherKey?: Key;
  /** The "standing assignment" app target (mutually exclusive with a
   *  curriculum activity, which this seed shape doesn't otherwise carry) —
   *  see review/app-access-unification-plan.html §robotics. References a
   *  SeedExternalApp by key. */
  externalAppKey?: Key;
}

/** A minimal catalog-app row, seeded so a schedulePlacement can demo the
 *  standing-assignment app target end to end. */
export interface SeedExternalApp {
  key: Key;
  name: string;
  webUrl: string;
  nativeUrlScheme?: string;
  iconEmoji?: string;
  color?: string;
}

export interface SeedPortfolioItem {
  title: string;
  caption: string;
  scholarKeys: Key[];
  svg: string;
}

// ── Design (curriculum) ─────────────────────────────────────────────────────

export interface SeedGranule {
  key: string;
  text: string;
}

export interface SeedDeliverable {
  kind: "photo" | "artifact" | "slides" | "text" | "audio" | "map";
  prompt: string;
  mode: "manual" | "auto" | "none";
  notes?: string;
  criteria: { id: string; label: string; description?: string }[];
}

export interface SeedActivity {
  key: Key;
  lessonKey: Key;
  title: string;
  order: number;
  kind: ActivityKind;
  description?: string;
  /** Scholar-FACING (2nd person / neutral invitation) card blurb. Distinct from
   *  the teacher-facing `description`; scholar reads do NOT fall back to
   *  `description`, so this must be authored for any activity a scholar opens.
   *  Omit for genuinely teacher-only activities (a title-only card is correct). */
  scholarDescription?: string;
  systemPrompt?: string;
  durationMinutes?: number;
  deliverable?: SeedDeliverable;
  /** Resolve a process by slug (slug-idempotent shared building block). */
  processSlug?: string;
  defaultMode?: "classFocus" | "homework" | "either";
  hasScholarAngles?: boolean;
  recipe?: "baseline" | "exitTicket";
  // kind === "web"
  webUrl?: string;
  webAllowedHosts?: string[];
  // kind === "shareBack"
  shareBackRecipe?:
    | "reflection"
    | "galleryWalk"
    | "exitTicket"
    | "debateDebrief"
    | "custom";
  sourceActivityKeys?: Key[];
  facilitationFocus?: string;
}

export interface SeedLesson {
  key: Key;
  unitKey: Key;
  title: string;
  order: number;
  strand?: "core" | "connections" | "practice" | "identity";
  systemPrompt?: string;
  processSlug?: string;
  durationMinutes?: number;
  activities: SeedActivity[];
}

export interface SeedUnit {
  key: Key;
  teacherKey: Key;
  /**
   * Independent-study discriminator. When set, this unit was authored BY a
   * scholar (their own independent study) — the inserter stamps both
   * `teacherId` and `authorScholarId` to this scholar's user id, matching the
   * real `createQuest` mutation (teacherId === authorScholarId ===
   * the scholar). IS units surface on the teacher "Independent" tab
   * (units.listScholarAuthored) and the scholar's own home. When unset, this is
   * regular teacher-authored curriculum (teacherId = teacherKey).
   */
  authorScholarKey?: Key;
  title: string;
  slug: string;
  emoji?: string;
  subject?: string;
  gradeLevel?: string;
  bigIdea?: string;
  description?: string;
  /** Scholar-facing (2nd-person) blurb for the author's own home cards;
   *  `description` stays teacher-facing. */
  scholarDescription?: string;
  targetBloomLevel?:
    | "remember"
    | "understand"
    | "apply"
    | "analyze"
    | "evaluate"
    | "create";
  /** @deprecated anti-parasocial — personas are no longer wired; this is inert (never read). See TODO.html. */
  personaSlug?: string;
  perspectiveSlug?: string;
  processSlug?: string;
  essentialQuestions?: SeedGranule[];
  enduringUnderstandings?: SeedGranule[];
  badgeOnCompletion?: { title: string; description?: string; icon?: string };
  lessons: SeedLesson[];
}

// ── Execution (assignments) ─────────────────────────────────────────────────

export interface SeedScheduleEntry {
  activityKey: Key;
  mode: "classFocus" | "homework";
  setAgoMinutes?: number;
  endsInMinutes?: number;
  dueInDays?: number;
  /**
   * PLANNED future push: days FROM NOW the item is scheduled to start (positive
   * = future). Maps to the schedule entry's `startsAt`. A planned entry has
   * `setAt` unset, so it renders on the Agenda as "planned" on that day without
   * being live to scholars yet. This is what positions an item on a FUTURE day
   * of the weekly agenda (agendaAt = startsAt ?? setAt ?? startedAt).
   */
  startsInDays?: number;
}

export interface SeedAssignment {
  key: Key;
  unitKey: Key;
  teacherKey: Key;
  scholarKeys: Key[];
  title?: string;
  startedAgoDays: number;
  schedule?: SeedScheduleEntry[];
}

export interface SeedMessage {
  role: "user" | "assistant" | "system" | "tool";
  content: string;
  /** Minutes before the session's lastMessageAt (descending within a thread). */
  agoMinutes: number;
  flagged?: boolean;
  flagReason?: string;
  toolAction?: string;
  model?: string;
}

export interface SeedProcessStateStep {
  key: string;
  status: "not_started" | "in_progress" | "completed";
  commentary?: string;
}

export interface SeedSession {
  key: Key;
  scholarKey: Key;
  unitKey?: Key;
  lessonKey?: Key;
  activityKey?: Key;
  assignmentKey?: Key;
  title: string;
  isArchived?: boolean;
  isOffline?: boolean;
  seedExemplar?: boolean;
  /** 0–5 integer, matching the observer's pulseScore scale (observerShared.ts). */
  pulseScore?: number;
  analysisSummary?: string;
  teacherWhisper?: string;
  /** lastMessageAt offset; messages anchor relative to this. */
  lastMessageAgoMinutes: number;
  activityCompletedAgoMinutes?: number;
  seedKey?: Key;
  messages?: SeedMessage[];
  processState?: {
    processSlug: string;
    currentStep: string;
    steps: SeedProcessStateStep[];
  };
}

export interface SeedDeliverableSubmission {
  key: Key;
  activityKey: Key;
  scholarKey: Key;
  sessionKey: Key;
  assignmentKey?: Key;
  textContent?: string;
  submittedAgoMinutes: number;
  rubricPassed?: boolean;
  rubricFeedback?: string;
  rubricCheckedBy?: "ai" | "teacher";
  rubricCheckedAgoMinutes?: number;
  overall?: "not" | "half" | "full";
  verdicts?: {
    criterionId: string;
    level: "not" | "half" | "full";
    note?: string;
  }[];
}

export interface SeedCompletion {
  scholarKey: Key;
  activityKey: Key;
  lessonKey?: Key;
  unitKey?: Key;
  sessionKey?: Key;
  assignmentKey?: Key;
  completedAgoMinutes: number;
  note?: string;
}

export interface SeedBadge {
  scholarKey: Key;
  /** Omit for a custom (unit-less) badge. */
  unitKey?: Key;
  title: string;
  description?: string;
  /** Emoji shown as the fallback — the seed skips (costly) generative art. */
  icon?: string;
  style?: "patch" | "medallion";
  colorway?: string;
  earnedAgoDays?: number;
  /**
   * Stable slug into the pre-baked badge art (convex/seed/rich/badgeArtAssets.ts).
   * The seed attaches that committed PNG so badges look real WITHOUT a live
   * gen-art run per seed. Regenerate via `node scripts/build-badge-art-assets.mjs`.
   */
  art?: string;
}

export interface SeedWebSession {
  scholarKey: Key;
  activityKey: Key;
  assignmentKey?: Key;
  startedAgoMinutes: number;
  endedAgoMinutes?: number;
  lastHeartbeatAgoMinutes?: number;
  offDomainBlocks?: number;
  lastUrl?: string;
  extractedSource?: "api" | "dom";
  extracted?: {
    xpToday?: number;
    xpGoal?: number;
    courseName?: string;
    percentComplete?: number;
    tasksCompletedToday?: number;
    taskSummaries?: string[];
  };
  summary?: string;
}

export interface SeedShareBackDigest {
  activityKey: Key;
  assignmentKey?: Key;
  status: "pending" | "ready" | "error";
  generatedAgoMinutes?: number;
  summary?: string;
  themes?: { title: string; body: string }[];
  highlights?: {
    deliverableKey: Key;
    scholarKey: Key;
    scholarName: string;
    sourceActivityTitle: string;
    angleTitle?: string;
    reason: string;
    excerpt: string;
    sessionKey?: Key;
  }[];
  discussionPrompts?: string[];
  sourceSnapshot?: { activityKey: Key; title: string; deliverableCount: number }[];
}

export interface SeedAngle {
  scholarKey: Key;
  activityKey: Key;
  title: string;
  description: string;
  setAgoMinutes: number;
  setBy: "scholar" | "teacher" | "ai";
}

// ── Observation (learning record) ───────────────────────────────────────────

export interface SeedAnalysis {
  sessionKey: Key;
  /** All three scores are 0–1, matching the observer's scales (observerShared.ts). */
  engagementScore?: number;
  complexityLevel?: number;
  onTaskScore?: number;
  topics?: string[];
  learningIndicators?: string[];
  concernFlags?: string[];
  summary?: string;
  suggestedIntervention?: string;
}

// ── Practice engine (math practice graph) ──────────────────────────────────
// A per-scholar `practiceMastery` row for the math practice graph. `skillKey`
// MUST be a `knowledgeNodes.nodeKey`; the inserter derives `domain` + `strand`
// from that node, so this fixture never hardcodes (and drifts from) the graph's
// taxonomy. The inserter SKIPS any skill whose node isn't present (a seed path
// that didn't build the graph), so it never throws — see
// convex/seed/rich/practice.ts.
export interface SeedPracticeMasteryRow {
  scholarKey: Key;
  skillKey: string;
  repetition: number;
  frontier: boolean;
  // Retention clock. Default: frontier ? 2 : 100 (fluent roots decay slowly).
  halfLifeDays?: number;
  // lastPracticedAt = now - this. Default 1 (practiced ~yesterday).
  lastPracticedAgoDays?: number;
}

// A single fictional MISS row on `practiceAttempts`, WITH its Option-2
// snapshot (stem + expected answer) already attached — practiceAttempts is
// otherwise empty in dev seed, so without this the new "recent misses"
// teacher surfaces (SkillDetailPanel, ScholarDomainReport) render blank out
// of the box. `skillKey` MUST be a `knowledgeNodes.nodeKey`; the inserter
// derives `domain` from that node and SKIPS any skill whose node isn't
// present, so it never throws. Deliberately fictional stems/answers — no real
// scholar work.
export interface SeedPracticeAttemptRow {
  scholarKey: Key;
  skillKey: string;
  stem: string;
  wrongAnswer: string;
  expectedAnswer: string;
  // createdAt = now - this. Higher = older; use distinct values across a
  // fixture so recency ordering in the read-side queries is stable.
  agoMinutes: number;
}

export interface SeedMastery {
  key: Key;
  scholarKey: Key;
  conceptLabel: string;
  domain: string;
  observedAgoDays: number;
  sessionKey: Key;
  transcriptExcerpt: string;
  masteryLevel: number;
  confidenceScore: number;
  evidenceSummary: string;
  evidenceType: string;
  attemptContext: string;
  studentInitiated: boolean;
  supersedesKey?: Key;
  isSuperseded?: boolean;
  misconceptionStatus?: "open" | "addressed";
  misconceptionAddressedAgoDays?: number;
  misconceptionAddressedByKey?: Key;
  misconceptionNote?: string;
}

export interface SeedGranuleEvidence {
  scholarKey: Key;
  unitKey: Key;
  granuleKey: string;
  assignmentKey?: Key;
  sessionKey: Key;
  observedAgoDays: number;
  outcome: "demonstrated" | "probed";
  transcriptExcerpt: string;
  evidenceSummary: string;
  bloomLevel?: string;
  phase?: "baseline" | "exit";
}

export interface SeedSignal {
  scholarKey: Key;
  sessionKey: Key;
  signalType: string;
  description: string;
  intensity: string;
  transcriptExcerpt?: string;
}

export interface SeedConnection {
  scholarKey: Key;
  domains: string[];
  conceptLabels: string[];
  description: string;
  sessionKey: Key;
  studentInitiated: boolean;
  transcriptExcerpt?: string;
}

export interface SeedSeed {
  key: Key;
  scholarKey: Key;
  origin: SeedOrigin;
  status: SeedStatus;
  topic: string;
  domain?: string;
  suggestionType: SeedSuggestionType;
  rationale: string;
  scholarInvitation: string;
  approachHint?: string;
  connectionTo?: string;
  sessionKey?: Key;
  teacherKey?: Key;
  currentBloomsLevel?: number;
  targetBloomsLevel?: number;
}

export interface SeedObservation {
  teacherKey: Key;
  scholarKey: Key;
  sessionKey?: Key;
  note: string;
  type: "praise" | "concern" | "suggestion" | "intervention" | "note";
}

// ── Teacher chat (Curriculum Bot / Teacher Aide threads) ────────────────────

export interface SeedChatMessage {
  role: "user" | "assistant";
  content: string;
  /** Minutes BEFORE now. Author oldest-first (largest agoMinutes first). */
  agoMinutes: number;
  model?: string;
}

/**
 * A teacher chat thread (the `chats` table) + its `curriculumMessages`.
 * Three flavours, by which optional link is set:
 *   - neither unitKey nor scholarKey → global Teacher Aide thread
 *   - unitKey set                    → a unit-scoped Curriculum Bot thread
 *   - scholarKey set                 → a scholar-scoped aide thread
 * The generic chat library (curriculumAssistant.listSessions) lists a
 * teacher's ordinary threads; the unit-scoped ones show up only under their
 * unit (curriculumAssistant.listSessionsForUnit).
 */
export interface SeedChat {
  key: Key;
  teacherKey: Key;
  title: string;
  pinned?: boolean;
  unitKey?: Key;
  scholarKey?: Key;
  /** lastMessageAt offset; minutes before now. */
  lastMessageAgoMinutes: number;
  messages: SeedChatMessage[];
}

// ── Sims (curriculum-quality, design-facing) ────────────────────────────────

export interface SeedSyntheticProfile {
  key: Key;
  ownerKey: Key;
  name: string;
  readingLevel: string;
  dossier: string;
  traits: string[];
  archetype?: string;
}

export interface SeedVariant {
  key: Key;
  activityKey: Key;
  experimentKey?: Key;
  parentVariantKey?: Key;
  generation: number;
  systemPrompt?: string | null;
  origin: "baseline" | "ai-proposed" | "teacher-edited";
  rationale?: string;
  status: "candidate" | "promoted" | "rejected";
  aggregateScores?: unknown;
}

export interface SeedSimTurn {
  role: "tutor" | "scholar";
  content: string;
}

export interface SeedSimulatedSession {
  experimentKey: Key;
  variantKey: Key;
  profileKey: Key;
  transcript: SeedSimTurn[];
  stopReason: "goal" | "stuck" | "maxTurns";
  verdict?: unknown;
  goalReached?: boolean;
}

/**
 * A judge's grounded verdict on ONE real scholar session — the field-record
 * data behind the violet Sessions distribution (one dot per verdict). Written
 * live by the grounding pipeline (convex/curriculumExperiments.ts); seeded here
 * so the Sessions signal has a real spread of fitness scores to plot.
 */
export interface SeedGroundedVerdict {
  activityKey: Key;
  sessionKey: Key;
  experimentKey: Key;
  scholarKey?: Key;
  profileName: string;
  readingLevel: string;
  verdict?: unknown;
  /** Mean of the fitness dims — the plotted dot's position on the 1–5 axis. */
  fitness: number;
  goalAttainment: number;
  excerpt: string;
  /** judgedAt offset (positive = "this long ago"). */
  judgedAgoMinutes: number;
}

export interface SeedExperiment {
  key: Key;
  activityKey: Key;
  teacherKey: Key;
  mode: "analyze" | "propose" | "loop";
  castProfileKeys: Key[];
  maxTurns: number;
  learningGoal: string;
  generations?: number;
  variantsPerGen?: number;
  status: "running" | "done" | "failed" | "cancelled";
  sessionsDone: number;
  sessionsTotal: number;
  baselineVariantKey?: Key;
  bestVariantKey?: Key;
  overallVerdict?: string;
  startedAgoDays: number;
  finishedAgoDays?: number;
  // Phase-4 sim-to-real calibration written by groundExperiment
  // ({ status:"done", realAggregate, ...Calibration }). Presence + trustworthy
  // drive the unit's Debriefed maturity rung. v.any() in schema.
  grounding?: unknown;
}

export interface SeedUnitReview {
  unitKey: Key;
  reviewedByKey: Key;
  reviewedAgoDays: number;
  openGapCount: number;
  summary?: unknown;
}

export interface SeedActivityReflection {
  activityKey: Key;
  teacherKey: Key;
  content: string;
  updatedAgoDays: number;
}

export interface SeedMomentTriage {
  teacherKey: Key;
  activityKey: Key;
  source: "mastery" | "signal" | "connection";
  /** Reference the source row by its mastery key (only mastery supported here). */
  sourceMasteryKey: Key;
  verdict: "kept" | "dismissed";
  triagedAgoDays: number;
}

// ── The whole fixture ───────────────────────────────────────────────────────

export interface RichSeed {
  teachers: SeedTeacher[];
  scholars: SeedScholar[];
  parents: SeedParent[];
  groups: SeedGroup[];
  teacherAffinities: SeedTeacherAffinity[];
  dossiers: SeedDossier[];
  directives: SeedDirective[];
  readingLevelHistory: SeedReadingLevelHistory[];

  units: SeedUnit[];
  reportingPeriods: SeedReportingPeriod[];
  scheduleBlocks: SeedScheduleBlock[];
  externalApps: SeedExternalApp[];

  assignments: SeedAssignment[];
  schedulePlacements: SeedSchedulePlacement[];
  portfolioItems: SeedPortfolioItem[];
  sessions: SeedSession[];
  deliverables: SeedDeliverableSubmission[];
  completions: SeedCompletion[];
  webSessions: SeedWebSession[];
  shareBackDigests: SeedShareBackDigest[];
  angles: SeedAngle[];

  analyses: SeedAnalysis[];
  mastery: SeedMastery[];
  practiceMastery: SeedPracticeMasteryRow[];
  practiceAttempts: SeedPracticeAttemptRow[];
  granuleEvidence: SeedGranuleEvidence[];
  signals: SeedSignal[];
  connections: SeedConnection[];
  seeds: SeedSeed[];
  observations: SeedObservation[];
  badges: SeedBadge[];

  chats: SeedChat[];

  syntheticProfiles: SeedSyntheticProfile[];
  experiments: SeedExperiment[];
  variants: SeedVariant[];
  simulatedSessions: SeedSimulatedSession[];
  groundedVerdicts: SeedGroundedVerdict[];
  unitReviews: SeedUnitReview[];
  activityReflections: SeedActivityReflection[];
  momentTriage: SeedMomentTriage[];
}
