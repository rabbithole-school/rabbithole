// Pure-helper tests for the Workshop's daily-block config + /meta-stream
// request/ownership validation (convex/lib/metaBlocks.ts). No convexTest — just
// inputs → output (rabbithole-test-strategy.md §1).

import { describe, expect, test } from "vitest";
import {
  dayKeyForTimezone,
  isValidHHMM,
  isValidTimeZone,
  validateDailyBlockInput,
  validateMetaStreamRequest,
  participatesInPrep,
  isWithinPrepWindow,
  formatLocalTimeLabel,
  localWeekdayAndTime,
  type DailyBlock,
} from "../lib/metaBlocks";
import {
  dayStartForTimezone,
  millisecondsUntilNextDay,
} from "../../shared/institutionDay";

const block = (over: Partial<DailyBlock> = {}): DailyBlock => ({
  key: "prepTime",
  label: "Scholar’s Prep",
  startLocal: "14:30",
  endLocal: "15:00",
  days: [1, 2, 3, 4, 5],
  timezone: "Pacific/Honolulu",
  ...over,
});

describe("dayKeyForTimezone", () => {
  test("flips at LOCAL midnight — same instant, different tz → different day", () => {
    // 2026-07-03T05:00:00Z. Honolulu (UTC-10) is still 2026-07-02 19:00;
    // Kiritimati (UTC+14) is already 2026-07-03 19:00.
    const at = new Date("2026-07-03T05:00:00Z").getTime();
    expect(dayKeyForTimezone(at, "Pacific/Honolulu")).toBe("2026-07-02");
    expect(dayKeyForTimezone(at, "Pacific/Kiritimati")).toBe("2026-07-03");
  });

  test("formats as zero-padded YYYY-MM-DD", () => {
    const at = new Date("2026-01-05T12:00:00Z").getTime();
    expect(dayKeyForTimezone(at, "Pacific/Honolulu")).toBe("2026-01-05");
  });

  test("finds local midnight without assuming a fixed UTC offset", () => {
    const honoluluNoon = new Date("2026-07-03T22:00:00Z").getTime();
    expect(dayStartForTimezone(honoluluNoon, "Pacific/Honolulu")).toBe(
      new Date("2026-07-03T10:00:00Z").getTime(),
    );

    const newYorkDstDay = new Date("2026-03-08T12:00:00Z").getTime();
    expect(dayStartForTimezone(newYorkDstDay, "America/New_York")).toBe(
      new Date("2026-03-08T05:00:00Z").getTime(),
    );
    expect(
      millisecondsUntilNextDay(newYorkDstDay, "America/New_York"),
    ).toBe(new Date("2026-03-09T04:00:01Z").getTime() - newYorkDstDay);
  });
});

describe("isValidHHMM", () => {
  test.each(["00:00", "09:05", "14:30", "23:59"])("accepts %s", (s) => {
    expect(isValidHHMM(s)).toBe(true);
  });
  test.each(["24:00", "9:00", "14:60", "1430", "2:5", "", "aa:bb"])(
    "rejects %s",
    (s) => {
      expect(isValidHHMM(s)).toBe(false);
    },
  );
});

describe("isValidTimeZone", () => {
  test("accepts real IANA names", () => {
    expect(isValidTimeZone("Pacific/Honolulu")).toBe(true);
    expect(isValidTimeZone("America/New_York")).toBe(true);
    expect(isValidTimeZone("UTC")).toBe(true);
  });
  test("rejects junk", () => {
    expect(isValidTimeZone("Mars/Olympus_Mons")).toBe(false);
    expect(isValidTimeZone("")).toBe(false);
  });
});

describe("validateDailyBlockInput", () => {
  test("valid input → null", () => {
    expect(
      validateDailyBlockInput({
        startLocal: "14:30",
        endLocal: "15:00",
        days: [1, 2, 3, 4, 5],
        timezone: "Pacific/Honolulu",
      }),
    ).toBeNull();
  });
  test("bad startLocal", () => {
    expect(
      validateDailyBlockInput({
        startLocal: "2:30pm",
        endLocal: "15:00",
        days: [1],
        timezone: "Pacific/Honolulu",
      }),
    ).toMatch(/startLocal/);
  });
  test.each([
    ["15:00", "15:00"],
    ["15:00", "14:30"],
  ])("endLocal must be after startLocal (%s → %s)", (startLocal, endLocal) => {
    expect(
      validateDailyBlockInput({
        startLocal,
        endLocal,
        days: [1],
        timezone: "Pacific/Honolulu",
      }),
    ).toMatch(/after startLocal/);
  });
  test("empty days", () => {
    expect(
      validateDailyBlockInput({
        startLocal: "14:30",
        endLocal: "15:00",
        days: [],
        timezone: "Pacific/Honolulu",
      }),
    ).toMatch(/at least one weekday/);
  });
  test("days out of 1..7", () => {
    expect(
      validateDailyBlockInput({
        startLocal: "14:30",
        endLocal: "15:00",
        days: [0, 8],
        timezone: "Pacific/Honolulu",
      }),
    ).toMatch(/1\.\.7/);
  });
  test("bad timezone", () => {
    expect(
      validateDailyBlockInput({
        startLocal: "14:30",
        endLocal: "15:00",
        days: [1],
        timezone: "Nowhere/Nope",
      }),
    ).toMatch(/IANA/);
  });
});

describe("participatesInPrep", () => {
  test("true when any group carries a prepTime entry (Move 5: presence = participation)", () => {
    expect(
      participatesInPrep([
        { dailyBlocks: [] },
        { dailyBlocks: [block({ key: "lunch" })] },
        { dailyBlocks: [block()] },
      ]),
    ).toBe(true);
  });
  test("false when no group runs the ritual", () => {
    expect(participatesInPrep([{}, { dailyBlocks: [] }])).toBe(false);
    expect(
      participatesInPrep([{ dailyBlocks: [block({ key: "lunch" })] }]),
    ).toBe(false);
  });
});

describe("validateMetaStreamRequest", () => {
  const base = {
    callerUserId: "user1",
    chatId: "chat1",
    assistantMsgId: "msg1",
    chatScholarId: "user1",
    assistantChatId: "chat1",
    assistantRole: "assistant",
  };

  test("ok when everything lines up", () => {
    expect(validateMetaStreamRequest(base)).toEqual({ ok: true });
  });
  test("401 when unauthenticated", () => {
    expect(validateMetaStreamRequest({ ...base, callerUserId: null })).toEqual({
      ok: false,
      status: 401,
      error: "Not authenticated",
    });
  });
  test("400 when chatId missing", () => {
    expect(
      validateMetaStreamRequest({ ...base, chatId: undefined }),
    ).toMatchObject({ ok: false, status: 400 });
  });
  test("400 when assistantMsgId missing", () => {
    expect(
      validateMetaStreamRequest({ ...base, assistantMsgId: "" }),
    ).toMatchObject({ ok: false, status: 400 });
  });
  test("404 when chat missing", () => {
    expect(
      validateMetaStreamRequest({ ...base, chatScholarId: null }),
    ).toMatchObject({ ok: false, status: 404 });
  });
  test("403 when the chat belongs to another scholar", () => {
    expect(
      validateMetaStreamRequest({ ...base, chatScholarId: "user2" }),
    ).toMatchObject({ ok: false, status: 403 });
  });
  test("404 when the assistant message is missing", () => {
    expect(
      validateMetaStreamRequest({ ...base, assistantChatId: null }),
    ).toMatchObject({ ok: false, status: 404 });
  });
  test("403 when the assistant message belongs to a different chat", () => {
    expect(
      validateMetaStreamRequest({ ...base, assistantChatId: "chatX" }),
    ).toMatchObject({ ok: false, status: 403 });
  });
  test("400 when the target row is not an assistant message", () => {
    expect(
      validateMetaStreamRequest({ ...base, assistantRole: "user" }),
    ).toMatchObject({ ok: false, status: 400 });
  });
});

// A Friday 2:45 PM Honolulu instant, inside a 14:30–15:00 Mon–Fri window.
// 2026-07-03 is a Friday. 14:45 HST = 00:45 UTC on 2026-07-04.
const FRI_1445_HST = new Date("2026-07-04T00:45:00Z").getTime();
// Same day, 15:30 HST (after the window) = 01:30 UTC 2026-07-04.
const FRI_1530_HST = new Date("2026-07-04T01:30:00Z").getTime();
// 2026-07-04 is a Saturday; 14:45 HST = 00:45 UTC 2026-07-05.
const SAT_1445_HST = new Date("2026-07-05T00:45:00Z").getTime();

describe("localWeekdayAndTime", () => {
  test("resolves ISO weekday (1=Mon…7=Sun) + HH:MM in the tz", () => {
    const { isoWeekday, hhmm } = localWeekdayAndTime(FRI_1445_HST, "Pacific/Honolulu");
    expect(isoWeekday).toBe(5); // Friday
    expect(hhmm).toBe("14:45");
  });

  test("Sunday resolves to 7", () => {
    // 2026-07-05 is a Sunday; noon HST = 22:00 UTC.
    const sunNoon = new Date("2026-07-05T22:00:00Z").getTime();
    expect(localWeekdayAndTime(sunNoon, "Pacific/Honolulu").isoWeekday).toBe(7);
  });
});

describe("isWithinPrepWindow", () => {
  test("true inside the window on an allowed day", () => {
    expect(isWithinPrepWindow(block(), FRI_1445_HST)).toBe(true);
  });

  test("false after the window ends (end is exclusive)", () => {
    expect(isWithinPrepWindow(block(), FRI_1530_HST)).toBe(false);
    // Exactly at endLocal → excluded.
    const at1500 = new Date("2026-07-04T01:00:00Z").getTime(); // 15:00 HST
    expect(isWithinPrepWindow(block(), at1500)).toBe(false);
  });

  test("true exactly at startLocal (start is inclusive)", () => {
    const at1430 = new Date("2026-07-04T00:30:00Z").getTime(); // 14:30 HST
    expect(isWithinPrepWindow(block(), at1430)).toBe(true);
  });

  test("false on a day not in the allowed set (Sat)", () => {
    expect(isWithinPrepWindow(block(), SAT_1445_HST)).toBe(false);
  });

  test("false for a misconfigured window (end <= start)", () => {
    expect(
      isWithinPrepWindow(block({ startLocal: "15:00", endLocal: "14:30" }), FRI_1445_HST),
    ).toBe(false);
  });

  test("respects the block's own timezone, not the host's", () => {
    // 14:45 in Honolulu is NOT 14:45 in New York — a NY block wouldn't be open.
    expect(
      isWithinPrepWindow(block({ timezone: "America/New_York" }), FRI_1445_HST),
    ).toBe(false);
  });
});

describe("formatLocalTimeLabel", () => {
  test.each([
    ["14:30", "2:30 PM"],
    ["15:00", "3:00 PM"],
    ["00:05", "12:05 AM"],
    ["09:00", "9:00 AM"],
    ["12:00", "12:00 PM"],
    ["23:59", "11:59 PM"],
  ])("%s → %s", (input, expected) => {
    expect(formatLocalTimeLabel(input)).toBe(expected);
  });

  test("passes through an invalid string unchanged", () => {
    expect(formatLocalTimeLabel("nope")).toBe("nope");
  });
});
