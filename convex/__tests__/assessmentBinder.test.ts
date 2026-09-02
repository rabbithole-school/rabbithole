import { describe, expect, test } from "vitest";
import {
  clusterEpisodes,
  claimStrength,
  buildDimensionBriefs,
  coverageLabel,
  heuristicDimension,
  type EvidenceItem,
} from "../lib/assessmentBinder";

const DAY = 24 * 60 * 60 * 1000;
const base = 1_000_000_000_000;

function item(over: Partial<EvidenceItem>): EvidenceItem {
  return {
    dimension: "core",
    source: "mastery",
    summary: "x",
    at: base,
    context: "Math",
    ...over,
  };
}

// The binder's whole job re: Carl's over-weighting worry: a pile of notes about
// the same thing must be ONE data point, and claim strength must come from
// DISTINCT CONTEXTS, never row count.

describe("clusterEpisodes — a pile of notes collapses to one exhibit", () => {
  test("five notes, same source+context+week → one episode with sources=5", () => {
    const items = Array.from({ length: 5 }, (_, i) =>
      item({ source: "obs:concern", context: "peer_conflict", at: base + i * 1000 }),
    );
    const episodes = clusterEpisodes(items);
    expect(episodes).toHaveLength(1);
    expect(episodes[0].sources).toBe(5);
  });

  test("same context but different weeks stays separate", () => {
    const items = [
      item({ context: "peer_conflict", at: base }),
      item({ context: "peer_conflict", at: base + 10 * DAY }),
    ];
    expect(clusterEpisodes(items)).toHaveLength(2);
  });

  test("a major in the cluster wins the episode weight + sorts first", () => {
    const episodes = clusterEpisodes([
      item({ source: "obs:praise", context: "c1", weight: "minor", at: base + DAY }),
      item({ source: "obs:praise", context: "c1", weight: "major", at: base }),
      item({ source: "obs:praise", context: "c2", weight: "minor", at: base }),
    ]);
    // c1 collapses to one major episode; it sorts ahead of the c2 minor.
    expect(episodes[0].weight).toBe("major");
    expect(episodes[0].context).toBe("c1");
  });
});

describe("claimStrength — from distinct contexts, not volume", () => {
  test("thresholds", () => {
    expect(claimStrength(0)).toBe("none");
    expect(claimStrength(1)).toBe("once");
    expect(claimStrength(2)).toBe("regular");
    expect(claimStrength(3)).toBe("consistent");
    expect(claimStrength(9)).toBe("consistent");
  });
});

describe("buildDimensionBriefs", () => {
  test("50 notes in ONE context is 'observed once', not 'consistent'", () => {
    const items = Array.from({ length: 50 }, (_, i) =>
      item({ dimension: "practice", source: "signal", context: "persistence", at: base + i * 1000 }),
    );
    const briefs = buildDimensionBriefs(items);
    // One context → one episode → claim strength is "once", and it's thin.
    expect(briefs.practice.distinctContexts).toBe(1);
    expect(briefs.practice.claimStrength).toBe("once");
    expect(briefs.practice.thin).toBe(true);
  });

  test("three distinct contexts earns 'consistent' and is not thin", () => {
    const items = [
      item({ dimension: "connections", source: "connection", context: "A+B", at: base }),
      item({ dimension: "connections", source: "connection", context: "C+D", at: base + 10 * DAY }),
      item({ dimension: "connections", source: "connection", context: "E+F", at: base + 20 * DAY }),
    ];
    const briefs = buildDimensionBriefs(items);
    expect(briefs.connections.distinctContexts).toBe(3);
    expect(briefs.connections.claimStrength).toBe("consistent");
    expect(briefs.connections.thin).toBe(false);
  });

  test("a dimension with no evidence is flagged thin with a Preflight-routing note", () => {
    const briefs = buildDimensionBriefs([]);
    expect(briefs.identity.thin).toBe(true);
    expect(briefs.identity.note.toLowerCase()).toContain("little evidence");
  });
});

describe("coverageLabel + heuristicDimension", () => {
  test("coverage ratios", () => {
    expect(coverageLabel(10, 0)).toBe("mostly-online");
    expect(coverageLabel(0, 10)).toBe("mostly-offline");
    expect(coverageLabel(5, 5)).toBe("balanced");
    expect(coverageLabel(0, 0)).toBe("mostly-offline");
  });

  test("heuristic mapping", () => {
    expect(heuristicDimension("mastery")).toBe("core");
    expect(heuristicDimension("connection")).toBe("connections");
    expect(heuristicDimension("deliverable")).toBe("practice");
    expect(heuristicDimension("seed")).toBe("identity");
    expect(heuristicDimension("signal", { signalType: "metacognition" })).toBe("practice");
    expect(heuristicDimension("signal", { signalType: "emotional_engagement" })).toBe("identity");
  });
});
