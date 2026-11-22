import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
  type AnswerType,
  answersEqual,
  exprAns,
  formatAnswer,
  meetsRequiredForm,
  parseAnswer,
} from "../lib/practice/answers";
import { CX_DRAW } from "../lib/practice/algebra2/complexQuadratics";
import { untypableAnswer } from "./algebra2TestMath";
import { gradeTemplateItem, makeItemId } from "../lib/practice/session";
import { generateItem, type PracticeItem } from "../lib/practice/templates";
import { ALGEBRA_2_SKILLS } from "../seed/algebra2Graph";

/** The complex-quadratics nodes this strand templates, with their declared
 *  algebra-pad palette and (family-level) answer form. */
const FAMILIES: Record<string, { type: AnswerType; palette: string; form?: string }> = {
  cx_imaginary_unit: { type: "expression", palette: "complex" },
  cx_add_subtract: { type: "expression", palette: "complex", form: "complexStandard" },
  cx_multiply: { type: "expression", palette: "complex", form: "complexStandard" },
  cx_divide: { type: "expression", palette: "complex", form: "complexStandard" },
  quad_complex_roots: { type: "solutionSet", palette: "complex", form: "complexStandard" },
  quad_from_roots: { type: "expression", palette: "algebra", form: "expanded" },
  sys_linear_quadratic: { type: "solutionSet", palette: "algebra" },
};
const KEYS = Object.keys(FAMILIES);

/** Need a function-curve or complex-plane visual another lane is building. */
const LEFT_FOR_VISUALS = ["cx_plane_plot", "quad_inequality"];

const SEEDS = Array.from({ length: 250 }, (_, i) => i + 1);

function item(skillKey: string, seed: number): PracticeItem {
  const generated = generateItem(skillKey, seed);
  if (!generated) throw new Error(`no template for ${skillKey}`);
  return generated;
}

/** Full grade (value, then form) through the template oracle. */
function grades(skillKey: string, seed: number, raw: string): boolean {
  return gradeTemplateItem(makeItemId(skillKey, seed), raw)?.correct === true;
}

/** Value-only equality of a raw answer against an item's answer. */
function valueEqual(it: PracticeItem, raw: string): boolean {
  const parsed = parseAnswer(raw, it.answerType);
  return parsed !== null && answersEqual(parsed, it.answer);
}

function expressionsEqual(a: string, b: string): boolean {
  return answersEqual(exprAns(a), exprAns(b));
}

/** The `\( … \)` spans of a stem, in order. */
function spans(stem: string): string[] {
  return [...stem.matchAll(/\\\((.*?)\\\)/g)].map((m) => m[1]);
}

/** Translate the stem's LaTeX subset into the answer grammar, so the grader's
 *  own evaluator can check a stem against an answer independently of the
 *  generator's arithmetic. */
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

/** Coefficients [a, b, c] of a quadratic (or [0, m, k] of a line) rendered by
 *  polyTex, read back from the LaTeX. */
function readPoly(latex: string): [number, number, number] {
  const out: [number, number, number] = [0, 0, 0];
  const s = latex.replace(/\s+/g, "");
  for (const m of s.matchAll(/([+-]?)(\d*)(x(?:\^\{(\d+)\})?)?/g)) {
    if (m[0] === "" || m[0] === "+" || m[0] === "-") continue;
    const sign = m[1] === "-" ? -1 : 1;
    const power = m[3] ? (m[4] ? Number(m[4]) : 1) : 0;
    const coefficient = m[2] === "" ? 1 : Number(m[2]);
    out[2 - power] += sign * coefficient;
  }
  return out;
}

/** Answer-grammar coefficients of a canonical expanded quadratic `ax^2+bx+c`. */
function readAnswerPoly(answer: string): [number, number, number] {
  return readPoly(answer.replace(/x\^2/g, "x^{2}"));
}

function gcd(a: number, b: number): number {
  let x = Math.abs(a);
  let y = Math.abs(b);
  while (y) [x, y] = [y, x % y];
  return x;
}

/** quad_complex_roots runs backwards in some draws: write the quadratic whose
 *  solutions are a complex-conjugate pair (an expanded polynomial). */
function isBackwards(it: PracticeItem): boolean {
  return it.skillKey === "quad_complex_roots" && it.answerType === "expression";
}

/** Every "write p(x) from its solutions" item: all of quad_from_roots, plus the
 *  backwards draws of quad_complex_roots, as [skillKey, seed] pairs. */
function fromRootsCases(seeds: number[]): Array<[string, number]> {
  return seeds.flatMap((seed): Array<[string, number]> => {
    const cases: Array<[string, number]> = [["quad_from_roots", seed]];
    if (isBackwards(item("quad_complex_roots", seed))) cases.push(["quad_complex_roots", seed]);
    return cases;
  });
}

/** Members of a solution-set answer. */
function members(it: PracticeItem): string[] {
  return it.answer.type === "solutionSet" ? it.answer.members : [];
}

// Every suite runs twice: as served, and with every retry exhausted so each
// fallback is served and re-derived like any other draw.
describe.each([false, true])("algebra-2 complex-quadratics templates (every retry exhausted: %s)", (forced) => {
  beforeAll(() => {
    if (forced) CX_DRAW.attempts = 0;
  });
  afterAll(() => {
    CX_DRAW.attempts = 20;
  });

  test("every typed answer can be entered on the pad it is served with", () => {
    for (const key of KEYS) {
      for (const seed of SEEDS) {
        const it = generateItem(key, seed)!;
        expect(untypableAnswer(it), `${key}#${seed} on ${it.answerPalette ?? it.answerType}: ${it.stem}`).toBeNull();
      }
    }
  });

  test("every strand node has a template (the two visual ones live in graphNodes.ts)", () => {
    const strand = ALGEBRA_2_SKILLS.filter((s) => s.strand === "complex-quadratics").map((s) => s.skillKey);
    expect([...KEYS, ...LEFT_FOR_VISUALS].sort()).toEqual([...strand].sort());
    for (const key of KEYS) expect(generateItem(key, 1), key).not.toBeNull();
    for (const key of LEFT_FOR_VISUALS) expect(generateItem(key, 1), key).not.toBeNull();
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
        expect(it.answerPalette, key).toBe(spec.palette);
        if (isBackwards(it)) {
          expect(it.answerForm, key).toBe("expanded");
          continue;
        }
        expect(it.answerType, key).toBe(spec.type);
        if (spec.form) expect(it.answerForm, key).toBe(spec.form);
      }
    }
    // cx_imaginary_unit picks its form per draw: radicals vs powers of i.
    const forms = new Set(SEEDS.map((seed) => item("cx_imaginary_unit", seed).answerForm));
    expect([...forms].sort()).toEqual(["complexStandard", "simplifiedRadical"]);
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

  test("each stem's value equals its answer (re-derived through the grader's evaluator)", () => {
    for (const key of ["cx_imaginary_unit", "cx_add_subtract", "cx_multiply", "cx_divide"]) {
      for (const seed of SEEDS) {
        const it = item(key, seed);
        const question = texToGrammar(spans(it.stem)[0]);
        expect(expressionsEqual(question, formatAnswer(it.answer)), `${key} ${seed}: ${question}`).toBe(true);
      }
    }
  });

  test("quad_complex_roots: two non-real conjugate solutions that satisfy the equation", () => {
    for (const seed of SEEDS) {
      const it = item("quad_complex_roots", seed);
      if (isBackwards(it)) continue;
      const [lhs, rhs] = texToGrammar(spans(it.stem)[0]).split("=");
      expect(rhs).toBe("0");
      const roots = members(it);
      expect(roots, it.stem).toHaveLength(2);
      for (const root of roots) {
        expect(root, it.stem).toMatch(/i/);
        expect(expressionsEqual(lhs.replace(/x/g, `(${root})`), "0"), `${it.stem} at ${root}`).toBe(true);
      }
      // Two distinct non-real roots of a real quadratic are a conjugate pair.
      expect(expressionsEqual(roots[0], roots[1]), it.stem).toBe(false);
    }
  });

  test("quad_from_roots: the stem's solutions are zeros of the answer, with the stated leading coefficient", () => {
    let fractional = 0;
    let radical = 0;
    let complex = 0;
    for (const [key, seed] of fromRootsCases(SEEDS)) {
      const it = item(key, seed);
      const answer = formatAnswer(it.answer);
      const [a, b, c] = readAnswerPoly(answer);
      expect(a, answer).not.toBe(0);
      const roots = spans(it.stem)
        .slice(1)
        .filter((s) => !/p/.test(s))
        .map(texToGrammar);
      const valueSpans = roots.filter((s) => s !== "");
      // The last numeric span may be the leading coefficient.
      const leadMatch = it.stem.match(/leading coefficient \\\((-?\d+)\\\)/);
      const solutions = leadMatch ? valueSpans.slice(0, -1) : valueSpans;
      for (const root of solutions) {
        expect(expressionsEqual(answer.replace(/x/g, `(${root})`), "0"), `${it.stem} → ${answer} at ${root}`).toBe(true);
      }
      if (leadMatch) expect(a).toBe(Number(leadMatch[1]));
      else if (/leading coefficient 1/.test(it.stem)) expect(a).toBe(1);
      else {
        fractional += 1;
        expect(a).toBeGreaterThan(0);
        expect(gcd(gcd(a, b), c)).toBe(1);
      }
      const stated = solutions.join("");
      // quad_from_roots needs only factoring, so it never states a complex root;
      // the complex-conjugate pairs come from quad_complex_roots, after i.
      if (key === "quad_from_roots") expect(stated, it.stem).not.toMatch(/i/);
      else expect(stated, it.stem).toMatch(/i/);
      if (/√/.test(stated)) radical += 1;
      if (/i/.test(stated)) complex += 1;
    }
    expect(fractional).toBeGreaterThan(10);
    expect(radical).toBeGreaterThan(30);
    expect(complex).toBeGreaterThan(20);
  });

  test("sys_linear_quadratic: members are exactly the meeting coordinates, with 0, 1 and 2 meetings all occurring", () => {
    const counts = [0, 0, 0];
    for (const seed of SEEDS) {
      const it = item("sys_linear_quadratic", seed);
      const [lineSpan, parabolaSpan] = spans(it.stem);
      const [, m, k] = readPoly(lineSpan.replace(/^y=/, "").replace(/^y\s*=\s*/, ""));
      const [a, b, c] = readPoly(parabolaSpan.replace(/^y\s*=\s*/, ""));
      // a x² + (b − m) x + (c − k) = 0, solved numerically.
      const B = b - m;
      const C = c - k;
      const disc = B * B - 4 * a * C;
      const xs = disc < 0 ? [] : disc === 0 ? [-B / (2 * a)] : [(-B - Math.sqrt(disc)) / (2 * a), (-B + Math.sqrt(disc)) / (2 * a)];
      counts[xs.length] += 1;
      const askY = /y-value/.test(it.stem);
      const expected = (askY ? xs.map((x) => m * x + k) : xs).sort((p, q) => p - q);
      const got = members(it).map(Number).sort((p, q) => p - q);
      expect(got.length, it.stem).toBe(new Set(expected.map((v) => Math.round(v * 1e9))).size);
      for (const value of got) expect(expected.some((e) => Math.abs(e - value) < 1e-9), it.stem).toBe(true);
    }
    expect(counts[0]).toBeGreaterThan(20);
    expect(counts[1]).toBeGreaterThan(20);
    expect(counts[2]).toBeGreaterThan(80);
  });

  test("plausible wrong answers grade incorrect", () => {
    for (const seed of SEEDS.slice(0, 120)) {
      for (const key of ["cx_imaginary_unit", "cx_add_subtract", "cx_multiply", "cx_divide"]) {
        const answer = formatAnswer(item(key, seed).answer);
        // A sign slip, and a stray factor of i (e.g. √−4·√−9 answered as 6,
        // or i² left as +1).
        expect(grades(key, seed, `-(${answer})`), `${key} ${seed}`).toBe(false);
        expect(grades(key, seed, `(${answer})i`), `${key} ${seed}`).toBe(false);
      }
      const roots = item("quad_complex_roots", seed);
      if (!isBackwards(roots)) {
        const [first] = members(roots);
        expect(grades("quad_complex_roots", seed, first), "one member only").toBe(false);
        expect(grades("quad_complex_roots", seed, "none"), "no solution").toBe(false);
      }

      for (const [key] of fromRootsCases([seed])) {
        const poly = formatAnswer(item(key, seed).answer);
        // Roots taken with the wrong sign: p(−x) unless p is even.
        const [, b] = readAnswerPoly(poly);
        if (b !== 0) expect(grades(key, seed, poly.replace(/x/g, "(-x)")), poly).toBe(false);
        expect(grades(key, seed, `${poly}+1`), poly).toBe(false);
      }

      const sys = item("sys_linear_quadratic", seed);
      const xs = members(sys);
      if (xs.length === 0) {
        expect(grades("sys_linear_quadratic", seed, "0")).toBe(false);
      } else {
        expect(grades("sys_linear_quadratic", seed, "none")).toBe(false);
        const shifted = xs.map((x) => `${Number(x) + 1}`).join(",");
        expect(grades("sys_linear_quadratic", seed, shifted)).toBe(false);
      }
    }
  });

  test("equivalent rewrites of the right answer grade correct", () => {
    const swap = (answer: string) => {
      const m = answer.match(/^(-?[^+-]+)([+-].+)$/);
      return m ? `${m[2].startsWith("+") ? m[2].slice(1) : m[2]}+${m[1]}`.replace("+-", "-") : answer;
    };
    for (const seed of SEEDS.slice(0, 120)) {
      for (const key of ["cx_add_subtract", "cx_multiply", "cx_divide"]) {
        const answer = formatAnswer(item(key, seed).answer);
        expect(grades(key, seed, swap(answer)), `${key} ${seed} ${swap(answer)}`).toBe(true);
        expect(grades(key, seed, ` x = ${answer.replace(/-/g, "−")} `), `${key} ${seed}`).toBe(true);
      }
      const unit = item("cx_imaginary_unit", seed);
      const unitAnswer = formatAnswer(unit.answer);
      expect(grades("cx_imaginary_unit", seed, unitAnswer.replace(/^(-?)(\d*)i(√\d+)?$/, "$1$2$3i")), unitAnswer).toBe(true);
      expect(grades("cx_imaginary_unit", seed, ` ${unitAnswer.replace(/-/g, "−")} `), unitAnswer).toBe(true);

      if (!isBackwards(item("quad_complex_roots", seed))) {
        const roots = members(item("quad_complex_roots", seed));
        expect(grades("quad_complex_roots", seed, [...roots].reverse().join(", ")), roots.join()).toBe(true);
        expect(grades("quad_complex_roots", seed, `x = ${roots[0]} or x = ${roots[1]}`), roots.join()).toBe(true);
      }

      for (const [key] of fromRootsCases([seed])) {
        const poly = formatAnswer(item(key, seed).answer);
        const reversed = poly
          .replace(/-/g, "+-")
          .split("+")
          .filter(Boolean)
          .reverse()
          .join("+")
          .replace(/\+-/g, "-");
        expect(grades(key, seed, reversed), `${poly} vs ${reversed}`).toBe(true);
        expect(grades(key, seed, poly.replace(/x\^2/, "x·x")), poly).toBe(true);
      }

      const xs = members(item("sys_linear_quadratic", seed));
      const reorder = xs.length === 0 ? "No solution" : [...xs].reverse().join(" or ");
      expect(grades("sys_linear_quadratic", seed, reorder), reorder).toBe(true);
      const assigned = xs.length === 0 ? "none" : xs.map((x) => `x = ${x}`).join("; ");
      expect(grades("sys_linear_quadratic", seed, assigned), assigned).toBe(true);
    }
  });

  test("an equal answer not yet in the asked form is a nudge, not a miss", () => {
    for (const seed of SEEDS.slice(0, 120)) {
      // Typing the question back (√−12, i^27, (3−2i)(1+i), …) is equal in
      // value but not in the asked form.
      for (const key of ["cx_imaginary_unit", "cx_add_subtract", "cx_multiply", "cx_divide"]) {
        const it = item(key, seed);
        const echo = texToGrammar(spans(it.stem)[0]);
        const expected = formatAnswer(it.answer);
        expect(valueEqual(it, echo), `${key} ${echo}`).toBe(true);
        expect(meetsRequiredForm(echo, expected, it.answerForm!, it.answerType), `${key} ${echo}`).toBe(false);
        expect(meetsRequiredForm(expected, expected, it.answerForm!, it.answerType), `${key} ${expected}`).toBe(true);
      }
      const roots = item("quad_complex_roots", seed);
      if (!isBackwards(roots)) {
        // Left with √(−1) where i belongs, as the formula first produces it.
        const unfinished = members(roots)
          .map((root) => root.replace(/i/g, "√(-1)"))
          .join(", ");
        expect(valueEqual(roots, unfinished)).toBe(true);
        expect(meetsRequiredForm(unfinished, formatAnswer(roots.answer), "complexStandard", "solutionSet")).toBe(false);
      }

      for (const [key] of fromRootsCases([seed])) {
        const fromRoots = item(key, seed);
        const poly = formatAnswer(fromRoots.answer);
        const [a, b, c] = readAnswerPoly(poly);
        // a(x − r)(x − s) with r, s from the quadratic formula, as a factored product.
        const disc = `(${b * b - 4 * a * c})`;
        const factored = `${a}(x-(${-b}+√${disc})/(${2 * a}))(x-(${-b}-√${disc})/(${2 * a}))`;
        expect(valueEqual(fromRoots, factored), factored).toBe(true);
        expect(meetsRequiredForm(factored, poly, "expanded", "expression"), factored).toBe(false);
      }
    }
  });
});
