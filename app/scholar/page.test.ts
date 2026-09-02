import { describe, expect, it } from "vitest";
import { findPendingHighlightChoice } from "./page";

const fractions = {
  domain: "fractions",
  domainLabel: "Fractions",
  strand: "equivalence",
  sampleSkillKey: "fraction-equivalence",
  sampleSkillLabel: "Equivalent fractions",
};

describe("findPendingHighlightChoice", () => {
  it("preserves a delayed deep-link match before the scholar chooses", () => {
    expect(findPendingHighlightChoice("fractions", null, [])).toBeNull();
    expect(findPendingHighlightChoice("fractions", null, [fractions])).toEqual(fractions);
  });

  it.each(["strand", "domain", "Stretch"])(
    "does not apply a delayed match after a manual %s chooser interaction",
    () => {
      // The page records the URL target synchronously in each manual callback,
      // before its asynchronous choice-card query can return this match.
      expect(findPendingHighlightChoice("fractions", "fractions", [])).toBeNull();
      expect(findPendingHighlightChoice("fractions", "fractions", [fractions])).toBeNull();
    },
  );
});
