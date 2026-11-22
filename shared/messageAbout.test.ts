import { describe, expect, test } from "vitest";
import { aboutLabel, aboutLine } from "./messageAbout";

describe("what an about thread is about", () => {
  test("a scholar's label and a teacher's", () => {
    expect(aboutLabel({ type: "wonder" })).toBe("About your wonder");
    expect(aboutLabel({ type: "quest" })).toBe("About your Quest");
    expect(aboutLabel({ type: "wonder" }, "staff")).toBe("About a wonder");
    expect(aboutLabel(undefined)).toBeNull();
  });

  test("the line adds the subject's words when there are some", () => {
    expect(aboutLine({ type: "quest" }, "Angle croc")).toBe("About your Quest · Angle croc");
    expect(aboutLine({ type: "quest" }, "  ")).toBe("About your Quest");
    expect(aboutLine({ type: "wonder" }, undefined)).toBe("About your wonder");
  });
});
