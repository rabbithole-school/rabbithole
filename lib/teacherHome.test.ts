import { describe, expect, test } from "vitest";
import { teacherHomePath } from "./teacherHome";

describe("teacherHomePath", () => {
  test("sends operations Staff to the scholars home", () => {
    expect(teacherHomePath("staff", true)).toBe("/teacher/scholars");
  });

  test("sends base Staff without school operations to Apps", () => {
    expect(teacherHomePath("staff")).toBe("/teacher/apps");
  });
});
