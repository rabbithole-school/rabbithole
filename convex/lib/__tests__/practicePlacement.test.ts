import { describe, expect, test } from "vitest";
import {
  topoOrderStrand,
  strandOrders,
  nextStrandProbe,
  strandFrontier,
  isStrandConverged,
  probeOutcomeFromKind,
  DEFAULT_PLACEMENT_STRAND,
  PLACEMENT_HALF_LIFE_DAYS,
  EARNED_HALF_LIFE_DAYS,
  MAX_PROBES_PER_STRAND,
  type ProbeOutcome,
} from "../practice/placement";

// ─────────────────────────────────────────────────────────────────────────
// Pure per-strand adaptive placement (roadmap §3): topological ordering within
// a strand + a binary search that converges on the frontier in ~3–4 probes,
// "trusting upward" (crediting everything below the frontier). These tests own
// the ordering fully, so they pin the ALGORITHM independent of the graph seed.
// ─────────────────────────────────────────────────────────────────────────

/** Build a simple chain-ordered strand of `n` templated-looking node keys. */
function chain(prefix: string, n: number) {
  const nodes = Array.from({ length: n }, (_, i) => ({
    nodeKey: `${prefix}${i}`,
    strand: prefix,
    order: i,
  }));
  const edges = Array.from({ length: n - 1 }, (_, i) => ({
    fromKey: `${prefix}${i}`,
    toKey: `${prefix}${i + 1}`,
  }));
  return { nodes, edges, keys: nodes.map((x) => x.nodeKey) };
}

/**
 * Drive the adaptive search to convergence against a hidden `trueFrontier`
 * (scholar answers correct iff a node's index < trueFrontier). Models a scholar
 * with no SLIPS: a genuine miss is an honest "don't know" (`"unknown"`), which
 * caps immediately — so these algorithm invariants are unchanged by the
 * confirm-before-cap slip path (which only a `"incorrect"` outcome triggers).
 * Returns the probe transcript and the resolved frontier.
 */
function simulate(
  orderedKeys: string[],
  trueFrontier: number,
  opts: {
    isProbeable?: (k: string) => boolean;
    maxProbes?: number;
    resumeFloor?: number;
  } = {},
) {
  const isProbeable = opts.isProbeable ?? (() => true);
  const outcomes: ProbeOutcome[] = [];
  const probeIndices: number[] = [];
  for (let guard = 0; guard < 100; guard++) {
    const probe = nextStrandProbe(orderedKeys, isProbeable, outcomes, {
      maxProbes: opts.maxProbes,
      resumeFloor: opts.resumeFloor,
    });
    if (!probe) break;
    probeIndices.push(probe.index);
    outcomes.push(
      probeOutcomeFromKind(probe.probeKey, probe.index < trueFrontier ? "correct" : "unknown"),
    );
  }
  const frontier = strandFrontier("s", orderedKeys, outcomes, opts.resumeFloor ?? 0);
  return { outcomes, probeIndices, frontier };
}

describe("placement — topological ordering within a strand", () => {
  test("orders nodes by buildsOn prerequisites, not insertion order", () => {
    // Deliberately shuffled input; edges force c → b → a → d.
    const nodes = [
      { nodeKey: "a", order: 5 },
      { nodeKey: "d", order: 6 },
      { nodeKey: "c", order: 7 },
      { nodeKey: "b", order: 8 },
    ];
    const edges = [
      { fromKey: "c", toKey: "b" },
      { fromKey: "b", toKey: "a" },
      { fromKey: "a", toKey: "d" },
    ];
    expect(topoOrderStrand(nodes, edges)).toEqual(["c", "b", "a", "d"]);
  });

  test("breaks ties by the node's order field (then key), degrading to display order with no edges", () => {
    const nodes = [
      { nodeKey: "z", order: 2 },
      { nodeKey: "y", order: 0 },
      { nodeKey: "x", order: 1 },
    ];
    expect(topoOrderStrand(nodes, [])).toEqual(["y", "x", "z"]);
  });

  test("only intra-strand edges matter; a cross-set edge endpoint is ignored", () => {
    const nodes = [
      { nodeKey: "a", order: 0 },
      { nodeKey: "b", order: 1 },
    ];
    // edge references "outside" which is not in the set → ignored
    const edges = [
      { fromKey: "outside", toKey: "a" },
      { fromKey: "a", toKey: "b" },
    ];
    expect(topoOrderStrand(nodes, edges)).toEqual(["a", "b"]);
  });

  test("strandOrders partitions by strand and collapses missing strand to the default", () => {
    const nodes = [
      { nodeKey: "a1", strand: "add", order: 0 },
      { nodeKey: "m1", strand: "mult", order: 0 },
      { nodeKey: "u1", order: 0 }, // no strand
      { nodeKey: "a2", strand: "add", order: 1 },
    ];
    const edges = [{ fromKey: "a1", toKey: "a2" }];
    const orders = strandOrders(nodes, edges);
    const byStrand = new Map(orders.map((o) => [o.strand, o.orderedKeys]));
    expect(byStrand.get("add")).toEqual(["a1", "a2"]);
    expect(byStrand.get("mult")).toEqual(["m1"]);
    expect(byStrand.get(DEFAULT_PLACEMENT_STRAND)).toEqual(["u1"]);
  });
});

describe("placement — adaptive binary-search convergence (~3–4 probes)", () => {
  test("converges on the exact frontier in ≤4 probes for a 13-node strand", () => {
    const { keys } = chain("s", 13);
    // A ~13-node strand ⇒ ceil(log2(14)) = 4 probes is the worst case.
    for (let f = 0; f <= 13; f++) {
      const { probeIndices, frontier } = simulate(keys, f, { maxProbes: 20 });
      expect(frontier.frontierIndex).toBe(f);
      expect(probeIndices.length).toBeLessThanOrEqual(4);
    }
  });

  test("frontierKey is the first not-yet-mastered node; null when the whole strand is credited", () => {
    const { keys } = chain("s", 13);
    const mid = simulate(keys, 7, { maxProbes: 20 }).frontier;
    expect(mid.frontierKey).toBe("s7");
    expect(mid.creditedKeys).toEqual(["s0", "s1", "s2", "s3", "s4", "s5", "s6"]);

    const top = simulate(keys, 13, { maxProbes: 20 }).frontier;
    expect(top.frontierKey).toBeNull(); // scholar is beyond this strand
    expect(top.creditedKeys).toHaveLength(13);

    const bottom = simulate(keys, 0, { maxProbes: 20 }).frontier;
    expect(bottom.frontierKey).toBe("s0");
    expect(bottom.creditedKeys).toEqual([]);
  });

  test("a bigger strand still converges within a handful of probes", () => {
    const { keys } = chain("s", 31);
    const { probeIndices, frontier } = simulate(keys, 19, { maxProbes: 20 });
    expect(frontier.frontierIndex).toBe(19);
    expect(probeIndices.length).toBeLessThanOrEqual(5); // ceil(log2(32)) = 5
  });

  test("isStrandConverged flips true exactly when no probe remains", () => {
    const { keys } = chain("s", 8);
    const outcomes: ProbeOutcome[] = [];
    expect(isStrandConverged(keys, () => true, outcomes)).toBe(false);
    // answer every offered probe correctly → converges to the top
    for (let g = 0; g < 20; g++) {
      const p = nextStrandProbe(keys, () => true, outcomes, { maxProbes: 20 });
      if (!p) break;
      outcomes.push(probeOutcomeFromKind(p.probeKey, "correct"));
    }
    expect(isStrandConverged(keys, () => true, outcomes, { maxProbes: 20 })).toBe(true);
    expect(strandFrontier("s", keys, outcomes).frontierIndex).toBe(8);
  });
});

describe("placement — trust upward (generous crediting, self-correcting)", () => {
  test("credits every node below the frontier, including one that was individually missed", () => {
    const { keys } = chain("s", 10);
    // Non-monotone reality: passes a HARD node (index 6) but misses an EASY one
    // (index 2). Trust upward: the higher pass dominates → credit through 6.
    const outcomes: ProbeOutcome[] = [
      probeOutcomeFromKind("s2", "incorrect"),
      probeOutcomeFromKind("s6", "correct"),
    ];
    const f = strandFrontier("s", keys, outcomes);
    expect(f.frontierIndex).toBe(7); // 1 + max passed index
    expect(f.creditedKeys).toContain("s2"); // the missed easy node is still credited
    expect(f.frontierKey).toBe("s7");
  });

  test("a wrong answer only lowers the ceiling above the confirmed-pass floor", () => {
    const { keys } = chain("s", 10);
    // Pass 4, then miss 3 (below the pass): the miss is ignored (trust upward).
    const outcomes: ProbeOutcome[] = [
      probeOutcomeFromKind("s4", "correct"),
      probeOutcomeFromKind("s3", "incorrect"),
    ];
    expect(strandFrontier("s", keys, outcomes).frontierIndex).toBe(5);
  });

  test("everything wrong ⇒ placed at the very bottom (nothing credited)", () => {
    const { keys } = chain("s", 6);
    const { frontier } = simulate(keys, 0, { maxProbes: 20 });
    expect(frontier.frontierIndex).toBe(0);
    expect(frontier.creditedKeys).toEqual([]);
    expect(frontier.frontierKey).toBe("s0");
  });
});

describe("placement — per-strand independence", () => {
  test("each strand's frontier is found independently (strong in one, weak in another)", () => {
    const add = chain("add", 12);
    const mult = chain("mult", 12);
    // Strong in add (through 9), weak in mult (through 2).
    const addF = simulate(add.keys, 9, { maxProbes: 20 }).frontier;
    const multF = simulate(mult.keys, 2, { maxProbes: 20 }).frontier;
    expect(addF.frontierIndex).toBe(9);
    expect(multF.frontierIndex).toBe(2);
    // No cross-contamination: add's credit set never mentions a mult node.
    expect(addF.creditedKeys.every((k) => k.startsWith("add"))).toBe(true);
    expect(multF.creditedKeys.every((k) => k.startsWith("mult"))).toBe(true);
  });

  test("strandFrontier ignores outcomes belonging to other strands", () => {
    const { keys } = chain("add", 6);
    const outcomes: ProbeOutcome[] = [
      probeOutcomeFromKind("add2", "correct"),
      probeOutcomeFromKind("mult5", "correct"), // foreign strand — must be ignored
    ];
    expect(strandFrontier("add", keys, outcomes).frontierIndex).toBe(3);
  });
});

describe("placement — resume from a paused diagnostic", () => {
  test("a resume floor is honored: the search never re-probes below it and credits it", () => {
    const { keys } = chain("s", 16);
    // Previously confirmed floor 8 (persisted), no fresh outcomes this session.
    const probe = nextStrandProbe(keys, () => true, [], { resumeFloor: 8 });
    expect(probe).not.toBeNull();
    expect(probe!.index).toBeGreaterThanOrEqual(8);
    // Finalizing with only the floor credits everything below it.
    const f = strandFrontier("s", keys, [], 8);
    expect(f.frontierIndex).toBe(8);
    expect(f.creditedKeys).toEqual(keys.slice(0, 8));
  });

  test("resuming then finishing lands on the same frontier as an uninterrupted run", () => {
    const { keys } = chain("s", 16);
    const trueFrontier = 11;

    // Uninterrupted.
    const straight = simulate(keys, trueFrontier, { maxProbes: 20 }).frontier;

    // Interrupted: run a couple of probes, persist the floor, resume from it.
    const partial: ProbeOutcome[] = [];
    for (let i = 0; i < 2; i++) {
      const p = nextStrandProbe(keys, () => true, partial, { maxProbes: 20 });
      if (!p) break;
      partial.push(probeOutcomeFromKind(p.probeKey, p.index < trueFrontier ? "correct" : "unknown"));
    }
    const persistedFloor = strandFrontier("s", keys, partial).frontierIndex;
    // Fresh session: transcript lost, resume only from the persisted floor.
    const resumed = simulate(keys, trueFrontier, {
      maxProbes: 20,
      resumeFloor: persistedFloor,
    }).frontier;

    expect(resumed.frontierIndex).toBe(straight.frontierIndex);
    expect(resumed.frontierIndex).toBe(trueFrontier);
  });
});

describe("placement — non-probeable (concept) nodes", () => {
  test("probes the nearest probeable node to the midpoint, still crediting concept nodes below", () => {
    const { keys } = chain("s", 12);
    // Odd indices are concept-only (no template) → not probeable.
    const isProbeable = (k: string) => Number(k.slice(1)) % 2 === 0;
    const { probeIndices, frontier } = simulate(keys, 7, { isProbeable, maxProbes: 20 });
    // Every probe landed on a probeable (even) node.
    expect(probeIndices.every((i) => i % 2 === 0)).toBe(true);
    // The frontier still credits concept nodes below it (e.g. odd "s5").
    expect(frontier.creditedKeys).toContain("s5");
  });

  test("a strand with no probeable node in the window converges at the floor", () => {
    const { keys } = chain("s", 6);
    // Nothing is probeable ⇒ cannot narrow ⇒ frontier stays at floor 0.
    expect(nextStrandProbe(keys, () => false, [])).toBeNull();
    expect(strandFrontier("s", keys, []).frontierIndex).toBe(0);
  });
});

describe("placement — probe cap", () => {
  test("the search stops after maxProbes even if not fully converged", () => {
    const { keys } = chain("s", 63);
    const outcomes: ProbeOutcome[] = [];
    let probes = 0;
    for (let g = 0; g < 100; g++) {
      const p = nextStrandProbe(keys, () => true, outcomes, { maxProbes: 3 });
      if (!p) break;
      probes++;
      outcomes.push(probeOutcomeFromKind(p.probeKey, "correct"));
    }
    expect(probes).toBe(3);
    expect(isStrandConverged(keys, () => true, outcomes, { maxProbes: 3 })).toBe(true);
  });

  test("the default cap is a small, sane number of probes", () => {
    expect(MAX_PROBES_PER_STRAND).toBeGreaterThanOrEqual(3);
    expect(MAX_PROBES_PER_STRAND).toBeLessThanOrEqual(6);
  });
});

describe("placement — trust-upward tuning constants", () => {
  test("the credited half-life is short (self-correcting) and below earned fluency", () => {
    expect(PLACEMENT_HALF_LIFE_DAYS).toBe(4);
    expect(PLACEMENT_HALF_LIFE_DAYS).toBeLessThan(EARNED_HALF_LIFE_DAYS);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// "Confirm before you cap": a SINGLE typed miss is a possible slip — it must not
// cap the ceiling or finalize the scholar at the slipped node. The search
// re-serves a fresh item on the SAME skill (the confirm); a correct confirm
// supersedes the slip and the search climbs on; a second miss confirms a real
// ceiling. An honest "don't know" caps immediately (the fast path). This is the
// fix for the prod bug where one careless slip locked away every skill above it.
// ─────────────────────────────────────────────────────────────────────────

/**
 * Drive the adaptive search where the scholar knows the WHOLE strand but SLIPS
 * exactly once — on the FIRST probe whose index is `slipAt` (a fresh typed miss),
 * then answers everything (including the confirm of that node) correctly.
 */
function simulateOneSlip(orderedKeys: string[], slipAt: number) {
  const outcomes: ProbeOutcome[] = [];
  const probeIndices: number[] = [];
  let slipped = false;
  for (let guard = 0; guard < 100; guard++) {
    const probe = nextStrandProbe(orderedKeys, () => true, outcomes, { maxProbes: 20 });
    if (!probe) break;
    probeIndices.push(probe.index);
    const isSlip = !slipped && probe.index === slipAt && !probe.pendingConfirm;
    if (isSlip) slipped = true;
    // A slip is a single typed miss; everything else (incl. the confirm) is correct.
    outcomes.push(probeOutcomeFromKind(probe.probeKey, isSlip ? "incorrect" : "correct"));
  }
  return { outcomes, probeIndices, frontier: strandFrontier("s", orderedKeys, outcomes) };
}

describe("placement — confirm before you cap", () => {
  test("slip-then-confirm-correct leaves the frontier IDENTICAL to a clean run", () => {
    const { keys } = chain("s", 17);
    const clean = simulate(keys, 17, { maxProbes: 20 }).frontier; // knows all, no slip
    expect(clean.frontierIndex).toBe(17);
    // Slip on the very first probe, then ace everything (incl. the confirm).
    const firstProbeIdx = nextStrandProbe(keys, () => true, [], { maxProbes: 20 })!.index;
    const slipped = simulateOneSlip(keys, firstProbeIdx);
    expect(slipped.frontier.frontierIndex).toBe(17); // 100% recovered — nothing locked away
    expect(slipped.frontier.frontierKey).toBeNull();
  });

  test("a single typed miss re-serves the SAME node (the confirm), not a lower one", () => {
    const { keys } = chain("s", 13);
    const first = nextStrandProbe(keys, () => true, [], { maxProbes: 20 })!;
    const outcomes: ProbeOutcome[] = [probeOutcomeFromKind(first.probeKey, "incorrect")];
    const confirm = nextStrandProbe(keys, () => true, outcomes, { maxProbes: 20 });
    expect(confirm).not.toBeNull();
    expect(confirm!.probeKey).toBe(first.probeKey); // same skill, fresh item
    expect(confirm!.pendingConfirm).toBe(true);
  });

  test("slip-then-confirm-wrong caps exactly where a confirmed miss caps today", () => {
    const { keys } = chain("s", 13);
    const first = nextStrandProbe(keys, () => true, [], { maxProbes: 20 })!;
    // Two misses on the same node = a real ceiling.
    const twoMiss: ProbeOutcome[] = [
      probeOutcomeFromKind(first.probeKey, "incorrect"),
      probeOutcomeFromKind(first.probeKey, "incorrect"),
    ];
    // An honest don't-know on the same first node — today's immediate cap.
    const idk: ProbeOutcome[] = [probeOutcomeFromKind(first.probeKey, "unknown")];
    expect(strandFrontier("s", keys, twoMiss).frontierIndex).toBe(
      strandFrontier("s", keys, idk).frontierIndex,
    );
    // And neither re-serves the capped node — both are done at/below it.
    const afterTwo = nextStrandProbe(keys, () => true, twoMiss, { maxProbes: 20 });
    if (afterTwo) expect(afterTwo.index).toBeLessThan(first.index);
  });

  test("a don't-know still caps immediately with NO extra probe", () => {
    const { keys } = chain("s", 13);
    const first = nextStrandProbe(keys, () => true, [], { maxProbes: 20 })!;
    const idk: ProbeOutcome[] = [probeOutcomeFromKind(first.probeKey, "unknown")];
    const next = nextStrandProbe(keys, () => true, idk, { maxProbes: 20 });
    // The next probe (if any) is strictly BELOW the conceded node — never a confirm.
    if (next) expect(next.index).toBeLessThan(first.index);
    if (next) expect(next.pendingConfirm).toBe(false);
  });

  test("the per-strand probe cap is NOT truncated by confirms", () => {
    // A scholar who slips once still gets enough narrowing probes to converge —
    // the confirm doesn't consume one of the (few) budgeted narrowing steps.
    const { keys } = chain("s", 13);
    // Default cap (5). Knows the whole strand, slips on the first probe.
    const outcomes: ProbeOutcome[] = [];
    let slipped = false;
    const distinctNodes = new Set<string>();
    for (let guard = 0; guard < 100; guard++) {
      const probe = nextStrandProbe(keys, () => true, outcomes); // DEFAULT maxProbes
      if (!probe) break;
      distinctNodes.add(probe.probeKey);
      const isSlip = !slipped && !probe.pendingConfirm && probe.index === nextStrandProbe(keys, () => true, [])!.index;
      if (isSlip) slipped = true;
      outcomes.push(probeOutcomeFromKind(probe.probeKey, isSlip ? "incorrect" : "correct"));
    }
    // The frontier still reaches the top despite the default cap, because the
    // confirm didn't count against the ≤5 distinct narrowing probes.
    expect(strandFrontier("s", keys, outcomes).frontierIndex).toBe(13);
    expect(distinctNodes.size).toBeLessThanOrEqual(MAX_PROBES_PER_STRAND);
  });
});

describe("confirm budget per strand (PLACEMENT_MAX_CONFIRMS_PER_STRAND)", () => {
  const keys = ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j"];
  const probeable = () => true;
  const miss = (nodeKey: string): ProbeOutcome => ({ nodeKey, kind: "incorrect" });

  test("serves a confirm for the first two slips in a strand", () => {
    const first = nextStrandProbe(keys, probeable, [miss("e")], {});
    expect(first).toMatchObject({ probeKey: "e", pendingConfirm: true });
    // "e" confirmed wrong (caps), "c" then slips — still inside the budget.
    const outcomes = [miss("e"), miss("e"), miss("c")];
    expect(nextStrandProbe(keys, probeable, outcomes, {})).toMatchObject({
      probeKey: "c",
      pendingConfirm: true,
    });
  });

  test("stops offering confirms once the budget is spent, and the slip then caps", () => {
    // Two nodes have already consumed a confirm each; a third slips.
    const outcomes = [miss("h"), miss("h"), miss("f"), miss("f"), miss("c")];
    const next = nextStrandProbe(keys, probeable, outcomes, {});
    expect(next?.pendingConfirm ?? false).toBe(false);
    expect(next?.probeKey).not.toBe("c");
    // With no confirm coming, the unconfirmed miss caps the ceiling itself, so
    // the strand finalizes below it rather than crediting through it.
    expect(strandFrontier("s", keys, outcomes).frontierIndex).toBeLessThanOrEqual(2);
  });

  test("is deterministic on replay — budget goes to the earliest-logged slips", () => {
    const outcomes = [miss("d"), miss("g")];
    const a = nextStrandProbe(keys, probeable, outcomes, {});
    const b = nextStrandProbe(keys, probeable, [...outcomes], {});
    expect(a).toEqual(b);
    expect(a).toMatchObject({ pendingConfirm: true });
  });

  test("still fully covers a scholar who slips twice in one strand", () => {
    // The real repair case: two slips, both retried correctly -> nothing locked.
    const outcomes: ProbeOutcome[] = [
      { nodeKey: "c", kind: "correct" },
      miss("g"),
      { nodeKey: "g", kind: "correct" },
      miss("i"),
      { nodeKey: "i", kind: "correct" },
    ];
    expect(strandFrontier("s", keys, outcomes).frontierIndex).toBe(9);
  });
});
