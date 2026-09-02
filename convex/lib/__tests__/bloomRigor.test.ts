import { describe, it, expect } from "vitest";
import { expectedBloomForStandard, fourStop, cellStop, summarizeBand } from "../bloomRigor";

describe("expectedBloomForStandard", () => {
  it("reads the standard's strongest cognitive-demand verb", () => {
    expect(expectedBloomForStandard("Identify the main topic of a text.")).toBe(0);
    expect(expectedBloomForStandard("Explain how an author uses reasons to support points.")).toBe(3); // "explain how"
    expect(expectedBloomForStandard("Describe characters in a story.")).toBe(1);
    expect(expectedBloomForStandard("Multiply two two-digit numbers.")).toBe(2);
    expect(expectedBloomForStandard("Compare two fractions with different numerators.")).toBe(3);
    expect(expectedBloomForStandard("Evaluate the argument and specific claims in a text.")).toBe(4);
    expect(expectedBloomForStandard("Write an opinion piece supporting a point of view.")).toBe(5);
  });

  it("takes the MAX level when several verbs appear", () => {
    // "use" (2) + "analyze" (3) → analyze
    expect(expectedBloomForStandard("Use evidence to analyze the structure of events.")).toBe(3);
    // "describe" (1) + "design" (5) → design
    expect(expectedBloomForStandard("Describe and design a solution to a problem.")).toBe(5);
  });

  it("falls back to Apply (2) when no verb matches", () => {
    expect(expectedBloomForStandard("Numbers and operations in base ten.")).toBe(2);
  });
});

describe("fourStop", () => {
  it("is not-yet when there is no evidence", () => {
    expect(fourStop(null, 3)).toBe("notyet");
    expect(fourStop(undefined, 3)).toBe("notyet");
  });
  it("is approaching below the bar, met at it, beyond past it", () => {
    expect(fourStop(1.0, 3)).toBe("approaching"); // well below
    expect(fourStop(2.6, 3)).toBe("met"); // within 0.5
    expect(fourStop(3.0, 3)).toBe("met");
    expect(fourStop(3.4, 3)).toBe("met");
    expect(fourStop(3.6, 3)).toBe("beyond"); // a clear half-level past
    expect(fourStop(5.0, 2)).toBe("beyond"); // an accelerated kid blows past
  });
});

describe("cellStop", () => {
  it("classifies a band by its averages, not-yet when unevidenced", () => {
    expect(cellStop(null, 3)).toBe("notyet");
    expect(cellStop(4.8, 2.5)).toBe("beyond"); // the gifted 2nd grader on grade-3 math
    expect(cellStop(1.7, 2.5)).toBe("approaching"); // a below-bar writing cell
  });
});

describe("summarizeBand — the ONE shared headline (grid cell === drawer ring)", () => {
  it("coverage is met-or-beyond over ALL standards (the goal-100% denominator)", () => {
    // 4 standards, bar 2 each: two beyond, one approaching, one unevidenced.
    const summary = summarizeBand([
      { demonstrated: 4, expected: 2 }, // beyond
      { demonstrated: 3, expected: 2 }, // beyond
      { demonstrated: 0.5, expected: 2 }, // approaching
      { demonstrated: undefined, expected: 2 }, // not yet
    ]);
    expect(summary.total).toBe(4);
    expect(summary.evidenced).toBe(3);
    expect(summary.dist).toEqual({ notyet: 1, approaching: 1, met: 0, beyond: 2 });
    expect(summary.coveragePct).toBe(50); // 2 of 4
    expect(summary.stop).toBe("beyond"); // avg demonstrated (2.5) ≫ avg expected (2)
  });

  it("an empty / all-gray band is 0% and not-yet", () => {
    expect(summarizeBand([]).coveragePct).toBe(0);
    expect(summarizeBand([]).stop).toBe("notyet");
    const blank = summarizeBand([{ demonstrated: undefined, expected: 3 }]);
    expect(blank.coveragePct).toBe(0);
    expect(blank.evidenced).toBe(0);
    expect(blank.stop).toBe("notyet");
  });

  it("the headline ignores DEPTH — sparse-but-deep reads as low coverage", () => {
    // One standard mastered far beyond the bar, nine untouched: deep, but only
    // 10% of the grade covered. The number is breadth, the colour is depth.
    const standards = [
      { demonstrated: 5, expected: 2 },
      ...Array.from({ length: 9 }, () => ({ demonstrated: undefined as number | undefined, expected: 2 })),
    ];
    const summary = summarizeBand(standards);
    expect(summary.coveragePct).toBe(10); // breadth
    expect(summary.stop).toBe("beyond"); // depth of what's touched
  });
});
