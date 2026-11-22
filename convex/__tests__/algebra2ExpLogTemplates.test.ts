/**
 * Algebra 2, exponential-logarithmic strand: the deterministic templates in
 * convex/lib/practice/algebra2/expLog.ts.
 *
 * The math checks never reuse the generator's arithmetic. Each stem's typeset
 * equation is translated to plain JavaScript (Math.log gives NaN outside a
 * logarithm's domain, which is exactly the domain check), and the claimed
 * answer is substituted back in.
 */
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
  formatAnswer,
  meetsRequiredForm,
  rawAnswersEqual,
  type AnswerType,
} from "../lib/practice/answers";
import { gradeTemplateItem, makeItemId } from "../lib/practice/session";
import { generateItem, hasTemplate, type PracticeItem } from "../lib/practice/templates";
import { ALGEBRA_2_SKILLS } from "../seed/algebra2Graph";
import { EXP_LOG_DRAW } from "../lib/practice/algebra2/expLog";

const KEYS = [
  "exp_solve_common_base",
  "log_definition",
  "log_evaluate",
  "log_rules_expand",
  "log_rules_condense",
  "log_change_of_base",
  "exp_solve_with_logs",
  "log_solve_equation",
  "exp_natural_base",
  "exp_model_doubling_halflife",
] as const;
type Key = (typeof KEYS)[number];

/** Left untemplated on purpose: it needs a function-curve visual. */
const UNTEMPLATED = ["log_graph_inverse"];

/** The answer types a family's draws may use (a draw names its own when its
 *  natural answer is a plain number), its algebra-pad palette, and its form. */
const SHAPE: Record<Key, { types: AnswerType[]; palette: string; form?: string }> = {
  exp_solve_common_base: { types: ["integer", "fraction", "solutionSet"], palette: "algebra" },
  log_definition: { types: ["expression", "integer", "fraction"], palette: "logs" },
  log_evaluate: { types: ["integer", "fraction"], palette: "algebra" },
  log_rules_expand: { types: ["expression"], palette: "logs", form: "expandedLog" },
  log_rules_condense: { types: ["expression"], palette: "logs", form: "singleLog" },
  log_change_of_base: { types: ["integer", "fraction"], palette: "logs" },
  exp_solve_with_logs: { types: ["expression"], palette: "logs" },
  log_solve_equation: { types: ["solutionSet"], palette: "logs" },
  exp_natural_base: { types: ["expression"], palette: "logs" },
  exp_model_doubling_halflife: { types: ["integer", "expression"], palette: "logs" },
};

const MANY = Array.from({ length: 240 }, (_, i) => i + 1);

function itemFor(key: string, seed: number): PracticeItem {
  const item = generateItem(key, seed);
  if (!item) throw new Error(`no template for ${key}`);
  return item;
}

function submission(item: PracticeItem): string {
  return formatAnswer(item.answer);
}

function grade(key: string, seed: number, raw: string): boolean | undefined {
  return gradeTemplateItem(makeItemId(key, seed), raw)?.correct;
}

// ── Typeset stem → plain JavaScript ─────────────────────────────────────────

/** LaTeX from a stem span → the answer grammar (also used as "unfinished" input). */
function texToGrammar(latex: string): string {
  let s = latex.replace(/\\left\(/g, "(").replace(/\\right\)/g, ")");
  for (let i = 0; i < 12; i++) {
    const before = s;
    s = s
      .replace(/\^\{([^{}]*)\}/g, "^($1)")
      .replace(/\\sqrt\[(\d+)\]\{([^{}]*)\}/g, "(($2)^(1/$1))")
      .replace(/\\sqrt\{([^{}]*)\}/g, "sqrt($1)")
      .replace(/\\frac\{([^{}]*)\}\{([^{}]*)\}/g, "(($1)/($2))")
      .replace(/\\log_\{([^{}]*)\}/g, "log_($1)");
    if (s === before) break;
  }
  return s
    .replace(/\\log/g, "log")
    .replace(/\\ln/g, "ln")
    .replace(/\\cdot/g, "*")
    .replace(/\s+/g, "");
}

/** Answer grammar → a JavaScript expression over LOGB/LOGT/LN/SQRT/CBRT/E_. */
function grammarToJs(grammar: string): string {
  let s = grammar.replace(/−/g, "-").replace(/·/g, "*").replace(/\s+/g, "");
  // log_<base>( → LOGB(<base>,   (base is digits or a parenthesised group)
  let out = "";
  for (let i = 0; i < s.length; ) {
    if (s.startsWith("log_", i)) {
      let j = i + 4;
      let base = "";
      if (s[j] === "(") {
        let depth = 0;
        const start = j;
        for (; j < s.length; j++) {
          if (s[j] === "(") depth++;
          else if (s[j] === ")" && --depth === 0) break;
        }
        base = s.slice(start, j + 1);
        j++;
      } else {
        while (j < s.length && /[0-9a-z]/.test(s[j]) && s[j] !== "(") base += s[j++];
      }
      if (s[j] !== "(") throw new Error(`bad log in ${grammar}`);
      out += `LOGB(${base},`;
      i = j + 1;
      continue;
    }
    out += s[i++];
  }
  s = out
    .replace(/log\(/g, "LOGT(")
    .replace(/ln\(/g, "LN(")
    .replace(/sqrt\(/g, "SQRT(")
    .replace(/√\(/g, "SQRT(")
    .replace(/∛\(/g, "CBRT(")
    .replace(/(^|[^A-Za-z])e(?![A-Za-z])/g, "$1E_");
  s = s.replace(/([0-9a-z)_])(?=[a-zA-Z(])/g, "$1*");
  return s.replace(/\^/g, "**");
}

const LIB = {
  LOGB: (b: number, x: number) => Math.log(x) / Math.log(b),
  LOGT: Math.log10,
  LN: Math.log,
  SQRT: Math.sqrt,
  CBRT: Math.cbrt,
  E_: Math.E,
};
const VARS = ["x", "y", "z", "b", "t", "n"] as const;
type Env = Partial<Record<(typeof VARS)[number], number>>;

function compile(grammar: string): (env?: Env) => number {
  const js = grammarToJs(grammar);
  const fn = new Function(...VARS, ...Object.keys(LIB), `return (${js});`) as (...args: number[]) => number;
  return (env: Env = {}) =>
    fn(...VARS.map((v) => env[v] ?? NaN), ...(Object.values(LIB) as unknown as number[]));
}

function close(a: number, b: number): boolean {
  return Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(b));
}

function spans(stem: string): string[] {
  return [...stem.matchAll(/\\\((.*?)\\\)/g)].map((m) => m[1]);
}

function lastSpan(stem: string): string {
  const all = spans(stem);
  return all[all.length - 1];
}

/** The stem's last span holding "=", split into compiled sides. */
function stemEquation(stem: string): { left: (env?: Env) => number; right: (env?: Env) => number; grammar: string[] } {
  const eq = [...spans(stem)].reverse().find((s) => s.includes("="));
  if (!eq) throw new Error(`no equation in ${stem}`);
  const [l, r] = eq.split("=").map(texToGrammar);
  return { left: compile(l), right: compile(r), grammar: [l, r] };
}

function value(grammar: string, env: Env = {}): number {
  return compile(grammar)(env);
}

function members(item: PracticeItem): string[] {
  return item.answer.type === "solutionSet" ? item.answer.members : [];
}

/** An equivalent spelling of a rational literal: 3 → 6/2, -3/2 → -6/4. */
function doubled(literal: string): string {
  const m = literal.match(/^(-?\d+)(?:\/(\d+))?$/);
  if (!m) throw new Error(`not a rational literal: ${literal}`);
  return `${Number(m[1]) * 2}/${Number(m[2] ?? 1) * 2}`;
}

/** Split an answer into its top-level signed terms. */
function topTerms(expr: string): string[] {
  const terms: string[] = [];
  let depth = 0;
  let current = "";
  for (const ch of expr) {
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if ((ch === "+" || ch === "-") && depth === 0 && current !== "") {
      terms.push(current);
      current = ch === "-" ? "-" : "";
      continue;
    }
    current += ch;
  }
  terms.push(current);
  return terms;
}

/** log_b(X) → (ln(X)/ln(b)), log(X) → (ln(X)/ln(10)); single-level arguments. */
function toNaturalLogs(expr: string): string {
  return expr
    .replace(/log_(\d+)\(([^()]*(?:\([^()]*\)[^()]*)*)\)/g, "(ln($2)/ln($1))")
    .replace(/(^|[^_a-z])log\(([^()]*)\)/g, "$1(ln($2)/ln(10))");
}

// ── What the on-screen pad can enter ────────────────────────────────────────

/** Can the item's canonical typed answer be entered on the pad its palette
 *  shows? Base keys: digits x y + − × / ^ ( ) . √; complex adds i; logs adds
 *  log, ln and e; sequence adds n; a solution set adds "," and ±. Number
 *  answers use the number pad: an integer or a fraction. */
function typableOnPad(item: PracticeItem): boolean {
  const a = item.answer;
  if (a.type === "integer") return Number.isInteger(a.value);
  if (a.type === "fraction") return Number.isInteger(a.num) && Number.isInteger(a.den);
  if (a.type !== "expression" && a.type !== "solutionSet") return true;
  let allowed = "0123456789xy+-*/^().√";
  if (item.answerPalette === "complex") allowed += "i";
  if (item.answerPalette === "sequence") allowed += "n";
  const strings = a.type === "solutionSet" ? a.members : [a.canonical];
  if (a.type === "solutionSet") allowed += ",±";
  return strings.every((raw) => {
    let s = raw;
    if (item.answerPalette === "logs") s = s.replace(/log_/g, "").replace(/log|ln/g, "").replace(/e/g, "");
    return [...s].every((ch) => allowed.includes(ch));
  });
}

// ── Coverage ────────────────────────────────────────────────────────────────

describe("algebra-2 exponential-logarithmic templates", () => {
  test("every strand node has a template (the graph one lives in graphNodes.ts)", () => {
    const strand = ALGEBRA_2_SKILLS.filter((s) => s.strand === "exponential-logarithmic").map((s) => s.skillKey);
    expect([...strand].sort()).toEqual([...KEYS, ...UNTEMPLATED].sort());
    for (const key of KEYS) expect(hasTemplate(key), key).toBe(true);
    for (const key of UNTEMPLATED) expect(hasTemplate(key), key).toBe(true);
  });

  test.each(KEYS)("%s: reproducible, varied, typed and palette-tagged as declared", (key) => {
    const distinct = new Set<string>();
    const seen = new Set<string>();
    for (let seed = 1; seed <= 80; seed++) {
      const item = itemFor(key, seed);
      expect(generateItem(key, seed)).toEqual(item);
      expect(SHAPE[key].types).toContain(item.answerType);
      expect(item.answer.type).toBe(item.answerType);
      seen.add(item.answerType);
      // The algebra pad (and so its palette) appears only for typed algebra.
      const padShown = item.answerType === "expression" || item.answerType === "solutionSet";
      expect(item.answerPalette).toBe(padShown ? SHAPE[key].palette : undefined);
      if (SHAPE[key].form) expect(item.answerForm).toBe(SHAPE[key].form);
      distinct.add(`${item.stem}¦${formatAnswer(item.answer)}`);
    }
    expect(distinct.size, `${key} produced ${distinct.size} distinct items`).toBeGreaterThanOrEqual(12);
    for (const type of SHAPE[key].types) expect(seen, `${key} never drew ${type}`).toContain(type);
  });

  test.each(KEYS)("%s: clean stems and worked steps that end on the answer", (key) => {
    for (const seed of MANY) {
      const item = itemFor(key, seed);
      for (const bad of ["undefined", "NaN", "--", "+ -", "x^1", "x^{1}", "Infinity"]) {
        expect(item.stem, `${key}#${seed}`).not.toContain(bad);
      }
      expect(item.stem, `${key}#${seed}`).not.toMatch(/(^|[^0-9])1x/);
      const steps = item.workedSteps ?? [];
      expect(steps.length, `${key}#${seed}`).toBeGreaterThanOrEqual(1);
      expect(steps.length, `${key}#${seed}`).toBeLessThanOrEqual(5);
      for (const s of steps) {
        expect(s.text.length).toBeGreaterThan(0);
        expect(s.blankText?.length ?? 0).toBeGreaterThan(0);
        expect(s.text).not.toMatch(/undefined|NaN/);
      }
      const last = steps[steps.length - 1].text;
      if (item.answer.type === "solutionSet") {
        if (item.answer.members.length === 0) expect(last, `${key}#${seed}`).toContain("no solution");
        for (const m of item.answer.members) expect(last, `${key}#${seed}`).toContain(`x = ${m}`);
      } else {
        expect(last, `${key}#${seed}`).toContain(formatAnswer(item.answer));
      }
    }
  });

  test.each(KEYS)("%s: the canonical answer grades correct", (key) => {
    for (const seed of MANY) {
      const item = itemFor(key, seed);
      expect(grade(key, seed, formatAnswer(item.answer)), `${key}#${seed}: ${item.stem}`).toBe(true);
    }
  });

  test.each(KEYS)("%s: every typed answer can be entered on the pad it is served with", (key) => {
    for (const seed of MANY) {
      const item = itemFor(key, seed);
      expect(typableOnPad(item), `${key}#${seed}: ${formatAnswer(item.answer)} on ${item.answerPalette ?? item.answerType}`).toBe(true);
    }
  });

  test("expand and condense say the variables are positive (the rules need it)", () => {
    for (const key of ["log_rules_expand", "log_rules_condense"]) {
      for (const seed of MANY) expect(itemFor(key, seed).stem).toContain("Assume every variable is positive.");
    }
  });
});

// ── Grader round trips: equivalent rewrites in, plausible mistakes out ──────

function rewrites(key: Key, item: PracticeItem): { right: string[]; wrong: string[] } {
  const canon = formatAnswer(item.answer);
  if (item.answer.type === "integer" || item.answer.type === "fraction") {
    const [num, den] =
      item.answer.type === "integer" ? [item.answer.value, 1] : [item.answer.num, item.answer.den];
    return {
      right: [`${num * 2}/${den * 2}`, `x = ${canon}`],
      wrong: [
        den === 1 ? String(num + 1) : `${num + den}/${den}`,
        num === 0 ? "1" : den === 1 ? String(-num) : `${-num}/${den}`,
      ],
    };
  }
  if (item.answer.type === "solutionSet") {
    const ms = item.answer.members;
    if (ms.length === 0) return { right: ["No solution", "none"], wrong: ["0", "1"] };
    return {
      right: [[...ms].reverse().map((m) => `x = ${m}`).join(" or "), ms.map((m) => doubled(m)).join(", ")],
      wrong: [
        [String(value(ms[0]) + 1), ...ms.slice(1)].join(", "),
        ms.length > 1 ? ms[0] : `${ms[0]}, ${value(ms[0]) - 3}`,
      ],
    };
  }
  const shifted = [`(${canon})+1`, `(${canon})-2`];
  const literal = /^-?\d+(\/\d+)?$/.test(canon);
  switch (key) {
    case "log_definition": {
      if (literal) return { right: [`x = ${canon}`, doubled(canon)], wrong: [...shifted, `-(${canon})`] };
      const single = canon.match(/^(log_\d+|log)\((\d+)\)$/);
      if (single) {
        return {
          right: [`y = ${canon}`, `${single[1]}(${Number(single[2]) * 2}/2)`],
          // The base and the input swapped is the classic slip.
          wrong: [...shifted, single[1] === "log" ? `log_${single[2]}(10)` : `log_${single[2]}(${single[1].slice(4)})`],
        };
      }
      const power = canon.match(/^(\d+)\^\((\d*)y([+-]\d+)?\)$/);
      if (!power) throw new Error(`unexpected log_definition answer ${canon}`);
      const [B, m, c] = [Number(power[1]), Number(power[2] || 1), Number(power[3] ?? 0)];
      return {
        right: [`x = ${canon}`, `${B ** m}^y*${B}^(${c})`],
        wrong: [...shifted, `${B}^y`, `log_${B}(${m}y+${c})`],
      };
    }
    case "log_evaluate":
    case "log_change_of_base":
      return { right: [doubled(canon), `x = ${canon}`], wrong: [...shifted, canon === "0" ? "1" : `-(${canon})`] };
    case "log_rules_expand": {
      const terms = topTerms(canon);
      const reversed = terms
        .reverse()
        .map((t, i) => (i === 0 ? t : t.startsWith("-") ? t : `+${t}`))
        .join("");
      return {
        right: [reversed, canon.includes("log") ? toNaturalLogs(canon) : canon.replace(/ln\(([a-z])\)/g, "(log($1)/log(e))")],
        // Splitting a power as a product, and dropping a coefficient.
        wrong: [...shifted, canon.replace(/(\d)log/, "log")].filter((w) => w !== canon),
      };
    }
    case "log_rules_condense": {
      const m = canon.match(/^(log_\d+|log|ln)\((.*)\)$/);
      if (!m) throw new Error(`unexpected condensed answer ${canon}`);
      const [, head, arg] = m;
      const [top, bottom] = arg.split("/");
      const factors = top.match(/\d+(?![\^\d])|e\^\d+|[a-z](?:\^\d+)?|[√∛]\([a-z]\)/g) ?? [];
      expect(factors.join("")).toBe(top);
      const reordered = [...factors].reverse().join("*") + (bottom ? `/${bottom}` : "");
      return {
        right: [`${head}(${reordered})`, `${head}(${top}*(1/${bottom ?? 1}))`],
        // Adding instead of multiplying the inputs; leaving a coefficient outside.
        wrong: [...shifted, `${head}(${factors.join("+")}${bottom ? `-${bottom}` : ""})`],
      };
    }
    case "exp_solve_with_logs": {
      const alternative = canon.includes("log") ? toNaturalLogs(canon) : canon.replace(/ln\(/g, "log(");
      return { right: [`x = ${canon}`, alternative], wrong: [...shifted, canon.replace(/(log_\d+|log|ln)\((\d+)\)/, "$1($2+1)")] };
    }
    case "exp_natural_base": {
      let alternative: string;
      let m: RegExpMatchArray | null;
      if ((m = canon.match(/^(\d+)ln\((\d+)\)$/))) alternative = `ln(${m[2]})*${m[1]}`;
      else if ((m = canon.match(/^ln\((\d+)\)\/(\d+)$/))) alternative = `(1/${m[2]})ln(${m[1]})`;
      else if ((m = canon.match(/^-ln\((\d+)\)$/))) alternative = `ln(1/${m[1]})`;
      else if ((m = canon.match(/^ln\((\d+)\)$/))) alternative = `ln(${Number(m[1]) * 2}/2)`;
      else if ((m = canon.match(/^e\^\(?(-?\d+)\)?$/))) alternative = `1/e^(${-Number(m[1])})`;
      else if ((m = canon.match(/^\(e\^(\d+)([+-]\d+)\)\/(\d+)$/))) alternative = `e^${m[1]}/${m[3]}+(${m[2]})/${m[3]}`;
      else throw new Error(`unexpected natural-base answer ${canon}`);
      const slip = canon.includes("ln") ? canon.replace("ln", "log") : canon.replace("e^", "10^");
      return { right: [`x = ${canon}`, alternative], wrong: [...shifted, slip] };
    }
    case "exp_model_doubling_halflife": {
      if (literal) return { right: [`t = ${canon}`, doubled(canon)], wrong: [...shifted, `(${canon})/2`] };
      const m = canon.match(/^(\d+)log_2\((\d+)\)$/);
      if (!m) throw new Error(`unexpected model answer ${canon}`);
      return {
        right: [`log_2(${Number(m[2]) ** Number(m[1])})`, `${m[1]}ln(${m[2]})/ln(2)`],
        wrong: [...shifted, `log_2(${m[2]})`, `${m[1]}log_2(${m[2]})/2`],
      };
    }
    default:
      throw new Error(`no rewrites for ${key}`);
  }
}

describe("grader round trips", () => {
  test.each(KEYS)("%s: equivalent rewrites are correct and plausible mistakes are not", (key) => {
    for (let seed = 1; seed <= 60; seed++) {
      const item = itemFor(key, seed);
      const { right, wrong } = rewrites(key, item);
      expect(right.length).toBeGreaterThanOrEqual(2);
      expect(wrong.length).toBeGreaterThanOrEqual(2);
      for (const raw of right) expect(grade(key, seed, raw), `${key}#${seed} right "${raw}" for ${formatAnswer(item.answer)}`).toBe(true);
      for (const raw of wrong) expect(grade(key, seed, raw), `${key}#${seed} wrong "${raw}" for ${formatAnswer(item.answer)}`).toBe(false);
    }
  });

  test("an exact answer is accepted in every base the scholar might reach for", () => {
    let checked = 0;
    for (let seed = 1; seed <= 120; seed++) {
      const item = itemFor("exp_solve_with_logs", seed);
      const m = formatAnswer(item.answer).match(/^log_(\d+)\((\d+)\)$/);
      if (!m) continue;
      checked++;
      for (const raw of [`log(${m[2]})/log(${m[1]})`, `ln(${m[2]})/ln(${m[1]})`, `x=log_${m[1]}(${m[2]})`]) {
        expect(grade("exp_solve_with_logs", seed, raw), raw).toBe(true);
      }
    }
    expect(checked).toBeGreaterThan(10);
  });
});

// ── Forms ───────────────────────────────────────────────────────────────────

describe("required forms", () => {
  test("log_definition: the exponent written as a logarithm must be ONE logarithm", () => {
    let checked = 0;
    for (const seed of MANY) {
      const item = itemFor("log_definition", seed);
      if (!item.answerForm) continue;
      checked++;
      expect(item.answerForm).toBe("singleLog");
      const canon = formatAnswer(item.answer);
      expect(meetsRequiredForm(canon, canon, "singleLog")).toBe(true);
      const m = canon.match(/^(log_(\d+)|log)\((\d+)\)$/)!;
      const quotient = `ln(${m[3]})/ln(${m[2] ?? 10})`;
      expect(rawAnswersEqual(quotient, canon, "expression")).toBe(true);
      expect(meetsRequiredForm(quotient, canon, "singleLog")).toBe(false);
    }
    expect(checked).toBeGreaterThan(30);
  });

  test("expand and condense: the un-rewritten stem is equal but not yet in the form", () => {
    for (const [key, form] of [
      ["log_rules_expand", "expandedLog"],
      ["log_rules_condense", "singleLog"],
    ] as const) {
      for (const seed of MANY) {
        const item = itemFor(key, seed);
        const canon = formatAnswer(item.answer);
        const unfinished = texToGrammar(lastSpan(item.stem));
        expect(meetsRequiredForm(canon, canon, form), `${key}#${seed} canonical`).toBe(true);
        expect(rawAnswersEqual(unfinished, canon, "expression"), `${key}#${seed} ${unfinished} vs ${canon}`).toBe(true);
        expect(meetsRequiredForm(unfinished, canon, form), `${key}#${seed} ${unfinished}`).toBe(false);
      }
    }
  });
});

// ── Independent math ────────────────────────────────────────────────────────

const SAMPLES: Env[] = [
  { x: 1.7, y: 0.6, z: 2.3 },
  { x: 0.4, y: 3.1, z: 1.2 },
  { x: 5.2, y: 1.9, z: 0.7 },
];

function mathChecks(forced: boolean): void {
  test("exp_solve_common_base: every member solves the equation and nothing else on a fine grid does", () => {
    for (const seed of MANY) {
      const item = itemFor("exp_solve_common_base", seed);
      const { left, right } = stemEquation(item.stem);
      const roots =
        item.answer.type === "solutionSet" ? members(item).map((m) => value(m)) : [value(formatAnswer(item.answer))];
      expect(roots.length).toBeGreaterThan(0);
      // Both sides are positive powers, so compare their logarithms: tiny values
      // far down the grid would otherwise all look "equal".
      const same = (x: number) => close(Math.log(left({ x })), Math.log(right({ x })));
      for (const x of roots) expect(same(x), `${item.stem} at ${x}`).toBe(true);
      for (let k = -144; k <= 144; k++) {
        const x = k / 12;
        if (roots.some((root) => Math.abs(root - x) < 1e-9)) continue;
        expect(same(x), `${item.stem}: missed x = ${x}`).toBe(false);
      }
    }
  });

  test("log_definition: substituting the answer makes the stem's statement true", () => {
    for (const seed of MANY) {
      const item = itemFor("log_definition", seed);
      const { left, right } = stemEquation(item.stem);
      const answer = formatAnswer(item.answer);
      if (item.stem.includes("in terms of")) {
        for (const y of [0.3, 1.1, 2]) {
          const x = value(answer, { y });
          expect(close(left({ x, y }), right({ x, y })), item.stem).toBe(true);
        }
      } else if (item.stem.includes("Find the base")) {
        const b = value(answer);
        expect(b).toBeGreaterThan(0);
        expect(close(left({ b }), right({ b })), item.stem).toBe(true);
      } else if (item.stem.includes("Find")) {
        const x = value(answer);
        expect(close(left({ x }), right({ x })), item.stem).toBe(true);
      } else {
        const y = value(answer);
        expect(close(left({ y }), right({ y })), item.stem).toBe(true);
        expect(Number.isInteger(Math.round(y * 1e9) / 1e9), `${item.stem}: a whole exponent belongs in log_evaluate`).toBe(false);
      }
    }
  });

  test("log_evaluate and log_change_of_base: the typeset expression has the answer's value", () => {
    for (const key of ["log_evaluate", "log_change_of_base"]) {
      for (const seed of MANY) {
        const item = itemFor(key, seed);
        const expression = texToGrammar(lastSpan(item.stem));
        expect(close(value(expression), value(formatAnswer(item.answer))), `${key}#${seed}: ${item.stem}`).toBe(true);
      }
    }
  });

  test("expand and condense: the stem and the answer agree at sample points", () => {
    for (const key of ["log_rules_expand", "log_rules_condense"]) {
      for (const seed of MANY) {
        const item = itemFor(key, seed);
        const stem = compile(texToGrammar(lastSpan(item.stem)));
        const answer = compile(formatAnswer(item.answer));
        for (const env of SAMPLES) expect(close(stem(env), answer(env)), `${key}#${seed}: ${item.stem}`).toBe(true);
      }
    }
  });

  test("exp_solve_with_logs and exp_natural_base: the answer solves the stem's equation", () => {
    for (const key of ["exp_solve_with_logs", "exp_natural_base"]) {
      for (const seed of MANY) {
        const item = itemFor(key, seed);
        const t = value(formatAnswer(item.answer));
        const growth = item.stem.match(/P = (\d+)e\^\{([\d.]+)t\}.*is it (\d+)\?/);
        const decay = item.stem.match(/A = (\d+)e\^\{-([\d.]+)t\}.*is (\d+) left\?/);
        if (growth) {
          expect(close(Number(growth[1]) * Math.exp(Number(growth[2]) * t), Number(growth[3])), item.stem).toBe(true);
          expect(t).toBeGreaterThan(0);
        } else if (decay) {
          expect(close(Number(decay[1]) * Math.exp(-Number(decay[2]) * t), Number(decay[3])), item.stem).toBe(true);
          expect(t).toBeGreaterThan(0);
        } else {
          const { left, right } = stemEquation(item.stem);
          expect(close(left({ x: t }), right({ x: t })), `${key}#${seed}: ${item.stem} at ${t}`).toBe(true);
        }
      }
    }
  });

  test("exp_model_doubling_halflife: the answer fits the model the words describe", () => {
    const models: [RegExp, (m: RegExpMatchArray, t: number) => [number, number]][] = [
      [/starts at (\d+) and doubles every (\d+) (?:hours|days)\. After how many \w+ is it (\d+)\?/, (m, t) => [Number(m[1]) * 2 ** (t / Number(m[2])), Number(m[3])]],
      [/A colony of (\d+) cells doubles every (\d+) hours\. After how many hours are there (\d+) cells\?/, (m, t) => [Number(m[1]) * 2 ** (t / Number(m[2])), Number(m[3])]],
      [/A sample of (\d+) grams has a half-life of (\d+) (?:days|years)\. After how many \w+ are (\d+) grams left\?/, (m, t) => [Number(m[1]) * 0.5 ** (t / Number(m[2])), Number(m[3])]],
      [/takes (\d+) ms on (\d+) items, .* grows by (\d+) items\. How many items take (\d+) ms\?/, (m, n) => [Number(m[1]) * 2 ** ((n - Number(m[2])) / Number(m[3])), Number(m[4])]],
      [/grows by a factor of (\d+) every (\d+) years\. What is its doubling time/, (m, d) => [2 ** (Number(m[2]) / d), Number(m[1])]],
      [/shrinks to \\\(\\frac\{1\}\{(\d+)\}\\\) of its mass in (\d+) minutes\. What is its half-life/, (m, h) => [0.5 ** (Number(m[2]) / h), 1 / Number(m[1])]],
    ];
    for (const seed of MANY) {
      const item = itemFor("exp_model_doubling_halflife", seed);
      const t = value(formatAnswer(item.answer));
      const hit = models.map(([re, f]) => {
        const m = item.stem.match(re);
        return m ? f(m, t) : null;
      }).find((x) => x !== null);
      expect(hit, `no model matches: ${item.stem}`).toBeTruthy();
      expect(close(hit![0], hit![1]), `${item.stem} with ${t}`).toBe(true);
    }
  });

  test("log_solve_equation: members are exactly the real solutions, and the domain check really bites", () => {
    let withRejected = 0;
    let empty = 0;
    for (const seed of MANY) {
      const item = itemFor("log_solve_equation", seed);
      const { left, right, grammar } = stemEquation(item.stem);
      const roots = members(item).map((m) => value(m));
      for (const x of roots) expect(close(left({ x }), right({ x })), `${item.stem} at ${x}`).toBe(true);
      // Completeness on a grid wide enough for every draw.
      for (let k = -80; k <= 80; k++) {
        const x = k / 2;
        if (roots.some((r) => Math.abs(r - x) < 1e-9)) continue;
        expect(close(left({ x }), right({ x })), `${item.stem}: missed x = ${x}`).toBe(false);
      }
      // The algebra's candidates: exponentiate both sides, i.e. compare the
      // product of the log inputs with the right side's input (or base^k). A
      // candidate that is not a real solution is one the domain check rejects.
      const inputs = (side: string) =>
        [...grammarToJs(side).matchAll(/LOGB\(([^,]+),([^()]*)\)|LOGT\(([^()]*)\)|LN\(([^()]*)\)/g)].map(
          (m) => (m[2] ?? m[3] ?? m[4]) as string,
        );
      const [lInputs, rInputs] = grammar.map(inputs);
      const base = (() => {
        const m = grammar[0].match(/log_\((\d+)\)|log_(\d+)/);
        return m ? Number(m[1] ?? m[2]) : grammar[0].startsWith("ln") ? Math.E : 10;
      })();
      const product = (list: string[], x: number) =>
        list.reduce((acc, input) => acc * new Function("x", `return (${input});`)(x), 1);
      let rejected = false;
      for (let x = -40; x <= 40; x++) {
        const lhs = product(lInputs, x);
        const rhs = rInputs.length > 0 ? product(rInputs, x) : base ** value(grammar[1]);
        if (Math.abs(lhs - rhs) < 1e-9 && !roots.includes(x)) rejected = true;
      }
      if (rejected) withRejected++;
      if (roots.length === 0) empty++;
    }
    if (!forced) {
      expect(withRejected / MANY.length, "share of draws with a rejected candidate").toBeGreaterThan(0.3);
      expect(empty / MANY.length, "share of draws with no solution").toBeGreaterThan(0.05);
    }
  });
}

describe("the math, re-derived", () => mathChecks(false));

describe("every retry exhausted: each fallback is served and still right", () => {
  beforeAll(() => {
    EXP_LOG_DRAW.attempts = 0;
  });
  afterAll(() => {
    EXP_LOG_DRAW.attempts = 80;
  });

  test.each(KEYS)("%s: the fallback items grade correct and are typable", (key) => {
    for (const seed of MANY) {
      const item = itemFor(key, seed);
      expect(grade(key, seed, submission(item)), `${key}#${seed}: ${item.stem}`).toBe(true);
      expect(typableOnPad(item), `${key}#${seed}`).toBe(true);
    }
  });

  test("the log + log = log fallback: roots 1 and 3, only 3 survives", () => {
    let seen = 0;
    for (const seed of MANY) {
      const item = itemFor("log_solve_equation", seed);
      if (!item.stem.includes("(x - 2) + ") || !item.stem.includes("(3x - 5)")) continue;
      seen++;
      expect(formatAnswer(item.answer)).toBe("3");
      const steps = (item.workedSteps ?? []).map((s) => s.text).join(" ");
      expect(steps).toContain("x^2 - 4x + 3 = 0");
      // (3 - 2)(3 + 1) = 4 = 3·3 - 5, and x = 1 makes x - 2 negative.
      expect((3 - 2) * (3 + 1)).toBe(3 * 3 - 5);
    }
    expect(seen).toBeGreaterThan(0);
  });

  mathChecks(true);
});
