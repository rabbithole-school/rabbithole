/**
 * Anti-drift guard for the teach-back eval.
 *
 * The eval's entire credibility rests on measuring the SHIPPED behavior, so:
 *
 * 1. The eval's re-export (../prompt.ts) must be the very same objects as
 *    convex/lib/teachBack.ts — not a copy that could rot. We assert referential
 *    identity (===), so swapping in a hand-rolled section/tool/grader fails.
 *
 * 2. The two tutor-tool guidance strings were extracted OUT of the tutor tool
 *    definitions into convex/lib/teachBack.ts precisely so the eval hands the
 *    model the same text prod does. The tool definitions themselves have since
 *    moved from convex/http.ts into convex/lib/tutorSessionTools.ts; this test
 *    reads that module and asserts it still calls the extracted symbols and
 *    does NOT re-inline the guidance — re-inlining (the drift we refactored
 *    away) becomes impossible to merge.
 *
 * 3. A few load-bearing invariants of the shipped strings (novice stance, don't
 *    explain it, no grade to the kid) must survive any edit — a well-meaning
 *    rewrite that guts them should turn this test red.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import * as evalPrompt from "../prompt";
import * as shipped from "../../../convex/lib/teachBack";

const HERE = dirname(fileURLToPath(import.meta.url));
// The tutor tool definitions live in lib/tutorSessionTools.ts (extracted from
// http.ts); scan BOTH so a re-inline in either home turns this red.
const httpSource = readFileSync(join(HERE, "..", "..", "..", "convex", "http.ts"), "utf8");
const tutorToolsSource = readFileSync(
  join(HERE, "..", "..", "..", "convex", "lib", "tutorSessionTools.ts"),
  "utf8",
);

describe("teach-back eval ⟷ shipped module", () => {
  test("the eval re-exports the exact shipped symbols (referential identity)", () => {
    expect(evalPrompt.buildTeachBackSection).toBe(shipped.buildTeachBackSection);
    expect(evalPrompt.START_TEACH_BACK_TOOL).toBe(shipped.START_TEACH_BACK_TOOL);
    expect(evalPrompt.FINISH_TEACH_BACK_TOOL).toBe(shipped.FINISH_TEACH_BACK_TOOL);
    expect(evalPrompt.teachBackStartGuidance).toBe(shipped.teachBackStartGuidance);
    expect(evalPrompt.TEACH_BACK_FINISH_GUIDANCE).toBe(shipped.TEACH_BACK_FINISH_GUIDANCE);
    expect(evalPrompt.TEACH_BACK_NO_ACTIVE_GUIDANCE).toBe(shipped.TEACH_BACK_NO_ACTIVE_GUIDANCE);
    expect(evalPrompt.buildTeachBackGradingPrompt).toBe(shipped.buildTeachBackGradingPrompt);
    expect(evalPrompt.parseTeachBackRubric).toBe(shipped.parseTeachBackRubric);
    expect(evalPrompt.TEACH_BACK_GRADING_TOOL).toBe(shipped.TEACH_BACK_GRADING_TOOL);
  });
});

describe("the tutor tool assembly uses the extracted guidance (no re-inlining)", () => {
  test("tutorSessionTools.ts calls the extracted guidance symbols", () => {
    expect(tutorToolsSource).toContain("teachBackStartGuidance(");
    expect(tutorToolsSource).toContain("TEACH_BACK_FINISH_GUIDANCE");
    expect(tutorToolsSource).toContain("TEACH_BACK_NO_ACTIVE_GUIDANCE");
  });

  test("neither home re-inlines the guidance strings", () => {
    // A distinctive slice of each shipped string; if it reappears verbatim in
    // either file, someone re-inlined it and the eval would silently drift.
    for (const source of [httpSource, tutorToolsSource]) {
      expect(source).not.toContain("Teach-back mode is on for");
      expect(source).not.toContain("Teach-back closed. Warmly thank");
      expect(source).not.toContain("no active teach-back to finish");
    }
  });
});

describe("shipped teach-back strings keep their load-bearing invariants", () => {
  test("the tutor-visible section holds the core stance", () => {
    const section = shipped.buildTeachBackSection().toLowerCase();
    expect(section).toContain("method"); // a method, not a character
    expect(section).toContain("but why"); // escalating naive probes
    // never grade the kid
    expect(section).toMatch(/never give the scholar a grade|no scoreboard/);
    // don't supply the answer
    expect(section).toContain("do not supply the answer");
    // …and the exit must not turn into a soft grade (the eval's gradeLeak fix)
    expect(section).toContain("evaluative praise of the explanation");
    expect(section).toContain("thank the act of teaching");
    // …and a novice literally can't confirm correctness mid-stream (no "yeah, exactly")
    expect(section).toContain('no "yeah, exactly"');
  });

  test("the start guidance keeps the novice/withhold/no-grade instructions", () => {
    const g = shipped.teachBackStartGuidance("why the sky is blue").toLowerCase();
    expect(g).toContain("why the sky is blue"); // interpolates the concept
    expect(g).toContain("never give them a grade");
    expect(g).toMatch(/do not explain it yourself|let them explain/);
    expect(g).toContain("but why");
  });

  test("the finish guidance thanks without a verdict", () => {
    const g = shipped.TEACH_BACK_FINISH_GUIDANCE.toLowerCase();
    expect(g).toContain("thank");
    expect(g).toMatch(/grade|score|verdict/);
    // thanks the act of teaching, not the quality of the explanation
    expect(g).toContain("thanking the act of teaching");
    expect(g).toContain("do not praise the quality");
  });

  test("the start guidance also bars praising the explanation", () => {
    const g = shipped.teachBackStartGuidance("x").toLowerCase();
    expect(g).toContain("don't praise how well they explained it");
    // a novice can't confirm correctness mid-stream
    expect(g).toContain('no "yeah, exactly"');
  });
});
