/**
 * The scholar's demonstrated-fluent frontier GRADE in one math domain — the one
 * canonical definition of "grade level in this domain", reused by the working
 * level vector (`workingLevel.ts`), the teacher portrait query, and the
 * guardian-gated parent read. Defined here, pure and testable, so the number and
 * its trajectory are the SAME function evaluated at different times — never a
 * second vocabulary for a signal the practice engine already owns.
 *
 * The gate is the DEMONSTRATED one (`isFluent`, ctx-free = access-proven AND a
 * demonstrated source), NOT the generous `accessProven`. That is deliberate:
 * the green claim the tutor and parents are told is demonstrated-through-practice
 * (scheduler.ts §isFluent / §accessProven), and `becameFluentAt` stamps exactly
 * that gate flipping. So a placement/valve credit that hasn't been demonstrated
 * yet does not inflate the grade a parent sees.
 *
 * Trajectory (`asOf`) reconstructs a past point from the forward-only
 * `becameFluentAt` stamp. A demonstrated-fluent row WITHOUT a stamp
 * (pre-instrumentation) counts from the baseline, so the reconstructed series is
 * monotonic and equals the live value at `asOf = now` — real data, honestly
 * left-censored ("since we started tracking"), never a fabricated trend.
 */

import { isFluent } from "./scheduler";
import { gradeRank, gradeLabelFromRank } from "../../../shared/gradeRange";

export interface MasteryRowForGrade {
  skillKey: string;
  repetition: number;
  source?: string;
  becameFluentAt?: number;
}

/**
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
 * {@link frontierGradeValue}, or null. Always one decimal place. Grade K (rank 0)
 * keeps its "K" token, so a kindergarten-band value reads "Grade K.4".
 */
export function gradeLabelFromValueOrNull(value: number | null): string | null {
  if (value === null) return null;
  const whole = Math.floor(value + 1e-9);
  const tenth = Math.round((value - whole) * 10);
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
