import { describe, expect, it } from "vitest";

import {
  FLAIR_MOTION,
  flairArrivingIds,
  flairChipDelayMs,
  flairNoticeDelayMs,
  flairStaggerIndex,
} from "./flairMotion";

describe("flair motion constants", () => {
  it("derives the chip delay from the beat it is made of", () => {
    // Not a chosen number: emoji settle + the stillness that makes the chip read
    // as caused + the lead the deliverable transaction has on the message one.
    expect(FLAIR_MOTION.chipEnterDelayMs).toBe(
      FLAIR_MOTION.noticeEmojiMs +
        FLAIR_MOTION.handoffGapMs +
        FLAIR_MOTION.chipLeadAllowanceMs,
    );
    expect(FLAIR_MOTION.chipEnterDelayMs).toBe(460);
  });

  it("keeps every motion inside the reviewed bounds", () => {
    expect(FLAIR_MOTION.noticeRiseMs).toBeGreaterThanOrEqual(180);
    expect(FLAIR_MOTION.noticeRiseMs).toBeLessThanOrEqual(260);
    expect(FLAIR_MOTION.noticeEmojiMs).toBeGreaterThanOrEqual(240);
    expect(FLAIR_MOTION.noticeEmojiMs).toBeLessThanOrEqual(320);
    expect(FLAIR_MOTION.handoffGapMs).toBeGreaterThanOrEqual(100);
    expect(FLAIR_MOTION.handoffGapMs).toBeLessThanOrEqual(160);
  });
});

describe("flairStaggerIndex", () => {
  it("caps so a big batch is no longer than a four-award one", () => {
    expect(flairStaggerIndex(0)).toBe(0);
    expect(flairStaggerIndex(3)).toBe(3);
    expect(flairStaggerIndex(4)).toBe(FLAIR_MOTION.maxStaggerIndex);
    expect(flairStaggerIndex(9)).toBe(FLAIR_MOTION.maxStaggerIndex);
  });

  it("never returns a negative slot for a not-arriving index", () => {
    expect(flairStaggerIndex(-1)).toBe(0);
    expect(flairStaggerIndex(Number.NaN)).toBe(0);
  });
});

describe("stagger delays", () => {
  it("staggers a notice batch and then stops", () => {
    expect(flairNoticeDelayMs(0)).toBe(0);
    expect(flairNoticeDelayMs(2)).toBe(180);
    expect(flairNoticeDelayMs(9)).toBe(flairNoticeDelayMs(3));
  });

  it("starts every chip from the same fixed beat", () => {
    expect(flairChipDelayMs(0)).toBe(460);
    expect(flairChipDelayMs(1)).toBe(540);
    expect(flairChipDelayMs(9)).toBe(flairChipDelayMs(3));
  });

  it("keeps a six-award batch's last chip inside the ceremony budget", () => {
    // Award 6 shares award 4's slot, so the last entrance still starts at 700ms
    // and the whole thing settles around a second.
    expect(flairChipDelayMs(5)).toBe(700);
    expect(flairChipDelayMs(5) + 320).toBeLessThanOrEqual(1100);
  });
});

describe("flairArrivingIds", () => {
  it("animates nothing while the query is unresolved", () => {
    expect(flairArrivingIds(null, undefined)).toEqual([]);
    expect(flairArrivingIds(new Set(["a"]), undefined)).toEqual([]);
  });

  it("animates nothing on a surface's first resolved snapshot", () => {
    // Opening a session that already has flair, on either surface.
    expect(flairArrivingIds(null, ["a", "b"])).toEqual([]);
    // …and a resolved deliverable that has simply never earned any.
    expect(flairArrivingIds(null, [])).toEqual([]);
  });

  it("animates the first award on a deliverable with an empty baseline", () => {
    expect(flairArrivingIds(new Set(), ["a"])).toEqual(["a"]);
  });

  it("animates only the delta of a successive award", () => {
    expect(flairArrivingIds(new Set(["a"]), ["a", "b"])).toEqual(["b"]);
    expect(flairArrivingIds(new Set(["a", "b"]), ["a", "b", "c"])).toEqual(["c"]);
  });

  it("animates nothing when a reconnect replays the same ids", () => {
    expect(flairArrivingIds(new Set(["a", "b"]), ["a", "b"])).toEqual([]);
  });

  it("keeps a batch in display order so the stagger follows the verdict order", () => {
    expect(flairArrivingIds(new Set(["a"]), ["a", "b", "c"])).toEqual(["b", "c"]);
  });
});
