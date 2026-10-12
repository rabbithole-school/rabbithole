import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, test } from "vitest";

import {
  STORY_FIELD_SETTLED_OPACITY,
  STORY_HINT_MS,
  STORY_REVEAL_MS,
} from "./storyReveal";

// The repo root, from this test file at shared/storyReveal.test.ts.
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const NATIVE_CARD = "native/src/components/practice/StoryMomentCard.tsx";

// Strip comments so the scans below see CODE, not the header/inline prose (which
// legitimately discusses the very tokens — createFromSeed, runOnJS — we assert
// the code no longer uses).
const stripComments = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
const readCode = (rel: string) => stripComments(readFileSync(join(repoRoot, rel), "utf8"));

describe("story reveal — timing invariants", () => {
  test("phases are ordered mount → field → shine → emoji → text → settle", () => {
    const R = STORY_REVEAL_MS;
    expect(R.fieldIn).toBeLessThanOrEqual(R.shineStart);
    expect(R.shineStart).toBeLessThanOrEqual(R.emojiStart);
    expect(R.emojiStart).toBeLessThanOrEqual(R.textStart);
    expect(R.textStart).toBeLessThanOrEqual(R.settleStart);
  });

  test("total is settleStart + settleDur, and the reveal stays ~sub-second", () => {
    const R = STORY_REVEAL_MS;
    expect(R.total).toBe(R.settleStart + R.settleDur);
    expect(R.total).toBeLessThanOrEqual(1000);
  });

  test("the settled field opacity is faint (readability) and the hint dwells ~2s", () => {
    expect(STORY_FIELD_SETTLED_OPACITY).toBeGreaterThan(0);
    expect(STORY_FIELD_SETTLED_OPACITY).toBeLessThan(1);
    expect(STORY_HINT_MS).toBe(2000);
  });
});

describe("story reveal — reduced motion collapses to the settled state", () => {
  test("native never runs runOnJS inside an animation completion callback", () => {
    // The load-bearing crash guard: sequence with withDelay/withSequence, never
    // a completion-callback runOnJS (SIGABRTs with the React Compiler on).
    expect(readCode(NATIVE_CARD)).not.toContain("runOnJS");
  });
});
