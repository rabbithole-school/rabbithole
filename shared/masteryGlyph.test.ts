import { describe, expect, it } from "vitest";
import { MASTERY_GLYPH_KIND } from "./masteryGlyph";

describe("MASTERY_GLYPH_KIND", () => {
  it("keeps the mastery-state shape vocabulary stable", () => {
    expect(MASTERY_GLYPH_KIND).toEqual({
      locked: "bar",
      placed: "none",
      frontier: "dot",
      fluent: "check",
      struggling: "cross",
      overlearned: "star",
    });
  });
});
