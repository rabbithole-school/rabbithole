import { describe, expect, it } from "vitest";

import {
  DEMONSTRATED_SOURCES,
  FLUENT_REPS,
  isProvisional,
  STRUGGLING_MISS_THRESHOLD as SCHEDULER_STRUGGLING_MISS_THRESHOLD,
} from "../convex/lib/practice/scheduler";
import {
  masteryOf,
  computeCheckpointMarkers,
  railStrandsFit,
  STRAND_RAIL_ROW_MIN_PX,
  STRUGGLING_MISS_THRESHOLD,
  type TreeNode,
} from "./treeMapLayout";

// J1 (pilot9 judgment queue, Option A): the Tree/Knowledge map must render TWO
// distinct states — DEMONSTRATED credit (source ∈ DEMONSTRATED_SOURCES) goes the
// full "fluent" green; INFERRED credit that is only access-proven (placement /
// accelerated / re-probe) renders "placed" (provisional). This locks the PURE
// derivation the render fix threads through: source → demonstrated → mastery band.

/** Minimal TreeNode fixture — only the fields `masteryOf` reads matter. */
function node(over: Partial<TreeNode>): TreeNode {
  return {
    skillKey: "k",
    label: "K",
    domain: "d",
    repetition: FLUENT_REPS,
    proficiency: "fluent",
    retention: "fresh",
    frontier: false,
    ...over,
  };
}

describe("source → demonstrated (the same rule isFluent uses for the green claim)", () => {
  it("only source='practice' is a demonstrated credit", () => {
    expect(DEMONSTRATED_SOURCES.has("practice")).toBe(true);
    for (const inferred of ["placement", "accelerated", "reprobe", "scaffolded"]) {
      expect(DEMONSTRATED_SOURCES.has(inferred)).toBe(false);
    }
  });

  it("an access-proven inferred credit is provisional; a demonstrated one is not", () => {
    // The exact J1 bug row: placement credit at FLUENT_REPS the kid never proved.
    expect(isProvisional({ repetition: FLUENT_REPS, source: "placement" })).toBe(true);
    expect(isProvisional({ repetition: FLUENT_REPS, source: "accelerated" })).toBe(true);
    expect(isProvisional({ repetition: FLUENT_REPS, source: "reprobe" })).toBe(true);
    // Demonstrated practice at the same rep count is NOT provisional.
    expect(isProvisional({ repetition: FLUENT_REPS, source: "practice" })).toBe(false);
  });
});

describe("masteryOf render band — provisional vs demonstrated", () => {
  it("a fluent-by-reps INFERRED credit renders 'placed', never 'fluent'", () => {
    expect(masteryOf(node({ proficiency: "fluent", demonstrated: false }))).toBe("placed");
  });

  it("a fluent-by-reps DEMONSTRATED credit renders the full 'fluent' green", () => {
    expect(masteryOf(node({ proficiency: "fluent", demonstrated: true }))).toBe("fluent");
  });

  it("overlearned follows the same split (inferred → placed, demonstrated → overlearned)", () => {
    expect(masteryOf(node({ proficiency: "overlearned", demonstrated: false }))).toBe("placed");
    expect(masteryOf(node({ proficiency: "overlearned", demonstrated: true }))).toBe("overlearned");
  });

  it("omitting the flag (legacy/pre-flag callers) reads as demonstrated — nothing green goes hollow", () => {
    expect(masteryOf(node({ proficiency: "fluent" }))).toBe("fluent");
    expect(masteryOf(node({ proficiency: "overlearned" }))).toBe("overlearned");
  });

  it("below the fluent bar the demonstrated flag is irrelevant (no green to gate)", () => {
    expect(masteryOf(node({ proficiency: "practicing", demonstrated: false }))).toBe("frontier");
    expect(masteryOf(node({ proficiency: "not_started", frontier: true, demonstrated: false }))).toBe("frontier");
    expect(masteryOf(node({ proficiency: "not_started", frontier: false, demonstrated: false }))).toBe("locked");
  });
});

describe("end-to-end: the J1 scenario the deck traced", () => {
  it("a placement-credited node the kid never demonstrated is 'placed', a practiced one is 'fluent'", () => {
    // Mirrors buildScholarTree's derivation: demonstrated = source ∈ DEMONSTRATED_SOURCES.
    const demonstratedFrom = (source: string) => DEMONSTRATED_SOURCES.has(source);

    const placementNode = node({
      proficiency: "fluent", // proficiencyFromReps(FLUENT_REPS) — the buggy green
      demonstrated: demonstratedFrom("placement"),
    });
    const practiceNode = node({
      proficiency: "fluent",
      demonstrated: demonstratedFrom("practice"),
    });

    expect(masteryOf(placementNode)).toBe("placed");
    expect(masteryOf(practiceNode)).toBe("fluent");
  });
});

describe("struggling (red) — the teacher/parent-facing recent-miss state", () => {
  it("≥ STRUGGLING_MISS_THRESHOLD recent misses renders 'struggling'", () => {
    expect(STRUGGLING_MISS_THRESHOLD).toBe(2);
    expect(masteryOf(node({ proficiency: "practicing", missStreak: 2 }))).toBe("struggling");
    expect(masteryOf(node({ proficiency: "practicing", missStreak: 5 }))).toBe("struggling");
  });

  it("a single miss (below the bar) is NOT struggling — stays the rep-band state", () => {
    expect(masteryOf(node({ proficiency: "practicing", missStreak: 1 }))).toBe("frontier");
    expect(masteryOf(node({ proficiency: "practicing", missStreak: 0 }))).toBe("frontier");
  });

  it("struggling OVERRIDES a stale green (a previously-fluent skill just missed twice)", () => {
    // The freshest evidence is failure: a demonstrated-fluent node that then
    // logged two misses reads red to the teacher, not green.
    expect(masteryOf(node({ proficiency: "fluent", demonstrated: true, missStreak: 2 }))).toBe(
      "struggling",
    );
    expect(
      masteryOf(node({ proficiency: "overlearned", demonstrated: true, missStreak: 2 })),
    ).toBe("struggling");
  });

  it("is REDACTED for the scholar's own map: a missing missStreak never derives struggling", () => {
    // The server omits missStreak from a scholar's own read, so the field is
    // undefined there — the scholar keeps seeing the amber/rep-band state.
    expect(masteryOf(node({ proficiency: "practicing", missStreak: undefined }))).toBe("frontier");
    expect(masteryOf(node({ proficiency: "fluent", demonstrated: true }))).toBe("fluent");
  });

  it("a correct answer (missStreak reset to 0) supersedes the earlier misses", () => {
    // recordAttemptCore resets missStreak to 0 on a correct answer — the
    // "determination of fluency" that supersedes the streak — so the node
    // returns to its rep-band state.
    expect(masteryOf(node({ proficiency: "fluent", demonstrated: true, missStreak: 0 }))).toBe(
      "fluent",
    );
  });

  it("the shared/ mirror of STRUGGLING_MISS_THRESHOLD equals the scheduler's canonical value", () => {
    // shared/ deliberately keeps a LOCAL copy of the threshold because shared/
    // runtime code must not import from convex/. A test file MAY import from
    // convex/, so this drift-guard asserts the mirror can't silently diverge
    // from its canonical home (convex/lib/practice/scheduler.ts).
    expect(STRUGGLING_MISS_THRESHOLD).toBe(SCHEDULER_STRUGGLING_MISS_THRESHOLD);
  });
});

describe("computeCheckpointMarkers — the derived strand × grade milestone", () => {
  /** A grade-tagged node in a single strand; only the fields the derivation reads. */
  function cnode(over: Partial<TreeNode> & { skillKey: string; grade: string }): TreeNode {
    return {
      label: over.skillKey,
      domain: "wna",
      strand: "add-subtract",
      repetition: FLUENT_REPS,
      proficiency: "not_started",
      retention: "none",
      frontier: false,
      ...over,
    };
  }
  const green = (skillKey: string, grade: string) =>
    cnode({ skillKey, grade, proficiency: "fluent", demonstrated: true });
  const grey = (skillKey: string, grade: string) =>
    cnode({ skillKey, grade, proficiency: "not_started" });

  it("certifies a band only when EVERY node in it is demonstrated-green", () => {
    const nodes: TreeNode[] = [
      green("s0", "2"),
      green("s1", "2"),
      green("s2", "2"),
      green("s3", "3"),
      grey("s4", "3"),
    ];
    const markers = computeCheckpointMarkers({ nodes, edges: [] });
    const g2 = markers.find((m) => m.grade === "2")!;
    const g3 = markers.find((m) => m.grade === "3")!;

    expect(g2.status).toBe("certified");
    expect(g2.solid).toBe(3);
    expect(g2.total).toBe(3);

    expect(g3.status).toBe("in_progress");
    expect(g3.solid).toBe(1);
    expect(g3.total).toBe(2);
  });

  it("reports not_started when no node in the band is green yet", () => {
    const nodes: TreeNode[] = [grey("s0", "2"), grey("s1", "2")];
    const [m] = computeCheckpointMarkers({ nodes, edges: [] });
    expect(m.status).toBe("not_started");
    expect(m.solid).toBe(0);
  });

  it("does NOT count inferred 'placed' credit toward certification", () => {
    // Two demonstrated + one placement-credited (access-proven but not proven).
    const nodes: TreeNode[] = [
      green("s0", "2"),
      green("s1", "2"),
      cnode({ skillKey: "s2", grade: "2", proficiency: "fluent", demonstrated: false }),
    ];
    const [m] = computeCheckpointMarkers({ nodes, edges: [] });
    expect(m.status).toBe("in_progress"); // the placed node keeps it from certifying
    expect(m.solid).toBe(2);
    expect(m.total).toBe(3);
  });

  it("omits a band with fewer than MIN_CHECKPOINT_BAND nodes (a lone skill isn't a grade level)", () => {
    const nodes: TreeNode[] = [
      green("s0", "2"),
      green("s1", "2"),
      green("s4", "4"), // a lone grade-4 node → no marker
    ];
    const markers = computeCheckpointMarkers({ nodes, edges: [] });
    expect(markers.map((m) => m.grade)).toEqual(["2"]);
  });

  it("ignores ungraded nodes (they belong to no band)", () => {
    const nodes: TreeNode[] = [
      green("s0", "2"),
      green("s1", "2"),
      cnode({ skillKey: "u", grade: undefined as unknown as string }),
    ];
    const [m] = computeCheckpointMarkers({ nodes, edges: [] });
    expect(m.total).toBe(2);
  });

  it("positions later grades further right, in the same lane, with a stable id", () => {
    const nodes: TreeNode[] = [
      green("s0", "2"),
      green("s1", "2"),
      green("s2", "3"),
      green("s3", "3"),
    ];
    const markers = computeCheckpointMarkers({ nodes, edges: [] }, ["wna"]);
    const g2 = markers.find((m) => m.grade === "2")!;
    const g3 = markers.find((m) => m.grade === "3")!;
    expect(g2.lane).toBe(g3.lane); // same strand → same row
    expect(g2.xPct).toBeLessThan(g3.xPct); // grade boundary marches right
    expect(g2.id).toContain("add-subtract");
    expect(g2.id).toContain("g2");
  });

  it("keeps two different strands in different lanes", () => {
    const nodes: TreeNode[] = [
      cnode({ skillKey: "a0", grade: "2", strand: "add-subtract", proficiency: "fluent", demonstrated: true }),
      cnode({ skillKey: "a1", grade: "2", strand: "add-subtract", proficiency: "fluent", demonstrated: true }),
      cnode({ skillKey: "m0", grade: "2", strand: "mult-divide", proficiency: "fluent", demonstrated: true }),
      cnode({ skillKey: "m1", grade: "2", strand: "mult-divide", proficiency: "fluent", demonstrated: true }),
    ];
    const markers = computeCheckpointMarkers({ nodes, edges: [] });
    const lanes = new Set(markers.map((m) => m.lane));
    expect(markers.length).toBe(2);
    expect(lanes.size).toBe(2);
  });
});

// The rail's strand tier is all-or-nothing: overlapping pills do not degrade
// gracefully, they destroy each other, so the tier drops out and the domain
// headers carry the rail alone (Andy, 2026-08-19 — the iPad zoomed out).
describe("railStrandsFit", () => {
  it("keeps the strands when the rows are further apart than a pill is tall", () => {
    const rows = [0, 40, 80, 120].map((y) => y + STRAND_RAIL_ROW_MIN_PX);
    expect(railStrandsFit(rows)).toBe(true);
  });

  it("drops the tier when ANY adjacent pair is too close, not just the average", () => {
    // Three roomy gaps and one tight one: an average-based test would pass.
    expect(railStrandsFit([0, 100, 200, 205, 305])).toBe(false);
  });

  it("judges against the caller's own pill height", () => {
    const rows = [0, 26, 52];
    expect(railStrandsFit(rows, 24)).toBe(true);
    expect(railStrandsFit(rows, 30)).toBe(false); // native's larger type scale
  });

  it("shows the tier when there is nothing to collide with", () => {
    expect(railStrandsFit([])).toBe(true);
    expect(railStrandsFit([42])).toBe(true);
  });

  it("does not hide the tier on an unmeasured (NaN) row", () => {
    expect(railStrandsFit([0, Number.NaN, 100])).toBe(true);
  });
});
