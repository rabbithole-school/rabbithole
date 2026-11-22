import { describe, expect, it } from "vitest";
import {
  classMeetingAt,
  endFromFinish,
  endFromRequestedWindow,
  meetingsOnDay,
  type MeetingBlockInput,
} from "./classMeetings";
import { isOpenUntil } from "./openUntil";

// Honolulu is UTC-10 all year (no DST), so local times are easy to write.
const TZ = "Pacific/Honolulu";
const hst = (dayKey: string, hhmm: string) =>
  Date.parse(`${dayKey}T${hhmm}:00.000-10:00`);
const endOfDay = (dayKey: string) => hst(dayKey, "23:59") + 59_999;

// 2026-11-09 is a Monday.
const MON = "2026-11-09";
const TUE = "2026-11-10";
const WED = "2026-11-11";

const blocks = new Map<string, MeetingBlockInput>([
  ["blockA", { startLocal: "08:30", endLocal: "09:40", weekdays: [1, 2, 3, 4, 5] }],
  // Runs Mon/Wed only.
  ["blockB", { startLocal: "09:45", endLocal: "11:00", weekdays: [1, 3] }],
  ["late", { startLocal: "23:00", endLocal: "24:00", weekdays: [1, 2, 3, 4, 5] }],
]);

const humanities = {
  meetings: [
    { weekday: 1, blockId: "blockB" },
    { weekday: 2, blockId: "blockB" }, // block B doesn't run Tuesdays
    { weekday: 3, blockId: "blockA" },
  ],
};

describe("endFromFinish", () => {
  it("in that class ends at the meeting's end and fades", () => {
    expect(
      endFromFinish(
        { kind: "inClass" },
        { dayKey: MON, meetingEndsAt: hst(MON, "11:00"), timeZone: TZ },
      ),
    ).toEqual({ endsAt: hst(MON, "11:00"), afterEnd: "fade" });
  });

  it("in that class outside any meeting ends at the end of the day", () => {
    expect(
      endFromFinish({ kind: "inClass" }, { dayKey: MON, timeZone: TZ }),
    ).toEqual({ endsAt: endOfDay(MON), afterEnd: "fade" });
  });

  it("by a date ends at the end of that school day and goes late", () => {
    expect(
      endFromFinish({ kind: "by", dayKey: WED }, { dayKey: MON, timeZone: TZ }),
    ).toEqual({ endsAt: endOfDay(WED), afterEnd: "late" });
  });

  it("open until ends at the end of that day and fades", () => {
    expect(
      endFromFinish(
        { kind: "openUntil", dayKey: WED },
        { dayKey: MON, timeZone: TZ },
      ),
    ).toEqual({ endsAt: endOfDay(WED), afterEnd: "fade" });
  });

  it("end of unit ends at the end of the given day and goes late", () => {
    expect(
      endFromFinish(
        { kind: "endOfUnit", dayKey: TUE },
        { dayKey: MON, timeZone: TZ },
      ),
    ).toEqual({ endsAt: endOfDay(TUE), afterEnd: "late" });
  });

  it("uses the school's time zone for the day end", () => {
    const { endsAt } = endFromFinish(
      { kind: "by", dayKey: MON },
      { dayKey: MON, timeZone: TZ },
    );
    expect(new Date(endsAt!).toISOString()).toBe("2026-11-10T09:59:59.999Z");
  });
});

describe("endFromRequestedWindow", () => {
  it("focus keeps its end and fades", () => {
    expect(
      endFromRequestedWindow(
        { kind: "focus", endsAt: hst(MON, "09:40") },
        hst(MON, "08:30"),
        TZ,
      ),
    ).toEqual({ endsAt: hst(MON, "09:40"), afterEnd: "fade" });
  });

  it("an open-until focus fades too", () => {
    const setAt = hst(MON, "08:30");
    const endsAt = endOfDay(WED) + 1;
    expect(isOpenUntil({ mode: "classFocus", setAt, endsAt }, TZ)).toBe(true);
    expect(endFromRequestedWindow({ kind: "focus", endsAt }, setAt, TZ)).toEqual({
      endsAt,
      afterEnd: "fade",
    });
  });

  it("until cleared ends at the end of the day it was given and fades", () => {
    expect(
      endFromRequestedWindow({ kind: "untilCleared" }, hst(MON, "10:15"), TZ),
    ).toEqual({ endsAt: endOfDay(MON), afterEnd: "fade" });
  });

  it("until cleared given at 23:50 ends that same night", () => {
    expect(
      endFromRequestedWindow({ kind: "untilCleared" }, hst(MON, "23:50"), TZ),
    ).toEqual({ endsAt: endOfDay(MON), afterEnd: "fade" });
  });

  it("until cleared given at midnight belongs to the new day", () => {
    expect(
      endFromRequestedWindow({ kind: "untilCleared" }, hst(TUE, "00:00"), TZ),
    ).toEqual({ endsAt: endOfDay(TUE), afterEnd: "fade" });
  });

  it("dated homework ends at its due time and goes late", () => {
    expect(
      endFromRequestedWindow(
        { kind: "homework", dueAt: endOfDay(WED) },
        hst(MON, "10:00"),
        TZ,
      ),
    ).toEqual({ endsAt: endOfDay(WED), afterEnd: "late" });
  });

  it("undated homework keeps no end and goes late", () => {
    expect(
      endFromRequestedWindow({ kind: "homework" }, hst(MON, "10:00"), TZ),
    ).toEqual({ endsAt: undefined, afterEnd: "late" });
  });
});

describe("meetingsOnDay", () => {
  it("returns the meeting with its block times", () => {
    expect(meetingsOnDay(humanities, blocks, MON, TZ)).toEqual([
      {
        dayKey: MON,
        weekday: 1,
        blockId: "blockB",
        startsAt: hst(MON, "09:45"),
        endsAt: hst(MON, "11:00"),
      },
    ]);
  });

  it("skips a meeting whose block doesn't run that weekday", () => {
    expect(meetingsOnDay(humanities, blocks, TUE, TZ)).toEqual([]);
  });

  it("returns nothing on a day the class doesn't meet", () => {
    expect(meetingsOnDay(humanities, blocks, "2026-11-12", TZ)).toEqual([]);
  });

  it("returns nothing for a missing block", () => {
    expect(
      meetingsOnDay({ meetings: [{ weekday: 1, blockId: "gone" }] }, blocks, MON, TZ),
    ).toEqual([]);
  });

  it("reads a block ending at 24:00 as the next midnight", () => {
    const [m] = meetingsOnDay(
      { meetings: [{ weekday: 1, blockId: "late" }] },
      blocks,
      MON,
      TZ,
    );
    expect(m.endsAt).toBe(hst(TUE, "00:00"));
  });
});

describe("classMeetingAt", () => {
  it("finds the meeting containing the instant", () => {
    expect(classMeetingAt(humanities, blocks, hst(WED, "09:00"), TZ)).toMatchObject({
      dayKey: WED,
      blockId: "blockA",
    });
  });

  it("includes the start and excludes the end", () => {
    expect(classMeetingAt(humanities, blocks, hst(MON, "09:45"), TZ)).not.toBeNull();
    expect(classMeetingAt(humanities, blocks, hst(MON, "11:00"), TZ)).toBeNull();
  });

  it("is null at a time outside the meeting", () => {
    expect(classMeetingAt(humanities, blocks, hst(MON, "08:45"), TZ)).toBeNull();
  });

  it("is null on a weekday the class doesn't meet", () => {
    // Thursday 09:50: block B's hours, but no Thursday meeting.
    expect(
      classMeetingAt(humanities, blocks, hst("2026-11-12", "09:50"), TZ),
    ).toBeNull();
  });

  it("is null when the block doesn't run that weekday", () => {
    expect(classMeetingAt(humanities, blocks, hst(TUE, "10:00"), TZ)).toBeNull();
  });

  it("uses the school-local day, not UTC", () => {
    // Monday 23:50 Honolulu is Tuesday 09:50 UTC; the late block is Monday's.
    const late = { meetings: [{ weekday: 1, blockId: "late" }] };
    expect(classMeetingAt(late, blocks, hst(MON, "23:50"), TZ)).toMatchObject({
      dayKey: MON,
      weekday: 1,
    });
    // Tuesday 00:00 is past Monday's late block and Tuesday has no meeting.
    expect(classMeetingAt(late, blocks, hst(TUE, "00:00"), TZ)).toBeNull();
  });
});

describe("daylight saving (a school outside Honolulu)", () => {
  const NY = "America/New_York";
  // 2026-03-08 is a Sunday: New York skips 02:00–03:00 local.
  const SPRING = "2026-03-08";
  const nyBlocks = new Map<string, MeetingBlockInput>([
    ["gap", { startLocal: "02:30", endLocal: "03:30", weekdays: [7] }],
    ["endsInGap", { startLocal: "01:30", endLocal: "02:30", weekdays: [7] }],
    ["morning", { startLocal: "09:00", endLocal: "10:00", weekdays: [7] }],
  ]);
  const sunday = (blockId: string) => ({ meetings: [{ weekday: 7, blockId }] });

  it("treats a meeting starting in the spring-forward gap as no meeting", () => {
    expect(meetingsOnDay(sunday("gap"), nyBlocks, SPRING, NY)).toEqual([]);
    expect(
      classMeetingAt(sunday("gap"), nyBlocks, Date.parse("2026-03-08T03:15:00-04:00"), NY),
    ).toBeNull();
  });

  it("treats a meeting ending in the gap as no meeting", () => {
    expect(meetingsOnDay(sunday("endsInGap"), nyBlocks, SPRING, NY)).toEqual([]);
  });

  it("keeps the same block on an ordinary Sunday", () => {
    const [m] = meetingsOnDay(sunday("gap"), nyBlocks, "2026-03-15", NY);
    expect(m.startsAt).toBe(Date.parse("2026-03-15T02:30:00-04:00"));
  });

  it("times a meeting after the change at the new offset", () => {
    const [m] = meetingsOnDay(sunday("morning"), nyBlocks, SPRING, NY);
    expect(m.startsAt).toBe(Date.parse("2026-03-08T09:00:00-04:00"));
    expect(m.endsAt).toBe(Date.parse("2026-03-08T10:00:00-04:00"));
  });

  it("propagates errors that aren't a DST gap", () => {
    expect(() =>
      meetingsOnDay(sunday("morning"), nyBlocks, SPRING, "Not/AZone"),
    ).toThrow();
  });

  it("ends a 23-hour day at its real last millisecond", () => {
    expect(
      endFromFinish({ kind: "by", dayKey: SPRING }, { dayKey: SPRING, timeZone: NY }),
    ).toEqual({
      endsAt: Date.parse("2026-03-09T00:00:00-04:00") - 1,
      afterEnd: "late",
    });
  });
});
