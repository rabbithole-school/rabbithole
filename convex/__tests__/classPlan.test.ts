import { describe, expect, test } from "vitest";
import { classMeetingDays, shiftMeeting, type PlanClassTerm } from "../lib/classPlan";

const timeZone = "Pacific/Honolulu";
const at = (day: string, clock: string) => Date.parse(`${day}T${clock}:00-10:00`);

// Humanities meets Mon, Tue, Thu and Fri in the morning block.
const morning = { label: "Morning", startLocal: "09:00", endLocal: "10:15", weekdays: [1, 2, 3, 4, 5] };
function term(classId: string, from: string, to: string): PlanClassTerm {
  return {
    classId,
    cls: { meetings: [1, 2, 4, 5].map((weekday) => ({ weekday, blockId: "b1" })) },
    periodStartsAt: at(from, "00:00"),
    periodEndsAt: at(to, "00:00"),
    blocksById: new Map([["b1", morning]]),
  };
}

describe("classMeetingDays", () => {
  test("lists the class's meetings, skips non-meeting days, and reports closures", () => {
    const { meetings, closed } = classMeetingDays({
      terms: [term("fall", "2026-08-01", "2026-12-20")],
      closures: [{ startDayKey: "2026-11-13", endDayKey: "2026-11-13", label: "Staff day", kind: "staffOnly" }],
      fromDayKey: "2026-11-10",
      throughDayKey: "2026-11-17",
      timeZone,
    });
    expect(meetings.map((m) => m.dayKey)).toEqual([
      "2026-11-10", "2026-11-12", "2026-11-16", "2026-11-17",
    ]);
    expect(meetings[0]).toMatchObject({
      classId: "fall",
      startsAt: at("2026-11-10", "09:00"),
      endsAt: at("2026-11-10", "10:15"),
      blockLabel: "Morning",
    });
    expect(closed).toEqual([{ dayKey: "2026-11-13", label: "Staff day" }]);
  });

  test("a range across a term change follows each term's class record", () => {
    const { meetings } = classMeetingDays({
      terms: [term("fall", "2026-08-01", "2026-11-14"), term("winter", "2026-11-14", "2027-03-01")],
      closures: [],
      fromDayKey: "2026-11-12",
      throughDayKey: "2026-11-16",
      timeZone,
    });
    expect(meetings.map((m) => [m.dayKey, m.classId])).toEqual([
      ["2026-11-12", "fall"], ["2026-11-13", "fall"], ["2026-11-16", "winter"],
    ]);
  });
});

describe("shiftMeeting", () => {
  const { meetings } = classMeetingDays({
    terms: [term("fall", "2026-08-01", "2026-12-20")],
    closures: [{ startDayKey: "2026-11-13", endDayKey: "2026-11-13", label: "Staff day", kind: "staffOnly" }],
    fromDayKey: "2026-11-09",
    throughDayKey: "2026-11-20",
    timeZone,
  });

  test("moves by class meetings, stepping over closures and non-meeting days", () => {
    const on = (day: string) => ({ dayKey: day, startsAt: at(day, "09:00") });
    expect(shiftMeeting(meetings, on("2026-11-12"), 1)?.dayKey).toBe("2026-11-16");
    expect(shiftMeeting(meetings, on("2026-11-16"), -1)?.dayKey).toBe("2026-11-12");
    expect(shiftMeeting(meetings, on("2026-11-10"), 2)?.dayKey).toBe("2026-11-16");
  });

  test("counts from where a non-meeting day would sit", () => {
    // Wednesday: the next meeting is Thursday, the one before is Tuesday.
    expect(shiftMeeting(meetings, { dayKey: "2026-11-11" }, 1)?.dayKey).toBe("2026-11-12");
    expect(shiftMeeting(meetings, { dayKey: "2026-11-11" }, -1)?.dayKey).toBe("2026-11-10");
    // Homework given at 13:00 on a meeting day counts from after that meeting.
    expect(shiftMeeting(meetings, { dayKey: "2026-11-12", startsAt: at("2026-11-12", "13:00") }, 1)?.dayKey)
      .toBe("2026-11-16");
  });

  test("returns null past the end of the list", () => {
    expect(shiftMeeting(meetings, { dayKey: "2026-11-20", startsAt: at("2026-11-20", "09:00") }, 1)).toBeNull();
  });

  test("a double period counts as two meetings", () => {
    const twice: PlanClassTerm = {
      ...term("fall", "2026-08-01", "2026-12-20"),
      cls: { meetings: [{ weekday: 2, blockId: "b1" }, { weekday: 2, blockId: "b2" }] },
      blocksById: new Map([
        ["b1", morning],
        ["b2", { label: "Afternoon", startLocal: "13:00", endLocal: "14:00", weekdays: [1, 2, 3, 4, 5] }],
      ]),
    };
    const { meetings: m } = classMeetingDays({
      terms: [twice], closures: [], fromDayKey: "2026-11-10", throughDayKey: "2026-11-17", timeZone,
    });
    expect(m.map((x) => `${x.dayKey} ${x.blockLabel}`)).toEqual([
      "2026-11-10 Morning", "2026-11-10 Afternoon", "2026-11-17 Morning", "2026-11-17 Afternoon",
    ]);
    const next = shiftMeeting(m, { dayKey: "2026-11-10", startsAt: at("2026-11-10", "09:00") }, 1);
    expect(`${next?.dayKey} ${next?.blockLabel}`).toBe("2026-11-10 Afternoon");
  });
});
