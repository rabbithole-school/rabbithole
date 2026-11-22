import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
  type AnswerType,
  answersEqual,
  exprAns,
  formatAnswer,
  meetsRequiredForm,
  numericValue,
  parseAnswer,
} from "../lib/practice/answers";
import { RADICAL_DRAW } from "../lib/practice/algebra2/radicals";
import { untypableAnswer } from "./algebra2TestMath";
import { gradeTemplateItem, makeItemId } from "../lib/practice/session";
import { generateItem, type PracticeItem } from "../lib/practice/templates";
import { ALGEBRA_2_SKILLS } from "../seed/algebra2Graph";

const FAMILIES: Record<string, { type: AnswerType; palette?: string; form?: string }> = {
  rexp_convert: { type: "expression", palette: "algebra" },
  rexp_evaluate: { type: "fraction" },
  rexp_simplify: { type: "fraction" },
  rad_add_multiply: { type: "expression", palette: "algebra" },
  rad_rationalize: { type: "expression", palette: "algebra", form: "rationalizedDenominator" },
  rad_solve_equation: { type: "solutionSet", palette: "algebra" },
};
const KEYS = Object.keys(FAMILIES);
const SEEDS = Array.from({ length: 250 }, (_, i) => i + 1);

function item(skillKey: string, seed: number): PracticeItem {
  const generated = generateItem(skillKey, seed);
  if (!generated) throw new Error(`no template for ${skillKey}`);
  return generated;
}

function grades(skillKey: string, seed: number, raw: string): boolean {
  return gradeTemplateItem(makeItemId(skillKey, seed), raw)?.correct === true;
}

function valueEqual(it: PracticeItem, raw: string): boolean {
  const parsed = parseAnswer(raw, it.answerType);
  return parsed !== null && answersEqual(parsed, it.answer);
}

function expressionsEqual(a: string, b: string): boolean {
  return answersEqual(exprAns(a), exprAns(b));
}

function spans(stem: string): string[] {
  return [...stem.matchAll(/\\\((.*?)\\\)/g)].map((m) => m[1]);
}

/** The stem's LaTeX subset → the answer grammar (so the grader's evaluator,
 *  not the generator, re-derives each answer). */
function texToGrammar(latex: string): string {
  let s = latex.replace(/\\left|\\right/g, "").replace(/\\cdot/g, "*");
  for (let pass = 0; pass < 12; pass++) {
    const before = s;
    s = s
      .replace(/\\frac\{([^{}]*)\}\{([^{}]*)\}/g, "(($1)/($2))")
      .replace(/\\sqrt\[3\]\{([^{}]*)\}/g, "∛($1)")
      .replace(/\\sqrt\[(\d+)\]\{([^{}]*)\}/g, "√[$1]($2)")
      .replace(/\\sqrt\{([^{}]*)\}/g, "√($1)")
      .replace(/\^\{([^{}]*)\}/g, "^($1)");
    if (s === before) break;
  }
  return s.replace(/\s+/g, "");
}

/** A real-valued evaluator for one side of a radical equation in the stem's
 *  LaTeX: a linear polynomial, √(linear) or ∛(linear), optionally ± a number. */
function realSide(latex: string): (x: number) => number {
  const s = latex.replace(/\s+/g, "");
  const linear = (text: string) => {
    let a = 0;
    let b = 0;
    for (const m of text.matchAll(/([+-]?)(\d*)(x?)/g)) {
      if (m[0] === "" || m[0] === "+" || m[0] === "-") continue;
      const sign = m[1] === "-" ? -1 : 1;
      if (m[3]) a += sign * (m[2] === "" ? 1 : Number(m[2]));
      else b += sign * Number(m[2]);
    }
    return (x: number) => a * x + b;
  };
  const root = s.match(/^\\sqrt(\[3\])?\{([^}]*)\}(?:([+-])(\d+))?$/);
  if (!root) return linear(s);
  const inner = linear(root[2]);
  const shift = root[3] ? (root[3] === "-" ? -1 : 1) * Number(root[4]) : 0;
  return (x: number) => {
    const v = inner(x);
    if (root[1]) return Math.cbrt(v) + shift;
    return v < 0 ? NaN : Math.sqrt(v) + shift;
  };
}

function gcd(a: number, b: number): number {
  let x = Math.abs(a);
  let y = Math.abs(b);
  while (y) [x, y] = [y, x % y];
  return x;
}

function members(it: PracticeItem): string[] {
  return it.answer.type === "solutionSet" ? it.answer.members : [];
}

// Every suite runs twice: as served, and with every retry exhausted so each
// fallback is served and re-derived like any other draw.
describe.each([false, true])("algebra-2 radicals and rational exponents templates (every retry exhausted: %s)", (forced) => {
  beforeAll(() => {
    if (forced) RADICAL_DRAW.attempts = 0;
  });
  afterAll(() => {
    RADICAL_DRAW.attempts = 31;
  });

  test("rational-exponent rewrites of x say x is positive (the rules need it)", () => {
    for (const key of ["rexp_convert", "rexp_simplify"]) {
      for (const seed of SEEDS) {
        const it = generateItem(key, seed)!;
        if (/\\\([^)]*x/.test(it.stem)) expect(it.stem, `${key}#${seed}`).toContain("Assume x is positive.");
      }
    }
  });

  test("every typed answer can be entered on the pad it is served with", () => {
    for (const key of KEYS) {
      for (const seed of SEEDS) {
        const it = generateItem(key, seed)!;
        expect(untypableAnswer(it), `${key}#${seed} on ${it.answerPalette ?? it.answerType}: ${it.stem}`).toBeNull();
      }
    }
  });

  test("every strand node has exactly one template", () => {
    const strand = ALGEBRA_2_SKILLS.filter((s) => s.strand === "radicals-rational-exponents").map((s) => s.skillKey);
    expect([...KEYS].sort()).toEqual([...strand].sort());
    for (const key of KEYS) expect(generateItem(key, 1), key).not.toBeNull();
  });

  test("items are reproducible per seed and varied across seeds", () => {
    for (const key of KEYS) {
      const stems = new Set<string>();
      for (const seed of SEEDS) {
        expect(generateItem(key, seed)).toEqual(generateItem(key, seed));
        stems.add(item(key, seed).stem);
      }
      // A forced fallback is one fixed draw; variety belongs to normal draws.
      if (!forced) expect(stems.size, key).toBeGreaterThanOrEqual(12);
    }
  });

  test("answer type, palette and form are declared as designed", () => {
    for (const key of KEYS) {
      const spec = FAMILIES[key];
      for (const seed of SEEDS.slice(0, 40)) {
        const it = item(key, seed);
        expect(it.answerType, key).toBe(spec.type);
        expect(it.answerPalette, key).toBe(spec.palette);
        if (spec.form) expect(it.answerForm, key).toBe(spec.form);
      }
    }
    const convertForms = new Set(SEEDS.map((seed) => item("rexp_convert", seed).answerForm));
    expect([...convertForms].sort()).toEqual(["exponentForm", "radicalForm"]);
    const addForms = new Set(SEEDS.map((seed) => item("rad_add_multiply", seed).answerForm));
    expect([...addForms].sort()).toEqual(["expanded", "simplifiedRadical"]);
  });

  test("stems are clean, and every item carries 3–5 worked steps ending in the answer", () => {
    for (const key of KEYS) {
      for (const seed of SEEDS) {
        const it = item(key, seed);
        for (const bad of ["undefined", "NaN", "--", "+ -", "x^1", "x^{1}"]) {
          expect(it.stem.includes(bad), `${key} ${seed}: ${it.stem}`).toBe(false);
        }
        expect(/(^|[^\d.])1x/.test(it.stem), `${key} ${seed}: ${it.stem}`).toBe(false);
        const steps = it.workedSteps ?? [];
        expect(steps.length, `${key} ${seed}`).toBeGreaterThanOrEqual(3);
        expect(steps.length, `${key} ${seed}`).toBeLessThanOrEqual(5);
        for (const step of steps) expect(step.blankText ?? "", key).toMatch(/\?$/);
        const last = steps[steps.length - 1].text;
        if (it.answer.type === "solutionSet") {
          if (it.answer.members.length === 0) expect(last, key).toMatch(/No solution/);
          for (const member of it.answer.members) expect(last, key).toContain(member);
        } else {
          expect(last, `${key} ${seed}`).toContain(formatAnswer(it.answer));
        }
      }
    }
  });

  test("every canonical answer grades correct against its own item", () => {
    for (const key of KEYS) {
      for (const seed of SEEDS) {
        expect(grades(key, seed, formatAnswer(item(key, seed).answer)), `${key} ${seed}`).toBe(true);
      }
    }
  });

  test("rewrite families: the stem's expression equals the answer", () => {
    for (const key of ["rexp_convert", "rad_add_multiply", "rad_rationalize"]) {
      for (const seed of SEEDS) {
        const it = item(key, seed);
        const question = texToGrammar(spans(it.stem)[0]);
        expect(expressionsEqual(question, formatAnswer(it.answer)), `${key} ${seed}: ${question}`).toBe(true);
      }
    }
  });

  test("rexp_evaluate: the value re-computed in floating point", () => {
    for (const seed of SEEDS) {
      const it = item("rexp_evaluate", seed);
      const span = spans(it.stem)[0].replace(/\s+/g, "");
      const m = span.match(/^(?:\\left\()?(\(?-?[\d]+\)?|\\frac\{\d+\}\{\d+\})(?:\\right\))?\^\{(-?)(?:\\frac\{(\d+)\}\{(\d+)\}|(\d+))\}$/);
      expect(m, span).not.toBeNull();
      if (!m) continue;
      const baseText = m[1].replace(/[()]/g, "");
      const fraction = baseText.match(/\\frac\{(\d+)\}\{(\d+)\}/);
      const base = fraction ? Number(fraction[1]) / Number(fraction[2]) : Number(baseText);
      const p = Number(m[3] ?? m[5]);
      const q = Number(m[4] ?? 1);
      const sign = m[2] === "-" ? -1 : 1;
      // Real nth root (odd n allows a negative base), then the power.
      const root = base < 0 ? -Math.pow(-base, 1 / q) : Math.pow(base, 1 / q);
      const value = Math.pow(Math.pow(root, p), sign);
      expect(Math.abs(numericValue(it.answer) - value), `${span} → ${formatAnswer(it.answer)}`).toBeLessThan(1e-9);
    }
  });

  test("rexp_simplify: x^k equals the stem's expression at sample points", () => {
    for (const seed of SEEDS) {
      const it = item("rexp_simplify", seed);
      const question = texToGrammar(spans(it.stem)[0]);
      const k = formatAnswer(it.answer);
      // The stem says "Assume x is positive", so the identity is checked there:
      // for negative x an even-numerator inner power is |x|^…, a different function.
      for (const x of ["(1/2)", "(17/10)", "2", "(33/10)", "9"]) {
        const at = (expr: string) => expr.replace(/x/g, x);
        expect(expressionsEqual(at(question), at(`x^(${k})`)), `${question} vs x^(${k}) at x=${x}`).toBe(true);
      }
    }
  });

  test("rad_solve_equation: members are exactly the integer solutions that check, and extraneous roots occur", () => {
    let rejected = 0;
    let empty = 0;
    for (const seed of SEEDS) {
      const it = item("rad_solve_equation", seed);
      const [lhs, rhs] = spans(it.stem)[0].split("=");
      const left = realSide(lhs);
      const right = realSide(rhs);
      const truth: number[] = [];
      for (let x = -80; x <= 80; x++) {
        const l = left(x);
        const r = right(x);
        if (Number.isFinite(l) && Number.isFinite(r) && Math.abs(l - r) < 1e-9) truth.push(x);
      }
      expect(members(it).map(Number).sort((a, b) => a - b), it.stem).toEqual(truth);
      // A squaring step produced a candidate the check threw away.
      const steps = (it.workedSteps ?? []).map((s) => s.text).join(" ");
      if (/extraneous/.test(steps)) rejected += 1;
      if (truth.length === 0) empty += 1;
    }
    expect(rejected).toBeGreaterThan(SEEDS.length / 4);
    expect(empty).toBeGreaterThan(SEEDS.length / 10);
  });

  test("plausible wrong answers grade incorrect", () => {
    for (const seed of SEEDS.slice(0, 150)) {
      const convert = item("rexp_convert", seed);
      const answer = formatAnswer(convert.answer);
      // Index and power swapped: ∛(x^2) ↔ x^(3/2).
      const swapped = answer
        .replace(/\^\((-?)(\d+)\/(\d+)\)/, "^($1$3/$2)")
        .replace(/√\[(\d+)\]\(([a-z\d]+)\^(\d+)\)/, "√[$3]($2^$1)");
      if (swapped !== answer && !/\^\(-?(\d+)\/\1\)/.test(swapped)) {
        expect(grades("rexp_convert", seed, swapped), `${answer} vs ${swapped}`).toBe(false);
      }
      expect(grades("rexp_convert", seed, `2${answer}`), answer).toBe(false);

      const evaluate = item("rexp_evaluate", seed);
      const value = numericValue(evaluate.answer);
      expect(grades("rexp_evaluate", seed, String(-value))).toBe(false);
      if (Math.abs(value) !== 1) {
        const ev = formatAnswer(evaluate.answer);
        const reciprocal = ev.includes("/") ? ev.split("/").reverse().join("/") : `1/${ev}`;
        expect(grades("rexp_evaluate", seed, reciprocal.replace("1/-", "-1/")), `${ev} vs ${reciprocal}`).toBe(false);
      }

      const simplify = item("rexp_simplify", seed);
      const k = formatAnswer(simplify.answer);
      // A sign slip in a quotient, and a numerator off by one.
      expect(grades("rexp_simplify", seed, k.startsWith("-") ? k.slice(1) : `-${k}`), k).toBe(false);
      const [kn, kd = "1"] = k.split("/");
      expect(grades("rexp_simplify", seed, `${Number(kn) + 1}/${kd}`), k).toBe(false);

      for (const key of ["rad_add_multiply", "rad_rationalize"]) {
        const a = formatAnswer(item(key, seed).answer);
        expect(grades(key, seed, `-(${a})`), `${key} ${a}`).toBe(false);
        // Radicands added or multiplied wrongly: the answer with √ replaced by √ of double.
        expect(grades(key, seed, `(${a})*√2`), `${key} ${a}`).toBe(false);
      }

      const solve = item("rad_solve_equation", seed);
      const truth = members(solve);
      if (truth.length === 0) {
        // Keeping the extraneous candidate is the classic slip.
        const candidate = (solve.workedSteps ?? []).map((s) => s.text).join(" ").match(/x = (-?\d+)/);
        if (candidate) expect(grades("rad_solve_equation", seed, candidate[1])).toBe(false);
      } else {
        expect(grades("rad_solve_equation", seed, "No solution")).toBe(false);
        expect(grades("rad_solve_equation", seed, [...truth, "100"].join(", "))).toBe(false);
      }
    }
  });

  test("equivalent rewrites of the right answer grade correct", () => {
    for (const seed of SEEDS.slice(0, 150)) {
      const convert = item("rexp_convert", seed);
      const answer = formatAnswer(convert.answer);
      if (convert.answerForm === "exponentForm") {
        // Unreduced exponent, and the power-of-a-power reading.
        const doubled = answer.replace(/\^\((-?\d+)\/(\d+)\)/, (_, n, d) => `^(${2 * Number(n)}/${2 * Number(d)})`);
        expect(grades("rexp_convert", seed, doubled), doubled).toBe(true);
        expect(grades("rexp_convert", seed, ` ${answer} `), answer).toBe(true);
      } else {
        // ⁿ√(x^m) ↔ (ⁿ√x)^m, and ∛ ↔ √[3].
        const outside = answer.replace(/^(1\/)?(√\[\d+\]|√|∛)\(([a-z\d]+)\^(\d+)\)$/, "$1($2($3))^$4");
        expect(grades("rexp_convert", seed, outside), `${answer} vs ${outside}`).toBe(true);
        const bracketed = answer.replace(/∛/, "√[3]").replace(/^√([a-z])$/, "√($1)");
        expect(grades("rexp_convert", seed, bracketed), `${answer} vs ${bracketed}`).toBe(true);
      }

      for (const key of ["rexp_evaluate", "rexp_simplify"]) {
        const it = item(key, seed);
        const f = formatAnswer(it.answer);
        const [n, d = "1"] = f.split("/");
        expect(grades(key, seed, `${Number(n) * 3}/${Number(d) * 3}`), `${key} ${f}`).toBe(true);
        expect(grades(key, seed, `k = ${f}`), `${key} ${f}`).toBe(true);
      }

      const add = formatAnswer(item("rad_add_multiply", seed).answer);
      // √m written with explicit parentheses, and the terms in the other order.
      expect(grades("rad_add_multiply", seed, add.replace(/√(\d+)/g, "√($1)")), add).toBe(true);
      const turned = add.match(/^(-?\d+)([+-]\d*√\d+)$/);
      const reordered = turned ? `${turned[2].replace(/^\+/, "")}+${turned[1]}`.replace("+-", "-") : add.replace(/^(-?)(\d+)√(\d+)$/, "$1√$3*$2");
      expect(grades("rad_add_multiply", seed, reordered), `${add} vs ${reordered}`).toBe(true);

      const rat = formatAnswer(item("rad_rationalize", seed).answer);
      expect(grades("rad_rationalize", seed, `(${rat})`), rat).toBe(true);
      expect(grades("rad_rationalize", seed, rat.replace(/√(\d+)/g, "√($1)").replace(/∛(\d+)/g, "∛($1)")), rat).toBe(true);

      const truth = members(item("rad_solve_equation", seed));
      const written = truth.length === 0 ? "no solution" : truth.map((x) => `x = ${x}`).reverse().join(" or ");
      expect(grades("rad_solve_equation", seed, written), written).toBe(true);
      expect(grades("rad_solve_equation", seed, truth.length === 0 ? "none" : [...truth].reverse().join(";")), truth.join()).toBe(true);
    }
  });

  test("forms: the question typed back is equal in value but not in the asked form", () => {
    for (const seed of SEEDS) {
      for (const key of ["rexp_convert", "rad_add_multiply", "rad_rationalize"]) {
        const it = item(key, seed);
        const echo = texToGrammar(spans(it.stem)[0]);
        const expected = formatAnswer(it.answer);
        expect(valueEqual(it, echo), `${key} ${echo}`).toBe(true);
        expect(meetsRequiredForm(echo, expected, it.answerForm!, it.answerType), `${key} ${echo}`).toBe(false);
        expect(meetsRequiredForm(expected, expected, it.answerForm!, it.answerType), `${key} ${expected}`).toBe(true);
      }
      // Number-answer families: the typed-back question is not even a number.
      for (const key of ["rexp_evaluate", "rexp_simplify"]) {
        const echo = texToGrammar(spans(item(key, seed).stem)[0]);
        expect(grades(key, seed, echo), `${key} ${echo}`).toBe(false);
      }
    }
  });

  test("rad_rationalize answers are fully reduced", () => {
    for (const seed of SEEDS) {
      const answer = formatAnswer(item("rad_rationalize", seed).answer);
      if (!answer.includes("/")) continue;
      const [top, bottom] = answer.split("/");
      // Drop the radicals themselves; what is left are the coefficients
      // (none at all means a coefficient of 1).
      const radicalTerms = [...top.matchAll(/(\d*)[√∛]\d+/g)].map((m) => Number(m[1] || 1));
      const wholeTerms = [...top.replace(/\d*[√∛]\d+/g, "R").matchAll(/\d+/g)].map((m) => Number(m[0]));
      const content = [...radicalTerms, ...wholeTerms].reduce((g, n) => gcd(g, n), 0);
      expect(gcd(content, Number(bottom)), answer).toBe(1);
    }
  });
});
