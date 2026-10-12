import { describe, it, expect } from "vitest";
import { normalizeReflectionSections } from "../reflectionSections";

describe("normalizeReflectionSections", () => {
  it("keeps well-formed sections, trimmed", () => {
    expect(
      normalizeReflectionSections({
        sections: [
          { heading: "  The big idea  ", body: " Fractions name parts. " },
        ],
      }),
    ).toEqual([{ heading: "The big idea", body: "Fractions name parts." }]);
  });

  it("clamps to four sections", () => {
    const input = {
      sections: Array.from({ length: 7 }, (_, i) => ({
        heading: `H${i}`,
        body: `B${i}`,
      })),
    };
    expect(normalizeReflectionSections(input)).toHaveLength(4);
  });

  it("drops sections missing a heading or body", () => {
    expect(
      normalizeReflectionSections({
        sections: [
          { heading: "Kept", body: "Has both." },
          { heading: "", body: "No heading." },
          { heading: "No body", body: "   " },
          { heading: "No body at all" },
          null,
          "a bare string",
        ],
      }),
    ).toEqual([{ heading: "Kept", body: "Has both." }]);
  });

  // The bug this file exists for: the model returned `sections` as a STRING,
  // so `.slice(0, 4).map(...)` threw and the raw TypeError text reached a child.
  it("recovers a JSON-encoded sections array", () => {
    expect(
      normalizeReflectionSections({
        sections: JSON.stringify([{ heading: "Where this fits", body: "Ok." }]),
      }),
    ).toEqual([{ heading: "Where this fits", body: "Ok." }]);
  });

  it("returns [] for an unparseable string instead of throwing", () => {
    expect(
      normalizeReflectionSections({ sections: "The big idea: fractions" }),
    ).toEqual([]);
  });

  it("returns [] for missing, null, or non-array sections", () => {
    expect(normalizeReflectionSections({})).toEqual([]);
    expect(normalizeReflectionSections({ sections: null })).toEqual([]);
    expect(normalizeReflectionSections({ sections: 42 })).toEqual([]);
    expect(normalizeReflectionSections({ sections: { heading: "x" } })).toEqual(
      [],
    );
    expect(normalizeReflectionSections(null)).toEqual([]);
    expect(normalizeReflectionSections("nope")).toEqual([]);
  });
});
