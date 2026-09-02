import { describe, expect, test } from "vitest";
import { parseRoundsWeekParam } from "@/lib/roundsCadence";

describe("parseRoundsWeekParam", () => {
  test("keeps a well-formed week key so a closed week survives navigation", () => {
    expect(parseRoundsWeekParam("2026-08-13")).toBe("2026-08-13");
  });

  test("treats an absent parameter as 'the open week'", () => {
    expect(parseRoundsWeekParam(null)).toBeNull();
    expect(parseRoundsWeekParam(undefined)).toBeNull();
    expect(parseRoundsWeekParam("")).toBeNull();
  });

  test("refuses junk rather than letting it re-point the week silently", () => {
    for (const junk of ["this-week", "2026-8-13", "2026-08-13T00:00", "../2026-08-13"]) {
      expect(parseRoundsWeekParam(junk)).toBeNull();
    }
  });
});
