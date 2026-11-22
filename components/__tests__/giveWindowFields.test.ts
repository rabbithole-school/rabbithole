import { describe, expect, test } from "vitest";
import {
  parseSchoolInputValue,
  schoolInputValue,
} from "@/components/GiveWindowFields";

// A custom "shows up" time is typed on the SCHOOL's clock, whatever zone the
// teacher's browser is in (TRA-571 review #12). Instants are written out in
// UTC by hand: Honolulu is UTC-10 with no DST.
describe("custom give times use the school's time zone", () => {
  const ZONE = "Pacific/Honolulu";
  const TUE_0930_HST = Date.UTC(2026, 10, 10, 19, 30);

  test("formats an instant as school-local wall time", () => {
    expect(schoolInputValue(TUE_0930_HST, ZONE)).toBe("2026-11-10T09:30");
  });

  test("parses school-local wall time back to the same instant", () => {
    expect(parseSchoolInputValue("2026-11-10T09:30", ZONE)).toBe(TUE_0930_HST);
  });

  test("a different school zone moves the instant, not the wall time", () => {
    // 09:30 in New York on Nov 10 (EST, UTC-5).
    expect(parseSchoolInputValue("2026-11-10T09:30", "America/New_York")).toBe(
      Date.UTC(2026, 10, 10, 14, 30),
    );
  });

  test("rejects a malformed value", () => {
    expect(parseSchoolInputValue("tomorrow", ZONE)).toBeNull();
  });
});
