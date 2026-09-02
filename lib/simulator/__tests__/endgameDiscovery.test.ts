import { describe, expect, it } from "vitest";

import {
  ENDGAME_MAX_REMAINING,
  detectEndgameDefection,
} from "../endgameDiscovery";
import type { PolicyIR, PolicyPredicate, PolicyRule, PolicySelector } from "../policyIR";

// ── Tiny builders so the fixtures read like the strategies they encode ────────
function coop(): PolicySelector {
  return { kind: "action", actionKind: "cooperate", target: { kind: "none" } };
}
function defect(): PolicySelector {
  return { kind: "action", actionKind: "defect", target: { kind: "none" } };
}
function option(kind: "optionA" | "optionB"): PolicySelector {
  return { kind: "action", actionKind: kind, target: { kind: "none" } };
}
function roundsRemaining(op: "lt" | "lte" | "eq" | "gt" | "gte", value: number): PolicyPredicate {
  return { kind: "rounds_remaining", op, value };
}
function lastMove(actor: "self" | "opponent", move: "cooperate" | "defect"): PolicyPredicate {
  return { kind: "last_move", actor, move };
}
let ruleIdCounter = 0;
function rule(when: PolicyPredicate[], then: PolicySelector): PolicyRule {
  return { id: `rule-${(ruleIdCounter += 1)}`, when, then };
}
function policy(rules: PolicyRule[], slotId = "deckA"): Pick<PolicyIR, "slotId" | "rules"> {
  return { slotId, rules };
}

describe("detectEndgameDefection", () => {
  it("fires on cooperate-most, defect-in-the-final-round (backward induction)", () => {
    const signal = detectEndgameDefection(
      policy([
        rule([roundsRemaining("lte", 1)], defect()),
        rule([], coop()),
      ]),
    );
    expect(signal).not.toBeNull();
    expect(signal!.defectsAtEndgame).toBe(true);
    expect(signal!.endgameActions).toEqual(["defect"]);
    expect(signal!.baselineActions).toEqual(["cooperate"]);
    expect(signal!.slotId).toBe("deckA");
  });

  it("fires for a small defect tail (rounds_remaining < threshold)", () => {
    const signal = detectEndgameDefection(
      policy([
        rule([roundsRemaining("lt", 4)], defect()),
        rule([], coop()),
      ]),
    );
    expect(signal).not.toBeNull();
    expect(signal!.defectsAtEndgame).toBe(true);
  });

  it("fires on a horizon MOVE-SWITCH for matrixGame (no named defect)", () => {
    const signal = detectEndgameDefection(
      policy([
        rule([roundsRemaining("lte", 2)], option("optionB")),
        rule([], option("optionA")),
      ]),
    );
    expect(signal).not.toBeNull();
    // matrixGame "defection" is payoff-defined, so we only assert the switch.
    expect(signal!.defectsAtEndgame).toBe(false);
    expect(signal!.endgameActions).toEqual(["optionB"]);
    expect(signal!.baselineActions).toEqual(["optionA"]);
  });

  // ── The required NON-triggers ──────────────────────────────────────────────

  it("does NOT fire for grim-trigger (keys on opponent's last move, not the horizon)", () => {
    // Cooperate until the opponent defects, then defect forever — never
    // references rounds_remaining, so it can never be an endgame discovery.
    const grim = policy([
      rule([lastMove("opponent", "defect")], defect()),
      rule([], coop()),
    ]);
    expect(detectEndgameDefection(grim)).toBeNull();
  });

  it("does NOT fire for always-cooperate", () => {
    expect(detectEndgameDefection(policy([rule([], coop())]))).toBeNull();
  });

  it("does NOT fire for always-defect (no cooperative baseline)", () => {
    expect(detectEndgameDefection(policy([rule([], defect())]))).toBeNull();
  });

  it("does NOT fire when the horizon rule keeps playing the baseline move", () => {
    // rounds_remaining guard exists but selects the SAME move — no switch.
    const noSwitch = policy([
      rule([roundsRemaining("lte", 1)], defect()),
      rule([], defect()),
    ]);
    expect(detectEndgameDefection(noSwitch)).toBeNull();
  });

  it("does NOT fire for an OPENING rule (many rounds remain: gt/gte)", () => {
    // "While plenty of rounds remain, cooperate; otherwise Haiku decides" — the
    // rounds_remaining guard selects the opening, not the endgame.
    const opening = policy([
      rule([roundsRemaining("gt", 5)], coop()),
      rule([], defect()),
    ]);
    // The gt rule is a baseline (opening) cooperate; the empty-guard defect is
    // also baseline (not endgame-guarded) ⇒ no horizon switch detected.
    expect(detectEndgameDefection(opening)).toBeNull();
  });

  it("does NOT fire for a far-from-the-end eq guard (not the last move)", () => {
    const midGame = policy([
      rule([roundsRemaining("eq", ENDGAME_MAX_REMAINING + 10)], defect()),
      rule([], coop()),
    ]);
    expect(detectEndgameDefection(midGame)).toBeNull();
  });

  it("does NOT fire for a broad 'always after the opening' lte guard", () => {
    // rounds_remaining <= 49 in a 50-round game is near-always-defect, not an
    // endgame discovery; the threshold must be within the tail.
    const broad = policy([
      rule([roundsRemaining("lte", 49)], defect()),
      rule([], coop()),
    ]);
    expect(detectEndgameDefection(broad)).toBeNull();
  });

  it("ignores abstain/noop selectors as a baseline (no false discovery)", () => {
    // Endgame defect but the only other rule abstains — no cooperative baseline
    // is established, so we do not over-claim a discovery.
    const abstainBaseline = policy([
      rule([roundsRemaining("lte", 1)], defect()),
      rule([], { kind: "abstain" }),
    ]);
    expect(detectEndgameDefection(abstainBaseline)).toBeNull();
  });
});
