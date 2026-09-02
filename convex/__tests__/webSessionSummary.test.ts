import { describe, expect, test } from "vitest";
import {
  cleanSummary,
  webSessionFacts,
  webSessionHasContent,
} from "../lib/webSessionSummary";

describe("webSessionHasContent", () => {
  test("true when tasks completed or XP earned", () => {
    expect(webSessionHasContent({ tasksCompletedToday: 2 })).toBe(true);
    expect(webSessionHasContent({ xpToday: 7, xpGoal: 15 })).toBe(true);
  });
  test("false for empty / nothing-done sessions", () => {
    expect(webSessionHasContent(null)).toBe(false);
    expect(webSessionHasContent(undefined)).toBe(false);
    expect(webSessionHasContent({})).toBe(false);
    expect(webSessionHasContent({ tasksCompletedToday: 0, xpToday: 0, xpGoal: 15 })).toBe(false);
  });
});

describe("webSessionFacts", () => {
  test("null when nothing meaningful (no LLM call)", () => {
    expect(webSessionFacts(null)).toBeNull();
    expect(webSessionFacts({ tasksCompletedToday: 0, xpToday: 0, xpGoal: 15 })).toBeNull();
  });

  test("includes course, XP, task count, and task lines", () => {
    const facts = webSessionFacts({
      courseName: "4th Grade Math",
      xpToday: 14,
      xpGoal: 15,
      tasksCompletedToday: 2,
      taskSummaries: [
        "Lesson: Comparing Fractions (+7 XP)",
        "Lesson: Prime and Composite Numbers (+7 XP)",
      ],
    })!;
    expect(facts).toContain("Course: 4th Grade Math");
    expect(facts).toContain("XP today: 14/15");
    expect(facts).not.toContain("daily goal met"); // below goal
    expect(facts).toContain("Tasks completed today: 2");
    expect(facts).toContain("Comparing Fractions");
    expect(facts).toContain("Prime and Composite Numbers");
  });

  test("flags daily goal met when xpToday >= xpGoal", () => {
    const facts = webSessionFacts({ xpToday: 21, xpGoal: 15 })!;
    expect(facts).toContain("XP today: 21/15 (daily goal met)");
  });

  test("caps task lines at 15", () => {
    const many = Array.from({ length: 30 }, (_, i) => `Lesson ${i}`);
    const facts = webSessionFacts({ tasksCompletedToday: 30, taskSummaries: many })!;
    expect(facts).toContain("Lesson 14");
    expect(facts).not.toContain("Lesson 15");
  });
});

describe("cleanSummary", () => {
  test("strips quotes and newlines", () => {
    expect(cleanSummary('  "Completed 2 lessons on fractions."  ')).toBe(
      "Completed 2 lessons on fractions.",
    );
    expect(cleanSummary("line one\nline two")).toBe("line one line two");
  });
  test("rejects empty or over-long output", () => {
    expect(cleanSummary("   ")).toBeNull();
    expect(cleanSummary("x".repeat(281))).toBeNull();
  });
});
