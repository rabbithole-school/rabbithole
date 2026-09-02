import { describe, expect, test } from "vitest";
import { readingTileCaption } from "./readingTileCaption";

describe("readingTileCaption", () => {
  test("reads 'Not set yet' with no level and no history — the FTUE-H-03 repro", () => {
    // Before this fix: an empty reading tile showed "—" / "current", which
    // captions a blank value and reads as a stray word next to the
    // Engagement tile's clearer empty state.
    expect(readingTileCaption({ readingLevel: null, historyLength: 0 })).toBe("Not set yet");
  });

  test("reads 'current' when a level is set but there's under 2 history entries", () => {
    expect(readingTileCaption({ readingLevel: "3", historyLength: 0 })).toBe("current");
    expect(readingTileCaption({ readingLevel: "3", historyLength: 1 })).toBe("current");
  });

  test("reads 'current' with a single history entry even if the level itself is unset", () => {
    expect(readingTileCaption({ readingLevel: null, historyLength: 1 })).toBe("current");
  });

  test("reads 'trending' once there are 2+ history entries", () => {
    expect(readingTileCaption({ readingLevel: "4", historyLength: 2 })).toBe("trending");
    expect(readingTileCaption({ readingLevel: "4", historyLength: 5 })).toBe("trending");
  });
});
