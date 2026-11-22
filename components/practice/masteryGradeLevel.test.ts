import { describe, expect, it } from "vitest";
import {
  domainDetailLine,
  formatMasteryGradeLevel,
  highestGradeClause,
} from "./masteryGradeLevel";

describe("formatMasteryGradeLevel", () => {
  it("renders a level to one decimal and null as a calm em-dash", () => {
    expect(formatMasteryGradeLevel(null)).toBe("—");
    expect(formatMasteryGradeLevel(3)).toBe("3.0");
    expect(formatMasteryGradeLevel(4.6)).toBe("4.6");
    expect(formatMasteryGradeLevel(0.4)).toBe("0.4");
  });
});


describe("highestGradeClause", () => {
  it("names the highest grade only when its whole number differs from the level's", () => {
    expect(highestGradeClause(5.3, 7.2)).toBe("Highest skill shown: grade 7");
    expect(highestGradeClause(5.3, 5.9)).toBeNull();
    // Everything through grade 3 covered reads 4.0; "highest: grade 3" adds nothing.
    expect(highestGradeClause(4.0, 3.9)).toBeNull();
    expect(highestGradeClause(null, 0.5)).toBe("Highest skill shown: kindergarten");
    expect(highestGradeClause(4, null)).toBeNull();
  });
});

describe("domainDetailLine", () => {
  it("joins the highest grade and where the credit came from", () => {
    expect(
      domainDetailLine({ gradeValue: 5.3, highestGradeValue: 7.2, fluentSkills: 13, placementSkills: 6 }),
    ).toBe("Highest skill shown: grade 7 · 13 skills from daily work, 6 from the placement check-in");
    expect(
      domainDetailLine({ gradeValue: 2.4, highestGradeValue: 2.9, fluentSkills: 1, placementSkills: 0 }),
    ).toBe("1 skill from daily work");
    expect(
      domainDetailLine({ gradeValue: 4, highestGradeValue: null, fluentSkills: 0, placementSkills: 3 }),
    ).toBe("3 skills from the placement check-in");
    expect(
      domainDetailLine({ gradeValue: null, highestGradeValue: null, fluentSkills: 0, placementSkills: 0 }),
    ).toBeNull();
  });
});
