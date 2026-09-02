import { describe, it, expect } from "vitest";
import { computeFrontier, type ObsLite } from "../lib/knowledgeTreeFrontier";
import {
  FRACTIONS_TREE,
  HISTORICAL_THINKING_TREE,
} from "../lib/knowledgeTreeData";
import { canonicalNotation } from "../lib/standardNotation";

// Kai's evidence: 3 fraction concepts demonstrated, an OPEN misconception on
// "compare by size" — the scenario the UI demos.
const KAI_OBS: ObsLite[] = [
  { conceptLabel: "Partition a whole into equal parts", masteryLevel: 4, evidenceType: "demonstration" },
  { conceptLabel: "Equivalent fractions as fair trades", masteryLevel: 3.5, evidenceType: "demonstration" },
  { conceptLabel: "Fraction as a number on the number line", masteryLevel: 3, evidenceType: "demonstration" },
  {
    conceptLabel: "Compare fractions by size (1/8 vs 1/4)",
    masteryLevel: 1,
    evidenceType: "misconception_signal",
    misconceptionStatus: "open",
    evidenceSummary: "Believes 1/8 > 1/4 because 8 > 4.",
  },
];

function statusOf(nodes: { key: string; status: string }[], key: string) {
  return nodes.find((n) => n.key === key)?.status;
}

describe("computeFrontier — gap detection", () => {
  it("marks demonstrated nodes from matching evidence", () => {
    const r = computeFrontier(FRACTIONS_TREE, KAI_OBS);
    expect(statusOf(r.nodes, "partition")).toBe("demonstrated");
    expect(statusOf(r.nodes, "equivalent")).toBe("demonstrated");
    expect(statusOf(r.nodes, "quantity")).toBe("demonstrated");
  });

  it("flags an open misconception as a GAP (trigger ①), with a reason", () => {
    const r = computeFrontier(FRACTIONS_TREE, KAI_OBS);
    const compare = r.nodes.find((n) => n.key === "compare")!;
    expect(compare.status).toBe("gap");
    expect(compare.gapReason).toMatch(/misconception/i);
    expect(compare.evidence).toMatch(/1\/8/);
  });

  it("does NOT flag an addressed misconception as a gap", () => {
    const addressed = KAI_OBS.map((o) =>
      o.evidenceType === "misconception_signal"
        ? { ...o, misconceptionStatus: "addressed", masteryLevel: 3 }
        : o,
    );
    const r = computeFrontier(FRACTIONS_TREE, addressed);
    expect(statusOf(r.nodes, "compare")).not.toBe("gap");
  });

  it("treats an unmet, non-load-bearing downstream node as locked, NOT a gap", () => {
    // "Common denominators" is unmet but nothing active depends on it → locked.
    const r = computeFrontier(FRACTIONS_TREE, KAI_OBS);
    expect(statusOf(r.nodes, "commondenom")).toBe("locked");
  });

  it("with no evidence, nothing is a gap (the whole tree is just locked)", () => {
    const r = computeFrontier(FRACTIONS_TREE, []);
    expect(r.nodes.every((n) => n.status !== "gap")).toBe(true);
  });

  it("flags an unmet prerequisite of an active node as a blocking gap (trigger ②)", () => {
    // sourcing → corroboration (buildsTowards). Probe corroboration but never
    // sourcing: sourcing should surface as a gap supporting the active node.
    const obs: ObsLite[] = [
      { conceptLabel: "compare sources to corroborate", masteryLevel: 1, evidenceType: "probe" },
    ];
    const r = computeFrontier(HISTORICAL_THINKING_TREE, obs);
    const sourcing = r.nodes.find((n) => n.key === "sourcing")!;
    expect(sourcing.status).toBe("gap");
    expect(sourcing.gapReason).toMatch(/supports|prerequisite/i);
  });
});

describe("canonicalNotation — cross-source CCSS matching", () => {
  it("strips the cluster letter so the Tree fixture matches the corpus", () => {
    // Tree tags nodes "3.NF.A.3"; the imported corpus drops the cluster → "3.NF.3".
    expect(canonicalNotation("3.NF.A.3")).toBe("3.NF.3");
    expect(canonicalNotation("4.NF.B.3")).toBe("4.NF.3");
    expect(canonicalNotation("3.G.A.2")).toBe("3.G.2");
  });

  it("collapses a leaf component up to its parent standard", () => {
    // The corpus's clickable leaves are components ("3.NF.3a"); they belong to
    // the parent standard's Tree node.
    expect(canonicalNotation("3.NF.3a")).toBe("3.NF.3");
    expect(canonicalNotation("3.MD.7d")).toBe("3.MD.7");
  });

  it("is idempotent and leaves already-canonical / non-CCSS notations alone", () => {
    expect(canonicalNotation("3.NF.3")).toBe("3.NF.3");
    expect(canonicalNotation("K.CC.1")).toBe("K.CC.1");
    expect(canonicalNotation("MP.4")).toBe("MP.4");
    expect(canonicalNotation(undefined)).toBe("");
  });

  it("maps every fraction Tree node to a notation a real standard can carry", () => {
    // Each node's canonical form must be the parent-standard grain — no
    // surviving single-letter cluster *segment* past the domain — so
    // spineForStandard can match it against a corpus notation.
    for (const node of FRACTIONS_TREE.nodes) {
      const c = canonicalNotation(node.standard);
      expect(c).not.toBe("");
      const segs = c.split(".");
      expect(segs.slice(2).some((s) => /^[A-Z]$/.test(s))).toBe(false);
    }
  });
});
