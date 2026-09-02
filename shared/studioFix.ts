/**
 * The Studio's DETERMINISTIC generous fixer — stage 1 of a two-stage pipeline.
 * Stage 2 (elsewhere) is a Haiku model pass that only runs when THIS pass
 * still leaves a program unparseable. Stage 1 must carry the overwhelming
 * majority of cases: it runs INSIDE the WebView sandbox with zero latency, so
 * every Run press feels instant and works offline. A model round-trip on
 * every keystroke would kill the tactile feel that is the entire point of
 * the surface.
 *
 * Two entry points, for two different moments:
 *
 * - `fixSource` — called BEFORE running, on a program that fails to PARSE.
 * - `fixRuntimeSource` — called AFTER running, on a program that parsed fine
 *   but still went wrong (it threw, or silently moved nothing). The most
 *   common first-day mistakes — a mis-cased call, a bare command with no
 *   parentheses — are syntactically valid JavaScript, so `fixSource` never
 *   even sees them; see `fixRuntimeSource`'s own doc comment for the split.
 *
 * ## The one governing rule
 *
 * Fix things that are noise; never fix things that are the lesson. A typo
 * teaches nothing and unblocks everything — repair it silently-but-visibly.
 * A wrong ALGORITHM is the scholar's to work out; repairing it steals the
 * lesson and makes the machine look arbitrary. When in doubt, do not fix.
 * See the category list on each pass below for the reasoning behind it.
 *
 * ## Why this can only ever help, never hurt
 *
 * A program that already WORKS is returned completely untouched by either
 * entry point: `fixSource` short-circuits immediately on anything that
 * parses, and `fixRuntimeSource` only ever rewrites a name the scholar did
 * NOT already declare themselves, so it can't touch correct code either —
 * see its own doc comment. Both check the repaired candidate against the
 * same honest oracle before ever handing it back — if the whole batch of
 * repairs still doesn't parse, both return the ORIGINAL source with
 * `ok: false`, never a half-mangled attempt. That is a deliberately simple
 * "all or nothing" verification, not per-repair backtracking: a lot of small
 * heuristic rewrites (case, punctuation, missing parens…) chase one shared
 * goal — does it parse now — and stage 2 exists precisely for the cases
 * where stage 1's best combined effort still isn't enough.
 *
 * ## Why a hand-written scanner instead of a real tokenizer
 *
 * The single most likely way to embarrass this fixer is rewriting text INSIDE
 * a string or comment (`"say forward"` must never become `"say Forward"`'s
 * opposite mistake). `scanProtected` below is a small state machine that
 * tracks single/double-quoted strings, template literals (including `${…}`
 * interpolation), line comments and block comments, and marks every character
 * inside one of those as protected. Every fix pass below refuses to touch a
 * protected character. It is not a full parser (regex literals, for
 * instance, are not specially recognized — a beginner Studio program never
 * has a reason to write one, and if it ever does, the worst case is a
 * conservative under-fix, never a corrupted string).
 *
 * Sync changes into `native/vendor/shared/` with `native/scripts/sync-vendor.js`.
 */

import { STUDIO_VOCABULARY, type StudioFix, type StudioFixResult } from "./studioContract";

// ── The parse oracle ─────────────────────────────────────────────────────────

/**
 * The runtime runs a scholar's program via `new Function('"use strict";\n' +
 * source)` (see `studio/src/runtime.ts`) — so that is the honest check for
 * "does this parse", not a hand-rolled grammar. This never EXECUTES the
 * program (constructing a `Function` only compiles it), so it is safe to run
 * on arbitrary, possibly-buggy scholar code, including an infinite
 * `while (true)` — that is a real bug with a real lesson, not this fixer's
 * job (the runtime's own step cap reports it honestly).
 */
function tryParse(source: string): boolean {
  try {
    new Function('"use strict";\n' + source);
    return true;
  } catch {
    return false;
  }
}

// ── Protecting strings and comments ──────────────────────────────────────────

type ScanState = "code" | "line-comment" | "block-comment" | "sq" | "dq" | "template";

/**
 * One boolean per character of `source`: true when that character is inside a
 * string, template literal, or comment, and therefore off-limits to every fix
 * below. `${…}` interpolation inside a template literal is treated as CODE
 * (a scholar could write `` `${Forward()}` `` — unlikely, but correct), by
 * tracking brace depth so the interpolation's own `}` is recognized even when
 * it contains nested `{ }` (e.g. an object literal).
 */
function scanProtected(source: string): boolean[] {
  const isProtected = new Array<boolean>(source.length).fill(false);
  let state: ScanState = "code";
  // Brace-depth counters for each currently-open `${ … }` interpolation, so a
  // nested `{`/`}` (e.g. an object literal argument) doesn't close it early.
  const interpDepth: number[] = [];

  let i = 0;
  while (i < source.length) {
    const c = source[i];
    const c2 = i + 1 < source.length ? source[i + 1] : "";

    if (state === "code") {
      if (c === "/" && c2 === "/") {
        isProtected[i] = true;
        isProtected[i + 1] = true;
        state = "line-comment";
        i += 2;
        continue;
      }
      if (c === "/" && c2 === "*") {
        isProtected[i] = true;
        isProtected[i + 1] = true;
        state = "block-comment";
        i += 2;
        continue;
      }
      if (c === '"') {
        isProtected[i] = true;
        state = "dq";
        i++;
        continue;
      }
      if (c === "'") {
        isProtected[i] = true;
        state = "sq";
        i++;
        continue;
      }
      if (c === "`") {
        isProtected[i] = true;
        state = "template";
        i++;
        continue;
      }
      if (interpDepth.length > 0) {
        if (c === "{") {
          interpDepth[interpDepth.length - 1]++;
        } else if (c === "}") {
          if (interpDepth[interpDepth.length - 1] === 0) {
            interpDepth.pop();
            isProtected[i] = true;
            state = "template";
            i++;
            continue;
          }
          interpDepth[interpDepth.length - 1]--;
        }
      }
      i++;
      continue;
    }

    if (state === "line-comment") {
      isProtected[i] = true;
      if (c === "\n") state = "code";
      i++;
      continue;
    }

    if (state === "block-comment") {
      isProtected[i] = true;
      if (c === "*" && c2 === "/") {
        isProtected[i + 1] = true;
        state = "code";
        i += 2;
        continue;
      }
      i++;
      continue;
    }

    if (state === "sq" || state === "dq") {
      isProtected[i] = true;
      if (c === "\\") {
        if (i + 1 < source.length) isProtected[i + 1] = true;
        i += 2;
        continue;
      }
      if (c === "\n") {
        // Unterminated string — bail back to code rather than protecting the
        // rest of the file forever. The program was already broken anyway.
        state = "code";
        i++;
        continue;
      }
      if ((state === "sq" && c === "'") || (state === "dq" && c === '"')) {
        state = "code";
      }
      i++;
      continue;
    }

    // state === "template"
    isProtected[i] = true;
    if (c === "\\") {
      if (i + 1 < source.length) isProtected[i + 1] = true;
      i += 2;
      continue;
    }
    if (c === "`") {
      state = "code";
      i++;
      continue;
    }
    if (c === "$" && c2 === "{") {
      isProtected[i + 1] = true;
      interpDepth.push(0);
      state = "code";
      i += 2;
      continue;
    }
    i++;
  }

  return isProtected;
}

function isRangeCode(mask: boolean[], start: number, end: number): boolean {
  for (let i = start; i < end; i++) {
    if (mask[i]) return false;
  }
  return true;
}

// ── Carrying original line numbers through repeated edits ──────────────────

/** `origLine[i]` is the 1-based ORIGINAL line the character at `source[i]` came from. */
function computeOrigLine(source: string): number[] {
  const origLine = new Array<number>(source.length);
  let line = 1;
  for (let i = 0; i < source.length; i++) {
    origLine[i] = line;
    if (source[i] === "\n") line++;
  }
  return origLine;
}

interface Working {
  text: string;
  /** Same length as `text`; the ORIGINAL 1-based line each character traces to. */
  origLine: number[];
}

function initWorking(source: string): Working {
  return { text: source, origLine: computeOrigLine(source) };
}

/** Replace `text[start, end)` with `replacement`, keeping `origLine` aligned. */
function spliceWorking(w: Working, start: number, end: number, replacement: string): Working {
  const contextLine = w.origLine[start] ?? w.origLine[w.origLine.length - 1] ?? 1;
  const insertedLines = new Array<number>(replacement.length).fill(contextLine);
  return {
    text: w.text.slice(0, start) + replacement + w.text.slice(end),
    origLine: [...w.origLine.slice(0, start), ...insertedLines, ...w.origLine.slice(end)],
  };
}

interface Edit {
  start: number;
  end: number;
  replacement: string;
  was: string;
  now: string;
  note: string;
}

/** Applies non-overlapping edits (by original-snapshot position) back-to-front, so earlier offsets never shift under later ones. */
function applyEdits(w: Working, edits: Edit[]): { w: Working; fixes: StudioFix[] } {
  const sorted = [...edits].sort((a, b) => a.start - b.start);
  const fixes: StudioFix[] = [];
  let working = w;
  for (let i = sorted.length - 1; i >= 0; i--) {
    const e = sorted[i];
    const line = working.origLine[e.start] ?? working.origLine[working.origLine.length - 1] ?? 1;
    fixes.unshift({ line, was: e.was, now: e.now, note: e.note });
    working = spliceWorking(working, e.start, e.end, e.replacement);
  }
  return { w: working, fixes };
}

interface LineSpan {
  /** Index of the first character of the line. */
  start: number;
  /** Index just past the last non-newline character. */
  end: number;
  /** Index just past the line's own trailing `\n`, if any (else equal to `end`). */
  endWithBreak: number;
}

function splitLines(text: string): LineSpan[] {
  const spans: LineSpan[] = [];
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "\n") {
      spans.push({ start, end: i, endWithBreak: i + 1 });
      start = i + 1;
    }
  }
  spans.push({ start, end: text.length, endWithBreak: text.length });
  return spans;
}

// ── Pass 1: typographic substitutions ────────────────────────────────────────

/**
 * The iOS keyboard's smart-punctuation quietly swaps `'`/`"` for curly quotes
 * and `-` for an en/em dash AS a scholar types — including while typing a
 * string literal, which is exactly the case that matters: a kid who typed
 * `pen("red")` may have `pen(“red”)` on screen and never notice, because it
 * LOOKS identical at a glance. Since those curly quotes never actually opened
 * a real string (our scanner only recognizes straight quotes as delimiters),
 * they read as plain code here and are safe to rewrite; a curly quote that
 * genuinely appears inside an already-straight-quoted string (someone quoting
 * dialogue on purpose) is protected and left alone.
 */
const TYPO_MAP: Record<string, string> = {
  "\u201C": '"', // “
  "\u201D": '"', // ”
  "\u2018": "'", // ‘
  "\u2019": "'", // ’
  "\u2013": "-", // – en dash
  "\u2014": "-", // — em dash
};
const TYPO_RE = /[\u201C\u201D\u2018\u2019\u2013\u2014]/g;

function fixTypography(w: Working): { w: Working; fixes: StudioFix[] } {
  const mask = scanProtected(w.text);
  const edits: Edit[] = [];
  for (const line of splitLines(w.text)) {
    let first = -1;
    let last = -1;
    for (let i = line.start; i < line.end; i++) {
      if (mask[i]) continue;
      if (TYPO_RE.test(w.text[i])) {
        TYPO_RE.lastIndex = 0;
        if (first === -1) first = i;
        last = i;
      }
    }
    if (first === -1) continue;
    const was = w.text.slice(first, last + 1);
    let now = "";
    for (let i = first; i <= last; i++) {
      const c = w.text[i];
      now += !mask[i] && TYPO_MAP[c] ? TYPO_MAP[c] : c;
    }
    edits.push({
      start: first,
      end: last + 1,
      replacement: now,
      was,
      now,
      note: "Your keyboard turned a straight quote or dash into a curly one, so I straightened it back out.",
    });
  }
  return applyEdits(w, edits);
}

// ── Pass 2: other-language leftovers ─────────────────────────────────────────

/**
 * Habits carried over from Python (`elif`, lowercase `and`/`or`/`not`) and
 * from Scratch/BASIC/Ruby-shaped pseudocode (a trailing `end`, `endif`,
 * `then`, or `do` on its own line, standing in for a block that JavaScript
 * closes with `{ }` instead). This only ever runs on a program that already
 * fails to parse — a legitimate `do` line in a real `do { … } while (…)`
 * loop belongs to a program that already parses fine and never reaches here.
 */
const WORD_SWAP_RE = /\b(elif|and|or|not)\b/gi;
const STANDALONE_LEFTOVER_RE = /^(end|endif|then|do)$/i;

function fixOtherLanguageLeftovers(w: Working): { w: Working; fixes: StudioFix[] } {
  let working = w;
  const fixes: StudioFix[] = [];

  {
    const mask = scanProtected(working.text);
    const edits: Edit[] = [];
    let m: RegExpExecArray | null;
    WORD_SWAP_RE.lastIndex = 0;
    while ((m = WORD_SWAP_RE.exec(working.text))) {
      const start = m.index;
      let end = start + m[0].length;
      if (!isRangeCode(mask, start, end)) continue;
      const was = m[0];
      const lower = was.toLowerCase();
      const now = lower === "elif" ? "else if" : lower === "and" ? "&&" : lower === "or" ? "||" : "!";
      if (lower === "not" && working.text[end] === " ") {
        // `not` is a prefix operator like `!x`, not a word with spaces on
        // both sides like `&&`/`||` — swallow the one space that separated
        // it from its operand so the replacement reads naturally.
        end += 1;
      }
      const note =
        lower === "elif"
          ? "Other languages write `elif`; JavaScript spells it `else if`, so I changed it."
          : `Other languages write \`${lower}\`; JavaScript spells that \`${now}\`, so I changed it.`;
      edits.push({ start, end, replacement: now, was, now, note });
    }
    const applied = applyEdits(working, edits);
    working = applied.w;
    fixes.push(...applied.fixes);
  }

  {
    const mask = scanProtected(working.text);
    const edits: Edit[] = [];
    for (const line of splitLines(working.text)) {
      if (!isRangeCode(mask, line.start, line.end)) continue;
      const raw = working.text.slice(line.start, line.end);
      const trimmed = raw.trim();
      if (!STANDALONE_LEFTOVER_RE.test(trimmed)) continue;
      edits.push({
        start: line.start,
        end: line.endWithBreak,
        replacement: "",
        was: trimmed,
        now: "",
        note: `"${trimmed}" isn't how JavaScript ends a block — curly braces \`{ }\` do that — so I removed this line.`,
      });
    }
    const applied = applyEdits(working, edits);
    working = applied.w;
    fixes.push(...applied.fixes);
  }

  return { w: working, fixes };
}

// ── Pass 3: wrong case on a known word ───────────────────────────────────────

/**
 * The control-flow words and command vocabulary this curriculum actually
 * teaches. Deliberately a SHORT, curated list rather than every ECMAScript
 * reserved word: a beginner writing straight-line/loop/conditional/function
 * code plausibly mis-cases `while`/`if`/`forward`, but a short capitalized
 * word like `In` or `Of` is far more likely to be a scholar's own identifier
 * than a mis-cased `in`/`of` — and rewriting an identifier the scholar chose
 * is exactly the "steals the lesson" mistake this fixer must never make.
 */
const CASE_FIX_KEYWORDS = [
  "if",
  "else",
  "while",
  "for",
  "function",
  "return",
  "let",
  "const",
  "var",
  "true",
  "false",
  "null",
  "break",
  "continue",
];

function buildCanonicalByLower(): Map<string, string> {
  const map = new Map<string, string>();
  for (const w of CASE_FIX_KEYWORDS) map.set(w.toLowerCase(), w);
  for (const w of STUDIO_VOCABULARY) map.set(w.toLowerCase(), w);
  return map;
}
const CANONICAL_BY_LOWER = buildCanonicalByLower();
const IDENTIFIER_RE = /\b[A-Za-z_$][\w$]*\b/g;

/** No names to protect — the default for `fixSource`, where nothing has been shadowed yet. */
const NO_DECLARED: ReadonlySet<string> = new Set();

/**
 * @param declared Names the SCHOLAR bound themselves (see
 *   `collectDeclaredNames`). A token that exactly matches one of these is
 *   left alone even if its lowercase form matches a keyword or vocabulary
 *   word — `function Forward() {}` makes `Forward` the scholar's own name,
 *   not a mis-cased `forward`, and rewriting it would break code that
 *   already works. Defaults to none, for `fixSource`'s pipeline, where a
 *   program that reaches this pass has already failed to parse at all.
 */
function fixWrongCase(
  w: Working,
  declared: ReadonlySet<string> = NO_DECLARED,
): { w: Working; fixes: StudioFix[] } {
  const mask = scanProtected(w.text);
  const edits: Edit[] = [];
  let m: RegExpExecArray | null;
  IDENTIFIER_RE.lastIndex = 0;
  while ((m = IDENTIFIER_RE.exec(w.text))) {
    const token = m[0];
    const start = m.index;
    const end = start + token.length;
    if (!isRangeCode(mask, start, end)) continue;
    if (start > 0 && w.text[start - 1] === ".") continue; // property access — not our vocabulary to rename
    if (declared.has(token)) continue; // the scholar's own name, spelled exactly this way — untouchable
    const canonical = CANONICAL_BY_LOWER.get(token.toLowerCase());
    if (!canonical || canonical === token) continue;
    edits.push({
      start,
      end,
      replacement: canonical,
      was: token,
      now: canonical,
      note: "JavaScript is fussy about capital letters.",
    });
  }
  return applyEdits(w, edits);
}

// ── Pass 4: a known command used without parentheses ────────────────────────

/**
 * A scholar coming from Scratch writes the VERB ("Forward"), not the call
 * ("forward()") — blocks don't have parentheses. Only fires when a known
 * command word is the ENTIRE statement on its own line (optionally with a
 * trailing `;`): `forward` alone becomes `forward()`, but `forward` inside a
 * longer expression or on the right of `=` is a different situation this
 * fixer leaves alone, because the meaning there is genuinely ambiguous.
 */
const VOCAB_SET = new Set<string>(STUDIO_VOCABULARY);
const BARE_COMMAND_RE = /^([ \t]*)([A-Za-z_$][\w$]*)([ \t]*;?[ \t]*)$/gm;

/**
 * @param declared Names the scholar bound themselves. A bare vocabulary word
 *   they have shadowed (their own `let draw = …` or `function draw() {}`) is
 *   left alone — it may well be a deliberate reference to their own thing,
 *   not a Scratch-style bare verb. See `fixWrongCase` for the same guard.
 */
function fixMissingParens(
  w: Working,
  declared: ReadonlySet<string> = NO_DECLARED,
): { w: Working; fixes: StudioFix[] } {
  const mask = scanProtected(w.text);
  const edits: Edit[] = [];
  let m: RegExpExecArray | null;
  BARE_COMMAND_RE.lastIndex = 0;
  while ((m = BARE_COMMAND_RE.exec(w.text))) {
    const lead = m[1];
    const word = m[2];
    if (!VOCAB_SET.has(word)) continue;
    if (declared.has(word)) continue;
    const matchStart = m.index;
    const matchEnd = matchStart + m[0].length;
    if (!isRangeCode(mask, matchStart, matchEnd)) continue;
    const wordEnd = matchStart + lead.length + word.length;
    edits.push({
      start: wordEnd,
      end: wordEnd,
      replacement: "()",
      was: word,
      now: `${word}()`,
      note: `\`${word}\` by itself is just that command's name — nothing happens until you call it: \`${word}()\`.`,
    });
  }
  return applyEdits(w, edits);
}

// ── Pass 5: `=` used where a comparison was meant ────────────────────────────

/**
 * `if (carrying() = 3)` almost always means "does this equal 3", not "set
 * this to 3" — only inside an `if`/`while` CONDITION, and only for a bare `=`
 * that isn't secretly part of `==`, `===`, `!=`, `<=`, `>=`, `+=`, `=>`, etc.
 * A plain statement's `=` is left alone everywhere else — that's assignment,
 * and it's correct there.
 */
const CONDITION_HEAD_RE = /\b(if|while)\b[ \t]*\(/g;
const COMPOUND_EQ_PREV = "!<>+-*/%&|^~";

function fixEqualsInCondition(w: Working): { w: Working; fixes: StudioFix[] } {
  const mask = scanProtected(w.text);
  const text = w.text;
  const edits: Edit[] = [];
  let m: RegExpExecArray | null;
  CONDITION_HEAD_RE.lastIndex = 0;
  while ((m = CONDITION_HEAD_RE.exec(text))) {
    const headStart = m.index;
    if (!isRangeCode(mask, headStart, headStart + m[0].length)) continue;
    const openParenIdx = headStart + m[0].length - 1;

    let depth = 1;
    let j = openParenIdx + 1;
    while (j < text.length && depth > 0) {
      if (!mask[j]) {
        if (text[j] === "(") depth++;
        else if (text[j] === ")") depth--;
      }
      if (depth === 0) break;
      j++;
    }
    if (depth !== 0) continue; // unmatched — a harder bug this pass can't safely touch
    const closeParenIdx = j;

    const bareEqPositions: number[] = [];
    for (let k = openParenIdx + 1; k < closeParenIdx; ) {
      if (mask[k] || text[k] !== "=") {
        k++;
        continue;
      }
      // Treat a run of consecutive `=` characters (`==`, `===`) atomically —
      // only a run of exactly ONE `=` is a candidate; a longer run is
      // already a real comparison and must never be touched.
      let runEnd = k;
      while (runEnd < closeParenIdx && !mask[runEnd] && text[runEnd] === "=") runEnd++;
      const isArrow = text[runEnd] === ">"; // `=>` — not a comparison at all
      const prev = k > 0 ? text[k - 1] : "";
      const isCompoundAssign = prev !== "" && COMPOUND_EQ_PREV.includes(prev);
      if (runEnd - k === 1 && !isArrow && !isCompoundAssign) {
        bareEqPositions.push(k);
      }
      k = runEnd;
    }
    if (bareEqPositions.length === 0) continue;

    const headEnd = closeParenIdx + 1; // include the closing ")"
    const was = text.slice(headStart, headEnd);
    let now = "";
    let cursor = headStart;
    for (const pos of bareEqPositions) {
      now += text.slice(cursor, pos) + "===";
      cursor = pos + 1;
    }
    now += text.slice(cursor, headEnd);
    edits.push({
      start: headStart,
      end: headEnd,
      replacement: now,
      was,
      now,
      note: "A single = sets a value, but a condition needs === to compare two values, so I changed it.",
    });
  }
  return applyEdits(w, edits);
}

// ── Pass 6: missing `let` on first assignment to a new name ─────────────────

const RESERVED_FOR_LET = new Set<string>([
  ...CASE_FIX_KEYWORDS,
  "do",
  "in",
  "of",
  "new",
  "this",
  "typeof",
  "instanceof",
  "class",
  "try",
  "catch",
  "finally",
  "throw",
  "switch",
  "case",
  "default",
  "delete",
  "void",
  "yield",
  "async",
  "await",
  "static",
  "super",
  "extends",
  "with",
  "import",
  "export",
]);

function firstIdentifier(paramText: string): string | null {
  const m = /^[ \t]*([A-Za-z_$][\w$]*)/.exec(paramText);
  return m ? m[1] : null;
}

/**
 * Names the program already introduces: `let`/`const`/`var` declarations,
 * named-function declarations, function/arrow parameters, and `catch`
 * clauses. Deliberately shallow (no destructuring, no multi-declarator
 * `let a, b`) — the curriculum doesn't reach for those, and undercounting a
 * declared name only means we skip adding `let` a second time somewhere it
 * genuinely wasn't needed, never that we mislabel a truly-new name.
 */
function collectDeclaredNames(text: string, mask: boolean[]): Set<string> {
  const names = new Set<string>();

  const declRe = /\b(?:let|const|var)\s+([A-Za-z_$][\w$]*)/g;
  let m: RegExpExecArray | null;
  while ((m = declRe.exec(text))) {
    if (isRangeCode(mask, m.index, m.index + m[0].length)) names.add(m[1]);
  }

  const namedFnRe = /\bfunction\s+([A-Za-z_$][\w$]*)/g;
  while ((m = namedFnRe.exec(text))) {
    if (isRangeCode(mask, m.index, m.index + m[0].length)) names.add(m[1]);
  }

  const fnParamsRe = /\bfunction\b[^(]*\(([^)]*)\)/g;
  while ((m = fnParamsRe.exec(text))) {
    if (!isRangeCode(mask, m.index, m.index + m[0].length)) continue;
    for (const part of m[1].split(",")) {
      const name = firstIdentifier(part);
      if (name) names.add(name);
    }
  }

  const arrowParenRe = /\(([^)]*)\)\s*=>/g;
  while ((m = arrowParenRe.exec(text))) {
    if (!isRangeCode(mask, m.index, m.index + m[0].length)) continue;
    for (const part of m[1].split(",")) {
      const name = firstIdentifier(part);
      if (name) names.add(name);
    }
  }

  const arrowBareRe = /\b([A-Za-z_$][\w$]*)\s*=>/g;
  while ((m = arrowBareRe.exec(text))) {
    if (isRangeCode(mask, m.index, m.index + m[0].length)) names.add(m[1]);
  }

  const catchRe = /\bcatch\s*\(([^)]*)\)/g;
  while ((m = catchRe.exec(text))) {
    if (!isRangeCode(mask, m.index, m.index + m[0].length)) continue;
    const name = firstIdentifier(m[1]);
    if (name) names.add(name);
  }

  return names;
}

/**
 * `let` is a taught concept, not skirted around (Andy's ruling) — so a
 * scholar who forgets it on line 6 should still see their program run, WITH
 * the fix shown, exactly like every other repair here. Only the FIRST bare
 * assignment to a genuinely new name gets `let`; a later reassignment to the
 * same name is correct as-is and must not get a second, redeclaring `let`.
 * Vocabulary words (`color`, `pen`, …) are excluded: a bare `color = "red"`
 * is ambiguous between "new local variable" and "a slip that shadows the
 * built-in command", and this fixer only ever touches the unambiguous case.
 */
const BARE_ASSIGN_RE = /^([ \t]*)([A-Za-z_$][\w$]*)([ \t]*)=(?![=>])/gm;

function fixMissingLet(w: Working): { w: Working; fixes: StudioFix[] } {
  const mask = scanProtected(w.text);
  const declared = collectDeclaredNames(w.text, mask);
  const edits: Edit[] = [];
  let m: RegExpExecArray | null;
  BARE_ASSIGN_RE.lastIndex = 0;
  while ((m = BARE_ASSIGN_RE.exec(w.text))) {
    const lead = m[1];
    const name = m[2];
    const matchStart = m.index;
    const matchEnd = matchStart + m[0].length;
    if (!isRangeCode(mask, matchStart, matchEnd)) continue;
    if (RESERVED_FOR_LET.has(name) || VOCAB_SET.has(name)) continue;
    if (declared.has(name)) continue;
    declared.add(name); // only the FIRST bare assignment to this name is a declaration
    const nameStart = matchStart + lead.length;
    edits.push({
      start: nameStart,
      end: nameStart,
      replacement: "let ",
      was: name,
      now: `let ${name}`,
      note: "A brand-new name needs `let` in front of it the first time you use it, so I added it.",
    });
  }
  return applyEdits(w, edits);
}

// ── Pass 7: missing closing bracket/brace/paren at end of program ───────────

function bracketName(open: string): string {
  return open === "(" ? "parenthesis" : open === "{" ? "curly brace" : "square bracket";
}

/**
 * Counts unmatched openers over the whole program (skipping protected
 * characters) and appends whatever is still open, in the correct nested
 * order, at the very end. Deliberately EOF-only: guessing an insertion point
 * mid-program is exactly the kind of "fix" that could silently change what
 * the scholar's code does, which this fixer must never do.
 */
function fixMissingClosingBrackets(w: Working): { w: Working; fixes: StudioFix[] } {
  const mask = scanProtected(w.text);
  const stack: string[] = [];
  for (let i = 0; i < w.text.length; i++) {
    if (mask[i]) continue;
    const c = w.text[i];
    if (c === "(" || c === "{" || c === "[") stack.push(c);
    else if (c === ")" || c === "}" || c === "]") {
      if (stack.length > 0) stack.pop();
    }
  }
  if (stack.length === 0) return { w, fixes: [] };

  const closerFor: Record<string, string> = { "(": ")", "{": "}", "[": "]" };
  const closers = stack
    .slice()
    .reverse()
    .map((open) => closerFor[open])
    .join("");

  const trimmedEnd = w.text.replace(/\s+$/, "");
  const lastLine = w.origLine[trimmedEnd.length - 1] ?? w.origLine[w.origLine.length - 1] ?? 1;
  // A newline before the appended closers, so they land on their own line
  // instead of glued onto the scholar's last statement.
  const appended = trimmedEnd.length > 0 ? "\n" + closers : closers;
  const appendedOrigLine = new Array<number>(appended.length).fill(lastLine);

  const note =
    stack.length === 1
      ? `Your program was missing a closing ${bracketName(stack[0])} at the end, so I added one.`
      : "Your program was missing some closing brackets at the end, so I added them.";

  return {
    w: {
      text: trimmedEnd + appended,
      origLine: [...w.origLine.slice(0, trimmedEnd.length), ...appendedOrigLine],
    },
    fixes: [{ line: lastLine, was: "(end of program)", now: closers, note }],
  };
}

// ── The entry point ──────────────────────────────────────────────────────────

const PASSES: Array<(w: Working) => { w: Working; fixes: StudioFix[] }> = [
  fixTypography,
  fixOtherLanguageLeftovers,
  fixWrongCase,
  fixMissingParens,
  fixEqualsInCondition,
  fixMissingLet,
  fixMissingClosingBrackets,
];

export function fixSource(source: string): StudioFixResult {
  if (tryParse(source)) {
    // Rule: an already-correct program is a fixed point. Nothing to show,
    // nothing to risk.
    return { source, fixes: [], ok: true };
  }

  let working = initWorking(source);
  const fixes: StudioFix[] = [];
  for (const pass of PASSES) {
    const result = pass(working);
    working = result.w;
    fixes.push(...result.fixes);
  }

  if (tryParse(working.text)) {
    return { source: working.text, fixes, ok: true };
  }
  // The combined batch of repairs still doesn't parse — hand back the
  // original untouched rather than a half-mangled attempt (rule: never keep
  // a repair that didn't help). Stage 2 takes it from here.
  return { source, fixes: [], ok: false };
}

/** Alias for the name `studio/src/fix.ts` imports at integration. */
export const studioFix = fixSource;

// ── The runtime entry point ──────────────────────────────────────────────────

/**
 * Only the passes that can turn an opaque or silent runtime failure into
 * real behaviour, in the same relative order as `PASSES`. See
 * `fixRuntimeSource`'s doc comment for what — and why — is left out.
 */
const RUNTIME_PASSES: Array<
  (w: Working, declared: ReadonlySet<string>) => { w: Working; fixes: StudioFix[] }
> = [(w) => fixTypography(w), fixWrongCase, fixMissingParens, (w) => fixEqualsInCondition(w)];

/**
 * The RUNTIME half of the generous fixer. `fixSource` only ever engages a
 * program that already fails to PARSE — but the two most common first-day
 * mistakes in this vocabulary both parse perfectly and fail silently or
 * opaquely instead:
 *
 * - `Forward()` throws `ReferenceError: Forward is not defined` at runtime.
 * - bare `forward` (no parentheses) is a valid expression statement that
 *   evaluates a function reference and discards it — the robot does not
 *   move and NOTHING is reported. That is the worst outcome this surface
 *   can produce, and it is invisible to `fixSource` by construction.
 *
 * Call this after the sandbox has already RUN the program and the run went
 * wrong — it threw, or it completed having moved zero steps and drawn
 * nothing. This function never has to detect that condition itself.
 *
 * Deliberately narrower than `fixSource`, and deliberately more careful,
 * because the input here has usually already parsed and may already work:
 *
 * - Only `fixTypography`, `fixWrongCase`, `fixMissingParens`, and
 *   `fixEqualsInCondition` run — the passes that can turn a wrong-looking
 *   call or condition into a correct one. `fixTypography` can't find
 *   anything to do here (an unprotected curly quote would already have
 *   failed to parse), but it costs nothing to keep the pass order uniform.
 * - `fixMissingLet` is deliberately excluded. The sandbox's runtime already
 *   declares an undeclared name forgivingly at execution time, and its idle
 *   reformat writes the `let` into the editor buffer where the scholar can
 *   watch it happen — declaration vs. assignment is a taught concept, not
 *   one to paper over from behind the scenes.
 * - `fixMissingClosingBrackets` and `fixOtherLanguageLeftovers` are excluded
 *   too: neither can do anything useful to source that already parses, and
 *   the latter carries real false-positive risk on an innocent identifier
 *   (e.g. a scholar-chosen variable named `and`-adjacent text inside a
 *   longer word would never match, but a bare `do`/`then`/`end` LINE that
 *   is genuinely the scholar's own — however unlikely — would be deleted
 *   with no parse-failure signal to justify it).
 * - Every rewrite is checked against `collectDeclaredNames`: if the scholar
 *   already bound a name themselves — `function Forward() {}`, `let pen =
 *   …` — that exact spelling is left alone. It is their own working code,
 *   not a typo of the vocabulary, and rewriting it would break something
 *   that currently runs.
 *
 * Same conservatism as `fixSource`: the repaired text is re-verified with
 * the same `new Function` oracle, and if the combined repairs don't leave
 * it parsing, this returns the original source untouched with `ok: false` —
 * never a half-mangled attempt. If nothing needed changing, `fixes` comes
 * back empty and `ok: true`, which the sandbox reads as "I have nothing to
 * offer" and leaves the original error on screen.
 */
export function fixRuntimeSource(source: string): StudioFixResult {
  const declared = collectDeclaredNames(source, scanProtected(source));

  let working = initWorking(source);
  const fixes: StudioFix[] = [];
  for (const pass of RUNTIME_PASSES) {
    const result = pass(working, declared);
    working = result.w;
    fixes.push(...result.fixes);
  }

  if (fixes.length === 0) {
    // Nothing to offer — never hand back a "changed" result with no fixes.
    return { source, fixes: [], ok: true };
  }

  if (tryParse(working.text)) {
    return { source: working.text, fixes, ok: true };
  }
  // Never keep a repair that didn't help: hand back the original untouched.
  return { source, fixes: [], ok: false };
}
