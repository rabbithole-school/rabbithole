import { describe, expect, test } from "vitest";
import {
  strandForStandard,
  trackedGrades,
  gradeIndex,
  domainOf,
  isGradeSpecific,
  isValidGradeLevel,
  ACCELERATION_GRADES,
} from "../standardStrand";

/**
 * standardStrand turns a raw CCSS standard into the Acceleration view's
 * grade-banded strand. The contract that matters: Math → one row, ELA splits
 * by notation prefix into Reading/Writing/Language/Speaking, and skill-based
 * non-graded subjects are excluded (null) so they can't smear across every
 * grade column.
 */
describe("strandForStandard", () => {
  test("Mathematics maps to the single Math strand regardless of notation", () => {
    expect(strandForStandard("Mathematics", "3.NF.1")?.key).toBe("math");
    expect(strandForStandard("Mathematics", "K.CC.1")?.key).toBe("math");
    expect(strandForStandard("Mathematics", undefined)?.key).toBe("math");
  });

  test("ELA splits by notation prefix into the right strand", () => {
    expect(strandForStandard("ELA/Literacy", "RL.2.1")?.key).toBe("ela.reading");
    expect(strandForStandard("ELA/Literacy", "RI.3.2")?.key).toBe("ela.reading");
    expect(strandForStandard("ELA/Literacy", "RF.1.4")?.key).toBe("ela.reading");
    expect(strandForStandard("ELA/Literacy", "W.4.1")?.key).toBe("ela.writing");
    expect(strandForStandard("ELA/Literacy", "WHST.6.1")?.key).toBe("ela.writing");
    expect(strandForStandard("ELA/Literacy", "SL.2.1")?.key).toBe("ela.speaking");
    expect(strandForStandard("ELA/Literacy", "L.5.4")?.key).toBe("ela.language");
  });

  test("non-graded skill subjects are excluded", () => {
    expect(strandForStandard("Historical Thinking", "HT.3.A")).toBeNull();
    expect(strandForStandard("Some Future Subject", "X.1")).toBeNull();
  });

  test("Science (NGSS) maps to the Science strand", () => {
    expect(strandForStandard("Science", "3-LS1-1")?.key).toBe("science");
    expect(strandForStandard("Science (NGSS)", "5-PS1-2")?.key).toBe("science");
    expect(strandForStandard("Science", "MS-LS2-3")?.key).toBe("science");
    expect(strandForStandard("Science", "HS-LS2-6")?.key).toBe("science");
  });

  test("strand order makes Math first, then Reading/Writing/Speaking/Language", () => {
    const keys = ["L.2.1", "SL.2.1", "W.2.1", "RL.2.1"]
      .map((n) => strandForStandard("ELA/Literacy", n)!)
      .sort((a, b) => a.order - b.order)
      .map((s) => s.key);
    expect(keys).toEqual([
      "ela.reading",
      "ela.writing",
      "ela.speaking",
      "ela.language",
    ]);
  });
});

describe("grade helpers", () => {
  test("trackedGrades keeps only ladder grades", () => {
    expect(trackedGrades(["2"])).toEqual(["2"]);
    expect(trackedGrades(["K", "1", "2"])).toEqual(["K", "1", "2"]);
    expect(trackedGrades(["9", "10", "11", "12"])).toEqual([]); // above the K-8 ladder
  });

  test("isGradeSpecific accepts NGSS middle-school bands but rejects all-grades frameworks", () => {
    expect(isGradeSpecific(["3"])).toBe(true);
    expect(isGradeSpecific(["6", "7", "8"])).toBe(true);
    expect(isGradeSpecific(["K", "1", "2", "3", "4", "5", "6", "7", "8"])).toBe(false);
  });

  test("gradeIndex orders K before 1..8", () => {
    expect(gradeIndex("K")).toBe(0);
    expect(gradeIndex("2")).toBe(2);
    expect(gradeIndex("8")).toBe(8);
    expect(gradeIndex("9")).toBe(-1);
    expect(ACCELERATION_GRADES[0]).toBe("K");
  });
});

describe("domainOf", () => {
  test("math: token after the leading grade", () => {
    expect(domainOf("3.NF.1")).toEqual({ key: "NF", label: "Number & Operations — Fractions" });
    expect(domainOf("K.CC.1")).toEqual({ key: "CC", label: "Counting & Cardinality" });
    expect(domainOf("3.OA.7").key).toBe("OA");
    expect(domainOf("3.G.1").key).toBe("G");
  });
  test("ELA: leading alpha token", () => {
    expect(domainOf("RL.3.1")).toEqual({ key: "RL", label: "Reading: Literature" });
    expect(domainOf("W.4.2").key).toBe("W");
    expect(domainOf("RF.K.1").key).toBe("RF");
  });
  test("NGSS: discipline after grade-dash (3-LS1-1 → LS)", () => {
    expect(domainOf("3-LS1-1")).toEqual({ key: "LS", label: "Life Science" });
    expect(domainOf("5-PS1-2").key).toBe("PS");
    expect(domainOf("K-ESS2-1")).toEqual({ key: "ESS", label: "Earth & Space Science" });
    expect(domainOf("3-ETS1-1").key).toBe("ETS");
    expect(domainOf("MS-LS2-3")).toEqual({ key: "LS", label: "Life Science" });
    expect(domainOf("HS-LS2-6")).toEqual({ key: "LS", label: "Life Science" });
  });
  test("unknown / empty falls back gracefully", () => {
    expect(domainOf(undefined).key).toBe("other");
    expect(domainOf("ZZ.9.9").label).toBe("ZZ");
  });
});

describe("isValidGradeLevel — the chronological-grade notch", () => {
  test("accepts exactly the acceleration grade columns (K–8)", () => {
    for (const g of ACCELERATION_GRADES) {
      expect(isValidGradeLevel(g)).toBe(true);
    }
  });
  test("rejects non-notch values (tenths, college, labels, out-of-range)", () => {
    expect(isValidGradeLevel("7.3")).toBe(false);
    expect(isValidGradeLevel("college")).toBe(false);
    expect(isValidGradeLevel("Grade 3")).toBe(false);
    expect(isValidGradeLevel("9")).toBe(false);
    expect(isValidGradeLevel("")).toBe(false);
    expect(isValidGradeLevel("k")).toBe(false);
  });
});
