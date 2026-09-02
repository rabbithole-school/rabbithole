import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync(
  new URL("./Placement.tsx", import.meta.url),
  "utf8",
);

function between(start: string, end: string): string {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from + start.length);
  if (from < 0 || to < 0) throw new Error("Placement walkthrough marker moved");
  return source.slice(from, to);
}

describe("Placement walkthrough single-flight latch", () => {
  it("re-arms only from an effect committed after the tutorial index or run changes", () => {
    expect(source).toContain("useEffect");
    // The run counter keeps re-ENTRY at the same index (a beat-0 skip → the
    // null-probe intro fallback → Start again) able to re-arm the latch,
    // without adding a second reset site (2026-08-18).
    expect(source).toMatch(
      /useEffect\(\(\) => \{\s*tutorialAdvancing\.current = false;\s*\}, \[tutorialIndex, tutorialRun\]\);/,
    );
    expect(source.match(/tutorialAdvancing\.current = false/g)).toHaveLength(1);

    const begin = between(
      "const beginTutorial = useCallback(() => {",
      "// Single-flight latch",
    );
    expect(begin).toContain("setTutorialRun((n) => n + 1);");
    expect(begin).not.toContain("tutorialAdvancing.current");

    const advance = between(
      "const advanceTutorial = useCallback(() => {",
      "const skipTutorial = useCallback(() => {",
    );
    expect(advance).toContain("setTutorialIndex((i) => i + 1);");
    expect(advance).not.toContain("tutorialAdvancing.current = false");
  });

  it("keeps the latch closed when the walkthrough exits", () => {
    const advance = between(
      "const advanceTutorial = useCallback(() => {",
      "const skipTutorial = useCallback(() => {",
    );
    expect(advance).toMatch(
      /tutorialAdvancing\.current = true;[\s\S]*?if \(tutorialIndex >= TUTORIAL_BEATS\.length - 1\) \{[\s\S]*?start\(\);[\s\S]*?return;/,
    );

    const skip = between(
      "const skipTutorial = useCallback(() => {",
      "const onTutorialCheck = useCallback(() => {",
    );
    expect(skip).toContain("tutorialAdvancing.current = true;");
    expect(skip).toContain("start();");
    expect(skip).not.toContain("tutorialAdvancing.current = false");
  });
});
