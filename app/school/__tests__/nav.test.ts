import { describe, expect, test } from "vitest";
import { NAV, firstVisibleNavHref, isNavItemVisible, isStaffRoleForSchool } from "../nav";

const labels = (
  role: string,
  hasCaptureReviewAccess = false,
  hasSchoolOperationsAccess = false,
  hasHealthManagementAccess = false,
) => NAV.filter((item) =>
  isNavItemVisible(
    item,
    role,
    hasCaptureReviewAccess,
    hasSchoolOperationsAccess,
    hasHealthManagementAccess,
  ),
).map((item) => item.label);

describe("school shell entry", () => {
  test("every staff role may enter; nobody else may", () => {
    for (const role of ["teacher", "staff", "curriculum_designer", "school_admin", "platform_admin"]) {
      expect(isStaffRoleForSchool(role)).toBe(true);
    }
    for (const role of ["scholar", "parent", undefined]) {
      expect(isStaffRoleForSchool(role)).toBe(false);
    }
  });
});

describe("school shell tab filtering", () => {
  test("a curriculum designer sees only generic school surfaces", () => {
    expect(labels("curriculum_designer")).toEqual(["Instructional materials"]);
  });

  test("a scoped capture reviewer sees Devices without scholar-admin directory tabs", () => {
    const seen = labels("curriculum_designer", true);
    expect(seen).toContain("Devices");
    expect(seen).not.toContain("Scholars");
    expect(seen).not.toContain("Staff");
  });

  test("base staff do not see school operations without the capability", () => {
    expect(labels("staff")).toEqual(["Instructional materials"]);
    expect(labels("staff", false, true)).toContain("Scholars");
  });

  test("health-only staff see the canonical health surface and no operations tabs", () => {
    const seen = labels("staff", false, false, true);
    expect(seen).toEqual(["Health", "Instructional materials"]);
    expect(seen).not.toContain("Scholars");
    expect(seen).not.toContain("Forms");
    expect(seen).not.toContain("Devices");
  });

  test("operations staff see school tabs but not leader-only tabs", () => {
    const seen = labels("staff", false, true);
    expect(seen).toContain("Scholars");
    expect(seen).toContain("Instructional materials");
    expect(seen).not.toContain("Invites");
    expect(seen).not.toContain("Settings");
  });

  test("a school admin sees everything", () => {
    expect(labels("school_admin", false, true, true)).toEqual(NAV.map((item) => item.label));
  });

  test("Staff precedes Forms", () => {
    const seen = labels("teacher");
    expect(seen.indexOf("Staff")).toBeLessThan(seen.indexOf("Forms"));
  });

  test("Groups is teacher-visible and follows Forms", () => {
    const teacherTabs = labels("teacher");
    expect(teacherTabs).toContain("Groups");
    expect(teacherTabs.indexOf("Forms")).toBeLessThan(teacherTabs.indexOf("Groups"));
  });
});

describe("the /school index redirect", () => {
  test("sends each role to a tab it can actually open", () => {
    for (const role of ["teacher", "staff", "curriculum_designer", "school_admin", "platform_admin"]) {
      const href = firstVisibleNavHref(role, false, role === "staff");
      expect(href).toBeDefined();
      const target = NAV.find((item) => item.href === href)!;
      expect(isNavItemVisible(target, role, false, role === "staff")).toBe(true);
    }
  });

  test("a curriculum designer never lands on the scholar directory", () => {
    expect(firstVisibleNavHref("curriculum_designer")).toBe("/school/instructional-materials");
  });
});
