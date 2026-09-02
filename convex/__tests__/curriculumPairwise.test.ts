/**
 * Pure pairwise-judge helpers (convex/lib/curriculumSimShared.ts) for the
 * pairwise promote gate (adoptable #3 — addresses Finding 3). No model call:
 * we assert the ORDER-RANDOMIZATION is applied and correctly resolved (the
 * position-bias guard is the load-bearing bit), and that the judge prompt is
 * purely positional (never reveals which of A/B is the candidate). The judge
 * call itself + the promotion arithmetic are covered elsewhere
 * (curriculumScore.test.ts → isBetterPairwise/tallyPairwise).
 */
import { describe, expect, test } from "vitest";
import {
  assignPairwiseOrder,
  resolvePairwiseWinner,
  formatPairwiseForJudge,
  type SimActivity,
  type SimProfile,
  type SimTurn,
} from "../lib/curriculumSimShared";

describe("assignPairwiseOrder — position-bias randomization", () => {
  test("rand < 0.5 puts the candidate in slot A", () => {
    expect(assignPairwiseOrder(0).candidateLabel).toBe("A");
    expect(assignPairwiseOrder(0.49).candidateLabel).toBe("A");
  });

  test("rand >= 0.5 puts the candidate in slot B", () => {
    expect(assignPairwiseOrder(0.5).candidateLabel).toBe("B");
    expect(assignPairwiseOrder(0.99).candidateLabel).toBe("B");
  });

  test("both slots are reachable across the draw range (order is not fixed)", () => {
    const labels = new Set(
      [0, 0.25, 0.5, 0.75, 0.99].map((r) => assignPairwiseOrder(r).candidateLabel),
    );
    expect(labels).toEqual(new Set(["A", "B"]));
  });
});

describe("resolvePairwiseWinner — undo the randomization", () => {
  test("judge picks the slot the candidate was in → candidate wins", () => {
    expect(resolvePairwiseWinner("A", "A")).toBe("candidate");
    expect(resolvePairwiseWinner("B", "B")).toBe("candidate");
  });

  test("judge picks the OTHER slot → baseline wins", () => {
    expect(resolvePairwiseWinner("B", "A")).toBe("baseline");
    expect(resolvePairwiseWinner("A", "B")).toBe("baseline");
  });

  test("a tie stays a tie regardless of which slot the candidate held", () => {
    expect(resolvePairwiseWinner("tie", "A")).toBe("tie");
    expect(resolvePairwiseWinner("tie", "B")).toBe("tie");
  });

  test("round-trips for every combination (randomize → resolve is lossless)", () => {
    // The candidate always wins when the judge's raw pick equals its slot,
    // for BOTH possible slots — the property that makes randomized order safe.
    for (const rand of [0.1, 0.9]) {
      const { candidateLabel } = assignPairwiseOrder(rand);
      const other = candidateLabel === "A" ? "B" : "A";
      expect(resolvePairwiseWinner(candidateLabel, candidateLabel)).toBe("candidate");
      expect(resolvePairwiseWinner(other, candidateLabel)).toBe("baseline");
    }
  });
});

describe("formatPairwiseForJudge — positional, never leaks candidate/baseline", () => {
  const ACTIVITY: SimActivity = {
    title: "Halving Shapes",
    kind: "online",
    systemPrompt: "Guide them to discover halves.",
    learningGoal: "Understand that half = two equal parts.",
    deliverablePrompt: "Describe one shape split into equal halves.",
  };
  const PROFILE: SimProfile = {
    name: "Pip",
    readingLevel: "Grade 2",
    dossier: "7yo, loses the thread on multi-step problems.",
    traits: ["gives up quickly"],
  };
  const A: SimTurn[] = [
    { role: "tutor", content: "What do you notice about the square?" },
    { role: "scholar", content: "It has four sides." },
  ];
  const B: SimTurn[] = [
    { role: "tutor", content: "Here is the answer: cut it in half." },
    { role: "scholar", content: "ok" },
  ];

  test("renders both sessions labeled A/B with the shared activity + profile", () => {
    const out = formatPairwiseForJudge(ACTIVITY, PROFILE, A, B);
    expect(out).toContain("## SESSION A");
    expect(out).toContain("## SESSION B");
    expect(out).toContain("Halving Shapes");
    expect(out).toContain("Pip");
    expect(out).toContain("Understand that half = two equal parts.");
    // Positional only — the words "candidate"/"baseline" must never appear.
    expect(out.toLowerCase()).not.toContain("candidate");
    expect(out.toLowerCase()).not.toContain("baseline");
  });

  test("renders the turns of whichever transcript is passed into each slot", () => {
    const out = formatPairwiseForJudge(ACTIVITY, PROFILE, A, B);
    const aIdx = out.indexOf("## SESSION A");
    const bIdx = out.indexOf("## SESSION B");
    // A's content precedes the SESSION B header; B's follows it.
    expect(out.indexOf("four sides")).toBeGreaterThan(aIdx);
    expect(out.indexOf("four sides")).toBeLessThan(bIdx);
    expect(out.indexOf("Here is the answer")).toBeGreaterThan(bIdx);
  });
});
