import { describe, expect, test } from "vitest";
import { teacherHomePath } from "./teacherHome";
import {
  teacherNavHref,
  teacherNavKeysForRole,
} from "@/components/TeacherNavTabs";

describe("teacherHomePath", () => {
  test("sends operations Staff to the scholars home", () => {
    expect(teacherHomePath("staff", true)).toBe("/teacher/scholars");
  });

  test("sends curriculum-granted Staff to Units", () => {
    expect(teacherHomePath("staff", false, true)).toBe("/teacher/curriculum");
  });

  // The regression: `staff` carries no authority on its own, so a staffer
  // whose only grant is health:manage (or who has none at all) opens nothing
  // under /teacher. Sending them to /teacher/apps put them on the dashboard
  // error boundary, because that tab's first query is a `scholarAdminQuery`.
  // /school is their working surface — it routes on to /school/health.
  test("sends a Staff member with no /teacher-opening grant to the school shell", () => {
    expect(teacherHomePath("staff")).toBe("/school");
    expect(teacherHomePath("staff", false, false)).toBe("/school");
  });

  test("sends a mentor-only Staff member to Messages", () => {
    expect(teacherHomePath("staff", false, false, true)).toBe(
      "/teacher/messages",
    );
  });

  test("leaves the other roles' homes alone", () => {
    expect(teacherHomePath("curriculum_designer")).toBe("/teacher/curriculum");
    expect(teacherHomePath("teacher")).toBe("/teacher");
    expect(teacherHomePath("school_admin")).toBe("/teacher");
    expect(teacherHomePath("platform_admin")).toBe("/teacher");
  });
});

// `teacherHomePath` and `teacherNavKeysForRole` encode the staff capability
// ladder separately, and the whole bug was the two disagreeing: the nav
// offered Apps while the home pointed at it and neither matched the query's
// gate. Rather than assert an exact pairing (an ops+curriculum+publishing
// staffer's first tab is Schedule, but their home is deliberately Scholars),
// pin the property that actually protects the user: you are never homed to a
// destination your own nav does not contain.
describe("a staff home is always a destination that role can reach", () => {
  const BOOLS = [false, true];

  test("every staff capability combination homes to a visible section", () => {
    for (const hasCurriculumAccess of BOOLS) {
      for (const hasProgramPublishingAccess of BOOLS) {
        for (const hasSchoolOperationsAccess of BOOLS) {
          const home = teacherHomePath(
            "staff",
            hasSchoolOperationsAccess,
            hasCurriculumAccess,
          );
          const reachable = teacherNavKeysForRole(
            "staff",
            hasCurriculumAccess,
            hasProgramPublishingAccess,
            hasSchoolOperationsAccess,
          ).map(teacherNavHref);
          expect(
            reachable,
            `staff{curriculum:${hasCurriculumAccess},publish:${hasProgramPublishingAccess},ops:${hasSchoolOperationsAccess}} homed to ${home}`,
          ).toContain(home);
        }
      }
    }
  });

  test("a mentor-only staffer homes to a visible section", () => {
    const home = teacherHomePath("staff", false, false, true);
    expect(
      teacherNavKeysForRole("staff", false, false, false, {
        mentor: true,
        mentorOnly: true,
      }).map(teacherNavHref),
    ).toContain(home);
  });

  test("a curriculum designer homes to a visible section", () => {
    const home = teacherHomePath("curriculum_designer");
    expect(teacherNavKeysForRole("curriculum_designer").map(teacherNavHref)).toContain(
      home,
    );
  });
});
