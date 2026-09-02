/**
 * Pure tests for the "external practice today" prompt section — the
 * tutor-visible rendering of Web Assignment captures. Same shape as
 * nonHumanIdentity.test.ts: import the builders, assert on strings.
 */
import { describe, expect, test } from "vitest";
import {
  buildSystemPrompt,
  buildWebPracticeSection,
  type WebPracticeEntry,
} from "../sessionHelpers";

const SESSION: WebPracticeEntry = {
  activityTitle: "Acme Practice",
  durationMs: 32 * 60_000,
  extracted: {
    xpToday: 70,
    xpGoal: 70,
    courseName: "Prealgebra",
    tasksCompletedToday: 4,
    taskSummaries: ["Lesson: Dividing fractions (+12 XP)", "Review: Decimals (+5 XP)"],
  },
};

describe("buildWebPracticeSection", () => {
  test("null/empty → no section", () => {
    expect(buildWebPracticeSection(null)).toBeNull();
    expect(buildWebPracticeSection([])).toBeNull();
  });

  test("renders duration, XP, goal-met, course, tasks", () => {
    const s = buildWebPracticeSection([SESSION])!;
    expect(s).toContain("EXTERNAL PRACTICE TODAY");
    expect(s).toContain("Acme Practice: 32 min");
    expect(s).toContain("70/70 XP (daily goal met)");
    expect(s).toContain("course: Prealgebra");
    expect(s).toContain("4 tasks completed");
    expect(s).toContain("Lesson: Dividing fractions (+12 XP)");
    // Guardrails for the tutor.
    expect(s).toContain("Don't quiz them");
  });

  test("goal not met → no goal-met flag", () => {
    const s = buildWebPracticeSection([
      { ...SESSION, extracted: { xpToday: 30, xpGoal: 70 } },
    ])!;
    expect(s).toContain("30/70 XP");
    expect(s).not.toContain("daily goal met");
  });

  test("screenshot-only session (no extraction) still renders duration", () => {
    const s = buildWebPracticeSection([
      { activityTitle: "Typing practice", durationMs: 90_000, extracted: null },
    ])!;
    expect(s).toContain("Typing practice: 2 min");
  });
});

describe("buildSystemPrompt integration", () => {
  test("section appears when sessions passed, absent otherwise", () => {
    const withSection = buildSystemPrompt(
      null, null, "Kai", null, null, null,
      null, null, null, null, null, null, null, null, null, null, null, null,
      null, null, null, false, false, null,
      [SESSION],
    );
    expect(withSection).toContain("EXTERNAL PRACTICE TODAY");
    expect(withSection).toContain("Acme Practice");

    const without = buildSystemPrompt(
      null, null, "Kai", null, null, null,
    );
    expect(without).not.toContain("EXTERNAL PRACTICE TODAY");
  });
});
