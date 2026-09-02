import { describe, expect, test } from "vitest";
import {
  validateCombinedGraph,
  assertCombinedGraphValid,
  type ValidatableNode,
  type ValidatableEdge,
} from "./graphValidation";
import {
  WHOLE_NUMBER_ARITHMETIC_DOMAIN,
  WHOLE_NUMBER_ARITHMETIC_SKILLS,
  WHOLE_NUMBER_ARITHMETIC_EDGES,
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
} from "../../seed/probabilityGraph";
import {
  GEOMETRY_MEASUREMENT_DOMAIN,
  GEOMETRY_MEASUREMENT_SKILLS,
  GEOMETRY_MEASUREMENT_EDGES,
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
} from "../../seed/earlyAlgebraGraph";
import {
  ALGEBRA_1_DOMAIN,
  ALGEBRA_1_SKILLS,
  ALGEBRA_1_EDGES,
} from "../../seed/algebra1Graph";

const n = (nodeKey: string, domain = "d"): ValidatableNode => ({ nodeKey, domain });

describe("validateCombinedGraph (D4 cross-domain acyclicity)", () => {
  test("a well-formed multi-domain DAG with a cross-domain edge has no issues", () => {
    const nodes = [n("a", "x"), n("b", "x"), n("p", "y"), n("q", "y")];
    const edges: ValidatableEdge[] = [
      { fromKey: "a", toKey: "b" }, // in-domain x
      { fromKey: "p", toKey: "q" }, // in-domain y
      { fromKey: "b", toKey: "q" }, // cross-domain x → y (grade-forward)
    ];
    expect(validateCombinedGraph(nodes, edges)).toEqual([]);
    expect(() => assertCombinedGraphValid(nodes, edges)).not.toThrow();
  });

  test("detects a cycle that closes THROUGH a cross-domain edge", () => {
    // x: a → b ; y: p → q ; cross: b → p AND q → a  ⇒ a→b→p→q→a is a cycle
    // invisible to per-domain validation (each domain alone is acyclic).
    const nodes = [n("a", "x"), n("b", "x"), n("p", "y"), n("q", "y")];
    const edges: ValidatableEdge[] = [
      { fromKey: "a", toKey: "b" },
      { fromKey: "p", toKey: "q" },
      { fromKey: "b", toKey: "p" },
      { fromKey: "q", toKey: "a" },
    ];
    const issues = validateCombinedGraph(nodes, edges);
    const cycle = issues.find((i) => i.kind === "cycle");
    expect(cycle).toBeDefined();
    // the reported cycle repeats its entry node (…→ x) and covers all 4 keys
    if (cycle && cycle.kind === "cycle") {
      expect(new Set(cycle.cycle)).toEqual(new Set(["a", "b", "p", "q"]));
      expect(cycle.cycle[0]).toBe(cycle.cycle[cycle.cycle.length - 1]);
    }
    expect(() => assertCombinedGraphValid(nodes, edges)).toThrow(/cycle/);
  });

  test("detects a self-loop", () => {
    const nodes = [n("a"), n("b")];
    const edges: ValidatableEdge[] = [{ fromKey: "a", toKey: "a" }];
    const issues = validateCombinedGraph(nodes, edges);
    expect(issues.some((i) => i.kind === "cycle")).toBe(true);
  });

  test("flags an edge whose endpoint is not a declared node", () => {
    const nodes = [n("a"), n("b")];
    const edges: ValidatableEdge[] = [
      { fromKey: "a", toKey: "b" },
      { fromKey: "ghost", toKey: "b" }, // unknown from
      { fromKey: "a", toKey: "nowhere" }, // unknown to
    ];
    const issues = validateCombinedGraph(nodes, edges);
    const unknown = issues.filter((i) => i.kind === "unknown-endpoint");
    expect(unknown).toHaveLength(2);
    expect(() => assertCombinedGraphValid(nodes, edges)).toThrow(/unknown/);
  });

  test("a dangling endpoint does not hide a real cycle elsewhere", () => {
    const nodes = [n("a"), n("b"), n("c")];
    const edges: ValidatableEdge[] = [
      { fromKey: "a", toKey: "b" },
      { fromKey: "b", toKey: "a" }, // cycle a↔b
      { fromKey: "c", toKey: "ghost" }, // dangling
    ];
    const issues = validateCombinedGraph(nodes, edges);
    expect(issues.some((i) => i.kind === "cycle")).toBe(true);
    expect(issues.some((i) => i.kind === "unknown-endpoint")).toBe(true);
  });

  test("empty graph is valid", () => {
    expect(validateCombinedGraph([], [])).toEqual([]);
  });
});

describe("validateCombinedGraph — global nodeKey uniqueness (cross-domain guard)", () => {
  test("flags a nodeKey declared in TWO domains, naming the key + both domains", () => {
    // `add_within_100` legitimately lives in whole-number; a probability seed
    // reusing that exact key would silently merge the two skills into one graph
    // node and make cross-domain frontier resolution ambiguous.
    const nodes = [
      n("add_within_100", "whole-number-arithmetic"),
      n("compare_probabilities", "probability"),
      n("add_within_100", "probability"), // COLLISION across domains
    ];
    const issues = validateCombinedGraph(nodes, []);
    const dup = issues.find((i) => i.kind === "duplicate-key");
    expect(dup).toBeDefined();
    if (dup && dup.kind === "duplicate-key") {
      expect(dup.nodeKey).toBe("add_within_100");
      expect(new Set(dup.domains)).toEqual(
        new Set(["whole-number-arithmetic", "probability"]),
      );
    }
    expect(() => assertCombinedGraphValid(nodes, [])).toThrow(/duplicate nodeKey "add_within_100"/);
    // and the message names both colliding domains
    expect(() => assertCombinedGraphValid(nodes, [])).toThrow(/whole-number-arithmetic/);
    expect(() => assertCombinedGraphValid(nodes, [])).toThrow(/probability/);
  });

  test("flags a nodeKey duplicated within a SINGLE domain (twice total)", () => {
    const nodes = [n("a", "x"), n("a", "x"), n("b", "x")];
    const issues = validateCombinedGraph(nodes, []);
    const dup = issues.filter((i) => i.kind === "duplicate-key");
    expect(dup).toHaveLength(1);
    if (dup[0].kind === "duplicate-key") {
      expect(dup[0].nodeKey).toBe("a");
      expect(dup[0].domains).toEqual(["x"]);
    }
  });

  test("does NOT flag legitimately repeated edge endpoints (only NODE duplication counts)", () => {
    // A single node fanning out to / in from many edges is normal; the guard
    // must key off the node list, never edge endpoints.
    const nodes = [n("a", "x"), n("b", "x"), n("c", "x")];
    const edges: ValidatableEdge[] = [
      { fromKey: "a", toKey: "b" },
      { fromKey: "a", toKey: "c" }, // "a" repeats as an endpoint — not a dup node
      { fromKey: "b", toKey: "c" },
    ];
    expect(validateCombinedGraph(nodes, edges).some((i) => i.kind === "duplicate-key")).toBe(false);
    expect(() => assertCombinedGraphValid(nodes, edges)).not.toThrow();
  });

  test("the currently registered practice graphs have globally-distinct keys and pass", () => {
    // Mirror how rebuildPracticeNodes assembles the combined set it validates.
    const graphs = [
      { domain: WHOLE_NUMBER_ARITHMETIC_DOMAIN, skills: WHOLE_NUMBER_ARITHMETIC_SKILLS, edges: WHOLE_NUMBER_ARITHMETIC_EDGES },
      { domain: FRACTION_ARITHMETIC_DOMAIN, skills: FRACTION_ARITHMETIC_SKILLS, edges: FRACTION_ARITHMETIC_EDGES },
      { domain: PROBABILITY_DOMAIN, skills: PROBABILITY_SKILLS, edges: PROBABILITY_EDGES },
      { domain: GEOMETRY_MEASUREMENT_DOMAIN, skills: GEOMETRY_MEASUREMENT_SKILLS, edges: GEOMETRY_MEASUREMENT_EDGES },
      { domain: RATIO_PROPORTION_PERCENT_DOMAIN, skills: RATIO_PROPORTION_PERCENT_SKILLS, edges: RATIO_PROPORTION_PERCENT_EDGES },
      { domain: INTEGERS_COORDINATES_DOMAIN, skills: INTEGERS_COORDINATES_SKILLS, edges: INTEGERS_COORDINATES_EDGES },
      { domain: EARLY_ALGEBRA_DOMAIN, skills: EARLY_ALGEBRA_SKILLS, edges: EARLY_ALGEBRA_EDGES },
      { domain: ALGEBRA_1_DOMAIN, skills: ALGEBRA_1_SKILLS, edges: ALGEBRA_1_EDGES },
    ];
    const nodes = graphs.flatMap((g) => g.skills.map((s) => ({ nodeKey: s.skillKey, domain: g.domain })));
    const edges = graphs.flatMap((g) => g.edges.map((e) => ({ fromKey: e.fromKey, toKey: e.toKey })));

    // No duplicate-key issue (and, as a whole, no validation issue at all).
    expect(validateCombinedGraph(nodes, edges)).toEqual([]);
    expect(() => assertCombinedGraphValid(nodes, edges)).not.toThrow();
  });
});
