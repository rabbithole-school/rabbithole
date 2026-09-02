import { describe, expect, test } from "vitest";
import {
  expressionAnswerSignals,
  expressionAnswerSignalsFromCanonical,
} from "../practice/answerShape";
import { formatAnswer } from "../practice/answers";
import { generateItem, hasTemplate } from "../practice/templates";
import { gradeTemplateItem, makeItemId } from "../practice/session";
import type { TypedAnswer } from "../practice/answers";

const expr = (canonical: string): TypedAnswer => ({ type: "expression", canonical });

describe("expressionAnswerSignals — 2-D editor routing", () => {
  test("a genuine fraction answer is twoD with a non-leaky skeleton", () => {
    expect(expressionAnswerSignals("expression", expr("3/4"))).toEqual({
      answerShape: "twoD",
      answerFormat: "F(_/_)",
    });
  });

  test("a complex (nested) fraction nests in both shape and skeleton", () => {
    expect(expressionAnswerSignals("expression", expr("(2/3)/4"))).toEqual({
      answerShape: "twoD",
      answerFormat: "F(F(_/_)/_)",
    });
  });

  test("a power is twoD but gets NO L1 skeleton (fractions-only seed grammar)", () => {
    expect(expressionAnswerSignals("expression", expr("2^5"))).toEqual({
      answerShape: "twoD",
    });
  });

  test("a power with a fraction base still builds (nested), no skeleton", () => {
    expect(expressionAnswerSignals("expression", expr("(1/2)^3"))).toEqual({
      answerShape: "twoD",
    });
  });

  test("a simplified radical is twoD with no answer-leaking scaffold", () => {
    expect(expressionAnswerSignals("expression", expr("3√7"))).toEqual({
      answerShape: "twoD",
    });
    expect(expressionAnswerSignalsFromCanonical("expression", "3√7")).toEqual({
      answerShape: "twoD",
    });
    expect(expressionAnswerSignals("expression", expr("2√[4]3"))).toEqual({
      answerShape: "twoD",
    });
  });

  test("serves fourth- and fifth-root simplification items through the same editor", () => {
    const seen = new Set<number>();
    for (let seed = 1; seed <= 100; seed++) {
      const item = generateItem("roots_simplify_radicals", seed);
      if (item?.answer.type !== "expression") continue;
      const match = item.answer.canonical.match(/√\[(\d+)\]/);
      if (!match) continue;
      seen.add(Number(match[1]));
      expect(expressionAnswerSignals(item.answerType, item.answer)).toEqual({ answerShape: "twoD" });
      expect(gradeTemplateItem(makeItemId("roots_simplify_radicals", seed), item.answer.canonical)?.correct).toBe(
        true,
      );
    }
    expect(seen).toEqual(new Set([4, 5]));
  });

  test("the remainder form 7r1 is NOT twoD (routes to the plain pad)", () => {
    expect(expressionAnswerSignals("expression", expr("7r1"))).toEqual({});
  });

  test("additive / multiplicative answers are not buildable → plain pad", () => {
    expect(expressionAnswerSignals("expression", expr("1/2+3"))).toEqual({});
    expect(expressionAnswerSignals("expression", expr("2*3"))).toEqual({});
  });

  test("a bare number has no 2-D structure → plain pad", () => {
    expect(expressionAnswerSignals("expression", expr("5"))).toEqual({});
  });

  test("a leading-minus answer is not buildable (pad has no key)", () => {
    expect(expressionAnswerSignals("expression", expr("-1/2"))).toEqual({});
  });

  test("a genuine fraction ANSWER TYPE is twoD too (the common real case)", () => {
    // Most fraction word problems carry answerType "fraction" (canonical n/d),
    // not "expression" — they must open the box editor just the same.
    expect(
      expressionAnswerSignals("fraction", { type: "fraction", num: 2, den: 3 }),
    ).toEqual({ answerShape: "twoD", answerFormat: "F(_/_)" });
    // An improper fraction is still a single fraction.
    expect(
      expressionAnswerSignals("fraction", { type: "fraction", num: 7, den: 4 }),
    ).toEqual({ answerShape: "twoD", answerFormat: "F(_/_)" });
  });

  test("a whole-number fraction answer (n/1) has no 2-D structure → plain pad", () => {
    expect(
      expressionAnswerSignals("fraction", { type: "fraction", num: 1, den: 1 }),
    ).toEqual({});
  });

  test("non-buildable answer types never get the signals", () => {
    expect(expressionAnswerSignals("integer", { type: "integer", value: 3 })).toEqual({});
    expect(expressionAnswerSignals("decimal", { type: "decimal", value: 0.5 })).toEqual({});
  });

  test("from-canonical entry point (stored items) matches the typed path", () => {
    // A stored fraction word problem carries its answer as a canonical string.
    expect(expressionAnswerSignalsFromCanonical("fraction", "2/3")).toEqual({
      answerShape: "twoD",
      answerFormat: "F(_/_)",
    });
    expect(expressionAnswerSignalsFromCanonical("expression", "(2/3)/4")).toEqual({
      answerShape: "twoD",
      answerFormat: "F(F(_/_)/_)",
    });
    // A stored plain-text or numeric answer never routes to the box editor.
    expect(expressionAnswerSignalsFromCanonical("text", "2/3")).toEqual({});
    expect(expressionAnswerSignalsFromCanonical("integer", "5")).toEqual({});
  });
});

describe("fraction_as_division — the 2-D editor's first served skill", () => {
  test("is templated", () => {
    expect(hasTemplate("fraction_as_division")).toBe(true);
  });

  test("every generated item is a twoD fraction that round-trips through grading", () => {
    for (let seed = 1; seed <= 50; seed++) {
      const item = generateItem("fraction_as_division", seed);
      expect(item, `seed=${seed}`).not.toBeNull();
      if (!item) continue;
      expect(item.answerType).toBe("expression");

      const signals = expressionAnswerSignals(item.answerType, item.answer);
      expect(signals.answerShape, `seed=${seed}: ${item.stem}`).toBe("twoD");
      expect(signals.answerFormat, `seed=${seed}: ${item.stem}`).toBe("F(_/_)");

      const graded = gradeTemplateItem(makeItemId("fraction_as_division", seed), formatAnswer(item.answer));
      expect(graded?.correct, `seed=${seed}: ${item.stem}`).toBe(true);
    }
  });
});
