import { describe, it, expect } from "vitest";
import { homeworkEyebrow } from "./homeworkFraming";
import { dueStatus } from "./institutionDay";

const TZ = "Pacific/Honolulu";
const localNoon = (y: number, m: number, d: number) =>
  new Date(`${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}T12:00:00-10:00`).getTime();

describe("homeworkEyebrow", () => {
  it("names the work, the deadline, and who set it", () => {
    expect(homeworkEyebrow("due Tuesday", "Mr. Char")).toBe(
      "Homework · due Tuesday · with Mr. Char",
    );
  });

  it("carries the overdue phrase through unchanged", () => {
    expect(homeworkEyebrow("was due yesterday", "Mr. Char")).toBe(
      "Homework · was due yesterday · with Mr. Char",
    );
  });

  it("drops missing parts rather than rendering empty separators", () => {
    expect(homeworkEyebrow(null, "Mr. Char")).toBe("Homework · with Mr. Char");
    expect(homeworkEyebrow("due today", null)).toBe("Homework · due today");
    expect(homeworkEyebrow(null, null)).toBe("Homework");
    expect(homeworkEyebrow(undefined, undefined)).toBe("Homework");
    expect(homeworkEyebrow("", "")).toBe("Homework");
  });

  it("speaks the tonight list's deadline vocabulary (dueStatus, not its own)", () => {
    const now = localNoon(2026, 9, 4); // Friday
    expect(
      homeworkEyebrow(dueStatus(localNoon(2026, 9, 8), now, TZ)?.phrase, "Mr. Char"),
    ).toBe("Homework · due Tuesday · with Mr. Char");
    expect(
      homeworkEyebrow(dueStatus(localNoon(2026, 9, 3), now, TZ)?.phrase, "Mr. Char"),
    ).toBe("Homework · was due yesterday · with Mr. Char");
    expect(
      homeworkEyebrow(dueStatus(localNoon(2026, 9, 4), now, TZ)?.phrase, "Mr. Char"),
    ).toBe("Homework · due today · with Mr. Char");
  });
});
