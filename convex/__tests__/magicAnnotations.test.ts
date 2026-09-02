import { describe, expect, test } from "vitest";
import {
  parseDetection,
  buildEditInstruction,
  stripFences,
  MAGIC_CONFIDENCE_THRESHOLD,
} from "../lib/magicAnnotations";
import { detectImageMime } from "../lib/imageBytes";

// Pure tests for the Magic Annotations logic — the prompt/parse/instruction
// helpers that ship into prod unchanged. No models, no ctx, no deployment.

describe("parseDetection", () => {
  test("parses a single confident region from the regions array", () => {
    const d = parseDetection(
      JSON.stringify({
        regions: [
          { instruction: "a fire-breathing red dragon over a castle", confidence: 0.92 },
        ],
      }),
    );
    expect(d).toEqual({
      present: true,
      kind: "corners",
      regions: [{ instruction: "a fire-breathing red dragon over a castle", confidence: 0.92 }],
    });
  });

  // The core fix: a page with two framed regions must yield BOTH regions, not
  // just the first. This is exactly the "only filled one of the two" bug.
  test("parses MULTIPLE regions on one page (the multi-frame bug)", () => {
    const d = parseDetection(
      JSON.stringify({
        regions: [
          { instruction: "a shark eating a fish", confidence: 0.88 },
          { instruction: "water flowing down into a plant's roots", confidence: 0.9 },
        ],
      }),
    );
    expect(d.present).toBe(true);
    expect(d.kind).toBe("corners");
    expect(d.regions).toEqual([
      { instruction: "a shark eating a fish", confidence: 0.88 },
      { instruction: "water flowing down into a plant's roots", confidence: 0.9 },
    ]);
  });

  test("drops regions without a usable instruction but keeps the valid ones", () => {
    const d = parseDetection(
      JSON.stringify({
        regions: [
          { instruction: "  ", confidence: 0.9 },
          { instruction: "a dog", confidence: 0.7 },
          { confidence: 0.95 },
        ],
      }),
    );
    expect(d.regions).toEqual([{ instruction: "a dog", confidence: 0.7 }]);
  });

  test("strips ```json fences before parsing", () => {
    const d = parseDetection(
      "```json\n" +
        JSON.stringify({ regions: [{ instruction: "a cat", confidence: 0.8 }] }) +
        "\n```",
    );
    expect(d.present).toBe(true);
    expect(d.regions[0].instruction).toBe("a cat");
  });

  test("an empty regions array collapses to a clean miss", () => {
    const d = parseDetection(JSON.stringify({ regions: [] }));
    expect(d).toEqual({ present: false, kind: null, regions: [] });
  });

  test("tolerates the legacy single-object shape (regions absent)", () => {
    const d = parseDetection(
      JSON.stringify({
        present: true,
        kind: "corners",
        instruction: "a smiling sun",
        confidence: 0.81,
      }),
    );
    expect(d.present).toBe(true);
    expect(d.regions).toEqual([{ instruction: "a smiling sun", confidence: 0.81 }]);
  });

  test("legacy single-object shape with no instruction is a miss", () => {
    const d = parseDetection(
      JSON.stringify({ present: false, kind: null, instruction: null, confidence: 0.1 }),
    );
    expect(d).toEqual({ present: false, kind: null, regions: [] });
  });

  test("malformed JSON degrades to a miss, never throws", () => {
    expect(parseDetection("not json at all")).toEqual({
      present: false,
      kind: null,
      regions: [],
    });
    expect(parseDetection("")).toEqual({
      present: false,
      kind: null,
      regions: [],
    });
  });

  test("clamps out-of-range per-region confidence into [0,1]", () => {
    const hi = parseDetection(JSON.stringify({ regions: [{ instruction: "x", confidence: 5 }] }));
    expect(hi.regions[0].confidence).toBe(1);
    const lo = parseDetection(JSON.stringify({ regions: [{ instruction: "x", confidence: -3 }] }));
    expect(lo.regions[0].confidence).toBe(0);
    const nan = parseDetection(JSON.stringify({ regions: [{ instruction: "x", confidence: "z" }] }));
    expect(nan.regions[0].confidence).toBe(0);
  });
});

describe("stripFences", () => {
  test("removes json fences and trims", () => {
    expect(stripFences("```json\n{\"a\":1}\n```")).toBe('{"a":1}');
    expect(stripFences("```\n{\"a\":1}\n```")).toBe('{"a":1}');
    expect(stripFences('  {"a":1}  ')).toBe('{"a":1}');
  });
});

describe("buildEditInstruction", () => {
  test("single region: embeds the instruction and the whole-image-edit guardrails", () => {
    const out = buildEditInstruction(["a smiling sun"]);
    expect(out).toContain("a smiling sun");
    expect(out).toContain("ONLY the area inside the frame");
    expect(out).toContain("Remove the corner brackets");
    expect(out).toContain("Leave everything outside the frame");
    // Single-frame prose shouldn't claim a count.
    expect(out).not.toContain("separate hand-drawn");
  });

  test("multiple regions: enumerates every frame and tells the model not to skip any", () => {
    const out = buildEditInstruction(["a shark eating a fish", "water flowing into roots"]);
    expect(out).toContain("2 separate hand-drawn rectangular frames");
    expect(out).toContain("Frame 1: a shark eating a fish");
    expect(out).toContain("Frame 2: water flowing into roots");
    expect(out).toContain("redraw EVERY one of them");
    expect(out).toContain("Remove the corner brackets");
  });
});

describe("MAGIC_CONFIDENCE_THRESHOLD", () => {
  test("is a sane probability", () => {
    expect(MAGIC_CONFIDENCE_THRESHOLD).toBeGreaterThan(0);
    expect(MAGIC_CONFIDENCE_THRESHOLD).toBeLessThan(1);
  });
});

describe("detectImageMime", () => {
  test("sniffs jpeg/png/gif/webp from magic bytes", () => {
    expect(detectImageMime(new Uint8Array([0xff, 0xd8, 0xff]))).toBe("image/jpeg");
    expect(detectImageMime(new Uint8Array([0x89, 0x50, 0x4e, 0x47]))).toBe("image/png");
    expect(detectImageMime(new Uint8Array([0x47, 0x49, 0x46]))).toBe("image/gif");
    // "RIFF" + 4-byte size + "WEBP" — a full 12-byte header (the "WEBP" tag at
    // offset 8 means a real file is always at least this long).
    const webp = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]);
    expect(detectImageMime(webp)).toBe("image/webp");
  });

  test("a too-short RIFF (truncated, < 12 bytes) is not mis-detected as webp", () => {
    expect(detectImageMime(new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57]))).toBe(
      "image/jpeg",
    );
  });

  test("uses the fallback when nothing matches", () => {
    expect(detectImageMime(new Uint8Array([0, 1, 2, 3]))).toBe("image/jpeg");
    expect(detectImageMime(new Uint8Array([0, 1, 2, 3]), "image/png")).toBe("image/png");
  });

  test("corrects a mislabeled declared type (the scanner-ingest 400 bug)", () => {
    // JPEG bytes that a picker declared as image/png — the real cause of the
    // "image appears to be a image/jpeg image" Claude 400 during ingest. The
    // byte sniff must win over the (wrong) declared fallback.
    const jpegBytes = new Uint8Array([0xff, 0xd8, 0xff, 0xe0]);
    expect(detectImageMime(jpegBytes, "image/png")).toBe("image/jpeg");
  });
});
