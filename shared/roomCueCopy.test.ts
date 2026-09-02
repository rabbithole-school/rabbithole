import { describe, it, expect } from "vitest";
import {
  formatReturnAtClock,
  restSubline,
  roomCueBannerText,
  pickCuesByKind,
  REST_HEADLINE,
  type RoomCueForDisplay,
} from "./roomCueCopy";

describe("formatReturnAtClock", () => {
  it("formats a plain afternoon time with no leading zero or AM/PM", () => {
    const d = new Date(2026, 0, 1, 13, 15); // 1:15 PM local
    expect(formatReturnAtClock(d.getTime())).toBe("1:15");
  });

  it("formats midnight and noon as 12", () => {
    expect(formatReturnAtClock(new Date(2026, 0, 1, 0, 5).getTime())).toBe("12:05");
    expect(formatReturnAtClock(new Date(2026, 0, 1, 12, 0).getTime())).toBe("12:00");
  });

  it("pads single-digit minutes", () => {
    expect(formatReturnAtClock(new Date(2026, 0, 1, 9, 5).getTime())).toBe("9:05");
  });
});

describe("restSubline", () => {
  it("returns null when no return time is set", () => {
    expect(restSubline(null)).toBeNull();
  });

  it("reads 'Eyes up — back at <time>' when a return time is set", () => {
    const t = new Date(2026, 0, 1, 13, 15).getTime();
    expect(restSubline(t)).toBe("Eyes up — back at 1:15");
  });
});

describe("roomCueBannerText", () => {
  it("attributes the teacher's words verbatim with a speaker emoji", () => {
    expect(
      roomCueBannerText({
        cueId: "c1",
        kind: "message",
        body: "Clean up in two minutes — then we're on the rug.",
        returnAt: null,
        authorName: "Ms. K",
      }),
    ).toBe("📣 Ms. K: Clean up in two minutes — then we're on the rug.");
  });

  it("trims surrounding whitespace on the body", () => {
    expect(
      roomCueBannerText({
        cueId: "c2",
        kind: "transition",
        body: "  We're moving to the rug now.  ",
        returnAt: null,
        authorName: "Mr. B",
      }),
    ).toBe("📣 Mr. B: We're moving to the rug now.");
  });
});

describe("REST_HEADLINE", () => {
  it("is the fixed, non-authored rest chrome", () => {
    expect(REST_HEADLINE).toBe("🌙 Screens resting");
  });
});

describe("pickCuesByKind", () => {
  const message: RoomCueForDisplay = {
    cueId: "m1",
    kind: "message",
    body: "hi",
    returnAt: null,
    authorName: "Ms. K",
  };
  const transition: RoomCueForDisplay = {
    cueId: "t1",
    kind: "transition",
    body: "moving on",
    returnAt: null,
    authorName: "Ms. K",
  };
  const rest: RoomCueForDisplay = {
    cueId: "r1",
    kind: "rest",
    body: null,
    returnAt: 123,
    authorName: "Ms. K",
  };

  it("returns one cue per kind when none are dismissed", () => {
    const picked = pickCuesByKind([message, transition, rest], new Set());
    expect(picked.message?.cueId).toBe("m1");
    expect(picked.transition?.cueId).toBe("t1");
    expect(picked.rest?.cueId).toBe("r1");
  });

  it("hides a locally-dismissed message/transition", () => {
    const picked = pickCuesByKind([message, transition, rest], new Set(["m1"]));
    expect(picked.message).toBeNull();
    expect(picked.transition?.cueId).toBe("t1");
  });

  it("never hides rest for a local dismissal — only a server clear can", () => {
    const picked = pickCuesByKind([rest], new Set(["r1"]));
    expect(picked.rest?.cueId).toBe("r1");
  });

  it("handles an undefined (not-yet-loaded) cue list", () => {
    const picked = pickCuesByKind(undefined, new Set());
    expect(picked).toEqual({ message: null, transition: null, rest: null });
  });
});
