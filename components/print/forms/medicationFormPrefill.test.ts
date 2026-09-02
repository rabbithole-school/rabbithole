import { describe, expect, test } from "vitest";
import {
  buildInsuranceItems,
  formatDob,
  prefillFromHealthRecord,
  schoolYearFor,
  type HealthRecordPrefillSource,
} from "./medicationFormPrefill";

const baseRecord: HealthRecordPrefillSource = {
  childName: "Oliver Stone",
  childDob: "2018-03-15",
  childGrade: "2",
  homeAddress: "123 Aloha St, Honolulu, HI 96816",
  streetAddress: "123 Aloha St",
  city: "Honolulu",
  state: "HI",
  zipCode: "96816",
  insurancePlan: "HMSA",
  guardian1Name: "Avery Stone",
  guardian1Relationship: "parent",
  guardian1RelationshipOther: "",
  guardian1Phone: "808-555-1234",
};

describe("prefillFromHealthRecord", () => {
  test("maps the record onto Section 1 fields", () => {
    const p = prefillFromHealthRecord(baseRecord, new Date("2026-08-02"));
    expect(p).toEqual({
      studentName: "Oliver Stone",
      dateOfBirth: "03/15/2018",
      grade: "2",
      schoolYear: "2026–2027",
      homeAddress: "123 Aloha St, Honolulu, HI 96816",
      guardianName: "Avery Stone",
      phone: "808-555-1234",
      relationship: "Parent",
      insurancePlan: "HMSA",
    });
  });

  test("blank strings map to undefined so the printed line stays blank", () => {
    const p = prefillFromHealthRecord(
      {
        ...baseRecord,
        childName: "  ",
        guardian1Phone: "",
      },
      new Date("2026-08-02"),
    );
    expect(p.studentName).toBeUndefined();
    expect(p.phone).toBeUndefined();
  });

  test("falls back to the legacy single-string address when parts are missing", () => {
    const p = prefillFromHealthRecord(
      { ...baseRecord, streetAddress: "", city: "" },
      new Date("2026-08-02"),
    );
    expect(p.homeAddress).toBe("123 Aloha St, Honolulu, HI 96816");
  });

  test('an "other" relationship uses the free-text label', () => {
    const p = prefillFromHealthRecord(
      {
        ...baseRecord,
        guardian1Relationship: "other",
        guardian1RelationshipOther: "Hanai aunt",
      },
      new Date("2026-08-02"),
    );
    expect(p.relationship).toBe("Hanai aunt");
  });
});

describe("formatDob", () => {
  test("formats ISO dates as MM/DD/YYYY", () => {
    expect(formatDob("2018-03-15")).toBe("03/15/2018");
  });
  test("passes through non-ISO values untouched", () => {
    expect(formatDob("3/15/18")).toBe("3/15/18");
  });
  test("returns undefined for blank", () => {
    expect(formatDob("")).toBeUndefined();
    expect(formatDob(undefined)).toBeUndefined();
  });
});

describe("schoolYearFor", () => {
  test("August onward starts the new school year", () => {
    expect(schoolYearFor(new Date(2026, 7, 2))).toBe("2026–2027");
  });
  test("spring belongs to the year that started the previous fall", () => {
    expect(schoolYearFor(new Date(2026, 2, 1))).toBe("2025–2026");
  });
});

describe("buildInsuranceItems", () => {
  test("no plan → all boxes empty with the blank Other line", () => {
    const items = buildInsuranceItems(undefined);
    expect(items).toHaveLength(6);
    expect(items.every((i) => !i.checked)).toBe(true);
    expect(items[4].label).toBe("Other: ____________________");
  });

  test("a known plan ticks its box", () => {
    const items = buildInsuranceItems("Kaiser Permanente HMO");
    expect(items.find((i) => i.label === "Kaiser Permanente")?.checked).toBe(
      true,
    );
    expect(items.filter((i) => i.checked)).toHaveLength(1);
  });

  test("Med-QUEST matches the Medicaid box", () => {
    const items = buildInsuranceItems("Med-QUEST");
    expect(
      items.find((i) => i.label === "Medicaid / Med-QUEST")?.checked,
    ).toBe(true);
  });

  test("an unrecognized plan is written onto a ticked Other line", () => {
    const items = buildInsuranceItems("UHA Health");
    expect(items[4]).toEqual({ label: "Other: UHA Health", checked: true });
    expect(items.filter((i) => i.checked)).toHaveLength(1);
  });
});
