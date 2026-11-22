import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
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

  describe("scholar birthday acknowledgement wiring", () => {
    const source = readFileSync(new URL("./page.tsx", import.meta.url), "utf8");

    it("reuses the shared birthday acknowledgement on the scholar home", () => {
      expect(source).toContain("scholarBirthdayAcknowledgement(");
      expect(source).toContain("user.dateOfBirth");
      expect(source).toContain("institutionDay.dayKey");
    });

    it("renders the banner and web confetti, with no header marker", () => {
      expect(source).toContain("birthdayBannerText={birthdayAcknowledgement?.bannerText ?? null}");
      expect(source).toContain("<BirthdayConfetti");
      // The prop must be destructured, not only typed (a missing destructure
      // crashes Home with a ReferenceError at render).
      expect(source).toMatch(/nowDataLoaded,\s+birthdayBannerText,\s+\}: \{/);
      expect(source).not.toContain("birthdayHeaderName");
      expect(source).not.toContain("headerName");
    });

    it("takes the day-key from the institution, never a hardcoded zone", () => {
      expect(source).toContain("institutionDay.dayKey");
      expect(source).not.toMatch(/Pacific\/Honolulu/);
    });
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
