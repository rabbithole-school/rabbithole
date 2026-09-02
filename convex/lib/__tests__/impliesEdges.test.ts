import { describe, expect, test } from "vitest";
import {
  computeFrontier,
  type GraphEdge,
  type SkillState,
} from "../practice/scheduler";
import { ancestorWeights, IMPLICIT_WEIGHT_DEFAULT } from "../practice/implicitCredit";
import { topoOrderStrand } from "../practice/placement";
import {
  PROBABILITY_SKILLS,
  PROBABILITY_EDGES,
  PROBABILITY_IMPLIES_EDGES,
} from "../../seed/probabilityGraph";

/**
 * `implies` — the INFERENCE-ONLY edge kind: PURE-MECHANISM properties.
 *
 * These pin the pure functions the production loaders compose, so a regression in
 * the mechanism is caught here. They are NOT the production-faithful proof — the
 * end-to-end behavior lives in convex-test suites, cross-referenced below:
 *   • frontier gate ignores implies                 → here (pure `computeFrontier`)
 *   • recommendation loader is buildsOn-only         → here (pure filter) AND the
 *     real neighbourhood/NodeDrawer surface in `nodeNeighbourhood.test.ts`
 *     ("`implies` never surface in the neighbourhood")
 *   • placement CONSUMES implies (skip + credit)     → `impliesPlacement.test.ts`
 *     drives the REAL `submitPlacementAnswer` path
 *   • implicit credit unions implies                 → here (pure `ancestorWeights`).
 *
 * IMPORTANT (production honesty): the shipped `implies` edges are all CROSS-domain,
 * so FIRe implicit credit is INERT for them in production — the source mastery row
 * lives in another domain, absent from `recordAttemptCore`'s domain-scoped
 * `preMastery`, so the write loop skips it (locked by `practiceSkills.test.ts`
 * "FIRe implicit credit does NOT flow across the cross-domain edge"). The
 * `ancestorWeights` test below therefore asserts only the PURE union mechanism
 * (the wiring that would activate for an intra-domain implies edge), NOT that the
 * shipped cross-domain rows move credit. PLACEMENT is the active production
 * consumer of the shipped edges.
 */

const NOT_KNOWN: SkillState = { repetition: 0, halfLifeDays: 0 };
const FLUENT: SkillState = { repetition: 3, halfLifeDays: 7, lastPracticedAt: Date.now() };

// A real shipped implies edge: source (whole-number, gK) → probability entrance.
const IMPLIES_SRC = "count_objects_within_20";
const IMPLIES_TGT = "read_picture_graph";

const probKeys = PROBABILITY_SKILLS.map((s) => s.skillKey);
const gatingEdges: GraphEdge[] = PROBABILITY_EDGES.map((e) => ({ fromKey: e.fromKey, toKey: e.toKey }));
const inferenceEdges: GraphEdge[] = [
  ...gatingEdges,
  ...PROBABILITY_IMPLIES_EDGES.map((e) => ({ fromKey: e.fromKey, toKey: e.toKey })),
];

describe("implies — inference-only edge kind (pure mechanism)", () => {
  test("the fixture edge is an implies edge, NOT a buildsOn edge", () => {
    expect(
      PROBABILITY_IMPLIES_EDGES.some((e) => e.fromKey === IMPLIES_SRC && e.toKey === IMPLIES_TGT),
    ).toBe(true);
    // Never present in the buildsOn set — the gating graph literally cannot see it.
    expect(
      PROBABILITY_EDGES.some((e) => e.fromKey === IMPLIES_SRC && e.toKey === IMPLIES_TGT),
    ).toBe(false);
  });

  test("NEVER blocks access: the target stays on the frontier despite an unknown implies source", () => {
    // Everything unknown. Over the GATING graph (buildsOn only), the entrance
    // target has no prerequisite, so it is on the frontier even though the implies
    // source is not known.
    const allUnknown = (): SkillState => NOT_KNOWN;
    expect(computeFrontier(probKeys, gatingEdges, allUnknown)).toContain(IMPLIES_TGT);

    // Contrast: the SAME pair treated as a `buildsOn` gate WOULD block the target
    // while the source is unknown — which is exactly the over-gating the curation
    // declined, and precisely why the edge is `implies`, not `buildsOn`.
    const asBuildsOn: GraphEdge[] = [...gatingEdges, { fromKey: IMPLIES_SRC, toKey: IMPLIES_TGT }];
    const stateOf = (k: string): SkillState => (k === IMPLIES_SRC ? NOT_KNOWN : NOT_KNOWN);
    expect(computeFrontier([...probKeys, IMPLIES_SRC], asBuildsOn, stateOf)).not.toContain(IMPLIES_TGT);

    // And once the (hypothetical) gate source is fluent, the buildsOn variant would
    // unblock — confirming the gate is real and the difference is purely the kind.
    const srcFluent = (k: string): SkillState => (k === IMPLIES_SRC ? FLUENT : NOT_KNOWN);
    expect(computeFrontier([...probKeys, IMPLIES_SRC], asBuildsOn, srcFluent)).toContain(IMPLIES_TGT);
  });

  test("NEVER appears in prereq recommendations: the recommendation loader is buildsOn-only", () => {
    // The cross-domain prereq recommendation surface (domainsForScholar prereq
    // gate) loads kind:"buildsOn" rows only. Replicate that exact predicate over a
    // mixed-kind row set: the implies row is dropped before any recommendation is
    // derived, so the implies source is never surfaced as a prerequisite. (The REAL
    // user-facing surface — neighbourhood → NodeDrawer — is covered end-to-end in
    // nodeNeighbourhood.test.ts.)
    const rows = [
      { kind: "buildsOn", fromKey: "fraction_as_parts", toKey: "probability_as_fraction" },
      { kind: "implies", fromKey: IMPLIES_SRC, toKey: IMPLIES_TGT },
    ];
    const recommendationEdges = rows.filter((e) => e.kind === "buildsOn");
    expect(recommendationEdges.some((e) => e.fromKey === IMPLIES_SRC)).toBe(false);
    expect(recommendationEdges.some((e) => e.toKey === IMPLIES_TGT)).toBe(false);
  });

  test("PURE MECHANISM: ancestorWeights unions implies at the buildsOn default weight (inert cross-domain in prod — see header)", () => {
    // The pure `ancestorWeights` over the INFERENCE graph (buildsOn ∪ implies)
    // credits the implies source at the SAME default weight as a buildsOn
    // prerequisite. This is the wiring `recordAttemptCore` composes; for the
    // shipped CROSS-domain edges it is inert in production (the source mastery row
    // is in another domain — see the header + practiceSkills.test.ts lock). It
    // would activate for an intra-domain implies edge.
    const overInference = ancestorWeights(IMPLIES_TGT, inferenceEdges);
    expect(overInference.get(IMPLIES_SRC)).toBe(IMPLICIT_WEIGHT_DEFAULT);

    // Over the GATING graph (buildsOn only), the source is NOT credited — the edge
    // is invisible to the buildsOn-only propagation.
    expect(ancestorWeights(IMPLIES_TGT, gatingEdges).has(IMPLIES_SRC)).toBe(false);
  });

  test("PURE MECHANISM: topoOrderStrand consumes implies edges (real placement effect proven in impliesPlacement.test.ts)", () => {
    // Placement orders a strand via topoOrderStrand over the INFERENCE edge set. An
    // implies edge a→b forces b AFTER a — even against the display order that would
    // put b first. The GATING set (no edge) falls back to display order. (The
    // shipped cross-domain edges skip/credit placement via a resume floor, proven
    // end-to-end in impliesPlacement.test.ts; this pins the ordering primitive.)
    const nodes = [
      { nodeKey: "a", order: 1 },
      { nodeKey: "b", order: 0 }, // lower display order — would sort first with no edge
    ];
    const impliesOnly = [{ fromKey: "a", toKey: "b" }];
    expect(topoOrderStrand(nodes, impliesOnly)).toEqual(["a", "b"]);
    expect(topoOrderStrand(nodes, [])).toEqual(["b", "a"]);
  });
});
