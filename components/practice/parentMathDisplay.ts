/**
 * Display helpers for the parent Math page (`ParentMathPortrait.tsx`). Every number
 * here is computed by the server (convex/mathPortrait.ts → gatherMathPortrait);
 * these only decide whether and how to show it.
 */

import { hasEnoughFluentSkillsForPace } from "@/shared/mathPace";
import type { LearnedPace } from "@/convex/lib/practice/frontierGrade";

/** A school-day key as a short date, "Nov 1". The key is already the
 *  school's day, so it is formatted as a calendar date, never shifted by the
 *  viewer's zone. */
export function formatDayKeyShort(dayKey: string): string {
  const [year, month, day] = dayKey.split("-").map(Number);
  return new Intl.DateTimeFormat("en-US", { timeZone: "UTC", month: "short", day: "numeric" }).format(
    new Date(Date.UTC(year, month - 1, day)),
  );
}

/** "{Name}'s math · this term, since Sep 2", or just "{Name}'s math" with no
 *  term. `windowStartsDay` is the server's YYYY-MM-DD in the school's zone. */
export function mathContextLine(firstName: string, windowStartsDay: string | null | undefined): string {
  const head = `${firstName}'s math`;
  if (windowStartsDay == null) return head;
  return `${head} · this term, since ${formatDayKeyShort(windowStartsDay)}`;
}

/** Months to one decimal, the unit both the tile and the area column use: "3.1 mo". */
export function monthsShort(months: number): string {
  return `${months.toFixed(1)} mo`;
}

/**
 * An area's "New this term" cell: the months of curriculum learned there this
 * term, or "—" (muted) when that rounds to 0.0. Null when there is no current
 * term (`termLearnedMonths` absent). Not gated on the tile's fluent-skill
 * floor: it is an amount, not a rate.
 */
export function newThisTermCell(
  termLearnedMonths: number | undefined,
): { text: string; muted: boolean } | null {
  if (termLearnedMonths === undefined) return null;
  return Math.round(termLearnedMonths * 10) === 0
    ? { text: "—", muted: true }
    : { text: monthsShort(termLearnedMonths), muted: false };
}

export interface PaceTile {
  learnedMonths: string; // "4.5 mo"
  schoolMonths: string; // "3.2 months of school"
  pace: string; // "1.4× standard pace"
  /** At or above the standard pace, as shown (rounded to one decimal). */
  atOrAboveStandard: boolean;
}

/**
 * The "New math learned" tile, or null when no pace should be stated: no
 * current term, too few skills fluent this term (the report drafter's same
 * floor, shared/mathPace.ts), or too little school yet for a rate.
 */
export function paceTile(pace: LearnedPace | null | undefined): PaceTile | null {
  if (!pace || !hasEnoughFluentSkillsForPace(pace) || pace.pace === null) return null;
  const rounded = Math.round(pace.pace * 10) / 10;
  return {
    learnedMonths: monthsShort(pace.learnedMonths),
    schoolMonths: `${pace.schoolMonths.toFixed(1)} months of school`,
    pace: `${rounded.toFixed(1)}× standard pace`,
    atOrAboveStandard: rounded >= 1,
  };
}

/**
 * The count line under an area's recent skills: "12 skills demonstrated in
 * daily work · 4 credited by the placement check-in", either half alone when
 * the other is zero, or null when there is neither.
 */
export function areaSkillCountLine(dailySkills: number, placementSkills: number): string | null {
  const skills = (n: number) => `${n} ${n === 1 ? "skill" : "skills"}`;
  const daily = dailySkills > 0 ? `${skills(dailySkills)} demonstrated in daily work` : null;
  if (placementSkills === 0) return daily;
  const placement = `credited by the placement check-in`;
  return daily ? `${daily} · ${placementSkills} ${placement}` : `${skills(placementSkills)} ${placement}`;
}
