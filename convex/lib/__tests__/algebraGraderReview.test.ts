/**
 * Pinned counterexamples from the adversarial review of the Algebra 2 grader,
 * plus a differential test of the simplifying-radicals family against master's
 * strict radical parser (the behaviour installed clients saw before nudges).
 */

import { describe, expect, test } from "vitest";
import {
  answersEqual,
  formatAnswer,
  parseAnswer,
  satisfiesAnswerForm,
  type AnswerForm,
} from "../practice/answers";
import { buildTemplateServable, gradeSubmission, PRACTICE_POLICY } from "../practice/servable";
import { makeItemId } from "../practice/session";
import { generateItem } from "../practice/templates";

const eq = (a: string, b: string, type: "expression" | "solutionSet" = "expression") => {
  const pa = parseAnswer(a, type);
  const pb = parseAnswer(b, type);
  return pa !== null && pb !== null && answersEqual(pa, pb);
};

describe("review #2: sampling must not accept identities false on part of the domain", () => {
  test.each([
    ["sqrt(x^2)", "x"],
    ["abs(x)", "x+0sqrt(2)"], // a constant root used to switch off negative samples
    ["abs(x-10)", "10-x"], // every old sample was below 10
    ["abs(x+10)", "x+10"],
    ["|x|", "x"],
    ["√(x^2)", "x"],
    ["sqrt(x^2)+0·√3", "x"],
  ])("key %s ≢ %s", (key, submitted) => {
    expect(eq(submitted, key)).toBe(false);
    expect(eq(key, submitted)).toBe(false);
  });

  test.each([
    ["2log(x)", "log(x^2)"],
    ["√x·√x", "x"],
    ["x^(1/2)", "√x"],
    ["log_2(8)", "3"],
    ["e^(ln 5)", "5"],
    ["(1+i)/(1-i)", "i"],
    ["(x^2)^(1/2)", "|x|"],
    ["∛(x^3)", "x"],
    ["√(x^3)", "x√x"],
    ["x^(2/3)", "∛(x^2)"],
    ["log(x)-log(y)", "log(x/y)"],
    ["(x+i)(x-i)", "x^2+1"],
    ["(√(x^3)·x^(5/2))^3", "x^12"], // two imaginary halves never get compared
    ["(2/(-2))·(-2)^n", "2·(-2)^(n-1)"], // never real: principal values compared
    ["|x-10|", "|10-x|"],
  ])("still equal: %s ≡ %s", (a, b) => {
    expect(eq(a, b)).toBe(true);
    expect(eq(b, a)).toBe(true);
  });
});

describe("review #3 and #12: leading-dot decimals and odd roots of negatives", () => {
  test.each([
    ["1/2", ".5"],
    ["-1/4", "-.25"],
    ["x+1/2", "x+.5"],
    ["(-2048)^(1/11)", "-2"],
    ["(-32)^(3/5)", "-8"],
    ["(-8)^(2/3)", "4"],
  ])("%s ≡ %s", (a, b) => expect(eq(a, b)).toBe(true));

  test("integer and decimal types read a leading dot too", () => {
    expect(parseAnswer(".5", "decimal")).toEqual({ type: "decimal", value: 0.5 });
    expect(parseAnswer("-.25", "decimal")).toEqual({ type: "decimal", value: -0.25 });
    expect(parseAnswer(".5", "integer")).toBeNull();
  });
});

describe("review #4 and #5: solution-set notation", () => {
  test("5+-2 is five plus negative two, not 5 ± 2", () => {
    expect(eq("5+-2", "3", "solutionSet")).toBe(true);
    expect(eq("5+-2", "3, 7", "solutionSet")).toBe(false);
    expect(eq("5±2", "3, 7", "solutionSet")).toBe(true);
    expect(eq("5+/-2", "3, 7", "solutionSet")).toBe(true);
  });

  test.each(["x!=3", "x≠3", "x ≠ 3"])("an exclusion %s is not the inclusion 3", (raw) => {
    expect(eq(raw, "3", "solutionSet")).toBe(false);
  });
});

const meets = (raw: string, form: AnswerForm) => satisfiesAnswerForm(raw, form);

describe("review #6–#11: form checker bypasses", () => {
  test.each([
    // [form, key-form answer that must pass, counterexamples that must fail]
    ["factored", ["(2x+1)(x-3)", "(x-1/2)(x+2)", "2(x+1/2)"], ["2(x^2-2.5x-1.5)", "(x^2-2.5x-1.5)", "(x+1)(x^2-9)y/y", "(x-2)(x+3)+0"]],
    ["simplifiedRadical", ["3√2", "3√2/2", "√2/2", "(1+√5)/2", "2(1+√5)"], ["6√2/2", "(2+4√2)/2", "2·3√2", "3√2+0", "4/2+√2"]],
    ["complexStandard", ["2+3i", "-i", "3-i/2"], ["3+i^2+3i+0x", "2+3i+0x", "2+3i·x^0", "x+3i"]],
    ["rationalizedDenominator", ["√2/2", "(3+√5)/4"], ["(√2)^-1", "(√2)^(-3)", "1/√2", "x^(-1/2)"]],
    ["expandedLog", ["log(x)+log(y)", "2log(x)-log(y)", "log(8)"], ["log(xy+0)", "log(x+1)", "log(xy)", "log(x^2)"]],
    ["singleFraction", ["5/6", "(x+1)/(x-2)"], ["1/2+1/3", "x/2+1/3", "1/x+1/y", "(1/2)/3"]],
    ["expanded", ["x^2+5x+6"], ["x^2+5x+6+0x", "x^2+5x+6+0"]],
  ] as const)("%s", (form, accept, reject) => {
    for (const raw of accept) expect(meets(raw, form), `${form} accepts ${raw}`).toBe(true);
    for (const raw of reject) expect(meets(raw, form), `${form} rejects ${raw}`).toBe(false);
  });
});

// ── Second review pass ─────────────────────────────────────────────────────

describe("review 2 / sampling", () => {
  test.each([
    // [key, submitted, equal?]
    ["x", "(x^(2/3))^(3/2)", false], // 8 at x = −8: odd-root powers stay real, so compared
    ["x^(11/5)", "(x^(6/5))^(11/6)", false], // |x|^(11/5) for x < 0, by the same convention
    ["2log(x-20)", "log((x-20)^2)", true], // shared real domain is x > 20: found by the sweep
    ["2ln(x-100)", "ln(x-100)+ln(x-100)", true],
    ["log(x-20)", "log(20-x)", false], // no shared real domain: never equal
    ["4^(n-1)", "(-2)^(2n-2)", true], // n is a sequence index: positive integers only
    ["3*2^(n-1)", "(3/2)*2^n", true],
    ["2*(-2)^(n-1)", "(2/(-2))*(-2)^n", true],
    ["4*(-2)^(n-1)", "(4/(-2))*(-2)^n", true],
    ["abs(x^2-0.01)", "x^2-0.01", false], // they differ on (−0.1, 0.1)
    ["|x^2-1|", "x^2-1", false],
    // still true from the first pass
    ["2log(x)", "log(x^2)", true],
    ["√x·√x", "x", true],
    ["∛(x^3)", "x", true],
    ["(x^2)^(1/2)", "|x|", true],
    ["sqrt(x^2)", "x", false],
  ] as const)("key %s vs %s → %s", (key, submitted, equal) => {
    expect(eq(submitted, key)).toBe(equal);
    expect(eq(key, submitted)).toBe(equal);
  });
});

describe("review 2 / forms", () => {
  test.each([
    ["simplifiedRadical", ["3√2/2", "3*√2", "√2/2"], ["√2/(2/3)", "3√2/(1/1)", "6√2/2"]],
    ["expanded", ["x^2+5x+6", "(1/2)x^2+x/2", "x/2+1"], ["x^2+5x+2*3", "x^2+6/2x+6", "x^2+5x+2+4", "x^2+5x+6/1"]],
    ["factored", ["(x-2)(x+4)", "2(x-2)(x+4)", "-(x-2)(x+4)"], ["(x-2)(x+4)*(x-x+1)", "(x-2)(x+4)*1", "(x-2)(x+4)(x/x)", "(x-2)(x+4)*(2x-2x+3)"]],
    // Not a change: a + bi means two separate parts.
    ["complexStandard", ["3/5+(4/5)i"], ["(3+4i)/5"]],
  ] as const)("%s", (form, accept, reject) => {
    for (const raw of accept) expect(meets(raw, form), `${form} accepts ${raw}`).toBe(true);
    for (const raw of reject) expect(meets(raw, form), `${form} rejects ${raw}`).toBe(false);
  });
});

// ── Differential: roots_simplify_radicals vs master, for a client with no count ──

/** Master's canonicalization + strict simplified-radical parser, verbatim. */
function masterCanonicalize(s: string): string {
  return s
    .trim()
    .toLowerCase()
    .replace(/(\d+)\s+(\d+\s*\/\s*\d+)/g, "($1+$2)")
    .replace(/\s+/g, "")
    .replace(/\*\*/g, "^");
}
function masterRootIndex(token: string): number | null {
  if (token === "√") return 2;
  if (token === "∛") return 3;
  const match = token.match(/^√\[(\d+)\]$/);
  if (!match) return null;
  if (!/^(?:[2-9]\d*|1\d+)$/.test(match[1])) return null;
  const index = Number(match[1]);
  return Number.isSafeInteger(index) && index >= 2 ? index : null;
}
function masterStrict(raw: string): string | null {
  const s = masterCanonicalize(raw.trim().replace(/^[a-zA-Z]\s*=\s*/, ""));
  const match = s.match(/^(\d*)(√(?:\[(\d+)\])?|∛)(\d+)$/);
  if (!match) return null;
  const index = masterRootIndex(match[2]);
  if (index === null) return null;
  const coefficient = match[1] === "" ? 1 : Number(match[1]);
  const radicand = Number(match[4]);
  if (!Number.isSafeInteger(coefficient) || !Number.isSafeInteger(radicand) || radicand < 2) return null;
  for (let factor = 2; Math.pow(factor, index) <= radicand; factor++) {
    if (radicand % Math.pow(factor, index) === 0) return null;
  }
  return `${index}|${coefficient}|${radicand}`;
}
const masterVerdict = (raw: string, key: string) => {
  const a = masterStrict(raw);
  return a !== null && a === masterStrict(key);
};

/** Explicit-product spellings of the key's own simplified form: master's regex
 *  only read the juxtaposed "a√b", so it marked these wrong; HEAD reads them
 *  as the same simplified radical. These are the ONLY intended differences. */
const INTENDED_DIFFERENCES = new Set([
  "a*√b",
  "a·√b",
  "√b*a",
  "√b·a",
  "(a)√b",
  "a√(b)",
  "a*(√b)",
  "decimal coefficient", // "3.0√2": the same whole-number coefficient
]);

describe("roots_simplify_radicals: no-count verdicts match master except written-out products", () => {
  test("differential over generated submissions", () => {
    const differences = new Set<string>();
    let compared = 0;
    for (let seed = 1; seed <= 120; seed++) {
      const gen = generateItem("roots_simplify_radicals", seed)!;
      const key = formatAnswer(gen.answer);
      const m = key.match(/^(\d+)(√(?:\[\d+\])?|∛)(\d+)$/)!;
      const a = Number(m[1]);
      const sym = m[2];
      const b = Number(m[3]);
      const index = sym === "√" ? 2 : sym === "∛" ? 3 : Number(sym.slice(2, -1));
      const servable = buildTemplateServable(makeItemId("roots_simplify_radicals", seed), null, "t")!;
      const candidates: [string, string][] = [
        ["key", key],
        ["spaced", `${a} ${sym}${b}`],
        ["x=key", `x = ${key}`],
        ["a*√b", `${a}*${sym}${b}`],
        ["a·√b", `${a}·${sym}${b}`],
        ["√b*a", `${sym}${b}*${a}`],
        ["√b·a", `${sym}${b}·${a}`],
        ["(a)√b", `(${a})${sym}${b}`],
        ["a√(b)", `${a}${sym}(${b})`],
        ["a*(√b)", `${a}*(${sym}${b})`],
        ["unsimplified", `${sym}${Math.pow(a, index) * b}`],
        ["2a√b/2", `${2 * a}${sym}${b}/2`],
        ["3a√b/3", `${3 * a}${sym}${b}/3`],
        ["key+0", `${key}+0`],
        ["key*1", `${key}*1`],
        ["1*key", `1*${key}`],
        ["wrong coefficient", `${a + 1}${sym}${b}`],
        ["negated", `-${key}`],
        ["split root", `${sym}${Math.pow(a, index)}${sym}${b}`],
        ["decimal coefficient", `${a}.0${sym}${b}`],
      ];
      for (const [shape, raw] of candidates) {
        compared += 1;
        const head = gradeSubmission(servable, { kind: "typed", raw }, PRACTICE_POLICY).correct;
        const master = masterVerdict(raw, key);
        if (head !== master) {
          differences.add(shape);
          // Every difference must be HEAD accepting an equivalent simplified
          // spelling — never HEAD rejecting what master accepted.
          expect(head, `${shape}: ${raw} vs ${key}`).toBe(true);
        }
      }
    }
    expect(compared).toBeGreaterThan(1000);
    for (const shape of differences) expect(INTENDED_DIFFERENCES.has(shape), shape).toBe(true);
    // Pinned so a future change to the list is a decision, not a drift.
    expect([...differences].sort()).toEqual([...INTENDED_DIFFERENCES].sort());
  });
});
