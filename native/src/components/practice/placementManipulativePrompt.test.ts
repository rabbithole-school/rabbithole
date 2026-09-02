import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";

// ─────────────────────────────────────────────────────────────────────────
// A manipulative PLACEMENT probe must show its question.
//
// Observed 2026-08-19 on the physical test iPad (canary 1.0.18(26)): questions
// 7 and 9 of a multi-domain check-in rendered a bare number line whose only
// text was the stage's own mechanical caption, "Start at 3. Drag the dot left
// or right." The XCUITest a11y dump had no stem node at all. The prod rows were
// fine (`ic-place-neg-1point5`, `ic-add-3-plus-neg5` both carry a real stem AND
// a real spec.prompt) — NativePlacement hid the stem card for a manipulative
// probe on the assumption the stage supplied the prompt, then rendered the
// chrome-LESS `NativeManipulative` dispatcher, which never does. Every other
// native call site (the drill card, the launchpad, the chat item, the
// multi-step sequence) renders `spec.prompt` itself; placement was the one that
// did not.
//
// This matters more than a normal missing label: a placement probe's answer is
// recorded as evidence of what the scholar knows and feeds domain convergence,
// so an unanswerable item writes noise into their map.
//
// No component render harness exists for these Convex-subscribing screens, so
// this is a structural drift guard reading the real source — the same shape as
// checkInSurfacesPlacement.test.ts.
// ─────────────────────────────────────────────────────────────────────────

const PLACEMENT = "src/components/practice/NativePlacement.tsx";

function read(path: string): string {
  return readFileSync(path, "utf8");
}

describe("NativePlacement — a manipulative probe renders its own question", () => {
  test("renders the spec's prompt above the stage", () => {
    const src = read(PLACEMENT);
    expect(src).toContain("<Text style={styles.manipPrompt}>{manipSpec.prompt}</Text>");
  });

  test("renders the spec's concept eyebrow, matching the drill card and web", () => {
    expect(read(PLACEMENT)).toContain(
      "<Text style={styles.manipConcept}>{manipSpec.concept.toUpperCase()}</Text>",
    );
  });

  test("keeps the stem card when the spec did not parse, so text is never absent", () => {
    // The stem card is suppressed ONLY when a parsed spec exists to carry the
    // prompt; a malformed spec falls back to the served stem rather than to a
    // screen with no question on it at all.
    expect(read(PLACEMENT)).toContain("{!isManipulativeProbe || !manipSpec ? (");
  });

  test("the prompt block does not depend on the kind having a native renderer", () => {
    // An unsupported kind shows the fallback line instead of a stage; the
    // scholar should still see what was asked before tapping "I haven't
    // learned this yet", so the prompt gates on `manipSpec`, not `supportedManip`.
    const src = read(PLACEMENT);
    const promptIdx = src.indexOf("styles.manipPromptBlock");
    const supportedIdx = src.indexOf("{supportedManip && manipSpec ? (");
    expect(promptIdx).toBeGreaterThan(-1);
    expect(supportedIdx).toBeGreaterThan(promptIdx);
  });
});
