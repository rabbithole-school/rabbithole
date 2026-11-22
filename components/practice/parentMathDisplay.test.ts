import { describe, expect, it } from "vitest";
import { areaSkillCountLine, mathContextLine, newThisTermCell, paceTile } from "./parentMathDisplay";
import { MIN_FLUENT_SKILLS_FOR_PACE } from "@/shared/mathPace";
import type { LearnedPace } from "@/convex/lib/practice/frontierGrade";

const pace = (over: Partial<LearnedPace> = {}): LearnedPace => ({
  learnedMonths: 4.5,
  knownMonths: 1,
  learnedSkills: 6,
  knownSkills: 4,
  schoolMonths: 3.2,
  pace: 1.4,
  ...over,
});

describe("newThisTermCell", () => {
  it("is absent when there is no term to measure from", () => {
    expect(newThisTermCell(undefined)).toBeNull();
  });

  it("shows the learned amount in the tile's unit, and a muted dash when it rounds to zero", () => {
    expect(newThisTermCell(3.14)).toEqual({ text: "3.1 mo", muted: false });
    expect(newThisTermCell(0.04)).toEqual({ text: "—", muted: true });
    expect(newThisTermCell(0)).toEqual({ text: "—", muted: true });
  });

  it("is never gated on the tile's fluent-skill floor: one learned skill still shows", () => {
    expect(newThisTermCell(0.8)?.muted).toBe(false);
  });
});

describe("paceTile", () => {
  it("is omitted with no term, too few fluent skills, or too little school", () => {
    expect(paceTile(null)).toBeNull();
    expect(paceTile(undefined)).toBeNull();
    expect(paceTile(pace({ learnedSkills: MIN_FLUENT_SKILLS_FOR_PACE - 1, knownSkills: 0 }))).toBeNull();
    expect(paceTile(pace({ pace: null }))).toBeNull();
  });

  it("shows at exactly the fluent-skill floor, counting known skills toward it", () => {
    expect(paceTile(pace({ learnedSkills: 1, knownSkills: MIN_FLUENT_SKILLS_FOR_PACE - 1 }))).not.toBeNull();
  });

  it("marks standard pace by the value shown, so 0.96 (shown 1.0×) is at standard", () => {
    expect(paceTile(pace({ pace: 1.4 }))?.atOrAboveStandard).toBe(true);
    expect(paceTile(pace({ pace: 0.96 }))?.atOrAboveStandard).toBe(true);
    expect(paceTile(pace({ pace: 0.94 }))?.atOrAboveStandard).toBe(false);
  });
});

describe("areaSkillCountLine", () => {
  it("names each source only when it has skills", () => {
    expect(areaSkillCountLine(0, 0)).toBeNull();
    expect(areaSkillCountLine(12, 0)).not.toMatch(/placement/);
    expect(areaSkillCountLine(0, 4)).not.toMatch(/daily work/);
    expect(areaSkillCountLine(12, 4)).toMatch(/daily work.*placement/);
  });
});

describe("mathContextLine", () => {
  it("prints the server's school-day key as is, whatever the viewer's zone", () => {
    expect(mathContextLine("Kai", "2026-11-01")).toMatch(/since Nov 1$/);
    expect(mathContextLine("Kai", null)).not.toMatch(/since/);
  });
});
