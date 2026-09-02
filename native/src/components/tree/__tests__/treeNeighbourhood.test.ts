import { describe, expect, it } from "vitest";

import {
  deriveNeighbourhood,
  neighbourAccessibilityHint,
  neighbourAccessibilityLabel,
  nodeAccessibilityHint,
  nodeAccessibilityLabel,
  type NodeNeighbourhood,
} from "../treeNeighbourhood";

const data: NodeNeighbourhood = {
  node: { nodeKey: "fractions", label: "Add fractions", practiceServeable: true },
  edges: [
    { fromKey: "number_sense", toKey: "fractions", relation: "dependency", method: null, weight: null },
    { fromKey: "fractions", toKey: "mixed_numbers", relation: "dependency", method: null, weight: null },
    { fromKey: "fractions", toKey: "pizza", relation: "bridge", method: "observed", weight: 3 },
    { fromKey: "pizza", toKey: "fractions", relation: "bridge", method: null, weight: 1 },
  ],
  stories: [],
  neighbours: [
    { nodeKey: "number_sense", label: "Number sense" },
    { nodeKey: "mixed_numbers", label: "Mixed numbers" },
    { nodeKey: "pizza", label: "Pizza fractions" },
  ],
  neighbourMastery: { pizza: { mastery: "frontier" } },
};

describe("tree neighbourhood", () => {
  it("derives the canonical dependency and bridge vocabulary without duplicating a bridge", () => {
    expect(deriveNeighbourhood(data)).toMatchObject({
      prerequisites: [{ nodeKey: "number_sense", relation: "prerequisite" }],
      unlocks: [{ nodeKey: "mixed_numbers", relation: "unlock" }],
      bridges: [{ nodeKey: "pizza", relation: "bridge", observed: true, mastery: "frontier" }],
    });
  });

  it("keeps an observed bridge badge regardless of the edge response order", () => {
    const reversed = { ...data, edges: [...data.edges].reverse() };
    expect(deriveNeighbourhood(reversed)!.bridges[0]).toMatchObject({ observed: true });
  });

  it("provides an actionable label and hint for every accessible neighbour", () => {
    const bridge = deriveNeighbourhood(data)!.bridges[0];
    expect(neighbourAccessibilityLabel(bridge)).toBe("Connects to Pizza fractions");
    expect(neighbourAccessibilityHint(bridge)).toBe("Opens Pizza fractions in this skill map.");
  });

  it("labels map nodes independently of a relationship selected in the sheet", () => {
    const node = { label: "Add fractions", mastery: "frontier" as const };
    expect(nodeAccessibilityLabel(node)).toBe("Add fractions. frontier.");
    expect(nodeAccessibilityHint(node)).toBe("Opens details for Add fractions.");
  });
});
