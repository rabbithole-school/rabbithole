import { describe, expect, it } from "vitest";

import { isFrozenAt, msUntilThaw } from "../freezeMode";

describe("Freeze Mode on the iPad", () => {
  const now = Date.parse("2026-10-17T20:00:00.000Z");

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
});
