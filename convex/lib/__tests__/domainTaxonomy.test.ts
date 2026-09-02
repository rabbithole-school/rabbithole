import { describe, expect, test } from "vitest";
import { classifyDomain, WAYS_OF_THINKING } from "../domainTaxonomy";

describe("classifyDomain", () => {
  test("dup-merges the math spellings to Mathematics", () => {
    for (const raw of ["Math", "Mathematics", "mathematics", "  MATHEMATICS "]) {
      expect(classifyDomain(raw)).toEqual({ domain: "Mathematics" });
    }
  });

  test("dup-merges ELA / ELA/Literacy", () => {
    expect(classifyDomain("ELA")).toEqual({ domain: "ELA/Literacy" });
    expect(classifyDomain("ela/literacy")).toEqual({ domain: "ELA/Literacy" });
  });

  test("un-flattens the ELA strands to domain ELA/Literacy + strand", () => {
    expect(classifyDomain("Reading")).toEqual({ domain: "ELA/Literacy", strand: "Reading" });
    expect(classifyDomain("Writing")).toEqual({ domain: "ELA/Literacy", strand: "Writing" });
    expect(classifyDomain("Language")).toEqual({ domain: "ELA/Literacy", strand: "Language" });
    expect(classifyDomain("Speaking & Listening")).toEqual({
      domain: "ELA/Literacy",
      strand: "Speaking & Listening",
    });
  });

  test("routes Historical Thinking (any case) to the Ways of Thinking umbrella", () => {
    for (const raw of ["Historical Thinking", "Historical thinking", "historical thinking"]) {
      expect(classifyDomain(raw)).toEqual({
        domain: WAYS_OF_THINKING,
        strand: "Historical Thinking",
      });
    }
  });

  test("nests curated Fractions under Mathematics as a strand", () => {
    expect(classifyDomain("Fractions")).toEqual({ domain: "Mathematics", strand: "Fractions" });
  });

  test("leaves Science as a bare content subject", () => {
    expect(classifyDomain("Science")).toEqual({ domain: "Science" });
  });

  test("PASSES THROUGH the practice-engine domain slug untouched (domain AND strand)", () => {
    expect(classifyDomain("whole-number-arithmetic")).toEqual({
      domain: "whole-number-arithmetic",
    });
    // a practice node's own strand must be preserved
    expect(classifyDomain("whole-number-arithmetic", "counting")).toEqual({
      domain: "whole-number-arithmetic",
      strand: "counting",
    });
    // INVARIANT: practice domains must be kebab slugs distinct from atlas words —
    // e.g. Wave D fractions should be "fraction-arithmetic", NOT "fractions"
    // (which the atlas maps to Mathematics/Fractions under case-folding). A kebab
    // slug is unknown to the taxonomy → passthrough.
    expect(classifyDomain("fraction-arithmetic")).toEqual({ domain: "fraction-arithmetic" });
  });

  test("drops a raw strand that is only a subject-synonym (coarse 'Math' label)", () => {
    // strandForStandard emits label "Math" for math standards — not a real
    // sub-strand under Mathematics, so it must be dropped, not kept.
    expect(classifyDomain("Mathematics", "Math")).toEqual({ domain: "Mathematics" });
  });

  test("keeps a real derived strand when the subject is passed with it", () => {
    // go-forward atlas build path: subject + derived ELA strand
    expect(classifyDomain("ELA/Literacy", "Reading")).toEqual({
      domain: "ELA/Literacy",
      strand: "Reading",
    });
  });

  test("is idempotent (classify∘classify == classify)", () => {
    for (const raw of ["Math", "Reading", "Historical thinking", "whole-number-arithmetic", "Science"]) {
      const once = classifyDomain(raw);
      const twice = classifyDomain(once.domain, once.strand);
      expect(twice).toEqual(once);
    }
  });
});
