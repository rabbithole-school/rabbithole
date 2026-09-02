import { describe, expect, it } from "vitest";
import {
  type FrontierSkill,
  pickStartingSkillLabel,
  placementSpotLabel,
  placementStartBody,
  placementStartHeadline,
} from "./placementResultCopy";

// The single scholar-facing invariant J3 is enforcing: a placement END string may
// NEVER carry a grade token (a bare "Grade 2", or a lone K/1..8 band read as a
// grade). We assert the produced copy is skill-anchored and grade-free.
const GRADE_TOKEN = /\bgrade\b/i;

describe("pickStartingSkillLabel", () => {
  it("names the FURTHEST-reached frontier (highest grade band) so the copy agrees with the Tree's 'you are here'", () => {
    const frontier: FrontierSkill[] = [
      { skillKey: "add_within_20", label: "adding within 20", grade: "2" },
      { skillKey: "multiply_fractions", label: "multiplying fractions", grade: "5" },
      { skillKey: "skip_count", label: "skip-counting", grade: "3" },
    ];
    expect(pickStartingSkillLabel(frontier)).toBe("multiplying fractions");
  });

  it("recognizes grade 9 as the highest practice band", () => {
    const frontier: FrontierSkill[] = [
      { skillKey: "grade_9", label: "quadratic formulas", grade: "9" },
      { skillKey: "grade_8", label: "linear equations", grade: "8" },
    ];
    expect(pickStartingSkillLabel(frontier)).toBe("quadratic formulas");
  });

  it("is deterministic on a grade tie (lowest skillKey wins)", () => {
    const frontier: FrontierSkill[] = [
      { skillKey: "z_skill", label: "Z skill", grade: "4" },
      { skillKey: "a_skill", label: "A skill", grade: "4" },
    ];
    expect(pickStartingSkillLabel(frontier)).toBe("A skill");
  });

  it("ignores frontier candidates with no human label", () => {
    const frontier: FrontierSkill[] = [
      { skillKey: "labelled", label: "counting to 20", grade: "1" },
      { skillKey: "blank", label: "", grade: "5" },
      { skillKey: "nullish", label: null, grade: "6" },
    ];
    expect(pickStartingSkillLabel(frontier)).toBe("counting to 20");
  });

  it("returns null when nothing on the frontier carries a label (all-mastered / degenerate)", () => {
    expect(pickStartingSkillLabel([])).toBeNull();
    expect(pickStartingSkillLabel([{ skillKey: "x", label: "  ", grade: "3" }])).toBeNull();
  });
});

describe("placementStartHeadline — skill-anchored, never grade-anchored", () => {
  it("names the skill she's starting from, with NO grade token", () => {
    const line = placementStartHeadline("multiplying fractions", true);
    expect(line).toBe("You're starting at: multiplying fractions");
    expect(line).not.toMatch(GRADE_TOKEN);
  });

  it("uses a warm, numberless line for the rare all-mastered case (placed, no frontier)", () => {
    const line = placementStartHeadline(null, true);
    expect(line).toBe("You've mapped a strong foundation");
    expect(line).not.toMatch(GRADE_TOKEN);
  });

  it("uses the genuine beginner line when nothing placed", () => {
    const line = placementStartHeadline(null, false);
    expect(line).toBe("Let's start from the beginning");
    expect(line).not.toMatch(GRADE_TOKEN);
  });

  it("never emits a grade token even for a numeric-looking skill label", () => {
    // Defense-in-depth: the label is a real skill name, so the string stays clean.
    const line = placementStartHeadline("adding two-digit numbers", true);
    expect(line).not.toMatch(GRADE_TOKEN);
  });
});

describe("placementStartBody", () => {
  it("gives the growth reassurance when a skill is named or the scholar placed", () => {
    expect(placementStartBody("adding within 20", true)).toMatch(/pick up right where you're ready to grow/);
    expect(placementStartBody(null, true)).toMatch(/pick up right where you're ready to grow/);
  });

  it("gives the foundation line for a true beginner, with no grade token", () => {
    const line = placementStartBody(null, false);
    expect(line).toBe("We'll build a strong foundation together, step by step.");
    expect(line).not.toMatch(GRADE_TOKEN);
  });
});

describe("placementSpotLabel — mixed check-in 'your spots'", () => {
  it("shows the domain's frontier skill, never a grade", () => {
    const spot = placementSpotLabel("dividing fractions");
    expect(spot).toBe("dividing fractions");
    expect(spot).not.toMatch(GRADE_TOKEN);
  });

  it("falls back to a warm 'Starting out' when nothing placed", () => {
    expect(placementSpotLabel(null)).toBe("Starting out");
  });
});
