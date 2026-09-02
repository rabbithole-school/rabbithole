/**
 * Weekly Practice Portrait digest — deterministic teacher-facing roll-up over
 * the homegrown practice engine. The broad portrait makes zero model calls: it reads the practice tables
 * (`practiceMastery`, `practicePlacements`, `practiceErrorEvents`) plus
 * scholar groups and per-scholar domain focus, aggregates them with the pure helper in
 * lib/practiceDigest.ts, and posts one calm note scoped to the primary
 * institution's alert channel (or the catchall when no primary institution is
 * configured) through the existing alerts fabric.
 *
 * Guardrail: this Slack channel is staff-facing, so per-scholar detail is OK,
 * but the digest remains a portrait, not a report card: no learner-vs-learner
 * comparison, no points/XP/streaks, no pace projection.
 *
 * The separate Friday Math Skills update uses one bounded Sonnet call to add
 * prose after deterministic attempt-based topic selection.
 *
 * `weeklyDigest` is wired to a Friday-17:10-HST cron in convex/crons.ts. It can
 * also be run by hand for a dev-deployment spot check:
 *
 *   CONVEX_DEPLOYMENT=dev:<dev> npx convex run practiceDigest:weeklyDigest
 *
 * Running against prod requires explicit approval per
 * .claude/rules/rabbithole-convex-deploys.md.
 */
import { v } from "convex/values";
import { internalAction, internalMutation, internalQuery } from "./_generated/server";
import type { ActionCtx, QueryCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { teacherQuery } from "./lib/customFunctions";
import { requireScholarsAccessible } from "./lib/access";
import { scholarInstitutionId } from "./lib/scholarEnrollment";
import {
  fluentCount,
  frontierGradeValue,
  gradeLabelFromValueOrNull,
} from "./lib/practice/frontierGrade";
import { PRACTICE_DOMAIN_LABELS } from "../shared/practiceDomainLabels";
import { gradeRank } from "../shared/gradeRange";
import {
  isDue,
  isFluent,
  HALFLIFE_GROWTH,
} from "./lib/practice/scheduler";
import { PRACTICE_DOMAINS } from "./lib/practice/domains";
import { requireAnthropicApiKey } from "./lib/anthropic";
import {
  ERROR_FLAG_WINDOW_MS,
  openErrorPatterns,
  type ErrorEvent,
} from "./lib/practice/errorFlags";
import {
  applyMathSkillsNarratives,
  buildMathSkillsNarrativeUserMessage,
  collectMathSkillsNarrativeCandidates,
  MATH_SKILLS_NARRATIVE_SYSTEM,
  MATH_SKILLS_NARRATIVE_TOOL,
  parseMathSkillsNarrativeToolInput,
} from "./lib/practice/mathSkillsNarrative";
import {
  weeklyMathTopics,
  type WeeklyMathTopicEvidence,
} from "./lib/practice/weeklyMathTopics";
import {
  computePracticeDigest,
  computeMathSkillsUpdate,
  computeWeeklyPracticeSignals,
  PRACTICE_DIGEST_WINDOW_MS,
  selectMathSkillsUpdateCohorts,
  type MathSkillsPriorityTopic,
  type PracticeCohortDigestRow,
  type PracticeElsewhereDigestRow,
  type PracticeScholarDigestRow,
} from "./lib/practiceDigest";
import {
  computeParamHealthMetrics,
  deriveWindowSignal,
  recommendParamChange,
  renderParamHealthSection,
  reviewShare as computeReviewShare,
  MAX_CONSECUTIVE_WINDOW_GAP_MS,
  MEMORY_PARAMS,
  PARAM_HEALTH_WINDOW_MS,
  type AttemptRow,
  type PracticeLane,
  type PreviousRecommendation,
  type RecommendationEvidence,
  type ReviewShare,
  type SignalDirection,
} from "./lib/practice/paramHealth";
import {
  computeStoryDigestSection,
  type StoryConnectionInput,
  type StoryDigestSection,
  type StoryEdgeInput,
  type StoryProvenance,
} from "./lib/practice/storyDigest";
import { MODELS } from "./lib/models";
import { ROLES } from "./lib/roles";
import { relationOf } from "../shared/edgeOntology";
import {
  isSubjectCohort,
  owningGroupForScholar,
  subjectKeyOf,
} from "../shared/scholarGroupRouting";
import { isEnrolledScholar } from "./lib/enrollmentStanding";
import { siteUrl, withBase } from "./lib/channels";
import { PREP_TIME_KEY } from "./lib/metaBlocks";
import {
  fetchConversationHistory,
  fetchConversationReplies,
  messageWithDeliveryMetadata,
  postMessage,
  type SlackMessageMetadata,
} from "./lib/slackApi";
import { recordAnthropicUsage } from "./usage";

// Coalesce to one post per ISO week. The key changes weekly, and the window is
// slightly longer than a week so a same-week manual rerun does not double-post.
const DEDUP_WINDOW_MS = 8 * 24 * 60 * 60 * 1000;

const PRACTICE_SUBJECT_KEY = "math";
const MATH_UPDATE_EVENT_TYPE = "rabbithole_math_weekly_update";
const MATH_UPDATE_EVIDENCE_EVENT_TYPE =
  "rabbithole_math_weekly_update_evidence";
const MATH_UPDATE_THREAD_CHUNK_MAX_CHARS = 9_500;
const MATH_PRACTICE_DOMAINS = new Set(
  PRACTICE_DOMAINS.filter(({ discipline }) => discipline === "Mathematics").map(
    ({ domain }) => domain,
  ),
);

// The broad Practice Portrait's low-stakes friction threshold now lives with the
// weekly read model in lib/practiceDigest.ts (FRICTION_MIN_MISSES). The Friday
// Math Skills update uses the full attempt log in weeklyMathTopics.ts.

type PracticeDigestScholarRow = PracticeScholarDigestRow & {
  scholarId: string;
  practiceCount: number;
  mathPracticeCount: number;
};

function inWindow(ts: number | undefined, since: number, now: number): ts is number {
  return typeof ts === "number" && ts >= since && ts <= now;
}

function priorityReason(candidate: WeeklyMathTopicEvidence): string {
  const attemptWord = candidate.attemptCount === 1 ? "attempt" : "attempts";
  const missWord = candidate.missCount === 1 ? "miss" : "misses";
  const evidence = `${candidate.missCount} ${missWord} in ${candidate.attemptCount} ${attemptWord}`;
  const ending =
    candidate.trailingCorrectCount > 0
      ? `finished with ${candidate.trailingCorrectCount} correct ${
          candidate.trailingCorrectCount === 1 ? "attempt" : "attempts"
        }`
      : "latest attempt was missed";
  const support = {
    triggered: "the practice brake stepped in",
    repair_started: "guided support started",
    repair_completed: "the guided step was completed",
    coach_escalated: "the tutor workthrough started",
    easy_exited: "the sitting ended there",
    fresh_correct:
      "after guided support, the fresh same-skill item was correct",
    fresh_missed:
      "after guided support, the fresh same-skill item was missed",
  }[candidate.supportOutcome ?? "triggered"];
  if (candidate.tier === "sustained") {
    return `${evidence} across ${candidate.missSittingCount} sittings;${
      candidate.supportOutcome ? ` ${support};` : ""
    } ${ending}`;
  }
  if (candidate.tier === "acute") {
    return `${evidence}; ${candidate.supportOutcome ? support : "the practice brake stepped in"}${
      candidate.breakerCount > 1 ? ` ${candidate.breakerCount} times` : ""
    }; ${ending}`;
  }
  const spread =
    candidate.missSittingCount > 1
      ? ` across ${candidate.missSittingCount} sittings`
      : " in one sitting";
  return `${evidence}${spread};${
    candidate.supportOutcome ? ` ${support};` : ""
  } ${ending}`;
}

async function priorityTopicsFor(
  ctx: QueryCtx,
  errorRows: Doc<"practiceErrorEvents">[],
  practiceAttempts: Doc<"practiceAttempts">[],
  since: number,
  now: number,
): Promise<MathSkillsPriorityTopic[]> {
  const ranked = weeklyMathTopics(
    errorRows,
    practiceAttempts,
    since,
    now,
  )
    .filter((candidate) => MATH_PRACTICE_DOMAINS.has(candidate.domain))
    .slice(0, 3);

  const topics = await Promise.all(
    ranked.map(async (candidate): Promise<MathSkillsPriorityTopic | null> => {
      const nodes = await ctx.db
        .query("knowledgeNodes")
        .withIndex("by_nodeKey", (q) => q.eq("nodeKey", candidate.nodeKey))
        .collect();
      const node =
        nodes.find(({ domain }) => domain === candidate.domain) ?? nodes[0];
      if (!node?.label.trim()) return null;
      return {
        domain: candidate.domain,
        nodeKey: candidate.nodeKey,
        label: node.label,
        tier: candidate.tier,
        attemptCount: candidate.attemptCount,
        missCount: candidate.missCount,
        correctCount: candidate.correctCount,
        missSittingCount: candidate.missSittingCount,
        dayCount: candidate.dayCount,
        dayLabels: candidate.dayLabels,
        latestAttemptCorrect: candidate.latestAttemptCorrect,
        trailingCorrectCount: candidate.trailingCorrectCount,
        breakerCount: candidate.breakerCount,
        ...(candidate.supportOutcome
          ? { supportOutcome: candidate.supportOutcome }
          : {}),
        ...(candidate.pattern ? { pattern: candidate.pattern } : {}),
        ...(candidate.patternDescription
          ? { patternDescription: candidate.patternDescription }
          : {}),
        missExamples: candidate.missExamples,
        reason: priorityReason(candidate),
      };
    }),
  );
  return topics.filter((topic): topic is MathSkillsPriorityTopic => topic !== null);
}

function linkPriorityTopics(
  scholar: PracticeDigestScholarRow,
  groupId?: Id<"scholarGroups">,
): PracticeDigestScholarRow {
  return {
    ...scholar,
    priorityTopics: (scholar.priorityTopics ?? []).map((topic) => {
      const query = new URLSearchParams({
        domain: topic.domain,
        lens: "mastery",
        node: topic.nodeKey,
        scholar: scholar.username ?? scholar.scholarId,
        scope: groupId ? String(groupId) : "",
      });
      return {
        ...topic,
        link: withBase(siteUrl(), `/teacher/math-skills?${query.toString()}`),
      };
    }),
  };
}

async function needsPlacementFor(
  ctx: QueryCtx,
  scholarId: Id<"users">,
  domain: string,
  masteryRows: Doc<"practiceMastery">[],
): Promise<boolean> {
  if (masteryRows.length > 0) return false;
  const placement = await ctx.db
    .query("practicePlacements")
    .withIndex("by_scholar_domain", (q) =>
      q.eq("scholarId", scholarId).eq("domain", domain),
    )
    .first();
  return placement?.status !== "complete";
}

/**
 * Count OPEN misconception flags whose latest matching error landed this week.
 * Pure over prefetched `practiceErrorEvents` rows so a scholar's error log is
 * read once and reused for both the flag count and the friction signal.
 */
function openMisconceptionFlagsRaised(
  errorRows: Doc<"practiceErrorEvents">[],
  domain: string,
  since: number,
  now: number,
): number {
  const byNode = new Map<string, ErrorEvent[]>();
  const flagWindowStart = now - ERROR_FLAG_WINDOW_MS;
  for (const row of errorRows) {
    if (row.domain !== domain) continue;
    if (row.createdAt < flagWindowStart || row.createdAt > now) continue;
    const events = byNode.get(row.nodeKey) ?? [];
    events.push({ pattern: row.pattern, createdAt: row.createdAt });
    byNode.set(row.nodeKey, events);
  }

  let count = 0;
  for (const events of byNode.values()) {
    count += openErrorPatterns(events, now).filter((p) => p.lastAt >= since).length;
  }
  return count;
}

/**
 * APPROXIMATE "where the week's work concentrated": the strand with the most
 * rows touched in the window. Returned only when ≥2 strands were touched, so
 * "most of the work" is meaningful. Not a minutes reading — it counts rows
 * touched, since attempts/time-on-task are not tracked.
 */
function topStrandTouched(
  masteryRows: Doc<"practiceMastery">[],
  since: number,
  now: number,
  strandOf: Map<string, string | undefined>,
): string | null {
  const touches = new Map<string, number>();
  for (const row of masteryRows) {
    const touched =
      inWindow(row.updatedAt, since, now) || inWindow(row.lastPracticedAt, since, now);
    if (!touched) continue;
    const strand = row.strand ?? strandOf.get(row.skillKey);
    if (!strand) continue;
    touches.set(strand, (touches.get(strand) ?? 0) + 1);
  }
  if (touches.size < 2) return null;
  let best: string | null = null;
  let bestCount = -1;
  for (const [strand, n] of touches) {
    if (n > bestCount) {
      bestCount = n;
      best = strand;
    }
  }
  return best ? best.replace(/[-_]+/g, " ") : null;
}

async function scholarDigestRow(
  ctx: QueryCtx,
  scholarId: Id<"users">,
  domain: string,
  since: number,
  now: number,
  graph: { labelOf: Map<string, string>; strandOf: Map<string, string | undefined> },
): Promise<PracticeDigestScholarRow> {
  const user = await ctx.db.get(scholarId);
  const allMasteryRows = await ctx.db
    .query("practiceMastery")
    .withIndex("by_scholar", (q) => q.eq("scholarId", scholarId))
    .collect();
  const masteryRows = allMasteryRows.filter((row) => row.domain === domain);
  const errorRows = await ctx.db
    .query("practiceErrorEvents")
    .withIndex("by_scholar", (q) => q.eq("scholarId", scholarId))
    .collect();
  const practiceAttempts = await ctx.db
    .query("practiceAttempts")
    .withIndex("by_scholar_createdAt", (q) =>
      q.eq("scholarId", scholarId).gte("createdAt", since),
    )
    .collect();
  const recordedPracticeAttempts = practiceAttempts.filter(
    (row) =>
      row.retry !== true &&
      row.createdAt !== undefined &&
      row.createdAt <= now,
  );
  // Count both formats as a practice-brake episode without projecting the v2
  // outcome into the old binary fields. Detailed repair/coach/easy-exit/fresh
  // state remains available on `breakerLifecycle`; legacy rows continue to use
  // `breaker` unchanged.
  const breakerEvents = recordedPracticeAttempts.filter(
    (row) => row.breaker || row.breakerLifecycle,
  );
  const practiceCount = recordedPracticeAttempts.filter(
    (row) =>
      row.domain === domain &&
      row.createdAt !== undefined,
  ).length;
  const mathPracticeAttempts = recordedPracticeAttempts.filter(
    (row) =>
      typeof row.domain === "string" &&
      MATH_PRACTICE_DOMAINS.has(row.domain) &&
      row.createdAt !== undefined,
  );
  const mathPracticeCount = mathPracticeAttempts.length;
  const mathMissCount = mathPracticeAttempts.filter(
    (row) => !row.correct,
  ).length;

  // The four trustworthy weekly signals now come from ONE shared definition
  // (lib/practiceDigest.ts) so the cron digest and the teacher-facing weekly
  // read model can never drift apart. Same inputs, same numbers as before.
  const signals = computeWeeklyPracticeSignals({
    masteryRows,
    errorRows,
    domain,
    since,
    now,
    labelOf: graph.labelOf,
  });

  const dueReviews = masteryRows.filter((r) =>
    isDue(
      {
        repetition: r.repetition,
        halfLifeDays: r.halfLifeDays,
        lastPracticedAt: r.lastPracticedAt,
      },
      now,
    ),
  ).length;

  return {
    scholarId: String(scholarId),
    domain,
    name: user?.name ?? user?.username ?? "Scholar",
    username: user?.username ?? null,
    needsPlacement: await needsPlacementFor(ctx, scholarId, domain, masteryRows),
    practicedDays: signals.practicedDays,
    practiceCount,
    mathPracticeCount,
    mathMissCount,
    // "Last practiced" for the inactivity note = last REAL attempt, never
    // `lastPracticedAt` (placement/reprobe stamp that at onboarding).
    lastPracticedAt: signals.lastAttemptAt,
    skillsTurnedFluent: signals.skillsTurnedFluent,
    turnedFluentLabels: signals.turnedFluentLabels,
    skillsAdvanced: signals.skillsAdvanced,
    frontierLabels: signals.frontierLabels,
    dueReviews,
    misconceptionFlags: openMisconceptionFlagsRaised(errorRows, domain, since, now),
    frictionSkillLabel: signals.frictionSkillLabel,
    frictionMisses: signals.frictionMisses,
    breakerEvents: breakerEvents.length,
    topStrand: topStrandTouched(masteryRows, since, now, graph.strandOf),
    priorityTopics: await priorityTopicsFor(
      ctx,
      errorRows,
      practiceAttempts,
      since,
      now,
    ),
  };
}

function localMinute(hhmm: string): number | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(hhmm.trim());
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) return null;
  return hour * 60 + minute;
}

function firstDailyBlockMinutes(
  group: Doc<"scholarGroups">,
): number | null {
  const block = group.dailyBlocks?.find(({ key }) => key === PREP_TIME_KEY);
  if (!block) return null;
  const start = localMinute(block.startLocal);
  const end = localMinute(block.endLocal);
  return start !== null && end !== null && end > start ? end - start : null;
}


// ── Teacher-facing weekly practice signals (F10) ─────────────────────────────
//
// `weeklySnapshot` above is an internalQuery because its only caller is an
// unauthenticated cron, which means no React surface can reach it. This is the
// public twin: the SAME four trustworthy weekly signals (they share
// `computeWeeklyPracticeSignals`, so the two can never drift), read for a named
// roster by an authenticated teacher.
//
// What it deliberately does NOT expose, and why — these are the two ways this
// data lies if you squint at it:
//
//   • BAND-COUNT DELTAS ("3 → 5 fluent this week"). A category error. The
//     current band folds access, retention, latency and a recent-miss override
//     together and is evaluated at READ time, so a week-over-week band change
//     can be decay or a single wrong answer rather than learning. Movement is
//     reported ONLY from stored crossing stamps (`becameFluentAt`,
//     `frontierAdvancedAt`), which recordAttemptCore writes once, at the moment
//     the bar is actually crossed.
//   • "TOP STRAND" AS TIME SPENT. `topStrandTouched` counts rows whose
//     `updatedAt` falls in the window, and placement stamps `updatedAt`. It is a
//     rough "where the work concentrated", never minutes, so it is not part of
//     this payload at all.
//
// There is no time-on-task number anywhere in here because the engine does not
// record one.

/** Hard fan-out bound. Above this we THROW rather than truncate: a silently
 *  short roster renders as "these scholars did nothing this week", which is a
 *  wrong number, and a wrong number outranks a missing one. */
export const WEEKLY_SIGNALS_MAX_SCHOLARS = 60;

/**
 * The demonstrated-fluent math grade for one domain, plus its 7-day movement.
 *
 * Reconstructed with `frontierGradeValue(rows, gradeByKey, asOf)` — the same
 * function evaluated at two cutoffs — so a week-over-week delta needs no new
 * table and cannot disagree with the portrait's live value.
 *
 * LEFT-CENSORING (the caveat that must survive to the screen): a
 * demonstrated-fluent row with no `becameFluentAt` stamp predates the crossing
 * instrumentation and counts from the baseline, i.e. at EVERY cutoff. Such rows
 * therefore contribute identically at `since` and at `now` and cancel out of the
 * delta — which is what makes the delta honest. The failure mode is the
 * boundary case: when the scholar had no gradeable demonstrated-fluent skill at
 * `since` at all, `priorValue` is null, and rendering `value - 0` would show a
 * multi-grade "jump" that is really instrumentation starting. So the delta is
 * SUPPRESSED (null) with a reason rather than fabricated, and `leftCensored`
 * flags that part of the standing level rests on unstamped history.
 */
export interface WeeklyMathGrade {
  /** Practice domain slug the grade is read from (same domain as the row's other signals). */
  domain: string;
  /** Human label for that domain, e.g. "Math". */
  domainLabel: string;
  /** Continuous grade-equivalent now, e.g. 5.2. Null when no demonstrated-fluent skill has a known grade. */
  value: number | null;
  /** Compact label for `value`, e.g. "Grade 5.2". Null when `value` is null. */
  label: string | null;
  /** The same value reconstructed at the window start, or null when nothing was demonstrated by then. */
  priorValue: number | null;
  /** Compact label for `priorValue`, or null. */
  priorLabel: string | null;
  /** `value - priorValue`, or null when it cannot be stated honestly. Never negative in practice (the series is monotonic). */
  delta: number | null;
  /** Why `delta` is null, so the surface can say so instead of rendering 0. */
  deltaSuppressedReason: "no_prior_value" | null;
  /** True when ≥1 demonstrated-fluent row carries no crossing stamp — part of this level predates tracking. */
  leftCensored: boolean;
  /** How many skills in the domain are demonstrated-fluent right now. */
  fluentSkills: number;
}

/** One roster row of honest weekly practice signals. */
export interface WeeklyPracticeSignalRow {
  scholarId: Id<"users">;
  name: string;
  username: string | null;
  /**
   * The "narration domain" — the domain of the scholar's most recent real
   * attempt. All four signals and the grade are read from this ONE domain, so a
   * row is internally coherent. Null when the scholar has never attempted
   * anything; every count below is then 0/null.
   */
  domain: string | null;
  /** True when the scholar has no mastery rows in `domain` and no placement yet. */
  needsPlacement: boolean;
  /** Distinct real drill days in the window (0–7), from `lastAttemptAt` only. */
  practicedDays: number;
  /** Last real attempt across the domain, ms. Null when they have never drilled. */
  lastAttemptAt: number | null;
  /** Skills that crossed the demonstrated-fluency bar in the window (`becameFluentAt`). */
  skillsTurnedFluent: number;
  /** Labels for those skills, newest crossing first. */
  turnedFluentLabels: string[];
  /** Skills whose access frontier advanced through practice in the window (`frontierAdvancedAt`). */
  skillsAdvanced: number;
  /** Current frontier skill labels, most recently practised first. */
  frontierLabels: string[];
  /** Worst not-yet-fluent skill by classified wrong answers in the window, or null below the ≥3 floor. */
  frictionSkillLabel: string | null;
  /** Classified misses on that skill. 0 when there is no friction skill. */
  frictionMisses: number;
  /** Demonstrated-fluent grade + honest 7-day movement, or null when the domain has no gradeable fluent skill. */
  mathGrade: WeeklyMathGrade | null;
}

export interface WeeklyPracticeSignalsResult {
  /** Window start, ms (inclusive). */
  since: number;
  /** Window end, ms (inclusive) — the server clock, never client-supplied. */
  now: number;
  /** Window length in ms (7 days). */
  windowMs: number;
  rows: WeeklyPracticeSignalRow[];
}

/**
 * Weekly practice signals for a named roster.
 *
 * Auth: `teacherQuery` (→ `requireTeacher`) establishes ROLE only. Multi-tenancy
 * in this repo is enforced per handler, so this additionally runs every id
 * through `requireScholarsAccessible`, which throws on the first scholar outside
 * the caller's institution lens. A role check alone would be a cross-tenant leak.
 *
 * Non-scholar or missing ids are rejected by `requireScholarsAccessible` before
 * any read happens, so a stale id fails loudly rather than rendering as an
 * all-zero row that reads "this scholar did nothing this week". The
 * `role !== "scholar"` skip below is a defensive backstop for that same reason.
 */
export const weeklySignalsForScholars = teacherQuery({
  args: { scholarIds: v.array(v.id("users")) },
  handler: async (ctx, args): Promise<WeeklyPracticeSignalsResult> => {
    const now = Date.now();
    const since = now - PRACTICE_DIGEST_WINDOW_MS;
    const base = {
      since,
      now,
      windowMs: PRACTICE_DIGEST_WINDOW_MS,
    };

    // De-duplicate before bounding, so a caller repeating an id can't be
    // spuriously rejected.
    const scholarIds = Array.from(new Set(args.scholarIds));
    if (scholarIds.length === 0) return { ...base, rows: [] };
    if (scholarIds.length > WEEKLY_SIGNALS_MAX_SCHOLARS) {
      throw new Error(
        `weeklySignalsForScholars: ${scholarIds.length} scholars requested, limit is ${WEEKLY_SIGNALS_MAX_SCHOLARS}. Page the roster rather than truncating it.`,
      );
    }

    await requireScholarsAccessible(ctx, ctx.user, scholarIds);

    // One knowledgeNodes read per DOMAIN, shared across the whole roster.
    const graphByDomain = new Map<
      string,
      Promise<{
        labelOf: Map<string, string>;
        gradeByKey: Map<string, string | null | undefined>;
      }>
    >();
    const graphFor = (domain: string) => {
      let graph = graphByDomain.get(domain);
      if (!graph) {
        graph = ctx.db
          .query("knowledgeNodes")
          .withIndex("by_domain", (q) => q.eq("domain", domain))
          .collect()
          .then((nodes) => ({
            labelOf: new Map(nodes.map((n) => [n.nodeKey, n.label])),
            gradeByKey: new Map<string, string | null | undefined>(
              nodes.map((n) => [n.nodeKey, n.grade]),
            ),
          }));
        graphByDomain.set(domain, graph);
      }
      return graph;
    };

    const rows: WeeklyPracticeSignalRow[] = [];
    for (const scholarId of scholarIds) {
      const user = await ctx.db.get(scholarId);
      if (!user || user.role !== "scholar") continue;

      const allMastery = await ctx.db
        .query("practiceMastery")
        .withIndex("by_scholar", (q) => q.eq("scholarId", scholarId))
        .collect();

      // Narration domain = domain of the most recent REAL attempt. Deliberately
      // not `lastPracticedAt`, which placement and reprobe also stamp.
      const attempted = allMastery
        .filter((row) => typeof row.lastAttemptAt === "number")
        .sort(
          (a, b) =>
            (b.lastAttemptAt ?? 0) - (a.lastAttemptAt ?? 0) ||
            a.domain.localeCompare(b.domain),
        );
      const domain = attempted[0]?.domain ?? null;

      const name = user.name ?? user.username ?? "Scholar";
      const username = user.username ?? null;

      if (!domain) {
        rows.push({
          scholarId,
          name,
          username,
          domain: null,
          needsPlacement: await needsPlacementFor(ctx, scholarId, "", allMastery),
          practicedDays: 0,
          lastAttemptAt: null,
          skillsTurnedFluent: 0,
          turnedFluentLabels: [],
          skillsAdvanced: 0,
          frontierLabels: [],
          frictionSkillLabel: null,
          frictionMisses: 0,
          mathGrade: null,
        });
        continue;
      }

      const masteryRows = allMastery.filter((row) => row.domain === domain);
      const errorRows = await ctx.db
        .query("practiceErrorEvents")
        .withIndex("by_scholar_domain", (q) =>
          q.eq("scholarId", scholarId).eq("domain", domain),
        )
        .collect();

      const graph = await graphFor(domain);
      const signals = computeWeeklyPracticeSignals({
        masteryRows,
        errorRows,
        domain,
        since,
        now,
        labelOf: graph.labelOf,
      });

      rows.push({
        scholarId,
        name,
        username,
        domain,
        needsPlacement: await needsPlacementFor(ctx, scholarId, domain, masteryRows),
        practicedDays: signals.practicedDays,
        lastAttemptAt: signals.lastAttemptAt,
        skillsTurnedFluent: signals.skillsTurnedFluent,
        turnedFluentLabels: signals.turnedFluentLabels,
        skillsAdvanced: signals.skillsAdvanced,
        frontierLabels: signals.frontierLabels,
        frictionSkillLabel: signals.frictionSkillLabel,
        frictionMisses: signals.frictionMisses,
        mathGrade: weeklyMathGrade(domain, masteryRows, graph.gradeByKey, since),
      });
    }

    return { ...base, rows };
  },
});

/** Pure: the grade block for one domain. Exported for unit tests. */
export function weeklyMathGrade(
  domain: string,
  masteryRows: readonly {
    skillKey: string;
    repetition: number;
    source?: string;
    becameFluentAt?: number;
  }[],
  gradeByKey: ReadonlyMap<string, string | null | undefined>,
  since: number,
): WeeklyMathGrade | null {
  const value = frontierGradeValue(masteryRows, gradeByKey);
  if (value === null) return null;

  const priorValue = frontierGradeValue(masteryRows, gradeByKey, since);

  // Suppress rather than fabricate. `priorValue === null` means nothing
  // gradeable was demonstrated at the window start, so `value - 0` would render
  // as a multi-grade jump that is really "we started tracking".
  let delta: number | null = null;
  let deltaSuppressedReason: WeeklyMathGrade["deltaSuppressedReason"] = null;
  if (priorValue === null) {
    deltaSuppressedReason = "no_prior_value";
  } else {
    delta = Number((value - priorValue).toFixed(2));
  }

  // Any demonstrated-fluent row with a known grade but no crossing stamp
  // predates the instrumentation; the standing level partly rests on it.
  const leftCensored = masteryRows.some(
    (row) =>
      row.becameFluentAt === undefined &&
      isFluent(row) &&
      gradeRank(gradeByKey.get(row.skillKey)) !== null,
  );

  return {
    domain,
    domainLabel: PRACTICE_DOMAIN_LABELS[domain] ?? domain,
    value,
    label: gradeLabelFromValueOrNull(value),
    priorValue,
    priorLabel: gradeLabelFromValueOrNull(priorValue),
    delta,
    deltaSuppressedReason,
    leftCensored,
    fluentSkills: fluentCount(masteryRows),
  };
}
