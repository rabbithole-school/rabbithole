import { describe, expect, test } from "vitest";
import { isTeacherRole, ROLES } from "@/convex/lib/roles";
import {
  buildEntries,
  searchCurriculumQueryArgs,
  searchSkillsQueryArgs,
} from "@/components/CommandPalette";

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

describe("CommandPalette curriculum search gate", () => {
  test("a staffer with no curriculum access never issues the query", () => {
    expect(searchCurriculumQueryArgs(false, true, "fraction", "moli")).toBe("skip");
  });

  test("a closed palette never issues the query", () => {
    expect(searchCurriculumQueryArgs(true, false, "fraction", "moli")).toBe("skip");
  });

  test("one character is below the server's minimum", () => {
    expect(searchCurriculumQueryArgs(true, true, "f", "moli")).toBe("skip");
    expect(searchCurriculumQueryArgs(true, true, " f ", "moli")).toBe("skip");
  });

  test("forwards the institution scope, normalising empty to undefined", () => {
    expect(searchCurriculumQueryArgs(true, true, "fraction", "moli")).toEqual({
      query: "fraction",
      scope: "moli",
      limit: 12,
    });
    expect(searchCurriculumQueryArgs(true, true, "fraction", "")).toEqual({
      query: "fraction",
      scope: undefined,
      limit: 12,
    });
  });
});

const scholar = {
  _id: "u1",
  username: "kai_kahale",
  name: "Kai Kahale",
  image: null,
};

const entries = (query: string) =>
  buildEntries([scholar], [], [], [], [], [], query);

describe("CommandPalette scholar matching", () => {
  test("matches the display name", () => {
    expect(entries("kahale").map((e) => e.key)).toEqual(["u1"]);
  });

  test("matches the username — it is what the destination URL is keyed on", () => {
    const hit = entries("kai_ka");
    expect(hit.map((e) => e.key)).toEqual(["u1"]);
    expect(hit[0]?.href).toBe("/teacher/scholars/kai_kahale");
  });

  test("shows the username as the sublabel", () => {
    expect(entries("kahale")[0]?.sublabel).toBe("kai_kahale");
  });

  test("falls back to the id when a scholar has no username", () => {
    const [hit] = buildEntries(
      [{ _id: "u2", username: null, name: "No Username", image: null }],
      [], [], [], [], [], "no user",
    );
    expect(hit?.href).toBe("/teacher/scholars/u2");
  });
});

describe("CommandPalette curriculum entries", () => {
  test("a lesson hit deep-links into the column view with ?lesson=", () => {
    const [hit] = buildEntries([], [], [], [], [], [
      {
        kind: "lesson",
        unitId: "un1",
        unitTitle: "Autorotation",
        lessonId: "le1",
        lessonTitle: "Entry drill",
      },
    ], "entry");
    expect(hit?.href).toBe("/teacher/curriculum/un1?lesson=le1");
    expect(hit?.label).toBe("Entry drill");
    expect(hit?.sublabel).toBe("Autorotation");
  });

  test("an activity hit deep-links with ?activity= and shows its path back up", () => {
    const [hit] = buildEntries([], [], [], [], [], [
      {
        kind: "activity",
        unitId: "un1",
        unitTitle: "Autorotation",
        lessonId: "le1",
        lessonTitle: "Entry drill",
        activityId: "ac1",
        activityTitle: "Warm-up",
      },
    ], "warm");
    expect(hit?.href).toBe("/teacher/curriculum/un1?activity=ac1");
    expect(hit?.label).toBe("Warm-up");
    // An activity title alone does not say which of the six warm-ups it is.
    expect(hit?.sublabel).toBe("Autorotation › Entry drill");
  });

  test("server-filtered curriculum hits are not re-filtered client-side", () => {
    // The server already applied the needle; a second client filter on a
    // different field (the unit title, say) would silently drop real hits.
    const hits = buildEntries([], [], [], [], [], [
      {
        kind: "lesson",
        unitId: "un1",
        unitTitle: "Autorotation",
        lessonId: "le1",
        lessonTitle: "Entry drill",
      },
    ], "zzz-no-client-match");
    expect(hits).toHaveLength(1);
  });
});
