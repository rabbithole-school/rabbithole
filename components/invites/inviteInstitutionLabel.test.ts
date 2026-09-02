import { describe, expect, test } from "vitest";
import { createdInstitutionLabel } from "./inviteInstitutionLabel";

describe("createdInstitutionLabel", () => {
  test("preserves a named institution", () => {
    expect(createdInstitutionLabel("Moli School")).toBe("Moli School");
  });

  test("labels a deleted institution without leaving a blank", () => {
    expect(createdInstitutionLabel(null)).toBe("Deleted school");
  });
});
