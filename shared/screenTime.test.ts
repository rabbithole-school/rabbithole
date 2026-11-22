import { describe, expect, test } from "vitest";

import { instantForLocalMinutes } from "./institutionDay";
import {
  ACTIVE_TURN_CAP_MS,
  ACTIVE_TURN_LEAD_MS,
  ACTIVE_TURN_TRAIL_MS,
  WEB_ACTIVITY_SESSION_CAP_MS,
  activeWindowsFromTurns,
  clipInterval,
  intersectIntervals,
  mergeIntervals,
  overlapMs,
  splitIntervalByDay,
  totalMs,
  webActivitySessionInterval,
  type TurnRow,
} from "./screenTime";

const MINUTE = 60_000;
const TIME_ZONE = "Pacific/Honolulu";
// A fixed instant, never the real clock (TRA-267).
const T0 = Date.parse("2026-11-03T19:00:00.000Z"); // 09:00 in Honolulu

const at = (minutes: number) => T0 + minutes * MINUTE;
const span = (from: number, to: number) => ({ start: at(from), end: at(to) });
const row = (role: string, minutes: number): TurnRow => ({
  role,
  createdAt: at(minutes),
});

describe("mergeIntervals / totalMs", () => {
  test("sorts, unions overlapping and touching spans, and drops empty ones", () => {
    expect(
      mergeIntervals([span(5, 8), span(0, 2), span(2, 3), span(7, 10), span(4, 4)]),
    ).toEqual([span(0, 3), span(5, 10)]);
  });

  test("counts overlapping time once", () => {
    expect(totalMs([span(0, 10), span(5, 15)])).toBe(15 * MINUTE);
  });
});

describe("activeWindowsFromTurns", () => {
  test("a turn opens a lead before it and stays open a trail after its reply", () => {
    // The scholar asks at minute 10; the reply lands 24 seconds later.
    const rows = [row("user", 10), row("assistant", 10.4)];
    expect(activeWindowsFromTurns(rows)).toEqual([
      {
        start: at(10) - ACTIVE_TURN_LEAD_MS,
        end: at(10.4) + ACTIVE_TURN_TRAIL_MS,
      },
    ]);
  });

  test("an unanswered turn vouches for the lead and the trail around itself", () => {
    expect(activeWindowsFromTurns([row("user", 10)])).toEqual([
      { start: at(10) - ACTIVE_TURN_LEAD_MS, end: at(10) + ACTIVE_TURN_TRAIL_MS },
    ]);
  });

  test("a slow reply cannot stretch one turn past the cap", () => {
    const rows = [
      row("user", 0),
      row("assistant", 1),
      row("tool", 6),
      row("assistant", 12),
    ];
    expect(activeWindowsFromTurns(rows)).toEqual([
      { start: at(0) - ACTIVE_TURN_LEAD_MS, end: at(0) + ACTIVE_TURN_CAP_MS },
    ]);
  });

  test("a reply is credited to the turn it answers, never stretching an earlier one", () => {
    // Two requests four minutes apart; everything after minute 4 answers the
    // second. The first turn had no reply of its own, so it keeps only its
    // trail, and the long reply is capped from the SECOND turn.
    const rows = [
      row("user", 0),
      row("user", 4),
      row("assistant", 5),
      row("tool", 8),
      row("assistant", 12),
    ];
    expect(activeWindowsFromTurns(rows)).toEqual([
      { start: at(0) - ACTIVE_TURN_LEAD_MS, end: at(0) + ACTIVE_TURN_TRAIL_MS },
      { start: at(4) - ACTIVE_TURN_LEAD_MS, end: at(4) + ACTIVE_TURN_CAP_MS },
    ]);
  });

  test("the margins are options, so a caller can tune them without forking the rule", () => {
    const rows = [row("user", 0), row("assistant", 0.5)];
    expect(
      activeWindowsFromTurns(rows, { leadMs: 0, trailMs: 3 * MINUTE }),
    ).toEqual([span(0, 3.5)]);
    expect(
      activeWindowsFromTurns(rows, { leadMs: 0, trailMs: 3 * MINUTE, capMs: 2 * MINUTE }),
    ).toEqual([span(0, 2)]);
  });

  test("quick turns merge into one stretch; a long silence splits them", () => {
    const rows = [
      row("user", 0),
      row("assistant", 0.4),
      row("user", 2),
      row("assistant", 2.5),
      row("user", 20),
    ];
    expect(activeWindowsFromTurns(rows)).toEqual([
      { start: at(0) - ACTIVE_TURN_LEAD_MS, end: at(2.5) + ACTIVE_TURN_TRAIL_MS },
      { start: at(20) - ACTIVE_TURN_LEAD_MS, end: at(20) + ACTIVE_TURN_TRAIL_MS },
    ]);
  });

  test("sorts its input and ignores sessions with no user turns", () => {
    expect(
      activeWindowsFromTurns([row("assistant", 0.4), row("user", 0)]),
    ).toEqual([
      { start: at(0) - ACTIVE_TURN_LEAD_MS, end: at(0.4) + ACTIVE_TURN_TRAIL_MS },
    ]);
    expect(activeWindowsFromTurns([row("assistant", 0), row("tool", 1)])).toEqual(
      [],
    );
  });
});

describe("overlapMs / intersectIntervals / clipInterval", () => {
  test("counts each minute of the intervals inside any window once", () => {
    const intervals = [span(0, 10)];
    const windows = [span(2, 4), span(3, 6), span(8, 12)];
    expect(intersectIntervals(intervals, windows)).toEqual([
      span(2, 6),
      span(8, 10),
    ]);
    expect(overlapMs(intervals, windows)).toBe(6 * MINUTE);
  });

  test("overlapping intervals are unioned before they are measured", () => {
    expect(overlapMs([span(0, 10), span(5, 10)], [span(0, 20)])).toBe(
      10 * MINUTE,
    );
  });

  test("no overlap is zero, and clipping outside the bounds is null", () => {
    expect(overlapMs([span(0, 5)], [span(5, 10)])).toBe(0);
    expect(clipInterval(span(0, 5), span(6, 10))).toBeNull();
    expect(clipInterval(span(0, 10), span(6, 20))).toEqual(span(6, 10));
  });
});

describe("splitIntervalByDay", () => {
  test("cuts at institution-local midnight in Pacific/Honolulu", () => {
    const start = instantForLocalMinutes("2026-11-03", 23 * 60 + 50, TIME_ZONE);
    const end = instantForLocalMinutes("2026-11-04", 20, TIME_ZONE);
    const pieces = splitIntervalByDay({ start, end }, TIME_ZONE);
    expect(pieces.map((piece) => piece.dayKey)).toEqual([
      "2026-11-03",
      "2026-11-04",
    ]);
    expect(pieces.map((piece) => (piece.end - piece.start) / MINUTE)).toEqual([
      10, 20,
    ]);
    // Midnight in Honolulu is 10:00 UTC, not 00:00 UTC.
    expect(new Date(pieces[1].start).toISOString()).toBe(
      "2026-11-04T10:00:00.000Z",
    );
  });

  test("a span inside one day is one piece; a span over two midnights is three", () => {
    const morning = instantForLocalMinutes("2026-11-03", 9 * 60, TIME_ZONE);
    expect(
      splitIntervalByDay({ start: morning, end: morning + 30 * MINUTE }, TIME_ZONE),
    ).toEqual([
      { dayKey: "2026-11-03", start: morning, end: morning + 30 * MINUTE },
    ]);
    const long = splitIntervalByDay(
      {
        start: instantForLocalMinutes("2026-11-03", 22 * 60, TIME_ZONE),
        end: instantForLocalMinutes("2026-11-05", 1 * 60, TIME_ZONE),
      },
      TIME_ZONE,
    );
    expect(long.map((piece) => piece.dayKey)).toEqual([
      "2026-11-03",
      "2026-11-04",
      "2026-11-05",
    ]);
    expect(long.map((piece) => (piece.end - piece.start) / MINUTE)).toEqual([
      120,
      24 * 60,
      60,
    ]);
  });

  test("an empty span has no pieces", () => {
    expect(splitIntervalByDay({ start: T0, end: T0 }, TIME_ZONE)).toEqual([]);
  });
});

describe("webActivitySessionInterval", () => {
  test("reads the explicit end, else the last heartbeat, else nothing", () => {
    expect(
      webActivitySessionInterval({
        startedAt: at(0),
        endedAt: at(20),
        lastHeartbeatAt: at(15),
      }),
    ).toEqual(span(0, 20));
    expect(
      webActivitySessionInterval({ startedAt: at(0), lastHeartbeatAt: at(15) }),
    ).toEqual(span(0, 15));
    expect(webActivitySessionInterval({ startedAt: at(0) })).toEqual(span(0, 0));
  });

  test("a webview left open all night is capped", () => {
    expect(
      webActivitySessionInterval({
        startedAt: at(0),
        lastHeartbeatAt: at(14 * 60),
      }),
    ).toEqual({ start: at(0), end: at(0) + WEB_ACTIVITY_SESSION_CAP_MS });
  });
});
