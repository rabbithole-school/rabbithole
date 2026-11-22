import { describe, expect, it } from "vitest";

import {
  formatThawTime,
  freezeCopy,
  isFrozenAt,
  msUntilThaw,
} from "../freezeMode";

describe("Freeze Mode on the iPad", () => {
  const now = Date.parse("2026-10-17T20:00:00.000Z");

  it("names the day only when the freeze ends on a later one", () => {
    const local = (day: number, hour: number) =>
      new Date(2026, 9, day, hour).getTime();
    const today = formatThawTime(local(17, 15), local(17, 9));
    expect(today).not.toContain(" at ");
    expect(formatThawTime(local(20, 8), local(17, 9))).toBe(
      `Tuesday at ${formatThawTime(local(20, 8), local(20, 7))}`,
    );
  });

  it("is frozen only before the boundary", () => {
    expect(isFrozenAt(now + 1, now)).toBe(true);
    expect(isFrozenAt(now, now)).toBe(false);
    expect(isFrozenAt(now - 1, now)).toBe(false);
  });

  it("is not frozen without a boundary", () => {
    expect(isFrozenAt(null, now)).toBe(false);
    expect(isFrozenAt(undefined, now)).toBe(false);
  });

  it("schedules the thaw for the remaining time only while frozen", () => {
    expect(msUntilThaw(now + 90_000, now)).toBe(90_000);
    expect(msUntilThaw(now - 1, now)).toBeNull();
    expect(msUntilThaw(null, now)).toBeNull();
  });

  it("tells a scholar to ask their parent only for a family freeze", () => {
    expect(freezeCopy("family", "3:00 PM")).toMatchObject({
      title: "This BunnyPad is frozen until 3:00 PM",
      body: "Ask your parent.",
    });
    for (const by of ["school", null, undefined] as const) {
      expect(freezeCopy(by, "3:00 PM").body).toBe(
        "Ask a teacher to unfreeze it.",
      );
    }
  });
});
