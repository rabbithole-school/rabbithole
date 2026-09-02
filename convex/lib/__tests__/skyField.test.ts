import { describe, expect, test } from "vitest";
import { hopTiers } from "../skyField";

describe("hopTiers", () => {
  test("linear chain buckets 0, 1, 2/3 merged, and 4+ as deep field", () => {
    const tiers = hopTiers(
      ["a"],
      [
        { s: "a", t: "b" },
        { s: "b", t: "c" },
        { s: "c", t: "d" },
        { s: "d", t: "e" },
      ],
      ["a", "b", "c", "d", "e"],
    );

    expect([...tiers.entries()]).toEqual([
      ["a", 0],
      ["b", 1],
      ["c", 2],
      ["d", 2],
      ["e", 3],
    ]);
  });

  test("branches inherit the shortest undirected distance from touched nodes", () => {
    const tiers = hopTiers(
      ["root"],
      [
        { s: "root", t: "left" },
        { s: "root", t: "right" },
        { s: "right", t: "right-child" },
      ],
      ["root", "left", "right", "right-child"],
    );

    expect(tiers.get("left")).toBe(1);
    expect(tiers.get("right")).toBe(1);
    expect(tiers.get("right-child")).toBe(2);
  });

  test("unreachable islands are tier 3", () => {
    const tiers = hopTiers(
      ["a"],
      [
        { s: "a", t: "b" },
        { s: "c", t: "d" },
      ],
      ["a", "b", "c", "d"],
    );

    expect(tiers.get("a")).toBe(0);
    expect(tiers.get("b")).toBe(1);
    expect(tiers.get("c")).toBe(3);
    expect(tiers.get("d")).toBe(3);
  });

  test("multi-source touched nodes run one BFS frontier", () => {
    const tiers = hopTiers(
      ["a", "e"],
      [
        { s: "a", t: "b" },
        { s: "b", t: "c" },
        { s: "c", t: "d" },
        { s: "d", t: "e" },
      ],
      ["a", "b", "c", "d", "e"],
    );

    expect(tiers.get("a")).toBe(0);
    expect(tiers.get("b")).toBe(1);
    expect(tiers.get("c")).toBe(2);
    expect(tiers.get("d")).toBe(1);
    expect(tiers.get("e")).toBe(0);
  });

  test("every nodeId is present, including isolated nodes and touched isolates", () => {
    const tiers = hopTiers(["touched-isolate"], [], ["touched-isolate", "lonely"]);

    expect(tiers.size).toBe(2);
    expect(tiers.get("touched-isolate")).toBe(0);
    expect(tiers.get("lonely")).toBe(3);
  });
});
