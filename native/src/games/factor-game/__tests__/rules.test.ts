/**
 * `factor-game` rules — the pure core, tested away from any renderer.
 *
 * Ported from the retired `lib/manipulative/__tests__/logic.test.ts` block,
 * with the player vocabulary renamed (`ai` → `opponent`, matching `GameActor`)
 * and one test class deliberately absent: everything that asserted
 * `factorGameSolved`. There is no "solved" any more. A round finishes ahead,
 * behind, or level, and none of those is a grade.
 */
import { describe, expect, test } from "vitest";

import { MAX_CHOICE_OPTIONS, gameEventInputError } from "../../../../vendor/games/contract";
import factorGameModule from "../module";
import {
  applyChoice,
  applyFactors,
  applyMove,
  chooseOpponentMove,
  describeGiveaway,
  hasLegalMove,
  isLegalMove,
  isTerminal,
  initialState,
  MAX_BOARD_SIZE,
  legalMoves,
  netValue,
  outcomeOf,
  properFactors,
  rationaleFor,
  scores,
  type FactorConfig,
  type FactorState,
} from "../rules";

const cfg = (over: Partial<FactorConfig> = {}): FactorConfig => ({
  boardSize: 30,
  firstTurn: "scholar",
  ...over,
});

describe("properFactors", () => {
  test("excludes the number itself", () => {
    expect(properFactors(12)).toEqual([1, 2, 3, 4, 6]);
    expect(properFactors(7)).toEqual([1]);
    expect(properFactors(1)).toEqual([]);
  });

  test("is empty for non-positive or non-integer input", () => {
    expect(properFactors(0)).toEqual([]);
    expect(properFactors(-4)).toEqual([]);
    expect(properFactors(2.5)).toEqual([]);
  });
});

describe("legality", () => {
  test("1 is never legal — it has no proper factors to give away", () => {
    expect(isLegalMove(cfg(), initialState(cfg()), 1)).toBe(false);
  });

  test("off-board picks are illegal", () => {
    const c = cfg({ boardSize: 12 });
    expect(isLegalMove(c, initialState(c), 13)).toBe(false);
    expect(isLegalMove(c, initialState(c), 0)).toBe(false);
  });

  test("a claimed number is illegal, and so is one whose factors are all gone", () => {
    const c = cfg({ boardSize: 12 });
    let s = initialState(c);
    s = applyMove(c, s, 8); // scholar takes 8, opponent gets 1, 2, 4
    expect(s.claimedBy[8]).toBe("scholar");
    expect(isLegalMove(c, s, 8)).toBe(false);
    // 2's only proper factor is 1, which the opponent now holds.
    expect(isLegalMove(c, s, 2)).toBe(false);
  });

  test("legalMoves is exactly the set isLegalMove accepts", () => {
    const c = cfg({ boardSize: 20 });
    const s = applyMove(c, initialState(c), 18);
    const scanned = Array.from({ length: 20 }, (_, i) => i + 1).filter((n) =>
      isLegalMove(c, s, n),
    );
    expect(legalMoves(c, s)).toEqual(scanned);
  });
});

describe("applying a move", () => {
  test("the picker scores the number, the OTHER player takes its leftover factors", () => {
    const c = cfg({ boardSize: 12 });
    const s = applyMove(c, initialState(c), 8);
    expect(s.claimedBy[8]).toBe("scholar");
    expect(s.claimedBy[1]).toBe("opponent");
    expect(s.claimedBy[2]).toBe("opponent");
    expect(s.claimedBy[4]).toBe("opponent");
    expect(scores(s)).toEqual({ scholar: 8, opponent: 7 });
    expect(s.turn).toBe("opponent");
  });

  test("the two staged halves compose to exactly the atomic move", () => {
    const c = cfg({ boardSize: 12 });
    const atomic = applyMove(c, initialState(c), 12);
    const staged = applyFactors(c, applyChoice(c, initialState(c), 12), 12);
    expect(staged).toEqual(atomic);
  });

  test("applyChoice claims the number WITHOUT passing the turn", () => {
    const c = cfg({ boardSize: 12 });
    const mid = applyChoice(c, initialState(c), 8);
    expect(mid.claimedBy[8]).toBe("scholar");
    expect(mid.claimedBy[4]).toBeUndefined();
    expect(mid.turn).toBe("scholar");
    expect(mid.moveLog).toHaveLength(0);
  });

  test("an already-claimed factor is not re-given", () => {
    const c = cfg({ boardSize: 12 });
    let s = applyMove(c, initialState(c), 8); // opponent now holds 1, 2, 4
    s = applyMove(c, s, 12); // opponent picks 12; only 3 and 6 are left to give
    const move = s.moveLog[1];
    expect(move.picker).toBe("opponent");
    expect(move.factorsGivenToOpponent).toEqual([3, 6]);
    expect(s.claimedBy[3]).toBe("scholar");
    expect(s.claimedBy[6]).toBe("scholar");
  });

  test("an illegal pick is a no-op, so the reducer guards itself", () => {
    const c = cfg({ boardSize: 12 });
    const s = initialState(c);
    expect(applyMove(c, s, 1)).toBe(s);
    expect(applyMove(c, s, 99)).toBe(s);
  });

  test("the move log records who picked what and what it cost", () => {
    const c = cfg({ boardSize: 12 });
    const s = applyMove(c, initialState(c), 8);
    expect(s.moveLog).toEqual([
      { picker: "scholar", number: 8, factorsGivenToOpponent: [1, 2, 4] },
    ]);
  });

  test("firstTurn: opponent starts the opponent", () => {
    const c = cfg({ boardSize: 12, firstTurn: "opponent" });
    const s = applyMove(c, initialState(c), 8);
    expect(s.claimedBy[8]).toBe("opponent");
    expect(s.claimedBy[4]).toBe("scholar");
  });
});

describe("terminal detection", () => {
  test("only once no legal pick remains for ANYONE", () => {
    const c = cfg({ boardSize: 4 });
    let s = initialState(c);
    expect(hasLegalMove(c, s)).toBe(true);
    s = applyMove(c, s, 4); // scholar 4; opponent 1, 2 — 3 is left but its only factor is gone
    expect(isTerminal(c, s)).toBe(true);
  });

  test("unclaimed numbers at the end score for nobody", () => {
    const c = cfg({ boardSize: 4 });
    const s = applyMove(c, initialState(c), 4);
    expect(s.claimedBy[3]).toBeUndefined();
    expect(scores(s)).toEqual({ scholar: 4, opponent: 3 });
  });
});

describe("the opponent chooser", () => {
  test("picks a legal move that greedily maximizes net value", () => {
    const c = cfg({ boardSize: 12 });
    const s = initialState(c);
    const move = chooseOpponentMove(c, s);
    expect(move).not.toBeNull();
    expect(isLegalMove(c, s, move as number)).toBe(true);
    const best = Math.max(...legalMoves(c, s).map((n) => netValue(s, n)));
    expect(netValue(s, move as number)).toBe(best);
  });

  test("returns null when no legal move remains", () => {
    const c = cfg({ boardSize: 4 });
    const terminal: FactorState = {
      claimedBy: { 4: "scholar", 1: "opponent", 2: "opponent" },
      turn: "opponent",
      moveLog: [],
    };
    expect(chooseOpponentMove(c, terminal)).toBeNull();
  });

  test("is beatable — a scholar who takes the cheapest giveaways finishes ahead", () => {
    // The whole pedagogical point: greedy is a real opponent, not a perfect
    // one. If this ever fails because the chooser got smarter, that is a
    // regression in the teaching, not a win.
    const c = cfg({ boardSize: 30 });
    let s = initialState(c);
    let guard = 0;
    while (!isTerminal(c, s) && guard++ < 200) {
      const moves = legalMoves(c, s);
      if (s.turn === "scholar") {
        const best = [...moves].sort((a, b) => netValue(s, b) - netValue(s, a))[0];
        s = applyMove(c, s, best);
      } else {
        s = applyMove(c, s, chooseOpponentMove(c, s) as number);
      }
    }
    expect(isTerminal(c, s)).toBe(true);
    expect(scores(s).scholar).toBeGreaterThan(scores(s).opponent);
  });
});

describe("outcome", () => {
  test("is a KEY describing the standing, never a pass/fail", () => {
    expect(
      outcomeOf({ claimedBy: { 4: "scholar", 3: "opponent" }, turn: "scholar", moveLog: [] }),
    ).toBe("scholar_ahead");
    expect(
      outcomeOf({ claimedBy: { 3: "scholar", 4: "opponent" }, turn: "scholar", moveLog: [] }),
    ).toBe("opponent_ahead");
    expect(
      outcomeOf({ claimedBy: { 3: "scholar", 3: "scholar" }, turn: "scholar", moveLog: [] }),
    ).toBe("scholar_ahead");
    expect(outcomeOf({ claimedBy: {}, turn: "scholar", moveLog: [] })).toBe("tied");
  });
});

describe("evidence helpers", () => {
  test("describeGiveaway reads as a list, and says so when there is none", () => {
    expect(describeGiveaway([])).toBe("nothing");
    expect(describeGiveaway([1, 2, 4])).toBe("1, 2, 4");
  });

  test("rationaleFor names a prime pick as cheap", () => {
    const c = cfg({ boardSize: 30 });
    expect(rationaleFor(c, initialState(c), 29)).toMatch(/prime/);
  });

  test("rationaleFor names a net-negative pick as costing more than it scored", () => {
    const c = cfg({ boardSize: 30 });
    // 24 gives away 1+2+3+4+6+8+12 = 36 against a score of 24.
    expect(rationaleFor(c, initialState(c), 24)).toMatch(/handed over more/);
  });

  test("rationaleFor is an inference about the BOARD and never a claim about the child", () => {
    const c = cfg({ boardSize: 30 });
    const s = initialState(c);
    for (const n of legalMoves(c, s)) {
      const text = rationaleFor(c, s, n);
      expect(text).not.toMatch(/\b(you|they|understands?|knows?|struggl|master)/i);
    }
  });
});

describe("the module's codecs", () => {
  test("config.parse accepts a valid config and defaults firstTurn", () => {
    expect(factorGameModule.config.parse({ boardSize: 30 })).toEqual({
      boardSize: 30,
      firstTurn: "scholar",
    });
  });

  test("config.parse rejects garbage", () => {
    expect(() => factorGameModule.config.parse(null)).toThrow();
    expect(() => factorGameModule.config.parse({})).toThrow();
    expect(() => factorGameModule.config.parse({ boardSize: 4 })).toThrow();
    expect(() => factorGameModule.config.parse({ boardSize: 1000 })).toThrow();
    expect(() => factorGameModule.config.parse({ boardSize: 12.5 })).toThrow();
    expect(() => factorGameModule.config.parse({ boardSize: 30, firstTurn: "ai" })).toThrow();
  });

  test("state.create is deterministic for a fixed config and seed", () => {
    const config = cfg();
    const a = factorGameModule.state.create({ config, seed: "seed-1" });
    const b = factorGameModule.state.create({ config, seed: "seed-1" });
    expect(a).toEqual(b);
    expect(a).toEqual(initialState(config));
  });
});

/**
 * The seam that unit tests and the CI conformance test both miss: the screen
 * builds a payload, and the SERVER decides whether it is legal. Nothing checked
 * that those two agreed until a live round on a 30-board threw
 * `choice_made.among exceeds 24 options` on the very first tap. Rules can be
 * green, the manifest can be green, and the game can still be unplayable.
 */
describe("the events the screen emits survive the server validator", () => {
  const choiceEvent = (config: FactorConfig, state: FactorState, move: number) => ({
    eventKey: "scholar_pick",
    payload: {
      kind: "choice_made" as const,
      choice: String(move),
      // Verbatim from `Screen.tsx`.
      among: legalMoves(config, state).map(String),
    },
  });

  test("a first move on the LARGEST legal board is accepted", () => {
    const config = cfg({ boardSize: MAX_BOARD_SIZE });
    const state = initialState(config);
    const moves = legalMoves(config, state);
    expect(moves.length).toBeGreaterThan(MAX_CHOICE_OPTIONS / 2);
    expect(gameEventInputError(choiceEvent(config, state, moves[0]!))).toBeNull();
  });

  test("every event of a full self-played round is accepted", () => {
    const config = cfg({ boardSize: MAX_BOARD_SIZE });
    let state = initialState(config);
    let guard = 0;
    while (!isTerminal(config, state) && guard++ < 400) {
      const move = chooseOpponentMove(config, state);
      if (move == null) break;
      expect(gameEventInputError(choiceEvent(config, state, move))).toBeNull();
      state = applyMove(config, state, move);
    }
    expect(guard).toBeGreaterThan(1);
  });
});
