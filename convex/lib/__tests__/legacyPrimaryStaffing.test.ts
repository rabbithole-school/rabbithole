import { describe, expect, test } from "vitest";
import type { Id } from "../../_generated/dataModel";
import { usesLegacyPrimaryStaffing } from "../access";

const school = "inst_1" as Id<"institutions">;

describe("usesLegacyPrimaryStaffing", () => {
  test("an institution staff role with no scoped staff membership falls back to the primary school", () => {
    expect(usesLegacyPrimaryStaffing({ role: "school_admin" }, [])).toBe(true);
    expect(usesLegacyPrimaryStaffing({ role: "teacher" }, [{ role: "parent", institutionId: school }])).toBe(true);
    expect(usesLegacyPrimaryStaffing({ role: "staff" }, [{ role: "teacher", institutionId: undefined }])).toBe(true);
  });

  test("any scoped teacher / school_admin / staff membership ends the fallback", () => {
    for (const role of ["teacher", "school_admin", "staff"] as const) {
      expect(usesLegacyPrimaryStaffing({ role: "school_admin" }, [{ role, institutionId: school }])).toBe(false);
    }
  });

  test("global or non-staff roles never use it", () => {
    expect(usesLegacyPrimaryStaffing({ role: "platform_admin" }, [])).toBe(false);
    expect(usesLegacyPrimaryStaffing({ role: "curriculum_designer" }, [])).toBe(false);
    expect(usesLegacyPrimaryStaffing({ role: "parent" }, [])).toBe(false);
  });
});
