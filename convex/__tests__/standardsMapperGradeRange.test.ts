import { describe, expect, test } from "vitest";
import { getGradeRange } from "../standardsMapper";

// The standards window around a scholar's TALK level (TRA-514).
describe("getGradeRange", () => {
  test("centres on the whole grade of a tenth-of-a-grade talk level", () => {
    expect(getGradeRange("3.4")).toEqual(getGradeRange("3"));
    expect(getGradeRange("3")).toEqual(["K", "1", "2", "3", "4", "5"]);
  });

  test("caps a high-school or college talk level at grade 8, not the K–5 default", () => {
    const top = getGradeRange("8");
    expect(top).toEqual(["5", "6", "7", "8"]);
    expect(getGradeRange("9")).toEqual(top);
    expect(getGradeRange("12.7")).toEqual(top);
    expect(getGradeRange("college")).toEqual(top);
  });

  test("unset or legacy values", () => {
    expect(getGradeRange(undefined)).toEqual(["K", "1", "2", "3", "4", "5"]);
    expect(getGradeRange("pre-reader")).toEqual(getGradeRange("K"));
  });
});
