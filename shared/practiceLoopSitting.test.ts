import { describe, expect, it } from "vitest";
import {
  CHECK_IN_SITTING_PROBE_BUDGET,
  placementProgress,
} from "./practiceLoop";

// The per-SITTING check-in budget's shared surface (constant + the "…today"
// progress label). The server-side budget/pause/priority behavior is exercised in
// convex/__tests__/checkInSittingBudget.test.ts; this pins the pure pieces both
// scholar frontends render.
describe("check-in per-sitting budget — shared surface", () => {
  it("exposes a sane, named per-sitting probe budget", () => {
    expect(CHECK_IN_SITTING_PROBE_BUDGET).toBe(30);
    // A "map, not a marathon": comfortably below a full multi-domain sweep, and
    // above a trivial handful.
    expect(CHECK_IN_SITTING_PROBE_BUDGET).toBeGreaterThan(10);
    expect(CHECK_IN_SITTING_PROBE_BUDGET).toBeLessThan(60);
  });

  it("appends ' today' to the ceiling copy only when perSitting", () => {
    // Default (single-domain placement) — unchanged copy, no "today".
    expect(placementProgress(3, 10).label).toBe("Question 4 of up to 10");
    // Mixed check-in — the ceiling reflects the SITTING budget, "…up to N today".
    expect(placementProgress(3, CHECK_IN_SITTING_PROBE_BUDGET, false, true).label).toBe(
      "Question 4 of up to 30 today",
    );
    // perSitting doesn't disturb the numeric fields (still additive-only).
    const p = placementProgress(3, 30, false, true);
    expect(p.questionNumber).toBe(4);
    expect(p.maxQuestions).toBe(30);
    expect(p.percent).toBe(10);
  });

  it("still clamps the shown question number to the sitting ceiling", () => {
    // Answered past the (early-convergence-shrunk) ceiling never overshoots.
    const p = placementProgress(40, 30, false, true);
    expect(p.questionNumber).toBe(30);
    expect(p.label).toBe("Question 30 of up to 30 today");
  });
});
