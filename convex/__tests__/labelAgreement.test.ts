import { describe, expect, test } from "vitest";
import {
  computeAgreement,
  computeTranscriptAgreement,
  maxPairwiseDisagreement,
  mean,
  roundTo,
  DISAGREEMENT_FLAG_THRESHOLD,
  type TurnLabelInput,
} from "../lib/labelAgreement";

// Pure unit tests for the agreement math (no Convex). Per
// rabbithole-test-strategy.md, the arithmetic is extracted here so it's
// testable without convex-test boilerplate.

describe("basic stats helpers", () => {
  test("mean", () => {
    expect(mean([])).toBeNull();
    expect(mean([3])).toBe(3);
    expect(mean([2, 4])).toBe(3);
    expect(mean([1, 2, 3, 4, 5])).toBe(3);
  });

  test("maxPairwiseDisagreement is max - min", () => {
    expect(maxPairwiseDisagreement([])).toBe(0);
    expect(maxPairwiseDisagreement([4])).toBe(0);
    expect(maxPairwiseDisagreement([2, 4])).toBe(2);
    expect(maxPairwiseDisagreement([5, 1, 3])).toBe(4);
  });

  test("roundTo", () => {
    expect(roundTo(3.333333)).toBe(3.33);
    expect(roundTo(3.005, 2)).toBe(3.01);
  });

  test("flag threshold is 2", () => {
    expect(DISAGREEMENT_FLAG_THRESHOLD).toBe(2);
  });
});

describe("computeAgreement", () => {
  const dimKeys = ["socratic", "sycophancy", "ageFit"];

  test("flags a cell when spread >= 2, not when spread < 2", () => {
    const labels = [
      { raterId: "alice", messageId: "m1", dims: { socratic: 2, sycophancy: 4 } },
      { raterId: "bob", messageId: "m1", dims: { socratic: 4, sycophancy: 5 } },
    ];
    const matrix = computeAgreement(labels, dimKeys, ["m1"]);

    const socratic = matrix.cells.find((c) => c.dimKey === "socratic")!;
    expect(socratic.min).toBe(2);
    expect(socratic.max).toBe(4);
    expect(socratic.spread).toBe(2);
    expect(socratic.mean).toBe(3);
    expect(socratic.flagged).toBe(true);
    expect(socratic.turnIndex).toBe(0);

    const syco = matrix.cells.find((c) => c.dimKey === "sycophancy")!;
    expect(syco.spread).toBe(1);
    expect(syco.flagged).toBe(false);

    expect(matrix.flaggedCells).toHaveLength(1);
    expect(matrix.flaggedCells[0].dimKey).toBe("socratic");
  });

  test("per-dimension summaries aggregate across turns", () => {
    const labels = [
      { raterId: "alice", messageId: "m1", dims: { socratic: 2 } },
      { raterId: "bob", messageId: "m1", dims: { socratic: 5 } },
      { raterId: "alice", messageId: "m2", dims: { socratic: 4 } },
      { raterId: "bob", messageId: "m2", dims: { socratic: 4 } },
    ];
    const matrix = computeAgreement(labels, dimKeys, ["m1", "m2"]);
    const socratic = matrix.dimSummaries.find((d) => d.dimKey === "socratic")!;
    expect(socratic.count).toBe(4);
    expect(socratic.mean).toBe(roundTo((2 + 5 + 4 + 4) / 4));
    expect(socratic.maxDisagreement).toBe(3); // m1 spread 3, m2 spread 0
    expect(socratic.flaggedTurnCount).toBe(1); // only m1 crosses the threshold
  });

  test("cells sort by turnIndex then rubric dim order", () => {
    const labels: TurnLabelInput[] = [
      { raterId: "alice", messageId: "m2", dims: { ageFit: 3, socratic: 3 } },
      { raterId: "alice", messageId: "m1", dims: { sycophancy: 3 } },
    ];
    const matrix = computeAgreement(labels, dimKeys, ["m1", "m2"]);
    // m1 (turnIndex 0) comes before m2 (turnIndex 1); within m2, socratic
    // (dim order 0) before ageFit (dim order 2).
    expect(matrix.cells.map((c) => [c.turnIndex, c.dimKey])).toEqual([
      [0, "sycophancy"],
      [1, "socratic"],
      [1, "ageFit"],
    ]);
  });

  test("distinct rater ids collected + sorted", () => {
    const labels = [
      { raterId: "bob", messageId: "m1", dims: { socratic: 3 } },
      { raterId: "alice", messageId: "m1", dims: { socratic: 3 } },
      { raterId: "bob", messageId: "m2", dims: { socratic: 3 } },
    ];
    const matrix = computeAgreement(labels, dimKeys, ["m1", "m2"]);
    expect(matrix.raterIds).toEqual(["alice", "bob"]);
  });

  test("single-rater cell has zero spread, never flagged", () => {
    const labels = [{ raterId: "alice", messageId: "m1", dims: { socratic: 1 } }];
    const matrix = computeAgreement(labels, dimKeys, ["m1"]);
    expect(matrix.cells[0].spread).toBe(0);
    expect(matrix.cells[0].flagged).toBe(false);
    expect(matrix.flaggedCells).toHaveLength(0);
  });
});

describe("computeTranscriptAgreement", () => {
  test("means + spread across raters; flags when spread >= 2", () => {
    const res = computeTranscriptAgreement([
      { raterId: "alice", overall: 2 },
      { raterId: "bob", overall: 5 },
      { raterId: "carol", overall: null },
    ]);
    expect(res.scores.map((s) => s.raterId)).toEqual(["alice", "bob"]);
    expect(res.mean).toBe(3.5);
    expect(res.min).toBe(2);
    expect(res.max).toBe(5);
    expect(res.spread).toBe(3);
    expect(res.flagged).toBe(true);
  });

  test("no overalls → empty, not flagged", () => {
    const res = computeTranscriptAgreement([{ raterId: "alice", overall: null }]);
    expect(res.scores).toHaveLength(0);
    expect(res.mean).toBeNull();
    expect(res.flagged).toBe(false);
  });
});
