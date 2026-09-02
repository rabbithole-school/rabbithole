import { describe, expect, test } from "vitest";
import {
  nextPractice,
  CONFIRMATION_LANE_CAP,
  type GraphEdge,
  type SkillState,
} from "../practice/scheduler";

// ─────────────────────────────────────────────────────────────────────────
// Confirmation lane (placement-v2). Placement credits a whole prefix on a
// short (4-day) leash, so ~day 3 the ENTIRE placed set crosses DUE_THRESHOLD
// at once and — without metering — floods `nextPractice` with easy review of
// skills the kid just placed out of. The confirmation lane partitions the due
// channel into DEMONSTRATED (real attempts — sacred) and INFERRED (never-
// attempted placement/accel/reprobe credit), meters the inferred lane to
// `CONFIRMATION_LANE_CAP` per session, and hands the freed slots to frontier —
// so a freshly-placed scholar's session stays frontier-dominant.
//
// The classifier `inferredDueCredit` is supplied directly here (in the wiring
// it's built from mastery-row `source`/`lastAttemptAt` in `buildStrandScheduling`).
// ─────────────────────────────────────────────────────────────────────────

const NOW = 100 * 86_400_000;
const DAY = 86_400_000;

/** Fluent + fresh: not due, not frontier. */
const fluentFresh: SkillState = { repetition: 4, halfLifeDays: 60, lastPracticedAt: NOW - 1 * DAY };
/** Decayed below 0.6 → a due review. */
const due: SkillState = { repetition: 4, halfLifeDays: 5, lastPracticedAt: NOW - 30 * DAY };
/** Never touched → a frontier candidate (if prereqs are fluent). */
const untouched: SkillState = { repetition: 0, halfLifeDays: 0 };

const stateOfFrom = (states: Record<string, SkillState>) =>
  (key: string): SkillState => states[key] ?? untouched;
const strandOfFrom = (strands: Record<string, string>) =>
  (key: string): string | undefined => strands[key];
const inferredFrom = (inferred: Set<string>) => (key: string): boolean => inferred.has(key);
const keysOf = (q: { key: string }[]) => q.map((i) => i.key);

// A freshly-placed scholar: N placement-credited (inferred) skills that all
// come due at once, plus a handful of frontier ("new") skills at their edge on
// a second strand. This is the exact "placement flood" the lane defends against.
function placementFlood(nInferred = 8, nFrontier = 4) {
  const inferredKeys = Array.from({ length: nInferred }, (_, i) => `p${i}`);
  const frontierKeys = Array.from({ length: nFrontier }, (_, i) => `f${i}`);
  const keys = [...inferredKeys, ...frontierKeys];
  const edges: GraphEdge[] = [];
  const strands: Record<string, string> = {};
  const states: Record<string, SkillState> = {};
  inferredKeys.forEach((k, i) => {
    strands[k] = "placed-strand";
    // Most-decayed-first: p0 most decayed. All are due (inferred placement credit).
    states[k] = { repetition: 4, halfLifeDays: 5, lastPracticedAt: NOW - (40 - i) * DAY };
  });
  frontierKeys.forEach((k) => {
    strands[k] = "frontier-strand";
    states[k] = untouched;
  });
  return { keys, edges, strands, states, inferred: new Set(inferredKeys), frontierKeys, inferredKeys };
}

// ── The partition ─────────────────────────────────────────────────────────
describe("confirmation lane — partition of the due channel", () => {
  test("demonstrated-due reviews keep full priority (never metered)", () => {
    // 5 demonstrated due reviews + 2 frontier. None are inferred, so the lane is
    // empty and behavior matches today (reviews win the review budget).
    const keys = ["d0", "d1", "d2", "d3", "d4", "n0", "n1"];
    const strands = { d0: "s", d1: "s", d2: "s", d3: "s", d4: "s", n0: "t", n1: "t" };
    const states: Record<string, SkillState> = {
      d0: due, d1: due, d2: due, d3: due, d4: due, n0: untouched, n1: untouched,
    };
    const q = nextPractice(keys, [], stateOfFrom(states), NOW, 5, {
      strandOf: strandOfFrom(strands),
      maxActiveStrands: 5,
      applyMixFloor: true,
      inferredDueCredit: inferredFrom(new Set()), // nothing inferred
    });
    // floor = ceil(5/4)=2 → 3 review + 2 frontier, unchanged from pre-lane.
    expect(q.filter((i) => i.reason === "review")).toHaveLength(3);
    expect(q.filter((i) => i.reason === "new")).toHaveLength(2);
  });

  test("only inferred-due rows are metered; a demonstrated due row on the same strand is not", () => {
    // p* inferred, d* demonstrated — both due, both on the placed strand.
    const keys = ["p0", "p1", "p2", "d0", "d1", "f0", "f1"];
    const strands: Record<string, string> = {
      p0: "s", p1: "s", p2: "s", d0: "s", d1: "s", f0: "t", f1: "t",
    };
    const states: Record<string, SkillState> = {
      p0: due, p1: due, p2: due, d0: due, d1: due, f0: untouched, f1: untouched,
    };
    const q = nextPractice(keys, [], stateOfFrom(states), NOW, 5, {
      strandOf: strandOfFrom(strands),
      maxActiveStrands: 5,
      applyMixFloor: true,
      inferredDueCredit: inferredFrom(new Set(["p0", "p1", "p2"])),
    });
    const served = keysOf(q);
    // The 2 demonstrated reviews (sacred) are served; inferred is capped at 2.
    expect(served).toContain("d0");
    expect(served).toContain("d1");
    const inferredServed = served.filter((k) => k.startsWith("p"));
    expect(inferredServed.length).toBeLessThanOrEqual(CONFIRMATION_LANE_CAP);
  });
});

// ── The 1–2/session cap ────────────────────────────────────────────────────
describe("confirmation lane — the per-session cap", () => {
  test("caps inferred-due at CONFIRMATION_LANE_CAP even when the whole placed set is due", () => {
    const { keys, edges, strands, states, inferred } = placementFlood(8, 4);
    const q = nextPractice(keys, edges, stateOfFrom(states), NOW, 5, {
      strandOf: strandOfFrom(strands),
      maxActiveStrands: 5,
      applyMixFloor: true,
      inferredDueCredit: inferredFrom(inferred),
    });
    const inferredServed = keysOf(q).filter((k) => k.startsWith("p"));
    expect(inferredServed.length).toBe(CONFIRMATION_LANE_CAP);
    expect(inferredServed.length).toBeLessThanOrEqual(2);
  });

  test("CONFIRMATION_LANE_CAP is 2 (a small trickle, not a review block)", () => {
    expect(CONFIRMATION_LANE_CAP).toBe(2);
  });

  test("serves the MOST-decayed inferred rows first (p0, p1 — not p6, p7)", () => {
    const { keys, edges, strands, states, inferred } = placementFlood(8, 4);
    const q = nextPractice(keys, edges, stateOfFrom(states), NOW, 5, {
      strandOf: strandOfFrom(strands),
      maxActiveStrands: 5,
      applyMixFloor: true,
      inferredDueCredit: inferredFrom(inferred),
    });
    const inferredServed = keysOf(q).filter((k) => k.startsWith("p"));
    expect(new Set(inferredServed)).toEqual(new Set(["p0", "p1"]));
  });
});

// ── Day 1 vs Day 4: the core scenario ──────────────────────────────────────
describe("confirmation lane — day-1 vs day-4 after placement", () => {
  test("day 1 (nothing due yet): all frontier, no confirmation", () => {
    // Placement rows are fresh (just credited) → none due. Frontier at the edge.
    const { keys, edges, strands, frontierKeys, inferredKeys } = placementFlood(8, 4);
    const states: Record<string, SkillState> = {};
    for (const k of inferredKeys) states[k] = fluentFresh; // fresh placement credit → not due
    for (const k of frontierKeys) states[k] = untouched;
    const q = nextPractice(keys, edges, stateOfFrom(states), NOW, 5, {
      strandOf: strandOfFrom(strands),
      maxActiveStrands: 5,
      applyMixFloor: true,
      inferredDueCredit: inferredFrom(new Set(inferredKeys)),
    });
    expect(q.every((i) => i.reason === "new")).toBe(true);
    expect(q.length).toBeGreaterThan(0);
  });

  test("day 4 (whole placed set due at once): frontier-DOMINANT with a small trickle, NOT review-flooded", () => {
    const { keys, edges, strands, states, inferred } = placementFlood(8, 4);
    const withLane = nextPractice(keys, edges, stateOfFrom(states), NOW, 5, {
      strandOf: strandOfFrom(strands),
      maxActiveStrands: 5,
      applyMixFloor: true,
      inferredDueCredit: inferredFrom(inferred),
    });
    const newCount = withLane.filter((i) => i.reason === "new").length;
    const reviewCount = withLane.filter((i) => i.reason === "review").length;
    // Frontier-dominant: strictly more new than review, and the trickle is capped.
    expect(newCount).toBeGreaterThan(reviewCount);
    expect(reviewCount).toBeLessThanOrEqual(CONFIRMATION_LANE_CAP);
    expect(newCount).toBe(3);
    expect(reviewCount).toBe(2);

    // Contrast: WITHOUT the classifier the same session is review-flooded — the
    // exact regression the lane fixes (only the mix-floor's 2 frontier slots).
    const withoutLane = nextPractice(keys, edges, stateOfFrom(states), NOW, 5, {
      strandOf: strandOfFrom(strands),
      maxActiveStrands: 5,
      applyMixFloor: true,
    });
    expect(withoutLane.filter((i) => i.reason === "review").length).toBe(3);
    expect(withoutLane.filter((i) => i.reason === "new").length).toBe(2);
  });
});

// ── The mix floor still protects frontier from BOTH review kinds ────────────
describe("confirmation lane — never eats the frontier mix floor", () => {
  test("demonstrated reviews fill the budget AND the confirmation lane still can't drop frontier below the floor", () => {
    // 4 demonstrated + 3 inferred due, plus abundant frontier. limit 5, floor 2.
    const keys = ["d0", "d1", "d2", "d3", "p0", "p1", "p2", "f0", "f1", "f2", "f3"];
    const strands: Record<string, string> = {};
    const states: Record<string, SkillState> = {};
    for (const k of ["d0", "d1", "d2", "d3", "p0", "p1", "p2"]) { strands[k] = "s"; states[k] = due; }
    for (const k of ["f0", "f1", "f2", "f3"]) { strands[k] = "t"; states[k] = untouched; }
    const q = nextPractice(keys, [], stateOfFrom(states), NOW, 5, {
      strandOf: strandOfFrom(strands),
      maxActiveStrands: 5,
      applyMixFloor: true,
      inferredDueCredit: inferredFrom(new Set(["p0", "p1", "p2"])),
    });
    // floor = 2 → frontier gets 2; demonstrated reviews take the 3-slot budget;
    // the inferred lane spills entirely (no room beyond the floor).
    expect(q.filter((i) => i.reason === "new")).toHaveLength(2);
    const served = keysOf(q);
    expect(served.filter((k) => k.startsWith("d")).length).toBe(3); // demonstrated, sacred
    expect(served.filter((k) => k.startsWith("p")).length).toBe(0); // inferred spilled
    expect(q).toHaveLength(5);
  });
});

// ── Scarce frontier: the confirmation cap still holds ───────────────────────
describe("confirmation lane — short honest runs when frontier is scarce", () => {
  test("with NO frontier and only inferred-due, serves a capped short block", () => {
    const inferredKeys = Array.from({ length: 8 }, (_, i) => `p${i}`);
    const strands: Record<string, string> = {};
    const states: Record<string, SkillState> = {};
    inferredKeys.forEach((k, i) => {
      strands[k] = "placed-strand";
      states[k] = { repetition: 4, halfLifeDays: 5, lastPracticedAt: NOW - (40 - i) * DAY };
    });
    const q = nextPractice(inferredKeys, [], stateOfFrom(states), NOW, 5, {
      strandOf: strandOfFrom(strands),
      maxActiveStrands: 5,
      applyMixFloor: true,
      inferredDueCredit: inferredFrom(new Set(inferredKeys)),
    });
    expect(q).toHaveLength(CONFIRMATION_LANE_CAP);
    expect(q.every((i) => i.reason === "review")).toBe(true);
    expect(keysOf(q)).toEqual(["p0", "p1"]); // most-decayed-first
  });

  test("with one frontier item, does not backfill the remaining slots with confirmations", () => {
    const { keys, edges, strands, states, inferred } = placementFlood(8, 1);
    const q = nextPractice(keys, edges, stateOfFrom(states), NOW, 5, {
      strandOf: strandOfFrom(strands),
      maxActiveStrands: 5,
      applyMixFloor: true,
      inferredDueCredit: inferredFrom(inferred),
    });
    expect(q).toHaveLength(1 + CONFIRMATION_LANE_CAP);
    expect(keysOf(q)).toContain("f0");
    expect(keysOf(q).filter((key) => key.startsWith("p"))).toEqual(["p0", "p1"]);
  });

  test("required calibration wins over a colliding inferred confirmation without crowding frontier", () => {
    const { keys, edges, strands, states, inferred } = placementFlood(8, 6);
    const q = nextPractice(keys, edges, stateOfFrom(states), NOW, 5, {
      strandOf: strandOfFrom(strands),
      maxActiveStrands: 5,
      applyMixFloor: true,
      inferredDueCredit: inferredFrom(inferred),
      calibrationSkillKeys: ["p0"],
      focusSkillKey: "f0",
    });
    const calibration = q.filter((item) => item.key === "p0");
    const confirmations = q.filter(
      (item) => item.reason === "review" && inferred.has(item.key),
    );
    expect(calibration).toEqual([{ key: "p0", reason: "new", strand: "placed-strand" }]);
    expect(confirmations).toHaveLength(CONFIRMATION_LANE_CAP);
    expect(keysOf(confirmations)).toEqual(["p1", "p2"]);
    expect(keysOf(q).slice(0, 3)).toEqual(["f0", "p1", "f1"]);
    expect(keysOf(q)).toContain("p0");
    expect(new Set(keysOf(q)).size).toBe(q.length);
  });

  test("a production-sized colliding calibration lane keeps genuine frontier in the block", () => {
    const { keys, edges, strands, states, inferred } = placementFlood(8, 6);
    const q = nextPractice(keys, edges, stateOfFrom(states), NOW, 6, {
      strandOf: strandOfFrom(strands),
      maxActiveStrands: 5,
      applyMixFloor: true,
      inferredDueCredit: inferredFrom(inferred),
      calibrationSkillKeys: ["p0", "p1", "p2", "p3", "p4", "p5"],
      focusSkillKey: "f0",
    });
    expect(q[0]).toMatchObject({ key: "f0", reason: "new" });
    expect(q.filter((item) => item.key.startsWith("f"))).toHaveLength(2);
    expect(q.filter((item) => item.reason === "review" && inferred.has(item.key))).toHaveLength(
      CONFIRMATION_LANE_CAP,
    );
    expect(new Set(keysOf(q)).size).toBe(q.length);
  });
});

// ── Default (no classifier) is byte-identical to pre-lane behavior ──────────
describe("confirmation lane — absent inferredDueCredit → no metering", () => {
  test("without the classifier, an all-inferred-due flood behaves exactly as today", () => {
    const { keys, edges, strands, states } = placementFlood(8, 4);
    const withClassifierAbsent = nextPractice(keys, edges, stateOfFrom(states), NOW, 5, {
      strandOf: strandOfFrom(strands),
      maxActiveStrands: 5,
      applyMixFloor: true,
    });
    // Pre-lane behavior: mix floor reserves 2 frontier, reviews take the other 3.
    expect(withClassifierAbsent.filter((i) => i.reason === "review")).toHaveLength(3);
    expect(withClassifierAbsent.filter((i) => i.reason === "new")).toHaveLength(2);
  });
});
