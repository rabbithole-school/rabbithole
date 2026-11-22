import { describe, expect, it } from "vitest";
import {
  isListedArea,
  isThinArea,
  MIN_SKILLS_FOR_AREA_LEVEL,
  parentLevelText,
  showOverallLevel,
} from "./parentMathThin";

const area = (fluentSkills: number, placementSkills = 0) => ({ fluentSkills, placementSkills });

describe("isThinArea", () => {
  it("draws the line at eight credited skills", () => {
    expect(MIN_SKILLS_FOR_AREA_LEVEL).toBe(8);
    expect(isThinArea(area(7))).toBe(true);
    expect(isThinArea(area(8))).toBe(false);
    expect(isThinArea(area(5, 3))).toBe(false);
  });

  it("counts placement credit, so a placement-only area of 20 is not thin", () => {
    expect(isThinArea(area(0, 20))).toBe(false);
  });
});

describe("isListedArea", () => {
  it("leaves out an area with no credited skill", () => {
    expect(isListedArea(area(0, 0))).toBe(false);
    expect(isListedArea(area(0, 1))).toBe(true);
  });
});

describe("showOverallLevel", () => {
  it("needs two areas that are not thin", () => {
    expect(showOverallLevel([area(30), area(3), area(2)])).toBe(false);
    expect(showOverallLevel([area(30), area(0, 12), area(2)])).toBe(true);
    expect(showOverallLevel([])).toBe(false);
  });
});

describe("parentLevelText", () => {
  it("prints a level below grade 1 as kindergarten", () => {
    expect(parentLevelText(0.8, "tile")).toBe("Kindergarten");
    expect(parentLevelText(0.8, "table")).toBe("K");
  });

  it("prints grade 1 and up to one decimal", () => {
    expect(parentLevelText(1, "table")).toBe("1.0");
    expect(parentLevelText(4.62, "tile")).toBe("Grade 4.6");
  });
});
