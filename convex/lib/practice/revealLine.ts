/**
 * The PLACEMENT WARMTH FLOOR — "never cold, never wrong".
 *
 * Design: ruling-placement-idk.html Option F, two-tier. A placement check is
 * measurement, so its miss/"I haven't learned this yet" moment stays reveal-only
 * and non-interactive (see .claude/rules/rabbithole-practice-engine.md
 * "Teach-as-action"). The historical failure this fixes: an honest don't-know
 * sometimes got a warm worked mini-lesson and sometimes a bare cold
 * "The answer was 11", purely as a function of item-family worked-steps coverage
 * (and, formerly, a flaky live LLM stream). This module guarantees a warm reveal
 * line on EVERY miss — deterministically, with NO live LLM call at serve time.
 *
 * Two tiers, in precedence order (`buildPlacementRevealLine`):
 *   • TIER 1 — specific warmth, only where correct-by-construction or verified:
 *       (c) a `revealLine` generated + VERIFIED at item-generation time and stored
 *           on the `practiceItems` row (LLM-authored stems);
 *       (a) the item's own deterministic worked steps (workedStepGen families /
 *           authored stored steps) joined into a compact mini-lesson — unchanged
 *           content, reused verbatim;
 *       (b) an authored strategy one-liner for the no-derivation families
 *           (facts / missing-operand), built from the item's own operands.
 *   • TIER 2 — generic warmth, the universal fallback: a small rotation of honest
 *       warm lines whenever no Tier-1 content exists. This is what makes the floor
 *       TOTAL — `buildPlacementRevealLine` NEVER returns empty.
 *
 * The S8 operand-substitution ban is enforced here (`revealLineNumbersOk`): a
 * generated/templated line's numbers must be the ITEM's numbers — the operands,
 * the answer, or a value REACHED by arithmetic on them — never a foreign operand
 * from a different example. Pure module (no Convex/React deps): unit-tested
 * directly.
 */

/** The generic Tier-2 rotation — honest, warm, and outcome-neutral (renders after
 *  both a wrong guess and an "I haven't learned this yet"). Matches the check-in's
 *  existing reveal voice (see `placementFeedback` in shared/practiceLoop.ts). */
export const TIER2_REVEAL_LINES: readonly string[] = [
  "That one's for later — good to know where you're starting 👍",
  "Still ahead of you, and that's exactly what this check is for.",
  "One for another day — thanks for showing us where you are.",
  "We'll come back to this one when you're ready 👍",
  "Good to know where the edge is — we'll build up to it.",
];

/** Deterministically pick a Tier-2 line by a per-probe seed (stable across a
 *  reload of the same feedback moment). Non-negative modulo, empty-safe. */
export function pickTier2Line(seed: number): string {
  const n = TIER2_REVEAL_LINES.length;
  if (n === 0) return "";
  const idx = ((Math.trunc(seed) % n) + n) % n;
  return TIER2_REVEAL_LINES[idx];
}

/** The operand shape a template item exposes for a strategy line (mirrors
 *  templates.ts `ItemVariant`). */
export type RevealVariant = { a: number; op: "+" | "−" | "×"; b: number };

/** Everything `buildPlacementRevealLine` needs about the graded item. Kept as a
 *  plain data packet (not a `ServableItem`) so the tier logic unit-tests without
 *  Convex. */
export type RevealLineInput = {
  kind: "template" | "stored" | "manipulative";
  /** The revealed correct answer (display string). Null for a manipulative (no
   *  answer string) — such a probe can only reach Tier 2. */
  correctAnswer: string | null;
  /** Tier 1c: the stored, pre-verified reveal line (LLM-authored items). */
  storedRevealLine?: string | null;
  /** Tier 1a: the item's own worked steps (server-truth `text` — safe to show in
   *  a placement reveal, where the answer is already revealed). */
  workedSteps?: { text: string; blankText?: string }[];
  /** Tier 1b inputs (template items only): the stem, and — for a direct fact —
   *  the operand `variant`. A missing-operand item carries `form: "missing"`. */
  stem?: string;
  variant?: RevealVariant;
  form?: string;
  /** Per-probe seed for the Tier-2 rotation. */
  seed: number;
};

export type PlacementRevealLine = {
  text: string;
  tier: 1 | 2;
  source: "stored" | "workedSteps" | "strategy" | "generic";
};

/** Tier 1a: fold an item's deterministic worked steps into one compact
 *  mini-lesson string. Returns null when there is nothing to show. */
export function workedStepsRevealLine(
  steps: { text: string }[] | undefined,
): string | null {
  if (!steps || steps.length === 0) return null;
  const joined = steps
    .map((s) => s.text.trim())
    .filter((t) => t.length > 0)
    .join(" ");
  return joined.length > 0 ? joined : null;
}

/**
 * Tier 1b: an authored, correct-by-construction strategy one-liner for the
 * no-derivation families (arithmetic facts + the missing-operand form). Uses ONLY
 * the item's own numbers (operands + answer), so it can never substitute a foreign
 * operand (the S8 ban). Returns null for any item it can't safely address — the
 * caller then falls to Tier 2.
 */
/**
 * Recover the operand structure of a DIRECT arithmetic FACT from its clean
 * "a op b = ?" stem (e.g. "6 + 1 = ?", "10 × 5 = ?", "3 − 1 = ?"), so a fact
 * template that never declared a `variant` still earns a Tier-1b strategy line.
 * The recovered numbers are the STEM's own numbers, so the S8 ban holds by
 * construction. Returns null for any stem that isn't a bare binary fact.
 */
function parseBinaryFactStem(stem: string | undefined): RevealVariant | null {
  if (!stem) return null;
  const m = stem
    .trim()
    .match(/^(\d+)\s*([+\-\u2212\u00d7*xX])\s*(\d+)\s*=\s*\?$/);
  if (!m) return null;
  const a = Number(m[1]);
  const b = Number(m[3]);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  const raw = m[2];
  const op: RevealVariant["op"] | null =
    raw === "+" ? "+" : raw === "-" || raw === "\u2212" ? "−" : "×";
  return { a, op, b };
}

export function strategyRevealLine(input: {
  correctAnswer: string;
  stem?: string;
  variant?: RevealVariant;
  form?: string;
}): string | null {
  const answer = input.correctAnswer.trim();
  if (!answer) return null;

  // Missing-operand form ("? × 8 = 56" / "8 × ? = 56"): fill the blank with the
  // revealed answer and show the completed fact. Every number is the stem's or
  // the answer — no foreign operand introduced.
  if (input.form === "missing" && input.stem && input.stem.includes("?")) {
    const filled = input.stem.replace("?", answer).replace(/\s*=\s*/, " = ").trim();
    return `The missing number is ${answer}, because ${filled}.`;
  }

  const v = input.variant ?? parseBinaryFactStem(input.stem);
  if (!v) return null;
  switch (v.op) {
    case "×":
      // A strategy framing (groups), not a bare restatement.
      return `That's ${v.a} groups of ${v.b}, which makes ${answer}.`;
    case "+": {
      const bigger = Math.max(v.a, v.b);
      const smaller = Math.min(v.a, v.b);
      const stepLabel = smaller === 1 ? "step" : "steps";
      return `Start at ${bigger} and count forward ${smaller} ${stepLabel} to reach ${answer}.`;
    }
    case "−":
      return `Take away ${v.b} from ${v.a} to get ${answer}.`;
    default:
      return null;
  }
}

/**
 * The precedence orchestrator: return the warm reveal line for a placement miss.
 * NEVER empty — Tier 2 is the total fallback.
 */
export function buildPlacementRevealLine(input: RevealLineInput): PlacementRevealLine {
  // A manipulative has no answer string to teach toward — keep it warm-generic.
  if (input.correctAnswer !== null) {
    // Tier 1c — a stored, pre-verified line wins (already vetted at gen time).
    const stored = input.storedRevealLine?.trim();
    if (stored) return { text: stored, tier: 1, source: "stored" };

    // Tier 1a — the item's own worked steps.
    const worked = workedStepsRevealLine(input.workedSteps);
    if (worked) return { text: worked, tier: 1, source: "workedSteps" };

    // Tier 1b — an authored strategy line for a template fact / missing-operand.
    if (input.kind === "template") {
      const strategy = strategyRevealLine({
        correctAnswer: input.correctAnswer,
        stem: input.stem,
        variant: input.variant,
        form: input.form,
      });
      if (strategy) return { text: strategy, tier: 1, source: "strategy" };
    }
  }

  // Tier 2 — the universal warm fallback.
  return { text: pickTier2Line(input.seed), tier: 2, source: "generic" };
}

// ── The S8 operand-substitution ban (verification) ──────────────────────────

/** Extract every numeric token from a line ("8×8=64" → [8, 8, 64]; "3/4" →
 *  [3, 4]). Digit runs with an optional decimal point; a fraction contributes its
 *  numerator + denominator separately (they are the tokens a reader sees). */
export function extractNumbers(s: string): number[] {
  const out: number[] = [];
  for (const m of s.matchAll(/\d+(?:\.\d+)?/g)) {
    const n = Number(m[0]);
    if (Number.isFinite(n)) out.push(n);
  }
  return out;
}

const EPS = 1e-9;

/**
 * The allowed number set for a line: the item's own numbers (`base`) plus every
 * value REACHED by one arithmetic step on any pair of them (+, −, ×, and exact
 * ÷) — so a legitimate derived intermediate like "8 × 8 = 64" (64 from the
 * operand 8) passes, while a foreign operand from a different example does not.
 */
function allowedNumberSet(base: number[]): number[] {
  const set = new Set<number>();
  const add = (x: number) => {
    if (Number.isFinite(x)) set.add(Math.round(x * 1e9) / 1e9);
  };
  for (const x of base) add(x);
  for (const x of base) {
    for (const y of base) {
      add(x + y);
      add(x - y);
      add(x * y);
      if (Math.abs(y) > EPS) add(x / y);
    }
  }
  return [...set];
}

/**
 * The S8 ban, mechanically: every number appearing in `line` must be one of the
 * item's own numbers (`allowedBase`) or a value reached by arithmetic on them.
 * A line that introduces any other (foreign) number is rejected.
 */
export function revealLineNumbersOk(line: string, allowedBase: number[]): boolean {
  const allowed = allowedNumberSet(allowedBase);
  const nums = extractNumbers(line);
  return nums.every((n) => allowed.some((a) => Math.abs(a - n) < EPS));
}

/**
 * The verification gate for a generation-time (Tier 1c) reveal line, before it is
 * stored on a `practiceItems` row. Rejects an empty/oversized line, a line with
 * Markdown, or one that violates the S8 ban against the item's own numbers
 * (`itemNumbers` = every number in the stem, plus the answer's number(s)).
 */
export const MAX_REVEAL_LINE_LEN = 240;

export function verifyRevealLine(
  line: string,
  itemNumbers: number[],
): { ok: true } | { ok: false; reason: string } {
  const trimmed = line.trim();
  if (trimmed.length < 4) return { ok: false, reason: "reveal line too short" };
  if (trimmed.length > MAX_REVEAL_LINE_LEN) return { ok: false, reason: "reveal line too long" };
  if (/(\*\*|__|^#|\n#)/.test(trimmed)) return { ok: false, reason: "reveal line has Markdown" };
  if (!revealLineNumbersOk(trimmed, itemNumbers)) {
    return { ok: false, reason: "reveal line introduces a foreign number (S8)" };
  }
  return { ok: true };
}
