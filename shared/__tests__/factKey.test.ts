import { describe, expect, it } from "vitest";
import {
  FACT_FAMILY_SKILLS,
  factBelongsToFamily,
  factKeyFromOperands,
  factKeyLabel,
  factKeyOp,
  factOpGlyph,
  isFactFamilySkill,
  normalizeFactOp,
  parseFactKey,
} from "../factKey";
import { generateItem } from "../../convex/lib/practice/templates";

describe("normalizeFactOp", () => {
  it("maps every accepted spelling to a canonical op", () => {
    expect(normalizeFactOp("+")).toBe("add");
    expect(normalizeFactOp("−")).toBe("sub"); // U+2212
    expect(normalizeFactOp("-")).toBe("sub"); // ASCII hyphen
    expect(normalizeFactOp("×")).toBe("mul"); // U+00D7
    expect(normalizeFactOp("*")).toBe("mul");
    expect(normalizeFactOp("x")).toBe("mul");
  });
  it("rejects non-fact operators (e.g. division)", () => {
    expect(normalizeFactOp("÷")).toBeNull();
    expect(normalizeFactOp("/")).toBeNull();
    expect(normalizeFactOp("?")).toBeNull();
  });
});

describe("factKeyFromOperands", () => {
  it("sorts commutative operands so a×b ≡ b×a and a+b ≡ b+a", () => {
    expect(factKeyFromOperands(7, "×", 8)).toBe("mul:7x8");
    expect(factKeyFromOperands(8, "×", 7)).toBe("mul:7x8");
    expect(factKeyFromOperands(6, "+", 9)).toBe("add:6+9");
    expect(factKeyFromOperands(9, "+", 6)).toBe("add:6+9");
  });
  it("keeps subtraction order (non-commutative)", () => {
    expect(factKeyFromOperands(15, "−", 8)).toBe("sub:15-8");
    expect(factKeyFromOperands(8, "−", 15)).toBe("sub:8-15");
  });
  it("returns null for a bad operator or negative/non-integer operands", () => {
    expect(factKeyFromOperands(7, "÷", 8)).toBeNull();
    expect(factKeyFromOperands(-1, "+", 2)).toBeNull();
    expect(factKeyFromOperands(1.5, "+", 2)).toBeNull();
  });
});

describe("parseFactKey / factKeyOp round-trips", () => {
  it("round-trips every op", () => {
    for (const key of ["mul:7x8", "add:6+9", "sub:15-8"]) {
      const parsed = parseFactKey(key);
      expect(parsed).not.toBeNull();
      expect(factKeyFromOperands(parsed!.a, factOpGlyph(parsed!.op), parsed!.b)).toBe(key);
    }
  });
  it("reads the op prefix", () => {
    expect(factKeyOp("mul:7x8")).toBe("mul");
    expect(factKeyOp("sub:15-8")).toBe("sub");
    expect(factKeyOp("garbage")).toBeNull();
  });
  it("rejects keys whose separator does not match the operation prefix", () => {
    expect(parseFactKey("add:3x4")).toBeNull();
    expect(parseFactKey("sub:3+4")).toBeNull();
    expect(parseFactKey("mul:3-4")).toBeNull();
  });
});

describe("factKeyLabel", () => {
  it("renders real glyphs", () => {
    expect(factKeyLabel("mul:7x8")).toBe("7 × 8");
    expect(factKeyLabel("sub:15-8")).toBe("15 − 8");
    expect(factKeyLabel("add:6+9")).toBe("6 + 9");
  });
  it("returns the raw key rather than throwing on garbage", () => {
    expect(factKeyLabel("not-a-key")).toBe("not-a-key");
  });
});

describe("FACT_FAMILY_SKILLS", () => {
  it("gates known fact families in and non-facts out", () => {
    expect(isFactFamilySkill("mult_facts_7_8_9")).toBe(true);
    expect(isFactFamilySkill("add_subtract_fluency_within_20")).toBe(true);
    expect(isFactFamilySkill("place_value_hundreds")).toBe(false);
    expect(FACT_FAMILY_SKILLS.has("fractions_equivalent")).toBe(false);
  });

  it("matches every registered family's real generated operand space", () => {
    const disjointSkill: Record<string, string> = {
      add_within_5: "mult_facts_7_8_9",
      add_within_10: "mult_facts_7_8_9",
      add_within_20_no_regroup: "mult_facts_7_8_9",
      add_within_20_regroup: "mult_facts_7_8_9",
      subtract_within_5: "mult_facts_7_8_9",
      subtract_within_10: "mult_facts_7_8_9",
      subtract_within_20: "mult_facts_7_8_9",
      add_subtract_fluency_within_20: "mult_facts_7_8_9",
      mult_facts_0_1_2_5_10: "subtract_within_20",
      mult_facts_3_4_6: "subtract_within_20",
      mult_facts_7_8_9: "subtract_within_20",
    };

    for (const skillKey of FACT_FAMILY_SKILLS) {
      const foreignSkill = disjointSkill[skillKey];
      expect(foreignSkill).toBeDefined();
      for (let seed = 1; seed <= 128; seed++) {
        const item = generateItem(skillKey, seed);
        const foreign = generateItem(foreignSkill, seed);
        expect(item?.variant).toBeDefined();
        expect(foreign?.variant).toBeDefined();
        const key = factKeyFromOperands(
          item!.variant!.a,
          item!.variant!.op,
          item!.variant!.b,
        );
        const foreignKey = factKeyFromOperands(
          foreign!.variant!.a,
          foreign!.variant!.op,
          foreign!.variant!.b,
        );
        expect(key && factBelongsToFamily(key, skillKey)).toBe(true);
        expect(foreignKey && factBelongsToFamily(foreignKey, skillKey)).toBe(false);
      }
    }
  });

  it("recognizes canonical facts shared by overlapping multiplication families", () => {
    expect(factBelongsToFamily("mul:3x7", "mult_facts_3_4_6")).toBe(true);
    expect(factBelongsToFamily("mul:3x7", "mult_facts_7_8_9")).toBe(true);
    expect(factBelongsToFamily("mul:3x7", "mult_facts_0_1_2_5_10")).toBe(false);
  });
});
