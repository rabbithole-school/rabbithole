/**
 * Grade levels for a scholar's math, pure and testable, so each number and its
 * trajectory are the SAME function evaluated at different times.
 *
 * {@link mathLevel} is the level every surface shows, for all of math and for
 * one area: how much of each grade's skills the scholar is credited with, added
 * up. Credit from the placement check-in counts and is reported separately.
 *
 * {@link frontierGradeValue} is the LEGACY per-area figure, shown beside the
 * level as "highest": the highest grade in which the scholar has shown a skill
 * in daily practice. It measures reach, so it reads above the level.
 *
 * The "highest" gate is the DEMONSTRATED one (`isFluent`, ctx-free =
 * access-proven AND a demonstrated source), NOT the generous `accessProven`, and
 * `becameFluentAt` stamps exactly that gate flipping. So a placement credit
 * never raises the highest figure.
 *
 * Trajectory (`asOf`) reconstructs a past point from the forward-only
 * `becameFluentAt` stamp. A demonstrated-fluent row WITHOUT a stamp
 * (pre-instrumentation) counts from the baseline, so the reconstructed series is
 * monotonic and equals the live value at `asOf = now` — real data, honestly
 * left-censored ("since we started tracking"), never a fabricated trend.
 */

import { accessProven, isFluent } from "./scheduler";
import { gradeRank, gradeLabelFromRank } from "../../../shared/gradeRange";

export interface MasteryRowForGrade {
  skillKey: string;
  repetition: number;
  source?: string;
  becameFluentAt?: number;
  /** When access was proven THROUGH practice (recordAttemptCore), if it was.
   *  Its absence on a demonstrated row means the credit came first (placement
   *  or reprobe): see {@link mathLevel}'s `asOf`. */
  frontierAdvancedAt?: number;
}

/**
 * LEGACY ("highest"): the whole grade under {@link frontierGradeValue}.
 *
 * The demonstrated-fluent frontier RANK for one domain's mastery rows, or null
 * when the scholar has no demonstrated-fluent skill with a known grade yet.
 * `asOf` (ms) reconstructs the rank at a past instant; omit it for "now".
 */
export function frontierRank(
  rows: readonly MasteryRowForGrade[],
  gradeByKey: ReadonlyMap<string, string | null | undefined>,
  asOf?: number,
): number | null {
  let max: number | null = null;
  for (const row of rows) {
    if (!isFluent(row)) continue;
    if (asOf !== undefined) {
      const at = row.becameFluentAt;
      // Stamped after the cutoff → not yet fluent then. Unstamped demonstrated
      // rows are baseline (pre-instrumentation) and count at every cutoff.
      if (at !== undefined && at > asOf) continue;
    }
    const rank = gradeRank(gradeByKey.get(row.skillKey));
    if (rank === null) continue;
    if (max === null || rank > max) max = rank;
  }
  return max;
}

/**
 * LEGACY, shown as "highest": surfaces show {@link mathLevel} as the area's
 * level and this beside it, the highest grade reached in daily practice.
 *
 * The scholar's CONTINUOUS demonstrated-fluent frontier grade for one domain, on
 * the grade-equivalent convention "G.m" (G = the top grade reached, m = tenths of
 * within-grade progress — so "Grade 5.2" reads as "early into 5th-grade work").
 * It is the integer {@link frontierRank} G plus how much of grade G's catalog the
 * scholar has demonstrated fluently — a REAL signal (fluent-at-G / total-at-G in
 * the domain's knowledge graph), never a fabricated decimal. `total-at-G` is read
 * from `gradeByKey`'s value distribution (the whole-domain catalog the caller has
 * already loaded), so this needs no extra data.
 *
 * Within-grade completion is capped at 0.9 so a fully-consolidated grade reads
 * "G.9" (ready to exit) and never rolls to "(G+1).0" — which would imply evidence
 * at a grade the scholar has not touched. A real fluent skill at G+1 advances the
 * integer part instead, so the value is monotonic non-decreasing over `asOf`
 * exactly like {@link frontierRank}, keeping the trajectory honest.
 */
export function frontierGradeValue(
  rows: readonly MasteryRowForGrade[],
  gradeByKey: ReadonlyMap<string, string | null | undefined>,
  asOf?: number,
): number | null {
  const top = frontierRank(rows, gradeByKey, asOf);
  if (top === null) return null;
  // total-at-top: how many of the domain's catalog nodes sit at the frontier
  // grade (time-invariant). ≥ 1, since the fluent frontier skill is itself one.
  let totalAtTop = 0;
  for (const grade of gradeByKey.values()) {
    if (gradeRank(grade) === top) totalAtTop++;
  }
  // fluent-at-top by `asOf`: how many of those the scholar has demonstrated.
  let fluentAtTop = 0;
  for (const r of rows) {
    if (!isFluent(r)) continue;
    if (asOf !== undefined && r.becameFluentAt !== undefined && r.becameFluentAt > asOf) continue;
    if (gradeRank(gradeByKey.get(r.skillKey)) === top) fluentAtTop++;
  }
  const completion = totalAtTop > 0 ? Math.min(fluentAtTop / totalAtTop, 0.9) : 0;
  return top + completion;
}

/**
 * The compact grade-equivalent label ("Grade 2.2", "Grade K.4") for a continuous
 * grade value ({@link mathLevel} or {@link frontierGradeValue}), or null.
 * Always one decimal place. Grade K (rank 0) keeps its "K" token, so a
 * kindergarten-band value reads "Grade K.4".
 */
export function gradeLabelFromValueOrNull(value: number | null): string | null {
  if (value === null) return null;
  // Round the whole value first: splitting 1.96 before rounding gives "1.10".
  const tenths = Math.round(value * 10);
  const whole = Math.floor(tenths / 10);
  const tenth = tenths - whole * 10;
  const token = whole <= 0 ? "K" : String(whole);
  return `Grade ${token}.${tenth}`;
}

/** How many of a domain's rows are demonstrated-fluent (the "N fluent skills"
 *  count that annotates the grade — same gate as {@link frontierRank}). `asOf`
 *  (ms) counts only skills fluent by that instant, consistent with a past
 *  trajectory point; omit it for "now". */
export function fluentCount(
  rows: readonly MasteryRowForGrade[],
  asOf?: number,
): number {
  let n = 0;
  for (const row of rows) {
    if (!isFluent(row)) continue;
    if (asOf !== undefined) {
      const at = row.becameFluentAt;
      if (at !== undefined && at > asOf) continue;
    }
    n++;
  }
  return n;
}

/**
 * The labels of the skills {@link fluentCount} counts (same gate), newest
 * fluent first: skills stamped `becameFluentAt` by stamp, then unstamped ones
 * (fluent before the stamp existed, so older than any stamped skill). A skill
 * with no usable label is left out rather than named by its key, so the list
 * is never longer than the count. `limit` keeps only the newest few.
 */
export function fluentSkillLabelsNewestFirst(
  rows: readonly MasteryRowForGrade[],
  labelByKey: ReadonlyMap<string, string | undefined>,
  limit?: number,
): string[] {
  const labels = rows
    .filter((r) => isFluent(r))
    .map((r) => ({ at: r.becameFluentAt ?? 0, label: labelByKey.get(r.skillKey)?.trim() ?? "" }))
    .filter((s) => s.label.length > 0)
    .sort((a, b) => b.at - a.at)
    .map((s) => s.label);
  return limit === undefined ? labels : labels.slice(0, limit);
}

/** The compact grade label ("Grade K", "Grade 5") for a rank, or null. */
export function gradeLabelFromRankOrNull(rank: number | null): string | null {
  return rank === null ? null : `Grade ${gradeLabelFromRank(rank)}`;
}

/**
 * Month-boundary instants ending at `now`, oldest → newest, `count` points
 * total (so the last element is `now`). Calendar months at server-local time —
 * month granularity, so DST/tz drift is immaterial.
 */
export function monthBoundaries(now: number, count: number): number[] {
  const d = new Date(now);
  const points: number[] = [];
  for (let i = count - 1; i >= 1; i--) {
    points.push(new Date(d.getFullYear(), d.getMonth() - i, 1).getTime());
  }
  points.push(now);
  return points;
}

// ── Math level: how much of each grade's math the scholar has covered ───────
// The level every surface shows, for all of math together and for one area.
// For each grade it takes the share of that grade's catalog skills the scholar
// is credited with, and adds the shares up from the catalog's lowest grade.
// All of K through 4 reads 5.0 (ready to start grade 5). Reaching far in one
// place while leaving the rest untouched earns credit only for the skills
// filled in. The legacy per-area figure, {@link frontierGradeValue}, is kept
// beside it as "highest".
//
// An area's catalog can start above kindergarten (ratios starts at grade 6) and
// can skip a grade. The lowest grade present is the starting point, and a grade
// with no skills in this area counts as passed once the scholar has credit
// above it: there is nothing in it to learn.

/** A grade counts as solid at this share of its skills. The same line the
 *  Acceleration view draws for a mastered band (`MASTERED_PCT`, acceleration.ts). */
export const SOLID_GRADE_SHARE = 0.8;

export interface MathLevelBand {
  /** Grade rank: 0 is kindergarten. */
  rank: number;
  /** Catalog skills at this grade in the catalog read. */
  total: number;
  /** Shown fluent in daily practice (the demonstrated gate, `isFluent`). */
  daily: number;
  /** Credited without daily proof: the placement check-in and the other
   *  inferred sources (`accessProven` and not `isFluent`). */
  placement: number;
}

export interface MathLevel {
  /** `baseValue + dailyValue + placementValue`. */
  value: number;
  /** The grades counted as passed without any skills to show for them: the
   *  catalog's lowest grade rank, plus every grade below the highest credited
   *  one that has no skills in this catalog. 0 for the whole catalog. */
  baseValue: number;
  /** The part of the shares shown in daily practice. */
  dailyValue: number;
  /** The part of the shares credited from the placement check-in. */
  placementValue: number;
  dailySkills: number;
  placementSkills: number;
  /** Highest grade rank with every grade up to it solid, or null when the
   *  catalog's lowest grade is not solid yet. Grades with no skills in the
   *  catalog are skipped. */
  solidThroughRank: number | null;
  /** One band per grade present in the catalog, lowest upward. */
  bands: MathLevelBand[];
}

/**
 * The level from a scholar's mastery rows and a catalog's grades: the whole
 * catalog for the overall level, one area's catalog for that area. A row whose
 * skill has no graded node in the catalog is left out, as is a second row for
 * the same skill. Null when nothing is credited yet.
 *
 * `asOf` (ms) reconstructs a past point for the trajectory from the two
 * forward-only stamps the write path sets (recordAttemptCore):
 *   • a row counts from `frontierAdvancedAt` when it has one: access was proven
 *     through practice then;
 *   • a demonstrated row with `becameFluentAt` but NO `frontierAdvancedAt` was
 *     access-proven before the attempt that demonstrated it (both stamps date
 *     from the same release, PR #527, and only inferred credit proves access
 *     outside the write path), so it was credited first, by the placement
 *     check-in or a reprobe, and counts from the baseline like any placement
 *     credit;
 *   • anything unstamped counts from the baseline (left-censoring, as in
 *     {@link frontierRank}).
 * A credited row counts as daily work only once demonstrated by `asOf`, and
 * as placement credit before that. Omit `asOf` for "now".
 */
export function mathLevel(
  rows: readonly MasteryRowForGrade[],
  gradeByKey: ReadonlyMap<string, string | null | undefined>,
  opts: { asOf?: number } = {},
): MathLevel | null {
  const { asOf } = opts;
  const bandByRank = new Map<number, MathLevelBand>();
  for (const grade of gradeByKey.values()) {
    const rank = gradeRank(grade);
    if (rank === null || rank < 0) continue;
    const band = bandByRank.get(rank) ?? { rank, total: 0, daily: 0, placement: 0 };
    band.total++;
    bandByRank.set(rank, band);
  }
  const seen = new Set<string>();
  for (const row of rows) {
    if (seen.has(row.skillKey) || !accessProven(row)) continue;
    let fluent = isFluent(row);
    if (asOf !== undefined) {
      if (row.frontierAdvancedAt !== undefined && row.frontierAdvancedAt > asOf) continue;
      if (fluent && row.becameFluentAt !== undefined && row.becameFluentAt > asOf) {
        // Credited by `asOf` (see above) but not yet demonstrated.
        fluent = false;
      }
    }
    const rank = gradeRank(gradeByKey.get(row.skillKey));
    const band = rank === null ? undefined : bandByRank.get(rank);
    if (!band) continue;
    seen.add(row.skillKey);
    if (fluent) band.daily++;
    else band.placement++;
  }
  const bands = [...bandByRank.values()].sort((a, b) => a.rank - b.rank);
  let dailyValue = 0;
  let placementValue = 0;
  let dailySkills = 0;
  let placementSkills = 0;
  let topCredited: number | null = null;
  let solidThroughRank: number | null = null;
  let stillSolid = true;
  for (const band of bands) {
    dailyValue += band.daily / band.total;
    placementValue += band.placement / band.total;
    dailySkills += band.daily;
    placementSkills += band.placement;
    if (band.daily + band.placement > 0) topCredited = band.rank;
    if (stillSolid && (band.daily + band.placement) / band.total >= SOLID_GRADE_SHARE) {
      solidThroughRank = band.rank;
    } else {
      stillSolid = false;
    }
  }
  if (topCredited === null) return null;
  const minRank = bands[0].rank;
  // Grades strictly between the lowest and the highest credited one with no
  // skills in this catalog: passed, since there is nothing in them to learn.
  let absentPassed = 0;
  for (let rank = minRank + 1; rank < topCredited; rank++) {
    if (!bandByRank.has(rank)) absentPassed++;
  }
  const baseValue = minRank + absentPassed;
  return {
    value: baseValue + dailyValue + placementValue,
    baseValue,
    dailyValue,
    placementValue,
    dailySkills,
    placementSkills,
    solidThroughRank,
    bands,
  };
}

// ── Learned pace: new learning against a standard curriculum's clock ────────
// A standard curriculum covers one grade in a ten-month school year, so the
// expected pace is one month of curriculum per month of school. Counting every
// skill that turned fluent overstates it badly: in a scholar's first weeks they
// prove skills they arrived with. So a skill counts as LEARNED only when the
// misses on the way to fluent show learning (see {@link isLearnedSkill});
// otherwise it was ALREADY KNOWN. The caller supplies the learned skills (it
// owns the attempts read).

/** School months in one grade of a standard curriculum. */
export const SCHOOL_MONTHS_PER_GRADE = 10;
const AVG_MONTH_MS = 30.44 * 86_400_000;
/** Below this much school the rate is not stated: a few days of practice
 *  divided by a few days of school is not a pace. */
export const MIN_SCHOOL_MONTHS_FOR_PACE = 1;

/**
 * Where a scholar's pace window starts: the term's start, or the day the
 * scholar joined when that is later. A midyear joiner is never divided by
 * school months they were not here for. `joinedAtMs` is the account's
 * creation time (there is no enrollment date on `users`); absent, the term
 * start stands.
 */
export function paceWindowStart(termStartMs: number, joinedAtMs: number | undefined): number {
  return Math.max(termStartMs, joinedAtMs ?? termStartMs);
}

export interface LearnedPace {
  /** Months of curriculum in skills learned in the window. */
  learnedMonths: number;
  /** Months of curriculum in skills that went fluent already known. */
  knownMonths: number;
  learnedSkills: number;
  knownSkills: number;
  /** Calendar months from the window's start to its end. */
  schoolMonths: number;
  /** learnedMonths / schoolMonths; 1 is the standard pace. Null before
   *  {@link MIN_SCHOOL_MONTHS_FOR_PACE} of school. */
  pace: number | null;
}

/** The skills that turned demonstrated-fluent inside (startMs, endMs] and sit
 *  on a graded catalog node: the ones the pace is built from. */
export function skillsFluentInWindow(
  rows: readonly MasteryRowForGrade[],
  gradeByKey: ReadonlyMap<string, string | null | undefined>,
  startMs: number,
  endMs: number,
): MasteryRowForGrade[] {
  const seen = new Set<string>();
  return rows.filter((row) => {
    const at = row.becameFluentAt;
    if (at === undefined || at <= startMs || at > endMs) return false;
    if (!isFluent(row) || seen.has(row.skillKey)) return false;
    const rank = gradeRank(gradeByKey.get(row.skillKey));
    if (rank === null || rank < 0) return false;
    seen.add(row.skillKey);
    return true;
  });
}

// One miss alone is a weak signal. On real data (11 scholars, one term), among
// skills two or more grades below the scholar's enrolled grade, which they
// plainly already knew, 11% had one miss before turning fluent and only 3% had
// two or more. So in grades the scholar already has solid, one miss is a slip
// and it takes two; in a grade with skills still open, one miss on the way to
// fluent is learning. The line is the first grade that is not yet solid in the
// scholar's overall level NOW. A level reconstructed at the window's start
// does not work: it leaves out every skill proved during the window, known
// ones included, so it sits far too low and makes everything new territory.

/** Misses before fluent that make a skill in an already-solid grade learned. */
export const MISSES_TO_LEARN_BELOW_START = 2;
/** Misses before fluent that make a skill in a grade with open skills learned. */
export const MISSES_TO_LEARN_FROM_START = 1;

/**
 * Whether a skill that turned fluent in the window was LEARNED there.
 * `misses` is how many times the scholar answered it wrong before it turned
 * fluent (2 is enough to tell); `skillRank` is the skill's grade rank;
 * `firstOpenRank` is the first grade that is not yet solid in the scholar's
 * overall level (solid-through grade plus one; kindergarten when nothing is
 * solid), or null when there is no level (every grade counts as new territory).
 */
export function isLearnedSkill({
  misses,
  skillRank,
  firstOpenRank,
}: {
  misses: number;
  skillRank: number;
  firstOpenRank: number | null;
}): boolean {
  const newTerritory = firstOpenRank === null || skillRank >= firstOpenRank;
  return misses >= (newTerritory ? MISSES_TO_LEARN_FROM_START : MISSES_TO_LEARN_BELOW_START);
}

export function learnedPace(
  rows: readonly MasteryRowForGrade[],
  gradeByKey: ReadonlyMap<string, string | null | undefined>,
  /** Skills learned in the window, by {@link isLearnedSkill}. */
  learned: ReadonlySet<string>,
  startMs: number,
  endMs: number,
): LearnedPace {
  const totalByRank = new Map<number, number>();
  for (const grade of gradeByKey.values()) {
    const rank = gradeRank(grade);
    if (rank === null || rank < 0) continue;
    totalByRank.set(rank, (totalByRank.get(rank) ?? 0) + 1);
  }
  let learnedGrades = 0;
  let knownGrades = 0;
  let learnedSkills = 0;
  let knownSkills = 0;
  for (const row of skillsFluentInWindow(rows, gradeByKey, startMs, endMs)) {
    const share = 1 / totalByRank.get(gradeRank(gradeByKey.get(row.skillKey))!)!;
    if (learned.has(row.skillKey)) {
      learnedGrades += share;
      learnedSkills++;
    } else {
      knownGrades += share;
      knownSkills++;
    }
  }
  const schoolMonths = Math.max(0, endMs - startMs) / AVG_MONTH_MS;
  const learnedMonths = learnedGrades * SCHOOL_MONTHS_PER_GRADE;
  return {
    learnedMonths,
    knownMonths: knownGrades * SCHOOL_MONTHS_PER_GRADE,
    learnedSkills,
    knownSkills,
    schoolMonths,
    pace: schoolMonths >= MIN_SCHOOL_MONTHS_FOR_PACE ? learnedMonths / schoolMonths : null,
  };
}
