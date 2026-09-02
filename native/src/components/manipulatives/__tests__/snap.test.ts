import { describe, expect, it } from "vitest";

import { crossedSnap, snapIndex } from "../snap";

// The pure snap-crossing math behind the manipulatives' discrete-step haptic:
// `useMovableHandle` mirrors this same rounding inside its UI-thread worklet
// (which can't call an imported JS fn) and seeds it here on the JS thread, so
// pinning the rule here guards the "one selection tick per cell crossed" feel.
describe("snapIndex", () => {
  it("rounds a value to its nearest increment index", () => {
    expect(snapIndex(0, 0.25)).toBe(0);
    expect(snapIndex(0.25, 0.25)).toBe(1);
    expect(snapIndex(0.72, 0.25)).toBe(3); // three-quarters
    expect(snapIndex(1, 0.25)).toBe(4);
    expect(snapIndex(5, 1)).toBe(5);
  });

  it("rounds to the NEAREST index across a boundary (half rounds up)", () => {
    expect(snapIndex(0.124, 0.25)).toBe(0);
    expect(snapIndex(0.125, 0.25)).toBe(1); // exactly halfway → up
    expect(snapIndex(0.13, 0.25)).toBe(1);
  });

  it("handles negative values symmetrically", () => {
    expect(snapIndex(-0.25, 0.25)).toBe(-1);
    expect(snapIndex(-0.6, 0.25)).toBe(-2); // -2.4 → -2
    expect(snapIndex(-2, 1)).toBe(-2);
  });

  it("reports NaN when there is no snapping (increment <= 0)", () => {
    expect(snapIndex(3, 0)).toBeNaN();
    expect(snapIndex(3, -1)).toBeNaN();
  });
});

describe("crossedSnap", () => {
  it("is true only when the index actually changes", () => {
    expect(crossedSnap(2, 3)).toBe(true);
    expect(crossedSnap(2, 1)).toBe(true);
    expect(crossedSnap(2, 2)).toBe(false);
  });

  it("treats a NaN endpoint (no prior index / no snapping) as no crossing", () => {
    // A grab seeds the index before the first move; until then prev is NaN and
    // must NOT count as a crossing (that would double-fire on top of the grab tick).
    expect(crossedSnap(Number.NaN, 3)).toBe(false);
    expect(crossedSnap(3, Number.NaN)).toBe(false);
    expect(crossedSnap(Number.NaN, Number.NaN)).toBe(false);
  });
});
