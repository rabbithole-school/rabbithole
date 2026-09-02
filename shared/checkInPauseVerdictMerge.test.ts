import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * Regression pin for the silent pretest flow × per-sitting check-in budget.
 * A naive edit could keep the server's `paused` response while dropping its
 * render, silently falling through to the quiz card with an ACTIVE Check
 * button — bypassing the sitting budget entirely for a scholar who should
 * have been parked on the warm pause screen.
 *
 * This is a static SOURCE-content guard (no component-render harness exists
 * for Placement.tsx / NativePlacement.tsx in this repo — they're wired
 * directly to live Convex hooks with no test-double seam), pinning the two
 * properties a bad merge would break:
 *
 *   1. The "paused" phase's early-return copy ("Great mapping today…") is
 *      still present in BOTH frontends' source.
 *   2. That early-return appears BEFORE the interactive quiz card's "Check"
 *      button in source order — i.e. it's a genuine early `return` a parked
 *      scholar hits, not dead code after the point where the quiz would
 *      already have rendered and become answerable.
 *
 * The quiz card must remain neutral: grading still happens server-side, but the
 * scholar advances without a verdict stamp, announcement, or feedback phase.
 */

function readSource(relPath: string): string {
  return readFileSync(new URL(`../${relPath}`, import.meta.url), "utf8");
}

describe("check-in sitting-pause × verdict-overlay merge — web", () => {
  const source = readSource("components/practice/Placement.tsx");

  it("still renders the warm per-sitting pause screen", () => {
    expect(source).toContain('if (phase === "paused")');
    expect(source).toContain("Great mapping today");
  });

  it("checks the pause phase BEFORE the interactive quiz card is reachable", () => {
    const pausedIdx = source.indexOf('if (phase === "paused")');
    const quizCheckButtonIdx = source.indexOf("Check <ArrowRight />");
    expect(pausedIdx).toBeGreaterThan(-1);
    expect(quizCheckButtonIdx).toBeGreaterThan(-1);
    expect(pausedIdx).toBeLessThan(quizCheckButtonIdx);
  });

  it("keeps the probe card neutral instead of rendering a verdict", () => {
    expect(source).toContain("<VerdictStemCard");
    expect(source).toContain("tone={null}");
    expect(source).not.toContain("label={fb?.stampLabel}");
    expect(source).not.toContain("announcement={fb?.srAnnouncement}");
  });

  it("routes a paused response directly to the pause screen", () => {
    expect(source).not.toContain("pendingPause");
    expect(source).toMatch(/else if \(res\.paused\)[\s\S]{0,250}setPhase\("paused"\);/);
  });
});

describe("check-in sitting-pause × verdict-overlay merge — native", () => {
  const source = readSource("native/src/components/practice/NativePlacement.tsx");

  it("still renders the warm per-sitting pause screen", () => {
    expect(source).toContain('if (phase === "paused")');
    expect(source).toContain("Great mapping today");
  });

  it("checks the pause phase BEFORE the interactive quiz card is reachable", () => {
    const pausedIdx = source.indexOf('if (phase === "paused")');
    const quizCheckButtonIdx = source.indexOf('label="Check  →"');
    expect(pausedIdx).toBeGreaterThan(-1);
    expect(quizCheckButtonIdx).toBeGreaterThan(-1);
    expect(pausedIdx).toBeLessThan(quizCheckButtonIdx);
  });

  it("keeps the probe card neutral instead of rendering a verdict", () => {
    expect(source).toContain("<StemCard");
    expect(source).toContain("feedback={null}");
    expect(source).not.toContain("stampLabel={fb.stampLabel}");
    expect(source).not.toContain("stampAnnouncement={fb.srAnnouncement}");
  });

  it("routes a paused response directly to the pause screen", () => {
    expect(source).not.toContain("pendingPause");
    expect(source).toMatch(/else if \(res\.paused\)[\s\S]{0,250}setPhase\("paused"\);/);
  });
});
