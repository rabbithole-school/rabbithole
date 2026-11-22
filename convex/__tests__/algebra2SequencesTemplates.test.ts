/**
 * Algebra 2, sequences-series strand: the deterministic templates in
 * convex/lib/practice/algebra2/sequences.ts.
 *
 * The math checks never reuse the generator's arithmetic: rules are checked
 * against the terms printed in the stem, recursions are run forward, and
 * every sum is added up term by term (an infinite series by a long partial sum).
 */
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { formatAnswer, type AnswerType } from "../lib/practice/answers";
import { gradeTemplateItem, makeItemId } from "../lib/practice/session";
import { generateItem, hasTemplate, type PracticeItem } from "../lib/practice/templates";
import { ALGEBRA_2_SKILLS } from "../seed/algebra2Graph";
import { SEQUENCES_DRAW } from "../lib/practice/algebra2/sequences";

const KEYS = [
  "seq_arithmetic_explicit",
  "seq_geometric_explicit",
  "seq_recursive",
  "series_sigma_notation",
  "series_arithmetic_sum",
  "series_geometric_sum",
  "series_infinite_geometric",
] as const;
type Key = (typeof KEYS)[number];

/** The answer types a family's draws use (a draw names its own when its
 *  natural answer is a plain number), and the algebra-pad palette, which is
 *  served only when a draw shows that pad. */
const SHAPE: Record<Key, { types: AnswerType[]; palette?: string }> = {
  seq_arithmetic_explicit: { types: ["expression", "integer"], palette: "sequence" },
  seq_geometric_explicit: { types: ["expression", "integer", "fraction"], palette: "sequence" },
  seq_recursive: { types: ["expression", "integer"], palette: "sequence" },
  series_sigma_notation: { types: ["integer"] },
  series_arithmetic_sum: { types: ["integer"] },
  series_geometric_sum: { types: ["integer", "fraction"] },
  series_infinite_geometric: { types: ["multipleChoice", "solutionSet"], palette: "algebra" },
};

const MANY = Array.from({ length: 240 }, (_, i) => i + 1);

function itemFor(key: string, seed: number): PracticeItem {
  const item = generateItem(key, seed);
  if (!item) throw new Error(`no template for ${key}`);
  return item;
}

function grade(key: string, seed: number, raw: string): boolean | undefined {
  return gradeTemplateItem(makeItemId(key, seed), raw)?.correct;
}

function submission(item: PracticeItem): string {
  return item.answer.type === "multipleChoice" ? String(item.answer.choiceIndex) : formatAnswer(item.answer);
}

// ── Stem and answer → plain JavaScript ──────────────────────────────────────

function texToGrammar(latex: string): string {
  let s = latex.replace(/\\left\(/g, "(").replace(/\\right\)/g, ")");
  for (let i = 0; i < 8; i++) {
    const before = s;
    s = s.replace(/\^\{([^{}]*)\}/g, "^($1)").replace(/\\frac\{([^{}]*)\}\{([^{}]*)\}/g, "(($1)/($2))");
    if (s === before) break;
  }
  return s.replace(/\\cdot/g, "*").replace(/\s+/g, "");
}

/** n, k and p (a previous term) are the only letters these expressions use. */
function compile(grammar: string): (env: { n?: number; k?: number; p?: number }) => number {
  const js = grammar
    .replace(/−/g, "-")
    .replace(/([0-9a-z)])(?=[a-z(])/g, "$1*")
    .replace(/\^/g, "**");
  const fn = new Function("n", "k", "p", `return (${js});`) as (n: number, k: number, p: number) => number;
  return ({ n = NaN, k = NaN, p = NaN }) => fn(n, k, p);
}

function value(grammar: string): number {
  return compile(grammar)({});
}

function close(a: number, b: number): boolean {
  return Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(b));
}

function spans(stem: string): string[] {
  return [...stem.matchAll(/\\\((.*?)\\\)/g)].map((m) => m[1]);
}

/** `7, 11, −3, …` after "sequence: " or "sequence " in a stem. */
function listedTerms(stem: string): number[] {
  const m = stem.match(/sequence:? ((?:−?\d+, )+)…/);
  if (!m) throw new Error(`no term list in ${stem}`);
  return m[1]
    .split(", ")
    .filter(Boolean)
    .map((t) => Number(t.replace("−", "-")));
}

/** `3 + 7 + 11 + ⋯ + 99` → first terms and the last term. */
function writtenSeries(stem: string): { terms: number[]; last?: number } {
  const m = stem.match(/((?:−?\d+(?: [+−] \d+)+)) [+−] ⋯(?: \+ \(?(−?\d+)\)?)?/);
  if (!m) throw new Error(`no written series in ${stem}`);
  const terms: number[] = [];
  const tokens = m[1].split(" ");
  terms.push(Number(tokens[0].replace("−", "-")));
  for (let i = 1; i < tokens.length; i += 2) terms.push((tokens[i] === "−" ? -1 : 1) * Number(tokens[i + 1]));
  return { terms, last: m[2] === undefined ? undefined : Number(m[2].replace("−", "-")) };
}

/** `\sum_{k=lo}^{hi} summand` → bounds and the summand as a function of k. */
function sigma(stem: string): { lo: number; hi: number; f: (k: number) => number } {
  const span = spans(stem).find((s) => s.includes("\\sum"));
  const m = span?.match(/\\sum_\{k=(\d+)\}\^\{(\d+|\\infty)\} (.*)$/);
  if (!m) throw new Error(`no sigma in ${stem}`);
  const f = compile(texToGrammar(m[3]));
  return { lo: Number(m[1]), hi: m[2] === "\\infty" ? Infinity : Number(m[2]), f: (k) => f({ k }) };
}

function rule(item: PracticeItem): (n: number) => number {
  const f = compile(formatAnswer(item.answer));
  return (n) => f({ n });
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

describe("algebra-2 sequences-series templates", () => {
  test("every strand node has exactly one template", () => {
    const strand = ALGEBRA_2_SKILLS.filter((s) => s.strand === "sequences-series").map((s) => s.skillKey);
    expect([...strand].sort()).toEqual([...KEYS].sort());
    for (const key of KEYS) expect(hasTemplate(key), key).toBe(true);
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
      const padShown = item.answerType === "expression" || item.answerType === "solutionSet";
      expect(item.answerPalette).toBe(padShown ? SHAPE[key].palette : undefined);
      expect(item.answerForm).toBeUndefined();
      distinct.add(`${item.stem}¦${JSON.stringify(item.choices ?? null)}¦${formatAnswer(item.answer)}`);
    }
    expect(distinct.size, `${key} produced ${distinct.size} distinct items`).toBeGreaterThanOrEqual(12);
    for (const type of SHAPE[key].types) expect(seen, `${key} never drew ${type}`).toContain(type);
  });

  test.each(KEYS)("%s: clean stems and worked steps that end on the answer", (key) => {
    for (const seed of MANY) {
      const item = itemFor(key, seed);
      for (const bad of ["undefined", "NaN", "--", "+ -", "x^1", "Infinity", "1n"]) {
        expect(item.stem, `${key}#${seed}`).not.toContain(bad);
      }
      expect(item.stem, `${key}#${seed}`).not.toMatch(/(^|[^0-9])1x/);
      const steps = item.workedSteps ?? [];
      expect(steps.length, `${key}#${seed}`).toBeGreaterThanOrEqual(2);
      expect(steps.length, `${key}#${seed}`).toBeLessThanOrEqual(5);
      for (const s of steps) {
        expect(s.blankText?.length ?? 0).toBeGreaterThan(0);
        expect(s.text).not.toMatch(/undefined|NaN/);
      }
      const last = steps[steps.length - 1].text;
      if (item.answer.type === "multipleChoice") {
        expect(last, `${key}#${seed}`).toContain(item.choices![item.answer.choiceIndex]);
      } else if (item.answer.type === "solutionSet" && item.answer.members.length === 0) {
        expect(last, `${key}#${seed}`).toContain("No solution");
      } else {
        expect(last, `${key}#${seed}`).toContain(formatAnswer(item.answer));
      }
    }
  });

  test.each(KEYS)("%s: the canonical answer grades correct", (key) => {
    for (const seed of MANY) {
      const item = itemFor(key, seed);
      expect(grade(key, seed, submission(item)), `${key}#${seed}: ${item.stem}`).toBe(true);
    }
  });

  test("series_infinite_geometric: judgement draws have 3–4 distinct options, exactly one correct", () => {
    let diverging = 0;
    let judged = 0;
    for (const seed of MANY) {
      const item = itemFor("series_infinite_geometric", seed);
      if (item.answerType !== "multipleChoice") continue;
      judged++;
      const choices = item.choices ?? [];
      expect(choices.length).toBeGreaterThanOrEqual(3);
      expect(choices.length).toBeLessThanOrEqual(4);
      expect(new Set(choices).size).toBe(choices.length);
      const right = choices.map((_, i) => grade("series_infinite_geometric", seed, String(i)));
      expect(right.filter(Boolean)).toHaveLength(1);
      if (item.answer.type === "multipleChoice" && choices[item.answer.choiceIndex].startsWith("Diverges")) diverging++;
    }
    // Both kinds of draw, and both verdicts, occur often.
    expect(judged / MANY.length).toBeGreaterThan(0.3);
    expect(judged / MANY.length).toBeLessThan(0.7);
    expect(diverging / judged).toBeGreaterThan(0.3);
    expect(diverging / judged).toBeLessThan(0.7);
  });

  test.each(KEYS)("%s: every typed answer can be entered on the pad it is served with", (key) => {
    for (const seed of MANY) {
      const item = itemFor(key, seed);
      expect(typableOnPad(item), `${key}#${seed}: ${formatAnswer(item.answer)} on ${item.answerPalette ?? item.answerType}`).toBe(true);
    }
  });
});

// ── Grader round trips ──────────────────────────────────────────────────────

function signed(v: number): string {
  return v < 0 ? `-${-v}` : `+${v}`;
}

function rewrites(key: Key, item: PracticeItem): { right: string[]; wrong: string[] } {
  const canon = formatAnswer(item.answer);
  if (item.answer.type === "solutionSet") {
    const [m] = item.answer.members;
    if (m === undefined) return { right: ["No solution", "none"], wrong: ["0", "1"] };
    const v = value(m);
    // A divergent verdict for a convergent series is the first mistake to rule out.
    return { right: [`S = ${m}`, String(v * 2) + "/2"], wrong: [String(v + 1), "none"] };
  }
  const literal = canon.match(/^(-?\d+)(?:\/(\d+))?$/);
  if (literal) {
    const [num, den] = [Number(literal[1]), Number(literal[2] ?? 1)];
    const right = [`${num * 2}/${den * 2}`, num < 0 ? `−${-num}${den === 1 ? "" : `/${den}`}` : `+${canon}`];
    if (key === "series_sigma_notation" || key === "series_arithmetic_sum") {
      right[0] = `${num}.0`;
    }
    return { right, wrong: [String(num + den) + (den === 1 ? "" : `/${den}`), `${-num - 1}`] };
  }
  const f = rule(item);
  const a1 = f(1);
  if (Number.isInteger(f(2) - a1) && close(f(3) - f(2), f(2) - a1)) {
    const d = f(2) - a1;
    const c = a1 - d;
    return {
      right: [`${a1}+(n-1)(${d})`, `${c}+(${d})n`],
      // The first term used as the constant; a whole extra difference.
      wrong: [`${d}n${signed(a1)}`, `${d}n${signed(c + d * 2)}`],
    };
  }
  const r = f(2) / a1;
  const ratio = Number.isInteger(r) ? String(r) : (() => {
    for (let den = 2; den <= 4; den++) if (Number.isInteger(r * den)) return `${r * den}/${den}`;
    throw new Error(`odd ratio ${r}`);
  })();
  return {
    right: [`(${a1}/(${ratio}))*(${ratio})^n`, `${a1}(${ratio})^(n-1)`],
    // One power too many; base and first term swapped.
    wrong: [`${a1}*(${ratio})^n`, a1 === r ? `${a1}*(${ratio})^(n-2)` : `(${ratio})*${a1}^(n-1)`],
  };
}

describe("grader round trips", () => {
  test.each(KEYS)(
    "%s: equivalent rewrites are correct and plausible mistakes are not",
    (key) => {
      for (let seed = 1; seed <= 80; seed++) {
        const item = itemFor(key, seed);
        if (item.answerType === "multipleChoice") continue;
        const { right, wrong } = rewrites(key, item);
        for (const raw of right) expect(grade(key, seed, raw), `${key}#${seed} right "${raw}" for ${formatAnswer(item.answer)}`).toBe(true);
        for (const raw of wrong) expect(grade(key, seed, raw), `${key}#${seed} wrong "${raw}" for ${formatAnswer(item.answer)}`).toBe(false);
      }
    },
  );
});

// ── Independent math ────────────────────────────────────────────────────────

function mathChecks(forced: boolean): void {
  // Nothing here is a distribution claim, so both runs check the same things.
  void forced;
  test("seq_arithmetic_explicit and seq_geometric_explicit: answers agree with the printed terms", () => {
    for (const key of ["seq_arithmetic_explicit", "seq_geometric_explicit"]) {
      for (const seed of MANY) {
        const item = itemFor(key, seed);
        const answer = formatAnswer(item.answer);
        const given = spans(item.stem)
          .map((s) => s.match(/^a_\{(\d+)\} = (.*)$/))
          .filter((m): m is RegExpMatchArray => m !== null)
          .map((m) => ({ n: Number(m[1]), v: value(texToGrammar(m[2])) }));
        if (given.length === 2) {
          // Two terms given: the rule must hit both, and be the right family.
          const f = rule(item);
          for (const { n, v } of given) expect(close(f(n), v), `${item.stem} → ${answer}`).toBe(true);
          continue;
        }
        const terms = listedTerms(item.stem);
        const arithmetic = key === "seq_arithmetic_explicit";
        const nth = (n: number) =>
          arithmetic ? terms[0] + (n - 1) * (terms[1] - terms[0]) : terms[0] * (terms[1] / terms[0]) ** (n - 1);
        for (let i = 0; i < terms.length; i++) expect(close(nth(i + 1), terms[i]), item.stem).toBe(true);
        const find = item.stem.match(/Find \\\(a_\{(\d+)\}\\\)/);
        const which = item.stem.match(/Which term is (?:\\\((.*?)\\\)|(−?\d+))\?/);
        if (find) {
          expect(close(value(answer), nth(Number(find[1]))), item.stem).toBe(true);
        } else if (which) {
          const target = which[1] ? value(texToGrammar(which[1])) : Number(which[2].replace("−", "-"));
          const n = value(answer);
          expect(Number.isInteger(n) && n >= 1).toBe(true);
          expect(close(nth(n), target), item.stem).toBe(true);
        } else {
          const f = rule(item);
          for (let n = 1; n <= 8; n++) expect(close(f(n), nth(n)), `${item.stem} → ${answer} at n=${n}`).toBe(true);
        }
      }
    }
  });

  test("seq_recursive: run the recursion forward, or evaluate the explicit rule", () => {
    for (const seed of MANY) {
      const item = itemFor("seq_recursive", seed);
      const answer = formatAnswer(item.answer);
      const ss = spans(item.stem);
      const first = ss.map((s) => s.match(/^a_\{1\} = (-?\d+)$/)).find(Boolean);
      const recurrence = ss.map((s) => s.match(/^a_\{n\} = (.*a_\{n-1\}.*)$/)).find(Boolean);
      if (first && recurrence && !recurrence[1].includes(" d") && !recurrence[1].includes("r \\cdot")) {
        const step = compile(texToGrammar(recurrence[1].replace(/a_\{n-1\}/g, "p")));
        const terms = [Number(first[1])];
        for (let i = 1; i < 10; i++) terms.push(step({ p: terms[i - 1] }));
        const find = item.stem.match(/Find \\\(a_\{(\d+)\}\\\)/);
        if (find) expect(value(answer)).toBe(terms[Number(find[1]) - 1]);
        else {
          const f = rule(item);
          for (let n = 1; n <= 10; n++) expect(close(f(n), terms[n - 1]), `${item.stem} → ${answer} at n=${n}`).toBe(true);
        }
        continue;
      }
      // Explicit rule given; one recursive part asked for.
      const explicit = ss.map((s) => s.match(/^a_\{n\} = ([^a]*)$/)).find(Boolean);
      expect(explicit, item.stem).toBeTruthy();
      const f = compile(texToGrammar(explicit![1]));
      const [t1, t2, t3] = [1, 2, 3].map((n) => f({ n }));
      if (item.stem.endsWith("What is \\(a_{1}\\)?")) expect(value(answer)).toBe(t1);
      else if (item.stem.endsWith("What is \\(d\\)?")) {
        expect(value(answer)).toBe(t2 - t1);
        expect(t3 - t2).toBe(t2 - t1);
      } else {
        expect(item.stem.endsWith("What is \\(r\\)?"), item.stem).toBe(true);
        expect(value(answer)).toBe(t2 / t1);
        expect(t3 / t2).toBe(t2 / t1);
      }
    }
  });

  test("series_sigma_notation: add the terms one by one", () => {
    let counting = 0;
    for (const seed of MANY) {
      const item = itemFor("series_sigma_notation", seed);
      const { lo, hi, f } = sigma(item.stem);
      const answer = value(formatAnswer(item.answer));
      if (item.stem.startsWith("How many terms")) {
        counting++;
        let count = 0;
        for (let k = lo; k <= hi; k++) count++;
        expect(answer).toBe(count);
      } else {
        let total = 0;
        for (let k = lo; k <= hi; k++) total += f(k);
        expect(answer, item.stem).toBe(total);
      }
    }
    expect(counting).toBeGreaterThan(0);
  });

  test("series_arithmetic_sum and series_geometric_sum: add the terms one by one", () => {
    for (const key of ["series_arithmetic_sum", "series_geometric_sum"]) {
      for (const seed of MANY) {
        const item = itemFor(key, seed);
        const answer = value(formatAnswer(item.answer));
        let total = 0;
        if (item.stem.includes("\\sum")) {
          const { lo, hi, f } = sigma(item.stem);
          for (let k = lo; k <= hi; k++) total += f(k);
        } else if (item.stem.startsWith("Find the sum of the first")) {
          const count = Number(item.stem.match(/first (\d+) terms/)![1]);
          const terms = listedTerms(item.stem);
          const arithmetic = key === "series_arithmetic_sum";
          for (let i = 0; i < count; i++) {
            total += arithmetic ? terms[0] + i * (terms[1] - terms[0]) : terms[0] * (terms[1] / terms[0]) ** i;
          }
        } else {
          const { terms, last } = writtenSeries(item.stem);
          expect(last, item.stem).toBeDefined();
          const arithmetic = key === "series_arithmetic_sum";
          let t = terms[0];
          let guard = 0;
          for (; guard < 500; guard++) {
            total += t;
            if (t === last) break;
            t = arithmetic ? t + (terms[1] - terms[0]) : t * (terms[1] / terms[0]);
          }
          expect(guard, `${item.stem}: never reached the last term`).toBeLessThan(500);
        }
        expect(close(answer, total), `${item.stem}: ${answer} vs ${total}`).toBe(true);
      }
    }
  });

  test("series_infinite_geometric: the verdict matches a long partial sum", () => {
    for (const seed of MANY) {
      const item = itemFor("series_infinite_geometric", seed);
      let term: (k: number) => number;
      if (item.stem.includes("\\sum")) {
        const { lo, hi, f } = sigma(item.stem);
        expect(lo).toBe(1);
        expect(hi).toBe(Infinity);
        term = f;
      } else {
        const { terms } = writtenSeries(item.stem);
        const r = terms[1] / terms[0];
        expect(close(terms[2] / terms[1], r)).toBe(true);
        term = (k) => terms[0] * r ** (k - 1);
      }
      const partial = (count: number) => {
        let s = 0;
        for (let k = 1; k <= count; k++) s += term(k);
        return s;
      };
      const settled = Math.abs(partial(400) - partial(401)) < 1e-9;
      if (item.answer.type === "multipleChoice") {
        const label = item.choices![item.answer.choiceIndex];
        expect(settled, `${item.stem}: ${label}`).toBe(label.startsWith("Converges"));
      } else if (item.answer.type === "solutionSet") {
        expect(settled, item.stem).toBe(item.answer.members.length === 1);
        if (settled) expect(close(value(item.answer.members[0]), partial(400)), item.stem).toBe(true);
      } else {
        throw new Error(`unexpected answer type ${item.answerType}`);
      }
    }
  });
}

describe("the math, re-derived", () => mathChecks(false));

describe("every retry exhausted: each fallback is served and still right", () => {
  beforeAll(() => {
    SEQUENCES_DRAW.attempts = 0;
  });
  afterAll(() => {
    SEQUENCES_DRAW.attempts = 80;
  });

  test.each(KEYS)("%s: the fallback items grade correct and are typable", (key) => {
    for (const seed of MANY) {
      const item = itemFor(key, seed);
      expect(grade(key, seed, submission(item)), `${key}#${seed}: ${item.stem}`).toBe(true);
      expect(typableOnPad(item), `${key}#${seed}`).toBe(true);
    }
  });

  mathChecks(true);
});
