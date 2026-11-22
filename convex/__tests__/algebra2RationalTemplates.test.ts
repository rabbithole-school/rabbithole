import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
  type AnswerForm,
  type AnswerType,
  answersEqual,
  exprAns,
  formatAnswer,
  meetsRequiredForm,
  parseAnswer,
} from "../lib/practice/answers";
import { RATIONAL_DRAW } from "../lib/practice/algebra2/rational";
import { gradeTemplateItem, makeItemId } from "../lib/practice/session";
import { generateItem, hasTemplate, type PracticeItem } from "../lib/practice/templates";
import { ALGEBRA_2_SKILLS } from "../seed/algebra2Graph";
import {
  BANNED_STEM_PIECES,
  type C,
  evalReal,
  evaluate,
  fracParts,
  interpolate,
  polyString,
  sameFunction,
  sameValueSet,
  splitTopFraction,
  texSpans,
  texToGrammar,
  untypableAnswer,
} from "./algebra2TestMath";

const FAMILIES: Record<string, { answerType: AnswerType; palette?: string; form?: AnswerForm }> = {
  rat_excluded_values: { answerType: "solutionSet", palette: "algebra" },
  rat_simplify: { answerType: "expression", palette: "algebra", form: "singleFraction" },
  rat_multiply_divide: { answerType: "expression", palette: "algebra", form: "singleFraction" },
  rat_add_subtract: { answerType: "expression", palette: "algebra", form: "singleFraction" },
  rat_solve_equation: { answerType: "solutionSet", palette: "algebra" },
  rat_inverse_variation: { answerType: "expression", palette: "algebra" },
};
const KEYS = Object.keys(FAMILIES);
const FRACTION_KEYS = ["rat_simplify", "rat_multiply_divide", "rat_add_subtract"];
const SEEDS = Array.from({ length: 240 }, (_, i) => i * 7919 + 13);

function items(key: string): { seed: number; item: PracticeItem }[] {
  return SEEDS.map((seed) => ({ seed, item: generateItem(key, seed)! }));
}
const grade = (key: string, seed: number, raw: string) =>
  gradeTemplateItem(makeItemId(key, seed), raw)?.correct;
const setOf = (raw: string): C[] => {
  const parsed = parseAnswer(raw, "solutionSet");
  return parsed?.type === "solutionSet" ? parsed.members.map((m) => evaluate(m)) : [];
};
const members = (item: PracticeItem): C[] =>
  item.answer.type === "solutionSet" ? item.answer.members.map((m) => evaluate(m)) : [];
const lastStep = (item: PracticeItem): string => {
  const steps = item.workedSteps ?? [];
  return steps[steps.length - 1]?.text ?? "";
};

/** The rational expression a simplify / multiply / divide / add item shows. */
function stemExpression(item: PracticeItem): string {
  const spans = texSpans(item.stem).map(texToGrammar);
  return item.stem.startsWith("Divide") ? `(${spans[0]})/(${spans[1]})` : spans[0];
}

/** The answer with its numerator and denominator multiplied out. */
function expandedFraction(answer: string): string {
  const parts = splitTopFraction(answer);
  const expand = (e: string) => polyString(interpolate((x) => evalReal(e, { x }), 4));
  if (!parts) return expand(answer);
  return `(${expand(parts[0])})/(${expand(parts[1])})`;
}

// Every suite runs twice: as served, and with every retry exhausted so each
// fallback is served and re-derived like any other draw.
describe.each([false, true])("algebra-2 rational templates (every retry exhausted: %s)", (forced) => {
  beforeAll(() => {
    if (forced) RATIONAL_DRAW.attempts = 0;
  });
  afterAll(() => {
    RATIONAL_DRAW.attempts = 200;
  });

  test("every typed answer can be entered on the pad it is served with", () => {
    for (const key of KEYS) {
      for (const seed of SEEDS) {
        const it = generateItem(key, seed)!;
        expect(untypableAnswer(it), `${key}#${seed} on ${it.answerPalette ?? it.answerType}: ${it.stem}`).toBeNull();
      }
    }
  });

  test("these are rational-strand nodes of the graph", () => {
    for (const key of KEYS) {
      expect(ALGEBRA_2_SKILLS.find((s) => s.skillKey === key)?.strand, key).toBe("rational");
    }
  });

  test("every family has a reproducible template with its declared type, palette and form", () => {
    for (const key of KEYS) {
      expect(hasTemplate(key), key).toBe(true);
      for (const seed of SEEDS.slice(0, 20)) {
        const item = generateItem(key, seed)!;
        expect(item, key).toEqual(generateItem(key, seed));
        expect(item.answerType, key).toBe(FAMILIES[key].answerType);
        expect(item.answerPalette, key).toBe(FAMILIES[key].palette);
        expect(item.answerForm, key).toBe(FAMILIES[key].form);
      }
    }
  });

  test("every family varies (at least 12 distinct items)", () => {
    for (const key of KEYS) {
      // A forced fallback is one fixed draw; variety belongs to normal draws.
      if (!forced) expect(new Set(items(key).map(({ item }) => item.stem)).size, key).toBeGreaterThanOrEqual(12);
    }
  });

  test("stems are clean and typeset, and every item has 2–5 worked steps ending in the answer", () => {
    for (const key of KEYS) {
      for (const { item } of items(key)) {
        for (const bad of BANNED_STEM_PIECES) expect(item.stem, `${key}: ${item.stem}`).not.toMatch(bad);
        // Word problems with only bare numbers need no typeset span.
        const wordProblem = key === "rat_inverse_variation" && !item.stem.startsWith("\\(");
        if (!wordProblem) expect(texSpans(item.stem).length, item.stem).toBeGreaterThan(0);
        const steps = item.workedSteps ?? [];
        expect(steps.length, item.stem).toBeGreaterThanOrEqual(2);
        expect(steps.length, item.stem).toBeLessThanOrEqual(5);
        for (const step of steps) {
          expect(step.blankText, item.stem).toMatch(/\?$/);
          for (const bad of [/undefined/, /NaN/, /\+ -/, /--/, /(^|[^\d])1x/]) expect(step.text, step.text).not.toMatch(bad);
        }
        expect(steps[steps.length - 1].text, item.stem).toContain(formatAnswer(item.answer));
      }
    }
  });

  test("every canonical answer grades correct and meets its own form", () => {
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

  // ── Re-derivations ───────────────────────────────────────────────────────

  test("excluded values: exactly the real zeros of the denominator as shown", () => {
    let none = 0;
    let cancellingTrap = 0;
    for (const { item } of items("rat_excluded_values")) {
      const [numTex, denTex] = fracParts(texSpans(item.stem)[0]);
      const den = texToGrammar(denTex);
      const found: C[] = [];
      for (let d = 1; d <= 3; d++)
        for (let k = -40; k <= 40; k++) if (Math.abs(evalReal(den, { x: k / d })) < 1e-9) found.push({ re: k / d, im: 0 });
      expect(sameValueSet(found, members(item), 1e-9), item.stem).toBe(true);
      if (found.length === 0) {
        none++;
        for (let x = -50; x <= 50; x += 0.25) expect(evalReal(den, { x }), item.stem).toBeGreaterThan(0);
      }
      // The numerator shares a zero with the denominator: simplifying first would lose it.
      if (found.some((z) => Math.abs(evalReal(texToGrammar(numTex), { x: z.re })) < 1e-9)) cancellingTrap++;
    }
    expect(none).toBeGreaterThan(10);
    expect(cancellingTrap).toBeGreaterThan(10);
  });

  test("simplify, multiply/divide, add/subtract: the answer equals the expression shown", () => {
    for (const key of FRACTION_KEYS) {
      for (const { item } of items(key)) {
        expect(sameFunction(formatAnswer(item.answer), stemExpression(item)), item.stem).toBe(true);
      }
    }
  });

  test("solve: the set is exactly the integers that satisfy the equation; extraneous roots and no-solution draws are common", () => {
    let empty = 0;
    let rejected = 0;
    for (const { item } of items("rat_solve_equation")) {
      const [lhs, rhs] = texSpans(item.stem)[0].split("=").map(texToGrammar);
      const found: C[] = [];
      for (let x = -40; x <= 40; x++) {
        const a = evalReal(lhs, { x });
        const b = evalReal(rhs, { x });
        if (Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) < 1e-9) found.push({ re: x, im: 0 });
      }
      expect(sameValueSet(found, members(item), 1e-9), item.stem).toBe(true);
      // Clearing denominators also yields these; at least one is thrown out.
      if (found.length === 0) empty++;
      const last = lastStep(item);
      if (/excluded, so/.test(last) && !/Neither|not excluded/.test(last)) rejected++;
    }
    expect(empty / SEEDS.length).toBeGreaterThan(0.12);
    expect(rejected / SEEDS.length).toBeGreaterThan(0.35);
  });

  test("solve: a rejected value really makes a denominator zero", () => {
    for (const { item } of items("rat_solve_equation")) {
      const last = lastStep(item);
      const match = /x = (-?\d+) is excluded/.exec(last);
      if (!match) continue;
      const lhs = texToGrammar(texSpans(item.stem)[0].split("=")[0]);
      expect(Number.isFinite(evalReal(lhs, { x: Number(match[1]) })), item.stem).toBe(false);
    }
  });

  test("inverse variation: x·y is constant across the two situations", () => {
    for (const { item } of items("rat_inverse_variation")) {
      const answer = evalReal(formatAnswer(item.answer));
      const plain = item.stem.replace(/\\\(|\\\)/g, "");
      const numbers = [...plain.matchAll(/-?\d+/g)].map((m) => Number(m[0]));
      if (plain.startsWith("y varies")) {
        const [y1, x1, x2] = numbers;
        if (plain.includes("constant of variation")) expect(answer, item.stem).toBe(x1 * y1);
        else expect(answer * x2, item.stem).toBeCloseTo(x1 * y1, 9);
      } else if (plain.startsWith("Painting")) {
        const [x1, y1, x2] = numbers;
        expect(answer * x2, item.stem).toBeCloseTo(x1 * y1, 9);
      } else if (plain.startsWith("A trip")) {
        const [y1, x1, x2] = numbers;
        expect(answer * x2, item.stem).toBeCloseTo(x1 * y1, 9);
      } else {
        const [x1, y1, x2] = numbers;
        expect(answer * x2, item.stem).toBeCloseTo(x1 * y1, 9);
      }
    }
  });

  // ── Grading ──────────────────────────────────────────────────────────────

  test("solution sets: reordered and 'x = … or …' pass; dropped, added or sign-flipped members miss", () => {
    for (const key of ["rat_excluded_values", "rat_solve_equation"]) {
      for (const { seed, item } of items(key)) {
        if (item.answer.type !== "solutionSet") throw new Error("type");
        const list = item.answer.members;
        if (list.length === 0) {
          expect(grade(key, seed, "none"), item.stem).toBe(true);
          expect(grade(key, seed, "No solution"), item.stem).toBe(true);
          expect(grade(key, seed, "0"), item.stem).toBe(false);
          expect(grade(key, seed, "2, -2"), item.stem).toBe(false);
          continue;
        }
        expect(grade(key, seed, [...list].reverse().join(", ")), item.stem).toBe(true);
        expect(grade(key, seed, list.map((m) => `x = ${m}`).join(" or ")), item.stem).toBe(true);
        const wrongs = [
          list.length > 1 ? list.slice(0, -1).join(", ") : "none",
          [...list, "7/5"].join(", "),
          list.map((m) => `-(${m})`).join(", "),
        ].filter((w) => !sameValueSet(setOf(w), members(item), 1e-9));
        expect(wrongs.length, item.stem).toBeGreaterThanOrEqual(2);
        for (const w of wrongs) expect(grade(key, seed, w), `${item.stem} ← ${w}`).toBe(false);
      }
    }
  });

  test("solve: keeping the extraneous root is graded wrong", () => {
    let checked = 0;
    for (const { seed, item } of items("rat_solve_equation")) {
      const match = /x = (-?\d+) is excluded/.exec(lastStep(item));
      if (!match || item.answer.type !== "solutionSet") continue;
      checked++;
      expect(grade("rat_solve_equation", seed, [...item.answer.members, match[1]].join(", ")), item.stem).toBe(false);
    }
    expect(checked).toBeGreaterThan(30);
  });

  test("single fractions: rewritten binomials and multiplied-out parts pass; reciprocals and sign slips miss", () => {
    for (const key of FRACTION_KEYS) {
      for (const { seed, item } of items(key)) {
        const answer = formatAnswer(item.answer);
        const swapped = answer.replace(/\(x([+-])(\d+)\)/g, (_m, s: string, d: string) => `(${s === "-" ? "-" : ""}${d}+x)`);
        const equivalents = [swapped === answer ? `(${answer})` : swapped, expandedFraction(answer)];
        for (const e of equivalents) expect(grade(key, seed, e), `${answer} ≡ ${e}`).toBe(true);
        const wrongs = [`1/(${answer})`, `-(${answer})`, `(${answer})+1`].filter(
          (w) => !sameFunction(w, answer),
        );
        expect(wrongs.length, answer).toBeGreaterThanOrEqual(2);
        for (const w of wrongs) expect(grade(key, seed, w), `${answer} ← ${w}`).toBe(false);
      }
    }
  });

  test("unsimplified but equal answers get the form nudge, never a miss", () => {
    for (const key of FRACTION_KEYS) {
      for (const { item } of items(key)) {
        const shown = stemExpression(item);
        const answer = formatAnswer(item.answer);
        expect(answersEqual(parseAnswer(shown, "expression")!, item.answer), `${key}: ${shown}`).toBe(true);
        expect(meetsRequiredForm(shown, answer, "singleFraction"), `${key}: ${shown}`).toBe(false);
      }
    }
  });

  test("cancelling terms instead of factors is graded wrong", () => {
    // Eedi's classic: (x+3)/(x+5) "simplified" to 3/5 by striking the x's.
    expect(answersEqual(exprAns("(x+3)/(x+5)"), exprAns("3/5"))).toBe(false);
    let checked = 0;
    for (const { seed, item } of items("rat_simplify")) {
      const [numTex, denTex] = fracParts(texSpans(item.stem)[0]);
      const num = interpolate((x) => evalReal(texToGrammar(numTex), { x }), 4);
      const den = interpolate((x) => evalReal(texToGrammar(denTex), { x }), 4);
      // Strike a shared x² term from top and bottom.
      if (num.length !== 3 || den.length !== 3 || num[0] !== 1 || den[0] !== 1) continue;
      const struck = `(${polyString(num.slice(1))})/(${polyString(den.slice(1))})`;
      checked++;
      expect(grade("rat_simplify", seed, struck), `${item.stem} ← ${struck}`).toBe(false);
    }
    expect(checked).toBeGreaterThan(30);
  });

  test("adding tops and bottoms is graded wrong", () => {
    let checked = 0;
    for (const { seed, item } of items("rat_add_subtract")) {
      if (!item.stem.startsWith("Add")) continue;
      const span = texSpans(item.stem)[0];
      const [n1, d1] = fracParts(span);
      const [n2, d2] = fracParts(span.slice(span.indexOf("+") + 1));
      const naive = `(${texToGrammar(n1)}+${texToGrammar(n2)})/(${texToGrammar(d1)}+${texToGrammar(d2)})`;
      checked++;
      expect(grade("rat_add_subtract", seed, naive), `${item.stem} ← ${naive}`).toBe(false);
    }
    expect(checked).toBeGreaterThan(30);
  });

  test("inverse variation: fraction or decimal spellings pass; a neighbour or a sign flip misses", () => {
    for (const { seed, item } of items("rat_inverse_variation")) {
      const answer = formatAnswer(item.answer);
      const value = evalReal(answer);
      expect(grade("rat_inverse_variation", seed, `y = ${answer}`), item.stem).toBe(true);
      const decimal = String(value);
      if (decimal.length < 8) expect(grade("rat_inverse_variation", seed, decimal), `${answer} ≡ ${decimal}`).toBe(true);
      else expect(grade("rat_inverse_variation", seed, `${value * 6}/6`), item.stem).toBe(true);
      expect(grade("rat_inverse_variation", seed, String(value + 1)), item.stem).toBe(false);
      expect(grade("rat_inverse_variation", seed, String(-value)), item.stem).toBe(false);
    }
  });

  test("asymptotes are left for the graph lane", () => {
    expect(KEYS).not.toContain("rat_graph_asymptotes");
  });
});
