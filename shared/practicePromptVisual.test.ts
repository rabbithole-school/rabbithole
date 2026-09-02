import { describe, it, expect } from "vitest";
import { layoutFractionLabel } from "./practicePromptVisual";

// Trace tests for the three alignment defects an adversarial review found in
// `layoutFractionLabel` (PR #887 follow-up): mixed text+fraction vertical
// alignment, a negative mixed number's detached sign, and end-anchor drift on
// a pure fraction. Each test asserts the fixed geometry directly rather than
// rendering, since `layoutFractionLabel` is the pure, deterministic layer
// both the web SVG and native react-native-svg renderers consume unchanged.

describe("layoutFractionLabel", () => {
  it("returns 'plain' untouched for fraction-free text (byte-identical path)", () => {
    const layout = layoutFractionLabel("Length (inches)", 100, 50, 13, "middle");
    expect(layout).toEqual({ kind: "plain", text: "Length (inches)", x: 100, y: 50 });
  });

  it("centers a trailing plain-text run on the fraction bar, not the original baseline", () => {
    // angle_turns_circle's label: `${degrees}/360 turn` (convex/lib/practice/templates.ts).
    const layout = layoutFractionLabel("90/360 turn", 100, 50, 15, "middle");
    expect(layout.kind).toBe("runs");
    if (layout.kind !== "runs") throw new Error("expected runs");
    const frac = layout.runs.find((run) => run.kind === "fraction");
    const trailingText = layout.runs.find((run) => run.kind === "text");
    if (!frac || frac.kind !== "fraction") throw new Error("expected a fraction run");
    if (!trailingText || trailingText.kind !== "text") throw new Error("expected a text run");
    expect(trailingText.text).toBe(" turn");
    // The text run's OWN optical center (baseline − 0.35·fontSize, the same
    // convention `FractionAwareLabel`'s `centered` mode uses) must land on the
    // bar, not float near the numerator the way the original baseline did.
    expect(trailingText.y - 15 * 0.35).toBeCloseTo(frac.barY, 5);
    expect(trailingText.y).not.toBe(50); // must have moved off the original baseline
  });

  it("leaves a pure-fraction label's text-run baseline alone (no text to center)", () => {
    // A bare fraction has no text run, so `textRunY` is never observed — the
    // fraction's own numY/denY/barY formulas (and hence pixel position for a
    // middle-anchored label) must stay exactly as before this fix.
    const layout = layoutFractionLabel("3/4", 100, 50, 11, "middle");
    expect(layout).toEqual({
      kind: "runs",
      runs: [
        {
          kind: "fraction",
          num: "3",
          den: "4",
          x: 100,
          numY: 50 - 11 * 0.65,
          denY: 50 + 11 * 1.15,
          barX1: 100 - 2.1 - 1.5,
          barX2: 100 + 2.1 + 1.5,
          barY: 50 - 11 * 0.05,
          innerFontSize: 7,
        },
      ],
    });
  });

  it("merges an adjacent sign into a negative mixed number's leading text run", () => {
    // formatAxisValue("-2 3/4") always emits the sign directly against the
    // whole part; the parser yields separate text("-") + text("2") nodes, and
    // without merging, RUN_GAP put a visible gap between them ("- 2 ¾").
    const layout = layoutFractionLabel("-2 3/4", 100, 50, 11, "middle");
    expect(layout.kind).toBe("runs");
    if (layout.kind !== "runs") throw new Error("expected runs");
    const textRuns = layout.runs.filter((run) => run.kind === "text");
    expect(textRuns).toHaveLength(1);
    expect(textRuns[0].kind === "text" && textRuns[0].text).toBe("-2");
    const fracRuns = layout.runs.filter((run) => run.kind === "fraction");
    expect(fracRuns).toHaveLength(1);
  });

  it("lands an end-anchored pure fraction's drawn bar exactly on its anchor", () => {
    const layout = layoutFractionLabel("3/4", 100, 50, 11, "end");
    expect(layout.kind).toBe("runs");
    if (layout.kind !== "runs") throw new Error("expected runs");
    const [frac] = layout.runs;
    if (frac.kind !== "fraction") throw new Error("expected a fraction run");
    expect(frac.barX2).toBeCloseTo(100, 5);
  });

  it("lands a start-anchored pure fraction's drawn bar exactly on its anchor", () => {
    const layout = layoutFractionLabel("3/4", 100, 50, 11, "start");
    expect(layout.kind).toBe("runs");
    if (layout.kind !== "runs") throw new Error("expected runs");
    const [frac] = layout.runs;
    if (frac.kind !== "fraction") throw new Error("expected a fraction run");
    expect(frac.barX1).toBeCloseTo(100, 5);
  });
});
