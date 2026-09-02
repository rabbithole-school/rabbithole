import { describe, expect, test } from "vitest";
import { computeNewReveals, computeVisibleKeys, type RevealEdge } from "../reveals";

describe("computeVisibleKeys", () => {
  const chain: RevealEdge[] = [
    { fromKey: "a", toKey: "b" },
    { fromKey: "b", toKey: "c" },
    { fromKey: "c", toKey: "d" },
  ];

  test("shows roots and their direct dependents at zero state", () => {
    expect(
      computeVisibleKeys(
        ["a", "b", "c", "d"],
        chain,
        new Set(),
        new Set(),
        new Set(),
      ),
    ).toEqual(new Set(["a", "b"]));
  });

  test("keeps a challenged node with evidence visible", () => {
    expect(
      computeVisibleKeys(
        ["a", "b", "c", "d"],
        chain,
        new Set(),
        new Set(["c"]),
        new Set(),
      ),
    ).toEqual(new Set(["a", "b", "c", "d"]));
  });

  test("never un-reveals when the dynamic horizon regresses", () => {
    const revealed = new Set(["c"]);
    expect(
      computeVisibleKeys(
        ["a", "b", "c", "d"],
        chain,
        new Set(["a"]),
        new Set(["a"]),
        revealed,
      ).has("c"),
    ).toBe(true);
    expect(
      computeVisibleKeys(
        ["a", "b", "c", "d"],
        chain,
        new Set(),
        new Set(["a"]),
        revealed,
      ).has("c"),
    ).toBe(true);
  });
});

describe("computeNewReveals", () => {
  test("a linear chain reveals one hop before each node reaches the frontier", () => {
    const edges: RevealEdge[] = [
      { fromKey: "a", toKey: "b" },
      { fromKey: "b", toKey: "c" },
      { fromKey: "c", toKey: "d" },
    ];

    expect(
      computeNewReveals(
        "a",
        edges,
        new Set(),
        new Set(["a"]),
        new Set(["a"]),
        new Set(),
      ),
    ).toEqual(["c"]);
    expect(
      computeNewReveals(
        "b",
        edges,
        new Set(["a"]),
        new Set(["a", "b"]),
        new Set(["a", "b"]),
        new Set(["c"]),
      ),
    ).toEqual(["d"]);
  });

  test("a diamond reveals on the first available prerequisite and never double-fires", () => {
    const edges: RevealEdge[] = [
      { fromKey: "a", toKey: "x" },
      { fromKey: "b", toKey: "z" },
      { fromKey: "x", toKey: "y" },
      { fromKey: "z", toKey: "y" },
    ];

    expect(
      computeNewReveals(
        "a",
        edges,
        new Set(),
        new Set(["a"]),
        new Set(["a"]),
        new Set(),
      ),
    ).toEqual(["y"]);
    expect(
      computeNewReveals(
        "b",
        edges,
        new Set(["a"]),
        new Set(["a", "b"]),
        new Set(["a", "b"]),
        new Set(["y"]),
      ),
    ).toEqual([]);
  });

  test("does not stamp a pre-ship node already visible through another prerequisite", () => {
    const edges: RevealEdge[] = [
      { fromKey: "a", toKey: "x" },
      { fromKey: "b", toKey: "z" },
      { fromKey: "x", toKey: "y" },
      { fromKey: "z", toKey: "y" },
    ];

    expect(
      computeNewReveals(
        "b",
        edges,
        new Set(["a"]),
        new Set(["a", "b"]),
        new Set(["a", "b"]),
        new Set(),
      ),
    ).toEqual([]);
  });
});
