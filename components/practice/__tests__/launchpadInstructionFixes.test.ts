import { describe, it, expect } from "vitest";
import {
  REHEARSE_TRY_FIRST_TERMINAL_COPY,
  launchpadTryFirstMode,
} from "@/components/practice/LaunchpadCard";
import {
  WORKED_NEXT_STEP_LABEL,
  WORKED_SEE_IT_WORK_LABEL,
  workedExampleReveal,
} from "@/components/practice/LaunchpadContent";

/**
 * The checkable cores of PHASE 0's two defect fixes (plan §5). This env has no
 * DOM renderer, so — exactly like `rehearseZeroWrite.test.ts` — these drive the
 * pure decision seams the components delegate to, so a regression fails an
 * assertion rather than only showing up in a screenshot.
 */

describe("F1 · Rehearse 'Try it myself' no longer silently closes the dialog", () => {
  it("flips to the terminal explainer in preview (no proceed → no dialog dismiss)", () => {
    expect(launchpadTryFirstMode(true)).toBe("preview-terminal");
  });

  it("POSITIVE CONTROL: a live scholar still proceeds to their first item", () => {
    expect(launchpadTryFirstMode(false)).toBe("proceed");
  });

  it("the terminal copy is sentence case and points at the 'See an example' shelf", () => {
    // First word capitalised, no Title Case, mentions the always-available shelf.
    expect(REHEARSE_TRY_FIRST_TERMINAL_COPY.startsWith("The scholar")).toBe(true);
    expect(REHEARSE_TRY_FIRST_TERMINAL_COPY).toContain("See an example");
  });
});

describe("F2 · 'Show me the move' reveals one step at a time, answer last", () => {
  it("starts with only step 1 visible and the answer hidden", () => {
    const s = workedExampleReveal(3, 1);
    expect(s.visibleStepCount).toBe(1);
    expect(s.showAnswer).toBe(false);
    expect(s.hasMore).toBe(true);
    expect(s.nextLabel).toBe(WORKED_NEXT_STEP_LABEL);
  });

  it("accumulates — never hides an already-revealed step", () => {
    const counts = [1, 2, 3].map((r) => workedExampleReveal(3, r).visibleStepCount);
    expect(counts).toEqual([1, 2, 3]); // monotonic, never shrinks
  });

  it("labels the final reveal 'See it work' (the answer is the last reveal)", () => {
    // At revealed === stepCount the next tap uncovers the answer.
    const beforeAnswer = workedExampleReveal(3, 3);
    expect(beforeAnswer.showAnswer).toBe(false);
    expect(beforeAnswer.nextLabel).toBe(WORKED_SEE_IT_WORK_LABEL);
    expect(beforeAnswer.hasMore).toBe(true);

    const atAnswer = workedExampleReveal(3, 4);
    expect(atAnswer.visibleStepCount).toBe(3); // all steps stay visible
    expect(atAnswer.showAnswer).toBe(true);
    expect(atAnswer.hasMore).toBe(false); // nothing left to reveal
  });

  it("clamps out-of-range reveal counts (no over/under-reveal)", () => {
    expect(workedExampleReveal(3, 0).visibleStepCount).toBe(1); // min 1 step
    expect(workedExampleReveal(3, 99)).toEqual({
      visibleStepCount: 3,
      showAnswer: true,
      hasMore: false,
      nextLabel: WORKED_SEE_IT_WORK_LABEL,
    });
  });

  it("degrades gracefully for a step-less example (answer only)", () => {
    const s = workedExampleReveal(0, 1);
    expect(s.visibleStepCount).toBe(0);
    expect(s.showAnswer).toBe(true);
    expect(s.hasMore).toBe(false);
  });
});
