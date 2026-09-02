/**
 * ENDGAME-DEFECTION discovery — the read-model derivation behind the Debrief's
 * "discoveries" note (founder-approved, taste lane).
 *
 * In a finitely-repeated Prisoner's Dilemma the backward-induction-optimal play
 * against a cooperative or grim opponent is to cooperate almost the whole game
 * and defect on the final round(s): the horizon removes any future to punish the
 * betrayal. A scholar who FINDS this is doing real reasoning about horizons and
 * consequences, so the teacher Debrief surfaces it as a DISCOVERY to celebrate
 * and discuss — never as cheating, and with no scoring or scholar-facing change.
 *
 * WHY THE COMPILED POLICY IS THE HONEST SIGNAL. A deck's Species prompt compiles
 * to a bounded policy IR that is stored on the run (`compiledPolicySnapshot`).
 * We read that, not the tick-by-tick move log, for three reasons:
 *   1. INTENT, not luck. A rule guarded by `rounds_remaining` that switches the
 *      chosen move as the horizon closes is legible evidence the scholar reasoned
 *      about the endgame. A single last-round defect in a Haiku-fallback run could
 *      be noise; we deliberately do not celebrate noise as a discovery.
 *   2. GRIM IS SAFE BY CONSTRUCTION. A grim-trigger deck keys only on the
 *      opponent's last move (`last_move`), never on `rounds_remaining`, so it can
 *      never produce this fingerprint — exactly the required behaviour.
 *   3. It is a pure derivation over data already on the run: no extra reads, and
 *      it scales across a whole cohort's runs.
 *
 * The trade-off, stated honestly: a deck that reaches endgame defection through a
 * Haiku-fallback prompt with no compiled `rounds_remaining` rule is NOT detected.
 * That is the conservative, intent-first choice — a false negative beats
 * false-celebrating a coincidence.
 */

import type { NumericComparison, PolicyIR, PolicyPredicate } from "./policyIR";

/** Templates whose decks have a finite-horizon endgame to "find". */
export const ENDGAME_DISCOVERY_TEMPLATES: ReadonlySet<PolicyIR["templateId"]> =
  new Set(["prisonersDilemma", "matrixGame"]);

/**
 * How near the end a `rounds_remaining` guard must fire to count as the ENDGAME
 * (the "last move"), not a broad "always after the opening" rule. Five rounds is
 * a generous tail: `rounds_remaining <= 5`, `< 6`, or `== (0..5)` all qualify.
 */
export const ENDGAME_MAX_REMAINING = 5;

export interface EndgameDefectionSignal {
  slotId: string;
  /** Action kinds the policy selects when the horizon is closing. */
  endgameActions: string[];
  /** Action kinds the policy selects with rounds still to spare. */
  baselineActions: string[];
  /**
   * True when the endgame move is specifically `defect` (Prisoner's Dilemma
   * semantics). For matrixGame the "defection" move is payoff-defined, so the
   * signal reports only that the move SWITCHES at the horizon.
   */
  defectsAtEndgame: boolean;
}

/**
 * A predicate that fires only near the end of the game — an "end-selecting"
 * `rounds_remaining` guard. `gt`/`gte`/`neq` select the OPENING (many rounds
 * left) and are deliberately excluded.
 */
function isEndgamePredicate(predicate: PolicyPredicate): boolean {
  if (predicate.kind !== "rounds_remaining") return false;
  const { op, value } = predicate as { op: NumericComparison; value: number };
  switch (op) {
    // `remaining < value` ⇒ tail of the game; value is one past the last counted.
    case "lt":
      return value <= ENDGAME_MAX_REMAINING + 1;
    case "lte":
      return value <= ENDGAME_MAX_REMAINING;
    case "eq":
      return value <= ENDGAME_MAX_REMAINING;
    default:
      return false;
  }
}

function ruleIsEndgame(when: readonly PolicyPredicate[]): boolean {
  return when.some(isEndgamePredicate);
}

function selectedAction(then: PolicyIR["rules"][number]["then"]): string | null {
  return then.kind === "action" ? then.actionKind : null;
}

/**
 * Detect the endgame-defection fingerprint in one compiled policy: the deck plays
 * one way with rounds to spare and SWITCHES its move as the final round(s) close.
 * Returns null for policies that do not condition their move on the horizon
 * (including every grim-trigger deck) or that never establish a cooperative
 * baseline.
 */
export function detectEndgameDefection(
  policy: Pick<PolicyIR, "slotId" | "rules">,
): EndgameDefectionSignal | null {
  const endgame = new Set<string>();
  const baseline = new Set<string>();

  for (const rule of policy.rules) {
    const action = selectedAction(rule.then);
    if (action === null) continue; // noop / abstain establishes nothing.
    if (ruleIsEndgame(rule.when)) {
      endgame.add(action);
    } else {
      baseline.add(action);
    }
  }

  // A discovery requires a genuine SWITCH: an endgame move the deck does not also
  // play with rounds to spare. No endgame rule (grim) or no cooperative baseline
  // (always-defect) ⇒ no fingerprint.
  const switched = [...endgame].filter((action) => !baseline.has(action));
  if (switched.length === 0 || baseline.size === 0) return null;

  return {
    slotId: policy.slotId,
    endgameActions: [...endgame].sort(),
    baselineActions: [...baseline].sort(),
    defectsAtEndgame: switched.includes("defect"),
  };
}

/** The Socratic prompt the Debrief offers alongside the discoveries. */
export const ENDGAME_DISCUSSION_QUESTION =
  "What changes when nobody knows which round is last?";
