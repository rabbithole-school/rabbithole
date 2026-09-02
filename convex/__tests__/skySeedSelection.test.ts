import { describe, expect, test } from "vitest";
import {
  selectSkySeedCandidates,
  type SkySeedCandidate,
} from "../lib/skySeedSelection";

function candidate(
  targetId: string,
  overrides: Partial<SkySeedCandidate> = {},
): SkySeedCandidate {
  return {
    targetId,
    domain: "Physics",
    suggestionType: "frontier",
    curated: false,
    pinned: false,
    structured: false,
    threaded: false,
    recencyRank: 0,
    ...overrides,
  };
}

describe("selectSkySeedCandidates", () => {
  test("balances freshness with domain and anchor diversity", () => {
    const candidates = [
      candidate("physics-1", {
        connectionTo: "pressure",
        recencyRank: 0,
      }),
      candidate("physics-2", {
        connectionTo: "pressure",
        recencyRank: 1,
      }),
      candidate("biology", {
        domain: "Biology",
        connectionTo: "reciprocity",
        suggestionType: "leap",
        reach: 2,
        recencyRank: 2,
      }),
      candidate("history", {
        domain: "History",
        connectionTo: "scientific disagreement",
        suggestionType: "leap",
        reach: 2,
        recencyRank: 3,
      }),
    ];

    expect(
      selectSkySeedCandidates(candidates, 3).map((item) => item.targetId),
    ).toEqual(["biology", "history", "physics-1"]);
  });

  test("keeps a teacher-curated invitation competitive despite age", () => {
    const candidates = Array.from({ length: 8 }, (_, index) =>
      candidate(`fresh-${index}`, {
        domain: `Domain ${index}`,
        recencyRank: index,
      }),
    );
    candidates.push(
      candidate("curated", {
        domain: "Civics",
        curated: true,
        pinned: true,
        recencyRank: 30,
      }),
    );

    const selected = selectSkySeedCandidates(candidates, 8);
    expect(selected.map((item) => item.targetId)).toContain("curated");
  });

  test("uses the newest framing when multiple rows target one concept", () => {
    const selected = selectSkySeedCandidates(
      [
        candidate("shared-concept", { recencyRank: 0, domain: "Biology" }),
        candidate("shared-concept", { recencyRank: 4, domain: "History" }),
      ],
      2,
    );

    expect(selected).toHaveLength(1);
    expect(selected[0].domain).toBe("Biology");
  });
});
