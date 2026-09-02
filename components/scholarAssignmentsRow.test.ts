import { describe, expect, test } from "vitest";
import { assignmentDetailLine, assignmentsHeadingSuffix } from "./scholarAssignmentsRow";

describe("assignmentDetailLine", () => {
  test("suppresses the detail line when the title duplicates the unit title", () => {
    // The exact FTUE-H-04 repro: a day-one scholar's "Welcome to Rabbithole"
    // assignment for the "Welcome to Rabbithole" unit read as a literal
    // repeat ("Welcome to Rabbithole / Welcome to Rabbithole").
    expect(
      assignmentDetailLine({ title: "Welcome to Rabbithole", unitTitle: "Welcome to Rabbithole", unitEmoji: null }),
    ).toBeUndefined();
  });

  test("shows the unit emoji + title when it differs from the assignment title", () => {
    expect(
      assignmentDetailLine({ title: "Week 3 focus", unitTitle: "Fraction Sense", unitEmoji: "🍕" }),
    ).toBe("🍕 Fraction Sense");
  });

  test("omits the emoji prefix when the unit has none", () => {
    expect(
      assignmentDetailLine({ title: "Week 3 focus", unitTitle: "Fraction Sense", unitEmoji: null }),
    ).toBe("Fraction Sense");
  });

  test("falls back to a generic caption when there's no unit at all", () => {
    expect(
      assignmentDetailLine({ title: "Standing practice", unitTitle: null, unitEmoji: null }),
    ).toBe("Active cohort assignment");
  });
});

describe("assignmentsHeadingSuffix", () => {
  test("counts only the scholar's own assignment rows", () => {
    // The original bug: the heading summed assignments + the class focus
    // row into one count ("Assignments (2)" for 1 real assignment + focus).
    // The count now reflects assignments alone; the focus row gets its own
    // "Class focus" sublabel instead of inflating this number.
    expect(assignmentsHeadingSuffix(1)).toBe(" (1)");
  });

  test("shows no count suffix when the scholar has no assignments of their own", () => {
    expect(assignmentsHeadingSuffix(0)).toBe("");
  });

  test("counts multiple assignments", () => {
    expect(assignmentsHeadingSuffix(3)).toBe(" (3)");
  });
});
