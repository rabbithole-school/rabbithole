import { describe, expect, test } from "vitest";
import { computeDepths } from "../lib/practiceAtlasLayout";

// Pure-function test — no Convex runtime needed; runs with vanilla vitest.

describe("computeDepths", () => {
  test("single root has depth 0", () => {
    const depths = computeDepths(["a"], []);
    expect(depths.get("a")).toBe(0);
  });

  test("linear chain: A → B → C", () => {
    // fromKey=A, toKey=B means B builds on A
    const depths = computeDepths(
      ["a", "b", "c"],
      [
        { fromKey: "a", toKey: "b" },
        { fromKey: "b", toKey: "c" },
      ],
    );
    expect(depths.get("a")).toBe(0);
    expect(depths.get("b")).toBe(1);
    expect(depths.get("c")).toBe(2);
  });

  test("diamond DAG — longest path wins", () => {
    // a → b → d  (path length 2 to d)
    // a → c → d  (path length 2 to d)
    // Both paths the same length — depth of d should be 2
    const depths = computeDepths(
      ["a", "b", "c", "d"],
      [
        { fromKey: "a", toKey: "b" },
        { fromKey: "a", toKey: "c" },
        { fromKey: "b", toKey: "d" },
        { fromKey: "c", toKey: "d" },
      ],
    );
    expect(depths.get("a")).toBe(0);
    expect(depths.get("b")).toBe(1);
    expect(depths.get("c")).toBe(1);
    expect(depths.get("d")).toBe(2);
  });

  test("asymmetric diamond — longest path wins", () => {
    // a(0) → b(1) → c(2) → e(3)
    //              a(0) → d(1) → e(max(a→d→e=2, a→b→c→e=3) = 3)
    const depths = computeDepths(
      ["a", "b", "c", "d", "e"],
      [
        { fromKey: "a", toKey: "b" },
        { fromKey: "b", toKey: "c" },
        { fromKey: "c", toKey: "e" },
        { fromKey: "a", toKey: "d" },
        { fromKey: "d", toKey: "e" },
      ],
    );
    expect(depths.get("a")).toBe(0);
    expect(depths.get("b")).toBe(1);
    expect(depths.get("c")).toBe(2);
    expect(depths.get("d")).toBe(1);
    // e: prereqs are c (depth 2) and d (depth 1) → 1 + max(2, 1) = 3
    expect(depths.get("e")).toBe(3);
  });

  test("multiple roots", () => {
    // a(0) and b(0) are both roots; c builds on both → depth 1
    const depths = computeDepths(
      ["a", "b", "c"],
      [
        { fromKey: "a", toKey: "c" },
        { fromKey: "b", toKey: "c" },
      ],
    );
    expect(depths.get("a")).toBe(0);
    expect(depths.get("b")).toBe(0);
    expect(depths.get("c")).toBe(1);
  });

  test("edges to unknown nodes are ignored", () => {
    // 'phantom' is not in nodeKeys — should not throw or cause issues
    const depths = computeDepths(
      ["a", "b"],
      [
        { fromKey: "phantom", toKey: "b" },
        { fromKey: "a", toKey: "b" },
      ],
    );
    expect(depths.get("a")).toBe(0);
    // b's prerequisites include 'a' (depth 0) and 'phantom' (unknown/ignored)
    // The 'phantom' prereq is in the edge but 'phantom' isn't a registered node,
    // so prereqsOf['b'] still includes 'phantom'. depth('phantom') will be called
    // and return 0 (no prereqs). So b = 1 + max(0, 0) = 1.
    expect(depths.get("b")).toBe(1);
  });

  test("empty graph returns empty map", () => {
    const depths = computeDepths([], []);
    expect(depths.size).toBe(0);
  });

  test("whole-number-arithmetic smoke: roots are K skills", () => {
    // Regression: roots (no buildsOn prerequisites) should get depth 0.
    // Use a small slice of the real graph.
    const depths = computeDepths(
      ["count_to_10", "count_to_20", "count_on"],
      [{ fromKey: "count_to_10", toKey: "count_on" }],
    );
    expect(depths.get("count_to_10")).toBe(0);
    expect(depths.get("count_to_20")).toBe(0); // no incoming edges
    expect(depths.get("count_on")).toBe(1);
  });
});
