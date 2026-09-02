import { describe, expect, test, vi } from "vitest";
import { isScholarInSchoolDay, isWithinSchoolDay } from "../lib/schoolDay";
import type { SchoolDayBlock } from "../lib/schoolDay";
import type { Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";

// Pure unit tests for the school-day predicate (no convexTest / no DB). The gate
// that gates the tutor's physical inventory to the school day is derived entirely
// from these bell-block windows, so this is the load-bearing logic to pin.
//
// All instants are built as explicit UTC epoch-ms. Pacific/Honolulu is HST =
// UTC-10 year-round (no DST), so an HST wall-clock time H:M on a given calendar
// day is simply UTC hour (H+10). Real calendar weekdays (verified):
//   2026-07-15 → Wednesday, 2026-07-18 → Saturday.
const HNL = "Pacific/Honolulu";

/** UTC epoch-ms for a Honolulu wall-clock time (HST = UTC-10, no DST). */
function hst(day: number, hour: number, minute = 0): number {
  return Date.UTC(2026, 6, day, hour + 10, minute); // month index 6 = July
}

const WEEKDAYS: SchoolDayBlock = {
  startLocal: "08:00",
  endLocal: "15:00",
  weekdays: [1, 2, 3, 4, 5], // Mon–Fri (ISO)
};

describe("isWithinSchoolDay", () => {
  test("in-window: Wednesday 10:00 HST → true", () => {
    expect(isWithinSchoolDay([WEEKDAYS], HNL, hst(15, 10, 0))).toBe(true);
  });

  test("before first block: Wednesday 07:00 HST → false", () => {
    expect(isWithinSchoolDay([WEEKDAYS], HNL, hst(15, 7, 0))).toBe(false);
  });

  test("after last block: Wednesday 15:30 HST → false", () => {
    expect(isWithinSchoolDay([WEEKDAYS], HNL, hst(15, 15, 30))).toBe(false);
  });

  test("exactly at start (08:00 HST) → true", () => {
    expect(isWithinSchoolDay([WEEKDAYS], HNL, hst(15, 8, 0))).toBe(true);
  });

  test("exactly at end (15:00 HST) → false (half-open [start, end))", () => {
    expect(isWithinSchoolDay([WEEKDAYS], HNL, hst(15, 15, 0))).toBe(false);
  });

  test("weekend (no block for today): Saturday 10:00 HST → false (fail closed)", () => {
    // 2026-07-18 is a Saturday; the block only covers Mon–Fri.
    expect(isWithinSchoolDay([WEEKDAYS], HNL, hst(18, 10, 0))).toBe(false);
  });

  test("empty blocks array → false (fail closed)", () => {
    expect(isWithinSchoolDay([], HNL, hst(15, 10, 0))).toBe(false);
  });

  test("multiple blocks → span is min(start)…max(end) (coarse whole-day)", () => {
    // Two disjoint periods 08:00–09:00 and 13:00–15:00. 09:30 falls in the GAP
    // between them, but the gate is intentionally a COARSE "school is in session"
    // whole-day span [earliest start, latest end) = [08:00, 15:00) — NOT
    // per-period — so 09:30 is inside the school day.
    const blocks: SchoolDayBlock[] = [
      { startLocal: "08:00", endLocal: "09:00", weekdays: [1, 2, 3, 4, 5] },
      { startLocal: "13:00", endLocal: "15:00", weekdays: [1, 2, 3, 4, 5] },
    ];
    expect(isWithinSchoolDay(blocks, HNL, hst(15, 9, 30))).toBe(true);
  });

  test("timezone is honored: same instant is in-window HST but out-of-window ET", () => {
    // Wednesday 10:00 HST == 20:00 UTC == 16:00 EDT (America/New_York, UTC-4 in
    // July). Same block+instant: 10:00 is inside [08:00, 15:00) in Honolulu, but
    // the equivalent New York wall time 16:00 is AFTER 15:00 → out of window.
    const instant = hst(15, 10, 0);
    expect(isWithinSchoolDay([WEEKDAYS], HNL, instant)).toBe(true);
    expect(isWithinSchoolDay([WEEKDAYS], "America/New_York", instant)).toBe(
      false,
    );
  });

  test("New York preserves local start/end boundaries across the EST-to-EDT transition", () => {
    const ny = "America/New_York";
    // Friday before DST: 13:00 UTC = 08:00 EST; 20:00 UTC = 15:00 EST.
    expect(isWithinSchoolDay([WEEKDAYS], ny, Date.UTC(2026, 2, 6, 13))).toBe(true);
    expect(isWithinSchoolDay([WEEKDAYS], ny, Date.UTC(2026, 2, 6, 20))).toBe(false);
    // Monday after DST: 12:00 UTC = 08:00 EDT; 19:00 UTC = 15:00 EDT.
    expect(isWithinSchoolDay([WEEKDAYS], ny, Date.UTC(2026, 2, 9, 12))).toBe(true);
    expect(isWithinSchoolDay([WEEKDAYS], ny, Date.UTC(2026, 2, 9, 19))).toBe(false);
  });
});

describe("isScholarInSchoolDay", () => {
  test("loads the scholar and institution once, then uses the lightweight period/block query seam", async () => {
    const scholarId = "scholar" as Id<"users">;
    const institutionId = "institution" as Id<"institutions">;
    const periodId = "period" as Id<"reportingPeriods">;
    const get = vi.fn(async (id: Id<"users"> | Id<"institutions">) => {
      if (id === scholarId) {
        return { _id: scholarId, institutionId };
      }
      if (id === institutionId) {
        return { _id: institutionId, timeZone: HNL };
      }
      return null;
    });
    const scopedPeriodCollect = vi.fn(async () => [
      {
        _id: periodId,
        _creationTime: 1,
        status: "open" as const,
        institutionId,
      },
    ]);
    const globalPeriodCollect = vi.fn(async () => []);
    const scopedPeriodOrder = vi.fn(() => ({ collect: scopedPeriodCollect }));
    const globalPeriodOrder = vi.fn(() => ({ collect: globalPeriodCollect }));
    const reportingWithIndex = vi
      .fn()
      .mockReturnValueOnce({ order: scopedPeriodOrder })
      .mockReturnValueOnce({ order: globalPeriodOrder });
    const blockCollect = vi.fn(async () => [
      { startLocal: "00:00", endLocal: "23:59", weekdays: [1, 2, 3, 4, 5, 6, 7] },
    ]);
    const scheduleBlocksWithIndex = vi.fn(() => ({ collect: blockCollect }));
    const query = vi.fn((table: string) => {
      if (table === "reportingPeriods") {
        return { withIndex: reportingWithIndex };
      }
      if (table === "scheduleBlocks") {
        return { withIndex: scheduleBlocksWithIndex };
      }
      throw new Error(`Unexpected table: ${table}`);
    });
    const ctx = { db: { get, query } } as unknown as QueryCtx;

    await expect(isScholarInSchoolDay(ctx, scholarId, hst(15, 10))).resolves.toBe(
      true,
    );

    expect(get).toHaveBeenCalledTimes(2);
    expect(get).toHaveBeenNthCalledWith(1, scholarId);
    expect(get).toHaveBeenNthCalledWith(2, institutionId);
    expect(query).toHaveBeenNthCalledWith(1, "reportingPeriods");
    expect(query).toHaveBeenNthCalledWith(2, "reportingPeriods");
    expect(reportingWithIndex).toHaveBeenCalledTimes(2);
    expect(reportingWithIndex).toHaveBeenNthCalledWith(
      1,
      "by_institution",
      expect.any(Function),
    );
    expect(reportingWithIndex).toHaveBeenNthCalledWith(
      2,
      "by_institution",
      expect.any(Function),
    );
    expect(scopedPeriodOrder).toHaveBeenCalledWith("asc");
    expect(globalPeriodOrder).toHaveBeenCalledWith("asc");
    expect(scopedPeriodCollect).toHaveBeenCalledTimes(1);
    expect(globalPeriodCollect).toHaveBeenCalledTimes(1);
    expect(query).toHaveBeenNthCalledWith(3, "scheduleBlocks");
    expect(scheduleBlocksWithIndex).toHaveBeenCalledTimes(1);
    expect(scheduleBlocksWithIndex).toHaveBeenCalledWith(
      "by_period",
      expect.any(Function),
    );
    expect(blockCollect).toHaveBeenCalledTimes(1);
  });
});
