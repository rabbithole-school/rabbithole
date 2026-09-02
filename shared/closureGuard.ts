/**
 * The ANTI-PARASOCIAL guard for a generated closure line — one pure predicate
 * that both the runtime (convex/closureLines.ts, before a generated line is ever
 * stored) and the eval (evals/closure-lines) enforce, so "the model wrote it" can
 * never smuggle in chrome the design forbids.
 *
 * Ground truth: review/anti-parasocial-design.md + review/learner-parent-
 * pedagogy.md + review/practice/completion-messaging-plan.html §4/§8. A closure
 * line is a METHOD finishing, in the third person, about the WORK — never a
 * character praising the child. So a line is rejected (and the deterministic
 * fallback renders instead) when it:
 *   • speaks in the FIRST PERSON singular ("I", "I'm", "my") — no simulated
 *     self, no bond. ("we"/"our"/"us" is allowed: it's Rabbithole-and-you, and
 *     the existing on-brand copy already uses "we'll practice…");
 *   • uses TRAIT / CALIBER praise or an emotive bond word (smart, brilliant,
 *     genius, gifted, proud, excited, friend, "miss you", love…);
 *   • frames a SCORE / STREAK / competition-count ("8 of 10", "9 correct",
 *     "nine out of ten", "3-day streak", "%"). (Per pilot9 ruling J4-A the
 *     scholar closure shows NO raw count at all; this guard still rejects any
 *     score/streak framing a generated line might smuggle in.) A stray numeral
 *     that does NOT come from one of the run's own skill labels is likewise
 *     rejected. (Skill labels legitimately carry numbers — "×7, ×8, ×9", "add
 *     within 20", "3-digit" — and naming them is the point (D2), so a digit is
 *     permitted only where it appears in the SAME local phrase its label gives
 *     it — never re-permitted globally, or the small integer nearly every math
 *     label carries would license any invented count.);
 *   • COMPARES the learner to anyone else;
 *   • runs longer than two sentences / an over-long headline.
 *
 * Imports nothing — pure and unit-testable, and safe to run in the Convex V8
 * action runtime.
 */

export interface ClosureGuardResult {
  ok: boolean;
  /** Why it failed (for logs + eval assertions). Absent when ok. */
  reason?: string;
}

export interface ClosureGuardOptions {
  /**
   * Skill / lesson LABELS that legitimately appear in the line. Numbers that
   * occur inside one of these (e.g. "×7, ×8, ×9", "add within 20", "3-digit")
   * are allowed — naming the specific skill is the design intent (D2). Any
   * numeral NOT drawn from a label — an invented score/streak — is still
   * rejected. Score/streak *framing* ("N of M", "N correct", "streak", "%") is
   * rejected regardless, even when the digits happen to match a label.
   */
  allowedLabels?: string[];
}

// Trait/caliber praise + emotive-bond words. Matched case-insensitively as whole
// words (so "start" never trips "smart"). "smart" also covers "smarter/smartest".
const BANNED_WORDS = [
  "smart",
  "smarter",
  "smartest",
  "brilliant",
  "genius",
  "gifted",
  "prodigy",
  "amazing",
  "awesome",
  "incredible",
  "superstar",
  "rockstar",
  "perfect",
  "proud",
  "excited",
  "friend",
  "buddy",
  "pal",
  "best",
];

// First-person SINGULAR only (a simulated self). "we/our/us" is intentionally
// allowed — it's the method-and-you, and shipped copy uses it.
const FIRST_PERSON = /\b(i|i'm|i've|i'll|im|me|my|mine|myself)\b/i;

// Emotive bond phrases that aren't single words.
const BANNED_PHRASES = [
  "miss you",
  "missed you",
  "love you",
  "i love",
  "so proud",
  "my friend",
];

// Ranking / learner-vs-learner comparison.
const COMPARISON =
  /\b(better than|faster than|smarter than|ahead of (?:everyone|the|your)|more than (?:everyone|anyone|the others|others)|best in|top of)\b/i;

// Number WORDS, so a score written out ("nine out of ten", "three in a row")
// can't slip past the digit-based detectors — the guard is the mechanical
// backstop and can't assume the model avoided word-numbers.
const NUM_WORD =
  "(?:one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty)";

// Score / streak / competition-count framing — rejected even when the digits it
// uses also appear in a skill label (so "10 of 10" can't hide behind a skill
// named "…within 10"). These are score shapes the growth line must never carry
// (and per J4-A there is no receipt either). Matched in both digit and
// spelled-out forms.
const SCORE_PATTERNS: RegExp[] = [
  /\b\d+\s*(?:\/|of|out of)\s*\d+\b/i, // 8 of 10 · 8/10 · 8 out of 10
  /\b\d+\s*(?:correct|right|wrong|missed|in a row)\b/i, // 9 correct · 3 in a row
  new RegExp(`\\b${NUM_WORD}\\s+(?:out of|of)\\s+${NUM_WORD}\\b`, "i"), // nine out of ten
  new RegExp(`\\b${NUM_WORD}\\s+(?:correct|right|wrong|missed|in a row)\\b`, "i"), // three in a row
  /\bstreak\b/i, // any streak framing
  /\b\d+[-\s]day\b/i, // 3-day · 3 day
  new RegExp(`\\b${NUM_WORD}[-\\s]day\\b`, "i"), // three-day
  /%/, // a percentage
];

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Trim leading/trailing punctuation from a label token, keeping inner math
// symbols/hyphens (so "×7," → "×7", "3-digit" stays "3-digit").
function trimToken(tok: string): string {
  return (tok ?? "").replace(/^[^0-9A-Za-z×÷]+|[^0-9A-Za-z×÷]+$/g, "");
}

export function validateClosureLine(
  line: string,
  opts: ClosureGuardOptions = {},
): ClosureGuardResult {
  const t = (line ?? "").trim();
  if (!t) return { ok: false, reason: "empty" };
  if (t.length > 180) return { ok: false, reason: "too long" };

  // Score/streak framing is always rejected, regardless of skill labels.
  for (const re of SCORE_PATTERNS) {
    if (re.test(t)) return { ok: false, reason: "score/streak framing" };
  }

  // A stray numeral (an invented count like "3 skills") is rejected — but a digit
  // that comes from one of the run's own skill labels is legitimate (D2: name the
  // skill). A digit is only allowed IN THE SAME LOCAL CONTEXT its label gives it
  // ("within 20", "×7", "3-digit"), never re-permitted globally — otherwise the
  // small integer nearly every math label carries would license any free-floating
  // count. Strip each label (whole, whitespace-tolerant) AND its number-bearing
  // fragments, then reject any digit that still remains.
  let residual = t;
  for (const raw of opts.allowedLabels ?? []) {
    const label = (raw ?? "").trim();
    if (!label) continue;
    if (label.length >= 2) {
      const whole = escapeRegExp(label).replace(/\s+/g, "\\s+");
      residual = residual.replace(new RegExp(whole, "gi"), " ");
    }
    const tokens = label.split(/\s+/);
    tokens.forEach((tok, i) => {
      const cleaned = trimToken(tok);
      if (!cleaned || !/\d/.test(cleaned)) return;
      let frag: string;
      if (/^\d+$/.test(cleaned)) {
        // A bare number ("20" in "add within 20") — anchor it to an adjacent
        // label word so the digit is only permitted in that exact phrase.
        const prev = trimToken(tokens[i - 1] ?? "");
        const next = trimToken(tokens[i + 1] ?? "");
        if (prev) frag = `${escapeRegExp(prev)}\\s+${cleaned}`;
        else if (next) frag = `${cleaned}\\s+${escapeRegExp(next)}`;
        else frag = cleaned; // a lone-number label — nothing to anchor to
      } else {
        // A symbol/hyphen-bearing token ("×7", "3-digit") — self-anchoring;
        // tolerate hyphen↔space so "3-digit" also clears "3 digit".
        frag = escapeRegExp(cleaned).replace(/\\-/g, "[-\\s]?");
      }
      residual = residual.replace(new RegExp(frag, "gi"), " ");
    });
  }
  if (/[0-9]/.test(residual)) return { ok: false, reason: "contains a digit" };

  const lower = t.toLowerCase();

  for (const phrase of BANNED_PHRASES) {
    if (lower.includes(phrase)) return { ok: false, reason: `banned phrase: ${phrase}` };
  }
  for (const w of BANNED_WORDS) {
    if (new RegExp(`\\b${w}\\b`, "i").test(t)) {
      return { ok: false, reason: `banned word: ${w}` };
    }
  }
  if (FIRST_PERSON.test(t)) return { ok: false, reason: "first person" };
  if (COMPARISON.test(lower)) return { ok: false, reason: "comparison" };

  // ≤ 2 sentences (an arc is at most two; a practice line is one).
  const sentences = t
    .split(/[.!?]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (sentences.length > 2) return { ok: false, reason: "more than 2 sentences" };

  return { ok: true };
}
