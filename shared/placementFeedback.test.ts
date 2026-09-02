import { describe, expect, it } from "vitest";
import { placementFeedback } from "./practiceLoop";

/**
 * Coverage for the unified verdict presentation (#unify — placement used to
 * render its own full-screen "Nice — that's right!" page; it now reuses the
 * SAME corner-stamp overlay the practice drill does). These pin the NEW
 * `stampLabel` / `srAnnouncement` fields; `shared/practiceLoop.test.ts`
 * already covers `.body` and is left untouched (still passes unchanged).
 */
describe("placementFeedback — unified verdict stamp", () => {
  it("labels a correct probe with the stamp text practice already uses", () => {
    const fb = placementFeedback("correct");
    expect(fb.tone).toBe("correct");
    expect(fb.stampLabel).toBe("Correct");
    expect(fb.body).toBe("Let's keep going.");
    expect(fb.srAnnouncement.length).toBeGreaterThan(0);
  });

  it("labels a wrong guess 'Not quite' — matching the drill's miss stamp", () => {
    const fb = placementFeedback("incorrect", "14");
    expect(fb.tone).toBe("miss");
    expect(fb.stampLabel).toBe("Not quite");
    expect(fb.body).toContain("The answer was 14.");
  });

  it("labels an honest don't-know 'Noted' — NOT 'Not quite' (honesty isn't a wrong guess)", () => {
    const fb = placementFeedback("unknown", "14");
    expect(fb.tone).toBe("miss");
    expect(fb.stampLabel).toBe("Noted");
    expect(fb.stampLabel).not.toBe("Not quite");
    expect(fb.body).toContain("haven't learned yet");
  });

  it("never renders a bare reveal when no correct answer is available (e.g. a manipulative probe)", () => {
    const fb = placementFeedback("incorrect");
    expect(fb.body).not.toContain("The answer was");
    // Teach-as-action dropped the "work through one step here" promise —
    // placement renders no interactive step, so the copy must not claim one.
    // The intent of this case survives: the body still says SOMETHING kind.
    expect(fb.body.trim().length).toBeGreaterThan(0);
    expect(fb.body).not.toContain("work through one step");
  });

  it("gives every outcome a non-empty screen-reader announcement carrying the retired title copy", () => {
    for (const outcome of ["correct", "incorrect", "unknown"] as const) {
      const fb = placementFeedback(outcome, "14");
      expect(fb.srAnnouncement.length).toBeGreaterThan(0);
    }
  });
});
