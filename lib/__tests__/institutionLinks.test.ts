import { describe, expect, test } from "vitest";
import { canonicalInstitutionScope } from "../institutionLinks";

const institutions = [
  { slug: "moli", isPrimary: true },
  { slug: "kona", isPrimary: false },
];

describe("canonical institution select values", () => {
  test.each([
    ["an invalid scope", "retired-school"],
    ["a legacy institution id", "k57legacyid"],
  ])("uses the resolved school for School's %s", (_description, requestedScope) => {
    expect(
      canonicalInstitutionScope(requestedScope, {
        scope: "institution",
        institutionSlug: "kona",
      }, institutions, "institution"),
    ).toBe("kona");
  });

  test("keeps a valid requested slug as School's controlled value", () => {
    expect(
      canonicalInstitutionScope("kona", {
        scope: "institution",
        institutionSlug: "moli",
      }, institutions, "institution"),
    ).toBe("kona");
  });

  test("falls back to School's primary option when no canonical scope is available", () => {
    expect(
      canonicalInstitutionScope("all", {
        scope: "all",
        institutionSlug: null,
      }, institutions, "institution"),
    ).toBe("moli");
  });

  test.each(["", "all"])(
    "keeps Accounts' all-institutions semantics for %s",
    (requestedScope) => {
      expect(
        canonicalInstitutionScope(requestedScope, {
          scope: "institution",
          institutionSlug: "kona",
        }, institutions, "all"),
      ).toBe("");
    },
  );

  test.each([
    ["an invalid scope", "retired-school"],
    ["a legacy institution id", "k57legacyid"],
  ])("uses the resolved school for Accounts' %s", (_description, requestedScope) => {
    expect(
      canonicalInstitutionScope(requestedScope, {
        scope: "institution",
        institutionSlug: "kona",
      }, institutions, "all"),
    ).toBe("kona");
  });

  test("keeps Accounts' valid requested slug as the controlled value", () => {
    expect(
      canonicalInstitutionScope("kona", {
        scope: "institution",
        institutionSlug: "moli",
      }, institutions, "all"),
    ).toBe("kona");
  });
});
