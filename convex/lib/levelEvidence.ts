// Evidence for the three levels (TRA-515): the pure half of the scholar
// profile's "Talk, read and write" card. Every number here is computed from
// what the child did in Rabbithole.
//
//   TALK  — the observer's per-session judgment of the grade at which a
//           typical child produces the LANGUAGE the scholar used, said or
//           typed (`analyses.talkLevel`). Collected, and plotted on a fixed
//           K–8 scale with NO grade numbers shown: the spot eval measured it
//           ~+0.5 grade high overall and ~+0.8 at K–3
//           (evals/spot-eval/talk-judgment-FINDINGS.md), and T6 says a number
//           or threshold ships calibrated or not at all. TRA-521 restores the
//           numbers and the "Sessions suggest" line once it is calibrated.
//   READ  — each your-turn line a beginner read aloud, scored word by word by
//           `compareReading` at the moment it was sent (`readAloudAttempts`).
//   WRITE — how the scholar's words got in: spoken vs typed turns.
//
// Pure, so the aggregation is testable without a database and the web card
// and the server agree on every number.

import { normalizeReadingLevel } from "./readingLevels";

/**
 * The fewest words the scholar must have said or typed in the window the
 * observer read before its talk judgment is stored. The same 100-word sample
 * the writing estimate uses (`MIN_TYPED_WORDS_FOR_ESTIMATE`, the classic
 * readability sample): below it one unusual word decides the grade. Unlike
 * the writing estimate, spoken turns count — this is how the child talks.
 */
export const MIN_SCHOLAR_WORDS_FOR_TALK_JUDGMENT = 100;

/**
 * The observer's talk judgment as it may be stored: a canonical level drawn
 * from enough scholar words, or nothing. `analysisHelpers.saveAnalysis` is the
 * one writer and applies it, the way `scholars.recordWritingDerivedEstimate`
 * validates the writing estimate.
 */
export function validTalkJudgment(
  raw: string | undefined,
  scholarWords: number | undefined,
): { talkLevel: string; talkWords: number } | null {
  if (!raw || scholarWords === undefined) return null;
  if (scholarWords < MIN_SCHOLAR_WORDS_FOR_TALK_JUDGMENT) return null;
  const level = normalizeReadingLevel(raw);
  return level ? { talkLevel: level, talkWords: scholarWords } : null;
}

/** Grade as a number for arithmetic: K = 0, college = 13, else the grade. */
export function gradeValue(level: string | null | undefined): number | null {
  if (!level) return null;
  const canonical = normalizeReadingLevel(level);
  if (!canonical) return null;
  if (canonical === "K") return 0;
  if (canonical === "college") return 13;
  const n = Number.parseFloat(canonical);
  return Number.isFinite(n) ? n : null;
}

/**
 * How far the tutor's reply grade may sit from the talk level and still read
 * "on target". One grade, because the measure is Flesch–Kincaid over short
 * conversational replies: replies to the same scholar on the same day routinely
 * differ by most of a grade, so a tighter band would call ordinary replies off
 * target. A display band for a mechanical measure, not a suggestion.
 */
export const TUTOR_REPLY_ON_TARGET_GRADES = 1;

/** The tutor's replies (Flesch–Kincaid grade) against the talk level. */
export function tutorRepliesText(
  replyGrade: number,
  talkLevel: string | null | undefined,
): string {
  const head = `Tutor's replies: grade ${replyGrade.toFixed(1)}`;
  const setting = gradeValue(talkLevel);
  if (setting === null) return head;
  const gap = replyGrade - setting;
  if (Math.abs(gap) < TUTOR_REPLY_ON_TARGET_GRADES) return `${head}, on target`;
  const grades = Math.abs(gap).toFixed(1);
  return `${head}, ${grades} grades ${gap > 0 ? "above" : "below"} the talk level`;
}

// ── Read: the your-turn read-aloud ───────────────────────────────────────

/**
 * Which spellings in a missed word the child got wrong, from one substitution
 * ("ship" heard as "sip" → "sh"). The word is split into sound units the same
 * way decodability splits it: the letter teams the line was accepted with
 * first (longest first), single letters otherwise. A unit counts as missed
 * when the heard word does not contain it. Only a substitution is evidence
 * about a sound: a word that was not heard at all says nothing about which
 * part was hard, so it contributes no units.
 *
 * Coarse on purpose — it cannot tell "pig" heard as "big" (b/p) from a
 * transcription slip — so the profile only names a unit missed repeatedly.
 */
export function missedUnits(
  word: string,
  heard: string | undefined,
  teams: readonly string[],
): string[] {
  if (!heard) return [];
  const w = word.toLowerCase().replace(/[^a-z]/g, "");
  const h = heard.toLowerCase().replace(/[^a-z]/g, "");
  if (!w || !h || w === h) return [];
  const sorted = [...teams].map((t) => t.toLowerCase()).sort((a, b) => b.length - a.length);
  const units: string[] = [];
  for (let i = 0; i < w.length; ) {
    const team = sorted.find((t) => t.length > 1 && w.startsWith(t, i));
    const unit = team ?? w[i];
    units.push(unit);
    i += unit.length;
  }
  return [...new Set(units.filter((u) => !h.includes(u)))];
}

export interface ReadAloudAttemptRow {
  at: number;
  words: number;
  matched: number;
  attempted: boolean;
  missedUnits: string[];
}

export interface ReadAloudTally {
  /** Lines the child actually tried. */
  lines: number;
  /** Lines answered with "I can't read that" or nothing heard. */
  notTried: number;
  words: number;
  matched: number;
  /** Spellings missed at least twice, most often first (at most three). */
  oftenMissed: string[];
}

/** A missed spelling is "often" missed from its second time. */
const OFTEN_MISSED_MIN = 2;
const OFTEN_MISSED_SHOWN = 3;

/** Tally read-aloud attempts. Accuracy counts tried lines only. */
export function tallyReadAloud(rows: ReadAloudAttemptRow[]): ReadAloudTally {
  const tried = rows.filter((r) => r.attempted);
  const counts = new Map<string, number>();
  for (const r of tried) {
    for (const unit of r.missedUnits) counts.set(unit, (counts.get(unit) ?? 0) + 1);
  }
  const oftenMissed = [...counts.entries()]
    .filter(([, n]) => n >= OFTEN_MISSED_MIN)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, OFTEN_MISSED_SHOWN)
    .map(([unit]) => unit);
  return {
    lines: tried.length,
    notTried: rows.length - tried.length,
    words: tried.reduce((s, r) => s + r.words, 0),
    matched: tried.reduce((s, r) => s + r.matched, 0),
    oftenMissed,
  };
}

/** The Read row's evidence line, or null when nothing was read aloud. */
export function readAloudText(tally: ReadAloudTally): string | null {
  if (tally.lines === 0 && tally.notTried === 0) return null;
  const parts: string[] = [];
  if (tally.lines > 0) {
    const pct = tally.words > 0 ? Math.round((tally.matched / tally.words) * 100) : 0;
    parts.push(
      `Read-aloud: ${tally.lines} ${tally.lines === 1 ? "line" : "lines"} in the last 7 days, ${pct}% of words right`,
    );
  } else {
    parts.push("Read-aloud: no lines tried in the last 7 days");
  }
  if (tally.notTried > 0) parts.push(`${tally.notTried} not tried`);
  if (tally.oftenMissed.length > 0) parts.push(`often misses ${tally.oftenMissed.join(", ")}`);
  return parts.join(" · ");
}

// ── Write: spoken vs typed ───────────────────────────────────────────────

/** The Write row's spoken-share line, or null with no scholar turns. */
export function spokenShareText(spoken: number, typed: number): string | null {
  const total = spoken + typed;
  if (total === 0) return null;
  return `${Math.round((spoken / total) * 100)}% spoken in the last 2 weeks`;
}

// ── Growth chart: school weeks on a real date axis ───────────────────────

export const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Honolulu is UTC−10 all year (no daylight saving), so a school week can be
 * found with a fixed offset. 1970-01-05 was a Monday.
 */
const HONOLULU_OFFSET_MS = -10 * 60 * 60 * 1000;
const FIRST_MONDAY_MS = 4 * 24 * 60 * 60 * 1000;

/**
 * The start (UTC ms) of the Monday-to-Sunday Honolulu calendar week `at`
 * falls in. Every lane of the growth chart buckets on this one grid, so a
 * week means the same school week whatever minute the page was opened.
 */
export function honoluluWeekStart(at: number): number {
  const local = at + HONOLULU_OFFSET_MS;
  const weekStartLocal =
    Math.floor((local - FIRST_MONDAY_MS) / WEEK_MS) * WEEK_MS + FIRST_MONDAY_MS;
  return weekStartLocal - HONOLULU_OFFSET_MS;
}
