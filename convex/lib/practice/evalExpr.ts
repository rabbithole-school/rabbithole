/**
 * A dependency-free, SAFE arithmetic evaluator. Convex actions run Node, not
 * Python — so the Spike-A verification gate ("execute the solution, check it
 * equals the stated answer") can't run sympy. Instead, an LLM that generates a
 * word problem also emits a restricted ARITHMETIC EXPRESSION that computes the
 * answer; we evaluate it here with a tiny recursive-descent parser that accepts
 * ONLY numbers, + - * / × ÷, and parentheses. No `eval`, no identifiers, no code
 * execution — anything outside the grammar returns null (rejected).
 *
 * Pure module. `/` is real division, so a fraction like "3/4" evaluates to 0.75.
 */

type Tok = { t: "num"; v: number } | { t: "op"; v: string } | { t: "("; } | { t: ")"; };

function tokenize(input: string): Tok[] | null {
  const s = input.replace(/×/g, "*").replace(/÷/g, "/");
  const toks: Tok[] = [];
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === " " || c === "\t" || c === "\n") {
      i++;
      continue;
    }
    if (c >= "0" && c <= "9") {
      let j = i + 1;
      while (j < s.length && ((s[j] >= "0" && s[j] <= "9") || s[j] === ".")) j++;
      const num = Number(s.slice(i, j));
      if (!Number.isFinite(num)) return null;
      toks.push({ t: "num", v: num });
      i = j;
    } else if (c === "+" || c === "-" || c === "*" || c === "/") {
      toks.push({ t: "op", v: c });
      i++;
    } else if (c === "(") {
      toks.push({ t: "(" });
      i++;
    } else if (c === ")") {
      toks.push({ t: ")" });
      i++;
    } else {
      return null; // any other character → reject
    }
  }
  return toks;
}

/**
 * Evaluate a restricted arithmetic expression. Returns the numeric value, or
 * null if it doesn't parse cleanly under the safe grammar (or divides by zero).
 */
export function evalArithmetic(input: string): number | null {
  const toks = tokenize(input);
  if (!toks || toks.length === 0) return null;
  let pos = 0;

  const peek = () => toks[pos];
  const eat = () => toks[pos++];

  // expr = term (('+'|'-') term)*
  function expr(): number | null {
    let left = term();
    if (left === null) return null;
    while (peek() && peek().t === "op" && ((peek() as { v: string }).v === "+" || (peek() as { v: string }).v === "-")) {
      const op = (eat() as { v: string }).v;
      const right = term();
      if (right === null) return null;
      left = op === "+" ? left + right : left - right;
    }
    return left;
  }
  // term = factor (('*'|'/') factor)*
  function term(): number | null {
    let left = factor();
    if (left === null) return null;
    while (peek() && peek().t === "op" && ((peek() as { v: string }).v === "*" || (peek() as { v: string }).v === "/")) {
      const op = (eat() as { v: string }).v;
      const right = factor();
      if (right === null) return null;
      if (op === "/") {
        if (right === 0) return null;
        left = left / right;
      } else {
        left = left * right;
      }
    }
    return left;
  }
  // factor = number | '(' expr ')' | ('+'|'-') factor
  function factor(): number | null {
    const tk = peek();
    if (!tk) return null;
    if (tk.t === "num") {
      eat();
      return tk.v;
    }
    if (tk.t === "op" && (tk.v === "+" || tk.v === "-")) {
      eat();
      const f = factor();
      if (f === null) return null;
      return tk.v === "-" ? -f : f;
    }
    if (tk.t === "(") {
      eat();
      const e = expr();
      if (e === null) return null;
      if (!peek() || peek().t !== ")") return null;
      eat();
      return e;
    }
    return null;
  }

  const result = expr();
  if (result === null || pos !== toks.length) return null; // trailing garbage → reject
  return result;
}
