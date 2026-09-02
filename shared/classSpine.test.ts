import { describe, expect, test } from "vitest";
import {
  assembleClassSpine,
  firstFreeMeeting,
  type SpineChip,
} from "./classSpine";
import { scheduleWeekStartMs } from "./scheduleWeek";
import { nextMeetingAfter } from "./meetingSlots";
import { dayKeyForWeekday, type SchoolClosure } from "./schoolClosures";

const DAY = 86_400_000;
const HOUR = 3_600_000;
const TZ = "Pacific/Honolulu";
// A concrete Monday 00:00 HST (Jan 7 2026 is a Wednesday → that week's Monday is
// Jan 5), so meeting day/end instants are deterministic.
const W = scheduleWeekStartMs(Date.UTC(2026, 0, 7, 20, 0));
const bo = new Map([["b1", 0], ["b2", 1]]);
const mwf = [
  { weekday: 1, blockId: "b1" },
  { weekday: 3, blockId: "b1" },
  { weekday: 5, blockId: "b1" },
];

/** A queued chip on b1 landing at `weekStartMs`/`weekday`, meeting ending 10:00. */
function chip(i: number, weekStartMs: number, weekday: number): SpineChip {
  const dayMs = weekStartMs + (weekday - 1) * DAY;
  return {
    placementId: `p${i}`,
    weekStartMs,
    weekday,
    blockId: "b1",
    dayMs,
    endMs: dayMs + 10 * HOUR,
    sequenceIndex: i,
    sequenceLength: 6,
    activityTitle: `A${i}`,
    unitTitle: "Unit",
    linkState: "planned",
  };
}

// Mon/Wed/Fri of week W (i=0,1,2) then of week W+7 (i=3,4,5).
const sixChips = [
  chip(0, W, 1),
  chip(1, W, 3),
  chip(2, W, 5),
  chip(3, W + 7 * DAY, 1),
  chip(4, W + 7 * DAY, 3),
  chip(5, W + 7 * DAY, 5),
];

describe("assembleClassSpine", () => {
  // "Now" = Saturday of week W (after Friday's meeting ended): 0,1,2 are past.
  const now = W + 5 * DAY;

  test("splits past/upcoming by meeting end, caps past to the most recent N", () => {
    const spine = assembleClassSpine({ chips: sixChips, nowMs: now, pastCap: 2 });
    expect(spine.pastTotal).toBe(3);
    // Most recent 2 past meetings, chronological ascending.
    expect(spine.past.map((c) => c.placementId)).toEqual(["p1", "p2"]);
    expect(spine.upcoming.map((c) => c.placementId)).toEqual(["p3", "p4", "p5"]);
    // "Finishes" = the last meeting's date (whole queue), not endMs.
    expect(spine.finishesMs).toBe(W + 7 * DAY + 4 * DAY);
  });

  test("a chip is upcoming until its own meeting has ended (in-progress reads upcoming)", () => {
    // Now is Monday of W, one minute before p0's meeting ends (10:00).
    const monNow = W + 10 * HOUR - 60_000;
    const spine = assembleClassSpine({ chips: sixChips, nowMs: monNow, pastCap: 5 });
    expect(spine.pastTotal).toBe(0);
    expect(spine.upcoming[0].placementId).toBe("p0");
  });

  test("pastCap larger than the count returns every past meeting", () => {
    const spine = assembleClassSpine({ chips: sixChips, nowMs: now, pastCap: 10 });
    expect(spine.past.map((c) => c.placementId)).toEqual(["p0", "p1", "p2"]);
  });

  test("sorts unsorted input and handles an empty class", () => {
    const shuffled = [sixChips[3], sixChips[0], sixChips[5], sixChips[1]];
    const spine = assembleClassSpine({ chips: shuffled, nowMs: now, pastCap: 5 });
    expect(spine.upcoming.map((c) => c.placementId)).toEqual(["p3", "p5"]);
    expect(spine.past.map((c) => c.placementId)).toEqual(["p0", "p1"]);

    const empty = assembleClassSpine({ chips: [], nowMs: now, pastCap: 5 });
    expect(empty).toEqual({ past: [], pastTotal: 0, upcoming: [], finishesMs: null });
  });
});

describe("firstFreeMeeting", () => {
  const slotsOf = (chips: SpineChip[]) =>
    chips.map((c) => ({ weekStartMs: c.weekStartMs, weekday: c.weekday, blockId: c.blockId }));
  // Thin wrapper injecting the (usually empty) closure args so each case stays
  // focused on the queue/pattern logic; the closure case overrides them.
  const ff = (
    a: Omit<Parameters<typeof firstFreeMeeting>[0], "closures" | "timeZone"> & {
      closures?: readonly SchoolClosure[];
      timeZone?: string;
    },
  ) => firstFreeMeeting({ closures: [], timeZone: TZ, ...a });

  test("lands one meeting after the last queued chip (end-to-end)", () => {
    // Queue runs through W+7 Friday; today is W Monday. The free meeting is the
    // one right after the whole queue = next-next-week Monday.
    const free = ff({
      queuedSlots: slotsOf(sixChips),
      pattern: mwf,
      blockOrder: bo,
      nowWeekStartMs: W,
      nowWeekday: 1,
    });
    expect(free).toEqual(nextMeetingAfter({ weekStartMs: W + 7 * DAY, weekday: 5, blockId: "b1" }, mwf, bo));
    expect(free).toEqual({ weekStartMs: W + 14 * DAY, weekday: 1, blockId: "b1" });
  });

  test("nothing queued → the first meeting strictly after today", () => {
    // Today is Tuesday of W; the next meeting is this Wednesday.
    const free = ff({
      queuedSlots: [],
      pattern: mwf,
      blockOrder: bo,
      nowWeekStartMs: W,
      nowWeekday: 2,
    });
    expect(free).toEqual({ weekStartMs: W, weekday: 3, blockId: "b1" });
  });

  test("once-weekly class, nothing queued → THIS week's still-upcoming meeting (no week skip)", () => {
    const wedOnly = [{ weekday: 3, blockId: "b1" }];
    // Today is Monday, before the Wednesday meeting — the free meeting is this
    // Wednesday, not next week's.
    expect(
      ff({ queuedSlots: [], pattern: wedOnly, blockOrder: bo, nowWeekStartMs: W, nowWeekday: 1 }),
    ).toEqual({ weekStartMs: W, weekday: 3, blockId: "b1" });
    // Once the meeting has passed (Thursday), it rolls to next week.
    expect(
      ff({ queuedSlots: [], pattern: wedOnly, blockOrder: bo, nowWeekStartMs: W, nowWeekday: 4 }),
    ).toEqual({ weekStartMs: W + 7 * DAY, weekday: 3, blockId: "b1" });
  });

  test("a queue entirely in the past clamps forward to the next real meeting", () => {
    // Queue is all of week W (past); today is next week's Monday. The free
    // meeting must be THIS week's Wednesday, not a still-past slot.
    const free = ff({
      queuedSlots: slotsOf([sixChips[0], sixChips[1], sixChips[2]]),
      pattern: mwf,
      blockOrder: bo,
      nowWeekStartMs: W + 7 * DAY,
      nowWeekday: 1,
    });
    expect(free).toEqual({ weekStartMs: W + 7 * DAY, weekday: 3, blockId: "b1" });
  });

  test("a closed anchor day rolls forward to the next OPEN meeting", () => {
    // Empty queue, today Monday → the clamped anchor is this Wednesday. Close
    // Wednesday → the free meeting must roll to Friday (the cascade would skip
    // the closed day, so the anchor has to as well or the grid lands off-screen).
    const wedKey = dayKeyForWeekday(W, 3, TZ);
    const closures: SchoolClosure[] = [
      { startDayKey: wedKey, endDayKey: wedKey, label: "Holiday", kind: "holiday" },
    ];
    const free = ff({
      queuedSlots: [],
      pattern: mwf,
      blockOrder: bo,
      nowWeekStartMs: W,
      nowWeekday: 1,
      closures,
    });
    expect(free).toEqual({ weekStartMs: W, weekday: 5, blockId: "b1" });
  });

  test("no recurring pattern → null (no structure to flow onto)", () => {
    expect(
      ff({
        queuedSlots: [],
        pattern: [],
        blockOrder: bo,
        nowWeekStartMs: W,
        nowWeekday: 1,
      }),
    ).toBeNull();
  });
});
