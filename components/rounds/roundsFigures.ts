/**
 * The arithmetic half of a Rounds row — shaped once, here, so the board and the
 * per-scholar pane cannot drift into two different readings of one number.
 *
 * Everything in this file is pure and React-free so the rules that matter can
 * be asserted in a unit test rather than eyeballed on a projector.
 *
 * THREE RULES THIS FILE EXISTS TO ENFORCE
 *
 *  1. A suppressed delta is never reconstructed. `mathGrade.delta` comes back
 *     null with `deltaSuppressedReason: "no_prior_value"` when the scholar had
 *     no gradeable demonstrated-fluent skill at the window start. Rendering
 *     `value - 0` there would draw a multi-grade leap that is really
 *     instrumentation starting. We render the standing value and say why there
 *     is no movement to show.
 *
 *  2. `leftCensored` survives to the screen. Part of the standing level rests
 *     on fluency that predates the crossing stamps, so an early delta can read
 *     as a spike. It is marked, quietly, every time.
 *
 *  3. The reading/writing signals are THREE DIFFERENT INSTRUMENTS and are named
 *     separately, always:
 *       • confirmed — a teacher-ratified SETTING the tutor acts on. `setAt` is
 *         when a human ratified it, NOT when anything was measured.
 *       • estimate  — a WRITING-DERIVED grade estimate, computed from the
 *         child's own production (typed chat + OCR'd handwriting). No reception
 *         evidence exists anywhere in this system, so it is never called a
 *         reading level. It is stored only while it DISAGREES, so its presence
 *         is itself the signal.
 *       • writing complexity — Flesch–Kincaid over typed messages
 *         (`lib/readingTrend.ts`), mechanical and already charted on the
 *         profile as "Scholar writing over time".
 *
 * Deliberately absent, because each was judged unsound upstream: band-count
 * deltas ("3 → 5 fluent"), "top strand" by time spent (no time-on-task exists),
 * and week-over-week movement of the writing estimate (only the latest value is
 * stored). Do not approximate any of them here.
 */

/** The friction floor is applied server-side; this is only for the caption. */
export const FRICTION_MISS_FLOOR = 3;

export interface RoundsMathGrade {
  domain: string;
  domainLabel: string;
  value: number | null;
  label: string | null;
  priorValue: number | null;
  priorLabel: string | null;
  delta: number | null;
  deltaSuppressedReason: "no_prior_value" | null;
  leftCensored: boolean;
  fluentSkills: number;
}

export interface RoundsPracticeSignals {
  /** Present on every row; the board keys its merged batches by it. */
  scholarId: string;
  domain: string | null;
  needsPlacement: boolean;
  practicedDays: number;
  lastAttemptAt: number | null;
  skillsTurnedFluent: number;
  turnedFluentLabels: string[];
  skillsAdvanced: number;
  frontierLabels: string[];
  frictionSkillLabel: string | null;
  frictionMisses: number;
  mathGrade: RoundsMathGrade | null;
}

/**
 * One of the three fixed slots. The slots are fixed so a scholar with figures
 * and a scholar without occupy the same height on a projected row — an empty
 * slot says "nothing to count", it does not collapse and shorten the row.
 */
export interface RoundsFigureSlot {
  key: "practiceDays" | "turnedFluent" | "mathGrade";
  /** The large, room-legible value. */
  value: string;
  /** The fixed slot name under it. */
  label: string;
  /** Optional quiet caption — provenance, suppression reasons, caveats. */
  caption: string | null;
  /** False when this slot has nothing to report, so it can be greyed. */
  present: boolean;
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** "3.3" → "3.3"; trims a trailing ".0" the backend never emits but might. */
function gradeNumber(value: number): string {
  const fixed = value.toFixed(1);
  return fixed.endsWith(".0") ? fixed.slice(0, -2) : fixed;
}

function practiceDaysSlot(row: RoundsPracticeSignals): RoundsFigureSlot {
  if (row.practicedDays <= 0) {
    return {
      key: "practiceDays",
      value: "None",
      label: "Practice days",
      caption: row.needsPlacement ? "Not placed yet" : null,
      present: false,
    };
  }
  return {
    key: "practiceDays",
    value: plural(row.practicedDays, "day", "days"),
    label: "Practice days",
    caption: null,
    present: true,
  };
}

function turnedFluentSlot(row: RoundsPracticeSignals): RoundsFigureSlot {
  if (row.skillsTurnedFluent <= 0) {
    return {
      key: "turnedFluent",
      value: "None",
      label: "Turned fluent",
      caption: null,
      present: false,
    };
  }
  const shown = row.turnedFluentLabels.slice(0, 2);
  const rest = row.turnedFluentLabels.length - shown.length;
  const caption =
    shown.length > 0
      ? `${shown.join(", ")}${rest > 0 ? ` +${rest} more` : ""}`
      : null;
  return {
    key: "turnedFluent",
    value: plural(row.skillsTurnedFluent, "skill", "skills"),
    label: "Turned fluent",
    caption,
    present: true,
  };
}

/**
 * The one slot with a real trap in it. Read the delta rules at the top of this
 * file before changing anything here.
 */
function mathGradeSlot(row: RoundsPracticeSignals): RoundsFigureSlot {
  const grade = row.mathGrade;
  const label = grade
    ? `Demonstrated ${grade.domainLabel.toLowerCase()} grade`
    : "Demonstrated math grade";

  if (!grade || grade.value === null) {
    return {
      key: "mathGrade",
      value: "Not yet",
      label,
      caption: "No demonstrated-fluent skill carries a grade yet",
      present: false,
    };
  }

  const now = grade.label ?? `Grade ${gradeNumber(grade.value)}`;
  const censored = grade.leftCensored
    ? "Part of this level predates the crossing stamps"
    : null;

  // A suppressed delta is stated, never reconstructed from zero.
  if (grade.delta === null) {
    const why =
      grade.deltaSuppressedReason === "no_prior_value"
        ? "First gradeable skill this week — nothing earlier to compare"
        : "No movement to state this week";
    return {
      key: "mathGrade",
      value: now,
      label,
      caption: [why, censored].filter(Boolean).join(" · "),
      present: true,
    };
  }

  if (grade.delta === 0 || grade.priorValue === null) {
    return {
      key: "mathGrade",
      value: now,
      label,
      caption: [
        grade.delta === 0 ? "Unchanged this week" : null,
        censored,
      ]
        .filter(Boolean)
        .join(" · ") || null,
      present: true,
    };
  }

  const prior = grade.priorLabel
    ? grade.priorLabel.replace(/^Grade\s+/i, "")
    : gradeNumber(grade.priorValue);
  const current = now.replace(/^Grade\s+/i, "");
  return {
    key: "mathGrade",
    value: `${prior} → ${current}`,
    label,
    caption: censored,
    present: true,
  };
}

/** The three fixed slots, always three, always in this order. */
export function roundsFigureSlots(
  row: RoundsPracticeSignals,
): RoundsFigureSlot[] {
  return [practiceDaysSlot(row), turnedFluentSlot(row), mathGradeSlot(row)];
}

/**
 * True when the week produced no arithmetic at all. The board still renders the
 * three slots — it renders this sentence above them so the emptiness is a
 * finding rather than a gap.
 */
export function hasNoFigures(row: RoundsPracticeSignals): boolean {
  return (
    row.practicedDays <= 0 &&
    row.skillsTurnedFluent <= 0 &&
    row.skillsAdvanced <= 0 &&
    (row.mathGrade === null || row.mathGrade.value === null)
  );
}

/**
 * The line that stands in for the figures when the room has stepped back to a
 * week that has already closed.
 *
 * The practice figures are always the last seven days, because that is the only
 * window the stored mastery rows can answer: they keep the LATEST attempt and
 * fluency stamps, not a series, so "how many days did they practise in the week
 * of 6 August" is not derivable after the fact. Showing today's numbers beside
 * an older week's evidence would put a number on a projected wall that the room
 * would read as belonging to that week. Say what they are instead.
 */
export function figuresAreCurrentLine(weekLabel: string): string {
  return `Practice figures are always the last seven days, so they describe now rather than the week of ${weekLabel}. That week's practice is in the evidence below.`;
}

export function noFiguresLine(
  row: RoundsPracticeSignals,
  scholarName: string,
): string {
  if (row.needsPlacement) {
    return `No figures yet — ${scholarName} has not been placed in a practice domain.`;
  }
  return `No figures this week — ${scholarName} did no practice, so there is nothing to count.`;
}

/**
 * The friction line. The ≥3-miss floor and the "excludes skills that turned
 * fluent this week" exclusion are applied SERVER-SIDE and are calibrated; this
 * only reports them, and must never add a threshold of its own.
 */
export function frictionLine(
  row: RoundsPracticeSignals,
): { headline: string; caption: string } | null {
  if (!row.frictionSkillLabel) return null;
  return {
    headline: `Friction · ${row.frictionSkillLabel} · ${plural(
      row.frictionMisses,
      "classified miss",
      "classified misses",
    )}`,
    caption: `Shown from ${FRICTION_MISS_FLOOR} misses up; skills that turned fluent this week are excluded`,
  };
}

/* ── The three level instruments ─────────────────────────────────────────── */

export interface RoundsLevelSignals {
  /** Present on every row; the board keys its merged batches by it. */
  scholarId: string;
  confirmed: {
    level: string | null;
    isPreReader: boolean;
    setAt: number | null;
    setBy: "teacher" | "observer" | null;
  };
  estimate: {
    level: string | null;
    computedAt: number | null;
    ageDays: number | null;
    disagreesWithConfirmed: boolean;
  };
}

/**
 * Render a stored grade band the way the rest of the app already renders it —
 * one canonical rendering, no second vocabulary.
 */
export function levelText(level: string | null): string {
  if (!level) return "Not set";
  if (level === "pre-reader") return "Pre-reader";
  if (level === "K") return "K";
  if (level === "college") return "College";
  return `Grade ${level}`;
}

/**
 * The same band inside a sentence. Only a numbered grade lowercases; "K",
 * "College" and "Pre-reader" are names, and "keep k" reads like a typo on a
 * projected wall.
 */
export function levelPhrase(level: string | null): string {
  const text = levelText(level);
  return text.startsWith("Grade ") ? text.toLowerCase() : text;
}

/**
 * The confirmed setting, said plainly. This one IS legitimately about reading —
 * it is the level the tutor adapts its reading to, and a human ratified it.
 */
export function confirmedLevelLine(signals: RoundsLevelSignals): {
  headline: string;
  caption: string | null;
} {
  const { confirmed } = signals;
  if (confirmed.isPreReader) {
    return {
      headline: "Pre-reader",
      caption: "Tutor runs its K register, voice first",
    };
  }
  if (!confirmed.level) {
    return {
      headline: "Reading level not set",
      caption: "The tutor has no level to adapt to",
    };
  }
  return {
    headline: `Reading level · ${levelText(confirmed.level)}`,
    caption:
      confirmed.setBy === "teacher"
        ? "Ratified by a teacher"
        : confirmed.setBy === "observer"
          ? "Set by the observer — no teacher has ratified it"
          : "Set before ratification was recorded",
  };
}

/**
 * The writing-derived estimate — present ONLY while it disagrees with the
 * confirmed setting, because agreement clears it server-side. So a returned
 * estimate always means "current evidence disagrees with the setting", and that
 * is what this says out loud.
 *
 * It is never called a reading level. Nothing in its evidence chain observes
 * what the child can read.
 */
export function writingEstimateLine(
  signals: RoundsLevelSignals,
  scholarName: string,
): {
  headline: string;
  /** The full sentence, for the pane. */
  caption: string;
  /** The board's line — same claim, short enough to read across a room. */
  shortCaption: string;
  dismissLabel: string;
} | null {
  const { estimate, confirmed } = signals;
  if (!estimate.level) return null;

  const age =
    estimate.ageDays === null
      ? "computed date not recorded"
      : estimate.ageDays <= 0
        ? "computed today"
        : `computed ${plural(estimate.ageDays, "day", "days")} ago`;

  const against = confirmed.level
    ? `Nobody has settled it against ${levelPhrase(confirmed.level)}.`
    : "No confirmed level has been set against it.";

  return {
    headline: `Writing suggests ${levelText(estimate.level)}`,
    caption: `Estimated from ${scholarName}'s own writing — typed chat and scanned work, ${age}. ${against}`,
    shortCaption: confirmed.level
      ? `From their own writing. Not settled against ${levelPhrase(confirmed.level)}.`
      : "From their own writing. No confirmed level set against it.",
    // "Keep <the confirmed value>", never "Dismiss": the teacher is choosing
    // their standing ruling over a machine estimate, not discarding a message.
    dismissLabel: confirmed.level
      ? `Keep ${levelPhrase(confirmed.level)}`
      : "Leave the level unset",
  };
}

/**
 * The third instrument, named so it cannot be mistaken for either of the other
 * two. Its canonical rendering is the chart on the scholar's profile; Rounds
 * states the latest value and points there rather than growing a second chart.
 */
export function writingComplexityLine(latestGradeLevel: number | null): {
  headline: string;
  caption: string;
} {
  return {
    headline:
      latestGradeLevel === null
        ? "Writing complexity · not enough typed writing yet"
        : `Writing complexity · grade ${gradeNumber(latestGradeLevel)}`,
    caption:
      "Flesch–Kincaid over typed messages — a mechanical reading of sentence and word length, not a judgement of the ideas.",
  };
}

/** The bands `api.practiceCalibration.calibrationForScholar` returns. */
export type CalibrationBand =
  | "insufficient_data"
  | "overconfident"
  | "underconfident"
  | "well_calibrated";

export interface CalibrationReading {
  overall: { band: CalibrationBand; n: number };
}

/**
 * The Predict-then-Check calibration line for the weekly Rounds pane — a
 * per-child, trailing-window metacognitive diagnostic, moved here from the
 * retired cohort table so it rides the same weekly cadence as the practice
 * figures beside it.
 *
 * Honours the server's insufficient-data FLOOR: below it (band
 * "insufficient_data") this returns null so the pane renders nothing at all,
 * never an empty shell. The copy is a read about the child's PREDICTIONS versus
 * results — never a score on the child.
 */
export function calibrationFigureLine(
  calibration: CalibrationReading | null | undefined,
): { label: string; value: string; caption: string; wellCalibrated: boolean } | null {
  if (!calibration) return null;
  const { band, n } = calibration.overall;
  if (band === "insufficient_data") return null;

  const value: Record<Exclude<CalibrationBand, "insufficient_data">, string> = {
    well_calibrated: "Well calibrated",
    overconfident: "Runs ahead",
    underconfident: "Runs behind",
  };
  const caption: Record<Exclude<CalibrationBand, "insufficient_data">, string> = {
    well_calibrated: "Predictions track results.",
    overconfident: "Predictions run ahead of results.",
    underconfident: "Results run ahead of predictions.",
  };

  return {
    label: "Calibration · predict-then-check",
    value: `${value[band]} · n=${n}`,
    caption: caption[band],
    wellCalibrated: band === "well_calibrated",
  };
}
