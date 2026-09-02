import { describe, expect, test } from "vitest";
import {
  nextPractice,
  shouldAccelerate,
  latencyBaselineFromSkillMedians,
  accessProven,
  isFluent,
  isDue,
  isProvisional,
  isDemonstratedSource,
  shouldOfferReprobe,
  desiredRetentionTargets,
  dueAt,
  retentionLabel,
  gradeBandCeiling,
  REPROBE_STRAND_ACCEL,
  ACCEL_MIN_BASELINE_SKILLS,
  ACCEL_SOURCE,
  FLUENT_REPS,
  LATENCY_FLUENT_TOLERANCE,
  DEFAULT_STRAND,
  type GraphEdge,
  type SkillState,
} from "../practice/scheduler";

// ─────────────────────────────────────────────────────────────────────────
// Access vs. fluency (plan of record §1). accessProven is the generous prereq
// gate; isFluent is the honest green claim (demonstrated source); isProvisional
// is the derived inferred-but-not-demonstrated middle.
// ─────────────────────────────────────────────────────────────────────────
describe("access vs. fluency split", () => {
  const below = { repetition: FLUENT_REPS - 1, source: "practice" };
  const practiced = { repetition: FLUENT_REPS, source: "practice" };
  const accelerated = { repetition: FLUENT_REPS, source: ACCEL_SOURCE };
  const placed = { repetition: FLUENT_REPS + 2, source: "placement" };

  test("below the rep bar is neither access-proven nor fluent", () => {
    expect(accessProven(below)).toBe(false);
    expect(isFluent(below)).toBe(false);
    expect(isProvisional(below)).toBe(false);
  });

  test("demonstrated practice at the bar is access-proven AND fluent (green)", () => {
    expect(accessProven(practiced)).toBe(true);
    expect(isFluent(practiced)).toBe(true);
    expect(isProvisional(practiced)).toBe(false);
  });

  test("an inferred credit (valve) is access-proven but PROVISIONAL, never green", () => {
    expect(accessProven(accelerated)).toBe(true);
    expect(isFluent(accelerated)).toBe(false);
    expect(isProvisional(accelerated)).toBe(true);
  });

  test("a placement credit is access-proven but provisional too", () => {
    expect(accessProven(placed)).toBe(true);
    expect(isFluent(placed)).toBe(false);
    expect(isProvisional(placed)).toBe(true);
  });

  test("a missing source defaults to demonstrated (legacy rows read as practice)", () => {
    expect(isFluent({ repetition: FLUENT_REPS })).toBe(true);
    expect(isProvisional({ repetition: FLUENT_REPS })).toBe(false);
  });

  test("access, fluent, and provisional partition the access-proven set", () => {
    for (const row of [practiced, accelerated, placed]) {
      expect(accessProven(row)).toBe(true);
      // exactly one of fluent / provisional is true for an access-proven row
      expect(isFluent(row) !== isProvisional(row)).toBe(true);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────
// isDemonstratedSource — the single home for the demonstrated-vs-inferred
// `source` rule (and its load-bearing `?? "practice"` default). Every read
// surface (map, NodeDrawer read model, tune-up, coach handoff) routes through
// this, so the rule can't silently diverge between them.
// ─────────────────────────────────────────────────────────────────────────
describe("isDemonstratedSource", () => {
  test("only real practice is demonstrated", () => {
    expect(isDemonstratedSource("practice")).toBe(true);
  });

  test("a missing source defaults to demonstrated (legacy practice rows)", () => {
    expect(isDemonstratedSource(undefined)).toBe(true);
  });

  test("inferred credits are NOT demonstrated", () => {
    for (const source of [ACCEL_SOURCE, "placement", "reprobe", "scaffolded"]) {
      expect(isDemonstratedSource(source)).toBe(false);
    }
  });

  test("isFluent / isProvisional agree with the shared predicate", () => {
    for (const source of ["practice", ACCEL_SOURCE, "placement", undefined]) {
      const row = { repetition: FLUENT_REPS, source };
      expect(isFluent(row)).toBe(isDemonstratedSource(source));
      expect(isProvisional(row)).toBe(!isDemonstratedSource(source));
    }
  });
});

describe("P5 composite fluency (isFluent with read-time context)", () => {
  const now = 1_000 * 86_400_000; // arbitrary "now" in ms
  const day = 86_400_000;
  // A demonstrated row practiced just now (retention ≈ 1) with a fast median.
  const fresh = {
    repetition: FLUENT_REPS,
    source: "practice",
    halfLifeDays: 10,
    lastPracticedAt: now,
    latencyMedianMs: 1500,
  };

  test("demonstrated + retained + fast ⇒ green", () => {
    expect(isFluent(fresh, { now, latencyBaseline: 2000 })).toBe(true);
  });

  test("RETENTION leg: a demonstrated skill that has decayed past due is NOT green", () => {
    const decayed = { ...fresh, halfLifeDays: 2, lastPracticedAt: now - 10 * day }; // R = 2^-5 ≈ 0.03
    expect(isFluent(decayed)).toBe(true); // no ctx → demonstrated gate only
    expect(isFluent(decayed, { now, latencyBaseline: 2000 })).toBe(false); // composite drops it
  });

  test("LATENCY leg: slow-for-this-scholar is not green; fast is", () => {
    const baseline = 2000;
    const slow = { ...fresh, latencyMedianMs: baseline * LATENCY_FLUENT_TOLERANCE + 1 };
    const fast = { ...fresh, latencyMedianMs: baseline * LATENCY_FLUENT_TOLERANCE };
    expect(isFluent(slow, { now, latencyBaseline: baseline })).toBe(false);
    expect(isFluent(fast, { now, latencyBaseline: baseline })).toBe(true);
  });

  test("LATENCY leg is SOFT: unknown baseline or missing median never blocks green", () => {
    const slow = { ...fresh, latencyMedianMs: 999_999 };
    expect(isFluent(slow, { now, latencyBaseline: undefined })).toBe(true); // no baseline → skip
    const noMedian = { repetition: FLUENT_REPS, source: "practice", halfLifeDays: 10, lastPracticedAt: now };
    expect(isFluent(noMedian, { now, latencyBaseline: 2000 })).toBe(true); // no median → skip
  });

  test("RETENTION leg can use a per-skill target", () => {
    const halfLifeAgo = { ...fresh, halfLifeDays: 10, lastPracticedAt: now - 2 * DAY };
    expect(isFluent(halfLifeAgo, { now, retentionThreshold: 0.8 })).toBe(true);
    expect(isFluent(halfLifeAgo, { now, retentionThreshold: 0.9 })).toBe(false);
  });

  test("an inferred credit is never green even when fresh + fast", () => {
    const placedFresh = { ...fresh, source: "placement" };
    expect(isFluent(placedFresh, { now, latencyBaseline: 2000 })).toBe(false);
  });

  test("isProvisional is decoupled from the composite — a decayed demonstrated skill is NOT provisional", () => {
    const decayed = { repetition: FLUENT_REPS, source: "practice", halfLifeDays: 2, lastPracticedAt: now - 10 * day };
    // Not green under the composite, but it's a due REVIEW, not an inferred credit.
    expect(isFluent(decayed, { now })).toBe(false);
    expect(isProvisional(decayed)).toBe(false);
  });
});

describe("strand re-probe offer (B1 Mechanism 2)", () => {
  test("offers a re-probe only once accelerated credits hit the threshold", () => {
    expect(shouldOfferReprobe(0)).toBe(false);
    expect(shouldOfferReprobe(REPROBE_STRAND_ACCEL - 1)).toBe(false);
    expect(shouldOfferReprobe(REPROBE_STRAND_ACCEL)).toBe(true);
    expect(shouldOfferReprobe(REPROBE_STRAND_ACCEL + 3)).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Multi-strand scheduler (roadmap §2). These exercise the pure `nextPractice`
// priority order: 1) due reviews (cross-strand, most-decayed first) →
// 2) strand balance (least-recently-served round-robin) → 3) most-ready-within-
// strand → 4) scholar hint (×2), plus the 2-active-strand session cap and the
// teacher focus pin. The whole thing must reduce to the original single-track
// behavior when there's no strand info.
// ─────────────────────────────────────────────────────────────────────────

const NOW = 100 * 86_400_000;
const DAY = 86_400_000;

/** A skill that is fluent and fresh (won't be due, won't be on the frontier). */
const fluentFresh: SkillState = { repetition: 4, halfLifeDays: 60, lastPracticedAt: NOW - 1 * DAY };
/** A fluent skill whose retention has decayed well below 0.6 → a due review. */
const fluentDue: SkillState = { repetition: 4, halfLifeDays: 5, lastPracticedAt: NOW - 30 * DAY };
/** Never touched → a candidate frontier skill (if its prereqs are fluent). */
const untouched: SkillState = { repetition: 0, halfLifeDays: 0 };

function stateOfFrom(states: Record<string, SkillState>) {
  return (key: string): SkillState => states[key] ?? untouched;
}

function strandOfFrom(strands: Record<string, string>) {
  return (key: string): string | undefined => strands[key];
}

const keysOf = (q: { key: string }[]) => q.map((i) => i.key);
const strandsOf = (q: { strand: string }[]) => q.map((i) => i.strand);

// ── Rule 1: due reviews beat frontier work, across strands ────────────────
describe("nextPractice — due reviews beat frontier (rule 1, cross-strand)", () => {
  test("a fading fact in one strand outranks a shiny new frontier in another", () => {
    const keys = ["mult_fact", "place_value_new"];
    const edges: GraphEdge[] = [];
    const states = { mult_fact: fluentDue, place_value_new: untouched };
    const strands = { mult_fact: "mult-divide", place_value_new: "place-value" };

    const q = nextPractice(keys, edges, stateOfFrom(states), NOW, 5, {
      strandOf: strandOfFrom(strands),
      // Even if the new strand were "less recently served", the due review wins.
      lastServedByStrand: { "mult-divide": NOW, "place-value": 0 },
    });

    expect(q[0]).toMatchObject({ key: "mult_fact", reason: "review", strand: "mult-divide" });
    expect(q[1]).toMatchObject({ key: "place_value_new", reason: "new", strand: "place-value" });
  });

  test("multiple due reviews are ordered most-decayed first, uncapped by strands", () => {
    // Three due reviews across THREE strands — none is dropped by the 2-strand
    // cap (the cap bounds NEW work only; reviews are absolute).
    const keys = ["r_a", "r_b", "r_c"];
    const edges: GraphEdge[] = [];
    const states: Record<string, SkillState> = {
      r_a: { repetition: 4, halfLifeDays: 5, lastPracticedAt: NOW - 10 * DAY }, // mildly decayed
      r_b: { repetition: 4, halfLifeDays: 5, lastPracticedAt: NOW - 40 * DAY }, // most decayed
      r_c: { repetition: 4, halfLifeDays: 5, lastPracticedAt: NOW - 25 * DAY }, // middle
    };
    const strands = { r_a: "A", r_b: "B", r_c: "C" };

    const q = nextPractice(keys, edges, stateOfFrom(states), NOW, 5, {
      strandOf: strandOfFrom(strands),
      maxActiveStrands: 2,
    });

    expect(keysOf(q)).toEqual(["r_b", "r_c", "r_a"]); // most-decayed first, all three present
    expect(q.every((i) => i.reason === "review")).toBe(true);
  });
});

describe("desired-retention targets (P2a)", () => {
  test("foundation nodes come due sooner than leaves at equal half-life", () => {
    const root = "foundation";
    const dependents = Array.from({ length: 8 }, (_, i) => `d${i}`);
    const keys = [root, ...dependents, "leaf"];
    const edges: GraphEdge[] = dependents.map((key) => ({ fromKey: root, toKey: key }));
    const targets = desiredRetentionTargets(keys, edges);
    expect(targets.get(root)).toBe(0.9);
    expect(targets.get("leaf")).toBe(0.8);

    const state: SkillState = {
      repetition: 4,
      halfLifeDays: 10,
      lastPracticedAt: NOW - 2 * DAY,
    };
    expect(isDue(state, NOW, targets.get(root))).toBe(true);
    expect(isDue(state, NOW, targets.get("leaf"))).toBe(false);
    expect(retentionLabel(state, NOW, targets.get(root))).toBe("due");
    expect(retentionLabel(state, NOW, targets.get("leaf"))).toBe("fresh");
    expect(dueAt(state, targets.get(root))!).toBeLessThan(dueAt(state, targets.get("leaf"))!);
  });

  test("a mid-fanout node below an ACTIVE quartile cutoff gets the default target", () => {
    // A 20-node prerequisite chain gives a clean spread of transitive-dependent
    // counts (19, 18, …, 1, 0). The top-quartile cutoff lands at 15 (> 0, so the
    // quartile rule is live). A node with only a couple of dependents — well below
    // both FOUNDATION_DEPENDENT_COUNT (8) and the cutoff — is the default middle
    // band, proving 0.85 is reachable and the quartile rule doesn't over-promote.
    const keys = Array.from({ length: 20 }, (_, i) => `c${i}`);
    const edges: GraphEdge[] = keys
      .slice(0, -1)
      .map((k, i) => ({ fromKey: k, toKey: keys[i + 1] }));
    const targets = desiredRetentionTargets(keys, edges);
    expect(targets.get("c0")).toBe(0.9); // 19 dependents → foundation
    expect(targets.get("c17")).toBe(0.85); // 2 dependents → default
    expect(targets.get("c19")).toBe(0.8); // leaf
  });

  test("does not over-promote every non-leaf when the top-quartile cutoff is 0", () => {
    // Sparse graph: only `root` has dependents (2 of them); everyone else is a
    // leaf. Fewer than a quartile of nodes have ANY dependents, so the quartile
    // boundary lands at 0 — the degenerate case where `count >= 0` would sweep
    // every non-leaf into the 0.90 foundation band. The guard must prevent that.
    const keys = ["root", "a", "b", "c", "d", "e", "f"];
    const edges: GraphEdge[] = [
      { fromKey: "root", toKey: "a" },
      { fromKey: "root", toKey: "b" },
    ];
    const targets = desiredRetentionTargets(keys, edges);
    expect(targets.get("root")).toBe(0.85); // 2 dependents → default, NOT foundation
    expect(targets.get("a")).toBe(0.8); // leaf
    expect(targets.get("c")).toBe(0.8); // isolated leaf
  });
});

// ── Rule 2: strand balance via least-recently-served round-robin ──────────
describe("nextPractice — strand round-robin (rule 2)", () => {
  const keys = ["a1", "a2", "a3", "b1", "b2", "b3"];
  const edges: GraphEdge[] = []; // all roots → all on the frontier
  const strands = { a1: "A", a2: "A", a3: "A", b1: "B", b2: "B", b3: "B" };

  test("interleaves strands rather than draining one; least-recently-served first", () => {
    const q = nextPractice(keys, edges, stateOfFrom({}), NOW, 6, {
      strandOf: strandOfFrom(strands),
      lastServedByStrand: { A: 100, B: 200 }, // A less recently served → A leads
    });
    expect(keysOf(q)).toEqual(["a1", "b1", "a2", "b2", "a3", "b3"]);
  });

  test("the round-robin lead flips when the other strand is the stale one", () => {
    const q = nextPractice(keys, edges, stateOfFrom({}), NOW, 6, {
      strandOf: strandOfFrom(strands),
      lastServedByStrand: { A: 200, B: 100 }, // now B is the stale strand
    });
    expect(keysOf(q)).toEqual(["b1", "a1", "b2", "a2", "b3", "a3"]);
  });

  test("a never-served strand (absent from the table) sorts ahead of a served one", () => {
    const q = nextPractice(keys, edges, stateOfFrom({}), NOW, 6, {
      strandOf: strandOfFrom(strands),
      lastServedByStrand: { A: 500 }, // B never served → B leads
    });
    expect(q[0].strand).toBe("B");
  });
});

// ── Rule 3: most-ready-within-strand tiebreak ─────────────────────────────
describe("nextPractice — most-ready-within-strand (rule 3)", () => {
  test("within a strand, the skill with more fluent prerequisites comes first", () => {
    // p1, p2 fluent. `rich` builds on both (2 fluent prereqs); `lean` on one.
    // Input order deliberately lists lean BEFORE rich to prove the readiness
    // sort — not input order — decides.
    const keys = ["p1", "p2", "lean", "rich"];
    const edges: GraphEdge[] = [
      { fromKey: "p1", toKey: "rich" },
      { fromKey: "p2", toKey: "rich" },
      { fromKey: "p1", toKey: "lean" },
    ];
    const states = { p1: fluentFresh, p2: fluentFresh };
    const strands = { p1: "A", p2: "A", lean: "A", rich: "A" };

    const q = nextPractice(keys, edges, stateOfFrom(states), NOW, 5, {
      strandOf: strandOfFrom(strands),
    });

    // p1/p2 are fluent+fresh → neither a review nor a frontier skill.
    expect(keysOf(q)).toEqual(["rich", "lean"]);
    expect(q.every((i) => i.reason === "new")).toBe(true);
  });

  test("equal readiness falls back to topological (input) order — stable", () => {
    const keys = ["s1", "s2", "s3"]; // three independent roots, all readiness 0
    const q = nextPractice(keys, [], stateOfFrom({}), NOW, 5, {
      strandOf: () => "A",
    });
    expect(keysOf(q)).toEqual(["s1", "s2", "s3"]);
  });
});

// ── Rule 4: scholar hint gets ×2 weight (never over due reviews) ──────────
describe("nextPractice — scholar hint weighting (rule 4)", () => {
  const keys = ["x1", "x2", "x3", "x4", "y1", "y2"];
  const edges: GraphEdge[] = [];
  const strands = { x1: "X", x2: "X", x3: "X", x4: "X", y1: "Y", y2: "Y" };
  // Y is the stale (least-recently-served) strand, so it leads WITHOUT a hint.
  const lastServed = { X: 200, Y: 100 };

  test("without a hint, the stale strand (Y) leads the round-robin", () => {
    const q = nextPractice(keys, edges, stateOfFrom({}), NOW, 6, {
      strandOf: strandOfFrom(strands),
      lastServedByStrand: lastServed,
    });

    expect(q[0].strand).toBe("Y");
  });

  test("a hint on X jumps it to the front and doubles its share (×2)", () => {
    const q = nextPractice(keys, edges, stateOfFrom({}), NOW, 6, {
      strandOf: strandOfFrom(strands),
      lastServedByStrand: lastServed,
      hintStrand: "X",
    });
    // X leads, and each round gives X two picks to Y's one → x1,x2,y1,x3,x4,y2.
    expect(keysOf(q)).toEqual(["x1", "x2", "y1", "x3", "x4", "y2"]);
    expect(strandsOf(q).slice(0, 3).filter((s) => s === "X")).toHaveLength(2);
  });

  test("a hint never jumps ahead of a due review", () => {
    const states = { y1: fluentDue }; // y1 is a due review in the non-hinted strand
    const q = nextPractice(keys, edges, stateOfFrom(states), NOW, 6, {
      strandOf: strandOfFrom(strands),
      lastServedByStrand: lastServed,
      hintStrand: "X",
    });
    expect(q[0]).toMatchObject({ key: "y1", reason: "review" });
  });
});

describe("nextPractice — soft checkpoint preference", () => {
  const keys = ["a_grade_5", "a_grade_4", "b_grade_4", "b_grade_5"];
  const strands = {
    a_grade_5: "A",
    a_grade_4: "A",
    b_grade_4: "B",
    b_grade_5: "B",
  };
  const grades: Record<string, string> = {
    a_grade_5: "5",
    a_grade_4: "4",
    b_grade_4: "4",
    b_grade_5: "5",
  };

  test("weights the checkpoint strand and uses exact grade only as its final tiebreak", () => {
    const q = nextPractice(keys, [], stateOfFrom({}), NOW, 4, {
      strandOf: strandOfFrom(strands),
      gradeOf: (key) => grades[key],
      lastServedByStrand: { A: NOW, B: 0 },
      preferredCheckpoint: { strand: "A", grade: "4" },
    });
    expect(keysOf(q)).toEqual([
      "a_grade_4",
      "a_grade_5",
      "b_grade_4",
      "b_grade_5",
    ]);
  });

  test("never moves a checkpoint candidate ahead of a due review", () => {
    const q = nextPractice(
      ["review_b", "new_a"],
      [],
      stateOfFrom({ review_b: fluentDue }),
      NOW,
      4,
      {
        strandOf: strandOfFrom({ review_b: "B", new_a: "A" }),
        gradeOf: () => "4",
        preferredCheckpoint: { strand: "A", grade: "4" },
      },
    );
    expect(q[0]).toMatchObject({ key: "review_b", reason: "review" });
  });

  test("falls through when the checkpoint strand has no frontier work", () => {
    const q = nextPractice(
      ["owned_a", "new_b"],
      [],
      stateOfFrom({ owned_a: fluentFresh }),
      NOW,
      4,
      {
        strandOf: strandOfFrom({ owned_a: "A", new_b: "B" }),
        gradeOf: () => "4",
        preferredCheckpoint: { strand: "A", grade: "4" },
      },
    );
    expect(keysOf(q)).toEqual(["new_b"]);
  });

  test("cannot resurrect a hard-excluded strand", () => {
    const q = nextPractice(keys, [], stateOfFrom({}), NOW, 4, {
      strandOf: strandOfFrom(strands),
      gradeOf: (key) => grades[key],
      excludedStrands: ["A"],
      preferredCheckpoint: { strand: "A", grade: "4" },
    });
    expect(strandsOf(q)).toEqual(["B", "B"]);
  });

  test("coexists with a different scholar hint without stacking above ×2", () => {
    const q = nextPractice(keys, [], stateOfFrom({}), NOW, 4, {
      strandOf: strandOfFrom(strands),
      gradeOf: (key) => grades[key],
      hintStrand: "B",
      preferredCheckpoint: { strand: "A", grade: "4" },
    });
    expect(strandsOf(q)).toEqual(["B", "B", "A", "A"]);
  });

  test("a domain checkpoint does not force-activate a strand and tie-breaks by grade in every active strand", () => {
    const q = nextPractice(
      ["a_grade_5", "a_grade_4", "b_grade_5", "b_grade_4", "c_grade_4"],
      [],
      stateOfFrom({}),
      NOW,
      5,
      {
        strandOf: strandOfFrom({
          a_grade_5: "A",
          a_grade_4: "A",
          b_grade_5: "B",
          b_grade_4: "B",
          c_grade_4: "C",
        }),
        gradeOf: (key) => (key.endsWith("_4") ? "4" : "5"),
        lastServedByStrand: { A: 0, B: 100, C: 200 },
        maxActiveStrands: 2,
        preferredCheckpoint: { grade: "4" },
      },
    );

    expect(keysOf(q)).toEqual([
      "a_grade_4",
      "b_grade_4",
      "a_grade_5",
      "b_grade_5",
    ]);
    expect(strandsOf(q)).not.toContain("C");
  });
});

// ── Session-breadth cap: at most 2 active strands for NEW work ─────────────
describe("nextPractice — 2-active-strand session cap", () => {
  const keys = ["a1", "a2", "b1", "b2", "c1", "c2"];
  const edges: GraphEdge[] = [];
  const strands = { a1: "A", a2: "A", b1: "B", b2: "B", c1: "C", c2: "C" };
  const lastServed = { A: 100, B: 200, C: 300 }; // A stalest, then B, then C

  test("only the two least-recently-served strands supply new work", () => {
    const q = nextPractice(keys, edges, stateOfFrom({}), NOW, 12, {
      strandOf: strandOfFrom(strands),
      lastServedByStrand: lastServed,
      maxActiveStrands: 2,
    });
    expect(new Set(strandsOf(q))).toEqual(new Set(["A", "B"]));
    expect(keysOf(q)).not.toContain("c1");
    expect(keysOf(q)).not.toContain("c2");
  });

  test("raising the cap to 3 surfaces the third strand", () => {
    const q = nextPractice(keys, edges, stateOfFrom({}), NOW, 12, {
      strandOf: strandOfFrom(strands),
      lastServedByStrand: lastServed,
      maxActiveStrands: 3,
    });
    expect(new Set(strandsOf(q))).toEqual(new Set(["A", "B", "C"]));
  });

  test("a hint force-activates an otherwise-capped strand (surface a third)", () => {
    // C would be excluded by the cap; hinting it forces it active (displacing B).
    const q = nextPractice(keys, edges, stateOfFrom({}), NOW, 12, {
      strandOf: strandOfFrom(strands),
      lastServedByStrand: lastServed,
      maxActiveStrands: 2,
      hintStrand: "C",
    });
    const seen = new Set(strandsOf(q));
    expect(seen.has("C")).toBe(true);
    expect(seen.size).toBe(2); // still capped at two distinct strands
    expect(q[0].strand).toBe("C"); // forced strand leads
  });

  test("a due review in a capped-out strand is still surfaced (cap is new-work-only)", () => {
    const states = { c1: fluentDue }; // C is beyond the cap, but c1 is due
    const q = nextPractice(keys, edges, stateOfFrom(states), NOW, 12, {
      strandOf: strandOfFrom(strands),
      lastServedByStrand: lastServed,
      maxActiveStrands: 2,
    });
    expect(q[0]).toMatchObject({ key: "c1", reason: "review", strand: "C" });
    // …and new work is still limited to the two active strands.
    expect(strandsOf(q.filter((i) => i.reason === "new"))).not.toContain("C");
  });
});

// ── Teacher focus pin: overrides the frontier pick, never a due review ─────
describe("nextPractice — teacher focus pin", () => {
  const keys = ["a1", "a2", "b1", "b2"];
  const edges: GraphEdge[] = [];
  const strands = { a1: "A", a2: "A", b1: "B", b2: "B" };
  const lastServed = { A: 100, B: 200 }; // A leads by recency by default

  test("the pinned frontier skill is hoisted to the front of NEW picks", () => {
    const q = nextPractice(keys, edges, stateOfFrom({}), NOW, 5, {
      strandOf: strandOfFrom(strands),
      lastServedByStrand: lastServed,
      focusSkillKey: "b2", // teacher pins b2, which is otherwise buried
    });
    expect(q[0]).toMatchObject({ key: "b2", reason: "new", strand: "B" });
    // its strand is force-active even though B is not the stalest strand
    expect(new Set(strandsOf(q)).has("B")).toBe(true);
  });

  test("a pin never overrides a due review", () => {
    const states = { a1: fluentDue };
    const q = nextPractice(keys, edges, stateOfFrom(states), NOW, 5, {
      strandOf: strandOfFrom(strands),
      lastServedByStrand: lastServed,
      focusSkillKey: "b2",
    });
    expect(q[0]).toMatchObject({ key: "a1", reason: "review" });
    expect(q[1]).toMatchObject({ key: "b2", reason: "new" }); // pin leads the frontier
  });

  test("a pin on a locked (non-frontier) skill is a safe no-op", () => {
    // c depends on an unmet prereq → not on the frontier → the pin is ignored.
    const lockedKeys = ["gate", "c", "a1"];
    const lockedEdges: GraphEdge[] = [{ fromKey: "gate", toKey: "c" }];
    const q = nextPractice(lockedKeys, lockedEdges, stateOfFrom({}), NOW, 5, {
      strandOf: strandOfFrom({ gate: "A", c: "A", a1: "A" }),
      focusSkillKey: "c",
    });
    expect(keysOf(q)).not.toContain("c");
    expect(keysOf(q)).toContain("gate"); // the real frontier root
  });
});

// ── Standing-practice strand exclusion (roadmap §10) ──────────────────────
describe("nextPractice — excludedStrands (standing practice)", () => {
  const keys = ["a1", "a2", "b1", "b2"];
  const strands = { a1: "A", a2: "A", b1: "B", b2: "B" };

  test("an excluded strand is never served as new frontier work", () => {
    const q = nextPractice(keys, [], stateOfFrom({}), NOW, 12, {
      strandOf: strandOfFrom(strands),
      excludedStrands: ["B"],
      // Raise the cap so B would surface if it weren't excluded.
      maxActiveStrands: 5,
    });
    expect(keysOf(q)).not.toContain("b1");
    expect(keysOf(q)).not.toContain("b2");
    expect(strandsOf(q).every((s) => s !== "B")).toBe(true);
    // Non-excluded strand still flows.
    expect(keysOf(q)).toEqual(expect.arrayContaining(["a1", "a2"]));
  });

  test("an excluded strand is dropped even for a due review (off-limits, absolute)", () => {
    // b1 is a fading fact that would normally be an uncapped, top-priority
    // review — exclusion still removes it.
    const states = { b1: fluentDue, a1: fluentDue };
    const q = nextPractice(keys, [], stateOfFrom(states), NOW, 12, {
      strandOf: strandOfFrom(strands),
      excludedStrands: ["B"],
      maxActiveStrands: 5,
    });
    expect(keysOf(q)).not.toContain("b1");
    // The non-excluded due review IS still served, ahead of new work.
    expect(q[0]).toMatchObject({ key: "a1", reason: "review", strand: "A" });
  });

  test("an excluded strand can still gate a prereq without being served", () => {
    // A(gate, in excluded strand) -> b1 (frontier, kept strand). Making the
    // excluded gate fluent should unlock b1, and b1 is served while the gate
    // itself is not.
    const gateKeys = ["gate", "b1"];
    const gateEdges: GraphEdge[] = [{ fromKey: "gate", toKey: "b1" }];
    const q = nextPractice(gateKeys, gateEdges, stateOfFrom({ gate: fluentFresh }), NOW, 12, {
      strandOf: strandOfFrom({ gate: "A", b1: "B" }),
      excludedStrands: ["A"],
      maxActiveStrands: 5,
    });
    expect(keysOf(q)).toContain("b1");
    expect(keysOf(q)).not.toContain("gate");
  });

  test("a teacher pin into an excluded strand is a safe no-op", () => {
    const q = nextPractice(keys, [], stateOfFrom({}), NOW, 12, {
      strandOf: strandOfFrom(strands),
      excludedStrands: ["B"],
      focusSkillKey: "b2",
      maxActiveStrands: 5,
    });
    expect(keysOf(q)).not.toContain("b2");
  });

  test("an empty/absent exclusion list is a no-op", () => {
    const q = nextPractice(keys, [], stateOfFrom({}), NOW, 12, {
      strandOf: strandOfFrom(strands),
      excludedStrands: [],
      maxActiveStrands: 5,
    });
    expect(keysOf(q)).toEqual(expect.arrayContaining(["a1", "b1"]));
  });
});

describe("nextPractice — frontierAllowedStrands (focus mode)", () => {
  const keys = ["a_due", "a_new", "b_due", "b_new"];
  const strands = {
    a_due: "A",
    a_new: "A",
    b_due: "B",
    b_new: "B",
  };
  const states = { a_due: fluentDue, b_due: fluentDue };

  test("due reviews are untouched while frontier work is restricted", () => {
    const q = nextPractice(keys, [], stateOfFrom(states), NOW, 12, {
      strandOf: strandOfFrom(strands),
      frontierAllowedStrands: ["A"],
      maxActiveStrands: 5,
    });
    expect(keysOf(q.filter((item) => item.reason === "review"))).toEqual([
      "a_due",
      "b_due",
    ]);
    expect(keysOf(q.filter((item) => item.reason === "new"))).toEqual(["a_new"]);
    expect(keysOf(q)).not.toContain("b_new");
  });

  test("an empty allowlist yields reviews only", () => {
    const q = nextPractice(keys, [], stateOfFrom(states), NOW, 12, {
      strandOf: strandOfFrom(strands),
      frontierAllowedStrands: [],
      remediationSkillKey: "a_new",
      maxActiveStrands: 5,
    });
    expect(keysOf(q)).toEqual(["a_due", "b_due"]);
    expect(q.every((item) => item.reason === "review")).toBe(true);
  });

  test("a teacher focus pin outside the allowlist still wins", () => {
    const q = nextPractice(keys, [], stateOfFrom(states), NOW, 12, {
      strandOf: strandOfFrom(strands),
      frontierAllowedStrands: ["A"],
      focusSkillKey: "b_new",
      maxActiveStrands: 5,
    });
    expect(q.filter((item) => item.reason === "new")[0]).toMatchObject({
      key: "b_new",
      strand: "B",
    });
  });

  test("inferred confirmations outside the allowlist are withheld", () => {
    const q = nextPractice(keys, [], stateOfFrom(states), NOW, 12, {
      strandOf: strandOfFrom(strands),
      frontierAllowedStrands: ["A"],
      inferredDueCredit: (key) => key === "b_due",
      maxActiveStrands: 5,
    });
    expect(keysOf(q)).toContain("a_due");
    expect(keysOf(q)).not.toContain("b_due");
  });
});

// ── Degenerate single-strand case: backward-compatible with the old engine ─
describe("nextPractice — single-strand degenerate case (backward compat)", () => {
  test("with no strand info it is due-reviews-then-frontier, strand = default", () => {
    // chain a -> b -> c, a fluent-but-due, b on the frontier, c locked.
    const keys = ["a", "b", "c"];
    const edges: GraphEdge[] = [
      { fromKey: "a", toKey: "b" },
      { fromKey: "b", toKey: "c" },
    ];
    const states = { a: fluentDue };
    const q = nextPractice(keys, edges, stateOfFrom(states), NOW); // no options at all
    expect(q[0]).toMatchObject({ key: "a", reason: "review", strand: DEFAULT_STRAND });
    expect(q[1]).toMatchObject({ key: "b", reason: "new", strand: DEFAULT_STRAND });
    expect(keysOf(q)).not.toContain("c"); // still locked behind b
  });

  test("the legacy 5-arg positional call (no options) still works and caps at limit", () => {
    const keys = ["a", "b", "c", "d"];
    const q = nextPractice(keys, [], stateOfFrom({}), NOW, 2);
    expect(q).toHaveLength(2);
    expect(q.every((i) => i.reason === "new" && i.strand === DEFAULT_STRAND)).toBe(true);
  });
});

// ── Session-mix floor (raise-the-ceiling plan §8): never 100% review ───────
describe("nextPractice — applyMixFloor session-mix floor", () => {
  // 8 due reviews (well over any `limit` below) all on one strand, plus a
  // handful of frontier ("new") roots on a second strand — the failure mode
  // from the plan: after a break, every mastered node is due at once, and
  // without a floor the frontier would be starved for days.
  const reviewKeys = Array.from({ length: 8 }, (_, i) => `r${i}`);
  const frontierKeys = ["n1", "n2", "n3", "n4"];
  const keys = [...reviewKeys, ...frontierKeys];
  const edges: GraphEdge[] = [];
  const strands: Record<string, string> = {};
  for (const k of reviewKeys) strands[k] = "review-strand";
  for (const k of frontierKeys) strands[k] = "new-strand";

  const states: Record<string, SkillState> = {};
  reviewKeys.forEach((k, i) => {
    // Most-decayed-first ordering: r0 the most decayed, r7 the least.
    states[k] = { repetition: 4, halfLifeDays: 5, lastPracticedAt: NOW - (40 - i) * DAY };
  });

  test("with applyMixFloor:true, a limit=8 session with 8 due reviews + a frontier reserves ceil(8/4)=2 new slots", () => {
    const q = nextPractice(keys, edges, stateOfFrom(states), NOW, 8, {
      strandOf: strandOfFrom(strands),
      maxActiveStrands: 5,
      applyMixFloor: true,
    });
    expect(q).toHaveLength(8);
    const newItems = q.filter((i) => i.reason === "new");
    const reviewItems = q.filter((i) => i.reason === "review");
    expect(newItems.length).toBeGreaterThanOrEqual(Math.ceil(8 / 4));
    expect(newItems.length).toBe(2);
    expect(reviewItems.length).toBe(6);
    // Reviews still most-decayed-first, and the 6 that made it are the 6
    // most-decayed (r0..r5) — the least-decayed (r6, r7) spilled to next time.
    expect(keysOf(reviewItems)).toEqual(["r0", "r1", "r2", "r3", "r4", "r5"]);
    expect(new Set(keysOf(newItems))).toEqual(new Set(["n1", "n2"]));
  });

  test("with applyMixFloor:true and an EMPTY frontier, the floor is 0 — still all reviews (no regression)", () => {
    const q = nextPractice(reviewKeys, [], stateOfFrom(states), NOW, 8, {
      strandOf: strandOfFrom({ ...strands }),
      applyMixFloor: true,
    });
    expect(q).toHaveLength(8);
    expect(q.every((i) => i.reason === "review")).toBe(true);
    expect(keysOf(q)).toEqual(["r0", "r1", "r2", "r3", "r4", "r5", "r6", "r7"]);
  });

  test("with applyMixFloor absent (default false), behavior is byte-identical to today: all reviews, no frontier", () => {
    const withFloor = nextPractice(keys, edges, stateOfFrom(states), NOW, 8, {
      strandOf: strandOfFrom(strands),
      maxActiveStrands: 5,
      applyMixFloor: true,
    });
    const withoutFloor = nextPractice(keys, edges, stateOfFrom(states), NOW, 8, {
      strandOf: strandOfFrom(strands),
      maxActiveStrands: 5,
    });
    const withoutFloorExplicitFalse = nextPractice(keys, edges, stateOfFrom(states), NOW, 8, {
      strandOf: strandOfFrom(strands),
      maxActiveStrands: 5,
      applyMixFloor: false,
    });
    // Today's (no-floor) behavior: 8 due reviews fill the whole session, zero
    // frontier surfaces — the exact bug the plan calls out.
    expect(withoutFloor).toHaveLength(8);
    expect(withoutFloor.every((i) => i.reason === "review")).toBe(true);
    expect(withoutFloor).toEqual(withoutFloorExplicitFalse);
    // ...and it must differ from the floored result (proving the floor did
    // something), while the floored result never drops below the floor.
    expect(withFloor).not.toEqual(withoutFloor);
    expect(withFloor.filter((i) => i.reason === "new").length).toBeGreaterThanOrEqual(2);
  });

  test("dedupe still holds under the floor (a key can't appear as both review and new candidate twice)", () => {
    // n1's prereq chain makes it frontier; ensure no duplicate keys regardless
    // of floor bookkeeping.
    const q = nextPractice(keys, edges, stateOfFrom(states), NOW, 8, {
      strandOf: strandOfFrom(strands),
      maxActiveStrands: 5,
      applyMixFloor: true,
    });
    const seenKeys = keysOf(q);
    expect(new Set(seenKeys).size).toBe(seenKeys.length);
  });

  test("floor never exceeds `limit` even when frontier is abundant", () => {
    const manyFrontier = Array.from({ length: 20 }, (_, i) => `f${i}`);
    const allKeys = [...reviewKeys, ...manyFrontier];
    const s: Record<string, string> = { ...strands };
    for (const k of manyFrontier) s[k] = "new-strand";
    const q = nextPractice(allKeys, [], stateOfFrom(states), NOW, 8, {
      strandOf: strandOfFrom(s),
      maxActiveStrands: 5,
      applyMixFloor: true,
    });
    expect(q.length).toBeLessThanOrEqual(8);
    expect(q).toHaveLength(8);
    expect(q.filter((i) => i.reason === "new").length).toBeGreaterThanOrEqual(2);
  });

  test("when the frontier itself is smaller than the floor, the floor is capped at the frontier size", () => {
    // Only 1 frontier item available; ceil(8/4)=2 floor can't be met by 1 item,
    // so the floor degrades to 1 (min(floor, frontierItems.length)) — reviews
    // fill the rest, never leaving an empty slot.
    const smallFrontierKeys = ["only-one-new"];
    const smallKeys = [...reviewKeys, ...smallFrontierKeys];
    const s: Record<string, string> = { ...strands, "only-one-new": "new-strand" };
    const q = nextPractice(smallKeys, [], stateOfFrom(states), NOW, 8, {
      strandOf: strandOfFrom(s),
      maxActiveStrands: 5,
      applyMixFloor: true,
    });
    expect(q).toHaveLength(8);
    expect(q.filter((i) => i.reason === "new")).toHaveLength(1);
    expect(q.filter((i) => i.reason === "review")).toHaveLength(7);
  });

  test("with a limit under 4, ceil(limit/4) still reserves at least 1 new slot when frontier exists", () => {
    const q = nextPractice(keys, edges, stateOfFrom(states), NOW, 3, {
      strandOf: strandOfFrom(strands),
      maxActiveStrands: 5,
      applyMixFloor: true,
    });
    expect(q).toHaveLength(3);
    expect(q.filter((i) => i.reason === "new").length).toBeGreaterThanOrEqual(1);
  });
});

describe("nextPractice — grade band and challenge overflow", () => {
  const keys = ["on_band", "untagged", "high_1", "high_2", "high_3"];
  const grades: Record<string, string | undefined> = {
    on_band: "4",
    untagged: undefined,
    high_1: "6",
    high_2: "7",
    high_3: "8",
  };
  const gradeOf = (key: string): string | undefined => grades[key];

  test("frontier above the ceiling is excluded from normal lanes and capped as challenge overflow", () => {
    const q = nextPractice(keys, [], stateOfFrom({}), NOW, 10, {
      gradeOf,
      scholarBandCeiling: 4,
      challengeOverflowCap: 2,
      maxActiveStrands: 5,
    });

    expect(keysOf(q.filter((i) => i.reason === "new"))).toEqual(["on_band", "untagged"]);
    expect(keysOf(q.filter((i) => i.reason === "challenge"))).toEqual(["high_1", "high_2"]);
    expect(keysOf(q)).not.toContain("high_3");
  });

  test("first post-placement ceiling uses placed-through grade, not inflated access credit", () => {
    expect(
      gradeBandCeiling({
        accessGrade: 7,
        fallbackGrade: 2,
      }),
    ).toBe(8);

    expect(
      gradeBandCeiling({
        accessGrade: 7,
        fallbackGrade: 2,
        firstPostPlacementBlock: true,
        placedThroughGrade: "3",
      }),
    ).toBe(3);
  });

  test("first-block required exclusions move frontier skills to the optional challenge lane", () => {
    const q = nextPractice(keys, [], stateOfFrom({}), NOW, 10, {
      gradeOf,
      scholarBandCeiling: 4,
      requiredExcludedSkillKeys: ["on_band"],
      challengeOverflowCap: 5,
      maxActiveStrands: 5,
    });

    expect(keysOf(q.filter((i) => i.reason === "new"))).toEqual(["untagged"]);
    expect(keysOf(q.filter((i) => i.reason === "challenge"))).toContain("on_band");
  });

  test("first-block CALIBRATION lane fills the block from credited skills when the frontier is excluded (never an empty first block)", () => {
    // credited_a/b are inferred-credited (fluent-fresh, not due, not frontier);
    // frontier_x is the ONLY frontier but is a just-flagged don't-know, so the
    // required-exclusion demotes it to challenge. Without calibration the "new"
    // lane would be EMPTY (the round-4 "Nothing to practice" dead end).
    const cKeys = ["credited_a", "credited_b", "frontier_x"];
    const cEdges: GraphEdge[] = [
      { fromKey: "credited_a", toKey: "frontier_x" },
      { fromKey: "credited_b", toKey: "frontier_x" },
    ];
    const cStates = { credited_a: fluentFresh, credited_b: fluentFresh, frontier_x: untouched };

    // No calibration → frontier_x excluded → NOTHING in the "new" lane.
    const empty = nextPractice(cKeys, cEdges, stateOfFrom(cStates), NOW, 5, {
      requiredExcludedSkillKeys: ["frontier_x"],
    });
    expect(keysOf(empty.filter((i) => i.reason === "new"))).toEqual([]);

    // WITH the calibration lane → the credited skills fill the first block as
    // ordinary "new" work (order preserved), so the block is real, not empty.
    const filled = nextPractice(cKeys, cEdges, stateOfFrom(cStates), NOW, 5, {
      requiredExcludedSkillKeys: ["frontier_x"],
      calibrationSkillKeys: ["credited_b", "credited_a"],
    });
    expect(keysOf(filled.filter((i) => i.reason === "new"))).toEqual(["credited_b", "credited_a"]);
    // The excluded frontier still rides along as an optional challenge, never lost.
    expect(keysOf(filled.filter((i) => i.reason === "challenge"))).toContain("frontier_x");
  });

  test("first-block foundation fallback outranks challenge without granting credit", () => {
    const q = nextPractice(["foundation"], [], stateOfFrom({}), NOW, 5, {
      gradeOf: () => "6",
      scholarBandCeiling: 2,
      requiredExcludedSkillKeys: ["foundation"],
      calibrationSkillKeys: ["foundation"],
    });

    expect(q).toEqual([{ key: "foundation", reason: "new", strand: "" }]);
  });

  test("reviews are never band-filtered", () => {
    const states = { high_1: fluentDue };
    const q = nextPractice(keys, [], stateOfFrom(states), NOW, 10, {
      gradeOf,
      scholarBandCeiling: 4,
      maxActiveStrands: 5,
    });

    expect(q[0]).toMatchObject({ key: "high_1", reason: "review" });
    expect(keysOf(q.filter((i) => i.reason === "new"))).toEqual(["on_band", "untagged"]);
  });

  test("missing grade metadata is band-exempt", () => {
    const q = nextPractice(keys, [], stateOfFrom({}), NOW, 10, {
      gradeOf: () => undefined,
      scholarBandCeiling: 0,
      maxActiveStrands: 5,
    });

    expect(keysOf(q.filter((i) => i.reason === "new"))).toEqual(keys);
    expect(q.some((i) => i.reason === "challenge")).toBe(false);
  });

  test("a teacher pin on an above-band skill overrides the band (served as new, hoisted)", () => {
    const q = nextPractice(keys, [], stateOfFrom({}), NOW, 10, {
      gradeOf,
      scholarBandCeiling: 4,
      focusSkillKey: "high_2", // grade 7, well above the ceiling
      maxActiveStrands: 5,
    });

    // The explicit teacher pin beats the grade-band heuristic: it's a normal
    // NEW pick (never demoted to the filtered-out challenge overflow) and is
    // hoisted to the very front.
    expect(q[0]).toMatchObject({ key: "high_2", reason: "new" });
    expect(keysOf(q.filter((i) => i.reason === "challenge"))).not.toContain("high_2");
    // Other above-band skills are still banded into the challenge overflow.
    expect(keysOf(q.filter((i) => i.reason === "challenge"))).toEqual(["high_1", "high_3"]);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Structural challenge tail — one-hop widening (the #735 finding). For a
// demonstrably-strong learner the band ceiling rises in lockstep with the
// frontier, so an above-band key's prereqs sit AT the frontier (being
// practiced, not yet fluent) and never reach `rawFrontier` — leaving the
// `reason: "challenge"` tail empty and the opt-in offer permanently dark. When
// (and only when) that structural tail is empty, the scheduler reaches ONE hop
// past the reachable frontier, filling the SAME gate's empty input.
// ─────────────────────────────────────────────────────────────────────────
describe("nextPractice — one-hop challenge-tail widening", () => {
  /** A frontier skill actively being practiced: not fluent, but fresh (not due). */
  const practicing: SkillState = { repetition: 2, halfLifeDays: 60, lastPracticedAt: NOW - 1 * DAY };

  test("strong-learner lockstep: widens exactly one hop past the frontier, tagged challenge", () => {
    // found(3, fluent) → mid(4, practicing) → top(5) → top2(5). The only
    // rawFrontier member is `mid` (on-band): `top`'s prereq `mid` is not yet
    // fluent, so NO above-band key is structurally reachable → the old code's
    // challenge tail is empty. The widening admits `top` (its one prereq is on
    // the frontier) but NOT `top2` (two hops past — its prereq `top` is neither
    // fluent nor on the frontier).
    const keys = ["found", "mid", "top", "top2"];
    const edges: GraphEdge[] = [
      { fromKey: "found", toKey: "mid" },
      { fromKey: "mid", toKey: "top" },
      { fromKey: "top", toKey: "top2" },
    ];
    const grades: Record<string, string> = { found: "3", mid: "4", top: "5", top2: "5" };
    const states = { found: fluentFresh, mid: practicing };

    const q = nextPractice(keys, edges, stateOfFrom(states), NOW, 10, {
      gradeOf: (k) => grades[k],
      scholarBandCeiling: 4,
      challengeOverflowCap: 2,
      maxActiveStrands: 5,
    });

    // The on-band frontier is served as ordinary NEW work (never challenge).
    expect(keysOf(q.filter((i) => i.reason === "new"))).toEqual(["mid"]);
    // The one-hop-past above-band key is surfaced as the challenge tail…
    expect(keysOf(q.filter((i) => i.reason === "challenge"))).toEqual(["top"]);
    // …and the two-hops-past key is not reachable and never served.
    expect(keysOf(q)).not.toContain("top2");
  });

  test("does NOT fire when the structural challenge tail is already nonempty", () => {
    // found(3, fluent) → structTop(5) → farTop(6). `structTop` IS structurally
    // reachable (its prereq `found` is fluent) → the challenge tail is nonempty,
    // so the one-hop widening must stay dormant and `farTop` (one hop past
    // `structTop`) must NOT be pulled in.
    const keys = ["found", "structTop", "farTop"];
    const edges: GraphEdge[] = [
      { fromKey: "found", toKey: "structTop" },
      { fromKey: "structTop", toKey: "farTop" },
    ];
    const grades: Record<string, string> = { found: "3", structTop: "5", farTop: "6" };

    const q = nextPractice(keys, edges, stateOfFrom({ found: fluentFresh }), NOW, 10, {
      gradeOf: (k) => grades[k],
      scholarBandCeiling: 4,
      challengeOverflowCap: 5,
      maxActiveStrands: 5,
    });

    expect(keysOf(q.filter((i) => i.reason === "challenge"))).toEqual(["structTop"]);
    expect(keysOf(q)).not.toContain("farTop");
  });

  test("widened one-hop candidates are ordered and capped by challengeOverflowCap", () => {
    // Two on-band frontier skills being practiced, each gating its own above-band
    // key → two one-hop candidates. The overflow cap still bounds the tail.
    const keys = ["fa", "fb", "ma", "mb", "ta", "tb"];
    const edges: GraphEdge[] = [
      { fromKey: "fa", toKey: "ma" },
      { fromKey: "fb", toKey: "mb" },
      { fromKey: "ma", toKey: "ta" },
      { fromKey: "mb", toKey: "tb" },
    ];
    const grades: Record<string, string> = {
      fa: "3", fb: "3", ma: "4", mb: "4", ta: "5", tb: "5",
    };
    const states = { fa: fluentFresh, fb: fluentFresh, ma: practicing, mb: practicing };

    const q = nextPractice(keys, edges, stateOfFrom(states), NOW, 10, {
      gradeOf: (k) => grades[k],
      scholarBandCeiling: 4,
      challengeOverflowCap: 1,
      maxActiveStrands: 5,
    });

    expect(q.filter((i) => i.reason === "challenge")).toHaveLength(1);
    expect(["ta", "tb"]).toContain(q.find((i) => i.reason === "challenge")!.key);
  });

  test("widening is above-band only: an on-band one-hop key is not admitted", () => {
    // found(3, fluent) → mid(4, practicing) → onBandNext(4). `onBandNext` is one
    // hop past the frontier but on-band (grade == ceiling), so it is neither a
    // structural frontier pick nor a challenge candidate — it is simply not yet
    // reachable and is not served.
    const keys = ["found", "mid", "onBandNext"];
    const edges: GraphEdge[] = [
      { fromKey: "found", toKey: "mid" },
      { fromKey: "mid", toKey: "onBandNext" },
    ];
    const grades: Record<string, string> = { found: "3", mid: "4", onBandNext: "4" };

    const q = nextPractice(keys, edges, stateOfFrom({ found: fluentFresh, mid: practicing }), NOW, 10, {
      gradeOf: (k) => grades[k],
      scholarBandCeiling: 4,
      challengeOverflowCap: 2,
      maxActiveStrands: 5,
    });

    expect(q.some((i) => i.reason === "challenge")).toBe(false);
    expect(keysOf(q)).not.toContain("onBandNext");
  });

  test("widening is band-gated: no band (no gradeOf) leaves the empty tail empty", () => {
    // Same lockstep shape, but with no grade band active the challenge tail stays
    // empty — the widening is a band-only affordance, never a general frontier
    // relaxation.
    const keys = ["found", "mid", "top"];
    const edges: GraphEdge[] = [
      { fromKey: "found", toKey: "mid" },
      { fromKey: "mid", toKey: "top" },
    ];
    const q = nextPractice(keys, edges, stateOfFrom({ found: fluentFresh, mid: practicing }), NOW, 10, {
      maxActiveStrands: 5,
    });

    expect(q.some((i) => i.reason === "challenge")).toBe(false);
    expect(keysOf(q.filter((i) => i.reason === "new"))).toEqual(["mid"]);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Acceleration valve (B1 — raise-the-ceiling §4): the pure decision logic.
// A demonstrated FAST streak at a frontier node earns fluent credit; a
// slow-but-correct kid, a locked node, an already-fluent node, a broken streak,
// and a chained jump all correctly DON'T fire.
describe("acceleration valve — shouldAccelerate", () => {
  const base = {
    correct: true,
    prevRepetition: 1,
    nextAccelStreak: 2,
    isFrontierNode: true,
    prereqAcceleratedRecently: false,
    isFast: true,
  };

  test("fires: fast clean streak (≥2) at a frontier node", () => {
    expect(shouldAccelerate(base)).toBe(true);
  });
  test("does NOT fire on a miss", () => {
    expect(shouldAccelerate({ ...base, correct: false })).toBe(false);
  });
  test("does NOT fire when the node is already fluent", () => {
    expect(shouldAccelerate({ ...base, prevRepetition: 3 })).toBe(false);
  });
  test("does NOT fire on a non-frontier (locked) node", () => {
    expect(shouldAccelerate({ ...base, isFrontierNode: false })).toBe(false);
  });
  test("does NOT fire when the streak is below threshold", () => {
    expect(shouldAccelerate({ ...base, nextAccelStreak: 1 })).toBe(false);
  });
  test("does NOT fire when not fast (slow-but-correct keeps the full rep count)", () => {
    expect(shouldAccelerate({ ...base, isFast: false })).toBe(false);
  });
  test("does NOT fire when a prereq was just accelerated (one jump per chain)", () => {
    expect(shouldAccelerate({ ...base, prereqAcceleratedRecently: true })).toBe(false);
  });
});

describe("acceleration valve — latency baseline reducer (self-relative)", () => {
  test("undefined until enough skills carry a reading", () => {
    expect(latencyBaselineFromSkillMedians([])).toBeUndefined();
    expect(latencyBaselineFromSkillMedians([1000, 1200])).toBeUndefined(); // < MIN
    expect(ACCEL_MIN_BASELINE_SKILLS).toBe(3);
  });
  test("median of the per-skill medians once there are enough", () => {
    expect(latencyBaselineFromSkillMedians([1000, 2000, 3000])).toBe(2000);
    expect(latencyBaselineFromSkillMedians([3000, 1000, 2000, 4000])).toBe(2500); // even → mean of middle two
  });
  test("ignores non-finite / non-positive readings", () => {
    expect(latencyBaselineFromSkillMedians([1000, NaN, 2000, 0, 3000])).toBe(2000);
  });
});

// ── Repetition compression (FIRe §4A) ────────────────────────────────────
// With `compressReviews`, the due review that implicitly refreshes the most
// OTHER due skills (its due prerequisites, via `ancestorWeights`) is served
// first — so one answer covers several fading facts. Ties fall back to the
// pre-compression most-decayed-first order.
describe("nextPractice — review compression (compressReviews)", () => {
  // d builds on b and c; all three are due. Answering d trickles credit to b+c.
  const keys = ["b", "c", "d"];
  const edges: GraphEdge[] = [
    { fromKey: "b", toKey: "d" },
    { fromKey: "c", toKey: "d" },
  ];
  const states: Record<string, SkillState> = {
    b: { repetition: 4, halfLifeDays: 5, lastPracticedAt: NOW - 40 * DAY }, // most decayed
    c: { repetition: 4, halfLifeDays: 5, lastPracticedAt: NOW - 25 * DAY }, // middle
    d: { repetition: 4, halfLifeDays: 5, lastPracticedAt: NOW - 10 * DAY }, // least decayed
  };

  test("off: reviews stay in most-decayed-first order", () => {
    const q = nextPractice(keys, edges, stateOfFrom(states), NOW, 5);
    expect(keysOf(q)).toEqual(["b", "c", "d"]);
  });

  test("on: the highest-coverage review (d, covers b+c) is served first", () => {
    const q = nextPractice(keys, edges, stateOfFrom(states), NOW, 5, {
      compressReviews: true,
    });
    // d has cover-count 2 (b and c are due prereqs); b and c have 0 → they keep
    // the most-decayed-first tiebreak behind d.
    expect(keysOf(q)).toEqual(["d", "b", "c"]);
    expect(q[0]).toMatchObject({ key: "d", reason: "review" });
  });

  test("also ranks equal-readiness frontier picks by due prerequisite coverage", () => {
    const frontierKeys = ["plain", "compressed"];
    const duePrereqs = ["d1", "d2", "d3"];
    const freshPrereqs = ["f1", "f2", "f3"];
    const keys = [...freshPrereqs, ...duePrereqs, ...frontierKeys];
    const edges: GraphEdge[] = [
      ...freshPrereqs.map((fromKey) => ({ fromKey, toKey: "plain" })),
      ...duePrereqs.map((fromKey) => ({ fromKey, toKey: "compressed" })),
    ];
    const states: Record<string, SkillState> = {};
    for (const key of freshPrereqs) states[key] = fluentFresh;
    for (const key of duePrereqs) states[key] = fluentDue;

    const withoutCompression = nextPractice(keys, edges, stateOfFrom(states), NOW, 10, {
      strandOf: () => "A",
      maxActiveStrands: 5,
    }).filter((item) => item.reason === "new");
    const withCompression = nextPractice(keys, edges, stateOfFrom(states), NOW, 10, {
      strandOf: () => "A",
      maxActiveStrands: 5,
      compressReviews: true,
    }).filter((item) => item.reason === "new");

    expect(keysOf(withoutCompression)).toEqual(["plain", "compressed"]);
    expect(keysOf(withCompression)).toEqual(["compressed", "plain"]);
  });
});
