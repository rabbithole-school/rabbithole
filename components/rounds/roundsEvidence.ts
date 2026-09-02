// Pure helpers behind the Rounds week board and the per-scholar pane.
//
// Rounds is projected on a wall and read aloud, so the board never collapses a
// week into a score. These helpers turn one scholar's week into a short list of
// DATED, ATTRIBUTABLE lines in the source's own words. Counts are allowed only
// as an overflow suffix ("+2 more this week"), and an empty week is written out
// as a finding rather than left as a blank cell.
//
// Kept free of React so the shaping rules can be unit-tested directly.

import { bloomColor, bloomLabel } from "@/lib/bloom";
import { evidenceSourcePhrase } from "@/lib/masteryProvenance";

export type RoundsEvidenceSource =
  | "Teacher"
  | "Observer"
  | "Mastery"
  | "Practice";

export interface RoundsEvidenceLine {
  key: string;
  source: RoundsEvidenceSource;
  /** Rendered in quotation marks — the source's own words. */
  quote?: string;
  /** Rendered as plain prose — our own summary of a countable signal. */
  body?: string;
  /** Who said it, when, and how we know. Always present. */
  provenance: string;
  /** True when this line records an ABSENCE. Rendered quietly, never as alarm. */
  absence?: boolean;
  /**
   * True when this absence is a source that produced NOTHING (no observations,
   * no analysed sessions, no mastery, no attempts). The board folds these into
   * one collective sentence rather than printing four labelled empties. A
   * partial absence — the observer that ran sessions but wrote nothing — is
   * left standing on its own, because "sessions ran" is itself a finding.
   */
  foldable?: boolean;
  /** "+2 more this week" — the only place a count is allowed. */
  overflow?: string;
  /** Bloom's rung reached, for the mastery line only. */
  rung?: { label: string; color: string; from?: string };
  /** The observation this line came from, so the pane can open it in place. */
  observationId?: string;
}

export interface RoundsWeekObservation {
  _id: string;
  type: string;
  note: string;
  weight: string | number;
  at: number;
  teacherName: string | null;
}

export interface RoundsWeekMastery {
  _id: string;
  conceptLabel: string;
  domain: string | null;
  masteryLevel: number;
  evidenceType: string | null;
  attemptContext?: string | null;
  observedAt: number;
}

export interface RoundsWeekPractice {
  attempts: number;
  correct: number;
  nodes: number;
  lastAttemptAt: number | null;
}

export interface RoundsWeekPulse {
  latestSummary: string | null;
  latestSummaryAt: number | null;
  latestIntervention: string | null;
  analyzedSessions: number;
  sampleCount: number;
}

export interface RoundsEvidenceInput {
  observations: RoundsWeekObservation[];
  mastery: RoundsWeekMastery[];
  practice: RoundsWeekPractice;
  pulse: RoundsWeekPulse | null;
}

/** How many teacher observations the board quotes before it says "+N more". */
export const TEACHER_LINE_LIMIT = 2;

/**
 * The server's per-scholar-week evidence caps, mirrored here so the UI can be
 * honest about them. `convex/rounds.ts` takes at most this many rows per
 * scholar so one pathological week cannot make the projected board unloadable
 * for the whole room — which means a full array is a FLOOR, not a count.
 *
 * Where a cap is hit we say "or more" rather than printing a confidently wrong
 * exact number. A bounded view stated as bounded is fine on a wall; a precise
 * number that is quietly short is not.
 */
export const WEEK_OBSERVATION_CAP = 40;
export const WEEK_MASTERY_CAP = 12;
export const WEEK_PRACTICE_CAP = 400;

/** Longest note the server stores for one scholar-week (`MAX_NOTE_LEN`). */
export const MAX_NOTE_LEN = 4_000;

/**
 * Where the composer starts showing the budget. Silent until the writer is
 * near it: a counter on screen for every short note is noise, and a paragraph
 * lost to a silent rejection mid-meeting is worse than noise.
 */
export const NOTE_BUDGET_VISIBLE_AT = MAX_NOTE_LEN - 400;

/**
 * An unsaved note draft, lifted OUT of the composer so it survives the
 * composer unmounting.
 *
 * On the two-altitude board the composer lives inside the expanded row, so
 * collapsing the row — or opening a different scholar — unmounts it. If the
 * draft lived in component state it would be destroyed silently. The board
 * therefore holds a map of these KEYED BY `entryId` (never by scholar or by
 * week): an entry is unique to one scholar in one week, so a draft can never be
 * restored into, or saved into, a different week's entry. `baseVersion` is the
 * server note version the draft was started from, carried so the optimistic-
 * concurrency check still refuses a stale overwrite.
 */
export interface StoredNoteDraft {
  text: string;
  baseVersion: number | null;
}

/**
 * Reconcile a possibly-lifted draft with the server's current note. A stored
 * draft means the writer is mid-edit (dirty), so we hold their words and the
 * version they started from. With no stored draft the composer is clean and
 * simply follows the server, which is what lets a note someone else saved
 * appear without a reload.
 *
 * Pure so the keying invariant can be asserted directly: a draft under one
 * `entryId` never bleeds into another.
 */
export function resolveNoteDraft(
  stored: StoredNoteDraft | null | undefined,
  note: string | null,
  noteVersion: number | null,
): { text: string; dirty: boolean; baseVersion: number | null } {
  if (stored) {
    return { text: stored.text, dirty: true, baseVersion: stored.baseVersion };
  }
  return { text: note ?? "", dirty: false, baseVersion: noteVersion };
}

/**
 * "+3 more this week", or "+38 or more this week" when the read was capped and
 * the true remainder is unknowable from here.
 */
export function moreThisWeek(rest: number, atLeast: boolean): string | undefined {
  if (rest <= 0) return undefined;
  return atLeast ? `+${rest} or more this week` : `+${rest} more this week`;
}

const DATE_FMT = new Intl.DateTimeFormat("en-GB", {
  day: "numeric",
  month: "short",
});

const DATE_TIME_FMT = new Intl.DateTimeFormat("en-GB", {
  weekday: "short",
  day: "numeric",
  month: "short",
  hour: "numeric",
  minute: "2-digit",
  hour12: true,
});

/** "3 Sep" — the form every provenance line uses. */
export function roundsDate(ms: number): string {
  return DATE_FMT.format(new Date(ms));
}

/** "Thu 3 Sep, 3:00 pm" — used for the week window and meeting times. */
export function roundsDateTime(ms: number): string {
  return DATE_TIME_FMT.format(new Date(ms)).replace(/\u202f/g, " ");
}

/**
 * "Thu 3 Sep, 3:00 pm – Thu 10 Sep, 3:00 pm". The weekday is READ OFF the
 * institution's own anchor rather than written into copy, so a school that
 * moves Rounds off Thursday still reads correctly.
 */
export function roundsWindowLabel(startMs: number, endMs: number): string {
  return `${roundsDateTime(startMs)} – ${roundsDateTime(endMs)}`;
}

/**
 * "8 y 2 m". The board is ordered by age, so the room has to be able to SEE
 * the ordering hold; whole years alone would make a youngest-first sort of
 * five eight-year-olds look arbitrary.
 */
export function ageYearsMonths(
  dateOfBirth: string | null | undefined,
  nowMs: number,
): string | null {
  if (!dateOfBirth) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateOfBirth.trim());
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const now = new Date(nowMs);
  let months =
    (now.getFullYear() - y) * 12 +
    (now.getMonth() + 1 - mo) -
    (now.getDate() < d ? 1 : 0);
  if (months < 0) return null;
  const years = Math.floor(months / 12);
  months -= years * 12;
  return `${years} y ${months} m`;
}

function teacherProvenance(o: RoundsWeekObservation): string {
  const who = o.teacherName?.trim() || "a teacher";
  const kind = o.type ? `${o.type} · ` : "";
  return `${kind}${who} · ${roundsDate(o.at)}`;
}

/**
 * Group the week's mastery rows by concept and report the concept that moved
 * most recently. When the same concept was read twice at different depths we
 * show the movement ("Apply → Analyze"); otherwise just the rung reached.
 *
 * The vocabulary is Bloom's, straight from lib/bloom — Rounds does not get its
 * own mastery words.
 */
function masteryLine(rows: RoundsWeekMastery[]): RoundsEvidenceLine | null {
  if (rows.length === 0) return null;
  const byConcept = new Map<string, RoundsWeekMastery[]>();
  for (const r of rows) {
    const arr = byConcept.get(r.conceptLabel);
    if (arr) arr.push(r);
    else byConcept.set(r.conceptLabel, [r]);
  }
  let best: RoundsWeekMastery[] | null = null;
  let bestAt = -Infinity;
  for (const arr of byConcept.values()) {
    const latest = Math.max(...arr.map((r) => r.observedAt));
    if (latest > bestAt) {
      bestAt = latest;
      best = arr;
    }
  }
  if (!best) return null;
  const sorted = [...best].sort((a, b) => a.observedAt - b.observedAt);
  const first = sorted[0];
  const last = sorted[sorted.length - 1];
  const toLabel = bloomLabel(last.masteryLevel);
  const fromLabel = bloomLabel(first.masteryLevel);
  const others = rows.length - best.length;
  const capped = rows.length >= WEEK_MASTERY_CAP;
  return {
    key: `mastery-${last._id}`,
    source: "Mastery",
    body: last.conceptLabel,
    rung: {
      label: toLabel,
      color: bloomColor(last.masteryLevel),
      from: fromLabel !== toLabel ? fromLabel : undefined,
    },
    provenance: `Bloom's depth, ${evidenceSourcePhrase(last)} · ${roundsDate(last.observedAt)}`,
    overflow: moreThisWeek(others, capped),
  };
}

function practiceLine(p: RoundsWeekPractice): RoundsEvidenceLine {
  if (p.attempts <= 0) {
    return {
      key: "practice-none",
      source: "Practice",
      body: "No practice attempts this week.",
      provenance: "Practice log",
      absence: true,
      foldable: true,
    };
  }
  const skills = p.nodes === 1 ? "1 skill" : `${p.nodes} skills`;
  // At the cap the attempt rows stop being a census: the skill and correct
  // counts are taken from the same bounded read, and even "last attempt" is
  // only the last one we looked at. So we say so instead of quoting figures
  // that read exact.
  if (p.attempts >= WEEK_PRACTICE_CAP) {
    return {
      key: "practice",
      source: "Practice",
      body: `At least ${WEEK_PRACTICE_CAP} attempts across ${skills} or more.`,
      provenance: `Practice log · counted to this week's ${WEEK_PRACTICE_CAP}-attempt cap`,
    };
  }
  return {
    key: "practice",
    source: "Practice",
    body: `${p.attempts} attempt${p.attempts === 1 ? "" : "s"} across ${skills}, ${p.correct} correct.`,
    provenance: p.lastAttemptAt
      ? `Practice log · last attempt ${roundsDate(p.lastAttemptAt)}`
      : "Practice log",
  };
}

function observerLine(pulse: RoundsWeekPulse | null): RoundsEvidenceLine {
  const sessions = pulse?.analyzedSessions ?? 0;
  const read = sessions === 1 ? "1 session" : `${sessions} sessions`;
  const summary = pulse?.latestSummary?.trim();
  if (summary) {
    const at = pulse?.latestSummaryAt;
    return {
      key: "observer",
      source: "Observer",
      quote: summary,
      provenance: at
        ? `Observer, reading ${read} · ${roundsDate(at)}`
        : `Observer, reading ${read}`,
    };
  }
  if (sessions > 0) {
    return {
      key: "observer-quiet",
      source: "Observer",
      body: "Sessions ran, but the observer wrote nothing this week.",
      provenance: "Observer",
      absence: true,
    };
  }
  return {
    key: "observer-none",
    source: "Observer",
    body: "No sessions analysed this week.",
    provenance: "Observer",
    absence: true,
    foldable: true,
  };
}

/**
 * True when the week produced nothing at all. The board writes this out as a
 * finding — "No sessions, no observations and no practice this week." — rather
 * than leaving a blank cell the room has to interpret.
 */
export function isSilentWeek(input: RoundsEvidenceInput): boolean {
  return (
    input.observations.length === 0 &&
    input.mastery.length === 0 &&
    input.practice.attempts <= 0 &&
    !input.pulse?.latestSummary?.trim() &&
    (input.pulse?.analyzedSessions ?? 0) === 0
  );
}

export const SILENT_WEEK_FINDING =
  "No sessions, no observations and no practice this week.";

/**
 * The week, in the sources' own words. Teacher observations lead because they
 * are the only lines a human in the room wrote; the observer, mastery and
 * practice lines follow in that fixed order so the board reads the same way for
 * every scholar.
 */
export function buildRoundsEvidence(
  input: RoundsEvidenceInput,
): RoundsEvidenceLine[] {
  const lines: RoundsEvidenceLine[] = [];

  const observations = [...input.observations].sort((a, b) => b.at - a.at);
  for (const o of observations.slice(0, TEACHER_LINE_LIMIT)) {
    lines.push({
      key: `teacher-${o._id}`,
      source: "Teacher",
      quote: o.note,
      provenance: teacherProvenance(o),
      observationId: o._id,
    });
  }
  if (observations.length > TEACHER_LINE_LIMIT) {
    const rest = observations.length - TEACHER_LINE_LIMIT;
    const last = lines[lines.length - 1];
    if (last) {
      last.overflow = moreThisWeek(
        rest,
        observations.length >= WEEK_OBSERVATION_CAP,
      );
    }
  }
  if (observations.length === 0) {
    lines.push({
      key: "teacher-none",
      source: "Teacher",
      body: "No teacher observations written this week.",
      provenance: "Observations",
      absence: true,
      foldable: true,
    });
  }

  lines.push(observerLine(input.pulse));

  const mastery = masteryLine(input.mastery);
  if (mastery) {
    lines.push(mastery);
  } else {
    lines.push({
      key: "mastery-none",
      source: "Mastery",
      body: "No mastery movement recorded this week.",
      provenance: "Mastery record",
      absence: true,
      foldable: true,
    });
  }

  lines.push(practiceLine(input.practice));

  return lines;
}

/**
 * The collapsed board line. Two altitudes share one board: every scholar is a
 * single line by default, and the room expands the one it is looking at. That
 * line needs the ONE most load-bearing thing about the week, chosen the same
 * way every time so the board reads consistently and a quiet week is never
 * dressed up as a busy one.
 *
 * The order is deliberate: a human's flagged-major note first, then the
 * observer asking for action, then real academic movement, then the shape of
 * the week's practice, then whatever the observer summarised. A week that
 * produced nothing at all says so, in muted ink — the geometry of the row is
 * identical to every other, so "quiet" reads as "less to say", never as a
 * lower standing.
 */
export interface RoundsHeadline {
  /** The one line, in the source's own words or our own honest summary. */
  text: string;
  /** True for a week with no evidence at all — rendered muted, never as alarm. */
  quiet: boolean;
}

/** What a genuinely empty week reads as, in muted ink. */
export const NO_EVIDENCE_HEADLINE = "no evidence this week";

function isMajorObservation(o: RoundsWeekObservation): boolean {
  return String(o.weight).toLowerCase() === "major";
}

export function roundsHeadline(input: RoundsEvidenceInput): RoundsHeadline {
  if (isSilentWeek(input)) {
    return { text: NO_EVIDENCE_HEADLINE, quiet: true };
  }

  const observations = [...input.observations].sort((a, b) => b.at - a.at);

  // 1 · A major teacher observation — a human in the room wrote it and flagged
  //     it as the week's headline for this child.
  const major = observations.find((o) => isMajorObservation(o) && o.note.trim());
  if (major) return { text: major.note.trim(), quiet: false };

  // 2 · An observer concern — a suggested intervention is the observer asking
  //     the room to act.
  const intervention = input.pulse?.latestIntervention?.trim();
  if (intervention) return { text: intervention, quiet: false };

  // 3 · The first real academic movement, in the same Bloom vocabulary the
  //     evidence list uses.
  const mastery = masteryLine(input.mastery);
  if (mastery?.rung) {
    const concept = mastery.body ?? "A concept";
    const text = mastery.rung.from
      ? `${concept}: ${mastery.rung.from} → ${mastery.rung.label}`
      : `${concept} reached ${mastery.rung.label}`;
    return { text, quiet: false };
  }

  // 4 · The shape of the week's practice.
  if (input.practice.attempts > 0) {
    const line = practiceLine(input.practice);
    if (line.body) return { text: line.body, quiet: false };
  }

  // 5 · Whatever the observer summarised.
  const summary = input.pulse?.latestSummary?.trim();
  if (summary) return { text: summary, quiet: false };

  // 6 · A minor teacher observation still beats an empty line — it is a human's
  //     words about this child.
  const anyObservation = observations.find((o) => o.note.trim());
  if (anyObservation) return { text: anyObservation.note.trim(), quiet: false };

  // 7 · Sessions were analysed but nothing was written — thin, but not nothing,
  //     so it is not rendered as an absence.
  if ((input.pulse?.analyzedSessions ?? 0) > 0) {
    return {
      text: "Sessions ran, but the observer wrote nothing this week.",
      quiet: false,
    };
  }

  // isSilentWeek covered the truly-empty case above; this is only a guard.
  return { text: NO_EVIDENCE_HEADLINE, quiet: true };
}

const ABSENCE_SOURCE_NOUN: Record<RoundsEvidenceSource, string> = {
  Teacher: "teacher observations",
  Observer: "observer analysis",
  Mastery: "mastery movement",
  Practice: "practice",
};

/** "a", "a or b", "a, b or c" — a plain-language list, no Oxford comma. */
function humanJoin(parts: string[]): string {
  if (parts.length <= 1) return parts[0] ?? "";
  if (parts.length === 2) return `${parts[0]} or ${parts[1]}`;
  return `${parts.slice(0, -1).join(", ")} or ${parts[parts.length - 1]}`;
}

/**
 * Fold the sources that produced NOTHING into one collective sentence, so the
 * expanded row and the pane state absence once rather than printing four
 * labelled empty rows. Present lines — including the observer that ran sessions
 * but wrote nothing — are left exactly as they were.
 *
 * This changes geometry, not honesty: the same sources are still named, in the
 * same honest-absence language, on one line instead of four.
 */
export function foldRoundsAbsence(lines: RoundsEvidenceLine[]): {
  present: RoundsEvidenceLine[];
  absence: string | null;
} {
  const present = lines.filter((l) => !(l.absence && l.foldable));
  const folded = lines.filter((l) => l.absence && l.foldable);
  if (folded.length === 0) return { present, absence: null };
  const nouns = folded.map((l) => ABSENCE_SOURCE_NOUN[l.source]);
  return { present, absence: `No ${humanJoin(nouns)} this week.` };
}

/**
 * Split a roster into the age-ordered body and the tail of scholars with no
 * birth date. The tail is LABELLED on the board — a scholar whose record is
 * incomplete must never be silently sorted to one end and read as "youngest"
 * or "oldest" by a room that cannot see why they are there.
 *
 * The server already sorts; this only finds the seam.
 */
export function splitUndatedTail<T extends { dateOfBirth: string | null }>(
  scholars: T[],
): { dated: T[]; undated: T[] } {
  const dated: T[] = [];
  const undated: T[] = [];
  for (const s of scholars) {
    if (s.dateOfBirth) dated.push(s);
    else undated.push(s);
  }
  return { dated, undated };
}

/** The sentences a Rounds write can fail with, said in human words. */
export function roundsWriteFailure(
  error: unknown,
  scholarName: string,
): string {
  const message = error instanceof Error ? error.message : String(error ?? "");
  if (/changed while you were writing/.test(message)) {
    return `Someone else in the meeting saved a note for ${scholarName} while you were typing. Nothing was overwritten — read theirs below, then decide.`;
  }
  if (/Keep the note under/.test(message)) {
    return `That note is longer than the ${MAX_NOTE_LEN.toLocaleString("en-GB")} characters Rounds stores, so nothing was saved. Your words are still on screen — trim it and save again.`;
  }
  return message || "That did not save. Try again.";
}

/**
 * What the pane says when the week has no `previous` note.
 *
 * The server links weeks with a BOUNDED backward scan (`CONTINUITY_SCAN`), so
 * "no previous note" means "none in the run of weeks Rounds looked at" — a
 * scholar who was away for a term can have older notes it never reached.
 * Claiming "the team has never written about them" would be a stronger
 * statement than the data supports, so we do not make it.
 */
export const NO_PREVIOUS_NOTE_FINDING = "No note last week.";
export const NO_PREVIOUS_NOTE_CAVEAT =
  "Rounds reads back a bounded run of recent weeks, so an older note may exist beyond it.";
