import { describe, expect, test } from "vitest";
import { buildGoalsSection } from "../sessionHelpers";

// buildGoalsSection injects the scholar's active, teacher-approved goals into
// the tutor prompt (assessment-and-goals §9 — governed authorship). The section
// must be omitted when there are no goals (no empty heading), and must render
// each goal's title + optional description + kind.

describe("goals section", () => {
  test("returns null when there are no goals", () => {
    expect(buildGoalsSection(null)).toBeNull();
    expect(buildGoalsSection([])).toBeNull();
  });

  test("omits the description dash when a goal has no description", () => {
    const text = buildGoalsSection([{ title: "Build a solar oven", kind: "hobby" }])!;
    expect(text).toContain("**Build a solar oven** _(hobby)_");
  });
});
