/**
 * Rounds cadence — the institution-local week a Rounds meeting belongs to.
 *
 * The primary school runs Rounds on a Thursday afternoon, but that is a local habit,
 * not a product rule: the key is the school WEEK, anchored wherever the school
 * says its week turns over, so a school that meets on a Tuesday morning lands
 * in the same bucket without a code change. Nothing here — and nothing in the
 * Rounds copy — names a weekday. Labels name a DATE.
 *
 * ── Why this does NOT use `shared/scheduleWeek.ts` ────────────────────────
 * That helper is anchored to Monday 00:00 and is shared with the master
 * timetable grid (`convex/masterSchedule.ts` STAMPS `weekStartMs`; the grid
 * COMPARES against it). Moving its anchor would silently shift every timetable
 * chip. Rounds therefore does its own anchored arithmetic on the same
 * primitives (`shared/institutionDay.ts`) rather than widening a shared one.
 *
 * ── Why weekly goals do NOT move with Rounds ──────────────────────────────
 * `weeklyGoals.weekOf` is a Monday key (`convex/weeklyGoals.ts → mondayWeekOf`)
 * and stays one. Before the anchor existed both keys happened to be the same
 * Monday string, so they coincidentally joined; under a Thursday anchor they
 * diverge, and that is CORRECT. A learner's weekly goal is the child's own
 * Monday-to-Sunday loop; the Rounds week is the adults' meeting-to-meeting
 * window. Equality of the two strings was an accident of the default anchor,
 * never a modelled relationship — pinned by the divergence test in
 * `lib/roundsCadence.test.ts`.
 */
import {
  dayKeyForTimezone,
  dayStartForDayKey,
  instantForLocalMinutes,
  shiftDayKey,
  weekdayForDayKey,
  DEFAULT_TIMEZONE,
} from "../shared/institutionDay";

/**
 * Where an institution's Rounds week turns over.
 *
 * `weekday` is 0=Sun … 6=Sat (the `shared/institutionDay` convention);
 * `minutes` is 0–1439 wall-clock minutes past institution-local midnight.
 */
export type RoundsAnchor = {
  weekday: number;
  minutes: number;
};

export type RoundsCadenceKind = "academic" | "sel";

export type RoundsCadence = RoundsAnchor & {
  kind: RoundsCadenceKind;
};

/**
 * Monday 00:00 — exactly the behaviour every stored `weekKey` was written
 * under, so an institution with no anchor configured keeps its history.
 */
export const DEFAULT_ROUNDS_ANCHOR: RoundsAnchor = { weekday: 1, minutes: 0 };

/** The subset of an institution row this module reads. */
export type RoundsAnchorConfig =
  | {
      roundsCadences?: RoundsCadence[];
      roundsAnchorWeekday?: number;
      roundsAnchorMinutes?: number;
    }
  | null
  | undefined;

function isWeekday(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) >= 0 && (value as number) <= 6;
}

function isMinuteOfDay(value: unknown): value is number {
  return (
    Number.isInteger(value) && (value as number) >= 0 && (value as number) < 24 * 60
  );
}

/**
 * Read an institution's configured anchor, falling back to the default.
 *
 * An out-of-range stored value falls back rather than throwing: the fallback is
 * exactly today's behaviour, so a misconfiguration degrades to the historical
 * week instead of taking the meeting down mid-Rounds. WRITES are strict —
 * `assertValidRoundsAnchor` below rejects a bad anchor at the door so nothing
 * out of range is ever stored in the first place.
 */
export function roundsAnchorFor(institution: RoundsAnchorConfig): RoundsAnchor;
export function roundsAnchorFor(
  institution: RoundsAnchorConfig,
  kind: "academic",
): RoundsAnchor;
export function roundsAnchorFor(
  institution: RoundsAnchorConfig,
  kind: "sel",
): RoundsAnchor | null;
export function roundsAnchorFor(
  institution: RoundsAnchorConfig,
  kind: RoundsCadenceKind,
): RoundsAnchor | null;
export function roundsAnchorFor(
  institution: RoundsAnchorConfig,
  kind: RoundsCadenceKind = "academic",
): RoundsAnchor | null {
  const configured = institution?.roundsCadences?.find(
    (cadence) =>
      cadence.kind === kind &&
      isWeekday(cadence.weekday) &&
      isMinuteOfDay(cadence.minutes),
  );
  if (configured) {
    return { weekday: configured.weekday, minutes: configured.minutes };
  }
  if (kind === "sel") return null;
  return {
    weekday: isWeekday(institution?.roundsAnchorWeekday)
      ? institution.roundsAnchorWeekday
      : DEFAULT_ROUNDS_ANCHOR.weekday,
    minutes: isMinuteOfDay(institution?.roundsAnchorMinutes)
      ? institution.roundsAnchorMinutes
      : DEFAULT_ROUNDS_ANCHOR.minutes,
  };
}

/**
 * Validate an anchor about to be STORED. Rejects out of range rather than
 * clamping: a typo'd anchor that silently shifts a whole school's week — and
 * with it every `weekKey` the ritual reads back — is worse than an error the
 * person who typed it sees immediately.
 */
export function assertValidRoundsAnchor(anchor: RoundsAnchor): RoundsAnchor {
  if (!isWeekday(anchor.weekday)) {
    throw new Error(
      "Rounds anchor weekday must be a whole number from 0 (Sunday) to 6 (Saturday)",
    );
  }
  if (!isMinuteOfDay(anchor.minutes)) {
    throw new Error(
      "Rounds anchor minutes must be a whole number from 0 to 1439 (minutes past local midnight)",
    );
  }
  return { weekday: anchor.weekday, minutes: anchor.minutes };
}

export function assertValidRoundsCadences(
  cadences: readonly RoundsCadence[],
): RoundsCadence[] {
  const kinds = new Set<RoundsCadenceKind>();
  const validated = cadences.map((cadence) => {
    if (cadence.kind !== "academic" && cadence.kind !== "sel") {
      throw new Error("Rounds cadence kind must be academic or sel");
    }
    if (kinds.has(cadence.kind)) {
      throw new Error(`Rounds cadences may include at most one ${cadence.kind} entry`);
    }
    kinds.add(cadence.kind);
    return { kind: cadence.kind, ...assertValidRoundsAnchor(cadence) };
  });
  if (!kinds.has("academic")) {
    throw new Error("Rounds cadences must include one academic entry");
  }
  return validated;
}

/** Every effective cadence, including the legacy/default academic fallback. */
export function roundsCadencesFor(institution: RoundsAnchorConfig): RoundsCadence[] {
  const academic = roundsAnchorFor(institution, "academic");
  const sel = roundsAnchorFor(institution, "sel");
  return [
    { kind: "academic", ...academic },
    ...(sel ? [{ kind: "sel" as const, ...sel }] : []),
  ];
}

/**
 * Cadences explicitly configured by the institution, with no compatibility
 * default. Used by side effects such as reminders that must not activate merely
 * because old reads preserve Monday 00:00 behavior.
 */
export function explicitRoundsCadencesFor(
  institution: RoundsAnchorConfig,
): RoundsCadence[] {
  const configured = (institution?.roundsCadences ?? []).filter(
    (cadence) =>
      (cadence.kind === "academic" || cadence.kind === "sel") &&
      isWeekday(cadence.weekday) &&
      isMinuteOfDay(cadence.minutes),
  );
  const academic = configured.find((cadence) => cadence.kind === "academic");
  const sel = configured.find((cadence) => cadence.kind === "sel");
  const legacyAcademic =
    !academic &&
    isWeekday(institution?.roundsAnchorWeekday) &&
    isMinuteOfDay(institution?.roundsAnchorMinutes)
      ? {
          kind: "academic" as const,
          weekday: institution.roundsAnchorWeekday,
          minutes: institution.roundsAnchorMinutes,
        }
      : null;
  return [
    ...(academic ? [{ ...academic }] : legacyAcademic ? [legacyAcademic] : []),
    ...(sel ? [{ ...sel }] : []),
  ];
}

/**
 * The instant an anchored week beginning on `dayKey` starts.
 *
 * A spring-forward transition can delete the anchor's wall-clock minute from a
 * calendar day. Rather than throw (which would blank the board for one week a
 * year), the week then starts at the earliest instant that day exists.
 */
function anchorInstant(
  dayKey: string,
  anchor: RoundsAnchor,
  timeZone: string,
): number {
  try {
    return instantForLocalMinutes(dayKey, anchor.minutes, timeZone);
  } catch {
    return dayStartForDayKey(dayKey, timeZone);
  }
}

/**
 * The stable, institution-local key for the Rounds week containing an instant.
 *
 * The key is the day key of the week's ANCHOR day. With a Thursday 15:00
 * anchor the week spans Thu 15:00 → next Thu 15:00 institution-local, so an
 * instant at Thu 14:59 still belongs to the previous week and Thu 15:01 opens
 * the new one.
 */
export function roundsWeekKey(
  atMs: number = Date.now(),
  timeZone: string = DEFAULT_TIMEZONE,
  anchor: RoundsAnchor = DEFAULT_ROUNDS_ANCHOR,
): string {
  const dayKey = dayKeyForTimezone(atMs, timeZone);
  const daysSinceAnchor = (weekdayForDayKey(dayKey) - anchor.weekday + 7) % 7;
  const candidate = shiftDayKey(dayKey, -daysSinceAnchor);
  // Only reachable on the anchor day itself, before the anchor minute.
  if (atMs < anchorInstant(candidate, anchor, timeZone)) {
    return shiftDayKey(candidate, -7);
  }
  return candidate;
}

/** Epoch-ms at which the Rounds week named by `weekKey` begins. */
export function roundsWeekStartMs(
  weekKey: string,
  timeZone: string = DEFAULT_TIMEZONE,
  anchor: RoundsAnchor = DEFAULT_ROUNDS_ANCHOR,
): number {
  return anchorInstant(weekKey, anchor, timeZone);
}

/**
 * The half-open `[startMs, endMs)` window a Rounds week covers.
 *
 * Every week-bounded read on the board goes through this one window, so the
 * note, the observations, the mastery movement and the practice rows can never
 * disagree about which week they are describing.
 */
export function roundsWeekWindow(
  weekKey: string,
  timeZone: string = DEFAULT_TIMEZONE,
  anchor: RoundsAnchor = DEFAULT_ROUNDS_ANCHOR,
): { startMs: number; endMs: number } {
  return {
    startMs: roundsWeekStartMs(weekKey, timeZone, anchor),
    endMs: roundsWeekStartMs(shiftDayKey(weekKey, 7), timeZone, anchor),
  };
}

/** Shift a Rounds week by whole school weeks without using the host timezone. */
export function shiftRoundsWeekKey(weekKey: string, offset: number): string {
  return shiftDayKey(weekKey, offset * 7);
}

/**
 * The Rounds week a picked calendar DAY falls in.
 *
 * The week picker hands back an arbitrary day; a day belongs to exactly one
 * Rounds week — the one whose ANCHOR day is the most recent anchor-weekday on
 * or before it. The anchor weekday is read from a known `weekKey` (every key
 * names an anchor day, so they all share its weekday), so this needs no
 * institution config or host timezone. Same anchoring arithmetic as
 * `roundsWeekKey`, minus the anchor-MINUTE check: a whole-day pick has no
 * time-of-day, so the sub-day precision that check exists for is moot.
 */
export function roundsWeekKeyForDay(dayKey: string, referenceWeekKey: string): string {
  const anchorWeekday = weekdayForDayKey(referenceWeekKey);
  const daysSinceAnchor = (weekdayForDayKey(dayKey) - anchorWeekday + 7) % 7;
  return shiftDayKey(dayKey, -daysSinceAnchor);
}

/**
 * Re-anchor a viewed week onto another cadence's anchor weekday, keeping the
 * teacher's relative position ("last week" stays last week).
 *
 * The two cadences of one school can anchor on different weekdays (Tue
 * academic / Thu SEL is the live config), so a week key carried across a
 * cadence switch may name a day that is not an anchor for the target cadence —
 * the exact-string meeting lookup then misses an open meeting. A week under
 * one anchor always overlaps two weeks of the other, so "same week" is
 * ambiguous; nearest-week rounding of the day offset (anchors are < 7 days
 * apart) resolves it to the week the teacher means. Aligned input comes back
 * unchanged.
 */
export function alignRoundsWeekKey(weekKey: string, targetCurrentWeekKey: string): string {
  const dayMs =
    Date.parse(`${weekKey}T00:00:00Z`) - Date.parse(`${targetCurrentWeekKey}T00:00:00Z`);
  const weeks = Math.round(dayMs / (7 * 24 * 60 * 60 * 1000));
  return shiftRoundsWeekKey(targetCurrentWeekKey, weeks);
}

const MONTHS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

/**
 * "20 Aug" — the human label for a week key.
 *
 * A DATE, never a weekday: the label reads the same for a school that meets on
 * a Tuesday. Callers supply their own framing ("Rounds · 20 Aug", "Last in
 * Rounds · 20 Aug"), so the label itself carries no prefix and can never be
 * double-prefixed.
 *
 * Parsed from the key's own digits rather than through a `Date`, so the label
 * can never slip a day by being rendered in the browser's timezone instead of
 * the school's. Returns the raw key if it is not a well-formed day key.
 */
export function roundsWeekLabel(weekKey: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(weekKey);
  if (!match) return weekKey;
  const month = MONTHS[Number(match[2]) - 1];
  if (!month) return weekKey;
  return `${Number(match[3])} ${month}`;
}

/**
 * Read the week a Rounds deep-link is pinned to (`?rweek=`).
 *
 * A scholar opened from the board carries the week the board was showing, so
 * that a closed week stays closed all the way down and back. The server reads
 * an unknown key leniently — it falls back to the historical week rather than
 * throwing — so this guard is not a safety gate; it is here so a junk value in
 * a pasted URL cannot quietly re-point the room at a different week than the
 * one its own breadcrumb names.
 */
export function parseRoundsWeekParam(raw: string | null | undefined): string | null {
  if (!raw) return null;
  return /^\d{4}-\d{2}-\d{2}$/.test(raw) ? raw : null;
}

/** Unknown or absent deep-link values preserve the existing academic meeting. */
export function parseRoundsCadenceParam(
  raw: string | null | undefined,
): RoundsCadenceKind {
  return raw === "sel" ? "sel" : "academic";
}
