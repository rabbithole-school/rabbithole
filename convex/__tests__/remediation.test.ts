/**
 * Auto-remediation on plateau (§5, "C"). Pure-lib tests for
 * `convex/lib/practice/remediation.ts`: which flagged node drives remediation
 * (`pickFlaggedNode`) and which prerequisite of it gets drilled
 * (`pickRemediationTarget`). No Convex here — mirrors the scheduler / FIRe
 * pure-lib test style.
 */
import { describe, expect, test } from "vitest";
import type { GraphEdge, SkillState } from "../lib/practice/scheduler";
import { FLUENT_REPS } from "../lib/practice/scheduler";
import { ERROR_FLAG_MIN_COUNT } from "../lib/practice/errorFlags";
import {
  pickFlaggedNode,
  pickRemediationTarget,
  REMEDIATION_RETENTION_BAR,
  type NodeErrorEvent,
} from "../lib/practice/remediation";

const DAY = 86_400_000;
const NOW = 1_000 * DAY; // arbitrary fixed "now"

/** Build a `buildsOn` edge — "toKey builds on fromKey" (fromKey is the prereq). */
function edge(fromKey: string, toKey: string): GraphEdge {
  return { fromKey, toKey };
}

/** A recent miss on `nodeKey` with `pattern`, `ageDays` before NOW. */
function miss(nodeKey: string, pattern: string, ageDays: number): NodeErrorEvent {
  return { nodeKey, pattern, createdAt: NOW - ageDays * DAY };
}

/** `MIN_COUNT` same-pattern misses on a node, all fresh, most recent `lastAgeDays` old. */
function openFlag(nodeKey: string, pattern: string, lastAgeDays: number): NodeErrorEvent[] {
  return Array.from({ length: ERROR_FLAG_MIN_COUNT }, (_, i) =>
    miss(nodeKey, pattern, lastAgeDays + i),
  );
}

/**
 * A state at a given retention: reps ≥ FLUENT_REPS and a half-life chosen so
 * `2^(-days/halfLife)` lands on `ret`. Used to place prereqs above/below the bar.
 */
function stateAtRetention(ret: number, daysSince = 1): SkillState {
  // ret = 2^(-days/hl)  =>  hl = -days / log2(ret)
  const halfLifeDays = -daysSince / Math.log2(ret);
  return { repetition: FLUENT_REPS, halfLifeDays, lastPracticedAt: NOW - daysSince * DAY };
}

describe("pickFlaggedNode", () => {
  test("no events → null", () => {
    expect(pickFlaggedNode([], NOW)).toBeNull();
  });

  test("below MIN_COUNT → not flagged", () => {
    const events = [miss("add_2digit", "DROPPED_CARRY", 1), miss("add_2digit", "DROPPED_CARRY", 2)];
    expect(pickFlaggedNode(events, NOW)).toBeNull();
  });

  test("stale events (outside 14d window) → not flagged", () => {
    const events = openFlag("add_2digit", "DROPPED_CARRY", 30); // all ≥30d old
    expect(pickFlaggedNode(events, NOW)).toBeNull();
  });

  test("single open flag → that node", () => {
    const events = openFlag("add_2digit", "DROPPED_CARRY", 1);
    expect(pickFlaggedNode(events, NOW)).toBe("add_2digit");
  });

  test("most-recently-reinforced flag wins across nodes", () => {
    const events = [
      ...openFlag("node_old", "DROPPED_CARRY", 5), // freshest event 5d old
      ...openFlag("node_new", "SMALLER_FROM_LARGER", 1), // freshest event 1d old
    ];
    expect(pickFlaggedNode(events, NOW)).toBe("node_new");
  });

  test("tie on recency breaks by nodeKey asc", () => {
    const events = [
      ...openFlag("bbb", "DROPPED_CARRY", 1),
      ...openFlag("aaa", "SMALLER_FROM_LARGER", 1),
    ];
    expect(pickFlaggedNode(events, NOW)).toBe("aaa");
  });
});

describe("pickRemediationTarget", () => {
  const flagged = "add_2digit_regroup";
  const edges = [
    edge("place_value", flagged),
    edge("add_within_20", flagged),
    edge("add_within_10", flagged),
    edge("unrelated", "some_other_node"), // not a prereq of the flagged node
  ];

  test("lowest-retention weak prereq wins", () => {
    const stateOf = (k: string): SkillState | undefined => {
      if (k === "place_value") return stateAtRetention(0.7); // weakest
      if (k === "add_within_20") return stateAtRetention(0.85);
      if (k === "add_within_10") return stateAtRetention(0.95); // solid → excluded
      return undefined;
    };
    expect(pickRemediationTarget(flagged, edges, stateOf, NOW)).toBe("place_value");
  });

  test("all prereqs fluent + well-retained → null (stand down)", () => {
    const stateOf = (): SkillState => stateAtRetention(0.99);
    expect(pickRemediationTarget(flagged, edges, stateOf, NOW)).toBeNull();
  });

  test("low reps counts as not-solid even at high retention", () => {
    const stateOf = (k: string): SkillState | undefined => {
      if (k === "add_within_20") {
        // just learned: reps below fluent, retention high
        return { repetition: FLUENT_REPS - 1, halfLifeDays: 30, lastPracticedAt: NOW };
      }
      if (k === "place_value") return stateAtRetention(0.99); // solid
      return undefined;
    };
    expect(pickRemediationTarget(flagged, edges, stateOf, NOW)).toBe("add_within_20");
  });

  test("prereqs without a mastery row are skipped", () => {
    const stateOf = (k: string): SkillState | undefined =>
      k === "add_within_10" ? stateAtRetention(0.5) : undefined; // only one has a row
    expect(pickRemediationTarget(flagged, edges, stateOf, NOW)).toBe("add_within_10");
  });

  test("no mastery rows at all → null", () => {
    expect(pickRemediationTarget(flagged, edges, () => undefined, NOW)).toBeNull();
  });

  test("root node (no prereqs) → null", () => {
    const stateOf = (): SkillState => stateAtRetention(0.1);
    expect(pickRemediationTarget("count_to_10", edges, stateOf, NOW)).toBeNull();
  });

  test("retention tie breaks by skillKey asc", () => {
    const stateOf = (k: string): SkillState | undefined => {
      // place_value + add_within_10 both at 0.5; add_within_20 solid
      if (k === "place_value" || k === "add_within_10") return stateAtRetention(0.5);
      if (k === "add_within_20") return stateAtRetention(0.99);
      return undefined;
    };
    // "add_within_10" < "place_value"
    expect(pickRemediationTarget(flagged, edges, stateOf, NOW)).toBe("add_within_10");
  });

  test("exactly at the bar is solid (retention === BAR, reps fluent) → excluded", () => {
    const stateOf = (k: string): SkillState | undefined =>
      k === "place_value" ? stateAtRetention(REMEDIATION_RETENTION_BAR) : undefined;
    expect(pickRemediationTarget(flagged, edges, stateOf, NOW)).toBeNull();
  });
});

// D4 policy boundary: remediation stays DOMAIN-PURE. A child-domain node may have
// a FOREIGN prerequisite (a cross-domain buildsOn edge — e.g. the live bridge
// fraction_as_parts → probability_as_fraction). The remediation `stateOf` built in
// autoRemediationTargetForNode reads only the flagged node's OWN-domain mastery, so
// it returns `undefined` for a foreign prereq — which pickRemediationTarget already
// skips ("no mastery row → not a candidate"). So a miss on a child-domain skill can
// NEVER drill a parent-domain prerequisite; remediation only ever serves in-domain.
describe("pickRemediationTarget — cross-domain (D4 domain-purity)", () => {
  // probability_as_fraction's two prereqs: an own-domain one and the foreign
  // fraction bridge. A domain-pure stateOf returns undefined for the foreign key.
  const xedges: GraphEdge[] = [
    edge("theoretical_probability_simple", "probability_as_fraction"),
    edge("fraction_as_parts", "probability_as_fraction"), // foreign (fraction domain)
  ];

  test("drills the weak OWN-domain prereq, never the foreign one", () => {
    const stateOf = (k: string): SkillState | undefined => {
      if (k === "theoretical_probability_simple") return stateAtRetention(0.4); // weak, own-domain
      return undefined; // foreign fraction_as_parts has no probability-domain row
    };
    expect(pickRemediationTarget("probability_as_fraction", xedges, stateOf, NOW)).toBe(
      "theoretical_probability_simple",
    );
  });

  test("never returns the foreign prereq even when it is the only weak candidate", () => {
    // Own prereq solid; the foreign prereq is domain-invisible (undefined) → stand down.
    const stateOf = (k: string): SkillState | undefined =>
      k === "theoretical_probability_simple" ? stateAtRetention(0.99) : undefined;
    const target = pickRemediationTarget("probability_as_fraction", xedges, stateOf, NOW);
    expect(target).toBeNull();
    expect(target).not.toBe("fraction_as_parts");
  });
});
