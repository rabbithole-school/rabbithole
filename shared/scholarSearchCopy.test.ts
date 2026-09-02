import { describe, it, expect } from "vitest";
import { noScholarMatchCopy } from "./scholarSearchCopy";

describe("noScholarMatchCopy", () => {
  it("names the institution and nudges toward an admin in single-institution scope", () => {
    const copy = noScholarMatchCopy({
      institutionName: "Moli School",
      scope: "institution",
    });
    expect(copy).toBe(
      "No scholar named that at Moli School. If you expected them here, check with an admin.",
    );
  });

  it("keeps the palette honest about its dual scholar+curriculum scope", () => {
    const copy = noScholarMatchCopy({
      institutionName: "Moli School",
      scope: "institution",
      includesCurriculum: true,
    });
    expect(copy).toBe(
      "Nothing by that name at Moli School. If you expected a scholar here, check with an admin.",
    );
  });

  it("is generic with no institution name when scope is 'all'", () => {
    expect(
      noScholarMatchCopy({ institutionName: "Moli School", scope: "all" }),
    ).toBe("No scholar named that.");
    expect(
      noScholarMatchCopy({
        institutionName: "Moli School",
        scope: "all",
        includesCurriculum: true,
      }),
    ).toBe("Nothing by that name.");
  });

  it("falls back to generic copy when the institution name is not yet known", () => {
    expect(
      noScholarMatchCopy({ institutionName: null, scope: "institution" }),
    ).toBe("No scholar named that.");
  });

  it("never discloses the scholar exists elsewhere or names a foreign institution", () => {
    // Privacy boundary: whatever the args, the output must never imply the
    // scholar exists in another institution, and must never contain any
    // institution name other than the one in view.
    const foreignInstitution = "Kealoha Academy";
    const cases = [
      noScholarMatchCopy({ institutionName: "Moli School", scope: "institution" }),
      noScholarMatchCopy({
        institutionName: "Moli School",
        scope: "institution",
        includesCurriculum: true,
      }),
      noScholarMatchCopy({ institutionName: "Moli School", scope: "all" }),
      noScholarMatchCopy({ institutionName: null, scope: "institution" }),
    ];
    for (const copy of cases) {
      expect(copy.toLowerCase()).not.toContain("exist");
      expect(copy.toLowerCase()).not.toContain("another institution");
      expect(copy.toLowerCase()).not.toContain("elsewhere");
      expect(copy.toLowerCase()).not.toContain("other school");
      expect(copy).not.toContain(foreignInstitution);
    }
  });
});
