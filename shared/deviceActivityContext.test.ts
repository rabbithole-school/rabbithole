import { describe, expect, test } from "vitest";

import {
  DEFAULT_SCHOOL_DAY_WINDOW,
  deriveDeviceActivityContext,
  minuteOfDayFromLocalTime,
  schoolDayWindowFromBlocks,
  type DeviceActivityContextInput,
} from "./deviceActivityContext";

const MONDAY = 1;
const SATURDAY = 6;

function input(
  overrides: Partial<DeviceActivityContextInput> = {},
): DeviceActivityContextInput {
  return {
    enrollmentStanding: "enrolled",
    isHomeworkSession: null,
    weekday: MONDAY,
    isClosedDay: false,
    minuteOfDay: 10 * 60, // 10:00
    schoolDayWindow: DEFAULT_SCHOOL_DAY_WINDOW,
    ...overrides,
  };
}

describe("minuteOfDayFromLocalTime", () => {
  test("parses wall-clock times", () => {
    expect(minuteOfDayFromLocalTime("08:30")).toBe(510);
    expect(minuteOfDayFromLocalTime("8:05")).toBe(485);
    expect(minuteOfDayFromLocalTime("00:00")).toBe(0);
    expect(minuteOfDayFromLocalTime("23:59")).toBe(1439);
  });

  test("rejects anything that is not a wall-clock time", () => {
    expect(minuteOfDayFromLocalTime("24:00")).toBeNull();
    expect(minuteOfDayFromLocalTime("08:60")).toBeNull();
    expect(minuteOfDayFromLocalTime("half past")).toBeNull();
    expect(minuteOfDayFromLocalTime("")).toBeNull();
  });
});

describe("schoolDayWindowFromBlocks", () => {
  const blocks = [
    { startLocal: "08:30", endLocal: "09:40", weekdays: [1, 2, 3, 4, 5] },
    { startLocal: "12:00", endLocal: "12:40", weekdays: [1, 2, 3, 4, 5], kind: "lunch" },
    { startLocal: "13:00", endLocal: "14:30", weekdays: [1, 3, 5] },
  ];

  test("spans earliest start to latest end for that weekday", () => {
    expect(schoolDayWindowFromBlocks(blocks, 1)).toEqual({
      startMinute: 510,
      endMinute: 870,
    });
  });

  test("only counts blocks that run on the given weekday", () => {
    // Tuesday has no afternoon block, so the day ends at lunch.
    expect(schoolDayWindowFromBlocks(blocks, 2)).toEqual({
      startMinute: 510,
      endMinute: 760,
    });
  });

  test("ignores the virtual homework due rail", () => {
    const withHomeworkRail = [
      ...blocks,
      { startLocal: "00:00", endLocal: "23:59", weekdays: [1], kind: "homework" },
    ];
    expect(schoolDayWindowFromBlocks(withHomeworkRail, 1)).toEqual({
      startMinute: 510,
      endMinute: 870,
    });
  });

  test("returns null when nothing runs that day", () => {
    expect(schoolDayWindowFromBlocks(blocks, 6)).toBeNull();
    expect(schoolDayWindowFromBlocks([], 1)).toBeNull();
  });

  test("skips malformed and zero-length blocks", () => {
    expect(
      schoolDayWindowFromBlocks(
        [
          { startLocal: "oops", endLocal: "09:40", weekdays: [1] },
          { startLocal: "10:00", endLocal: "10:00", weekdays: [1] },
        ],
        1,
      ),
    ).toBeNull();
  });
});

describe("deriveDeviceActivityContext", () => {
  test("an ordinary Monday morning inside the bell schedule is core_day", () => {
    expect(deriveDeviceActivityContext(input())).toBe("core_day");
  });

  test("roster standing wins outright: a program guest is always extended_ed", () => {
    // Mid-core-day, mid-homework, on a closed day — standing still decides.
    expect(
      deriveDeviceActivityContext(
        input({ enrollmentStanding: "program_guest" }),
      ),
    ).toBe("extended_ed");
    expect(
      deriveDeviceActivityContext(
        input({
          enrollmentStanding: "program_guest",
          isHomeworkSession: true,
          isClosedDay: true,
          weekday: SATURDAY,
        }),
      ),
    ).toBe("extended_ed");
  });

  test("the homework flag beats the clock", () => {
    expect(
      deriveDeviceActivityContext(input({ isHomeworkSession: true })),
    ).toBe("homework");
    // Homework worked at 8pm on a Saturday is still homework.
    expect(
      deriveDeviceActivityContext(
        input({
          isHomeworkSession: true,
          weekday: SATURDAY,
          minuteOfDay: 20 * 60,
        }),
      ),
    ).toBe("homework");
  });

  test("a closed day is unknown, not core_day", () => {
    expect(deriveDeviceActivityContext(input({ isClosedDay: true }))).toBe(
      "unknown",
    );
  });

  test("weekends are unknown", () => {
    expect(deriveDeviceActivityContext(input({ weekday: SATURDAY }))).toBe(
      "unknown",
    );
    expect(deriveDeviceActivityContext(input({ weekday: 7 }))).toBe("unknown");
  });

  test("outside the school-day window is unknown, not guessed", () => {
    expect(
      deriveDeviceActivityContext(input({ minuteOfDay: 6 * 60 })),
    ).toBe("unknown");
    expect(
      deriveDeviceActivityContext(input({ minuteOfDay: 19 * 60 })),
    ).toBe("unknown");
  });

  test("the window is start-inclusive and end-exclusive", () => {
    expect(
      deriveDeviceActivityContext(
        input({ minuteOfDay: DEFAULT_SCHOOL_DAY_WINDOW.startMinute }),
      ),
    ).toBe("core_day");
    expect(
      deriveDeviceActivityContext(
        input({ minuteOfDay: DEFAULT_SCHOOL_DAY_WINDOW.endMinute }),
      ),
    ).toBe("unknown");
  });

  test("no bell schedule for the day means unknown", () => {
    expect(
      deriveDeviceActivityContext(input({ schoolDayWindow: null })),
    ).toBe("unknown");
  });

  test("an unknown homework flag does not imply classwork", () => {
    // null (nothing known) still lets the clock decide; it never forces a tag.
    expect(
      deriveDeviceActivityContext(
        input({ isHomeworkSession: null, minuteOfDay: 22 * 60 }),
      ),
    ).toBe("unknown");
    expect(
      deriveDeviceActivityContext(input({ isHomeworkSession: false })),
    ).toBe("core_day");
  });

  test("a legacy scholar with no recorded standing is treated as enrolled", () => {
    expect(
      deriveDeviceActivityContext(input({ enrollmentStanding: undefined })),
    ).toBe("core_day");
  });
});
