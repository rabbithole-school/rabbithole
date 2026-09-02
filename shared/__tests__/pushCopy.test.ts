import { describe, expect, it } from "vitest";
import {
  pushActionLabel,
  pushGlyph,
  pushSummaryLine,
  pushTimeLeftLabel,
} from "../pushCopy";

describe("pushTimeLeftLabel", () => {
  const now = 1_000_000;

  it("is null when the push is open-ended", () => {
    expect(pushTimeLeftLabel(null, now)).toBeNull();
  });

  it("is null once the window has closed", () => {
    expect(pushTimeLeftLabel(now, now)).toBeNull();
    expect(pushTimeLeftLabel(now - 1, now)).toBeNull();
  });

  it("rounds UP so the card never outlives its own countdown", () => {
    // 20 seconds left must not read "0 min left".
    expect(pushTimeLeftLabel(now + 20_000, now)).toBe("Less than a minute left");
    // 18m01s reads 19, not 18 — erring toward the card still being there.
    expect(pushTimeLeftLabel(now + 18 * 60_000 + 1_000, now)).toBe("19 min left");
  });

  it("reads in minutes below an hour", () => {
    expect(pushTimeLeftLabel(now + 20 * 60_000, now)).toBe("20 min left");
    expect(pushTimeLeftLabel(now + 59 * 60_000, now)).toBe("59 min left");
  });

  it("reads in hours at and above an hour", () => {
    expect(pushTimeLeftLabel(now + 60 * 60_000, now)).toBe("1 hr left");
    expect(pushTimeLeftLabel(now + 90 * 60_000, now)).toBe("1 hr 30 min left");
    expect(pushTimeLeftLabel(now + 120 * 60_000, now)).toBe("2 hr left");
  });
});

describe("pushGlyph", () => {
  it("takes the glyph from the target, never from the note", () => {
    expect(pushGlyph({ kind: "app" })).toBe("▶");
    expect(pushGlyph({ kind: "activity" })).toBe("✎");
    expect(pushGlyph({ kind: "resource" })).toBe("◈");
  });

  it("distinguishes a video link from a plain link", () => {
    expect(pushGlyph({ kind: "link", media: "video" })).toBe("▶");
    expect(pushGlyph({ kind: "link", media: "page" })).toBe("↗");
    expect(pushGlyph({ kind: "link" })).toBe("↗");
  });
});

describe("pushActionLabel", () => {
  it("names the action for each target", () => {
    expect(pushActionLabel({ kind: "app" })).toBe("Open");
    expect(pushActionLabel({ kind: "activity" })).toBe("Start");
    expect(pushActionLabel({ kind: "resource" })).toBe("Open");
    expect(pushActionLabel({ kind: "link", media: "video" })).toBe("Watch");
    expect(pushActionLabel({ kind: "link", media: "page" })).toBe("Open");
  });
});

describe("pushSummaryLine", () => {
  it("reads as a sentence, not a row of fields", () => {
    expect(
      pushSummaryLine({
        title: "Blue Planet: Coral Seas",
        audienceLabel: "Geckos",
        minutes: 20,
      }),
    ).toBe("Blue Planet: Coral Seas → Geckos, for 20 min");
  });
});
