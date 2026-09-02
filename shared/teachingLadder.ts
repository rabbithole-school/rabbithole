/**
 * The teaching moment's hint ladder — the one decision, shared by both frontends.
 *
 * After an honest "I haven't learned this yet", the scholar is handed ONE faded
 * worked step to finish. What happens when they submit is a ladder, not a verdict:
 *
 *   tier 1  the blank NAMES the move        ("Add the partial quotients: ?")
 *   tier 2  the hint SETS IT UP             ("100 + 30 + 6 = ?")
 *   tier 3  the Socratic companion tutor
 *   tier 4  the reveal
 *
 * The rule that makes it a ladder: **a wrong answer must not spend the reveal
 * while rungs remain below it.** The first version of this shipped as inline
 * component logic that set a terminal attempt state on ANY submission, which
 * collapsed tier 1 straight to tier 4 — so the ladder only ever served the
 * scholar who hesitated before guessing, and the one who guessed (the motivating
 * case) hit exactly the dead end it was built to remove.
 *
 * It lives here, as a pure function, for two reasons: it is the kind of small
 * state machine that silently drifts when copied across web and native, and a
 * component can't be unit-tested in this repo (no React testing library, and
 * adding one for this isn't worth it).
 */

/** What the scholar has already been given when they submit. */
export type TeachingLadderState = {
  /** A tier-2 hint exists for this step. Not every step can derive one. */
  hasHint: boolean;
  /** The tier-2 hint has already been shown. */
  hintShown: boolean;
};

/** How the surface should respond to this submission. */
export type TeachingLadderMove =
  /** They got it. Show the completed scaffold with their value in place. */
  | { kind: "solved"; outcome: "solved" | "hint" }
  /** Wrong, but a rung remains: surface the hint and let them go again. */
  | { kind: "hint"; outcome: "hint" }
  /** Wrong with the ladder exhausted: reveal. */
  | { kind: "reveal"; outcome: "stuck" };

/**
 * Decide the next rung.
 *
 * `outcome` is the value to report to `recordTeachingOutcome`, whose stored
 * depth is monotone (solved < hint < stuck) — so a scholar who misses, takes the
 * hint and then succeeds records `hint` both times and settles honestly on
 * "needed a nudge" rather than either "solved it cold" or "ran out of road".
 */
export function nextTeachingMove(
  correct: boolean,
  { hasHint, hintShown }: TeachingLadderState,
): TeachingLadderMove {
  if (correct) return { kind: "solved", outcome: hintShown ? "hint" : "solved" };
  if (hasHint && !hintShown) return { kind: "hint", outcome: "hint" };
  return { kind: "reveal", outcome: "stuck" };
}

/**
 * Whether the "I'm still stuck" affordance has anywhere to go — the hint if it
 * is still unspent, otherwise the tutor. With neither, the ladder ends at the
 * blank and the link is hidden rather than shown as a no-op.
 */
export function stillStuckAvailable(
  { hasHint, hintShown }: TeachingLadderState,
  canEscalate: boolean,
): boolean {
  return (hasHint && !hintShown) || canEscalate;
}
