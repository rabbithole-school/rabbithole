/**
 * A map of a builder app's source for the Code view, built entirely from what
 * the app already is: its code, and the rules it publishes in APP STATE. The
 * builder writes nothing extra for it.
 *
 * - The script is split at top-level statements and each one's kind guessed
 *   from what it touches (rules, when, look, setup); the HTML around the
 *   script folds as page layout.
 * - Each published rule is found in the code by its starting value (the
 *   app-state SDK keeps boot-time values under `__rhDefaults`), preferring a
 *   line that names its thing or field ("Cheetah", "speed").
 * - A part that decides or calculates with a rule's field (`if (r.power ===
 *   …)`, `x += r.speed * dt`) is the game logic, and opens by default.
 * - Labels stay honest to the code instead of translating it: a part is
 *   titled by the builder's own comment or by its name as written, and shows
 *   the lines elsewhere that run it, verbatim (`go.onclick=start`). Folds list
 *   the names inside them.
 *
 * The parts tile the file: every line belongs to exactly one part, so a wrong
 * guess can mislead but never hide code. Framework-free and shared by the web
 * and iPad Code views.
 */

export type CodePartKind = "rules" | "when" | "look" | "setup";

export interface CodePart {
  kind: CodePartKind;
  /** From the app's wiring or the builder's own comment, else a generic
   *  title or the function's name. */
  title: string;
  /** True when `title` is a code identifier rather than words (show it in the
   *  code font). */
  titleIsCode: boolean;
  /** Inclusive 0-based line range in the source. */
  start: number;
  end: number;
  lang: "html" | "js";
  /** Names this part declares at the top level (functions, consts, lets). */
  names: string[];
  /** Where the part's function is used from: other lines that mention its
   *  name, verbatim and trimmed around the mention. */
  calledFrom?: string[];
  /** The part decides or calculates with a rule's value (`if (r.power === …)`,
   *  `x += r.speed * dt`): the game logic a reader came for. */
  usesRules?: boolean;
}

/** A rule as the app publishes it in APP STATE: its name and its starting
 *  value (the app-state SDK keeps boot-time values under `__rhDefaults`). */
export interface PublishedRule {
  name: string;
  value: unknown;
}

export interface CodeMap {
  lines: string[];
  parts: CodePart[];
  /** Line index → names of the published rules whose starting value is on
   *  that line. */
  ruleLines: Map<number, string[]>;
  /** Colored tokens for every script line (absent for HTML lines). */
  tokens: Map<number, Token[]>;
}

/** Parts a reader should see open by default. */
export function isOpenByDefault(kind: CodePartKind): boolean {
  return kind === "rules" || kind === "when";
}


// ─── JS scanning (depth + tokens) ────────────────────────────────────────────

export type TokenKind = "comment" | "string" | "number" | "keyword" | "text";
export interface Token {
  kind: TokenKind;
  text: string;
}

const KEYWORDS = new Set([
  "const", "let", "var", "function", "return", "if", "else", "for", "while",
  "do", "of", "in", "new", "true", "false", "null", "undefined", "this",
  "class", "switch", "case", "break", "continue", "async", "await", "typeof",
  "default", "try", "catch", "finally", "throw",
]);

type ScanState = "code" | "block" | "single" | "double" | "template";

interface LineScan {
  /** Bracket depth ({[ minus )]}) before the line's first character. */
  depth: number;
  /** False when the line begins inside a string or block comment, so it can
   *  never start a statement. */
  startsInCode: boolean;
  tokens: Token[];
}

/**
 * Scans JavaScript lines once, carrying string/comment state across lines.
 * Regex literals are not recognized; a bracket inside one can skew `depth`,
 * which only affects where the heuristic splits, never what is shown.
 */
export function scanJsLines(lines: string[]): LineScan[] {
  const out: LineScan[] = [];
  let state: ScanState = "code";
  let depth = 0;
  for (const line of lines) {
    const tokens: Token[] = [];
    const lineDepth = depth;
    const startsInCode = state === "code";
    let buf = "";
    let kind: TokenKind = state === "code" ? "text" : state === "block" ? "comment" : "string";
    const flush = () => {
      if (buf) tokens.push({ kind, text: buf });
      buf = "";
    };
    const begin = (k: TokenKind) => {
      if (k !== kind) {
        flush();
        kind = k;
      }
    };
    let i = 0;
    while (i < line.length) {
      const c = line[i];
      const next = line[i + 1];
      if (state === "block") {
        buf += c;
        if (c === "*" && next === "/") {
          buf += "/";
          i += 2;
          state = "code";
          flush();
          kind = "text";
          continue;
        }
        i++;
        continue;
      }
      if (state === "single" || state === "double" || state === "template") {
        buf += c;
        if (c === "\\") {
          if (next !== undefined) buf += next;
          i += 2;
          continue;
        }
        const close = state === "single" ? "'" : state === "double" ? '"' : "`";
        if (c === close) {
          state = "code";
          flush();
          kind = "text";
        }
        i++;
        continue;
      }
      // code
      if (c === "/" && next === "/") {
        begin("comment");
        buf += line.slice(i);
        i = line.length;
        break;
      }
      if (c === "/" && next === "*") {
        begin("comment");
        buf += "/*";
        state = "block";
        i += 2;
        continue;
      }
      if (c === "'" || c === '"' || c === "`") {
        begin("string");
        buf += c;
        state = c === "'" ? "single" : c === '"' ? "double" : "template";
        i++;
        continue;
      }
      // A minus right after an operator, a bracket or a comma is a sign
      // (`jump: -12`), so the number reads as one literal, "-12".
      const signed =
        c === "-" &&
        /[0-9]/.test(next ?? "") &&
        /^$|[:=(\[,?{!&|;]$/.test(line.slice(0, i).trimEnd().slice(-1));
      if ((signed || /[0-9]/.test(c)) && !/[A-Za-z0-9_$.]/.test(line[i - 1] ?? "")) {
        const m = /^-?\d+(?:\.\d+)?/.exec(line.slice(i));
        if (m) {
          begin("number");
          buf += m[0];
          i += m[0].length;
          continue;
        }
      }
      if (/[A-Za-z_$]/.test(c) && !/[A-Za-z0-9_$]/.test(line[i - 1] ?? "")) {
        const m = /^[A-Za-z_$][A-Za-z0-9_$]*/.exec(line.slice(i))!;
        begin(KEYWORDS.has(m[0]) ? "keyword" : "text");
        buf += m[0];
        i += m[0].length;
        continue;
      }
      if (c === "{" || c === "(" || c === "[") depth++;
      else if (c === "}" || c === ")" || c === "]") depth = Math.max(0, depth - 1);
      begin("text");
      buf += c;
      i++;
    }
    flush();
    // A line comment never continues; strings other than templates don't either.
    if (state === "single" || state === "double") state = "code";
    out.push({ depth: lineDepth, startsInCode, tokens });
  }
  return out;
}

// ─── Script regions ──────────────────────────────────────────────────────────

interface Region {
  lang: "html" | "js";
  start: number;
  end: number;
}

/** Splits the file into alternating HTML and inline-script line ranges. */
function regionsOf(lines: string[]): Region[] {
  const regions: Region[] = [];
  let i = 0;
  let htmlStart = 0;
  while (i < lines.length) {
    const open = /<script(?![^>]*\bsrc=)[^>]*>/i.exec(lines[i]);
    if (!open) {
      i++;
      continue;
    }
    const afterTag = lines[i].slice(open.index + open[0].length);
    if (/<\/script>/i.test(afterTag)) {
      i++; // a one-line script stays with the HTML around it
      continue;
    }
    // The script body starts on the tag's line when code follows the tag.
    const jsStart = afterTag.trim() ? i : i + 1;
    let j = jsStart;
    while (j < lines.length && !/<\/script>/i.test(lines[j])) j++;
    const closeLine = Math.min(j, lines.length - 1);
    const closeOnly = /^\s*<\/script>/i.test(lines[closeLine]);
    const jsEnd = closeOnly ? closeLine - 1 : closeLine;
    if (jsStart > htmlStart) regions.push({ lang: "html", start: htmlStart, end: jsStart - 1 });
    if (jsEnd >= jsStart) regions.push({ lang: "js", start: jsStart, end: jsEnd });
    htmlStart = jsEnd + 1;
    i = closeLine + 1;
  }
  if (htmlStart < lines.length) regions.push({ lang: "html", start: htmlStart, end: lines.length - 1 });
  return regions;
}

function htmlParts(lines: string[], r: Region, beforeAnyScript: boolean): CodePart[] {
  const base = { kind: "look" as const, lang: "html" as const, titleIsCode: false, names: [] as string[] };
  if (!beforeAnyScript) {
    return [{ ...base, kind: "setup", title: "The end of the page", start: r.start, end: r.end }];
  }
  let styleEnd = -1;
  for (let k = r.start; k <= r.end; k++) {
    if (/<\/style>/i.test(lines[k])) styleEnd = k;
  }
  if (styleEnd < r.start || styleEnd >= r.end) {
    return [{ ...base, title: styleEnd >= r.start ? "Colors and layout" : "What's on the screen", start: r.start, end: r.end }];
  }
  return [
    { ...base, title: "Colors and layout", start: r.start, end: styleEnd },
    { ...base, title: "What's on the screen", start: styleEnd + 1, end: r.end },
  ];
}

// ─── Splitting the script ────────────────────────────────────────────────────

const SETUP_RE = /\brabbithole\b|\brh\b|setState|getState|registerAction|subscribe\(|getElementById|querySelector|createElement|addEventListener|onresize|onclick|oninput|onchange|appendChild/;
const LOOK_RE = /\bctx\.|fillRect|fillStyle|strokeStyle|beginPath|\.arc\(|ellipse\(|\.style\.|innerHTML|className/;
const DRAW_NAME_RE = /^(draw|render|paint|show|update[A-Z]?\w*View)/i;
const SETUP_NAME_RE = /^(pub|publish|save|load|restore|setup|init|size|resize|boot|mount)/i;

function statementKind(text: string): { kind: CodePartKind; fnName?: string } {
  const fn = /^\s*(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/.exec(text)
    ?? /^\s*(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/.exec(text)
    // `let t=0;function step(){…}`: a function after a short lead-in on its line
    ?? /^[^\n{]{0,40};\s*(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/.exec(text);
  if (fn) {
    const name = fn[1];
    if (DRAW_NAME_RE.test(name)) return { kind: "look", fnName: name };
    if (SETUP_NAME_RE.test(name)) return { kind: "setup", fnName: name };
    return { kind: "when", fnName: name };
  }
  const decl = /^\s*(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*([\[{]|-?\d)/.exec(text);
  if (decl && !/=>|function|document\.|\brh\b|rabbithole/.test(text)) {
    const numbers = text.match(/(?<![\w$.])-?\d+(?:\.\d+)?/g) ?? [];
    const allCapsNumber = /^[A-Z][A-Z0-9_]*$/.test(decl[1]) && /^-?\d/.test(decl[2]);
    if (numbers.length >= 3 || allCapsNumber) return { kind: "rules" };
  }
  if (SETUP_RE.test(text)) return { kind: "setup" };
  if (LOOK_RE.test(text)) return { kind: "look" };
  if (/\bif\s*\(/.test(text)) return { kind: "when" };
  return { kind: "setup" };
}

const GENERIC_TITLE: Record<CodePartKind, string> = {
  rules: "Numbers in your game",
  when: "What happens",
  look: "Drawing",
  setup: "Getting ready and saving",
};

/** Top-level names a statement declares: `function a`, `const b=…,c=…`. */
function declaredNames(code: string): string[] {
  const out: string[] = [];
  for (const m of code.matchAll(/(?:^|[;\n]\s*)(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/g)) out.push(m[1]);
  const decl = /^\s*(?:const|let|var)\s+([^;]*)/.exec(code);
  if (decl) {
    // Names at the start of each comma-separated declarator, outside brackets.
    let depth = 0;
    let piece = "";
    for (const ch of decl[1] + ",") {
      if ("([{".includes(ch)) depth++;
      else if (")]}".includes(ch)) depth--;
      if (ch === "," && depth === 0) {
        const m = /^\s*([A-Za-z_$][\w$]*)/.exec(piece);
        if (m) out.push(m[1]);
        piece = "";
      } else piece += ch;
    }
  }
  return [...new Set(out)];
}

function heuristicParts(lines: string[], scans: LineScan[], r: Region): CodePart[] {
  // Statements start at lines that begin in code at depth 0 (never inside a
  // string, template or block comment). A run of `//` lines directly above a
  // statement, however long, belongs to it and titles it; a blank line or
  // nested code ends the run.
  const starts: number[] = [];
  let commentRun = false;
  for (let k = r.start; k <= r.end; k++) {
    const s = scans[k - r.start];
    if (!lines[k].trim() || s.depth !== 0 || !s.startsInCode) {
      commentRun = false;
      continue;
    }
    if (/^\s*\/\//.test(lines[k])) {
      if (!commentRun) starts.push(k);
      commentRun = true;
      continue;
    }
    if (commentRun) {
      // this statement joins the comment run above it
      commentRun = false;
      continue;
    }
    starts.push(k);
  }
  if (!starts.length || starts[0] !== r.start) starts.unshift(r.start);

  const stmts = starts.map((s, idx) => {
    const end = idx + 1 < starts.length ? starts[idx + 1] - 1 : r.end;
    const body = lines.slice(s, end + 1);
    const commentTitle = /^\s*\/\/\s*(.+)$/.exec(body[0])?.[1]?.trim();
    const code = body.filter((l) => !/^\s*\/\//.test(l)).join("\n");
    const { kind, fnName } = statementKind(code);
    return { start: s, end, kind, fnName, commentTitle, names: declaredNames(code) };
  });

  const parts: CodePart[] = [];
  for (const st of stmts) {
    const last = parts[parts.length - 1];
    const ownTitle = st.commentTitle ?? st.fnName;
    // A "when" function, or anything the builder commented, stands alone;
    // runs of untitled setup/look/rules merge into one fold.
    if (last && last.kind === st.kind && !ownTitle && !(st.kind === "when" && st.fnName) && last.end === st.start - 1 && last.titleIsCode === false && last.title === GENERIC_TITLE[st.kind]) {
      last.end = st.end;
      last.names.push(...st.names);
      continue;
    }
    parts.push({
      kind: st.kind,
      title: st.commentTitle ?? st.fnName ?? GENERIC_TITLE[st.kind],
      titleIsCode: !st.commentTitle && !!st.fnName,
      start: st.start,
      end: st.end,
      lang: "js",
      names: st.names,
    });
  }
  // Merge consecutive parts of the same folded kind so setup reads as one line.
  const merged: CodePart[] = [];
  for (const p of parts) {
    const last = merged[merged.length - 1];
    if (last && !isOpenByDefault(p.kind) && last.kind === p.kind && last.end === p.start - 1) {
      last.end = p.end;
      last.names.push(...p.names);
      if (last.title !== p.title) {
        last.title = GENERIC_TITLE[p.kind];
        last.titleIsCode = false;
      }
      continue;
    }
    merged.push(p);
  }
  return merged;
}

// ─── Entry point ─────────────────────────────────────────────────────────────

/**
 * Finds each published rule's starting value in the code with no help from
 * the builder: a line holding the value as a literal, preferring lines that
 * name the rule's thing or field ("Cheetah", "speed"). Returns the line for
 * each rule found on exactly one best line, plus the field names the rules
 * live under, for spotting the code that uses them.
 */
export function linkRulesPassively(
  lines: string[],
  rules: readonly PublishedRule[],
  tokens: Map<number, Token[]> = new Map(scanJsLines(lines).map((scan, i) => [i, scan.tokens])),
): { ruleLines: Map<number, string[]>; fields: Set<string> } {
  const ruleLines = new Map<number, string[]>();
  const fields = new Set<string>();
  for (const rule of rules) {
    const v = rule.value;
    if (typeof v !== "number" && typeof v !== "string") continue;
    // Compare the code's own tokens, read the way the reader tints them, so
    // `9` never matches `9.5` and `-12` is one value.
    const target = String(v);
    const words = rule.name.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2);
    const last = words[words.length - 1];
    if (last && /^[a-z]\w*$/.test(last)) fields.add(last);
    let best = 0;
    let found: number[] = [];
    for (const [i, lineTokens] of tokens) {
      const hits = lineTokens.flatMap((t, at) => (literalOf(t) === target ? [at] : []));
      if (!hits.length) continue;
      const lower = lines[i].toLowerCase();
      const score = words.filter((w) => lower.includes(w)).length;
      if (score > best) {
        best = score;
        found = [i];
      } else if (score === best && score > 0) found.push(i);
      if (score > 0) {
        for (const at of hits) {
          const before = lineTokens.slice(Math.max(0, at - 4), at).map((t) => t.text).join("");
          const key = /([A-Za-z_$][\w$]*)\s*:\s*$/.exec(before);
          if (key) fields.add(key[1].toLowerCase());
        }
      }
    }
    if (found.length === 1) {
      ruleLines.set(found[0], [...(ruleLines.get(found[0]) ?? []), rule.name]);
    }
  }
  return { ruleLines, fields };
}

/** True when a line decides or calculates with one of these rule fields. */
function usesRuleField(maskedLine: string, fields: Set<string>): boolean {
  // Gluing a value into text ('<b>' + r.speed + '</b>') shows a rule; it
  // doesn't decide anything with it. Drop those before looking.
  const line = maskedLine
    .replace(/§+\s*\+\s*[\w$.[\]()]*/g, " ")
    .replace(/[\w$.[\]()]*\s*\+\s*§+/g, " ");
  for (const f of fields) {
    const ref = `\\.${f}\\b`;
    if (new RegExp(`\\bif\\s*\\([^)]*${ref}`, "i").test(line)) return true;
    if (new RegExp(`${ref}\\s*[*/+\\-<>]|[*/+\\-<>]=?\\s*[\\w$.\\[\\]]*${ref}`, "i").test(line)) return true;
  }
  return false;
}

export function mapAppCode(
  source: string,
  opts: { rules?: readonly PublishedRule[] } = {},
): CodeMap {
  const lines = source.split("\n");
  const parts: CodePart[] = [];
  let ruleLines = new Map<number, string[]>();
  // One scan per script, carried across its parts, so a string or comment
  // that spans lines is read the same everywhere.
  const tokens = new Map<number, Token[]>();
  let seenScript = false;
  for (const r of regionsOf(lines)) {
    if (r.lang === "html") {
      parts.push(...htmlParts(lines, r, !seenScript));
      continue;
    }
    seenScript = true;
    const scans = scanJsLines(lines.slice(r.start, r.end + 1));
    scans.forEach((scan, i) => tokens.set(r.start + i, scan.tokens));
    parts.push(...heuristicParts(lines, scans, r));
  }
  // Each script line with strings as § and comments as spaces: neither is
  // code. Null outside scripts.
  const code: (string | null)[] = lines.map((_, k) => {
    const lineTokens = tokens.get(k);
    if (!lineTokens) return null;
    return lineTokens
      .map((t) => (t.kind === "string" ? "§".repeat(t.text.length) : t.kind === "comment" ? " ".repeat(t.text.length) : t.text))
      .join("");
  });
  for (const p of parts) {
    if (p.lang === "js" && p.titleIsCode) p.calledFrom = callSites(lines, code, p);
  }
  if (opts.rules?.length) {
    const passive = linkRulesPassively(lines, opts.rules, tokens);
    ruleLines = passive.ruleLines;
    for (const p of parts) {
      if (p.lang !== "js" || p.kind === "rules") continue;
      for (let k = p.start; k <= p.end; k++) {
        if (usesRuleField(code[k] ?? "", passive.fields)) {
          p.usesRules = true;
          // Deciding with a rule is something that happens, whatever the
          // part looked like (drawing that reads a speed stays drawing).
          if (p.kind === "setup") {
            p.kind = "when";
            if (p.title === GENERIC_TITLE.setup) p.title = GENERIC_TITLE.when;
          }
          break;
        }
      }
    }
    // A short statement that holds a rule's starting value is a rules part,
    // whatever the heuristic guessed (a table that shares its line with a DOM
    // lookup). Long folds keep their kind: one literal doesn't make them rules.
    for (const p of parts) {
      if (p.lang !== "js" || p.kind === "rules" || p.end - p.start > 8) continue;
      for (const k of ruleLines.keys()) {
        if (k >= p.start && k <= p.end && !p.titleIsCode) {
          p.kind = "rules";
          p.title = GENERIC_TITLE.rules;
          break;
        }
      }
    }
  }
  return { lines, parts, ruleLines, tokens };
}

/** Longest call-site snippet shown; longer lines are cut around the mention. */
const CALL_SITE_CHARS = 72;

/**
 * Lines outside a part that mention its function by name, as written: the
 * button handler, the loop, the other function that calls it. A plain name
 * search, so it covers every wiring style without knowing any of them.
 */
export function callSites(lines: string[], code: (string | null)[], part: CodePart): string[] {
  const name = part.title;
  const re = new RegExp(`(?<![\\w$.])${name.replace(/\$/g, "\\$")}(?![\\w$])`);
  const out: string[] = [];
  for (let k = 0; k < lines.length && out.length < 2; k++) {
    if (k >= part.start && k <= part.end) continue;
    // Match against the code only: strings, comments and HTML are blanked,
    // so "Speed burst at the start" or <input step=…> don't count as calls.
    const masked = code[k];
    if (!masked) continue;
    const lead = lines[k].length - lines[k].trimStart().length;
    const hit = re.exec(masked);
    if (!hit) continue;
    const line = lines[k].trim();
    const m = { index: hit.index - lead };
    if (line.length <= CALL_SITE_CHARS) {
      out.push(line);
      continue;
    }
    // Keep the words before the mention (often the button's own text).
    const from = Math.max(0, m.index - (CALL_SITE_CHARS - name.length - 12));
    const to = Math.min(line.length, from + CALL_SITE_CHARS);
    out.push(`${from > 0 ? "…" : ""}${line.slice(from, to)}${to < line.length ? "…" : ""}`);
  }
  return out;
}

/**
 * What the reader opens by default. With published rules in hand, only the
 * rules and the code that uses them; without, every rules and "when" part.
 */
export function openParts(map: CodeMap): Set<number> {
  const open = new Set<number>();
  const passive = map.parts.some((p) => p.usesRules);
  for (const p of map.parts) {
    if (p.kind === "rules" || (passive ? p.usesRules : p.kind === "when")) open.add(p.start);
  }
  return open;
}

// ─── What the reader shows ───────────────────────────────────────────────────

/** One block in the reader: an open part, or a fold of everything between. */
export type ReaderBlock =
  | { kind: "part"; part: CodePart; start: number; end: number }
  | { kind: "rest"; start: number; end: number; title: string; titleIsCode: boolean };

/**
 * The reader's blocks, shared by the web and iPad Code views: open parts, with
 * adjacent rules pieces read as one "The rules" block, and every run of
 * folded parts collapsed into one line labeled by the names inside it.
 */
/** The style and markup before the script (not the closing tags after it). */
const isPageLayout = (p: CodePart) => p.lang === "html" && p.kind === "look";

export function readerBlocks(map: CodeMap): ReaderBlock[] {
  const open = openParts(map);
  const out: (ReaderBlock | { kind: "run"; start: number; end: number; names: string[]; html: boolean })[] = [];
  for (const part of map.parts) {
    const last = out[out.length - 1];
    if (open.has(part.start)) {
      if (last?.kind === "part" && last.part.kind === "rules" && part.kind === "rules") {
        last.end = part.end;
        last.part = { ...last.part, end: part.end };
      } else {
        const shown = part.kind === "rules" ? { ...part, title: "The rules", titleIsCode: false } : part;
        out.push({ kind: "part", part: shown, start: part.start, end: part.end });
      }
      continue;
    }
    if (last?.kind === "run") {
      last.end = part.end;
      last.names.push(...part.names);
      last.html = last.html || isPageLayout(part);
    } else {
      out.push({ kind: "run", start: part.start, end: part.end, names: [...part.names], html: isPageLayout(part) });
    }
  }
  return out.map((b) => {
    if (b.kind !== "run") return b;
    const shown = b.names.slice(0, 3).join(", ") + (b.names.length > 3 ? ` and ${b.names.length - 3} more` : "");
    if (b.html) {
      return { kind: "rest", start: b.start, end: b.end, title: b.names.length ? `Page style and layout, ${shown}` : "Page style and layout", titleIsCode: false };
    }
    return b.names.length
      ? { kind: "rest", start: b.start, end: b.end, title: shown, titleIsCode: true }
      : { kind: "rest", start: b.start, end: b.end, title: "Other setup", titleIsCode: false };
  });
}

/** The text a token holds as a literal value ("9", "Fast start"), or null. */
export function literalOf(t: Token): string | null {
  return t.kind === "string" ? t.text.slice(1, -1) : t.kind === "number" ? t.text : null;
}

/** The note shown when a scholar taps a rule's value. */
export function ruleNote(
  name: string,
  start: string | undefined,
  current: { value?: unknown; by?: unknown } | undefined,
): string {
  const now =
    typeof current?.value === "number" || typeof current?.value === "string" ? String(current.value) : null;
  const parts = [`${name}${start !== undefined ? ` starts at ${start}.` : "."}`];
  if (now !== null && start !== undefined && now !== start) parts.push(`It's ${now} now.`);
  if (current?.by === "scholar") parts.push("You set this one.");
  else if (current?.by === "guess") parts.push("I picked this one.");
  parts.push("Change it on its card in your app.");
  return parts.join(" ");
}

/** One entry of APP STATE `rules`, as the builder publishes it. */
export interface AppRuleEntry {
  name?: unknown;
  value?: unknown;
  by?: unknown;
}

/** Everything a Code-view reader renders, computed once per source + rules. */
export interface CodeReader {
  map: CodeMap;
  blocks: ReaderBlock[];
  /** Colored tokens for every script line (absent for HTML lines). */
  tokens: Map<number, Token[]>;
  /** The rule whose starting value this token is, if any. */
  ruleFor(line: number, token: Token): string | undefined;
  /** The note for a tapped rule value. */
  noteFor(name: string): string;
}

/**
 * The shared model behind the web and iPad readers. `rules` is APP STATE
 * `rules` now (current value, who set it); `startingRules` is the same list
 * as the app's code first wrote it (`__rhDefaults.rules`), used to find each
 * rule in the source. Without starting rules it falls back to the current
 * ones, which match the code until a scholar changes a rule.
 */
export function buildReader(
  source: string,
  rules: readonly AppRuleEntry[] | undefined,
  startingRules: readonly AppRuleEntry[] | undefined,
): CodeReader {
  const asPublished = (list: readonly AppRuleEntry[] | undefined): PublishedRule[] =>
    (list ?? []).flatMap((r) => (typeof r?.name === "string" ? [{ name: r.name, value: r.value }] : []));
  const published = asPublished(startingRules?.length ? startingRules : rules);
  const map = mapAppCode(source, { rules: published });
  const startValue = new Map(published.map((r) => [r.name, String(r.value)]));
  const current = new Map<string, AppRuleEntry>();
  for (const r of rules ?? []) if (typeof r?.name === "string") current.set(r.name, r);
  const tokens = map.tokens;
  return {
    map,
    blocks: readerBlocks(map),
    tokens,
    ruleFor(line, token) {
      const lit = literalOf(token);
      if (lit === null) return undefined;
      const candidates = (map.ruleLines.get(line) ?? []).filter((name) => startValue.get(name) === lit);
      if (!candidates.length) return undefined;
      const lineTokens = tokens.get(line) ?? [];
      const at = lineTokens.indexOf(token);
      // The key the value is written under (`size:5`, `speed = 5`) picks the
      // rule that names it ("Ball size"). Without one, a value is only tinted
      // when it is the one rule and the one such literal on the line, so two
      // 5s on one line never both claim "Ball speed".
      const before = lineTokens.slice(Math.max(0, at - 4), at).map((t) => t.text).join("");
      const key = /([A-Za-z_$][\w$]*)\s*[:=]\s*$/.exec(before)?.[1]?.toLowerCase();
      if (key) {
        const named = candidates.filter((name) => name.toLowerCase().split(/[^a-z0-9]+/).includes(key));
        if (named.length === 1) return named[0];
        if (named.length > 1) return undefined;
      }
      const sameLiteral = lineTokens.filter((t) => literalOf(t) === lit).length;
      return candidates.length === 1 && sameLiteral === 1 ? candidates[0] : undefined;
    },
    noteFor: (name) => ruleNote(name, startValue.get(name), current.get(name)),
  };
}
