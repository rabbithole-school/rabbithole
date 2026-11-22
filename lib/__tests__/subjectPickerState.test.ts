import { describe, expect, test } from "vitest";
import { subjectPickerState } from "../subjects";

// TRA-723: the unit designer's subject picker over the school's classes.
describe("subjectPickerState", () => {
  const options = ["Humanities", "Math"];

  test("a subject naming a class selects that class, any case", () => {
    expect(subjectPickerState(options, " humanities ")).toEqual({
      selected: "Humanities",
      offList: null,
    });
  });

  test("a subject that is not a class shows as-is and is flagged", () => {
    expect(subjectPickerState(options, "Social Studies")).toEqual({
      selected: "Social Studies",
      offList: "Social Studies",
    });
  });

  test("no subject selects nothing and is not flagged", () => {
    expect(subjectPickerState(options, undefined)).toEqual({ selected: "", offList: null });
    expect(subjectPickerState(options, "  ")).toEqual({ selected: "", offList: null });
  });
});
