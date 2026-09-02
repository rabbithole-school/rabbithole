import { describe, expect, test } from "vitest";
import {
  practiceDomainForConcept,
  practiceHrefForConcept,
  practiceHrefForDomain,
} from "../practiceDomainForConcept";
import { WHOLE_NUMBER_ARITHMETIC_DOMAIN } from "@/convex/seed/wholeNumberArithmeticGraph";
import { FRACTION_ARITHMETIC_DOMAIN } from "@/convex/seed/fractionArithmeticGraph";

describe("practiceDomainForConcept", () => {
  test("a known display domain resolves to its practice domain key", () => {
    expect(practiceDomainForConcept("Mathematics")).toBe(
      WHOLE_NUMBER_ARITHMETIC_DOMAIN,
    );
  });

  test("matching is case-insensitive and trims whitespace", () => {
    expect(practiceDomainForConcept("mathematics")).toBe(
      WHOLE_NUMBER_ARITHMETIC_DOMAIN,
    );
    expect(practiceDomainForConcept("  MATHEMATICS  ")).toBe(
      WHOLE_NUMBER_ARITHMETIC_DOMAIN,
    );
  });

  test("an unknown domain (no practice engine yet) resolves to null", () => {
    expect(practiceDomainForConcept("Biology")).toBeNull();
    expect(practiceDomainForConcept("History")).toBeNull();
    expect(practiceDomainForConcept("general")).toBeNull();
  });

  test("empty/missing domain resolves to null", () => {
    expect(practiceDomainForConcept("")).toBeNull();
    expect(practiceDomainForConcept(undefined)).toBeNull();
    expect(practiceDomainForConcept(null)).toBeNull();
  });
});

describe("practiceHrefForConcept", () => {
  test("a known domain produces the practice drill href", () => {
    expect(practiceHrefForConcept("Mathematics")).toBe(
      `/scholar/practice?domain=${WHOLE_NUMBER_ARITHMETIC_DOMAIN}`,
    );
  });

  test("an unknown domain produces no link at all", () => {
    expect(practiceHrefForConcept("Anthropology")).toBeNull();
  });
});

describe("practiceHrefForDomain (stamped on-ramp target)", () => {
  test("a real practice-domain slug produces the drill href directly", () => {
    // The fractions on-ramp: a "Mathematics" star would resolve to whole-number
    // via the allowlist, but a stamped fraction-arithmetic slug routes there.
    expect(practiceHrefForDomain(FRACTION_ARITHMETIC_DOMAIN)).toBe(
      `/scholar/practice?domain=${FRACTION_ARITHMETIC_DOMAIN}`,
    );
    expect(practiceHrefForDomain(WHOLE_NUMBER_ARITHMETIC_DOMAIN)).toBe(
      `/scholar/practice?domain=${WHOLE_NUMBER_ARITHMETIC_DOMAIN}`,
    );
  });

  test("does NOT consult the display-domain allowlist — takes the slug as-is", () => {
    // "probability" isn't in the allowlist, but it IS a real drill domain, so a
    // stamped slug must still route (the whole point of the stamp override).
    expect(practiceHrefForDomain("probability")).toBe(
      "/scholar/practice?domain=probability",
    );
  });

  test("empty/missing slug produces no link", () => {
    expect(practiceHrefForDomain("")).toBeNull();
    expect(practiceHrefForDomain(null)).toBeNull();
    expect(practiceHrefForDomain(undefined)).toBeNull();
  });
});
