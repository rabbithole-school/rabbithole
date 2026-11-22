// Pure classifier for the School › Screen time day strip: what kind of thing
// a scholar was doing, minute by minute, on one day. No Convex or DOM imports
// (see shared/screenTimeStretches.test.ts).
//
// ── WHY INFERENCE ──────────────────────────────────────────────────────────
// Device events say only that Rabbithole was on screen, or that the BunnyPad
// was handed to another app. They never say which Rabbithole screen was open.
// So the kind of each minute is inferred from the server's own records, by
// time overlap: an `appPlaySessions` row says the scholar's app was showing, a
// `webActivitySessions` row says a web activity was open, a practice attempt
// or a tutor turn says the scholar was doing that around then.
//
// ── COVERAGE COMES FROM THE DEVICE ONLY ────────────────────────────────────
// A stretch exists only where the roll-up (shared/deviceActivityRollup.ts)
// measured time on the BunnyPad: Rabbithole in the foreground, or a launched
// app the iPad came back from. The other sources only LABEL that time; they
// never add to it. So the strip's total for a day is exactly the day's
// measured minutes in the weekly table, and a laptop session (which overlaps
// no BunnyPad time) labels nothing.
//
// ── PRECEDENCE ─────────────────────────────────────────────────────────────
// Where sources overlap, the most specific wins:
//   launched app > web activity > own app (building, then playing)
//   > math practice > chat > plain Rabbithole
// A launched app is the iPad's own report and is never overlapped by
// Rabbithole foreground anyway. A web activity and the scholar's own app are
// full-screen surfaces with their own records, so they outrank the turn-based
// windows of practice and chat, which are estimates around single moments.

import { msToMinutes as msToMinutesRounded } from "./deviceActivityRollup";
import { mergeIntervals, overlapMs, totalMs, type Interval } from "./screenTime";

export type StretchKind =
  | "launched_app"
  | "web"
  | "building"
  | "playing"
  | "practice"
  | "chat"
  | "rabbithole";

/** In precedence order, highest first. Also the legend order. */
export const STRETCH_KINDS: readonly StretchKind[] = [
  "launched_app",
  "web",
  "building",
  "playing",
  "practice",
  "chat",
  "rabbithole",
];

export const STRETCH_KIND_LABELS: Record<StretchKind, string> = {
  building: "App building",
  playing: "Playing own app",
  chat: "Chat session",
  practice: "Math practice",
  web: "Web activity",
  launched_app: "Other app",
  rabbithole: "Rest of Rabbithole",
};

/** What a plain-Rabbithole stretch says, so a label never invents anything. */
export const NO_ACTIVITY_DETAIL = "Rabbithole, no activity open";

export type Stretch = {
  kind: StretchKind;
  start: number;
  end: number;
  /**
   * What was on screen, as specifically as the sources allow: the app, the
   * activity, the class and teacher, the skill practised. Titles only.
   */
  detail?: string;
};

/** An interval from one source, with what that source says it was. */
export type DetailedInterval = Interval & { detail?: string };

export type StretchSources = {
  /** Rabbithole itself in the foreground (the roll-up's measured foreground spans). */
  foreground: readonly Interval[];
  /** Measured stretches in a launched app; `detail` is the app's name. */
  launchedApps: readonly DetailedInterval[];
  web: readonly DetailedInterval[];
  /** The scholar's own app on screen. */
  builderOnScreen: readonly DetailedInterval[];
  /** The part of `builderOnScreen` near the scholar's own turns. */
  builderActive: readonly DetailedInterval[];
  /** Windows around math practice attempts; `detail` is the skill. */
  practice: readonly DetailedInterval[];
  /** Windows around the scholar's tutor turns; `detail` names the session. */
  chat: readonly DetailedInterval[];
};

export type ClassifiedDay = {
  /**
   * Disjoint, ascending. Adjacent stretches never share both kind and
   * detail, so a chat that moves to another session splits at the switch.
   */
  stretches: Stretch[];
  /**
   * The scholar's own app on screen while the BunnyPad measured nothing (no
   * touches, so no heartbeats). Drawn hatched; never counted in any total.
   */
  leftOpen: Interval[];
  /** Minutes per kind, one decimal place. */
  minutesByKind: Record<StretchKind, number>;
  totalMinutes: number;
};

/**
 * The detail of the latest-starting interval in `list` (sorted by start)
 * that covers `at`: where two sessions' windows overlap, the newer turn wins.
 */
function detailAt(list: readonly DetailedInterval[], at: number): string | undefined {
  let detail: string | undefined;
  for (const interval of list) {
    if (interval.start > at) break;
    if (at < interval.end && interval.detail !== undefined) detail = interval.detail;
  }
  return detail;
}

const byStart = (list: readonly DetailedInterval[]) =>
  list
    .filter((interval) => interval.end > interval.start)
    .map((interval) => ({ ...interval }))
    .sort((a, b) => a.start - b.start);

/** Is `at` inside any of `merged` (disjoint, ascending)? Binary search. */
function covers(merged: readonly Interval[], at: number): boolean {
  let lo = 0;
  let hi = merged.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const interval = merged[mid];
    if (at < interval.start) hi = mid - 1;
    else if (at >= interval.end) lo = mid + 1;
    else return true;
  }
  return false;
}

/**
 * Split one scholar-day's measured BunnyPad time into typed stretches.
 *
 * Every source boundary cuts the day into elementary pieces; each piece takes
 * the highest-precedence kind whose source covers it, and touching pieces of
 * the same kind (and app) join back into one stretch.
 */
export function classifyDayStretches(sources: StretchSources): ClassifiedDay {
  const layers = {
    launched_app: byStart(sources.launchedApps),
    web: byStart(sources.web),
    building: byStart(sources.builderActive),
    playing: byStart(sources.builderOnScreen),
    practice: byStart(sources.practice),
    chat: byStart(sources.chat),
  };
  const merged = {
    foreground: mergeIntervals(sources.foreground),
    launched_app: mergeIntervals(layers.launched_app),
    web: mergeIntervals(layers.web),
    building: mergeIntervals(layers.building),
    playing: mergeIntervals(layers.playing),
    practice: mergeIntervals(layers.practice),
    chat: mergeIntervals(layers.chat),
  };

  const cuts = new Set<number>();
  for (const list of [sources.foreground, ...Object.values(layers)]) {
    for (const interval of list) {
      cuts.add(interval.start);
      cuts.add(interval.end);
    }
  }
  const points = [...cuts].sort((a, b) => a - b);

  // Precedence, highest first; "rabbithole" is the remainder of foreground.
  const ranked = ["web", "building", "playing", "practice", "chat"] as const;

  const stretches: Stretch[] = [];
  for (let index = 0; index + 1 < points.length; index += 1) {
    const start = points[index];
    const end = points[index + 1];
    if (end <= start) continue;
    const mid = start + (end - start) / 2;
    let kind: StretchKind | null = null;
    let detail: string | undefined;
    if (covers(merged.launched_app, mid)) {
      kind = "launched_app";
      detail = detailAt(layers.launched_app, mid);
    } else if (covers(merged.foreground, mid)) {
      kind = "rabbithole";
      detail = NO_ACTIVITY_DETAIL;
      for (const candidate of ranked) {
        if (covers(merged[candidate], mid)) {
          kind = candidate;
          detail = detailAt(layers[candidate], mid);
          // Building is the own app's active part: name the app from either.
          if (candidate === "building" && detail === undefined) {
            detail = detailAt(layers.playing, mid);
          }
          break;
        }
      }
    }
    if (!kind) continue;
    const last = stretches[stretches.length - 1];
    if (last && last.end === start && last.kind === kind && last.detail === detail) {
      last.end = end;
    } else {
      stretches.push(detail !== undefined ? { kind, start, end, detail } : { kind, start, end });
    }
  }

  // Own app on screen where the device measured nothing at all.
  const measured = mergeIntervals([...merged.foreground, ...merged.launched_app]);
  const leftOpen: Interval[] = [];
  for (const open of merged.playing) {
    let cursor = open.start;
    for (const span of measured) {
      if (span.end <= cursor) continue;
      if (span.start >= open.end) break;
      if (span.start > cursor) leftOpen.push({ start: cursor, end: span.start });
      cursor = Math.max(cursor, span.end);
      if (cursor >= open.end) break;
    }
    if (cursor < open.end) leftOpen.push({ start: cursor, end: open.end });
  }

  const msByKind = Object.fromEntries(
    STRETCH_KINDS.map((kind) => [kind, 0]),
  ) as Record<StretchKind, number>;
  let totalStretchMs = 0;
  for (const stretch of stretches) {
    msByKind[stretch.kind] += stretch.end - stretch.start;
    totalStretchMs += stretch.end - stretch.start;
  }
  const minutesByKind = Object.fromEntries(
    STRETCH_KINDS.map((kind) => [kind, msToMinutesRounded(msByKind[kind])]),
  ) as Record<StretchKind, number>;

  return {
    stretches,
    leftOpen: leftOpen.filter((interval) => totalMs([interval]) > 0),
    minutesByKind,
    totalMinutes: msToMinutesRounded(totalStretchMs),
  };
}

// ── Minutes by kind, either side of the bell ────────────────────────────

/** Zero minutes for every kind. */
export function emptyKindMinutes(): Record<StretchKind, number> {
  return Object.fromEntries(STRETCH_KINDS.map((kind) => [kind, 0])) as Record<
    StretchKind,
    number
  >;
}

/**
 * One day's classified stretches as minutes per kind, split at the bell: the
 * part inside `schoolHours` is in school, the rest outside. The same split the
 * weekly table's "Outside school" column makes (the measured spans less their
 * overlap with the school-hours window), so the week and month bars and the
 * table agree on which side of the bell every minute fell. `schoolHours` is
 * empty on a weekend, a closed day or a day with no bell schedule, which puts
 * the whole day outside school.
 */
export function kindMinutesAtBell(
  stretches: readonly Stretch[],
  schoolHours: readonly Interval[],
): { inSchool: Record<StretchKind, number>; outside: Record<StretchKind, number> } {
  const inMs = emptyKindMinutes();
  const outMs = emptyKindMinutes();
  for (const stretch of stretches) {
    const whole = stretch.end - stretch.start;
    if (whole <= 0) continue;
    const inside = overlapMs([stretch], schoolHours);
    inMs[stretch.kind] += inside;
    outMs[stretch.kind] += whole - inside;
  }
  const toMinutes = (ms: Record<StretchKind, number>) =>
    Object.fromEntries(
      STRETCH_KINDS.map((kind) => [kind, msToMinutesRounded(ms[kind])]),
    ) as Record<StretchKind, number>;
  return { inSchool: toMinutes(inMs), outside: toMinutes(outMs) };
}

// ── The windows practice attempts vouch for ─────────────────────────────

/**
 * The most time before an attempt that it may vouch for: the time on the item.
 * `practiceAttempts.elapsedMs` is the client's time on the item; a missing or
 * implausible one counts as this cap. Provisional, like the turn windows in
 * shared/screenTime.ts.
 */
export const PRACTICE_ATTEMPT_LEAD_CAP_MS = 3 * 60_000;
/** Reading the verdict and moving on, after the answer is written. */
export const PRACTICE_ATTEMPT_TRAIL_MS = 30_000;

/**
 * One window per attempt, unioned per skill, so a run of items on one skill
 * reads as one stretch and a change of skill starts a new one.
 */
export function practiceWindowsFromAttempts(
  attempts: readonly {
    createdAt: number;
    elapsedMs?: number | null;
    detail?: string;
  }[],
): DetailedInterval[] {
  const bySkill = new Map<string | undefined, Interval[]>();
  for (const attempt of attempts) {
    const elapsed = attempt.elapsedMs;
    const lead =
      typeof elapsed === "number" && elapsed >= 0
        ? Math.min(elapsed, PRACTICE_ATTEMPT_LEAD_CAP_MS)
        : PRACTICE_ATTEMPT_LEAD_CAP_MS;
    const list = bySkill.get(attempt.detail) ?? [];
    list.push({
      start: attempt.createdAt - lead,
      end: attempt.createdAt + PRACTICE_ATTEMPT_TRAIL_MS,
    });
    bySkill.set(attempt.detail, list);
  }
  return [...bySkill.entries()]
    .flatMap(([detail, list]) =>
      mergeIntervals(list).map((interval) =>
        detail !== undefined ? { ...interval, detail } : interval,
      ),
    )
    .sort((a, b) => a.start - b.start);
}
