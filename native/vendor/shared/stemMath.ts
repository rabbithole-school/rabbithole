/**
 * Typeset math spans inside a practice stem (served-item contract §4).
 *
 * A stem is plain text; an author may mark a span of LaTeX with `\( … \)`
 * (inline, flows with the words) or `\[ … \]` (display, on its own line). The
 * renderers draw the spans with a real math engine (SwiftMath on iPad, KaTeX on
 * web) and everything outside a span exactly as before. Read-aloud and screen
 * readers get `latexToPlainSpeech`, never backslashes.
 *
 * The LaTeX subset: \frac, ^, _, \sqrt, \sqrt[n], \log_, \ln, \cdot, \times,
 * \pm, \le \ge \ne, \infty, \sum_{}^{}, \left( \right), \lvert \rvert, \pi,
 * \begin{cases}…\end{cases}, \text{}.
 *
 * Imports nothing, so it vendors into the native app as a flat copy.
 */

export type StemMathSegment =
  | { kind: "text"; text: string }
  | { kind: "math"; latex: string; display: boolean };

const SPAN_RE = /\\\(([\s\S]*?)\\\)|\\\[([\s\S]*?)\\\]/g;

/** True when the text holds at least one `\( … \)` or `\[ … \]` span. Cheap
 *  enough to gate every stem render with. */
export function hasStemMath(input: string | null | undefined): boolean {
  if (!input || (input.indexOf("\\(") === -1 && input.indexOf("\\[") === -1)) return false;
  return splitStemMath(input).some((s) => s.kind === "math");
}

/** Split text into prose and math spans, in order. An unterminated `\(` stays
 *  literal text. Empty spans are dropped. */
export function splitStemMath(input: string): StemMathSegment[] {
  const out: StemMathSegment[] = [];
  let last = 0;
  SPAN_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = SPAN_RE.exec(input))) {
    const raw = m[2] ?? m[1];
    // A cases/array block is display-size whatever its delimiters: it takes its
    // own centred line, with the sentence text above and below it.
    const display = m[2] != null || /\\begin\{/.test(raw);
    const latex = raw.trim();
    if (m.index > last) out.push({ kind: "text", text: input.slice(last, m.index) });
    if (latex) out.push({ kind: "math", latex, display });
    last = SPAN_RE.lastIndex;
  }
  if (last < input.length) out.push({ kind: "text", text: input.slice(last) });
  return out;
}

// A sign that opens a formula, or follows a relation, an opening delimiter, a
// comma, an alignment `&`, a row break or another operator: `-3`, `x = -2`,
// `(-1)`, `3, -2`, `3 \pm -1`. TeX would demote that binary operator to an
// ordinary symbol; SwiftMath does not, and asserts on the invalid spacing
// (device crash, 2026-11). Bracing it (`{-}3`) makes it an ordinary atom on
// every renderer, with the tight spacing a sign should have.
const UNARY_SIGN =
  /(^|[({[=,<>&]|\\\\|\\begin\{[a-z*]+\}|\\(?:le|ge|ne|leq|geq|neq|lt|gt|pm|mp|cdot|times|lvert|left[({[|.])(?![a-zA-Z])|[-+])(\s*)(-|\+|\\pm(?![a-zA-Z])|\\mp(?![a-zA-Z]))/g;

/** Brace every sign that has no left operand (see UNARY_SIGN). */
export function braceUnarySigns(latex: string): string {
  return latex.replace(UNARY_SIGN, (_m, before: string, space: string, sign: string) => `${before}${space}{${sign}}`);
}

/**
 * The LaTeX a renderer should draw for one stem/answer span: unary signs
 * braced, and an INLINE span set in display style, so a fraction reads at full
 * size beside the words instead of shrunk to text style (exponents and
 * subscripts keep their usual size). SwiftMath has no `\dfrac`, but both it and
 * KaTeX honour `\displaystyle`.
 */
export function renderableMathLatex(latex: string, display: boolean): string {
  const braced = braceUnarySigns(latex);
  return display ? braced : `\\displaystyle ${braced}`;
}

/** Speak a stem: prose through `speakText`, each math span as plain words. */
export function stemMathToSpeech(input: string, speakText: (text: string) => string): string {
  return splitStemMath(input)
    .map((s) => (s.kind === "text" ? speakText(s.text) : ` ${latexToPlainSpeech(s.latex)} `))
    .join("")
    .replace(/\s+/g, " ")
    .trim();
}

// ─── LaTeX → plain words ─────────────────────────────────────────────────────

const WORD_COMMANDS: Record<string, string> = {
  cdot: "times",
  times: "times",
  div: "divided by",
  pm: "plus or minus",
  mp: "minus or plus",
  le: "is less than or equal to",
  leq: "is less than or equal to",
  ge: "is greater than or equal to",
  geq: "is greater than or equal to",
  ne: "is not equal to",
  neq: "is not equal to",
  lt: "is less than",
  gt: "is greater than",
  infty: "infinity",
  ldots: "and so on",
  cdots: "and so on",
  pi: "pi",
  theta: "theta",
  alpha: "alpha",
  beta: "beta",
  approx: "is about",
  to: "to",
  in: "in",
  cup: "union",
};

const CHAR_WORDS: Record<string, string> = {
  "=": "equals",
  "+": "plus",
  "<": "is less than",
  ">": "is greater than",
  "≤": "is less than or equal to",
  "≥": "is greater than or equal to",
  "≠": "is not equal to",
  "±": "plus or minus",
  "·": "times",
  "×": "times",
  "π": "pi",
  "∞": "infinity",
};

function rootName(index: string): string {
  if (index === "2" || index === "") return "the square root of";
  if (index === "3") return "the cube root of";
  const suffix = /1$/.test(index) && index !== "11" ? "st" : /2$/.test(index) && index !== "12" ? "nd" : /3$/.test(index) && index !== "13" ? "rd" : "th";
  return /^\d+$/.test(index) ? `the ${index}${suffix} root of` : `the ${index} root of`;
}

function exponentWords(exp: string): string {
  const e = exp.trim();
  if (e === "2") return "squared";
  if (e === "3") return "cubed";
  return `to the ${e}`;
}

class LatexReader {
  private i = 0;
  private readonly s: string;
  constructor(s: string) {
    this.s = s;
  }

  done(): boolean {
    return this.i >= this.s.length;
  }

  private peek(): string {
    return this.s[this.i] ?? "";
  }

  private skipSpace(): void {
    while (/\s/.test(this.peek())) this.i += 1;
  }

  /** A `{…}` group or a single token, spoken. */
  private arg(): string {
    this.skipSpace();
    if (this.peek() === "{") {
      this.i += 1;
      const inner = this.until("}");
      this.i += 1;
      return inner;
    }
    return this.atom();
  }

  /** An optional `[…]` argument's raw text. */
  private optional(): string | null {
    this.skipSpace();
    if (this.peek() !== "[") return null;
    const end = this.s.indexOf("]", this.i);
    if (end === -1) return null;
    const raw = this.s.slice(this.i + 1, end);
    this.i = end + 1;
    return new LatexReader(raw).all();
  }

  private command(): string {
    let name = "";
    while (/[A-Za-z]/.test(this.peek())) {
      name += this.peek();
      this.i += 1;
    }
    if (!name) {
      // `\,` `\;` `\\` `\{` and friends.
      const ch = this.peek();
      this.i += 1;
      if (ch === "\\") return " ; ";
      if (ch === "{" || ch === "}") return "";
      if (ch === "|") return " the absolute value of ";
      return " ";
    }
    switch (name) {
      case "frac":
      case "dfrac":
      case "tfrac": {
        const num = this.arg();
        const den = this.arg();
        return ` ${num} over ${den} `;
      }
      case "sqrt": {
        const index = this.optional();
        return ` ${rootName(index ?? "")} ${this.arg()} `;
      }
      case "log": {
        this.skipSpace();
        if (this.peek() === "_") {
          this.i += 1;
          return ` log base ${this.arg()} of `;
        }
        return " log of ";
      }
      case "ln":
        return " the natural log of ";
      case "sum": {
        let from = "";
        let to = "";
        for (let k = 0; k < 2; k++) {
          this.skipSpace();
          if (this.peek() === "_") {
            this.i += 1;
            from = this.arg();
          } else if (this.peek() === "^") {
            this.i += 1;
            to = this.arg();
          }
        }
        return ` the sum${from ? ` from ${from}` : ""}${to ? ` to ${to}` : ""} of `;
      }
      case "left":
      case "right":
      case "big":
      case "Big": {
        this.skipSpace();
        const delim = this.peek();
        if (delim === "\\") {
          this.i += 1;
          let inner = "";
          while (/[A-Za-z]/.test(this.peek())) {
            inner += this.peek();
            this.i += 1;
          }
          if (inner === "lvert" || inner === "vert") return name === "right" ? " " : " the absolute value of ";
          return " ";
        }
        this.i += 1;
        if (delim === "|") return name === "right" ? " " : " the absolute value of ";
        return " ";
      }
      case "lvert":
        return " the absolute value of ";
      case "rvert":
        return " ";
      case "text":
      case "mathrm":
      case "operatorname": {
        this.skipSpace();
        if (this.peek() !== "{") return "";
        const end = this.s.indexOf("}", this.i);
        const raw = end === -1 ? this.s.slice(this.i + 1) : this.s.slice(this.i + 1, end);
        this.i = end === -1 ? this.s.length : end + 1;
        return ` ${raw} `;
      }
      case "begin": {
        const env = this.arg().trim();
        return env === "cases" ? " where " : " ";
      }
      case "end":
        this.arg();
        return " ";
      case "quad":
      case "qquad":
        return " ";
      default:
        return WORD_COMMANDS[name] ? ` ${WORD_COMMANDS[name]} ` : ` ${name} `;
    }
  }

  private atom(): string {
    this.skipSpace();
    const ch = this.peek();
    if (!ch) return "";
    if (ch === "\\") {
      this.i += 1;
      return this.command();
    }
    if (ch === "{") return this.arg();
    this.i += 1;
    return ch;
  }

  /** Read until `stop` (exclusive) or the end, spoken. */
  until(stop: string | null): string {
    const parts: string[] = [];
    let spokenAny = false;
    while (!this.done() && this.peek() !== stop) {
      const ch = this.peek();
      if (/\s/.test(ch)) {
        this.i += 1;
        parts.push(" ");
        continue;
      }
      if (ch === "^") {
        this.i += 1;
        parts.push(` ${exponentWords(this.arg())} `);
        continue;
      }
      if (ch === "_") {
        this.i += 1;
        parts.push(` sub ${this.arg()} `);
        continue;
      }
      if (ch === "&") {
        this.i += 1;
        parts.push(" ");
        continue;
      }
      if (ch === "-") {
        this.i += 1;
        parts.push(spokenAny && !/(?:plus|minus|times|equals|over|of|than|to|negative|where|;)\s*$/.test(parts.join("").trim()) ? " minus " : " negative ");
        spokenAny = true;
        continue;
      }
      if (ch === "(" || ch === ")" || ch === "[" || ch === "]") {
        this.i += 1;
        parts.push(" ");
        continue;
      }
      if (ch === "|") {
        this.i += 1;
        parts.push(" ");
        continue;
      }
      if (CHAR_WORDS[ch]) {
        this.i += 1;
        parts.push(` ${CHAR_WORDS[ch]} `);
        spokenAny = true;
        continue;
      }
      const piece = this.atom();
      if (piece.trim()) spokenAny = true;
      parts.push(piece);
    }
    return parts.join("").replace(/\s+/g, " ").trim();
  }

  all(): string {
    return this.until(null);
  }
}

/** A plain-language reading of a LaTeX span, for read-aloud and screen readers:
 *  `\frac{x+1}{x-2}` → "x plus 1 over x minus 2", `\log_{2} 8` → "log base 2 of 8". */
export function latexToPlainSpeech(latex: string): string {
  return new LatexReader(latex).all().replace(/\s+/g, " ").trim();
}
