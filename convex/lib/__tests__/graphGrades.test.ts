import { describe, expect, test } from "vitest";
import {
  WHOLE_NUMBER_ARITHMETIC_DOMAIN,
  WHOLE_NUMBER_ARITHMETIC_SKILLS,
  WHOLE_NUMBER_ARITHMETIC_EDGES,
  type SeedSkill,
} from "../../seed/wholeNumberArithmeticGraph";
import {
  FRACTION_ARITHMETIC_DOMAIN,
  FRACTION_ARITHMETIC_SKILLS,
  FRACTION_ARITHMETIC_EDGES,
} from "../../seed/fractionArithmeticGraph";
import {
  PROBABILITY_DOMAIN,
  PROBABILITY_SKILLS,
  PROBABILITY_EDGES,
  PROBABILITY_IMPLIES_EDGES,
} from "../../seed/probabilityGraph";
import {
  GEOMETRY_MEASUREMENT_DOMAIN,
  GEOMETRY_MEASUREMENT_SKILLS,
  GEOMETRY_MEASUREMENT_EDGES,
  GEOMETRY_MEASUREMENT_IMPLIES_EDGES,
} from "../../seed/geometryMeasurementGraph";
import {
  RATIO_PROPORTION_PERCENT_DOMAIN,
  RATIO_PROPORTION_PERCENT_SKILLS,
  RATIO_PROPORTION_PERCENT_EDGES,
} from "../../seed/ratioProportionPercentGraph";
import {
  INTEGERS_COORDINATES_DOMAIN,
  INTEGERS_COORDINATES_SKILLS,
  INTEGERS_COORDINATES_EDGES,
} from "../../seed/integersCoordinatesGraph";
import {
  EARLY_ALGEBRA_DOMAIN,
  EARLY_ALGEBRA_SKILLS,
  EARLY_ALGEBRA_EDGES,
  EARLY_ALGEBRA_IMPLIES_EDGES,
} from "../../seed/earlyAlgebraGraph";
import { gradeRank } from "../practice/placement";
import {
  ALGEBRA_1_DOMAIN,
  ALGEBRA_1_SKILLS,
  ALGEBRA_1_EDGES,
  ALGEBRA_1_IMPLIES_EDGES,
} from "../../seed/algebra1Graph";
import {
  DISCRETE_MATH_SKILLS,
  DISCRETE_MATH_EDGES,
} from "../../seed/discreteMathGraph";
import { validateCombinedGraph } from "../practice/graphValidation";

/**
 * Grade-tag completeness drift test (PR4 — placement-v2 graph audit).
 *
 * Every practice knowledge-graph node MUST carry a `grade` tag in the valid
 * K–9 set. This is load-bearing, not cosmetic: placement's affect-safe FIRST
 * probe (`affectSafeFirstProbeIndex`) and the placement result label
 * (`derivePlacedThroughGrade`) both resolve a node's grade through `gradeRank`,
 * which returns -1 for any grade outside {K,1,…,9}. A node with a missing or
 * malformed grade silently drops out of first-probe anchoring and the result
 * label — so this test locks the audit's invariant against future drift.
 */

const VALID_GRADES = new Set(["K", "1", "2", "3", "4", "5", "6", "7", "8", "9"]);

const DOMAINS: { label: string; skills: readonly SeedSkill[] }[] = [
  { label: "whole-number-arithmetic", skills: WHOLE_NUMBER_ARITHMETIC_SKILLS },
  { label: "fraction-arithmetic", skills: FRACTION_ARITHMETIC_SKILLS },
  { label: "probability", skills: PROBABILITY_SKILLS },
  { label: "geometry-measurement", skills: GEOMETRY_MEASUREMENT_SKILLS },
  { label: "ratio-proportion-percent", skills: RATIO_PROPORTION_PERCENT_SKILLS },
  { label: "integers-coordinates", skills: INTEGERS_COORDINATES_SKILLS },
  { label: "early-algebra", skills: EARLY_ALGEBRA_SKILLS },
  { label: "algebra-1", skills: ALGEBRA_1_SKILLS },
  { label: "discrete-math", skills: DISCRETE_MATH_SKILLS },
];

describe("practice graph — grade-tag completeness", () => {
  test("every node has a grade in the valid K–9 set", () => {
    const bad: string[] = [];
    for (const { label, skills } of DOMAINS) {
      for (const s of skills) {
        if (!s.grade || !VALID_GRADES.has(s.grade)) {
          bad.push(`${label}:${s.skillKey} grade=${JSON.stringify(s.grade)}`);
        }
      }
    }
    expect(bad).toEqual([]);
  });

  test("every grade resolves to a non-negative gradeRank (feeds placement)", () => {
    for (const { skills } of DOMAINS) {
      for (const s of skills) {
        expect(gradeRank(s.grade), `${s.skillKey} grade=${s.grade}`).toBeGreaterThanOrEqual(0);
      }
    }
  });
});

/**
 * Grade-density invariant (graph-density check-in #1 — surgical densification).
 *
 * The difficulty band suppresses a frontier node when its grade is more than one
 * above the scholar's demonstrated level. That only stays fair if the graph is
 * DEEP enough that a node never sits more than one grade above its nearest
 * prerequisite — otherwise a high-grade node with a shallow prereq chain surfaces
 * as "frontier" for a much younger scholar and the band, not the graph, is doing
 * all the work (the very failure the check-in flagged: grade-6 remainder_cycles
 * reachable by a grade-3 kid). This test locks the densified invariant for the
 * whole-number-arithmetic graph so future edits can't reintroduce a shallow
 * high-jump chain without either deepening it or consciously updating this bound.
 *
 * Scope: whole-number-arithmetic only. Fraction-arithmetic (unit_fraction's
 * g1→g3 root gap) and probability (uniformly grade-7) have known tagging gaps
 * tracked separately as the check-in's "adjacent observations", not density.
 */
describe("whole-number-arithmetic graph — grade-density invariant", () => {
  const BAND_WIDTH = 1; // a node may sit at most this many grades above a prereq

  test("no node's grade exceeds its nearest graded prerequisite by more than the band width", () => {
    const gradeByKey = new Map(
      WHOLE_NUMBER_ARITHMETIC_SKILLS.map((s) => [s.skillKey, s.grade]),
    );
    // direct prerequisites (buildsOn) per node
    const prereqsByKey = new Map<string, string[]>();
    for (const { toKey, fromKey } of WHOLE_NUMBER_ARITHMETIC_EDGES) {
      const list = prereqsByKey.get(toKey);
      if (list) list.push(fromKey);
      else prereqsByKey.set(toKey, [fromKey]);
    }

    const violations: string[] = [];
    for (const s of WHOLE_NUMBER_ARITHMETIC_SKILLS) {
      const nodeRank = gradeRank(s.grade);
      const prereqRanks = (prereqsByKey.get(s.skillKey) ?? [])
        .map((k) => gradeRank(gradeByKey.get(k) ?? ""))
        .filter((r) => r >= 0);
      // Grade-roots (no graded prerequisite) are entry points, band-exempt.
      if (prereqRanks.length === 0) continue;
      const jump = nodeRank - Math.max(...prereqRanks);
      if (jump > BAND_WIDTH) {
        violations.push(`${s.skillKey} (grade ${s.grade}) jumps +${jump} over its nearest prereq`);
      }
    }
    expect(violations).toEqual([]);
  });
});

/**
 * Cross-domain ENTRANCE prerequisite edges — drift lock (2026-07-19 curation +
 * the `implies` inference-edge follow-up).
 *
 * The entrance-coverage audit evaluated 19 candidate cross-domain hard gates for
 * the uncovered practice-domain entrances and added NONE of them as `buildsOn`
 * gates. The genuine-dependency-but-declined-as-gate subset later became
 * INFERENCE-ONLY `implies` edges (which propagate implicit credit + order
 * placement inference, but never gate); the contested + grade-inverted candidates
 * stay OUT of BOTH kinds. This block locks that decision:
 *   • NEGATIVE drift lock — none of the audited-and-declined/deferred candidate
 *     hard gates may silently appear as a `buildsOn` gate;
 *   • POSITIVE lock — the shipped `implies` set is present as kind:"implies", and
 *     the contested/grade-inverted candidates are absent from `implies` too;
 *   • grade-SANITY invariant — every cross-domain buildsOn OR implies edge is
 *     grade-forward (source at or below the target's grade); a grade-inverted edge
 *     would strand a younger learner; and
 *   • the combined multi-domain graph (buildsOn ∪ implies) stays a valid DAG.
 */
describe("cross-domain entrance prerequisite edges — drift lock", () => {
  const GRAPHS = [
    { domain: WHOLE_NUMBER_ARITHMETIC_DOMAIN, skills: WHOLE_NUMBER_ARITHMETIC_SKILLS, edges: WHOLE_NUMBER_ARITHMETIC_EDGES, implies: [] as { fromKey: string; toKey: string }[] },
    { domain: FRACTION_ARITHMETIC_DOMAIN, skills: FRACTION_ARITHMETIC_SKILLS, edges: FRACTION_ARITHMETIC_EDGES, implies: [] },
    { domain: PROBABILITY_DOMAIN, skills: PROBABILITY_SKILLS, edges: PROBABILITY_EDGES, implies: PROBABILITY_IMPLIES_EDGES },
    { domain: GEOMETRY_MEASUREMENT_DOMAIN, skills: GEOMETRY_MEASUREMENT_SKILLS, edges: GEOMETRY_MEASUREMENT_EDGES, implies: GEOMETRY_MEASUREMENT_IMPLIES_EDGES },
    { domain: RATIO_PROPORTION_PERCENT_DOMAIN, skills: RATIO_PROPORTION_PERCENT_SKILLS, edges: RATIO_PROPORTION_PERCENT_EDGES, implies: [] },
    { domain: INTEGERS_COORDINATES_DOMAIN, skills: INTEGERS_COORDINATES_SKILLS, edges: INTEGERS_COORDINATES_EDGES, implies: [] },
    { domain: EARLY_ALGEBRA_DOMAIN, skills: EARLY_ALGEBRA_SKILLS, edges: EARLY_ALGEBRA_EDGES, implies: EARLY_ALGEBRA_IMPLIES_EDGES },
    { domain: ALGEBRA_1_DOMAIN, skills: ALGEBRA_1_SKILLS, edges: ALGEBRA_1_EDGES, implies: ALGEBRA_1_IMPLIES_EDGES },
    { domain: "discrete-math", skills: DISCRETE_MATH_SKILLS, edges: DISCRETE_MATH_EDGES, implies: [] },
  ];
  const gradeByKey = new Map<string, string>();
  const domainByKey = new Map<string, string>();
  for (const g of GRAPHS) {
    for (const s of g.skills) {
      gradeByKey.set(s.skillKey, s.grade);
      domainByKey.set(s.skillKey, g.domain);
    }
  }
  const allEdges = GRAPHS.flatMap((g) => g.edges);
  const allImpliesEdges = GRAPHS.flatMap((g) => g.implies);
  const hasEdge = (fromKey: string, toKey: string) =>
    allEdges.some((e) => e.fromKey === fromKey && e.toKey === toKey);
  const hasImplies = (fromKey: string, toKey: string) =>
    allImpliesEdges.some((e) => e.fromKey === fromKey && e.toKey === toKey);
  const isCross = (e: { fromKey: string; toKey: string }) =>
    domainByKey.get(e.fromKey) !== domainByKey.get(e.toKey);

  // The audited candidate cross-domain entrance gates that must NEVER be a
  // `buildsOn` hard gate. The SURVIVORS of the implication-contract vetting
  // (`asImplies: true`) live as INFERENCE-ONLY `implies` edges — a home that
  // feeds implicit credit + placement diagnostic without gating. Everything else
  // (`asImplies: false`) is out of BOTH kinds: the 5 contested / 1 grade-inverted
  // candidates, PLUS the 7 template-vetting-review (§5) edges whose target template does not
  // exercise the source (pruned — they would mint false placement credit). This
  // is a NEGATIVE drift lock: adding any of these as a `buildsOn` gate fails here.
  const DECLINED_OR_DEFERRED_EDGES: { fromKey: string; toKey: string; asImplies: boolean; why: string }[] = [
    { fromKey: "fraction_number_line", toKey: "likelihood_scale", asImplies: false, why: "contested — hard-gates the chance-strand root; CONTESTED_EDGES.md" },
    // Survivors — target template genuinely exercises the source (kept as implies):
    { fromKey: "count_objects_within_20", toKey: "read_picture_graph", asImplies: true, why: "target counts 2-6 icons — genuine counting" },
    { fromKey: "count_objects_within_20", toKey: "read_bar_graph", asImplies: true, why: "target reads a bar's whole-number units" },
    { fromKey: "count_objects_within_20", toKey: "read_line_plot", asImplies: true, why: "target counts marks at a value" },
    { fromKey: "partition_shapes", toKey: "line_symmetry", asImplies: true, why: "a symmetry line partitions a figure into equal halves" },
    { fromKey: "order_of_operations", toKey: "expr_grouping_symbols", asImplies: true, why: "target asks which op comes first — that IS order of operations" },
    { fromKey: "skip_count_3s_4s", toKey: "pattern_rule_sequence", asImplies: true, why: "target computes the Nth 'add K each time' term — repeated skip-counting" },
    // PRUNED (template-vetting review §5 — target template does NOT exercise the source):
    { fromKey: "compare_3digit", toKey: "ordering", asImplies: false, why: "§5 — target only orders {2..9}; no 3-digit comparison" },
    { fromKey: "perimeter_polygons", toKey: "collect_measurement_data", asImplies: false, why: "§5 — target picks a consistent-units plan; no perimeter" },
    { fromKey: "compare_within_10", toKey: "statistical_question", asImplies: false, why: "§5 — target classifies variable-answer questions; no comparison" },
    { fromKey: "add_3digit_no_regroup", toKey: "perimeter_polygons", asImplies: false, why: "§5 — perimeter target is a small rectangle; no 3-digit addition" },
    { fromKey: "partition_shapes", toKey: "angle_concept", asImplies: false, why: "§5 — target names two rays + a turn; no partitioning" },
    { fromKey: "prop_table_from_rule", toKey: "expr_variable_meaning", asImplies: false, why: "§5 — target solves one ticket-price unknown; no ratio table" },
    { fromKey: "compare_multidigit", toKey: "ineq_symbol_meaning", asImplies: false, why: "§5 — target reads a signed -8..8 constraint; no multi-digit comparison" },
    // Contested (founder hasn't ruled) / grade-inverted — out of BOTH kinds:
    { fromKey: "equal_groups_concept", toKey: "ratio_concept_language", asImplies: false, why: "contested — typical, not necessary; CONTESTED_EDGES.md" },
    { fromKey: "fraction_number_line", toKey: "ordered_pair_meaning", asImplies: false, why: "contested — fraction source too strong; CONTESTED_EDGES.md" },
    { fromKey: "fraction_number_line", toKey: "positive_negative_contexts", asImplies: false, why: "contested — fraction source too strong; CONTESTED_EDGES.md" },
    { fromKey: "count_objects_within_20", toKey: "partition_rectangles_rows_cols", asImplies: false, why: "contested — spatial origin; CONTESTED_EDGES.md" },
    { fromKey: "arrays_concept", toKey: "partition_rectangles_rows_cols", asImplies: false, why: "grade-inverted oracle direction; never add" },
    { fromKey: "division_as_sharing", toKey: "partition_shapes", asImplies: false, why: "grade-inverted (g3 → g1); partition_shapes is a true origin" },
  ];

  test("no audited-and-declined/deferred cross-domain gate has crept into the seed as a buildsOn gate", () => {
    const present = DECLINED_OR_DEFERRED_EDGES.filter((e) => hasEdge(e.fromKey, e.toKey)).map(
      (e) => `${e.fromKey} -> ${e.toKey}  [${e.why}]`,
    );
    expect(present).toEqual([]);
  });

  test("the genuine-but-declined-as-gate edges are PRESENT as inference-only implies edges", () => {
    const missing = DECLINED_OR_DEFERRED_EDGES.filter((e) => e.asImplies && !hasImplies(e.fromKey, e.toKey)).map(
      (e) => `${e.fromKey} -> ${e.toKey}  [${e.why}]`,
    );
    expect(missing).toEqual([]);
  });

  test("contested/grade-inverted candidates stay absent from implies too (founder hasn't ruled)", () => {
    const leaked = DECLINED_OR_DEFERRED_EDGES.filter((e) => !e.asImplies && hasImplies(e.fromKey, e.toKey)).map(
      (e) => `${e.fromKey} -> ${e.toKey}  [${e.why}]`,
    );
    expect(leaked).toEqual([]);
  });

  test("every cross-domain buildsOn OR implies edge is grade-sane: source grade ≤ target grade (never inverted)", () => {
    const inversions: string[] = [];
    for (const e of [...allEdges, ...allImpliesEdges]) {
      if (!isCross(e)) continue;
      const fromRank = gradeRank(gradeByKey.get(e.fromKey) ?? "");
      const toRank = gradeRank(gradeByKey.get(e.toKey) ?? "");
      expect(fromRank, `${e.fromKey} grade`).toBeGreaterThanOrEqual(0);
      expect(toRank, `${e.toKey} grade`).toBeGreaterThanOrEqual(0);
      if (fromRank > toRank) {
        inversions.push(
          `${e.fromKey} (g${gradeByKey.get(e.fromKey)}) -> ${e.toKey} (g${gradeByKey.get(e.toKey)})`,
        );
      }
    }
    expect(inversions).toEqual([]);
  });

  test("the combined multi-domain graph (buildsOn ∪ implies) is a valid DAG", () => {
    const nodes = GRAPHS.flatMap((g) => g.skills.map((s) => ({ nodeKey: s.skillKey, domain: g.domain })));
    const edges = [...allEdges, ...allImpliesEdges].map((e) => ({ fromKey: e.fromKey, toKey: e.toKey }));
    expect(validateCombinedGraph(nodes, edges)).toEqual([]);
  });
});
