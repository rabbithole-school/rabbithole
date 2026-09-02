/**
 * feedMomentum — pure derivation of the Feed reassurance strip's "momentum"
 * (practice velocity) signal from data already in the schema. Deliberately
 * NOT a stored history table (see review/practice/practice-engine-roadmap.html
 * §6): everything here is recomputed live from `practiceMastery` (the
 * problem-set engine) + `masteryObservations` (the observer's tutoring
 * evidence), so the read stays honest as either source grows or is empty.
 *
 * Two honest, positive-framed counts — never a rank, never a deficit:
 *  - daysActive: distinct calendar days, in a trailing window, on which the
 *    scholar did REAL activity — attempted a skill (a practiceMastery row whose
 *    `lastAttemptAt` falls in the window; `recordAttemptCore` stamps it on every
 *    recorded attempt and nothing else does) or the observer recorded fresh
 *    mastery evidence from a tutoring session. It deliberately EXCLUDES anything
 *    that is not scholar activity: `lastPracticedAt` (the spaced-repetition
 *    clock, which bulk PLACEMENT and REPROBE also stamp at onboarding), a
 *    teacher-pinned skill the scholar hasn't touched, and a teacher-flagged
 *    observation (`attemptContext === "teacher-flagged"`) — otherwise the
 *    scholar-facing strip would report a "practice day" on which the scholar did
 *    nothing.
 *  - skillsStrengthened: distinct skills/concepts that CROSSED a bar in the last
 *    7 days — a practice skill whose stored crossing stamp (`becameFluentAt` or
 *    `frontierAdvancedAt`) lands in the window, or a chat-demonstrated concept
 *    at/above the "Demonstrated" bar the Feed timeline itself already uses
 *    (masteryLevel >= 2.5 — see components/ScholarFeed.tsx). One bar, reused,
 *    not invented.
 *
 *    The crossing stamps are written ONLY by `recordAttemptCore`, and only when
 *    the demonstrated gate flips (`accessProven && source === "practice"`), so a
 *    strengthened skill always means a real drill crossing. The previous
 *    predicate — `repetition > 0 && updatedAt >= since7` — checked neither the
 *    source nor whether any attempt happened, so a bulk placement row satisfied
 *    it and the count read "skills strengthened this week" for a week in which
 *    nothing was practised. That is the "wrong number laundered into a fact"
 *    failure; the count is now smaller and true.
 */

const MS_PER_DAY = 86_400_000;

/** The window "practiced N days in the last …" reassures over. */
export const MOMENTUM_WINDOW_DAYS = 14;

/** The window "M skills strengthened this …" reassures over. */
export const SKILLS_STRENGTHENED_WINDOW_DAYS = 7;

// Mirrors the "Demonstrated" threshold ScholarFeed's timeline already applies
// to masteryObservations (o.masteryLevel >= 2.5) — reuse the same bar rather
// than inventing a second one for the reassurance strip.
export const DEMONSTRATED_MASTERY_LEVEL = 2.5;

export type PracticeMasteryRow = {
  skillKey: string;
  repetition: number;
  updatedAt: number;
  /** Stamped by recordAttemptCore on every recorded attempt. The honest drill clock. */
  lastAttemptAt?: number;
  /** The spaced-repetition clock. Placement and reprobe stamp it too — NOT a drill signal. */
  lastPracticedAt?: number;
  /** One-time demonstrated-fluency crossing. Never set by placement/reprobe/accelerated. */
  becameFluentAt?: number;
  /** One-time access-frontier advance proven THROUGH practice. */
  frontierAdvancedAt?: number;
};

export type MasteryObservationRow = {
  conceptLabel: string;
  masteryLevel: number;
  observedAt: number;
  /** How the observation arose. "teacher-flagged" = a teacher assertion, NOT
   *  scholar activity, so it must not count toward daysActive. */
  attemptContext?: string;
};

export type Momentum = {
  daysActive: number;
  windowDays: number;
  skillsStrengthened: number;
};

function crossedIn(at: number | undefined, since: number, now: number): boolean {
  return typeof at === "number" && at >= since && at <= now;
}

export function computeMomentum(
  practiceRows: PracticeMasteryRow[],
  observations: MasteryObservationRow[],
  now: number,
): Momentum {
  const since14 = now - MOMENTUM_WINDOW_DAYS * MS_PER_DAY;
  const since7 = now - SKILLS_STRENGTHENED_WINDOW_DAYS * MS_PER_DAY;

  const activeDays = new Set<number>();
  const strengthened = new Set<string>();

  for (const row of practiceRows) {
    // Active days = REAL attempts only. `lastAttemptAt` is stamped solely by
    // recordAttemptCore, so a scholar who was only placed or reprobed this
    // week — which stamps `lastPracticedAt`/`updatedAt` — does not gain a
    // phantom practice day.
    if (row.lastAttemptAt !== undefined && row.lastAttemptAt >= since14) {
      activeDays.add(Math.floor(row.lastAttemptAt / MS_PER_DAY));
    }
    // "Strengthened" must mean a bar was CROSSED, not that a row was touched.
    if (
      crossedIn(row.becameFluentAt, since7, now) ||
      crossedIn(row.frontierAdvancedAt, since7, now)
    ) {
      strengthened.add(`skill:${row.skillKey}`);
    }
  }

  for (const obs of observations) {
    // A teacher-flagged observation is a teacher ASSERTION, not scholar
    // activity, so it must not count as a practice day. (Observer-detected
    // observations DO — they come from a real tutoring session.)
    const teacherAsserted = obs.attemptContext === "teacher-flagged";
    if (!teacherAsserted && obs.observedAt >= since14) {
      activeDays.add(Math.floor(obs.observedAt / MS_PER_DAY));
    }
    if (obs.masteryLevel >= DEMONSTRATED_MASTERY_LEVEL && obs.observedAt >= since7) {
      strengthened.add(`concept:${obs.conceptLabel}`);
    }
  }

  return {
    daysActive: activeDays.size,
    windowDays: MOMENTUM_WINDOW_DAYS,
    skillsStrengthened: strengthened.size,
  };
}
