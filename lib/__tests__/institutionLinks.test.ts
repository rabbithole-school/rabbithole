import { describe, expect, test } from "vitest";
import { canonicalInstitutionScope } from "../institutionLinks";

const institutions = [
  { slug: "moli", isPrimary: true },
  { slug: "kona", isPrimary: false },
  // Still listed by `institutions.listForStaff`, but suspended — the lens
  // filters it out of its candidates, so it can never resolve.
  { slug: "paused-school", isPrimary: false },
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
        honored: false,
      }, institutions, "institution"),
    ).toBe("kona");
  });

  test("keeps a valid requested slug as School's controlled value", () => {
    expect(
      canonicalInstitutionScope("kona", {
        scope: "institution",
        institutionSlug: "moli",
        honored: true,
      }, institutions, "institution"),
    ).toBe("kona");
  });

  test("falls back to School's primary option when no canonical scope is available", () => {
    expect(
      canonicalInstitutionScope("all", {
        scope: "all",
        institutionSlug: null,
        honored: true,
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
          honored: true,
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
        honored: false,
      }, institutions, "all"),
    ).toBe("kona");
  });

  test("keeps Accounts' valid requested slug as the controlled value", () => {
    expect(
      canonicalInstitutionScope("kona", {
        scope: "institution",
        institutionSlug: "moli",
        honored: true,
      }, institutions, "all"),
    ).toBe("kona");
  });

  // An unhonored scope is the dangerous case: the lens silently scoped the page
  // to the home school, so naming the requested school in the picker would tell
  // an operator they are reading a school whose data is not on screen.
  test.each(["institution", "all"] as const)(
    "shows the resolved school when a listed-but-unresolvable scope is requested (%s mode)",
    (mode) => {
      expect(
        canonicalInstitutionScope(
          "paused-school",
          {
            scope: "institution",
            institutionSlug: "kona",
            honored: false,
          },
          institutions,
          mode,
        ),
      ).toBe("kona");
    },
  );

  test("keeps the requested scope while the lens query is still loading", () => {
    expect(
      canonicalInstitutionScope("kona", undefined, institutions, "institution"),
    ).toBe("kona");
  });
});
