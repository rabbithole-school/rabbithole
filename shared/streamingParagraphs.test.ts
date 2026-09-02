import { describe, it, expect } from "vitest";
import { segmentParagraphs } from "./streamingParagraphs";

describe("segmentParagraphs", () => {
  it("returns a single segment for blank-line-free content", () => {
    expect(segmentParagraphs("Hello world")).toEqual([{ start: 0, text: "Hello world" }]);
  });

  it("keeps single newlines inside a paragraph (no split)", () => {
    // A single `\n` is a line break within a paragraph, not a paragraph break.
    expect(segmentParagraphs("line one\nline two")).toEqual([
      { start: 0, text: "line one\nline two" },
    ]);
  });

  it("splits on a blank line and reports each paragraph's global offset", () => {
    const segs = segmentParagraphs("First para.\n\nSecond para.");
    expect(segs).toEqual([
      { start: 0, text: "First para." },
      { start: 13, text: "Second para." },
    ]);
    // Offsets must index straight back into the source (the char after `\n\n`).
    expect("First para.\n\nSecond para.".slice(segs[1].start)).toBe("Second para.");
  });

  it("treats a run of 3+ newlines as one separator", () => {
    const segs = segmentParagraphs("A\n\n\n\nB");
    expect(segs).toEqual([
      { start: 0, text: "A" },
      { start: 5, text: "B" },
    ]);
  });

  it("collapses leading and trailing blank runs", () => {
    expect(segmentParagraphs("\n\nOnly.\n\n")).toEqual([{ start: 2, text: "Only." }]);
  });

  it("handles three paragraphs with correct offsets", () => {
    const src = "one\n\ntwo\n\nthree";
    const segs = segmentParagraphs(src);
    expect(segs.map((s) => s.text)).toEqual(["one", "two", "three"]);
    for (const s of segs) expect(src.slice(s.start, s.start + s.text.length)).toBe(s.text);
  });

  it("returns nothing for empty or all-blank content", () => {
    expect(segmentParagraphs("")).toEqual([]);
    expect(segmentParagraphs("\n\n\n")).toEqual([]);
  });
});
