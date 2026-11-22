import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
  type AnswerForm,
  type AnswerType,
  answersEqual,
  formatAnswer,
  meetsRequiredForm,
  parseAnswer,
} from "../lib/practice/answers";
import { POLY_DRAW } from "../lib/practice/algebra2/polynomials";
import { gradeTemplateItem, makeItemId } from "../lib/practice/session";
import { generateItem, hasTemplate, type PracticeItem } from "../lib/practice/templates";
import { ALGEBRA_2_SKILLS } from "../seed/algebra2Graph";
import {
  BANNED_STEM_PIECES,
  type C,
  distinctValues,
  evalReal,
  evaluate,
  interpolate,
  irreducibleOverZ,
  polyString,
  reverseTerms,
  roots,
  sameFunction,
  sameValueSet,
  splitFactors,
  texSpans,
  texToGrammar,
  untypableAnswer,
} from "./algebra2TestMath";

const FAMILIES: Record<
  string,
  { answerType: AnswerType; palette?: string; form?: AnswerForm }
> = {
  poly_zeros_multiplicity: { answerType: "solutionSet", palette: "algebra" },
  poly_factor_grouping_cubes: { answerType: "expression", palette: "algebra", form: "factored" },
  poly_factor_quadratic_form: { answerType: "expression", palette: "algebra", form: "factored" },
  poly_long_division: { answerType: "expression", palette: "algebra", form: "expanded" },
  poly_synthetic_division: { answerType: "expression", palette: "algebra", form: "expanded" },
  poly_remainder_theorem: { answerType: "integer" },
  poly_factor_theorem: { answerType: "expression", palette: "algebra", form: "factored" },
  poly_solve_higher_degree: { answerType: "solutionSet", palette: "complex" },
  poly_binomial_expansion: { answerType: "expression", palette: "algebra", form: "expanded" },
};
const KEYS = Object.keys(FAMILIES);
const SEEDS = Array.from({ length: 240 }, (_, i) => i * 7919 + 13);

function items(key: string): { seed: number; item: PracticeItem }[] {
  return SEEDS.map((seed) => ({ seed, item: generateItem(key, seed)! }));
}

const grade = (key: string, seed: number, raw: string) =>
  gradeTemplateItem(makeItemId(key, seed), raw)?.correct;

/** The polynomial a stem's span names, after any `p(x) =`. */
const polyOf = (span: string) => texToGrammar(span.replace(/^.*=\s*/, ""));
const setOf = (raw: string): C[] => {
  const parsed = parseAnswer(raw, "solutionSet");
  return parsed?.type === "solutionSet" ? parsed.members.map((m) => evaluate(m)) : [];
};
const members = (item: PracticeItem): C[] =>
  item.answer.type === "solutionSet" ? item.answer.members.map((m) => evaluate(m)) : [];

// Every suite runs twice: as served, and with every retry exhausted so each
// fallback is served and re-derived like any other draw.
describe.each([false, true])("algebra-2 polynomials templates (every retry exhausted: %s)", (forced) => {
  beforeAll(() => {
    if (forced) POLY_DRAW.attempts = 0;
  });
  afterAll(() => {
    POLY_DRAW.attempts = 200;
  });

  test("every typed answer can be entered on the pad it is served with", () => {
    for (const key of KEYS) {
      for (const seed of SEEDS) {
        const it = generateItem(key, seed)!;
        expect(untypableAnswer(it), `${key}#${seed} on ${it.answerPalette ?? it.answerType}: ${it.stem}`).toBeNull();
      }
    }
  });

  test("these are polynomials-strand nodes of the graph", () => {
    for (const key of KEYS) {
      expect(ALGEBRA_2_SKILLS.find((s) => s.skillKey === key)?.strand, key).toBe("polynomials");
    }
  });

  test("every family has a reproducible template with its declared type, palette and form", () => {
    for (const key of KEYS) {
      expect(hasTemplate(key), key).toBe(true);
      for (const seed of SEEDS) {
        const item = generateItem(key, seed)!;
        expect(item, key).toEqual(generateItem(key, seed));
        // A draw whose natural answer is one whole number is typed integer
        // (no algebra pad, so no palette).
        if (item.answerType === "integer") {
          expect(item.answer.type, item.stem).toBe("integer");
          expect(item.answerPalette, key).toBeUndefined();
          continue;
        }
        expect(item.answerType, key).toBe(FAMILIES[key].answerType);
        expect(item.answerPalette, key).toBe(FAMILIES[key].palette);
        expect(item.answerForm, key).toBe(FAMILIES[key].form);
      }
    }
  });

  test("every family varies (at least 12 distinct items)", () => {
    for (const key of KEYS) {
      const stems = new Set(items(key).map(({ item }) => item.stem));
      // A forced fallback is one fixed draw; variety belongs to normal draws.
      if (!forced) expect(stems.size, key).toBeGreaterThanOrEqual(12);
    }
  });

  test("stems are clean, typeset, and every item has 2–5 worked steps ending in the answer", () => {
    for (const key of KEYS) {
      for (const { item } of items(key)) {
        for (const bad of BANNED_STEM_PIECES) expect(item.stem, `${key}: ${item.stem}`).not.toMatch(bad);
        expect(texSpans(item.stem).length, item.stem).toBeGreaterThan(0);
        const steps = item.workedSteps ?? [];
        expect(steps.length, item.stem).toBeGreaterThanOrEqual(2);
        expect(steps.length, item.stem).toBeLessThanOrEqual(5);
        for (const step of steps) {
          expect(step.blankText, item.stem).toMatch(/\?$/);
          for (const bad of [/undefined/, /NaN/, /\+ -/, /--/]) expect(step.text, step.text).not.toMatch(bad);
        }
        expect(steps[steps.length - 1].text, item.stem).toContain(formatAnswer(item.answer));
      }
    }
  });

  test("every canonical answer grades correct, and meets its own form", () => {
    for (const key of KEYS) {
      for (const { seed, item } of items(key)) {
        expect(grade(key, seed, formatAnswer(item.answer)), `${key} ${item.stem}`).toBe(true);
        if (item.answerForm) {
          expect(
            meetsRequiredForm(formatAnswer(item.answer), formatAnswer(item.answer), item.answerForm, item.answerType),
            item.stem,
          ).toBe(true);
        }
      }
    }
  });

  // ── Re-derivations (never reuse the generators' arithmetic) ──────────────

  test("zeros: the listed set is exactly the polynomial's rational zeros; multiplicities count every copy", () => {
    let multiplicityItems = 0;
    let fractionZeros = 0;
    for (const { item } of items("poly_zeros_multiplicity")) {
      const spans = texSpans(item.stem);
      const pSpan = spans[spans.length - 1];
      const p = polyOf(pSpan);
      if (item.stem.startsWith("What is the multiplicity")) {
        multiplicityItems++;
        const a = evalReal(texToGrammar(spans[0].replace(/^x\s*=\s*/, "")));
        const { factors } = splitFactors(p.replace(/\^\((\d+)\)/g, "^$1"));
        let count = 0;
        for (const f of factors) {
          if (Math.abs(evalReal(f.expr, { x: a })) > 1e-9) continue;
          const coefficients = interpolate((x) => evalReal(f.expr, { x }), 3);
          const double = coefficients.length === 3 && coefficients[1] ** 2 === 4 * coefficients[0] * coefficients[2];
          count += f.power * (double ? 2 : 1);
        }
        expect(item.answer, item.stem).toEqual({ type: "integer", value: count });
        continue;
      }
      const found: C[] = [];
      for (let d = 1; d <= 3; d++)
        for (let k = -30; k <= 30; k++)
          if (Math.abs(evalReal(p, { x: k / d })) < 1e-7) found.push({ re: k / d, im: 0 });
      expect(sameValueSet(found, members(item), 1e-9), item.stem).toBe(true);
      if (item.answer.type === "solutionSet" && item.answer.members.some((m) => m.includes("/"))) fractionZeros++;
    }
    expect(multiplicityItems).toBeGreaterThan(20);
    expect(fractionZeros).toBeGreaterThan(10);
  });

  test("factoring families: the answer equals the polynomial, and every factor is irreducible and primitive", () => {
    for (const key of ["poly_factor_grouping_cubes", "poly_factor_quadratic_form", "poly_factor_theorem"]) {
      for (const { item } of items(key)) {
        const spans = texSpans(item.stem);
        const p = polyOf(key === "poly_factor_theorem" ? spans[1] : spans[0]);
        const answer = formatAnswer(item.answer);
        expect(sameFunction(answer, p), `${item.stem} → ${answer}`).toBe(true);
        for (const f of splitFactors(answer).factors) {
          expect(irreducibleOverZ(f.expr), `${answer}: ${f.expr}`).toBe(true);
        }
        if (key === "poly_factor_theorem") {
          const zero = evalReal(texToGrammar(spans[0].replace(/^x\s*=\s*/, "")));
          expect(Math.abs(evalReal(p, { x: zero })), item.stem).toBeLessThan(1e-9);
        }
      }
    }
  });

  test("division families: dividend − quotient·divisor is the remainder the item names", () => {
    for (const key of ["poly_long_division", "poly_synthetic_division"]) {
      let remainderAsked = 0;
      let quotientWithRemainder = 0;
      for (const { item } of items(key)) {
        const [dividendTex, divisorTex] = texSpans(item.stem);
        const dividend = texToGrammar(dividendTex);
        const divisor = texToGrammar(divisorTex);
        const answer = formatAnswer(item.answer);
        if (item.stem.includes("What is the remainder")) {
          remainderAsked++;
          // Divisors here are x − a: the remainder is the dividend at a.
          const a = -evalReal(divisor, { x: 0 });
          expect(evalReal(divisor, { x: 1 }) - evalReal(divisor, { x: 0 }), item.stem).toBe(1);
          expect(evalReal(answer), item.stem).toBeCloseTo(evalReal(dividend, { x: a }), 9);
          continue;
        }
        const leftover = (x: number) => evalReal(dividend, { x }) - evalReal(answer, { x }) * evalReal(divisor, { x });
        const values = [-2, -1, 0, 1, 2, 3].map(leftover);
        for (const v of values) expect(v, item.stem).toBeCloseTo(values[0], 9);
        if (item.stem.includes("There is a remainder")) {
          quotientWithRemainder++;
          expect(values[0], item.stem).not.toBe(0);
        } else {
          expect(values[0], item.stem).toBeCloseTo(0, 9);
        }
      }
      expect(remainderAsked, key).toBeGreaterThan(20);
      expect(quotientWithRemainder, key).toBeGreaterThan(20);
    }
  });

  test("division stems mark missing powers, and some draws need a placeholder 0", () => {
    for (const key of ["poly_long_division", "poly_synthetic_division"]) {
      const placeholder = items(key).filter(({ item }) => {
        const dividend = texToGrammar(texSpans(item.stem)[0]);
        const coefficients = interpolate((x) => evalReal(dividend, { x }), 4);
        return coefficients.slice(1).includes(0);
      });
      expect(placeholder.length, key).toBeGreaterThan(20);
    }
  });

  test("remainder theorem: the answer is p(a), or the k that makes p(a) = 0", () => {
    let findK = 0;
    let zeroRemainder = 0;
    for (const { item } of items("poly_remainder_theorem")) {
      const spans = texSpans(item.stem);
      const value = item.answer.type === "integer" ? item.answer.value : NaN;
      if (item.stem.startsWith("For what value of k")) {
        findK++;
        const a = -evalReal(texToGrammar(spans[0]), { x: 0 });
        expect(evalReal(polyOf(spans[1]), { x: a, k: value }), item.stem).toBeCloseTo(0, 9);
        continue;
      }
      const p = polyOf(spans[0]);
      const a = -evalReal(texToGrammar(spans[1]), { x: 0 });
      expect(value, item.stem).toBe(evalReal(p, { x: a }));
      if (value === 0) zeroRemainder++;
    }
    expect(findK).toBeGreaterThan(20);
    expect(zeroRemainder).toBeGreaterThan(10);
  });

  test("higher-degree solve: the set is every distinct complex root, each listed once", () => {
    const seen = { repeated: 0, irrational: 0, complex: 0 };
    for (const { item } of items("poly_solve_higher_degree")) {
      const [lhs, rhs] = texSpans(item.stem)[0].split("=").map(texToGrammar);
      const p = (x: number) => evalReal(lhs, { x }) - evalReal(rhs, { x });
      const coefficients = interpolate(p, 4);
      const all = roots(coefficients);
      const claimed = members(item);
      expect(sameValueSet(distinctValues(all, 1e-3), claimed, 1e-3), item.stem).toBe(true);
      for (const m of claimed) {
        const v = evaluate(`(${lhs})-(${rhs})`, { x: m });
        expect(Math.hypot(v.re, v.im), item.stem).toBeLessThan(1e-9);
      }
      if (distinctValues(all, 1e-3).length < all.length) seen.repeated++;
      if (item.answer.type === "solutionSet" && item.answer.members.some((m) => m.includes("√") && !m.includes("i"))) seen.irrational++;
      if (claimed.some((m) => Math.abs(m.im) > 1e-9)) seen.complex++;
    }
    expect(seen.repeated).toBeGreaterThan(20);
    expect(seen.irrational).toBeGreaterThan(20);
    expect(seen.complex).toBeGreaterThan(20);
  });

  test("binomial expansion: the expansion equals the power; a single coefficient matches interpolation", () => {
    let coefficientItems = 0;
    for (const { item } of items("poly_binomial_expansion")) {
      const spans = texSpans(item.stem);
      const answer = formatAnswer(item.answer);
      if (item.stem.startsWith("What is the coefficient")) {
        coefficientItems++;
        const power = spans[0] === "x" ? 1 : Number(/\^\{(\d+)\}/.exec(spans[0])![1]);
        const binomial = texToGrammar(spans[1]);
        const n = Number(/\^\{(\d+)\}\s*$/.exec(spans[1])![1]);
        const coefficients = interpolate((x) => evalReal(binomial, { x }), n);
        expect(evalReal(answer), item.stem).toBe(coefficients[n - power]);
        continue;
      }
      expect(sameFunction(answer, texToGrammar(spans[0]), ["x", "y"]), item.stem).toBe(true);
    }
    expect(coefficientItems).toBeGreaterThan(40);
  });

  // ── Grading: plausible wrong answers miss, equivalent rewrites pass ──────

  test("solution sets: reordered or 'x = … or …' forms pass; a dropped, added or sign-flipped member misses", () => {
    for (const key of ["poly_zeros_multiplicity", "poly_solve_higher_degree"]) {
      for (const { seed, item } of items(key)) {
        if (item.answer.type === "integer") {
          // A multiplicity: one whole number.
          const v = item.answer.value;
          expect(grade(key, seed, `m = ${v}`), item.stem).toBe(true);
          expect(grade(key, seed, `+${v}`), item.stem).toBe(true);
          expect(grade(key, seed, String(v + 1)), item.stem).toBe(false);
          expect(grade(key, seed, String(v - 1)), item.stem).toBe(false);
          continue;
        }
        if (item.answer.type !== "solutionSet") throw new Error("type");
        const list = item.answer.members;
        expect(grade(key, seed, [...list].reverse().join(", ")), item.stem).toBe(true);
        expect(grade(key, seed, list.map((m) => `x = ${m}`).join(" or ")), item.stem).toBe(true);
        const wrongs = [
          list.length > 1 ? list.slice(0, -1).join(", ") : "",
          [...list, "7/5"].join(", "),
          list.map((m) => `-(${m})`).join(", "),
        ].filter((w) => w && !sameValueSet(setOf(w), members(item), 1e-9));
        expect(wrongs.length, item.stem).toBeGreaterThanOrEqual(2);
        for (const w of wrongs) expect(grade(key, seed, w), `${item.stem} ← ${w}`).toBe(false);
      }
    }
  });

  test("solution sets accept ± and radical/complex spellings", () => {
    const solve = items("poly_solve_higher_degree").find(
      ({ item }) => item.answer.type === "solutionSet" && item.answer.members.includes("√3"),
    )!;
    const others = (solve.item.answer as { members: string[] }).members.filter((m) => !m.includes("√"));
    expect(grade("poly_solve_higher_degree", solve.seed, [...others, "±√3"].join(", "))).toBe(true);
    const complex = items("poly_solve_higher_degree").find(
      ({ item }) => item.answer.type === "solutionSet" && item.answer.members.includes("i√3"),
    )!;
    const rest = (complex.item.answer as { members: string[] }).members.filter((m) => !m.includes("√"));
    expect(grade("poly_solve_higher_degree", complex.seed, [...rest, "√3i", "-√3i"].join(", "))).toBe(true);
    expect(grade("poly_solve_higher_degree", complex.seed, [...rest, "±i√3"].join(", "))).toBe(true);
  });

  test("factored answers: other factor orders pass; a sign slip or a lost factor misses; the expanded form gets the nudge", () => {
    for (const key of ["poly_factor_grouping_cubes", "poly_factor_quadratic_form", "poly_factor_theorem"]) {
      for (const { seed, item } of items(key)) {
        const answer = formatAnswer(item.answer);
        const { constant, factors } = splitFactors(answer);
        const lead = constant === 1 ? "" : constant === -1 ? "-" : String(constant);
        const show = (f: { expr: string; power: number }) =>
          `${f.expr === "x" ? "x" : `(${f.expr})`}${f.power === 1 ? "" : `^${f.power}`}`;
        expect(grade(key, seed, lead + [...factors].reverse().map(show).join("")), answer).toBe(true);
        expect(grade(key, seed, lead + factors.map(show).join("*")), answer).toBe(true);
        const slip = answer.replace(/\(([^()]*?)([+-])(\d+)\)/, (_m, a: string, s: string, d: string) => `(${a}${s === "+" ? "-" : "+"}${d})`);
        expect(grade(key, seed, slip), `${answer} ← ${slip}`).toBe(false);
        if (factors.length > 1) {
          const lost = lead + factors.slice(0, -1).map(show).join("");
          expect(grade(key, seed, lost), `${answer} ← ${lost}`).toBe(false);
        }
        const spans = texSpans(item.stem);
        const expanded = polyOf(key === "poly_factor_theorem" ? spans[1] : spans[0]);
        const learner = parseAnswer(expanded, "expression")!;
        expect(answersEqual(learner, item.answer), expanded).toBe(true);
        expect(meetsRequiredForm(expanded, answer, "factored"), expanded).toBe(false);
      }
    }
  });

  test("a partly factored answer is not graded fully correct", () => {
    // `factored` means fully factored over the integers, so (x+1)(x^2-9) no
    // longer passes for (x+1)(x-3)(x+3): it is equal but unfinished, which the
    // drill answers with the form nudge. (Was "KNOWN GRADER GAP", which pinned
    // all three families as exposed.)
    const exposed = new Set<string>();
    let checked = 0;
    for (const key of ["poly_factor_grouping_cubes", "poly_factor_quadratic_form", "poly_factor_theorem"]) {
      for (const { seed, item } of items(key)) {
        const answer = formatAnswer(item.answer);
        const { constant, factors } = splitFactors(answer);
        if (factors.length < 3) continue;
        const [first, ...rest] = factors;
        const restExpr = rest.map((f) => `(${f.expr})^${f.power}`).join("*");
        const lead = constant === 1 ? "" : constant === -1 ? "-" : String(constant);
        const partial = `${lead}(${first.expr})^${first.power}(${polyString(interpolate((x) => evalReal(restExpr, { x }), 4))})`;
        expect(sameFunction(partial, answer), partial).toBe(true);
        checked += 1;
        if (grade(key, seed, partial)) exposed.add(key);
      }
    }
    expect(checked).toBeGreaterThan(0);
    expect([...exposed].sort()).toEqual([]);
  });

  test("expanded answers: reordered terms and explicit × pass; a slip misses; an unexpanded form gets the nudge", () => {
    for (const key of ["poly_long_division", "poly_synthetic_division", "poly_binomial_expansion"]) {
      for (const { seed, item } of items(key)) {
        const answer = formatAnswer(item.answer);
        if (item.answer.type === "integer") {
          // Remainder and single-coefficient draws are typed integer.
          const v = item.answer.value;
          expect(item.answerType, item.stem).toBe("integer");
          expect(grade(key, seed, `r = ${v}`), item.stem).toBe(true);
          expect(grade(key, seed, `${v}.0`), item.stem).toBe(true);
          expect(grade(key, seed, String(v + 1)), item.stem).toBe(false);
          expect(grade(key, seed, String(v === 0 ? 1 : -v)), item.stem).toBe(false);
          continue;
        }
        expect(grade(key, seed, reverseTerms(answer)), answer).toBe(true);
        expect(grade(key, seed, answer.replace(/(\d)([xy])/g, "$1*$2")), answer).toBe(true);
        expect(grade(key, seed, `${answer}+1`), answer).toBe(false);
        const signSlip = answer.replace(/([+-])(\d*[xy])/, (_m, s: string, t: string) => `${s === "+" ? "-" : "+"}${t}`);
        if (signSlip !== answer) expect(grade(key, seed, signSlip), `${answer} ← ${signSlip}`).toBe(false);
      }
    }
    // The unfinished forms a scholar might leave: the power itself, a nested product.
    const binomial = items("poly_binomial_expansion").find(({ item }) => item.stem.startsWith("Expand"))!;
    const power = texToGrammar(texSpans(binomial.item.stem)[0]);
    const answer = formatAnswer(binomial.item.answer);
    expect(answersEqual(parseAnswer(power, "expression")!, binomial.item.answer)).toBe(true);
    expect(meetsRequiredForm(power, answer, "expanded")).toBe(false);
    const division = items("poly_long_division").find(({ item }) => item.stem.endsWith("Write the quotient."))!;
    const q = formatAnswer(division.item.answer);
    const coefficients = interpolate((x) => evalReal(q, { x }), 3);
    const horner = `(${coefficients[0]}x${coefficients[1] < 0 ? "" : "+"}${coefficients[1]})x${coefficients[2] < 0 ? "" : "+"}${coefficients[2]}`;
    expect(answersEqual(parseAnswer(horner, "expression")!, division.item.answer)).toBe(true);
    expect(meetsRequiredForm(horner, q, "expanded")).toBe(false);
  });

  test("remainder theorem: an assignment or + sign passes; neighbouring values miss", () => {
    for (const { seed, item } of items("poly_remainder_theorem")) {
      const v = item.answer.type === "integer" ? item.answer.value : NaN;
      expect(grade("poly_remainder_theorem", seed, `k = ${v}`), item.stem).toBe(true);
      expect(grade("poly_remainder_theorem", seed, v >= 0 ? `+${v}` : `−${-v}`), item.stem).toBe(true);
      expect(grade("poly_remainder_theorem", seed, String(v + 1)), item.stem).toBe(false);
      expect(grade("poly_remainder_theorem", seed, String(v === 0 ? 2 : -v)), item.stem).toBe(false);
    }
  });

  test("end behavior and sketching are left for the graph lane", () => {
    // Recorded so a reader knows they are deliberately not in this file.
    expect(KEYS).not.toContain("poly_end_behavior");
    expect(KEYS).not.toContain("poly_sketch_factored");
  });
});
