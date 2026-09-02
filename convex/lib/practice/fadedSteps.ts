/**
 * Backward-faded worked examples (SPIKE) — Renkl/Atkinson faded worked
 * examples applied to the practice engine, run as a COMPLETION PROBLEM. A
 * multi-step procedure is shown worked for its EARLY steps, but the final,
 * answer-PRODUCING step is ALWAYS left for the scholar to finish — even at the
 * easiest level. So a worked example is never a finished answer key the scholar
 * can copy: the answer string never appears anywhere in the revealed scaffold.
 * As the scholar's fluency on the item's target skill grows, the blank just
 * grows backward from the END (hide the last 1 step → last 2 → … → bare), until
 * the scholar is solving a bare problem. A completion prompt ("your turn, finish
 * it") appears whenever there is still at least one revealed step to build on.
 *
 * Pure module (no Convex/React deps) — the fade level is a function of the
 * scholar's `practiceMastery` row for the SAME skill the scheduler already
 * reads (see scheduler.ts's Proficiency bands); no new mastery field, no
 * migration. Wired into serving in convex/practiceSkills.ts.
 *
 * ── Fade-level mapping (backward fading, by repetition) ──────────────────
 *   repetition 0 / no row               (not_started)  → level 1 — LAST step
 *                                                          faded (the
 *                                                          answer-producing
 *                                                          move is always the
 *                                                          scholar's; never a
 *                                                          full answer key)
 *   repetition 1                        (practicing)   → level 2 — last two
 *                                                          steps faded
 *   repetition 2                        (practicing)   → level 3 — last three
 *                                                          steps faded
 *   repetition ≥ FLUENT_REPS (accessProven, i.e.
 *     fluent / overlearned)                             → every step faded
 *                                                          (bare problem)
 * `scaffoldLevelFor` returns this RAW level (not clamped to any one item's
 * step count — it's a pure reading of mastery, independent of the item). The
 * minimum is always 1 (≥1 trailing step hidden) so the answer is never shown.
 * `applyFade`/`clampFadeLevel` clamp it to `steps.length`, so a short (e.g.
 * 3-step) item is already fully bare once fluent even though this function
 * would ask for more.
 */

import { accessProven } from "./scheduler";

/** A single worked step as stored server-side (`practiceItems.workedSteps`). */
export type WorkedStep = {
  /** The fully-worked step text. NEVER send this for a step that is faded. */
  text: string;
  /** What to show in place of `text` when this step is faded. Defaults to a
   *  generic placeholder (`DEFAULT_BLANK_TEXT`) when absent. */
  blankText?: string;
  /** TIER-2 HINT for the teaching moment (see `deriveStepHint`) — the same move
   *  this step performs, set up with its operands but left unevaluated. Only
   *  meaningful on the FINAL step (the only one the teaching moment blanks).
   *  Optional: absent means "derive it", which is what almost every item does. */
  hintText?: string;
};

export type RevealedWorkedStep = { text: string };
export type FadedWorkedStep = { blankText: string };

/** The client-safe fade result: revealed steps keep their text; faded steps
 *  carry ONLY a blank placeholder — never the real step text. */
export type FadeResult = {
  revealed: RevealedWorkedStep[];
  faded: FadedWorkedStep[];
  /** Present whenever there is at least one revealed step AND at least one
   *  faded step — a short COMPLETION prompt ("your turn, finish it") nudging
   *  the scholar to produce the answer themselves. Undefined once the problem
   *  is fully bare (nothing revealed): a bare problem is just a problem and
   *  needs no completion card. */
  selfExplainPrompt?: string;
};

export const DEFAULT_BLANK_TEXT = "___";

/**
 * Map a scholar's mastery row for this item's target skill to a RAW fade
 * level. See the module doc comment for the mapping table. `row` is whatever
 * subset of `practiceMastery` the caller has on hand — only `repetition`
 * matters here (kept minimal so callers don't need a full `Doc` when they
 * only have a partial read).
 *
 * The minimum is always 1 — a not-started / rep-0 scholar (or no row at all)
 * hides the LAST step, so the answer-producing move is never revealed. The
 * scaffold is a completion problem, not an answer key.
 *
 * No row (a scholar who has never touched this skill) reads identically to
 * `repetition: 0` — not_started, level 1 (last step faded).
 */
export function scaffoldLevelFor(row?: { repetition: number } | null): number {
  if (!row) return 1;
  // Once access-proven (fluent/overlearned), the scaffold is fully retired —
  // return a sentinel large enough to fade every step regardless of the
  // item's own step count; applyFade/clampFadeLevel do the clamping.
  if (accessProven(row)) return Number.POSITIVE_INFINITY;
  // +1 vs. the raw repetition so the minimum is always 1 (≥1 trailing step
  // hidden) — the answer-producing step is never shown, even at rep 0.
  return Math.max(1, Math.floor(row.repetition) + 1);
}

/** Clamp a raw fade level to a concrete item's step count — the number of
 *  steps actually faded for THAT item. Handles the `Infinity` sentinel from
 *  an access-proven scholar (fully bare) and any out-of-range input. */
export function clampFadeLevel(level: number, stepsLength: number): number {
  if (!Number.isFinite(level)) return stepsLength;
  return Math.max(0, Math.min(Math.floor(level), stepsLength));
}

/**
 * Apply a fade level to a worked-steps array. Steps fade from the END
 * backward: `revealed` keeps the FIRST `steps.length - level` steps verbatim;
 * `faded` replaces the remaining (trailing) steps with their blank
 * placeholder. A faded step's `text` never appears anywhere in the return
 * value — the anti-cheat discipline this repo applies to `answerCanonical`
 * applies here too, and (with the ≥1 minimum fade from `scaffoldLevelFor`)
 * the answer-producing final step is always among the faded, so the answer
 * string is never in `revealed`.
 */
export function applyFade(steps: WorkedStep[], level: number): FadeResult {
  const n = steps.length;
  const clamped = clampFadeLevel(level, n);
  const revealedCount = n - clamped;

  const revealed: RevealedWorkedStep[] = steps
    .slice(0, revealedCount)
    .map((s) => ({ text: s.text }));
  const faded: FadedWorkedStep[] = steps
    .slice(revealedCount)
    .map((s) => ({ blankText: s.blankText ?? DEFAULT_BLANK_TEXT }));

  // A COMPLETION prompt fires whenever there's still a revealed step to build
  // on AND at least one faded step to finish — "your turn, finish it". Once the
  // problem is fully bare (nothing revealed) it's just a problem: no card.
  let selfExplainPrompt: string | undefined;
  if (clamped > 0 && revealedCount > 0) {
    selfExplainPrompt = "Your turn — finish the last step and enter the answer.";
  }

  return { revealed, faded, selfExplainPrompt };
}

// ── The teaching moment's hint ladder (tier 2) ───────────────────────────────

/**
 * Derive the TIER-2 HINT for a blanked step: the same move it performs, with
 * its operands written out, but the result left open.
 *
 *   text:   "Add the partial quotients: 100 + 30 + 6 = 136."
 *   answer: "136"
 *   →       "Add the partial quotients: 100 + 30 + 6 = ?"
 *
 * This is the middle rung of the ladder a stuck scholar walks down. Tier 1 (the
 * step's `blankText`) NAMES the move — "Add the partial quotients: ?". Tier 2
 * SETS IT UP without doing it. Tier 3 is a person (the Socratic handoff). The
 * point is that each rung is strictly smaller than the last, so "I'm still
 * stuck" always has somewhere to go that isn't just the answer.
 *
 * DERIVED, not authored — built from the blanked step's OWN text, so the hint
 * can never drift from the step it hints at and can never assert the answer.
 * (An item may still override with an explicit `hintText` when its final step's
 * prose doesn't state the move arithmetically — a decimal-point placement, say.)
 *
 * Returns undefined when there is no usable hint — the answer is never asserted
 * as a result, or blanking it leaves no operands set up. Callers must treat that
 * as "no tier 2 for this item" and escalate straight to tier 3, never as an
 * error: for some families (add two like fractions) the move genuinely has no
 * honest middle rung, and inventing one would just be the answer in disguise.
 */
export function deriveStepHint(text: string, answer: string): string | undefined {
  const needle = answer.trim();
  if (!needle) return undefined;

  // Blank the answer only where it is ASSERTED AS A RESULT — after an `=`, or
  // trailing the sentence ("…the middle one is 7."). An operand that merely
  // happens to equal the answer ("8 × 1 = 8" when the answer is 1) is an INPUT
  // to the move, not a giveaway, and blanking it would destroy the hint.
  //
  // Every result position is blanked, not just the last: a step that states the
  // answer twice ("8 − 8 = 0, so 0/16 = 0") would otherwise leak it.
  const esc = needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // Not glued to a digit / decimal point / fraction bar, so "5" never matches
  // inside "557", "5.7" or "5/8".
  const tail = "(?![\\d]|[./]\\d)";
  let hint = text.replace(new RegExp(`(=\\s*)${esc}${tail}`, "g"), "$1?");
  hint = hint.replace(new RegExp(`(^|[^\\d./])${esc}${tail}\\s*\\.?\\s*$`), "$1?");

  if (hint === text) return undefined;
  // "…= ? = ?" (a value that was already in simplest form) reads as noise.
  hint = hint.replace(/=\s*\?(\s*=\s*\?)+/g, "= ?");
  // A hint that sets nothing up — no operands survived — is not a rung.
  if (!/\d/.test(hint)) return undefined;
  // A remaining RESULT-position occurrence would leak the answer outright.
  // Operand positions are intentionally left alone (see above), so the check
  // mirrors the blanking rule exactly rather than rejecting a usable hint.
  if (new RegExp(`=\\s*${esc}${tail}`).test(hint)) return undefined;
  if (new RegExp(`(^|[^\\d./])${esc}${tail}\\s*\\.?\\s*$`).test(hint)) return undefined;
  return hint.replace(/\s*\.\s*$/, "").trim();
}
