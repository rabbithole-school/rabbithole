import { describe, expect, test } from "vitest";
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
import { gradeRank } from "../practice/placement";
import {
  ALGEBRA_1_DOMAIN,
  ALGEBRA_1_SKILLS,
  ALGEBRA_1_EDGES,
} from "../../seed/algebra1Graph";

/**
 * No-hard-gate invariant for the cross-domain entrance edges (2026-07-19).
 *
 * A `buildsOn` prerequisite is a HARD gate: an entrance whose only prerequisites
 * are cross-domain sources the learner has not shown is unreachable for that
 * learner. The curation principle is "learner challenge, not hard-gate": adding
 * cross-domain gates must never leave a whole domain's ENTRANCE SET
 * simultaneously access-blocked for a plausible spiky learner — there must
 * always remain at least one door into every domain.
 *
 * This test simulates the SPIKY-NOVA profile from UNIFIED_DIAG_SIM.md against the
 * REAL post-curation graph (the seed edge lists). The 2026-07-19 curation added
 * no new cross-domain gates, so this asserts the invariant holds for the graph as
 * shipped — every one of the seven practice domains still exposes at least one
 * Nova-accessible entrance, most pointedly that a fractions-capable learner who is
 * shaky on her 6/7/8 multiplication facts can still reach the fractions domain —
 * and it stays a guard against any FUTURE cross-domain gate that would fully wall
 * off a domain for such a learner.
 */

const GRAPHS = [
  { domain: WHOLE_NUMBER_ARITHMETIC_DOMAIN, skills: WHOLE_NUMBER_ARITHMETIC_SKILLS, edges: WHOLE_NUMBER_ARITHMETIC_EDGES },
  { domain: FRACTION_ARITHMETIC_DOMAIN, skills: FRACTION_ARITHMETIC_SKILLS, edges: FRACTION_ARITHMETIC_EDGES },
  { domain: PROBABILITY_DOMAIN, skills: PROBABILITY_SKILLS, edges: PROBABILITY_EDGES },
  { domain: GEOMETRY_MEASUREMENT_DOMAIN, skills: GEOMETRY_MEASUREMENT_SKILLS, edges: GEOMETRY_MEASUREMENT_EDGES },
  { domain: RATIO_PROPORTION_PERCENT_DOMAIN, skills: RATIO_PROPORTION_PERCENT_SKILLS, edges: RATIO_PROPORTION_PERCENT_EDGES },
  { domain: INTEGERS_COORDINATES_DOMAIN, skills: INTEGERS_COORDINATES_SKILLS, edges: INTEGERS_COORDINATES_EDGES },
  { domain: EARLY_ALGEBRA_DOMAIN, skills: EARLY_ALGEBRA_SKILLS, edges: EARLY_ALGEBRA_EDGES },
  { domain: ALGEBRA_1_DOMAIN, skills: ALGEBRA_1_SKILLS, edges: ALGEBRA_1_EDGES },
];

const domainByKey = new Map<string, string>();
const gradeByKey = new Map<string, string>();
for (const g of GRAPHS) {
  for (const s of g.skills) {
    domainByKey.set(s.skillKey, g.domain);
    gradeByKey.set(s.skillKey, s.grade);
  }
}
const allEdges = GRAPHS.flatMap((g) => g.edges);

// SPIKY-NOVA — mirrors graph-edge-audit-sim.ts exactly: all K–2 whole-number
// nodes, plus the specific grade-3 arithmetic and early-fraction skills she has
// demonstrated. She does NOT know the 3/4/6 or 7/8/9 fact nodes, algorithms,
// decimals, later fractions, signed numbers, algebra, ratios, or probability
// notation.
const NOVA_KNOWN_KEYS = new Set<string>([
  "skip_count_3s_4s",
  "equal_groups_concept",
  "arrays_concept",
  "division_as_grouping",
  "division_as_sharing",
  "mult_facts_0_1_2_5_10",
  "mult_commutative_associative",
  "partition_shapes",
  "unit_fraction",
  "fraction_as_parts",
  "equivalent_fractions_visual",
]);
const novaKnows = (nodeKey: string): boolean => {
  if (NOVA_KNOWN_KEYS.has(nodeKey)) return true;
  const domain = domainByKey.get(nodeKey);
  const grade = gradeByKey.get(nodeKey);
  return (
    domain === WHOLE_NUMBER_ARITHMETIC_DOMAIN &&
    grade !== undefined &&
    gradeRank(grade) <= gradeRank("2")
  );
};

// An entrance is a node with no SAME-domain buildsOn prerequisite. Its only
// prerequisites (if any) are cross-domain sources.
const sameDomainPrereq = (nodeKey: string): boolean => {
  const dom = domainByKey.get(nodeKey);
  return allEdges.some((e) => e.toKey === nodeKey && domainByKey.get(e.fromKey) === dom);
};
const crossDomainSources = (nodeKey: string): string[] => {
  const dom = domainByKey.get(nodeKey);
  return allEdges
    .filter((e) => e.toKey === nodeKey && domainByKey.get(e.fromKey) !== dom)
    .map((e) => e.fromKey);
};
const entrancesOf = (domain: string): string[] =>
  GRAPHS.find((g) => g.domain === domain)!.skills.map((s) => s.skillKey).filter(
    (k) => !sameDomainPrereq(k),
  );
// A learner can ACCESS an entrance iff every cross-domain prerequisite source is
// already known to her (an entrance has no same-domain prerequisite by
// definition, so the cross-domain sources are the whole gate).
const novaCanAccess = (entranceKey: string): boolean =>
  crossDomainSources(entranceKey).every((src) => novaKnows(src));

describe("cross-domain entrances — no domain hard-gated for SPIKY-NOVA", () => {
  test("every practice domain still exposes at least one Nova-accessible entrance", () => {
    const blockedDomains: string[] = [];
    for (const g of GRAPHS) {
      const entrances = entrancesOf(g.domain);
      const accessible = entrances.filter(novaCanAccess);
      if (accessible.length === 0) {
        blockedDomains.push(
          `${g.domain} (entrances: ${entrances.join(", ") || "none"})`,
        );
      }
    }
    expect(blockedDomains).toEqual([]);
  });

  test("a fractions-capable kid shaky on 6/7/8 facts can still reach fractions", () => {
    // partition_shapes is the fraction domain's entrance and has NO cross-domain
    // prerequisite, so it is reachable regardless of any multiplication-fact gap.
    expect(entrancesOf(FRACTION_ARITHMETIC_DOMAIN)).toContain("partition_shapes");
    expect(crossDomainSources("partition_shapes")).toEqual([]);
    expect(novaCanAccess("partition_shapes")).toBe(true);

    // And she can progress INTO fractions: unit_fraction's cross-domain gate is
    // division_as_sharing (which she knows), not a 6/7/8 fact node.
    expect(crossDomainSources("unit_fraction")).toContain("division_as_sharing");
    expect(novaKnows("division_as_sharing")).toBe(true);
    expect(novaKnows("mult_facts_7_8_9")).toBe(false); // the fact node she is shaky on
  });

  test("the deferred likelihood_scale gate is absent, so the chance strand stays reachable", () => {
    // fraction_number_line -> likelihood_scale was DEFERRED as contestable (it
    // would hard-gate the chance-strand root; see CONTESTED_EDGES.md), so
    // likelihood_scale remains an ungated entrance and the probability domain has
    // no cross-domain hard gate on any entrance.
    expect(crossDomainSources("likelihood_scale")).toEqual([]);
    expect(novaCanAccess("likelihood_scale")).toBe(true);

    const entrances = entrancesOf(PROBABILITY_DOMAIN);
    const accessible = entrances.filter(novaCanAccess);
    // Every probability entrance is Nova-accessible (all are origins post-audit).
    expect(accessible).toEqual(entrances);
    expect(accessible).toContain("read_picture_graph");
  });
});
