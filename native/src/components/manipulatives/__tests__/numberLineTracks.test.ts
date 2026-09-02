import { describe, expect, it } from "vitest";
import {
  multipleTrackLandings,
  numberLineSolved,
} from "../../../../vendor/manipulative/logic";
import type { NumberLineSpec } from "../../../../vendor/manipulative/types";

const spec: NumberLineSpec = {
  kind: "numberline",
  id: "native-dual-track-line",
  concept: "Least common multiple",
  prompt: "Reveal both tracks.",
  min: 0,
  max: 30,
  tickStep: 5,
  snap: 1,
  start: 0,
  multipleTracks: [3, 5],
  goal: { type: "firstCommonMultiple", tolerance: 0.5 },
};

describe("native dual-track number line", () => {
  it("uses the shared reveal calculation and first-common-multiple grader", () => {
    expect(multipleTrackLandings(spec.multipleTracks, 16, spec.max)).toEqual({
      tracks: [[3, 6, 9, 12, 15], [5, 10, 15]],
      common: [15],
    });
    expect(numberLineSolved(spec, { value: 15 })).toBe(true);
    expect(numberLineSolved(spec, { value: 30 })).toBe(false);
  });
});
