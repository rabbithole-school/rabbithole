import { describe, expect, test } from "vitest";
import { budgetWindowKeys } from "../lib/simulatorRunBudget";

describe("budgetWindowKeys", () => {
  test("keeps the explicit Honolulu legacy default", () => {
    const now = Date.parse("2026-07-06T09:30:00.000Z"); // Sunday 23:30 HST
    expect(budgetWindowKeys(now, "a")).toEqual({
      blockKey: "a:2026-07-05:block-11",
      weekKey: "a:week-2026-06-29",
    });
  });

  test("uses New York local date, block, and DST-stable Monday", () => {
    const beforeMonday = Date.parse("2026-03-09T03:30:00.000Z");
    expect(
      budgetWindowKeys(beforeMonday, "a", "America/New_York"),
    ).toEqual({
      blockKey: "a:2026-03-08:block-11",
      weekKey: "a:week-2026-03-02",
    });

    const afterMonday = Date.parse("2026-03-09T04:30:00.000Z");
    expect(
      budgetWindowKeys(afterMonday, "a", "America/New_York"),
    ).toEqual({
      blockKey: "a:2026-03-09:block-0",
      weekKey: "a:week-2026-03-09",
    });
  });
});
