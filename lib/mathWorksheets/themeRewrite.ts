/**
 * "Make it about what your kid loves": a model rewrites the STORY of each word
 * problem around a theme (dinosaurs, soccer) while the math stays the
 * template's. The numbers, units and the question are the template's, so the
 * answer key stays correct by construction, and every rewrite is checked here
 * before it is shown: if a single number, number word or unit differs from the
 * original, that problem keeps its plain wording.
 *
 * Pure and framework-free. The browser calls the provider directly with the
 * grown-up's own key or OpenRouter sign-in (see ThemeRewriter.tsx); nothing
 * passes through our server.
 */

export type RewriteCandidate = { n: number; stem: string };

/** Longest theme we send. The theme is a hobby, never a name. */
export const MAX_THEME_LENGTH = 40;

const NUMBER_WORDS = new Set([
  "zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten",
  "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen",
  "nineteen", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety",
  "hundred", "thousand", "million", "dozen", "half", "halves", "third", "thirds", "quarter",
  "quarters", "twice", "double", "triple", "once", "pair", "pairs", "first", "second",
  "fourth", "fifth", "sixth", "tenth", "tenths", "hundredth", "hundredths", "percent",
]);

/** Units and unit-like words whose change would change the answer. */
const UNIT_WORDS = new Set([
  "cm", "mm", "m", "km", "g", "kg", "mg", "ml", "l", "liter", "liters", "litre", "litres",
  "inch", "inches", "foot", "feet", "yard", "yards", "mile", "miles", "pound", "pounds",
  "ounce", "ounces", "cup", "cups", "pint", "pints", "quart", "quarts", "gallon", "gallons",
  "second", "seconds", "minute", "minutes", "hour", "hours", "day", "days", "week", "weeks",
  "month", "months", "year", "years", "cent", "cents", "dollar", "dollars", "meter", "meters",
  "metre", "metres", "centimeter", "centimeters", "kilometer", "kilometers", "gram", "grams",
  "kilogram", "kilograms", "degree", "degrees", "mph", "per",
]);

/** A word problem worth theming: a sentence of prose, not a bare expression,
 *  no picture or table it must stay matched to, and no answer choices that
 *  name things in the story. */
export function isRewritable(item: { stem: string; choices?: string[]; promptVisual?: unknown }): boolean {
  if (item.promptVisual || item.choices || item.stem.includes("|")) return false;
  const words = item.stem.match(/[A-Za-z]{3,}/g) ?? [];
  return words.length >= 8;
}

function tokens(text: string, vocab: Set<string>): string[] {
  return (text.toLowerCase().match(/[a-z]+/g) ?? []).filter((w) => vocab.has(w));
}

/** Every numeral in a text, normalized: "1,200" → "1200", "3/4", "2.5", "−3" → "-3". */
export function numerals(text: string): string[] {
  return (text.replace(/[−–]/g, "-").match(/-?\d[\d,]*(?:\.\d+)?(?:\/\d+)?/g) ?? []).map((t) =>
    t.replace(/,+$/, "").replace(/,(?=\d{3}\b)/g, ""),
  );
}

function sameMultiset(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const x = [...a].sort();
  const y = [...b].sort();
  return x.every((v, i) => v === y[i]);
}

export type RewriteCheck = { ok: true } | { ok: false; reason: string };

/** The guard: a rewrite may change the story, never the math. */
export function checkRewrite(original: string, rewrite: string): RewriteCheck {
  const r = rewrite.trim();
  if (!r) return { ok: false, reason: "empty" };
  if (r.length > Math.max(220, original.length * 3)) return { ok: false, reason: "too long" };
  if (!sameMultiset(numerals(original), numerals(r))) return { ok: false, reason: "numbers changed" };
  if (!sameMultiset(tokens(original, NUMBER_WORDS), tokens(r, NUMBER_WORDS))) {
    return { ok: false, reason: "number words changed" };
  }
  if (!sameMultiset([...new Set(tokens(original, UNIT_WORDS))], [...new Set(tokens(r, UNIT_WORDS))])) {
    return { ok: false, reason: "units changed" };
  }
  if (original.includes("?") && !r.includes("?")) return { ok: false, reason: "question dropped" };
  return { ok: true };
}

export function cleanTheme(raw: string): string {
  return raw.replace(/[\r\n\t]+/g, " ").replace(/[<>{}`]/g, "").trim().slice(0, MAX_THEME_LENGTH);
}

export const REWRITE_SYSTEM = [
  "You rewrite the story in children's math word problems so they are about a theme the child loves.",
  "Hard rules for every problem:",
  "- Keep every number exactly as written, the same count of times, in digits where it was in digits and in words where it was in words.",
  "- Add no new numbers or number words (no 'two dinosaurs' unless 'two' was already there). Do not write ordinals or dates that are not in the original.",
  "- Keep every unit exactly (cm, minutes, dollars, and so on) and ask the same question about the same quantity.",
  "- Do not solve the problem or hint at the answer.",
  "- Keep it short, kind and suitable for a young child. Use no real people's names.",
  "- If the theme is unsuitable for a child or a problem cannot be rethemed without changing its math, return that problem's text unchanged.",
  'Reply with JSON only: {"problems":[{"n":<number>,"text":"<rewritten problem>"}]}.',
].join("\n");

export function rewriteUserPrompt(theme: string, items: RewriteCandidate[]): string {
  return [
    `Theme: ${cleanTheme(theme)}`,
    "Problems:",
    ...items.map((i) => JSON.stringify({ n: i.n, text: i.stem })),
  ].join("\n");
}

/** Pull `{n, text}` pairs out of a model reply, tolerating prose around the JSON. */
export function parseRewriteReply(reply: string): Map<number, string> {
  const out = new Map<number, string>();
  const start = reply.indexOf("{");
  const end = reply.lastIndexOf("}");
  if (start < 0 || end <= start) return out;
  try {
    const parsed = JSON.parse(reply.slice(start, end + 1)) as { problems?: { n?: unknown; text?: unknown }[] };
    for (const p of parsed.problems ?? []) {
      if (typeof p.n === "number" && typeof p.text === "string") out.set(p.n, p.text);
    }
  } catch {
    // An unparseable reply rewrites nothing; every problem keeps its wording.
  }
  return out;
}

/** Apply a reply: only rewrites that pass `checkRewrite` survive. */
export function acceptRewrites(
  candidates: RewriteCandidate[],
  reply: string,
): { accepted: Map<number, string>; rejected: { n: number; reason: string }[] } {
  const proposed = parseRewriteReply(reply);
  const accepted = new Map<number, string>();
  const rejected: { n: number; reason: string }[] = [];
  for (const c of candidates) {
    const text = proposed.get(c.n);
    if (text === undefined) {
      rejected.push({ n: c.n, reason: "missing" });
      continue;
    }
    const check = checkRewrite(c.stem, text);
    if (check.ok) {
      if (text.trim() !== c.stem.trim()) accepted.set(c.n, text.trim());
    } else rejected.push({ n: c.n, reason: check.reason });
  }
  return { accepted, rejected };
}
