import { describe, expect, test } from "vitest";
import { subjectFilterKey, unitFitsSubjectFilter, unitSubjectFilterOptions } from "../subjects";

// TRA-723: a unit list's Subject filter groups subjects by meaning, through
// the same matcher as class filing, so a spelling never splits an option.

const units = (...subjects: (string | null)[]) => subjects.map((subject) => ({ subject }));

describe("unitSubjectFilterOptions", () => {
  test("spellings of one subject are one option, labelled by the most common", () => {
    expect(unitSubjectFilterOptions(units("Mathematics", "Math", "Math", "maths"))).toEqual(["Math"]);
    expect(unitSubjectFilterOptions(units("Social Studies", "Humanities", "Humanities"))).toEqual([
      "Humanities",
    ]);
  });

  test("on a tie the alphabetically first spelling wins, whatever the order", () => {
    const expected = ["Math", "science"];
    expect(unitSubjectFilterOptions(units("science", "Math", "Science", "Mathematics"))).toEqual(expected);
    expect(unitSubjectFilterOptions(units("Mathematics", "Science", "Math", "science"))).toEqual(expected);
  });

  test("a subject the matcher names nothing in keeps its own option", () => {
    expect(unitSubjectFilterOptions(units("Workshop", "(TBD)", "workshop"))).toEqual([
      "(TBD)",
      "workshop",
    ]);
    expect(unitFitsSubjectFilter("Workshop", "workshop")).toBe(true);
    expect(unitFitsSubjectFilter("(TBD)", "Workshop")).toBe(false);
  });

  test("subjectFilterKey: same meaning, same key; blank is empty", () => {
    expect(subjectFilterKey("Mathematics")).toBe(subjectFilterKey(" math "));
    expect(subjectFilterKey("Science & Art")).toBe(subjectFilterKey("Art + Science"));
    expect(subjectFilterKey("Art")).not.toBe(subjectFilterKey("Art & Science"));
    expect(subjectFilterKey("  ")).toBe("");
  });

  test("a two-subject spelling is its own option; blanks are left out", () => {
    expect(unitSubjectFilterOptions(units("Art & Science", "Art", null, "  ", "Science & Art"))).toEqual([
      "Art",
      "Art & Science",
    ]);
  });

  test("a subject no class names keeps its own option", () => {
    expect(unitSubjectFilterOptions(units("AI Literacy", "SEL", "Math"))).toEqual([
      "AI Literacy",
      "Math",
      "SEL",
    ]);
  });
});

describe("unitFitsSubjectFilter", () => {
  test("a unit fits an option of the same meaning", () => {
    expect(unitFitsSubjectFilter("Mathematics", "Math")).toBe(true);
    expect(unitFitsSubjectFilter(" math ", "Mathematics")).toBe(true);
    expect(unitFitsSubjectFilter("Social Studies", "Humanities")).toBe(true);
  });

  test("a two-subject unit fits each of its subjects and the pair", () => {
    expect(unitFitsSubjectFilter("Art & Science", "Art")).toBe(true);
    expect(unitFitsSubjectFilter("Art & Science", "Science")).toBe(true);
    expect(unitFitsSubjectFilter("Science & Art", "Art & Science")).toBe(true);
    expect(unitFitsSubjectFilter("Art", "Art & Science")).toBe(false);
  });

  test("different subjects and blanks don't fit", () => {
    expect(unitFitsSubjectFilter("Language Arts", "Art")).toBe(false);
    expect(unitFitsSubjectFilter("AI Literacy", "Science")).toBe(false);
    expect(unitFitsSubjectFilter(null, "Math")).toBe(false);
    expect(unitFitsSubjectFilter("Math", "  ")).toBe(false);
  });
});
