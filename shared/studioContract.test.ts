import { describe, expect, test } from "vitest";

import {
  STUDIO_RUN_TRACE_FRAME_LIMIT,
  isStudioRunResult,
  type StudioRunResult,
} from "./studioContract";

const validRun = (): StudioRunResult => ({
  levelId: "maze",
  status: "win",
  steps: 18,
  seed: "studio:0123456789abcdef",
  assisted: true,
  trace: {
    frames: [
      { line: 1, x: 0, y: 0, note: "start" },
      { line: 2, x: 1, y: 0, note: "move" },
    ],
    totalFrames: 2,
    truncated: false,
  },
  message: "Solved.",
});

describe("StudioRunResult bridge shape", () => {
  test("accepts seed, assistance provenance, and a bounded trace", () => {
    expect(isStudioRunResult(validRun())).toBe(true);
  });

  test("rejects the pre-game shape without seed or assistance provenance", () => {
    const { seed: _seed, assisted: _assisted, ...oldShape } = validRun();
    expect(isStudioRunResult(oldShape)).toBe(false);
  });

  test("rejects a trace beyond the bridge cap", () => {
    const run = validRun();
    run.trace.frames = Array.from(
      { length: STUDIO_RUN_TRACE_FRAME_LIMIT + 1 },
      (_, i) => ({ line: i + 1, x: i % 9, y: 0, note: "move" }),
    );
    run.trace.totalFrames = run.trace.frames.length;
    expect(isStudioRunResult(run)).toBe(false);
  });
});
