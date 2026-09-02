import { describe, expect, test } from "vitest";
import {
  normalizeGrade,
  sirFizXCleanJsonToAsnEntries,
  type SirFizXCleanEntry,
} from "../asnStandardsAdapter";

describe("ASN standards adapter", () => {
  test("normalizes Common Core grade codes behavior-preservingly", () => {
    expect(normalizeGrade("KG")).toBe("K");
    expect(normalizeGrade("K")).toBe("K");
    expect(normalizeGrade("03")).toBe("3");
    expect(normalizeGrade("HS")).toBe("HS");
  });

  test("turns SirFizX clean JSON into ASN entries with resolved parent aliases", () => {
    const raw: SirFizXCleanEntry[] = [
      {
        id: "root-guid",
        subject: "Mathematics",
        statement: "Operations and Algebraic Thinking",
        gradeLevels: ["KG"],
        cls: "folder",
        ASN: { id: "SROOT", leaf: "false" },
      },
      {
        id: "cluster-guid",
        subject: "Mathematics",
        statement: "Represent and solve problems involving addition and subtraction.",
        gradelevels: ["KG"],
        cls: "folder",
        asnParent: "root-guid",
      },
      {
        id: "leaf-guid",
        subject: "Mathematics",
        statement: "Use addition and subtraction within 20 to solve word problems.",
        gradeLevels: ["01"],
        shortCode: "1.OA.1",
        statementLabel: "Standard",
        ASN: {
          id: "SLEAF",
          parent: "cluster-guid",
          leaf: "true",
          statementNotation: "1.OA.1",
        },
      },
    ];

    const entries = sirFizXCleanJsonToAsnEntries(raw);

    expect(entries).toEqual([
      {
        id: "SROOT",
        notation: undefined,
        description: "Operations and Algebraic Thinking",
        gradeLevels: ["K"],
        isLeaf: false,
        parent: undefined,
        label: "Domain",
      },
      {
        id: "cluster-guid",
        notation: undefined,
        description: "Represent and solve problems involving addition and subtraction.",
        gradeLevels: ["K"],
        isLeaf: false,
        parent: "SROOT",
        label: "Cluster",
      },
      {
        id: "SLEAF",
        notation: "1.OA.1",
        description: "Use addition and subtraction within 20 to solve word problems.",
        gradeLevels: ["1"],
        isLeaf: true,
        parent: "cluster-guid",
        label: "Standard",
      },
    ]);
  });
});
