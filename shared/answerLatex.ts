/**
 * Typeset a canonical practice ANSWER string (the contract §1 grammar the
 * clients submit and templates store: `(x+3)/(x-2)`, `log_2(8)`, `3±2i`,
 * `x^(2/3)`, `2√3`, `-1/2`, `3,-2`, `none`) as LaTeX, so a revealed answer or a
 * multiple-choice option reads as math instead of ASCII.
 *
 * Conservative by design: `answerToLatex` returns null for anything that is not
 * cleanly in the grammar (prose, upper-case words, a multi-letter word), and
 * `isTypesetAnswer` additionally says no to a plain number or fraction, which
 * the existing stacked-fraction renderer already draws. Callers fall back to
 * their old rendering on null, so no existing label can be mangled.
 *
 * Also accepts one relation (`=`, `<`, `>`, `<=`, `>=`, `≤`, `≥`, `≠`) so an
 * option such as `y = 2x + 1` typesets too.
 *
 * Imports nothing, so it vendors into the native app as a flat copy.
 */

type Tok =
  | { t: "num"; v: string; ws: boolean }
  | { t: "var"; v: string; ws: boolean }
  | { t: "const"; v: "i" | "e" | "pi"; ws: boolean }
  | { t: "op"; v: "+" | "-" | "*" | "/" | "^" | "±"; ws: boolean }
  | { t: "lp"; ws: boolean }
  | { t: "rp"; ws: boolean }
  | { t: "bar"; ws: boolean }
  | { t: "comma"; ws: boolean }
  | { t: "rel"; v: string; ws: boolean }
  | { t: "root"; n: number; ws: boolean }
  | { t: "fn"; v: "log" | "ln" | "abs" | "sqrt"; ws: boolean }
  | { t: "under"; ws: boolean }
  | { t: "none"; ws: boolean };

type Node =
  | { k: "num"; v: string }
  | { k: "var"; v: string }
  | { k: "const"; v: "i" | "e" | "pi" }
  | { k: "neg"; a: Node }
  | { k: "pm"; a: Node }
  | { k: "bin"; op: "+" | "-" | "±"; a: Node; b: Node }
  | { k: "mul"; a: Node; b: Node }
  | { k: "div"; a: Node; b: Node }
  | { k: "pow"; a: Node; b: Node }
  | { k: "root"; n: number; a: Node }
  | { k: "group"; a: Node }
  | { k: "log"; base: Node | null; a: Node }
  | { k: "ln"; a: Node }
  | { k: "abs"; a: Node }
  | { k: "mixed"; w: string; n: string; d: string }
  | { k: "rel"; op: string; a: Node; b: Node }
  | { k: "list"; items: Node[] }
  | { k: "none" };

const SUPERSCRIPTS: Record<string, string> = {
  "⁰": "0", "¹": "1", "²": "2", "³": "3", "⁴": "4", "⁵": "5", "⁶": "6", "⁷": "7", "⁸": "8", "⁹": "9", "⁻": "-",
};
const SUBSCRIPTS: Record<string, string> = {
  "₀": "0", "₁": "1", "₂": "2", "₃": "3", "₄": "4", "₅": "5", "₆": "6", "₇": "7", "₈": "8", "₉": "9",
};

function normalize(input: string): string {
  return input
    .replace(/[−–]/g, "-")
    .replace(/[×·⋅]/g, "*")
    .replace(/÷/g, "/")
    .replace(/<=/g, "≤")
    .replace(/>=/g, "≥")
    .replace(/!=/g, "≠")
    .replace(/log([₀-₉]+)/g, (_m, sub: string) => `log_${[...sub].map((c) => SUBSCRIPTS[c]).join("")}`)
    .replace(/[⁻⁰¹²³⁴⁵⁶⁷⁸⁹]+/g, (run: string) => {
      const plain = [...run].map((c) => SUPERSCRIPTS[c] ?? "").join("");
      return /^\d+$/.test(plain) ? `^${plain}` : `^(${plain})`;
    });
}

function tokenize(raw: string): Tok[] | null {
  const s = normalize(raw.trim());
  const out: Tok[] = [];
  let i = 0;
  while (i < s.length) {
    let ws = false;
    while (i < s.length && /\s/.test(s[i])) {
      ws = true;
      i += 1;
    }
    if (i >= s.length) break;
    const rest = s.slice(i);
    const num = /^(?:\d+(?:\.\d+)?|\.\d+)/.exec(rest);
    if (num) {
      out.push({ t: "num", v: num[0], ws });
      i += num[0].length;
      continue;
    }
    const word = /^[A-Za-z]+/.exec(rest);
    if (word) {
      const w = word[0];
      i += w.length;
      if (w === "log" || w === "ln" || w === "abs" || w === "sqrt") {
        out.push({ t: "fn", v: w, ws });
        continue;
      }
      if (w === "pi") {
        out.push({ t: "const", v: "pi", ws });
        continue;
      }
      if (w === "none") {
        out.push({ t: "none", ws });
        continue;
      }
      // Single-letter variables only; a longer run is prose, not an answer.
      if (w !== w.toLowerCase() || w.length > 2) return null;
      let first = true;
      for (const c of w) {
        const tokWs = first ? ws : false;
        first = false;
        if (c === "i" || c === "e") out.push({ t: "const", v: c, ws: tokWs });
        else out.push({ t: "var", v: c, ws: tokWs });
      }
      continue;
    }
    const c = s[i];
    i += 1;
    if (c === "π") out.push({ t: "const", v: "pi", ws });
    else if (c === "+" || c === "-" || c === "*" || c === "/" || c === "^" || c === "±") out.push({ t: "op", v: c, ws });
    else if (c === "(") out.push({ t: "lp", ws });
    else if (c === ")") out.push({ t: "rp", ws });
    else if (c === "|") out.push({ t: "bar", ws });
    else if (c === ",") out.push({ t: "comma", ws });
    else if (c === "_") out.push({ t: "under", ws });
    else if (c === "=" || c === "<" || c === ">" || c === "≤" || c === "≥" || c === "≠") out.push({ t: "rel", v: c, ws });
    else if (c === "∛") out.push({ t: "root", n: 3, ws });
    else if (c === "∜") out.push({ t: "root", n: 4, ws });
    else if (c === "√") {
      const idx = /^\[(\d+)\]/.exec(s.slice(i));
      if (idx) {
        i += idx[0].length;
        out.push({ t: "root", n: Number(idx[1]), ws });
      } else {
        out.push({ t: "root", n: 2, ws });
      }
    } else return null;
  }
  return out;
}

class Parser {
  private p = 0;
  private absDepth = 0;
  private readonly toks: Tok[];
  constructor(toks: Tok[]) {
    this.toks = toks;
  }

  private peek(): Tok | undefined {
    return this.toks[this.p];
  }

  private eat(): Tok {
    const tok = this.toks[this.p];
    this.p += 1;
    return tok;
  }

  private expectT(t: Tok["t"]): void {
    if (this.peek()?.t !== t) throw new Error("parse");
    this.p += 1;
  }

  parseTop(): Node {
    if (this.peek()?.t === "none" && this.toks.length === 1) {
      this.p += 1;
      return { k: "none" };
    }
    const items = [this.rel()];
    while (this.peek()?.t === "comma") {
      this.p += 1;
      items.push(this.rel());
    }
    if (this.p !== this.toks.length) throw new Error("parse");
    return items.length === 1 ? items[0] : { k: "list", items };
  }

  private rel(): Node {
    const a = this.expr();
    const tok = this.peek();
    if (tok?.t === "rel") {
      this.p += 1;
      return { k: "rel", op: tok.v, a, b: this.expr() };
    }
    return a;
  }

  private expr(): Node {
    let a: Node;
    const lead = this.peek();
    if (lead?.t === "op" && lead.v === "±") {
      this.p += 1;
      a = { k: "pm", a: this.term() };
    } else if (lead?.t === "op" && lead.v === "+") {
      this.p += 1;
      a = this.term();
    } else {
      a = this.term();
    }
    for (;;) {
      const tok = this.peek();
      if (tok?.t === "op" && (tok.v === "+" || tok.v === "-" || tok.v === "±")) {
        this.p += 1;
        a = { k: "bin", op: tok.v, a, b: this.term() };
      } else {
        return a;
      }
    }
  }

  private startsPrimary(tok: Tok | undefined): boolean {
    if (!tok) return false;
    if (tok.t === "bar") return this.absDepth === 0;
    return tok.t === "num" || tok.t === "var" || tok.t === "const" || tok.t === "lp" || tok.t === "root" || tok.t === "fn";
  }

  private term(): Node {
    let a = this.factor();
    for (;;) {
      const tok = this.peek();
      if (tok?.t === "op" && (tok.v === "*" || tok.v === "/")) {
        this.p += 1;
        const b = this.factor();
        a = tok.v === "*" ? { k: "mul", a, b } : { k: "div", a, b };
        continue;
      }
      if (this.startsPrimary(tok)) {
        // Mixed number: `2 1/2`.
        const t1 = this.toks[this.p + 1];
        const t2 = this.toks[this.p + 2];
        if (
          a.k === "num" &&
          tok!.t === "num" &&
          tok!.ws &&
          t1?.t === "op" &&
          t1.v === "/" &&
          t2?.t === "num" &&
          /^\d+$/.test(a.v) &&
          /^\d+$/.test(tok!.v) &&
          /^\d+$/.test(t2.v)
        ) {
          this.p += 3;
          a = { k: "mixed", w: a.v, n: tok!.v, d: t2.v };
          continue;
        }
        // Implicit multiplication never spans a space: "is 5" is prose.
        if (tok!.ws) throw new Error("parse");
        a = { k: "mul", a, b: this.factor() };
        continue;
      }
      return a;
    }
  }

  private factor(): Node {
    const base = this.unary();
    const tok = this.peek();
    if (tok?.t === "op" && tok.v === "^") {
      this.p += 1;
      return { k: "pow", a: base, b: this.factor() };
    }
    return base;
  }

  private unary(): Node {
    const tok = this.peek();
    if (tok?.t === "op" && tok.v === "-") {
      this.p += 1;
      return { k: "neg", a: this.unary() };
    }
    return this.primary();
  }

  private primary(): Node {
    const tok = this.eat();
    if (!tok) throw new Error("parse");
    switch (tok.t) {
      case "num":
        return { k: "num", v: tok.v };
      case "var":
        return { k: "var", v: tok.v };
      case "const":
        return { k: "const", v: tok.v };
      case "lp": {
        const a = this.expr();
        this.expectT("rp");
        return { k: "group", a };
      }
      case "bar": {
        this.absDepth += 1;
        const a = this.expr();
        this.absDepth -= 1;
        this.expectT("bar");
        return { k: "abs", a };
      }
      case "root":
        return { k: "root", n: tok.n, a: this.unary() };
      case "fn": {
        if (tok.v === "log") {
          let base: Node | null = null;
          if (this.peek()?.t === "under") {
            this.p += 1;
            const b = this.eat();
            if (b?.t === "num") base = { k: "num", v: b.v };
            else if (b?.t === "var") base = { k: "var", v: b.v };
            else if (b?.t === "const") base = { k: "const", v: b.v };
            else if (b?.t === "lp") {
              base = this.expr();
              this.expectT("rp");
            } else throw new Error("parse");
          }
          return { k: "log", base, a: this.callArg() };
        }
        const a = this.callArg();
        if (tok.v === "ln") return { k: "ln", a };
        if (tok.v === "abs") return { k: "abs", a };
        return { k: "root", n: 2, a };
      }
      default:
        throw new Error("parse");
    }
  }

  /** A function's argument: `(expr)`, or a bare atom (`log_2 8`). */
  private callArg(): Node {
    if (this.peek()?.t === "lp") {
      this.p += 1;
      const a = this.expr();
      this.expectT("rp");
      return a;
    }
    return this.unary();
  }
}

function parseAnswer(input: string): Node | null {
  const toks = tokenize(input);
  if (!toks || toks.length === 0) return null;
  try {
    return new Parser(toks).parseTop();
  } catch {
    return null;
  }
}

// ─── LaTeX output ────────────────────────────────────────────────────────────

const REL_LATEX: Record<string, string> = { "=": "=", "<": "<", ">": ">", "≤": "\\le", "≥": "\\ge", "≠": "\\ne" };

/** The inside of a group, without its brackets (a fraction bar, an exponent
 *  box or a root sign already groups it). */
function bare(n: Node): string {
  return n.k === "group" ? render(n.a) : render(n);
}

function isAtomic(n: Node): boolean {
  return n.k === "num" || n.k === "var" || n.k === "const" || n.k === "group" || n.k === "abs";
}

function render(n: Node): string {
  switch (n.k) {
    case "num":
    case "var":
      return n.v;
    case "const":
      return n.v === "pi" ? "\\pi " : n.v;
    case "neg":
      return `{-}${render(n.a)}`;
    case "pm":
      return `{\\pm}${render(n.a)}`;
    case "bin":
      return `${render(n.a)} ${n.op === "±" ? "\\pm" : n.op} ${render(n.b)}`;
    case "mul": {
      const a = render(n.a);
      const b = render(n.b);
      const dot = /^(?:[\d.-]|\{-\})/.test(b) || (n.a.k === "mixed") || (/\d$/.test(a) && n.b.k === "mixed");
      return dot ? `${a} \\cdot ${b}` : `${a}${b}`;
    }
    case "div":
      // −1/2 reads as "negative one half": the sign goes in front of the bar.
      if (n.a.k === "neg") return `{-}\\frac{${bare(n.a.a)}}{${bare(n.b)}}`;
      return `\\frac{${bare(n.a)}}{${bare(n.b)}}`;
    case "pow": {
      const base = isAtomic(n.a) || n.a.k === "ln" ? render(n.a) : `\\left(${render(n.a)}\\right)`;
      return `{${base}}^{${bare(n.b)}}`;
    }
    case "root":
      return n.n === 2 ? `\\sqrt{${bare(n.a)}}` : `\\sqrt[${n.n}]{${bare(n.a)}}`;
    case "group":
      return `\\left(${render(n.a)}\\right)`;
    case "log": {
      const base = n.base ? `_{${bare(n.base)}}` : "";
      return `\\log${base}${callArgLatex(n.a)}`;
    }
    case "ln":
      return `\\ln${callArgLatex(n.a)}`;
    case "abs":
      return `\\left|${render(n.a)}\\right|`;
    case "mixed":
      return `${n.w}\\frac{${n.n}}{${n.d}}`;
    case "rel":
      return `${render(n.a)} ${REL_LATEX[n.op] ?? n.op} ${render(n.b)}`;
    case "list":
      return n.items.map(render).join(",\\; ");
    case "none":
      return "\\text{no solution}";
  }
}

function callArgLatex(a: Node): string {
  if (a.k === "num" || a.k === "var" || a.k === "const") return ` ${render(a)}`;
  return `\\left(${bare(a)}\\right)`;
}

/** The LaTeX for a contract-§1 answer string, or null when it isn't one. */
export function answerToLatex(answer: string): string | null {
  const ast = parseAnswer(answer);
  return ast ? render(ast).replace(/\s+$/, "") : null;
}

function hasAlgebra(n: Node): boolean {
  switch (n.k) {
    case "num":
    case "mixed":
      return false;
    case "var":
    case "const":
    case "pm":
    case "pow":
    case "root":
    case "log":
    case "ln":
    case "abs":
    case "none":
      return true;
    case "neg":
    case "group":
      return hasAlgebra(n.a);
    case "bin":
      return n.op === "±" || hasAlgebra(n.a) || hasAlgebra(n.b);
    case "mul":
    case "div":
    case "rel":
      return hasAlgebra(n.a) || hasAlgebra(n.b);
    case "list":
      return true;
  }
}

/** True when a label is an algebra answer worth typesetting — it parses in the
 *  answer grammar AND has something a plain renderer would draw badly (a
 *  variable, exponent, root, log, i, ±, a list). Plain numbers and fractions say
 *  no: the stacked-fraction renderer already handles them. */
export function isTypesetAnswer(label: string | null | undefined): boolean {
  if (!label) return false;
  const ast = parseAnswer(label);
  return !!ast && hasAlgebra(ast);
}
