import { describe, expect, test } from "vitest";
import {
  blendHex,
  fadeTowardInk,
  GRAPHEME_INK,
  GRAPHEME_PALETTE,
  stageColor,
  teamColor,
  teamColorIndex,
  toSegments,
  type GraphemeSpan,
  type GraphemeStages,
} from "./graphemeSegments";

/** Channel spread (max−min of R,G,B); ~0 means grey/achromatic. */
function chroma(hex: string): number {
  const h = hex.replace(/^#/, "");
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
  return Math.max(r, g, b) - Math.min(r, g, b);
}

// Reconstitute the original string from segments — the load-bearing invariant.
function concat(segments: { text: string }[]): string {
  return segments.map((s) => s.text).join("");
}

describe("toSegments — round-trip concatenation", () => {
  test("segments always concatenate exactly back to the input text", () => {
    const text = "The ship is near the shore.";
    const spans: GraphemeSpan[] = [
      { start: 4, end: 6, team: "sh" }, // sh(ip)
      { start: 16, end: 18, team: "th" }, // th(e)
      { start: 21, end: 23, team: "sh" }, // sh(ore)
    ];
    const stages: GraphemeStages = { sh: "training", th: "fading" };
    const segments = toSegments(text, spans, stages);
    expect(concat(segments)).toBe(text);
  });

  test("round-trips regardless of stage mix", () => {
    const text = "Look at the sheep in the shade.";
    const spans: GraphemeSpan[] = [
      { start: 12, end: 14, team: "sh" },
      { start: 15, end: 17, team: "ee" },
      { start: 21, end: 23, team: "th" },
      { start: 25, end: 27, team: "sh" },
    ];
    for (const stages of [
      { sh: "training", ee: "training", th: "training" },
      { sh: "fading", ee: "graduated", th: "training" },
      {},
    ] as GraphemeStages[]) {
      expect(concat(toSegments(text, spans, stages))).toBe(text);
    }
  });
});

describe("toSegments — segment shape", () => {
  test("colored teams carry team + stage; gap text is plain", () => {
    const text = "the ship";
    const spans: GraphemeSpan[] = [
      { start: 0, end: 2, team: "th" },
      { start: 4, end: 6, team: "sh" },
    ];
    const segments = toSegments(text, spans, { th: "training", sh: "fading" });
    expect(segments).toEqual([
      { text: "th", team: "th", stage: "training" },
      { text: "e " },
      { text: "sh", team: "sh", stage: "fading" },
      { text: "ip" },
    ]);
  });

  test("no leading gap when a span starts at 0", () => {
    const segments = toSegments("ship", [{ start: 0, end: 2, team: "sh" }], { sh: "training" });
    expect(segments[0]).toEqual({ text: "sh", team: "sh", stage: "training" });
  });

  test("trailing text after the last span becomes a plain segment", () => {
    const segments = toSegments("shore", [{ start: 0, end: 2, team: "sh" }], { sh: "training" });
    expect(segments).toEqual([
      { text: "sh", team: "sh", stage: "training" },
      { text: "ore" },
    ]);
  });

  test("a span covering the whole string yields a single colored segment", () => {
    const segments = toSegments("sh", [{ start: 0, end: 2, team: "sh" }], { sh: "training" });
    expect(segments).toEqual([{ text: "sh", team: "sh", stage: "training" }]);
  });
});

describe("toSegments — graduated + unknown teams become plain ink", () => {
  test("explicitly graduated team renders as plain text", () => {
    const text = "the ship";
    const spans: GraphemeSpan[] = [
      { start: 0, end: 2, team: "th" },
      { start: 4, end: 6, team: "sh" },
    ];
    const segments = toSegments(text, spans, { th: "graduated", sh: "training" });
    // "th" graduated → merges into the plain run before "sh".
    expect(segments).toEqual([
      { text: "the " },
      { text: "sh", team: "sh", stage: "training" },
      { text: "ip" },
    ]);
  });

  test("team missing from the stages map defaults to graduated (plain)", () => {
    const segments = toSegments("ship", [{ start: 0, end: 2, team: "sh" }], {});
    expect(segments).toEqual([{ text: "ship" }]);
  });

  test("graduated-only fast path: whole string is one plain segment", () => {
    const text = "The ship is near the shore.";
    const spans: GraphemeSpan[] = [
      { start: 4, end: 6, team: "sh" },
      { start: 21, end: 23, team: "sh" },
    ];
    const segments = toSegments(text, spans, { sh: "graduated" });
    expect(segments).toEqual([{ text }]);
  });
});

describe("toSegments — empty inputs", () => {
  test("empty text yields no segments", () => {
    expect(toSegments("", [{ start: 0, end: 2, team: "sh" }], { sh: "training" })).toEqual([]);
  });

  test("empty spans list yields one plain segment of the whole text", () => {
    expect(toSegments("hello", [], { sh: "training" })).toEqual([{ text: "hello" }]);
  });
});

describe("toSegments — defensive range validation", () => {
  test("drops spans that run past the end of the text", () => {
    const segments = toSegments("ship", [{ start: 2, end: 99, team: "ip" }], { ip: "training" });
    expect(segments).toEqual([{ text: "ship" }]);
  });

  test("drops spans with negative start", () => {
    const segments = toSegments("ship", [{ start: -1, end: 2, team: "sh" }], { sh: "training" });
    expect(segments).toEqual([{ text: "ship" }]);
  });

  test("drops empty and negative-length spans", () => {
    const segments = toSegments(
      "ship",
      [
        { start: 2, end: 2, team: "x" }, // empty
        { start: 3, end: 1, team: "y" }, // negative length
      ],
      { x: "training", y: "training" },
    );
    expect(segments).toEqual([{ text: "ship" }]);
  });

  test("drops non-integer offsets", () => {
    const segments = toSegments("ship", [{ start: 0.5, end: 2, team: "sh" }], { sh: "training" });
    expect(segments).toEqual([{ text: "ship" }]);
  });

  test("keeps a valid span while dropping an invalid sibling", () => {
    const segments = toSegments(
      "the ship",
      [
        { start: 0, end: 2, team: "th" }, // valid
        { start: 4, end: 100, team: "sh" }, // out of range
      ],
      { th: "training", sh: "training" },
    );
    expect(segments).toEqual([
      { text: "th", team: "th", stage: "training" },
      { text: "e ship" },
    ]);
    expect(concat(segments)).toBe("the ship");
  });
});

describe("toSegments — overlap resolution (keep first, drop the rest)", () => {
  test("later overlapping span is dropped; earlier is kept", () => {
    const text = "abcdef";
    const spans: GraphemeSpan[] = [
      { start: 0, end: 3, team: "a" },
      { start: 2, end: 5, team: "b" }, // overlaps [0,3) → dropped
    ];
    const segments = toSegments(text, spans, { a: "training", b: "training" });
    expect(segments).toEqual([
      { text: "abc", team: "a", stage: "training" },
      { text: "def" },
    ]);
  });

  test("on identical start, the longer span wins", () => {
    const text = "abcdef";
    const spans: GraphemeSpan[] = [
      { start: 0, end: 2, team: "short" },
      { start: 0, end: 4, team: "long" },
    ];
    const segments = toSegments(text, spans, { short: "training", long: "training" });
    expect(segments).toEqual([
      { text: "abcd", team: "long", stage: "training" },
      { text: "ef" },
    ]);
  });

  test("adjacent (touching, non-overlapping) spans are both kept", () => {
    const text = "abcd";
    const spans: GraphemeSpan[] = [
      { start: 0, end: 2, team: "a" },
      { start: 2, end: 4, team: "b" },
    ];
    const segments = toSegments(text, spans, { a: "training", b: "fading" });
    expect(segments).toEqual([
      { text: "ab", team: "a", stage: "training" },
      { text: "cd", team: "b", stage: "fading" },
    ]);
  });

  test("input span order does not matter (sorted internally)", () => {
    const text = "the ship";
    const inOrder: GraphemeSpan[] = [
      { start: 0, end: 2, team: "th" },
      { start: 4, end: 6, team: "sh" },
    ];
    const reversed = [...inOrder].reverse();
    const stages: GraphemeStages = { th: "training", sh: "training" };
    expect(toSegments(text, inOrder, stages)).toEqual(toSegments(text, reversed, stages));
  });
});

describe("palette + color helpers", () => {
  test("teamColorIndex is deterministic and in range", () => {
    for (const team of ["sh", "th", "ea", "ee", "ay", "igh", "unknown-team"]) {
      const idx = teamColorIndex(team);
      expect(idx).toBeGreaterThanOrEqual(0);
      expect(idx).toBeLessThan(GRAPHEME_PALETTE.length);
      expect(teamColorIndex(team)).toBe(idx); // stable
    }
  });

  test("teamColor returns a palette hue", () => {
    expect(GRAPHEME_PALETTE).toContain(teamColor("sh"));
  });

  test("training stage is the full hue; fading blends toward the ink", () => {
    const full = teamColor("sh");
    expect(stageColor("sh", "training")).toBe(full);
    const faded = stageColor("sh", "fading");
    expect(faded).not.toBe(full);
    expect(faded).not.toBe(GRAPHEME_INK);
    expect(faded).toMatch(/^#[0-9a-f]{6}$/);
  });

  test("fading stays unmistakably chromatic (hue-preserving, not greyed out)", () => {
    // The whole point of the HSL fade over an RGB lerp toward the dark ink: a
    // fading team must still read as colored. Every palette hue's fade keeps a
    // healthy channel spread, well clear of the near-grey ink.
    for (const hue of GRAPHEME_PALETTE) {
      const faded = fadeTowardInk(hue);
      expect(faded).toMatch(/^#[0-9a-f]{6}$/);
      expect(chroma(faded)).toBeGreaterThan(chroma(GRAPHEME_INK));
      expect(chroma(faded)).toBeGreaterThan(80); // clearly colored, not muddy
    }
  });

  test("blendHex endpoints and midpoint", () => {
    expect(blendHex("#000000", "#ffffff", 0)).toBe("#000000");
    expect(blendHex("#000000", "#ffffff", 1)).toBe("#ffffff");
    expect(blendHex("#000000", "#ffffff", 0.5)).toBe("#808080");
  });

  test("blendHex clamps out-of-range amounts", () => {
    expect(blendHex("#000000", "#ffffff", -1)).toBe("#000000");
    expect(blendHex("#000000", "#ffffff", 2)).toBe("#ffffff");
  });
});
