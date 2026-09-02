/**
 * PURE helpers for the weekly teacher-facing practice digest.
 *
 * The Convex action hands this module plain cohort/scholar rows computed from
 * practiceMastery / practicePlacements / practiceErrorEvents / knowledgeNodes.
 * This module does no reads, no writes, and no model calls; it classifies each
 * scholar into ONE plain-language state and renders a calm, narrative Slack
 * mrkdwn note for #rabbithole-alerts — prose over a wall of counters.
 *
 * Guardrails: this is staff-facing, so per-scholar practice details are allowed,
 * but the rendering must stay portrait-shaped: no points/XP/streaks, no rank
 * order, no pace-to-finish projections, and no learner-vs-learner comparison.
 * Each scholar is described only against their own record.
 */

import { escapeSlackText } from "./slackText";

const DAY_MS = 24 * 60 * 60 * 1000;

export const PRACTICE_DIGEST_WINDOW_MS = 7 * DAY_MS;

export type MathSkillsTopicTier = "practice" | "acute" | "sustained";
export type MathSkillsSupportOutcome =
  | "triggered"
  | "repair_started"
  | "repair_completed"
  | "coach_escalated"
  | "easy_exited"
  | "fresh_correct"
  | "fresh_missed";

export interface MathSkillsMissExample {
  stem: string;
  learnerAnswer?: string;
  expectedAnswer?: string;
  isDontKnow: boolean;
}

export interface MathSkillsPriorityTopic {
  domain: string;
  nodeKey: string;
  label: string;
  tier: MathSkillsTopicTier;
  pattern?: string;
  patternDescription?: string;
  attemptCount: number;
  missCount: number;
  correctCount: number;
  missSittingCount: number;
  dayCount: number;
  dayLabels: string[];
  latestAttemptCorrect: boolean;
  trailingCorrectCount: number;
  breakerCount: number;
  supportOutcome?: MathSkillsSupportOutcome;
  missExamples: MathSkillsMissExample[];
  reason: string;
  narrative?: string;
  link?: string;
}

// A scholar is flagged "flying" once this many fluent-crossings + frontier moves
// land in the week; "stuck" once they put in this many practice days with none.
const FLYING_MIN_WINS = 2;
const STUCK_MIN_DAYS = 2;

export interface PracticeScholarDigestRow {
  scholarId?: string;
  domain: string;
  name: string;
  username?: string | null;
  practiceCount?: number;
  mathPracticeCount?: number;
  mathMissCount?: number;
  priorityTopics?: MathSkillsPriorityTopic[];
  needsPlacement: boolean;
  practicedDays: number;
  // Most recent practice timestamp across the scholar's rows (may predate the
  // window) — lets a "quiet this week" note say how long it has been.
  lastPracticedAt?: number | null;
  skillsTurnedFluent: number;
  // Labels of the skills that crossed into fluent THIS week (most recent first).
  turnedFluentLabels?: string[];
  skillsAdvanced: number;
  // Current frontier skill labels (most recently practiced first) — "where they
  // are working now".
  frontierLabels?: string[];
  dueReviews: number;
  misconceptionFlags: number;
  // A not-yet-fluent skill the scholar missed repeatedly this week (real
  // wrong-answer events), plus the miss count — the honest "friction" signal.
  frictionSkillLabel?: string | null;
  frictionMisses?: number;
  breakerEvents?: number;
  // APPROXIMATE: the strand the week's work concentrated in (by rows touched),
  // set only when >1 strand was touched so "most of the work" is meaningful.
  // This is "where the action was", not a true minutes-on-task reading.
  topStrand?: string | null;
}

// ── The weekly practice READ MODEL (shared by the Slack cron and teacher reads) ─
//
// These four signals are the honest weekly movement numbers the practice engine
// can actually back with stored EVENT stamps, extracted here so the Friday cron
// digest and any teacher-facing weekly surface compute them from ONE definition
// rather than growing a second vocabulary for the same claim:
//
//   1. practicedDays        — distinct REAL drill days, off `lastAttemptAt`
//                             (recordAttemptCore only; placement/reprobe never
//                             stamp it, so onboarding cannot inflate it).
//   2. skillsTurnedFluent   — `becameFluentAt` crossings in-window: the
//                             DEMONSTRATED gate flipping through real practice.
//                             The strongest weekly mastery-movement number.
//   3. skillsAdvanced       — `frontierAdvancedAt` crossings in-window: access
//                             proven THROUGH practice; bulk placement can't set it.
//   4. friction             — the worst not-yet-fluent skill by real wrong-answer
//                             events, at or above FRICTION_MIN_MISSES, excluding
//                             skills that turned fluent the same week. A miss
//                             count, NEVER a time-on-task or dwell reading.
//
// Deliberately NOT here, and deliberately not derivable from this input:
//   • band-count deltas ("3 → 5 fluent"). Current bands fold access, retention,
//     latency and a recent-miss override together, so a week-over-week category
//     change can be decay or one miss rather than learning. Movement is only
//     ever reported from stored crossing stamps.
//   • "top strand" as time spent. `topStrandTouched` counts ROWS whose
//     `updatedAt` falls in-window — which placement stamps — so it is "where the
//     action was", never minutes on task.

/** Real wrong answers on one not-yet-fluent skill before it counts as friction. */
export const FRICTION_MIN_MISSES = 3;

/** The `practiceMastery` fields the weekly read model needs. Structural, so the
 *  pure module stays free of Convex `Doc` types. */
export interface WeeklyMasteryRow {
  skillKey: string;
  domain: string;
  frontier: boolean;
  /** SR clock — placement/reprobe stamp it too, so it is never a drill signal. */
  lastPracticedAt?: number;
  /** The honest drill signal: recordAttemptCore only. */
  lastAttemptAt?: number;
  becameFluentAt?: number;
  frontierAdvancedAt?: number;
}

/** The `practiceErrorEvents` fields the friction signal needs. */
export interface WeeklyErrorRow {
  domain: string;
  nodeKey: string;
  createdAt: number;
}

export interface WeeklyPracticeSignals {
  /** Distinct real drill days in the window, capped at 7. */
  practicedDays: number;
  /** Last REAL attempt across the domain's rows (may predate the window). */
  lastAttemptAt: number | null;
  skillsTurnedFluent: number;
  /** Labels of the skills that crossed into fluent this week, newest first. */
  turnedFluentLabels: string[];
  skillsAdvanced: number;
  /** Current frontier labels, most recently practiced first. */
  frontierLabels: string[];
  frictionSkillLabel: string | null;
  frictionMisses: number;
}

function inDigestWindow(
  ts: number | undefined,
  since: number,
  now: number,
): ts is number {
  return typeof ts === "number" && ts >= since && ts <= now;
}

function skillLabel(key: string, labelOf: ReadonlyMap<string, string>): string {
  return labelOf.get(key) ?? key.replace(/[-_]+/g, " ");
}

/**
 * The four trustworthy weekly signals for ONE scholar in ONE domain. Pure: the
 * caller supplies the scholar's mastery rows (already narrowed to `domain`),
 * their raw error events (any domain — filtered here), and the domain's node
 * label map.
 */
export function computeWeeklyPracticeSignals(input: {
  masteryRows: readonly WeeklyMasteryRow[];
  errorRows: readonly WeeklyErrorRow[];
  domain: string;
  since: number;
  now: number;
  labelOf: ReadonlyMap<string, string>;
}): WeeklyPracticeSignals {
  const { errorRows, domain, since, now, labelOf } = input;
  // Both callers pre-filter to the domain; filtering here too makes the helper
  // safe standalone and keeps one row internally coherent (all four signals
  // and the grade read from the SAME domain).
  const masteryRows = input.masteryRows.filter((r) => r.domain === domain);

  // Count REAL drill days only — `lastAttemptAt` is stamped solely by
  // recordAttemptCore, so placement/reprobe trust-upward (which stamps
  // `lastPracticedAt`/`updatedAt` at onboarding but is not practice) can't
  // inflate a practice-day count or flip a scholar out of "quiet".
  const days = new Set<number>();
  for (const row of masteryRows) {
    if (inDigestWindow(row.lastAttemptAt, since, now)) {
      days.add(Math.floor(row.lastAttemptAt / DAY_MS));
    }
  }

  // Transition stamps, not a read-time composite: `isFluent` decays with time,
  // so it cannot DATE a crossing. `becameFluentAt` / `frontierAdvancedAt` are
  // written once, at the crossing, by real practice only.
  const turnedFluentRows = masteryRows
    .filter((r) => inDigestWindow(r.becameFluentAt, since, now))
    .slice()
    .sort((a, b) => (b.becameFluentAt ?? 0) - (a.becameFluentAt ?? 0));
  const turnedFluentKeys = new Set(turnedFluentRows.map((r) => r.skillKey));

  const skillsAdvanced = masteryRows.filter((r) =>
    inDigestWindow(r.frontierAdvancedAt, since, now),
  ).length;

  const frontierLabels = masteryRows
    .filter((r) => r.frontier)
    .slice()
    .sort((a, b) => (b.lastPracticedAt ?? 0) - (a.lastPracticedAt ?? 0))
    .map((r) => skillLabel(r.skillKey, labelOf));

  // "Last practiced" = last REAL attempt, never `lastPracticedAt` (placement /
  // reprobe stamp that at onboarding). A scholar who only placed this week has
  // no attempt → null, so the surface omits the clause rather than claiming a
  // phantom drill.
  const lastAttemptAt =
    masteryRows.reduce((max, r) => Math.max(max, r.lastAttemptAt ?? 0), 0) || null;

  const missesByNode = new Map<string, number>();
  for (const row of errorRows) {
    if (row.domain !== domain) continue;
    if (row.createdAt < since || row.createdAt > now) continue;
    missesByNode.set(row.nodeKey, (missesByNode.get(row.nodeKey) ?? 0) + 1);
  }
  let frictionKey: string | null = null;
  let frictionMisses = 0;
  for (const [key, count] of missesByNode) {
    if (count < FRICTION_MIN_MISSES) continue;
    if (turnedFluentKeys.has(key)) continue;
    if (count > frictionMisses) {
      frictionMisses = count;
      frictionKey = key;
    }
  }

  return {
    practicedDays: Math.min(days.size, 7),
    lastAttemptAt,
    skillsTurnedFluent: turnedFluentRows.length,
    turnedFluentLabels: turnedFluentRows.map((r) => skillLabel(r.skillKey, labelOf)),
    skillsAdvanced,
    frontierLabels,
    frictionSkillLabel: frictionKey ? skillLabel(frictionKey, labelOf) : null,
    frictionMisses: frictionKey ? frictionMisses : 0,
  };
}

/** A compact pointer to work rendered in a subject cohort, not a second narrative. */
export interface PracticeElsewhereDigestRow {
  name: string;
  subject: string;
  count: number;
  link: string;
}

export interface PracticeCohortDigestRow {
  title: string;
  subjectKey?: string | null;
  teacherName?: string | null;
  dailyGoalMinutes?: number | null;
  scholars: PracticeScholarDigestRow[];
  elsewhere?: PracticeElsewhereDigestRow[];
}

export interface PracticeDigestInput {
  now: number;
  cohorts: PracticeCohortDigestRow[];
}

export interface PracticeDigest {
  text: string;
  cohortCount: number;
  scholarCount: number;
  practicedScholarCount: number;
  practicedDayCount: number;
  skillsTurnedFluent: number;
  skillsAdvanced: number;
  dueReviews: number;
  misconceptionFlags: number;
  needsPlacementCount: number;
}

export interface MathSkillsUpdate {
  text: string;
  threadText: string;
  cohortCount: number;
  scholarCount: number;
  topicCount: number;
}

/**
 * Match the Math Skills studio's roster fallback: use explicit math cohorts
 * when configured, otherwise use primary and ungrouped cohorts.
 */
export function selectMathSkillsUpdateCohorts(
  cohorts: PracticeCohortDigestRow[],
): PracticeCohortDigestRow[] {
  const mathCohorts = cohorts.filter((cohort) => cohort.subjectKey === "math");
  return mathCohorts.length > 0
    ? mathCohorts
    : cohorts.filter((cohort) => !cohort.subjectKey);
}

export type ScholarState =
  | "not_placed"
  | "quiet"
  | "flying"
  | "stuck"
  | "steady";

function clampDays(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(7, Math.round(n)));
}

function domainLabel(domain: string): string {
  return domain.replace(/[-_]+/g, " ");
}

function isoWeekKey(ts: number): string {
  const d = new Date(ts);
  const target = new Date(
    Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()),
  );
  const dayNr = (target.getUTCDay() + 6) % 7; // Mon=0 … Sun=6
  target.setUTCDate(target.getUTCDate() - dayNr + 3);
  const isoYear = target.getUTCFullYear();
  const firstThursday = new Date(Date.UTC(isoYear, 0, 4));
  const firstDayNr = (firstThursday.getUTCDay() + 6) % 7;
  firstThursday.setUTCDate(firstThursday.getUTCDate() - firstDayNr + 3);
  const week =
    1 + Math.round((target.getTime() - firstThursday.getTime()) / (7 * DAY_MS));
  return `${isoYear}-W${String(week).padStart(2, "0")}`;
}

function relativeDay(ts: number, now: number): string {
  const days = Math.floor(now / DAY_MS) - Math.floor(ts / DAY_MS);
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  return `${days} days ago`;
}

function safeName(s: PracticeScholarDigestRow): string {
  const trimmed = s.name.trim();
  return trimmed || s.username || "Scholar";
}

function byScholarName(
  a: PracticeScholarDigestRow,
  b: PracticeScholarDigestRow,
): number {
  return safeName(a).localeCompare(safeName(b), undefined, {
    sensitivity: "base",
  });
}

function byElsewhereName(
  a: PracticeElsewhereDigestRow,
  b: PracticeElsewhereDigestRow,
): number {
  return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
}

function byCohortTitle(
  a: PracticeCohortDigestRow,
  b: PracticeCohortDigestRow,
): number {
  const teacher = (a.teacherName ?? "").localeCompare(b.teacherName ?? "", undefined, {
    sensitivity: "base",
  });
  if (teacher !== 0) return teacher;
  return a.title.localeCompare(b.title, undefined, { sensitivity: "base" });
}

/** Turn a list of labels into "*a*", "*a* and *b*", or "*a*, *b* and N more". */
function named(labels: string[] | undefined, max = 2): string {
  const items = (labels ?? []).filter(Boolean).map((l) => `*${l}*`);
  if (items.length === 0) return "";
  if (items.length === 1) return items[0];
  if (items.length <= max) {
    return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
  }
  const shown = items.slice(0, max);
  return `${shown.join(", ")} and ${items.length - max} more`;
}

function joinAnd(parts: string[]): string {
  if (parts.length <= 1) return parts.join("");
  return `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}

/** The single most salient state for one scholar's week. */
export function classifyScholarState(s: PracticeScholarDigestRow): ScholarState {
  if (s.needsPlacement) return "not_placed";
  const days = clampDays(s.practicedDays);
  if (days === 0) return "quiet";
  const wins =
    Math.max(0, Math.round(s.skillsTurnedFluent)) +
    Math.max(0, Math.round(s.skillsAdvanced));
  if (wins >= FLYING_MIN_WINS) return "flying";
  if (wins === 0 && days >= STUCK_MIN_DAYS) return "stuck";
  return "steady";
}

const STATE_EMOJI: Record<ScholarState, string> = {
  not_placed: "🌱",
  quiet: "💤",
  flying: "🚀",
  stuck: "🌀",
  steady: "🔵",
};

/** "*frontier* (and N more at the edge)" for the scholar's current frontier. */
function frontierNow(s: PracticeScholarDigestRow): string | null {
  const labels = s.frontierLabels ?? [];
  if (labels.length === 0) return null;
  const extra = labels.length - 1;
  return `${named([labels[0]])}${extra > 0 ? ` (and ${extra} more at the edge)` : ""}`;
}

/** Shared closing clauses for the active states. */
function tailClauses(
  s: PracticeScholarDigestRow,
  opts: { includeFriction: boolean },
): string[] {
  const out: string[] = [];
  if (s.topStrand) {
    out.push(`Most of the week's work was in _${s.topStrand}_.`);
  }
  if (opts.includeFriction && s.frictionSkillLabel && (s.frictionMisses ?? 0) > 0) {
    out.push(
      `One spot of friction: ${s.frictionMisses} missed attempts on ${named([s.frictionSkillLabel])} — worth a peek.`,
    );
  }
  if ((s.breakerEvents ?? 0) > 0) {
    out.push(
      `The practice brake stepped in ${s.breakerEvents} ${s.breakerEvents === 1 ? "time" : "times"}.`,
    );
  }
  if (s.dueReviews > 0) {
    out.push(
      `${s.dueReviews} ${s.dueReviews === 1 ? "review has" : "reviews have"} since come due.`,
    );
  }
  if (s.misconceptionFlags > 0) {
    out.push(
      `${s.misconceptionFlags} teacher-only misconception flag${s.misconceptionFlags === 1 ? "" : "s"} open.`,
    );
  }
  return out;
}

function winPhrases(s: PracticeScholarDigestRow): string[] {
  const wins: string[] = [];
  if ((s.turnedFluentLabels?.length ?? 0) > 0) {
    wins.push(`confirmed ${named(s.turnedFluentLabels)} fluent`);
  } else if (s.skillsTurnedFluent > 0) {
    wins.push(
      `confirmed ${s.skillsTurnedFluent} skill${s.skillsTurnedFluent === 1 ? "" : "s"} fluent`,
    );
  }
  if (s.skillsAdvanced > 0) wins.push("moved the frontier forward");
  return wins;
}

/** Render one scholar as a single narrative bullet. */
export function renderScholarNote(s: PracticeScholarDigestRow, now: number): string {
  const state = classifyScholarState(s);
  const emoji = STATE_EMOJI[state];
  const name = safeName(s);
  const days = clampDays(s.practicedDays);
  const front = frontierNow(s);
  const sentences: string[] = [];

  if (state === "not_placed") {
    return `${emoji} *${name}* hasn't taken a placement yet, so practice can't begin — placing them is the unblocker.`;
  }

  if (state === "quiet") {
    let lead = `${emoji} *${name}* was quiet this week`;
    lead += s.lastPracticedAt
      ? ` — last practiced ${relativeDay(s.lastPracticedAt, now)}.`
      : " — no practice recorded yet.";
    sentences.push(lead);
    if (front) {
      sentences.push(`Still at the edge on ${front}; a nudge might restart them.`);
    } else {
      sentences.push("A nudge might help them get going.");
    }
    if (s.dueReviews > 0) {
      sentences.push(
        `${s.dueReviews} ${s.dueReviews === 1 ? "review is" : "reviews are"} now due, waiting for a return.`,
      );
    }
    return sentences.join(" ");
  }

  if (state === "flying") {
    const wins = winPhrases(s);
    let lead = `${emoji} *${name}* had a strong week — practiced ${days} of 7 days`;
    lead += wins.length > 0 ? `, ${joinAnd(wins)}.` : ".";
    sentences.push(lead);
    if (front) sentences.push(`Working now at the edge on ${front}.`);
    sentences.push(...tailClauses(s, { includeFriction: true }));
    return sentences.join(" ");
  }

  if (state === "stuck") {
    let lead = `${emoji} *${name}* put in ${days} of 7 days, but nothing has crossed into fluent yet`;
    if (s.frictionSkillLabel && (s.frictionMisses ?? 0) > 0) {
      lead += ` — the friction is on ${named([s.frictionSkillLabel])} (${s.frictionMisses} missed attempts). Worth a check-in.`;
    } else if (front) {
      lead += ` — still circling ${front}. Worth a check-in.`;
    } else {
      lead += ". Worth a check-in.";
    }
    sentences.push(lead);
    sentences.push(...tailClauses(s, { includeFriction: false }));
    return sentences.join(" ");
  }

  // steady
  const wins = winPhrases(s);
  let lead = `${emoji} *${name}* kept at it — practiced ${days} of 7 days`;
  lead += wins.length > 0 ? `, ${joinAnd(wins)}.` : ".";
  sentences.push(lead);
  if (front) sentences.push(`Working on ${front}.`);
  sentences.push(...tailClauses(s, { includeFriction: true }));
  return sentences.join(" ");
}

function cohortHeadline(scholars: PracticeScholarDigestRow[]): string {
  const total = scholars.length;
  const practiced = scholars.filter((s) => clampDays(s.practicedDays) > 0).length;
  const counts: Record<ScholarState, number> = {
    not_placed: 0,
    quiet: 0,
    flying: 0,
    stuck: 0,
    steady: 0,
  };
  for (const s of scholars) counts[classifyScholarState(s)] += 1;

  const descriptors: string[] = [];
  if (counts.flying > 0) descriptors.push(`${counts.flying} moving fast`);
  if (counts.stuck > 0) descriptors.push(`${counts.stuck} circling a skill`);
  if (counts.steady > 0) descriptors.push(`${counts.steady} steady`);
  if (counts.quiet > 0) descriptors.push(`${counts.quiet} quiet`);
  if (counts.not_placed > 0) descriptors.push(`${counts.not_placed} still to place`);

  const base = `${practiced} of ${total} scholar${total === 1 ? "" : "s"} practiced this week`;
  return descriptors.length > 0 ? `${base} — ${descriptors.join(", ")}.` : `${base}.`;
}

function sumScholars(
  scholars: PracticeScholarDigestRow[],
): Omit<PracticeDigest, "text" | "cohortCount"> {
  return scholars.reduce(
    (acc, s) => {
      const practicedDays = clampDays(s.practicedDays);
      acc.scholarCount += 1;
      acc.practicedScholarCount += practicedDays > 0 ? 1 : 0;
      acc.practicedDayCount += practicedDays;
      acc.skillsTurnedFluent += Math.max(0, Math.round(s.skillsTurnedFluent));
      acc.skillsAdvanced += Math.max(0, Math.round(s.skillsAdvanced));
      acc.dueReviews += Math.max(0, Math.round(s.dueReviews));
      acc.misconceptionFlags += Math.max(0, Math.round(s.misconceptionFlags));
      acc.needsPlacementCount += s.needsPlacement ? 1 : 0;
      return acc;
    },
    {
      scholarCount: 0,
      practicedScholarCount: 0,
      practicedDayCount: 0,
      skillsTurnedFluent: 0,
      skillsAdvanced: 0,
      dueReviews: 0,
      misconceptionFlags: 0,
      needsPlacementCount: 0,
    },
  );
}

function renderElsewhereReference(reference: PracticeElsewhereDigestRow): string {
  return `↳ *${reference.name}* — practiced ${reference.count}× in [${reference.subject}](${reference.link})`;
}

function renderCohort(cohort: PracticeCohortDigestRow, now: number): string[] {
  const scholars = [...cohort.scholars].sort(byScholarName);
  const elsewhere = (cohort.elsewhere ?? [])
    .filter((reference) => reference.count > 0)
    .sort(byElsewhereName);
  const lines: string[] = [];
  const meta = [
    cohort.teacherName ?? null,
    cohort.dailyGoalMinutes ? `${cohort.dailyGoalMinutes} min/day` : null,
  ].filter((x): x is string => !!x);

  lines.push(`*${cohort.title}*${meta.length > 0 ? ` · ${meta.join(" · ")}` : ""}`);

  if (scholars.length === 0 && elsewhere.length === 0) {
    lines.push("No scholars in this cohort yet.");
    return lines;
  }

  if (scholars.length > 0) {
    lines.push(cohortHeadline(scholars));
    for (const scholar of scholars) {
      lines.push(
        `• _${domainLabel(scholar.domain)}_ · ${renderScholarNote(scholar, now)}`,
      );
    }
  }
  for (const reference of elsewhere) lines.push(renderElsewhereReference(reference));

  return lines;
}

export function computePracticeDigest(input: PracticeDigestInput): PracticeDigest {
  const cohorts = [...input.cohorts].sort(byCohortTitle);
  const allScholars = cohorts.flatMap((c) => c.scholars);
  const totals = sumScholars(allScholars);
  const activeCohorts = cohorts.filter((c) => c.scholars.length > 0);

  const lines: string[] = [
    `🧭 *Practice Portrait — week of ${isoWeekKey(input.now)}*`,
    "_One portrait per scholar — measured only against their own record._",
  ];

  if (cohorts.length === 0) {
    lines.push("No practice cohorts were found this week.");
    return {
      text: lines.join("\n"),
      cohortCount: 0,
      ...totals,
    };
  }

  if (totals.scholarCount === 0) {
    lines.push("No scholars had practice to narrate this week.");
  } else {
    lines.push(
      `Across ${activeCohorts.length} practice cohort${activeCohorts.length === 1 ? "" : "s"}: ${totals.practicedScholarCount} of ${totals.scholarCount} scholar${totals.scholarCount === 1 ? "" : "s"} practiced this week.`,
    );
  }

  for (const cohort of cohorts) {
    lines.push("");
    for (const line of renderCohort(cohort, input.now)) lines.push(line);
  }

  return {
    text: lines.join("\n"),
    cohortCount: activeCohorts.length,
    ...totals,
  };
}

function renderPriorityTopic(topic: MathSkillsPriorityTopic): string {
  const label = escapeSlackText(topic.label.trim() || topic.nodeKey);
  const linked = topic.link ? `[${label}](${topic.link})` : `*${label}*`;
  const marker = {
    practice: "",
    acute: "🟠 ",
    sustained: "🔴 ",
  }[topic.tier];
  const sittings = `${topic.missSittingCount} ${
    topic.missSittingCount === 1 ? "sitting" : "sittings"
  }`;
  return `  ${marker}${linked} — missed ${topic.missCount} of ${topic.attemptCount}, ${sittings}`;
}

function renderPriorityTopicEvidence(
  topic: MathSkillsPriorityTopic,
): string | undefined {
  if (!topic.narrative) return undefined;
  const label = escapeSlackText(topic.label.trim() || topic.nodeKey);
  const linked = topic.link ? `[${label}](${topic.link})` : `*${label}*`;
  return `  • ${linked} — ${escapeSlackText(topic.narrative)}`;
}

/** Slack-escaped variant of `named`, for labels rendered in the #math note. */
function namedSafe(labels: string[] | undefined, max = 2): string {
  return named(
    (labels ?? []).filter(Boolean).map((label) => escapeSlackText(label)),
    max,
  );
}

/**
 * One calm line placing a flagged scholar's misses inside their OWN week:
 * days practiced, what crossed into fluent, and where the frontier sits now.
 * Every clause is optional and every number is one the row already carries from
 * stored crossing stamps — a scholar with no wins simply gets a shorter line,
 * and one with nothing at all to show gets no line rather than a fabricated win.
 */
export function renderMathScholarWeekContext(
  s: PracticeScholarDigestRow,
): string | null {
  const parts: string[] = [];
  const days = clampDays(s.practicedDays);
  if (days > 0) parts.push(`practiced ${days} of 7 days`);
  if ((s.turnedFluentLabels?.length ?? 0) > 0) {
    parts.push(`confirmed ${namedSafe(s.turnedFluentLabels)} fluent`);
  } else if (s.skillsTurnedFluent > 0) {
    parts.push(
      `confirmed ${s.skillsTurnedFluent} skill${s.skillsTurnedFluent === 1 ? "" : "s"} fluent`,
    );
  }
  if (s.skillsAdvanced > 0) parts.push("moved the frontier forward");
  const frontier = (s.frontierLabels ?? []).filter(Boolean);
  if (frontier.length > 0) {
    const extra = frontier.length - 1;
    parts.push(
      `now at the edge on ${namedSafe([frontier[0]])}${extra > 0 ? ` (and ${extra} more at the edge)` : ""}`,
    );
  }
  if (parts.length === 0) return null;
  return `This week: ${joinAnd(parts)}.`;
}

/**
 * The cohort's week in one line, so the note shows genuine wins alongside the
 * worklist. Both numbers come from in-window crossing stamps only — never a
 * band-count delta, a time reading, or any learner-vs-learner ordering.
 */
function renderCohortWins(
  scholars: readonly PracticeScholarDigestRow[],
): string | null {
  let fluent = 0;
  let advanced = 0;
  for (const scholar of scholars) {
    fluent += Math.max(0, Math.round(scholar.skillsTurnedFluent));
    advanced += Math.max(0, Math.round(scholar.skillsAdvanced));
  }
  const parts: string[] = [];
  if (fluent > 0) {
    parts.push(`${fluent} skill${fluent === 1 ? "" : "s"} crossed into fluent`);
  }
  if (advanced > 0) {
    parts.push(`${advanced} frontier move${advanced === 1 ? "" : "s"}`);
  }
  if (parts.length === 0) return null;
  return `_Wins this week: ${joinAnd(parts)}._`;
}

/**
 * The scheduled #math note: a portrait with priorities. Topics are already
 * ranked from canonical practice evidence by the Convex snapshot; this renderer
 * groups them by scholar, frames each scholar's flagged topics inside their own
 * week, and keeps the copy short.
 */
export function computeMathSkillsUpdate(
  input: PracticeDigestInput,
): MathSkillsUpdate {
  const cohorts = [...input.cohorts]
    .map((cohort) => ({
      ...cohort,
      scholarsWithTopics: cohort.scholars
        .filter(
          (scholar) =>
            (scholar.mathPracticeCount ?? 0) > 0 &&
            (scholar.priorityTopics?.length ?? 0) > 0,
        )
        .sort(byScholarName),
      activeWithoutTopics: cohort.scholars
        .filter(
          (scholar) =>
            (scholar.mathPracticeCount ?? 0) > 0 &&
            (scholar.priorityTopics?.length ?? 0) === 0,
        )
        .sort(byScholarName),
    }))
    .filter(
      (cohort) =>
        cohort.scholarsWithTopics.length > 0 ||
        cohort.activeWithoutTopics.length > 0,
    )
    .sort(byCohortTitle);
  const scholars = cohorts.flatMap((cohort) => cohort.scholarsWithTopics);
  const allScholars = input.cohorts.flatMap((cohort) => cohort.scholars);
  const activeScholarCount = allScholars.filter(
    (scholar) => (scholar.mathPracticeCount ?? 0) > 0,
  ).length;
  const mathAttemptCount = allScholars.reduce(
    (sum, scholar) => sum + (scholar.mathPracticeCount ?? 0),
    0,
  );
  const mathMissCount = allScholars.reduce(
    (sum, scholar) => sum + (scholar.mathMissCount ?? 0),
    0,
  );
  const topicCount = scholars.reduce(
    (sum, scholar) => sum + (scholar.priorityTopics?.length ?? 0),
    0,
  );
  const lines = [
    `🎯 *Math skills — week of ${isoWeekKey(input.now)}*`,
    "_Each scholar's own week first, then the topics worth a 1:1 — 🔴 returned across sittings · 🟠 practice brake tripped · unmarked = repeated misses. Due reviews are automatic._",
  ];
  const threadLines = ["*Evidence behind this week's topics*"];
  let hasThreadEvidence = false;

  if (scholars.length === 0) {
    if (mathAttemptCount === 0) {
      lines.push("No math practice was recorded this week.");
    } else if (mathMissCount === 0) {
      lines.push(
        `${activeScholarCount} ${activeScholarCount === 1 ? "scholar practiced" : "scholars practiced"} math this week, with no missed attempts.`,
      );
    } else {
      lines.push(
        `${activeScholarCount} ${activeScholarCount === 1 ? "scholar practiced" : "scholars practiced"} math this week, but no skill was missed at least twice — nothing repeated enough to queue for a 1:1.`,
      );
    }
  }

  for (const cohort of cohorts) {
    lines.push("");
    lines.push(`*👥 ${escapeSlackText(cohort.title)}*`);
    const cohortWins = renderCohortWins([
      ...cohort.scholarsWithTopics,
      ...cohort.activeWithoutTopics,
    ]);
    if (cohortWins) lines.push(cohortWins);
    for (const scholar of cohort.scholarsWithTopics) {
      lines.push(`• *${escapeSlackText(safeName(scholar))}*`);
      const context = renderMathScholarWeekContext(scholar);
      if (context) lines.push(`  ${context}`);
      for (const topic of scholar.priorityTopics ?? []) {
        lines.push(renderPriorityTopic(topic));
      }

      const evidence = (scholar.priorityTopics ?? [])
        .map(renderPriorityTopicEvidence)
        .filter((line): line is string => Boolean(line));
      if (evidence.length > 0) {
        if (!hasThreadEvidence) {
          hasThreadEvidence = true;
        }
        threadLines.push("");
        threadLines.push(
          `*${escapeSlackText(cohort.title)} · ${escapeSlackText(safeName(scholar))}*`,
        );
        threadLines.push(...evidence);
      }
    }
    if (cohort.activeWithoutTopics.length > 0) {
      lines.push(
        `  _Also practiced this week, with nothing repeating enough to queue: ${cohort.activeWithoutTopics
          .map((scholar) => escapeSlackText(safeName(scholar)))
          .join(", ")}._`,
      );
    }
  }

  return {
    text: lines.join("\n"),
    threadText: hasThreadEvidence ? threadLines.join("\n") : "",
    cohortCount: cohorts.length,
    scholarCount: scholars.length,
    topicCount,
  };
}
