import { describe, expect, test } from "vitest";
import {
  diceCount,
  diceDefaultCount,
  diceEventMatches,
  diceExpectedAnswer,
  diceFaces,
  diceFavorableCount,
  diceMostLikelyTotal,
  diceSolved,
  diceSumDistribution,
  DICE_BATCH_SIZE,
  initialDice,
  isSolved,
  parseDicePrediction,
  rollDiceFaces,
} from "../logic";
import { assertGradableManipulative, isGradableManipulative } from "../authoring";
import { isChallenge, type DiceSpec } from "../types";
import { gradeManipulativeSubmission } from "../grade";

function spec(overrides: Partial<DiceSpec>): DiceSpec {
  return {
    kind: "dice",
    id: "d",
    concept: "Probability",
    prompt: "Predict it.",
    diceType: "d6",
    ...overrides,
  };
}

describe("dice faces", () => {
  test("d6 / d20 are 1..n, coin is [0,1] (tails=0, heads=1)", () => {
    expect(diceFaces("d6")).toEqual([1, 2, 3, 4, 5, 6]);
    expect(diceFaces("d20")).toHaveLength(20);
    expect(diceFaces("d20")[19]).toBe(20);
    expect(diceFaces("coin")).toEqual([0, 1]);
  });
});

describe("rollDiceFaces (shared batch RNG)", () => {
  test("returns `count` faces, each a legal face of the die", () => {
    for (const diceType of ["d6", "d20", "coin"] as const) {
      const legal = new Set(diceFaces(diceType));
      for (const count of [1, 2, 3]) {
        const roll = rollDiceFaces(diceType, count);
        expect(roll).toHaveLength(count);
        for (const face of roll) expect(legal.has(face)).toBe(true);
      }
    }
  });

  test("a large sample of d6 covers every face (uniform-ish, never out of range)", () => {
    const seen = new Set<number>();
    for (let i = 0; i < 400; i++) seen.add(rollDiceFaces("d6", 1)[0]);
    expect([...seen].sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  test("count <= 0 yields an empty roll", () => {
    expect(rollDiceFaces("d6", 0)).toEqual([]);
  });

  test("DICE_BATCH_SIZE is 10", () => {
    expect(DICE_BATCH_SIZE).toBe(10);
  });
});

describe("dice events", () => {
  test("face / even / odd / atLeast / greaterThan match the right faces", () => {
    expect(diceEventMatches({ type: "face", value: 6 }, 6)).toBe(true);
    expect(diceEventMatches({ type: "face", value: 6 }, 5)).toBe(false);
    expect(diceEventMatches({ type: "even" }, 4)).toBe(true);
    expect(diceEventMatches({ type: "even" }, 3)).toBe(false);
    expect(diceEventMatches({ type: "odd" }, 3)).toBe(true);
    expect(diceEventMatches({ type: "odd" }, 0)).toBe(false); // coin tails is even
    expect(diceEventMatches({ type: "atLeast", value: 5 }, 5)).toBe(true);
    expect(diceEventMatches({ type: "greaterThan", value: 5 }, 5)).toBe(false);
    expect(diceEventMatches({ type: "greaterThan", value: 5 }, 6)).toBe(true);
  });

  test("favorable counts", () => {
    expect(diceFavorableCount("d6", { type: "even" })).toBe(3); // 2,4,6
    expect(diceFavorableCount("d6", { type: "greaterThan", value: 4 })).toBe(2); // 5,6
    expect(diceFavorableCount("coin", { type: "face", value: 1 })).toBe(1); // heads
    expect(diceFavorableCount("d20", { type: "atLeast", value: 18 })).toBe(3); // 18,19,20
  });
});

describe("sum distribution + most likely total", () => {
  test("2d6 sums to 7 as the single mode (6 ways)", () => {
    const dist = diceSumDistribution("d6", 2);
    expect(dist.get(2)).toBe(1);
    expect(dist.get(7)).toBe(6);
    expect(dist.get(12)).toBe(1);
    expect(diceMostLikelyTotal("d6", 2)).toBe(7);
  });
  test("2 coins → most likely total is 1", () => {
    expect(diceMostLikelyTotal("coin", 2)).toBe(1);
  });
  test("2d20 → most likely total is 21", () => {
    expect(diceMostLikelyTotal("d20", 2)).toBe(21);
  });
  test("distribution ways sum to faces^count", () => {
    const dist = diceSumDistribution("d6", 3);
    const total = [...dist.values()].reduce((a, b) => a + b, 0);
    expect(total).toBe(6 ** 3);
  });
});

describe("expected answer", () => {
  test("probability is favorable/total; count is /1; mostLikelyTotal is the mode /1", () => {
    expect(diceExpectedAnswer(spec({ prediction: { type: "probability", event: { type: "even" } } }))).toEqual({
      num: 3,
      den: 6,
    });
    expect(diceExpectedAnswer(spec({ prediction: { type: "favorableCount", event: { type: "even" } } }))).toEqual({
      num: 3,
      den: 1,
    });
    expect(
      diceExpectedAnswer(spec({ diceType: "d6", count: 2, prediction: { type: "mostLikelyTotal" } })),
    ).toEqual({ num: 7, den: 1 });
  });
});

describe("diceCount defaults", () => {
  test("single-die events default to 1 die, mostLikelyTotal to 2, clamped 1..10", () => {
    expect(diceDefaultCount({ type: "probability", event: { type: "even" } })).toBe(1);
    expect(diceDefaultCount({ type: "mostLikelyTotal" })).toBe(2);
    expect(diceCount(spec({ prediction: { type: "mostLikelyTotal" } }))).toBe(2);
    expect(diceCount(spec({ count: 99 }))).toBe(10);
    expect(diceCount(spec({ count: 0 }))).toBe(1);
  });
});

describe("diceSolved — value equality, any equivalent fraction passes", () => {
  const probEven = spec({ prediction: { type: "probability", event: { type: "even" } } });

  test("3/6 and 1/2 both pass for P(even)", () => {
    expect(diceSolved(probEven, { rollCount: 5, predicted: { num: 3, den: 6 } })).toBe(true);
    expect(diceSolved(probEven, { rollCount: 5, predicted: { num: 1, den: 2 } })).toBe(true);
    expect(diceSolved(probEven, { rollCount: 5, predicted: { num: 2, den: 6 } })).toBe(false);
  });

  test("uncommitted / malformed / sandbox never solve", () => {
    expect(diceSolved(probEven, initialDice())).toBe(false); // predicted null
    expect(diceSolved(probEven, { rollCount: 0, predicted: { num: 1, den: 0 } })).toBe(false); // den 0
    const sandbox = spec({}); // no prediction
    expect(diceSolved(sandbox, { rollCount: 9, predicted: { num: 1, den: 2 } })).toBe(false);
    expect(isChallenge(sandbox)).toBe(false);
    expect(isChallenge(probEven)).toBe(true);
  });

  test("count and mostLikelyTotal grade as integers", () => {
    const fav = spec({ prediction: { type: "favorableCount", event: { type: "greaterThan", value: 4 } } });
    expect(diceSolved(fav, { rollCount: 1, predicted: { num: 2, den: 1 } })).toBe(true);
    expect(diceSolved(fav, { rollCount: 1, predicted: { num: 3, den: 1 } })).toBe(false);
    const mode = spec({ count: 2, prediction: { type: "mostLikelyTotal" } });
    expect(diceSolved(mode, { rollCount: 1, predicted: { num: 7, den: 1 } })).toBe(true);
  });
});

describe("isSolved dispatch + server grade path", () => {
  const probHeads = spec({ diceType: "coin", prediction: { type: "probability", event: { type: "face", value: 1 } } });

  test("isSolved routes dice to diceSolved", () => {
    expect(isSolved(probHeads, { rollCount: 3, predicted: { num: 1, den: 2 } })).toBe(true);
    expect(isSolved(probHeads, { rollCount: 3, predicted: { num: 2, den: 3 } })).toBe(false);
  });

  test("gradeManipulativeSubmission re-runs isSolved over JSON, total on garbage", () => {
    const specJson = JSON.stringify(probHeads);
    expect(gradeManipulativeSubmission(specJson, JSON.stringify({ rollCount: 4, predicted: { num: 5, den: 10 } }))).toEqual({
      correct: true,
    });
    expect(gradeManipulativeSubmission(specJson, "not json")).toEqual({ correct: false });
    expect(gradeManipulativeSubmission(specJson, JSON.stringify({ nope: true }))).toEqual({ correct: false });
  });
});

describe("authoring gradability guard", () => {
  test("a well-formed prediction is gradable; a sandbox is not", () => {
    expect(isGradableManipulative(spec({ prediction: { type: "probability", event: { type: "even" } } }))).toBe(true);
    expect(isGradableManipulative(spec({ prediction: { type: "mostLikelyTotal" } }))).toBe(true);
    expect(isGradableManipulative(spec({}))).toBe(false);
    expect(() => assertGradableManipulative(spec({}))).toThrow(/Ungradable/);
    expect(() =>
      assertGradableManipulative(spec({ prediction: { type: "probability", event: { type: "even" } } })),
    ).not.toThrow();
  });
});

describe("parseDicePrediction (keypad-typed prediction)", () => {
  test("a probability fraction 'num/den'", () => {
    expect(parseDicePrediction("1/2")).toEqual({ num: 1, den: 2 });
    expect(parseDicePrediction("3/6")).toEqual({ num: 3, den: 6 });
    expect(parseDicePrediction(" 2 / 4 ")).toEqual({ num: 2, den: 4 });
  });

  test("a bare integer is den 1 (count / most-likely total, or P=0/1)", () => {
    expect(parseDicePrediction("3")).toEqual({ num: 3, den: 1 });
    expect(parseDicePrediction("0")).toEqual({ num: 0, den: 1 });
  });

  test("empty / partial / malformed entries are null (Commit stays disabled)", () => {
    expect(parseDicePrediction("")).toBeNull();
    expect(parseDicePrediction("   ")).toBeNull();
    expect(parseDicePrediction("1/")).toBeNull();
    expect(parseDicePrediction("/2")).toBeNull();
    expect(parseDicePrediction("1/2/3")).toBeNull();
    expect(parseDicePrediction("abc")).toBeNull();
    expect(parseDicePrediction("1.5")).toBeNull();
    expect(parseDicePrediction("1/2.5")).toBeNull();
  });

  test("a zero or negative denominator is rejected", () => {
    expect(parseDicePrediction("1/0")).toBeNull();
    expect(parseDicePrediction("-1/2")).toBeNull();
    expect(parseDicePrediction("1/-2")).toBeNull();
  });

  test("round-trips through the value-equality grader", () => {
    const probHeads = spec({
      diceType: "coin",
      prediction: { type: "probability", event: { type: "face", value: 1 } },
    });
    const parsed = parseDicePrediction("2/4");
    expect(parsed).not.toBeNull();
    expect(diceSolved(probHeads, { rollCount: 3, predicted: parsed! })).toBe(true);
  });
});
