import { describe, expect, test } from "vitest";
import {
  clipFileExtension,
  clipFileName,
  containerMimeType,
  contactSheetFrameTimes,
  negotiateRecorderMimeType,
} from "./mediaRecording";

describe("negotiateRecorderMimeType", () => {
  test("prefers vp9 for video when everything is supported", () => {
    expect(negotiateRecorderMimeType("video", () => true)).toBe(
      "video/webm;codecs=vp9,opus",
    );
  });

  test("falls back to vp8 then plain webm when vp9 is missing", () => {
    const supported = new Set([
      "video/webm;codecs=vp8,opus",
      "video/webm",
      "video/mp4",
    ]);
    expect(
      negotiateRecorderMimeType("video", (m) => supported.has(m)),
    ).toBe("video/webm;codecs=vp8,opus");
  });

  test("uses mp4 for Safari-style video support (only mp4)", () => {
    expect(
      negotiateRecorderMimeType("video", (m) => m === "video/mp4"),
    ).toBe("video/mp4");
  });

  test("prefers opus webm for audio", () => {
    expect(negotiateRecorderMimeType("audio", () => true)).toBe(
      "audio/webm;codecs=opus",
    );
  });

  test("uses audio/mp4 for Safari-style audio support (only mp4)", () => {
    expect(
      negotiateRecorderMimeType("audio", (m) => m === "audio/mp4"),
    ).toBe("audio/mp4");
  });

  test("returns null when nothing is supported", () => {
    expect(negotiateRecorderMimeType("video", () => false)).toBeNull();
    expect(negotiateRecorderMimeType("audio", () => false)).toBeNull();
  });
});

describe("containerMimeType", () => {
  test.each([
    ["video/webm;codecs=vp9,opus", "video/webm"],
    ["video/webm;codecs=vp8,opus", "video/webm"],
    ["audio/webm;codecs=opus", "audio/webm"],
    ["video/mp4", "video/mp4"],
    ["audio/mp4", "audio/mp4"],
    ["video/webm", "video/webm"],
  ])("%s → %s", (full, bare) => {
    expect(containerMimeType(full)).toBe(bare);
  });

  test("strips whitespace around the container token", () => {
    expect(containerMimeType("video/webm ; codecs=vp9,opus")).toBe("video/webm");
  });

  test("result has no comma (valid as an HTTP Content-Type header)", () => {
    expect(containerMimeType("video/webm;codecs=vp9,opus")).not.toContain(",");
  });
});

describe("clipFileExtension", () => {
  test.each([
    ["audio", "audio/webm;codecs=opus", "webm"],
    ["audio", "audio/webm", "webm"],
    ["audio", "audio/mp4", "m4a"],
    ["video", "video/webm;codecs=vp9,opus", "webm"],
    ["video", "video/webm", "webm"],
    ["video", "video/mp4", "mp4"],
  ] as const)("%s + %s → .%s", (kind, mime, ext) => {
    expect(clipFileExtension(kind, mime)).toBe(ext);
  });
});

describe("clipFileName", () => {
  test("names an audio webm clip", () => {
    expect(clipFileName("audio", "audio/webm;codecs=opus", 1700)).toBe(
      "audio-1700.webm",
    );
  });

  test("names an audio mp4 clip as m4a", () => {
    expect(clipFileName("audio", "audio/mp4", 1700)).toBe("audio-1700.m4a");
  });

  test("names a video mp4 clip", () => {
    expect(clipFileName("video", "video/mp4", 42)).toBe("video-42.mp4");
  });

  test("names a video webm clip", () => {
    expect(clipFileName("video", "video/webm;codecs=vp9,opus", 42)).toBe(
      "video-42.webm",
    );
  });
});

describe("contactSheetFrameTimes", () => {
  test("returns 4 evenly spaced segment midpoints by default", () => {
    // 8000 ms / 4 segments → midpoints at 1000, 3000, 5000, 7000.
    expect(contactSheetFrameTimes(8000)).toEqual([1000, 3000, 5000, 7000]);
  });

  test("skips the very first and very last frame (no 0, no duration)", () => {
    const times = contactSheetFrameTimes(10_000);
    expect(times[0]).toBeGreaterThan(0);
    expect(times[times.length - 1]).toBeLessThan(10_000);
  });

  test("honors a custom frame count", () => {
    expect(contactSheetFrameTimes(4000, 2)).toEqual([1000, 3000]);
  });

  test("returns nothing for a non-positive duration or count", () => {
    expect(contactSheetFrameTimes(0)).toEqual([]);
    expect(contactSheetFrameTimes(-5)).toEqual([]);
    expect(contactSheetFrameTimes(Number.NaN)).toEqual([]);
    expect(contactSheetFrameTimes(8000, 0)).toEqual([]);
  });
});
