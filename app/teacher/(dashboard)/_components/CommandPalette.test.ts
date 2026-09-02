import { describe, expect, test } from "vitest";
import { isTeacherRole, ROLES } from "@/convex/lib/roles";
import { searchSkillsQueryArgs } from "@/components/CommandPalette";

describe("CommandPalette skill search role gate", () => {
  test.each([ROLES.CURRICULUM_DESIGNER, ROLES.STAFF])(
    "%s skips the teacher-only searchSkills query",
    (role) => {
      expect(searchSkillsQueryArgs(isTeacherRole(role), true, "fraction")).toBe("skip");
    },
  );

  test.each([ROLES.TEACHER, ROLES.SCHOOL_ADMIN, ROLES.PLATFORM_ADMIN])(
    "%s can issue the searchSkills query",
    (role) => {
      expect(searchSkillsQueryArgs(isTeacherRole(role), true, "fraction")).toEqual({
        query: "fraction",
        limit: 12,
      });
    },
  );
});
