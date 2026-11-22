import { describe, expect, it } from "vitest";

import type { HeadPoseFrame } from "../../modules/facing-room";
import {
  decodeFacing,
  DEFAULT_FACING_ZONE,
  encodeFacing,
  FACING_FRAME_MS,
  headNow,
  nudgeToward,
  observeFacing,
  readFacing,
  shiftFacing,
  type FacingRead,
} from "./facingRoom";
import type { SlideRun } from "./rehearsalTake";

const MS = FACING_FRAME_MS;
/** `seconds` of frames, 4 a second. */
const span = (seconds: number, frame: HeadPoseFrame): HeadPoseFrame[] =>
  Array.from({ length: Math.round((seconds * 1000) / MS) }, () => frame);
/** Facing the room, with the small wobble of real presenting. */
const facing = (seconds: number, yaw = 3, pitch = -5): HeadPoseFrame[] =>
  span(seconds, null).map((_, i) => [yaw + 6 * Math.sin(i), pitch + 3 * Math.cos(i * 1.7), 55]);

describe("encodeFacing / decodeFacing", () => {
  it("round-trips whole degrees and missing faces", () => {
    const frames: HeadPoseFrame[] = [[12.4, -4.6, 55.2], null, [-3, 2, 54]];
    expect(decodeFacing(encodeFacing(frames))).toEqual([[12, -5, 55], null, [-3, 2, 54]]);
    expect(encodeFacing(frames)).toBe("12,-5,55;;-3,2,54");
  });

  it("reads an empty trace as no frames", () => {
    expect(decodeFacing("")).toEqual([]);
  });
});

describe("readFacing", () => {
  it("marks nothing while the presenter faces the room", () => {
    expect(readFacing(facing(30), MS)).toEqual({ kind: "seen", away: [] });
  });

  it("marks a turn of 2 seconds or more, with its bounds", () => {
    const frames = [...facing(10), ...span(3, [55, -8, 50]), ...facing(10)];
    expect(readFacing(frames, MS)).toEqual({
      kind: "seen",
      away: [{ fromMs: 10_000, toMs: 13_000, kind: "turned" }],
    });
  });

  it("ignores a one-second glance", () => {
    const frames = [...facing(10), ...span(1, [55, -8, 50]), ...facing(10)];
    expect(readFacing(frames, MS)).toEqual({ kind: "seen", away: [] });
  });

  it("joins two looks away split by a short look back", () => {
    const frames = [...facing(10), ...span(1.5, [55, 0, 50]), ...facing(0.25), ...span(1.5, [55, 0, 50]), ...facing(10)];
    expect(readFacing(frames, MS)).toEqual({
      kind: "seen",
      away: [{ fromMs: 10_000, toMs: 13_250, kind: "turned" }],
    });
  });

  it("marks looking down from the presenter's usual tilt", () => {
    const frames = [...facing(10), ...span(3, [2, 22, 55]), ...facing(10)];
    expect(readFacing(frames, MS)).toEqual({
      kind: "seen",
      away: [{ fromMs: 10_000, toMs: 13_000, kind: "down" }],
    });
  });

  it("counts no face as turned away (to the screen behind, or out of the picture)", () => {
    const frames = [...facing(10), ...span(4, null), ...facing(10)];
    expect(readFacing(frames, MS)).toEqual({
      kind: "seen",
      away: [{ fromMs: 10_000, toMs: 14_000, kind: "turned" }],
    });
  });

  it("measures from the BunnyPad, so a habit doesn't become facing the room", () => {
    // Reading the slides off a TV 45° away for most of the take.
    const frames = [...facing(5), ...span(20, [45, 0, 50]), ...facing(5)];
    expect(readFacing(frames, MS)).toEqual({
      kind: "seen",
      away: [{ fromMs: 5_000, toMs: 25_000, kind: "turned" }],
    });
  });

  it("measures from a moved zone for a BunnyPad set off to one side", () => {
    const zone = { ...DEFAULT_FACING_ZONE, centerYaw: 25 };
    const toTheSide = [...facing(10, 25), ...span(3, [28, -5, 55]), ...facing(10, 25)];
    expect(readFacing(toTheSide, MS, zone)).toEqual({ kind: "seen", away: [] });
    const turnedBack = [...facing(10, 25), ...span(3, [-20, -5, 55]), ...facing(10, 25)];
    expect(readFacing(turnedBack, MS, zone)).toEqual({
      kind: "seen",
      away: [{ fromMs: 10_000, toMs: 13_000, kind: "turned" }],
    });
  });

  it("can't say when it rarely saw a face", () => {
    const frames = [...facing(5), ...span(20, null)];
    expect(readFacing(frames, MS)).toEqual({ kind: "unseen" });
    expect(readFacing([], MS)).toEqual({ kind: "unseen" });
  });
});

describe("shiftFacing", () => {
  it("moves looks away onto the take's clock", () => {
    const read: FacingRead = { kind: "seen", away: [{ fromMs: 1000, toMs: 4000, kind: "down" }] };
    expect(shiftFacing(read, 800)).toEqual({
      kind: "seen",
      away: [{ fromMs: 1800, toMs: 4800, kind: "down" }],
    });
  });
});

describe("observeFacing", () => {
  const runs: SlideRun[] = [
    { index: 0, slideId: "a", fromMs: 0, toMs: 20_000 },
    { index: 1, slideId: "b", fromMs: 20_000, toMs: 40_000 },
  ];

  it("says nothing without a head-direction read", () => {
    expect(observeFacing(null, runs)).toBeNull();
  });

  it("names the one look away and links to its slide", () => {
    const read: FacingRead = { kind: "seen", away: [{ fromMs: 25_000, toMs: 28_000, kind: "down" }] };
    expect(observeFacing(read, runs)).toEqual({
      text: "You looked down once, for 3 seconds on slide 2.",
      listen: { slideIndex: 1, atMs: 23_500 },
    });
  });

  it("counts several and points at the longest", () => {
    const read: FacingRead = {
      kind: "seen",
      away: [
        { fromMs: 5_000, toMs: 7_000, kind: "turned" },
        { fromMs: 22_000, toMs: 28_000, kind: "down" },
      ],
    };
    expect(observeFacing(read, runs)).toEqual({
      text: "You turned away from the room or looked down 2 times for 2 seconds or more. The longest was 6 seconds, on slide 2.",
      listen: { slideIndex: 1, atMs: 20_500 },
    });
  });

  it("gives a time instead of a slide for an app", () => {
    const read: FacingRead = { kind: "seen", away: [{ fromMs: 31_000, toMs: 34_000, kind: "turned" }] };
    expect(observeFacing(read, [])).toEqual({
      text: "You turned away from the room once, for 3 seconds at 0:31.",
      listen: { slideIndex: null, atMs: 29_500 },
    });
  });

  it("says when it saw nothing to mark, and when it couldn't see", () => {
    expect(observeFacing({ kind: "seen", away: [] }, runs)?.text).toBe(
      "From the back of the room, you never turned away or looked down or up for long.",
    );
    expect(observeFacing({ kind: "unseen" }, runs)?.listen).toBeUndefined();
  });
});

describe("headNow", () => {
  it("says when there's no face in view", () => {
    expect(headNow(null)).toEqual({ kind: "none" });
  });

  it("judges one reading against the zone", () => {
    expect(headNow([4, -3, 55])).toEqual({ kind: "facing", yaw: 4, pitch: -3, turnDeg: 4, chinDeg: -3 });
    expect(headNow([-40, 0, 55])).toMatchObject({ kind: "turned", turnDeg: 40 });
    expect(headNow([0, 19, 55])).toMatchObject({ kind: "down", chinDeg: 19 });
    expect(headNow([0, -19, 55])).toMatchObject({ kind: "up", chinDeg: -19 });
    const zone = { centerYaw: 25, centerPitch: -5, turnDeg: 30, tiltDeg: 8 };
    expect(headNow([27, -3, 55], zone)).toEqual({ kind: "facing", yaw: 27, pitch: -3, turnDeg: 2, chinDeg: 2 });
    expect(headNow([25, 5, 55], zone)).toMatchObject({ kind: "down", chinDeg: 10 });
  });
});

describe("facing limits", () => {
  it("marks looking up past the tilt limit", () => {
    const frames = [...facing(10), ...span(3, [2, -25, 55]), ...facing(10)];
    expect(readFacing(frames, MS)).toEqual({
      kind: "seen",
      away: [{ fromMs: 10_000, toMs: 13_000, kind: "up" }],
    });
  });

  it("moves the edges with the zone's size", () => {
    const frames = [...facing(10), ...span(3, [25, -5, 55]), ...facing(10)];
    expect(readFacing(frames, MS)).toEqual({ kind: "seen", away: [] });
    expect(readFacing(frames, MS, { ...DEFAULT_FACING_ZONE, turnDeg: 15 })).toEqual({
      kind: "seen",
      away: [{ fromMs: 10_000, toMs: 13_000, kind: "turned" }],
    });
    const short = { ...DEFAULT_FACING_ZONE, tiltDeg: 8 };
    expect(headNow([0, 10, 55], short).kind).toBe("down");
    expect(headNow([0, -10, 55], short).kind).toBe("up");
    expect(headNow([0, -10, 55]).kind).toBe("facing");
  });

  it("names every way the presenter looked away", () => {
    const read: FacingRead = {
      kind: "seen",
      away: [
        { fromMs: 1_000, toMs: 3_000, kind: "up" },
        { fromMs: 5_000, toMs: 7_000, kind: "turned" },
        { fromMs: 22_000, toMs: 28_000, kind: "down" },
      ],
    };
    expect(observeFacing(read, [])?.text).toBe(
      "You turned away from the room, looked down or looked up 3 times for 2 seconds or more. The longest was 6 seconds, at 0:22.",
    );
  });
});

describe("nudgeToward", () => {
  const zone = DEFAULT_FACING_ZONE;
  const toward = (yaw: number, pitch: number) => {
    const nudge = nudgeToward(headNow([yaw, pitch, 55], zone), zone);
    return nudge && { x: Math.round(nudge.x * 100) / 100, y: Math.round(nudge.y * 100) / 100 };
  };

  it("points back toward the room", () => {
    // Turned to their own left (screen left as they face it): back to the right.
    expect(toward(50, 0)).toEqual({ x: 1, y: 0 });
    expect(toward(-50, 0)).toEqual({ x: -1, y: 0 });
    // Looking down: back up. Looking up: back down.
    expect(toward(0, 30)).toEqual({ x: 0, y: -1 });
    expect(toward(0, -30)).toEqual({ x: 0, y: 1 });
  });

  it("counts only the part past the zone's edge", () => {
    // Up and to the left by the same amount past each edge: down and right.
    expect(toward(45, -30)).toEqual({ x: 0.71, y: 0.71 });
    // Too far left, chin a little down but inside the zone: straight right.
    expect(toward(45, 10)).toEqual({ x: 1, y: 0 });
  });

  it("has nothing to point at while facing, or with no face", () => {
    expect(toward(5, 5)).toBeNull();
    expect(nudgeToward(headNow(null), zone)).toBeNull();
  });
});
