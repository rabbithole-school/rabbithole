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

  test("renders each goal's title, description, and kind", () => {
    const section = buildGoalsSection([
      {
        title: "Ask my own research question and chase it",
        description: "start a quest from a question I care about",
        kind: "academic",
      },
      { title: "Stick with hard problems before asking for help", kind: "habit" },
    ]);
    expect(section).not.toBeNull();
    const text = section!;
    expect(text).toContain("This scholar's learning goals");
    expect(text).toContain("Ask my own research question and chase it");
    expect(text).toContain("start a quest from a question I care about");
    expect(text).toContain("(academic)");
    expect(text).toContain("Stick with hard problems before asking for help");
    expect(text).toContain("(habit)");
  });

  test("frames goals as kid-safe + not a checklist (governed authorship)", () => {
    const text = buildGoalsSection([{ title: "Read a whole chapter book", kind: "personal" }])!;
    // The section explicitly tells the tutor these were set WITH the scholar
    // (so they're referenceable) and to NOT drill them like a checklist.
    expect(text.toLowerCase()).toContain("with the scholar");
    expect(text.toLowerCase()).toContain("checklist");
  });

  test("omits the description dash when a goal has no description", () => {
    const text = buildGoalsSection([{ title: "Build a solar oven", kind: "hobby" }])!;
    expect(text).toContain("**Build a solar oven** _(hobby)_");
  });
});
