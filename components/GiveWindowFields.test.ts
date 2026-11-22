import { describe, expect, test } from "vitest";
import { withCurrentDay } from "./GiveWindowFields";

const suggested = [
  { dayKey: "2026-11-09", label: "Tomorrow" },
  { dayKey: "2026-11-13", label: "Fri, Nov 13" },
];

describe("the finish-day picker's options", () => {
  test("a saved day outside the suggestions gets its own option, in date order", () => {
    // Editing a give due Thu on a Sunday: before, the select had no Thu
    // option and showed "Tomorrow" while saving kept Thu.
    expect(withCurrentDay(suggested, "2026-11-12")).toEqual([
      { dayKey: "2026-11-09", label: "Tomorrow" },
      { dayKey: "2026-11-12", label: "Thu, Nov 12" },
      { dayKey: "2026-11-13", label: "Fri, Nov 13" },
    ]);
  });

  test("a suggested day or no day leaves the list alone", () => {
    expect(withCurrentDay(suggested, "2026-11-13")).toBe(suggested);
    expect(withCurrentDay(suggested, "")).toBe(suggested);
  });
});
