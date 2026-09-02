import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, test } from "vitest";

import {
  STORY_CARD_COPY,
  STORY_FIELD_SETTLED_OPACITY,
  STORY_HINT_MS,
  STORY_REVEAL_MS,
} from "./storyReveal";

// The repo root, from this test file at shared/storyReveal.test.ts.
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const WEB_CARD = "components/practice/StoryMomentCard.tsx";
const NATIVE_CARD = "native/src/components/practice/StoryMomentCard.tsx";

// Strip comments so the scans below see CODE, not the header/inline prose (which
// legitimately discusses the very tokens — createFromSeed, runOnJS — we assert
// the code no longer uses).
const stripComments = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
const readCode = (rel: string) => stripComments(readFileSync(join(repoRoot, rel), "utf8"));

describe("story reveal — locked copy", () => {
  // The two competing eyebrows collapsed into ONE, and the 🚀 is the app-wide
  // quest glyph that carries the WHERE. Sentence case (visual-design.md).
  test("the eyebrow is the unified '🚀 Quest unlocked'", () => {
    expect(STORY_CARD_COPY.eyebrow).toBe("🚀 Quest unlocked");
  });

  test("the tap hint points to the Quests tab", () => {
    expect(STORY_CARD_COPY.hint).toBe("Find this in your Quests tab");
  });
});

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

describe("story reveal — both card twins honor the brief", () => {
  const cards: [string, string][] = [
    ["web", WEB_CARD],
    ["native", NATIVE_CARD],
  ];

  test.each(cards)("%s card no longer navigates (no createFromSeed)", (_label, rel) => {
    const src = readCode(rel);
    expect(src).not.toContain("createFromSeed");
    // No router navigation from the card any more — Done owns navigation.
    expect(src).not.toContain("useRouter");
  });

  test.each(cards)("%s card uses the shared locked copy", (_label, rel) => {
    const src = readCode(rel);
    expect(src).toContain("STORY_CARD_COPY.eyebrow");
    expect(src).toContain("STORY_CARD_COPY.hint");
    // The old two-eyebrow / CTA copy is gone from the rendered card.
    expect(src).not.toContain("Follow the thread");
    expect(src).not.toContain("Waiting in your Quests");
    expect(src).not.toContain("NEW STORY");
  });

  test.each(cards)("%s card still records the offer at mount", (_label, rel) => {
    expect(readCode(rel)).toContain("recordMomentOffered");
  });

  test.each(cards)("%s card prefers artUrl and keeps visualEmoji as fallback", (_label, rel) => {
    const src = readCode(rel);
    expect(src).toContain("moment.artUrl");
    expect(src).toContain("moment.visualEmoji");
  });
});

describe("story reveal — reduced motion collapses to the settled state", () => {
  test("web gates the reveal on prefers-reduced-motion", () => {
    expect(readCode(WEB_CARD)).toContain("prefers-reduced-motion");
  });

  test("native gates the reveal on Reduce Motion", () => {
    expect(readCode(NATIVE_CARD)).toContain("isReduceMotionEnabled");
  });

  test("native never runs runOnJS inside an animation completion callback", () => {
    // The load-bearing crash guard: sequence with withDelay/withSequence, never
    // a completion-callback runOnJS (SIGABRTs with the React Compiler on).
    expect(readCode(NATIVE_CARD)).not.toContain("runOnJS");
  });
});
