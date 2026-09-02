/**
 * Units as part of the answer — the feature that spans `lib/practice/answers.ts`
 * (the unit registry + suffix split), `templates.ts` (which families declare a
 * required unit), `practiceItems.answerUnit` (which STORED rows declare one),
 * and `servable.ts` (the grader that enforces both).
 *
 * The product rule these pin: when a question names a unit, "112" is an
 * INCOMPLETE answer to it. Before this, `parseAnswer` stripped the unit away, so
 * "112" and "112 cm³" were indistinguishable at the grader.
 *
 * Pure tests — no Convex ctx.
 */

import { describe, expect, test } from "vitest";
import {
  formatUnit,
  hasUnitToken,
  parseAnswer,
  parseAnswerWithUnit,
  parseUnitKey,
  splitUnitSuffix,
  textNamesUnit,
  UNIT_KEYS,
  type UnitKey,
} from "../practice/answers";
import { generateItem } from "../practice/templates";
import { makeItemId, gradeTemplateItem } from "../practice/session";
import {
  buildStoredServable,
  buildTemplateServable,
  gradeSubmission,
  GRADE_ONLY_POLICY,
  PLACEMENT_POLICY,
  PRACTICE_POLICY,
  type ServableItem,
  type StoredPracticeItem,
  type Submission,
} from "../practice/servable";
import type { Id } from "../../_generated/dataModel";

const DOMAIN = "geometry-measurement";

/** The screenshot item: "Find the rectangular prism's volume in cubic
 *  centimeters." — an integer answer that must carry cm³. */
const VOLUME_KEY = "volume_rectangular_prism";
const VOLUME_SEED = 7;

function volumeServable(): ServableItem {
  const item = buildTemplateServable(
    makeItemId(VOLUME_KEY, VOLUME_SEED),
    { label: "Volume of a rectangular prism", domain: DOMAIN },
    DOMAIN,
  );
  expect(item).not.toBeNull();
  return item!;
}

/** The by-construction correct value of that item, as a bare number string. */
function volumeValue(): string {
  const generated = generateItem(VOLUME_KEY, VOLUME_SEED);
  expect(generated?.answer.type).toBe("integer");
  if (generated?.answer.type !== "integer") throw new Error("unexpected answer type");
  return String(generated.answer.value);
}

/** An angle item ("…measure in degrees?") — an integer answer that must carry °. */
const ANGLE_KEY = "angle_measure_protractor";
const ANGLE_SEED = 23;

function angleServable(): ServableItem {
  const item = buildTemplateServable(
    makeItemId(ANGLE_KEY, ANGLE_SEED),
    { label: "Measure an angle", domain: DOMAIN },
    DOMAIN,
  );
  expect(item).not.toBeNull();
  return item!;
}

function angleValue(): string {
  const generated = generateItem(ANGLE_KEY, ANGLE_SEED);
  expect(generated?.answer.type).toBe("integer");
  if (generated?.answer.type !== "integer") throw new Error("unexpected answer type");
  return String(generated.answer.value);
}

describe("unit registry — splitUnitSuffix", () => {
  const cases: [string, string, UnitKey | null][] = [
    ["112 cm³", "112", "cm^3"],
    ["112 cm^3", "112", "cm^3"],
    ["112cm3", "112", "cm^3"],
    ["112 cubic centimeters", "112", "cm^3"],
    ["112 cc", "112", "cm^3"],
    ["112 CUBIC CENTIMETRES", "112", "cm^3"],
    ["24 sq cm", "24", "cm^2"],
    ["24 square centimeter", "24", "cm^2"],
    ["8 m2", "8", "m^2"],
    ["8 m²", "8", "m^2"],
    ["6.5 m³", "6.5", "m^3"],
    ["14 cm", "14", "cm"],
    ["14 centimetres", "14", "cm"],
    ["14 m", "14", "m"],
    ["14 meters", "14", "m"],
    // Angles — the ° sign binds directly ("65°"), and the written words work too.
    ["65°", "65", "deg"],
    ["65 °", "65", "deg"],
    ["65 degrees", "65", "deg"],
    ["90 degree", "90", "deg"],
    ["90 deg", "90", "deg"],
  ];
  for (const [raw, value, unit] of cases) {
    test(`"${raw}" → ${value} + ${unit}`, () => {
      const split = splitUnitSuffix(raw);
      expect(split.value).toBe(value);
      expect(split.unit).toBe(unit);
      expect(split.unitRaw).not.toBeNull();
    });
  }

  test("an unrecognized unit still splits, but has no canonical key", () => {
    const split = splitUnitSuffix("112 dogs");
    expect(split.value).toBe("112");
    expect(split.unitRaw).toBe("dogs");
    expect(split.unit).toBeNull();
  });

  test("a unit alias that is the tail of a longer word is not a match", () => {
    // "gram" ends in "m"; splitting there would leave "8 gra" and stop parsing
    // entirely. The generic fallback reads it as 8 with an unknown unit.
    const split = splitUnitSuffix("8 grams");
    expect(split.value).toBe("8");
    expect(split.unit).toBeNull();
    expect(parseAnswer("8 grams", "integer")).toEqual({ type: "integer", value: 8 });
  });

  test("longest alias wins — 'cm' is never read as 'm'", () => {
    expect(splitUnitSuffix("14 cm").unit).toBe("cm");
    expect(splitUnitSuffix("14 square centimeters").unit).toBe("cm^2");
  });

  test("a bare number has no unit at all", () => {
    expect(splitUnitSuffix("112")).toEqual({ value: "112", unitRaw: null, unit: null });
    expect(hasUnitToken("112")).toBe(false);
  });

  test("a mixed number is untouched", () => {
    expect(splitUnitSuffix("2 1/2")).toEqual({ value: "2 1/2", unitRaw: null, unit: null });
    expect(parseAnswer("2 1/2", "fraction")).toEqual({ type: "fraction", num: 5, den: 2 });
  });

  test("hasUnitToken is true for a recognized AND an unrecognized unit", () => {
    expect(hasUnitToken("112 cm³")).toBe(true);
    expect(hasUnitToken("112 dogs")).toBe(true);
  });

  test("formatUnit renders the display form", () => {
    expect(formatUnit("cm")).toBe("cm");
    expect(formatUnit("m")).toBe("m");
    expect(formatUnit("cm^2")).toBe("cm²");
    expect(formatUnit("m^2")).toBe("m²");
    expect(formatUnit("cm^3")).toBe("cm³");
    expect(formatUnit("m^3")).toBe("m³");
    expect(formatUnit("deg")).toBe("°");
  });
});

describe("parseAnswerWithUnit", () => {
  test("a multi-word unit now parses — the widening over the old strip regex", () => {
    const parsed = parseAnswerWithUnit("112 cubic centimeters", "integer");
    expect(parsed.answer).toEqual({ type: "integer", value: 112 });
    expect(parsed.unit).toBe("cm^3");
  });

  test("value + unit are reported independently of each other", () => {
    const parsed = parseAnswerWithUnit("112 cm²", "integer");
    expect(parsed.answer).toEqual({ type: "integer", value: 112 });
    expect(parsed.unit).toBe("cm^2");
  });

  test("a leading variable assignment is still stripped first", () => {
    expect(parseAnswerWithUnit("x = 8 cm", "integer")).toEqual({
      answer: { type: "integer", value: 8 },
      unit: "cm",
      unitRaw: "cm",
    });
  });

  test("an EXPRESSION never unit-splits — the remainder form survives", () => {
    const parsed = parseAnswerWithUnit("7r2", "expression");
    expect(parsed.answer).toEqual({ type: "expression", canonical: "7r2" });
    expect(parsed.unit).toBeNull();
    expect(parsed.unitRaw).toBeNull();
    expect(parseAnswer("7 R 2", "expression")).toEqual({
      type: "expression",
      canonical: "7r2",
    });
  });

  test("currency notation is unaffected", () => {
    expect(parseAnswer("$1,250", "integer")).toEqual({ type: "integer", value: 1250 });
  });
});

describe("templates declare their answer unit", () => {
  test("volume_rectangular_prism resolves with cm³ on the prompt and cm^3 on the verifier", () => {
    const item = volumeServable();
    expect(item.prompt.answerUnit).toBe("cm³");
    expect(item.kind).toBe("template");
    if (item.kind !== "template") throw new Error("expected a template item");
    expect(item.verifier.requiredUnit).toBe("cm^3");
  });

  test("the unit-bearing geometry families each declare the unit their stem names", () => {
    const expected: Record<string, UnitKey> = {
      perimeter_polygons: "cm",
      area_rectangle: "cm^2",
      area_distributive: "cm^2",
      area_rectilinear_decompose: "cm^2",
      perimeter_composite: "cm",
      area_perimeter_unknown_side: "cm",
      area_fraction_side: "m^2",
      volume_rectangular_prism: "cm^3",
      volume_composite_prisms: "cm^3",
      volume_unknown_dimension: "cm",
      volume_fractional_edges: "m^3",
      surface_area_nets: "cm^2",
      // Angle families answer in degrees — the ° key rides the same unit
      // mechanism (one ° key, since degrees is dimensionless).
      angle_turns_circle: "deg",
      angle_measure_protractor: "deg",
      angle_additivity: "deg",
      angle_sum_triangle: "deg",
    };
    for (const [skillKey, unit] of Object.entries(expected)) {
      expect(generateItem(skillKey, 5)?.answerUnit, skillKey).toBe(unit);
    }
  });

  test("abstract-unit and 'number only' families stay unit-free", () => {
    // "square units" / "cubic units" stems, a multiple-choice item, and the
    // triangle-area stem that explicitly asks for the number alone.
    for (const skillKey of [
      "area_unit_squares",
      "area_composite_polygons",
      "area_triangle",
      "volume_conservation",
      "nets_of_solids",
      "area_perimeter_relationship",
    ]) {
      expect(generateItem(skillKey, 5)?.answerUnit, skillKey).toBeUndefined();
    }
  });

  test("the missing-operand FORM drops the unit — its answer is a bare operand", () => {
    const missing = generateItem(VOLUME_KEY, VOLUME_SEED, "missing");
    expect(missing?.form).toBe("missing");
    expect(missing?.answerUnit).toBeUndefined();
    const item = buildTemplateServable(
      makeItemId(VOLUME_KEY, VOLUME_SEED, "missing"),
      null,
      DOMAIN,
    );
    expect(item?.prompt.answerUnit).toBeUndefined();
  });
});

describe("gradeSubmission enforces the required unit", () => {
  const typed = (raw: string): Submission => ({ kind: "typed", raw });

  // The verdict must not depend on the policy — only the side-effect intentions
  // do — so the matrix runs under both the drill and the record-nothing policy.
  for (const policy of [PRACTICE_POLICY, GRADE_ONLY_POLICY]) {
    describe(policy.surface, () => {
      test("right value + right unit is correct", () => {
        const grade = gradeSubmission(
          volumeServable(),
          typed(`${volumeValue()} cm³`),
          policy,
        );
        expect(grade.correct).toBe(true);
        expect(grade.unitOutcome).toBeUndefined();
      });

      test("every written form of the right unit is accepted", () => {
        for (const suffix of ["cm³", "cm^3", "cm3", " cubic centimeters", " cc"]) {
          const grade = gradeSubmission(
            volumeServable(),
            typed(`${volumeValue()}${suffix.startsWith(" ") ? "" : " "}${suffix.trim()}`),
            policy,
          );
          expect(grade.correct, suffix).toBe(true);
        }
      });

      test("right value + NO unit is incorrect, and says so", () => {
        const grade = gradeSubmission(volumeServable(), typed(volumeValue()), policy);
        expect(grade.correct).toBe(false);
        expect(grade.unitOutcome).toBe("missing");
      });

      test("right value + the WRONG unit is incorrect, and says so", () => {
        const grade = gradeSubmission(
          volumeServable(),
          typed(`${volumeValue()} cm²`),
          policy,
        );
        expect(grade.correct).toBe(false);
        expect(grade.unitOutcome).toBe("wrong");
      });

      test("an unrecognized unit counts as WRONG, not missing", () => {
        const grade = gradeSubmission(
          volumeServable(),
          typed(`${volumeValue()} dogs`),
          policy,
        );
        expect(grade.correct).toBe(false);
        expect(grade.unitOutcome).toBe("wrong");
      });

      test("a wrong VALUE reports no unitOutcome — the unit is not what went wrong", () => {
        for (const raw of ["999999", "999999 cm³", "999999 cm²"]) {
          const grade = gradeSubmission(volumeServable(), typed(raw), policy);
          expect(grade.correct, raw).toBe(false);
          expect(grade.unitOutcome, raw).toBeUndefined();
        }
      });

      test("dontKnow is unchanged — a miss with no unit note", () => {
        const grade = gradeSubmission(volumeServable(), { kind: "dontKnow" }, policy);
        expect(grade.correct).toBe(false);
        expect(grade.isDontKnow).toBe(true);
        expect(grade.unitOutcome).toBeUndefined();
      });
    });
  }

  describe("degrees is a required unit, bound to the number with no space", () => {
    test("the served item carries ° on the prompt and deg on the verifier", () => {
      const item = angleServable();
      expect(item.prompt.answerUnit).toBe("°");
      expect(item.kind).toBe("template");
      if (item.kind !== "template") throw new Error("expected a template item");
      expect(item.verifier.requiredUnit).toBe("deg");
    });

    test("right value + ° is correct (both the bound and spaced forms)", () => {
      for (const raw of [`${angleValue()}°`, `${angleValue()} °`, `${angleValue()} degrees`]) {
        const grade = gradeSubmission(angleServable(), typed(raw), PRACTICE_POLICY);
        expect(grade.correct, raw).toBe(true);
        expect(grade.unitOutcome, raw).toBeUndefined();
      }
    });

    test("right value + NO unit is incomplete, and says so", () => {
      const grade = gradeSubmission(angleServable(), typed(angleValue()), PRACTICE_POLICY);
      expect(grade.correct).toBe(false);
      expect(grade.unitOutcome).toBe("missing");
    });

    test("right value + a length unit is the WRONG unit", () => {
      const grade = gradeSubmission(angleServable(), typed(`${angleValue()} cm`), PRACTICE_POLICY);
      expect(grade.correct).toBe(false);
      expect(grade.unitOutcome).toBe("wrong");
    });
  });

  test("a unit-free template is unaffected — a trailing unit is still ignored", () => {
    const item = buildTemplateServable(makeItemId("count_to_10", 7), null, "whole-number-arithmetic");
    expect(item?.prompt.answerUnit).toBeUndefined();
    const truth = generateItem("count_to_10", 7)!;
    if (truth.answer.type !== "integer") throw new Error("unexpected answer type");
    const grade = gradeSubmission(item!, typed(`${truth.answer.value} apples`), PRACTICE_POLICY);
    expect(grade.correct).toBe(true);
    expect(grade.unitOutcome).toBeUndefined();
  });

  test("the reveal models the FULL expected answer, unit included", () => {
    // PLACEMENT_POLICY reveals on a miss too (a locked measurement), so a kid
    // who left the unit off is shown the complete form.
    const missed = gradeSubmission(volumeServable(), typed(volumeValue()), PLACEMENT_POLICY);
    expect(missed.revealedAnswer).toBe(`${volumeValue()} cm³`);
    const won = gradeSubmission(
      volumeServable(),
      typed(`${volumeValue()} cm³`),
      PRACTICE_POLICY,
    );
    expect(won.revealedAnswer).toBe(`${volumeValue()} cm³`);
  });

  test("correctAnswer stays the BARE server truth — it feeds the error classifier", () => {
    const grade = gradeSubmission(volumeServable(), typed("1"), PRACTICE_POLICY);
    expect(grade.correctAnswer).toBe(volumeValue());
  });
});

describe("gradeTemplateItem (the answer oracle) agrees with the dispatcher", () => {
  test("its correctAnswer is re-submittable to the real grader", () => {
    const itemId = makeItemId(VOLUME_KEY, VOLUME_SEED);
    const oracle = gradeTemplateItem(itemId, "0")!;
    expect(oracle.correctAnswer).toBe(`${volumeValue()} cm³`);
    expect(gradeTemplateItem(itemId, oracle.correctAnswer)!.correct).toBe(true);
    expect(
      gradeSubmission(volumeServable(), { kind: "typed", raw: oracle.correctAnswer }, PRACTICE_POLICY)
        .correct,
    ).toBe(true);
  });

  test("a bare number no longer satisfies a unit-bearing template", () => {
    expect(gradeTemplateItem(makeItemId(VOLUME_KEY, VOLUME_SEED), volumeValue())!.correct).toBe(
      false,
    );
  });
});

// ── STORED items (the LLM word-problem bank) ───────────────────────────────

describe("the unit registry's text helpers", () => {
  test("parseUnitKey is the inverse of formatUnit, over every canonical key", () => {
    for (const key of UNIT_KEYS) {
      expect(parseUnitKey(formatUnit(key)), key).toBe(key);
    }
  });

  test("parseUnitKey accepts any written alias, cased or padded", () => {
    expect(parseUnitKey(" Cubic Centimeters ")).toBe("cm^3");
    expect(parseUnitKey("sq m")).toBe("m^2");
    expect(parseUnitKey("degrees")).toBe("deg");
  });

  test("parseUnitKey is null for a unit the grader can't normalize", () => {
    // Null, not a throw: the caller degrades to unit-free grading rather than
    // demanding a unit it could never check.
    expect(parseUnitKey("dogs")).toBeNull();
    expect(parseUnitKey("liters")).toBeNull();
    expect(parseUnitKey("")).toBeNull();
  });

  test("textNamesUnit finds the unit a stem asks for, in words or symbols", () => {
    expect(textNamesUnit("What is the volume in cubic centimeters?", "cm^3")).toBe(true);
    expect(textNamesUnit("How many cm³ of water fit inside?", "cm^3")).toBe(true);
    expect(textNamesUnit("What is the angle's measure in degrees?", "deg")).toBe(true);
    expect(textNamesUnit("The ribbon is cut into 14 cm pieces.", "cm")).toBe(true);
    expect(textNamesUnit("The angle measures 65°.", "deg")).toBe(true);
    expect(textNamesUnit("The ribbon is 8m long.", "m")).toBe(true);
    expect(textNamesUnit("The elevation change is -3m.", "m")).toBe(true);
  });

  test("textNamesUnit is false when the stem never asks for it", () => {
    expect(textNamesUnit("Maya packs 6 boxes with 7 shells each.", "cm^3")).toBe(false);
    // A unit alias buried inside a longer word is not the stem naming the unit.
    expect(textNamesUnit("The recipe needs 8 grams of yeast.", "m")).toBe(false);
    expect(textNamesUnit("The metermaid records each sample.", "m")).toBe(false);
    // "cm" inside "cm³" belongs to the cubic unit, not the linear one.
    expect(textNamesUnit("Give the volume in cm³.", "cm")).toBe(false);
    // A trailing digit keeps the alias inside a larger token.
    expect(textNamesUnit("The sample code is 8m4.", "m")).toBe(false);
    // A leading digit run does not split an identifier into a unit-bearing value.
    expect(textNamesUnit("The sample code is x8m.", "m")).toBe(false);
    expect(textNamesUnit("The sample code is x_8m.", "m")).toBe(false);
    // Scientific-notation exponents remain one token, including a signed exponent.
    expect(textNamesUnit("The value is 1e3m.", "m")).toBe(false);
    expect(textNamesUnit("The value is 1e-3m.", "m")).toBe(false);
    expect(textNamesUnit("The value is 1e+3m.", "m")).toBe(false);
  });
});

describe("a STORED item declares its answer unit", () => {
  const typed = (raw: string): Submission => ({ kind: "typed", raw });
  const DOMAIN_WNA = "whole-number-arithmetic";

  /** A stored word problem, unit-free by default — the shape of every row that
   *  predates the `answerUnit` column. */
  function storedDoc(overrides: Partial<StoredPracticeItem> = {}): StoredPracticeItem {
    return {
      _id: "storedUnit1" as Id<"practiceItems">,
      skillKey: "volume_rectangular_prism",
      stem: "A tank is 4 by 4 by 7. What is its volume in cubic centimeters?",
      answerType: "integer",
      answerCanonical: "112",
      verifierKind: "arithmetic",
      ...overrides,
    };
  }

  function servable(overrides: Partial<StoredPracticeItem> = {}): ServableItem {
    const item = buildStoredServable("gen#storedUnit1", storedDoc(overrides), null, DOMAIN_WNA);
    expect(item).not.toBeNull();
    return item!;
  }

  test("it resolves to cm³ on the prompt and cm^3 on the verifier, like a template", () => {
    const item = servable({ answerUnit: "cm³" });
    expect(item.prompt.answerUnit).toBe("cm³");
    expect(item.kind).toBe("stored");
    if (item.kind !== "stored") throw new Error("expected a stored item");
    expect(item.verifier.requiredUnit).toBe("cm^3");
  });

  test("the stored value is normalized through the registry, not echoed raw", () => {
    // Authored as a written phrase; served as the canonical display glyph, so
    // the pad renders identically whichever alias the author typed.
    const item = servable({ answerUnit: "cubic centimeters" });
    expect(item.prompt.answerUnit).toBe("cm³");
  });

  // The verdict must not depend on the policy — only the side-effect intentions
  // do — so the matrix runs under both the drill and the record-nothing policy.
  for (const policy of [PRACTICE_POLICY, GRADE_ONLY_POLICY]) {
    describe(policy.surface, () => {
      test("right value + right unit is correct", () => {
        const grade = gradeSubmission(servable({ answerUnit: "cm³" }), typed("112 cm³"), policy);
        expect(grade.correct).toBe(true);
        expect(grade.unitOutcome).toBeUndefined();
      });

      test("every written form of the right unit is accepted", () => {
        for (const raw of ["112 cm^3", "112cm3", "112 cubic centimeters", "112 cc"]) {
          expect(
            gradeSubmission(servable({ answerUnit: "cm³" }), typed(raw), policy).correct,
            raw,
          ).toBe(true);
        }
      });

      test("right value + NO unit is incorrect, and says so", () => {
        const grade = gradeSubmission(servable({ answerUnit: "cm³" }), typed("112"), policy);
        expect(grade.correct).toBe(false);
        expect(grade.unitOutcome).toBe("missing");
      });

      test("right value + the WRONG unit is incorrect, and says so", () => {
        for (const [raw, outcome] of [
          ["112 cm²", "wrong"],
          ["112 cm", "wrong"],
          ["112 dogs", "wrong"],
        ] as const) {
          const grade = gradeSubmission(servable({ answerUnit: "cm³" }), typed(raw), policy);
          expect(grade.correct, raw).toBe(false);
          expect(grade.unitOutcome, raw).toBe(outcome);
        }
      });

      test("a wrong VALUE reports no unitOutcome — the unit is not what went wrong", () => {
        const grade = gradeSubmission(servable({ answerUnit: "cm³" }), typed("999 cm³"), policy);
        expect(grade.correct).toBe(false);
        expect(grade.unitOutcome).toBeUndefined();
      });

      // ── THE REGRESSION GUARD ──────────────────────────────────────────
      // Every stored row that exists today has no `answerUnit`. Widening the
      // schema must not change one of them by a single verdict.
      test("a stored item WITHOUT a unit still grades unit-free", () => {
        const item = servable();
        expect(item.prompt.answerUnit).toBeUndefined();
        if (item.kind !== "stored") throw new Error("expected a stored item");
        expect(item.verifier.requiredUnit).toBeUndefined();
        for (const raw of ["112", "112 cm³", "112 cm²", "112 dogs"]) {
          const grade = gradeSubmission(item, typed(raw), policy);
          expect(grade.correct, raw).toBe(true);
          expect(grade.unitOutcome, raw).toBeUndefined();
        }
      });
    });
  }

  test("a unit the registry can't normalize degrades to unit-free grading", () => {
    // Never an unsatisfiable requirement: if the grader can't canonicalize the
    // stored token, the item grades exactly as it did before the column existed.
    const item = servable({ answerUnit: "furlongs" });
    expect(item.prompt.answerUnit).toBeUndefined();
    if (item.kind !== "stored") throw new Error("expected a stored item");
    expect(item.verifier.requiredUnit).toBeUndefined();
    expect(gradeSubmission(item, typed("112"), PRACTICE_POLICY).correct).toBe(true);
  });

  test("a multiple-choice row never requires a unit — a tapped index can't carry one", () => {
    const item = servable({
      answerType: "multipleChoice",
      answerCanonical: "1",
      choices: ["56", "112"],
      answerUnit: "cm³",
    });
    expect(item.prompt.answerUnit).toBeUndefined();
    expect(gradeSubmission(item, { kind: "choice", index: 1 }, PRACTICE_POLICY).correct).toBe(true);
  });

  test("the reveal models the FULL expected answer, unit included", () => {
    const missed = gradeSubmission(servable({ answerUnit: "cm³" }), typed("112"), PLACEMENT_POLICY);
    expect(missed.revealedAnswer).toBe("112 cm³");
    // correctAnswer stays the BARE server truth — it feeds the error classifier.
    expect(missed.correctAnswer).toBe("112");
  });
});
