import { describe, expect, test } from "vitest";
import { TEACHER_NAV, teacherNavKeysForRole } from "../TeacherNavTabs";

// The staff strip is the one place where a destination either exists or does
// not, for every staff shell that renders it. Two properties are asserted here
// because a regression in either is silent in the browser: Chat is absent (it
// is the Robot + the dock's "All chats" link now, not a tab), and every role
// still keeps the sections it is entitled to.

const STAFF_ROLES = [
  "teacher",
  "school_admin",
  "platform_admin",
  "staff",
  "curriculum_designer",
];

describe("the staff nav strip", () => {
  test("carries no Chat tab — chat is the header Robot, not a destination", () => {
    expect(TEACHER_NAV.map((t) => t.key)).not.toContain("chat");
    for (const role of STAFF_ROLES) {
      expect(teacherNavKeysForRole(role)).not.toContain("chat");
    }
  });

  test("every role keeps its other sections, with Messages last when available", () => {
    expect(teacherNavKeysForRole("curriculum_designer")).toEqual([
      "curriculum",
      "math-skills",
      "school",
    ]);
    expect(teacherNavKeysForRole("curriculum_designer", true, true)).toEqual([
      "schedule",
      "curriculum",
      "math-skills",
      "school",
    ]);
    expect(teacherNavKeysForRole("staff")).toEqual([
      "apps",
      "school",
    ]);
    expect(teacherNavKeysForRole("staff", false, false, true)).toEqual([
      "scholars",
      "apps",
      "school",
      "messages",
    ]);
    expect(teacherNavKeysForRole("staff", true, false, true)).toEqual([
      "scholars",
      "curriculum",
      "apps",
      "school",
      "messages",
    ]);
    expect(teacherNavKeysForRole("staff", false, true, true)).toEqual([
      "scholars",
      "apps",
      "school",
      "messages",
    ]);
    expect(teacherNavKeysForRole("staff", true, true, true)).toEqual([
      "schedule",
      "scholars",
      "curriculum",
      "apps",
      "school",
      "messages",
    ]);
    expect(teacherNavKeysForRole("teacher")).toEqual([
      "schedule",
      "scholars",
      "curriculum",
      "math-skills",
      "quests",
      "apps",
      "report",
      "school",
      "messages",
    ]);
  });

  test("renders Messages as the final tab for every role that can access it", () => {
    const canonicalKeys = TEACHER_NAV.map((tab) => tab.key);

    for (const role of STAFF_ROLES) {
      const allowed = teacherNavKeysForRole(role);
      const rendered = canonicalKeys.filter((key) => allowed.includes(key));

      // Availability is defined by teacherNavKeysForRole: a role entitled to
      // Messages must actually render it (this fails if "messages" is dropped
      // from TEACHER_NAV, rather than passing vacuously), and a role that is
      // not entitled must not render it.
      expect(rendered.includes("messages")).toBe(allowed.includes("messages"));

      if (allowed.includes("messages")) {
        expect(rendered.indexOf("messages")).toBe(rendered.length - 1);
      }
    }
  });

  test("every listed key is a real item in the strip", () => {
    const known = new Set<string>(TEACHER_NAV.map((t) => t.key));
    for (const role of STAFF_ROLES) {
      for (const key of teacherNavKeysForRole(role)) {
        expect(known).toContain(key);
      }
    }
  });
});
