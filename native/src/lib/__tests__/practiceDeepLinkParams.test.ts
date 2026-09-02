import { describe, expect, it } from "vitest";

import { parsePracticeDeepLinkParams } from "../practiceDeepLinkParams";

// Guards the native practice route's URL param contract — the thing that broke
// on native deep links (`?domain=` dropped). Mirrors the web reference
// app/scholar/practice/page.tsx (domain/choiceDomain slug resolution + the
// stretch flag), and pins the `?stretch=1` (web) ⟷ `?stretchHint=1` (native)
// alias so a web-style deep link is honored on iPad.
describe("parsePracticeDeepLinkParams", () => {
  it("resolves a registered ?domain= slug", () => {
    expect(parsePracticeDeepLinkParams({ domain: "fraction-arithmetic" }).domain).toBe(
      "fraction-arithmetic",
    );
    expect(parsePracticeDeepLinkParams({ domain: "probability" }).domain).toBe("probability");
  });

  it("resolves a natural-language ?domain= alias", () => {
    expect(parsePracticeDeepLinkParams({ domain: "fractions" }).domain).toBe(
      "fraction-arithmetic",
    );
    expect(parsePracticeDeepLinkParams({ domain: "Fractions" }).domain).toBe(
      "fraction-arithmetic",
    );
  });

  it("treats an unknown ?domain= as no domain (never a whole-number restart)", () => {
    expect(parsePracticeDeepLinkParams({ domain: "not-a-real-domain" }).domain).toBeUndefined();
    expect(parsePracticeDeepLinkParams({}).domain).toBeUndefined();
  });

  it("accepts the stretch tail under BOTH ?stretch=1 (web) and ?stretchHint=1 (native)", () => {
    expect(parsePracticeDeepLinkParams({ stretch: "1" }).isStretch).toBe(true);
    expect(parsePracticeDeepLinkParams({ stretchHint: "1" }).isStretch).toBe(true);
    expect(parsePracticeDeepLinkParams({}).isStretch).toBe(false);
    expect(parsePracticeDeepLinkParams({ stretch: "0" }).isStretch).toBe(false);
  });

  it("resolves choiceDomain to a slug and passes choiceStrand through", () => {
    const parsed = parsePracticeDeepLinkParams({
      choiceDomain: "fractions",
      choiceStrand: "add_subtract_unlike",
    });
    expect(parsed.choiceDomain).toBe("fraction-arithmetic");
    expect(parsed.choiceStrand).toBe("add_subtract_unlike");
  });

  it("passes an exact skill scope through and trims empty values", () => {
    expect(parsePracticeDeepLinkParams({ skill: "  fraction_add_like  " }).skillKey).toBe(
      "fraction_add_like",
    );
    expect(parsePracticeDeepLinkParams({ skill: "  " }).skillKey).toBeUndefined();
    expect(parsePracticeDeepLinkParams({}).skillKey).toBeUndefined();
  });

  it("builds a NUL-joined domainSetKey for a mixed (repeated) ?domains= param", () => {
    expect(
      parsePracticeDeepLinkParams({ domains: ["fraction-arithmetic", "probability"] }).domainSetKey,
    ).toBe("fraction-arithmetic\u0000probability");
    // A single value stays a single-element key (no split churn downstream).
    expect(parsePracticeDeepLinkParams({ domains: "probability" }).domainSetKey).toBe("probability");
    expect(parsePracticeDeepLinkParams({}).domainSetKey).toBe("");
  });

  it("collapses a repeated scalar param (string[]) to its first value", () => {
    // expo-router hands a duplicated query key back as an array.
    expect(
      parsePracticeDeepLinkParams({ domain: ["fraction-arithmetic", "probability"] }).domain,
    ).toBe("fraction-arithmetic");
    expect(parsePracticeDeepLinkParams({ stretch: ["1"] }).isStretch).toBe(true);
  });
  // --- foldsMappingBand: the `· mapping` fold decision ---------------------
  // Native used to pass includeMapping on EVERY non-stretch run, which defeated
  // ?domain= outright (the served playlist leads with the cross-domain mapping
  // band, so a fraction deep link served whole-number items). These lock in the
  // web parity: app/scholar/practice/page.tsx folds mapping for the default
  // playlist and for a You-Pick tile, never for a bare ?domain=.

  it("does NOT fold the mapping band for a bare ?domain= deep link", () => {
    // The bug this guards: a fraction-arithmetic deep link that served
    // whole-number mapping items, indistinguishable from a dropped param.
    expect(parsePracticeDeepLinkParams({ domain: "fraction-arithmetic" }).foldsMappingBand).toBe(
      false,
    );
    // Same for the knowledge tree's NodeSheet entry (also a bare ?domain=).
    expect(parsePracticeDeepLinkParams({ domain: "probability" }).foldsMappingBand).toBe(false);
  });

  it("folds the mapping band for the daily playlist (?blend=1)", () => {
    expect(
      parsePracticeDeepLinkParams({ domain: "fraction-arithmetic", blend: "1" }).foldsMappingBand,
    ).toBe(true);
    expect(
      parsePracticeDeepLinkParams({ domains: ["whole-number-arithmetic", "probability"], blend: "1" })
        .foldsMappingBand,
    ).toBe(true);
  });

  it("folds the mapping band for a bare /practice with no domain at all", () => {
    expect(parsePracticeDeepLinkParams({}).foldsMappingBand).toBe(true);
  });

  it("folds the mapping band for a You-Pick tile serving the picked domain", () => {
    // Mirrors web: choiceDomain === resolvedDomain (an out-of-set pick).
    expect(
      parsePracticeDeepLinkParams({
        domain: "fraction-arithmetic",
        choiceDomain: "fraction-arithmetic",
        choiceStrand: "add_subtract_unlike",
      }).foldsMappingBand,
    ).toBe(true);
    // A choiceHint layered on a DIFFERENT explicit domain must not fold.
    expect(
      parsePracticeDeepLinkParams({
        domain: "probability",
        choiceDomain: "fraction-arithmetic",
        choiceStrand: "add_subtract_unlike",
      }).foldsMappingBand,
    ).toBe(false);
  });

  it("does NOT fold for an external mixed ?domains= deep link without ?blend=", () => {
    // A pinned/explicit domain set is web's standing-assignment case
    // (includeMapping = false), not the default blend.
    expect(
      parsePracticeDeepLinkParams({ domains: ["fraction-arithmetic", "probability"] })
        .foldsMappingBand,
    ).toBe(false);
  });

  // --- checkInAllDomains: the finish-the-check-in accelerator (PR2) --------
  // `?checkin=all` — CheckInHomeCard's link — revives the standalone
  // multi-domain orchestrator for the TRUE default (no-pin, no choice-tile)
  // entry only, mirroring web's `checkInAllDomains` precedence exactly
  // (app/scholar/practice/page.tsx's final `else` branch).

  it("requests the multi-domain check-in for a bare /practice?checkin=all", () => {
    const parsed = parsePracticeDeepLinkParams({ checkin: "all" });
    expect(parsed.checkInAllDomains).toBe(true);
    // The standalone check-in REPLACES the ambient mapping band, never stacks.
    expect(parsed.foldsMappingBand).toBe(false);
  });

  it("requests the multi-domain check-in for the daily playlist's own ?blend=1&checkin=all", () => {
    const parsed = parsePracticeDeepLinkParams({
      domain: "fraction-arithmetic",
      blend: "1",
      checkin: "all",
    });
    expect(parsed.checkInAllDomains).toBe(true);
    expect(parsed.foldsMappingBand).toBe(false);
  });

  it("ignores ?checkin= on an explicit bare ?domain= deep link", () => {
    // A deep link to a specific domain is never the default blend entry.
    expect(
      parsePracticeDeepLinkParams({ domain: "fraction-arithmetic", checkin: "all" })
        .checkInAllDomains,
    ).toBe(false);
  });

  it("ignores ?checkin= on a You-Pick tile even if it happens to blend", () => {
    expect(
      parsePracticeDeepLinkParams({
        domain: "fraction-arithmetic",
        blend: "1",
        choiceDomain: "fraction-arithmetic",
        choiceStrand: "add_subtract_unlike",
        checkin: "all",
      }).checkInAllDomains,
    ).toBe(false);
  });

  it("requires the exact value 'all' (any other value is a no-op, matching web)", () => {
    expect(parsePracticeDeepLinkParams({ checkin: "1" }).checkInAllDomains).toBe(false);
    expect(parsePracticeDeepLinkParams({}).checkInAllDomains).toBe(false);
  });

  it("defaults false and still folds mapping when checkin is absent", () => {
    const parsed = parsePracticeDeepLinkParams({});
    expect(parsed.checkInAllDomains).toBe(false);
    expect(parsed.foldsMappingBand).toBe(true);
  });

  it("gives ?quickFacts=1 precedence over every other practice route hint", () => {
    const parsed = parsePracticeDeepLinkParams({
      quickFacts: "1",
      domain: "fractions",
      domains: ["probability", "geometry"],
      choiceDomain: "probability",
      choiceStrand: "conditional",
      skill: "fraction_add_like",
      stretch: "1",
      stretchHint: "1",
      blend: "1",
      checkin: "all",
    });
    expect(parsed.quickFacts).toBe(true);
    expect(parsed.domain).toBeUndefined();
    expect(parsed.domainSetKey).toBe("");
    expect(parsed.choiceDomain).toBeUndefined();
    expect(parsed.choiceStrand).toBeUndefined();
    expect(parsed.skillKey).toBeUndefined();
    expect(parsed.isStretch).toBe(false);
    expect(parsed.checkInAllDomains).toBe(false);
    expect(parsed.foldsMappingBand).toBe(false);
  });

  it("only enables direct Quick-facts routing for the exact value 1", () => {
    expect(parsePracticeDeepLinkParams({ quickFacts: "0" }).quickFacts).toBe(false);
    expect(parsePracticeDeepLinkParams({ quickFacts: "true" }).quickFacts).toBe(false);
  });
});
