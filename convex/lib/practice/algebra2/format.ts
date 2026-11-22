/**
 * Notation helpers shared by the Algebra 2 template families.
 *
 * Two outputs for the same math, because they have different readers:
 *  - `*Tex` builds LaTeX for a stem span (`\( … \)`, typeset on both clients).
 *  - `*Ans` builds the one-line answer grammar the grader parses
 *    (convex/lib/practice/answers.ts), which is also what a reveal typesets.
 *
 * A polynomial is its coefficient list, highest power first: [1, -2, 0, 5] is
 * x³ − 2x² + 5.
 */

/** Wrap LaTeX as an inline stem span. */
export function tex(latex: string): string {
  return `\\(${latex}\\)`;
}

function termParts(coefficient: number, power: number, variable: string) {
  const magnitude = Math.abs(coefficient);
  const showCoefficient = magnitude !== 1 || power === 0;
  return { magnitude, showCoefficient, hasVariable: power > 0, variable };
}

function polyString(
  coefficients: readonly number[],
  variable: string,
  power: (variable: string, exponent: number) => string,
  minus: string,
): string {
  const degree = coefficients.length - 1;
  let out = "";
  coefficients.forEach((coefficient, index) => {
    if (coefficient === 0) return;
    const exponent = degree - index;
    const { magnitude, showCoefficient, hasVariable } = termParts(coefficient, exponent, variable);
    const body =
      (showCoefficient ? String(magnitude) : "") +
      (hasVariable ? (exponent === 1 ? variable : power(variable, exponent)) : "");
    if (out === "") out = (coefficient < 0 ? minus : "") + body;
    else out += (coefficient < 0 ? ` ${minus} ` : " + ") + body;
  });
  return out === "" ? "0" : out;
}

/** LaTeX for a polynomial, e.g. `x^{3} - 2x^{2} + 5`. */
export function polyTex(coefficients: readonly number[], variable = "x"): string {
  return polyString(coefficients, variable, (v, e) => `${v}^{${e}}`, "-");
}

/** Answer-grammar string for a polynomial, e.g. `x^3-2x^2+5`. */
export function polyAns(coefficients: readonly number[], variable = "x"): string {
  return polyString(coefficients, variable, (v, e) => `${v}^${e}`, "-").replace(/ /g, "");
}

/** The linear factor with zero `root`: (x − 3), (x + 2), or bare x for 0. */
export function linearFactor(root: number, variable = "x"): string {
  if (root === 0) return variable;
  return root > 0 ? `(${variable}-${root})` : `(${variable}+${-root})`;
}

/** A product of linear factors from its zeros, repeated zeros as powers:
 *  [2, 2, -1] → `(x-2)^2(x+1)`. Reads the same as LaTeX and as answer grammar
 *  once exponents are braced, so `factoredTex` only rewrites the powers. */
export function factoredAns(roots: readonly number[], leading = 1, variable = "x"): string {
  const counts = new Map<number, number>();
  for (const root of roots) counts.set(root, (counts.get(root) ?? 0) + 1);
  const factors = [...counts.entries()].map(([root, count]) =>
    count === 1 ? linearFactor(root, variable) : `${linearFactor(root, variable)}^${count}`,
  );
  const lead = leading === 1 ? "" : leading === -1 ? "-" : String(leading);
  return lead + factors.join("");
}

export function factoredTex(roots: readonly number[], leading = 1, variable = "x"): string {
  return factoredAns(roots, leading, variable).replace(/\^(\d+)/g, "^{$1}");
}

/** Expand a product of linear factors into coefficients, highest power first. */
export function expandRoots(roots: readonly number[], leading = 1): number[] {
  let coefficients = [leading];
  for (const root of roots) {
    const next = new Array<number>(coefficients.length + 1).fill(0);
    coefficients.forEach((coefficient, index) => {
      next[index] += coefficient;
      next[index + 1] -= coefficient * root;
    });
    coefficients = next;
  }
  return coefficients;
}

/** Evaluate a polynomial at x (Horner). */
export function evalPoly(coefficients: readonly number[], x: number): number {
  return coefficients.reduce((acc, coefficient) => acc * x + coefficient, 0);
}

/** LaTeX fraction; pass strings so either part can itself be LaTeX. */
export function fracTex(numerator: string | number, denominator: string | number): string {
  return `\\frac{${numerator}}{${denominator}}`;
}

/** A complex number a + bi in the answer grammar's standard form: `3-2i`, `-i`, `4`. */
export function complexAns(re: number, im: number): string {
  if (im === 0) return String(re);
  const imaginary = (Math.abs(im) === 1 ? "" : String(Math.abs(im))) + "i";
  if (re === 0) return (im < 0 ? "-" : "") + imaginary;
  return `${re}${im < 0 ? "-" : "+"}${imaginary}`;
}

/** LaTeX for a + bi (identical glyphs; kept separate so a stem reads `3 - 2i`). */
export function complexTex(re: number, im: number): string {
  return complexAns(re, im).replace(/([+-])(?=.)/g, (sign, _s, offset: number) =>
    offset === 0 ? sign : ` ${sign} `,
  );
}
