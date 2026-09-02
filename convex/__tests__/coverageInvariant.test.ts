import { describe, expect, it } from "vitest";
import {
  WHOLE_NUMBER_ARITHMETIC_SKILLS,
  WHOLE_NUMBER_ARITHMETIC_EDGES,
} from "../seed/wholeNumberArithmeticGraph";
import {
  FRACTION_ARITHMETIC_SKILLS,
  FRACTION_ARITHMETIC_EDGES,
} from "../seed/fractionArithmeticGraph";
import {
  PROBABILITY_SKILLS,
  PROBABILITY_EDGES,
} from "../seed/probabilityGraph";
import {
  GEOMETRY_MEASUREMENT_SKILLS,
  GEOMETRY_MEASUREMENT_EDGES,
} from "../seed/geometryMeasurementGraph";
import {
  RATIO_PROPORTION_PERCENT_SKILLS,
  RATIO_PROPORTION_PERCENT_EDGES,
} from "../seed/ratioProportionPercentGraph";
import {
  INTEGERS_COORDINATES_SKILLS,
  INTEGERS_COORDINATES_EDGES,
} from "../seed/integersCoordinatesGraph";
import {
  EARLY_ALGEBRA_SKILLS,
  EARLY_ALGEBRA_EDGES,
} from "../seed/earlyAlgebraGraph";
import { hasTemplate } from "../lib/practice/templates";
import { ALGEBRA_1_SKILLS, ALGEBRA_1_EDGES } from "../seed/algebra1Graph";
import { PRE_WARMED_CONCEPTUAL } from "../lib/practice/coverage";

/**
 * Chokepoint-coverage CI invariant (raise-the-ceiling §3, Wave A "A3").
 *
 * A node with no template AND no pre-warmed verified items cannot be practiced,
 * cannot accrue reps, cannot become fluent, and cannot be probed at placement
 * (isProbeable = hasTemplate) — yet it can still GATE the frontier. A frontier
 * made of such nodes is a dead-end that renders but can't be climbed (the same
 * "seed must match the UI" class of bug as "No lessons yet").
 *
 * THE INVARIANT: every gating node (any node that is the `fromKey` of a buildsOn
 * edge) must be serveable — hasTemplate(node) || PRE_WARMED_CONCEPTUAL.has(node).
 *
 * Structured to iterate a list of domains so each new domain (fractions, …)
 * inherits the same gate by adding one row here.
 */
type DomainGraph = {
  label: string;
  skills: readonly { skillKey: string }[];
  edges: readonly { fromKey: string; toKey: string }[];
  /** Nodes served by verified-LLM items rather than a template. */
  preWarmed: ReadonlySet<string>;
};

const DOMAINS: DomainGraph[] = [
  {
    label: "whole-number-arithmetic",
    skills: WHOLE_NUMBER_ARITHMETIC_SKILLS,
    edges: WHOLE_NUMBER_ARITHMETIC_EDGES,
    preWarmed: PRE_WARMED_CONCEPTUAL,
  },
  {
    label: "fraction-arithmetic",
    skills: FRACTION_ARITHMETIC_SKILLS,
    edges: FRACTION_ARITHMETIC_EDGES,
    preWarmed: PRE_WARMED_CONCEPTUAL,
  },
  {
    label: "probability",
    skills: PROBABILITY_SKILLS,
    edges: PROBABILITY_EDGES,
    preWarmed: PRE_WARMED_CONCEPTUAL,
  },
  {
    label: "geometry-measurement",
    skills: GEOMETRY_MEASUREMENT_SKILLS,
    edges: GEOMETRY_MEASUREMENT_EDGES,
    preWarmed: PRE_WARMED_CONCEPTUAL,
  },
  {
    label: "ratio-proportion-percent",
    skills: RATIO_PROPORTION_PERCENT_SKILLS,
    edges: RATIO_PROPORTION_PERCENT_EDGES,
    preWarmed: PRE_WARMED_CONCEPTUAL,
  },
  {
    label: "integers-coordinates",
    skills: INTEGERS_COORDINATES_SKILLS,
    edges: INTEGERS_COORDINATES_EDGES,
    preWarmed: PRE_WARMED_CONCEPTUAL,
  },
  {
    label: "early-algebra",
    skills: EARLY_ALGEBRA_SKILLS,
    edges: EARLY_ALGEBRA_EDGES,
    preWarmed: PRE_WARMED_CONCEPTUAL,
  },
  {
    label: "algebra-1",
    skills: ALGEBRA_1_SKILLS,
    edges: ALGEBRA_1_EDGES,
    preWarmed: PRE_WARMED_CONCEPTUAL,
  },
];

// Every node key across ALL registered domains — the combined graph is what the
// rebuild validates acyclic at seed time, so a cross-domain buildsOn edge (e.g.
// probability's `fraction_as_parts → probability_as_fraction`) references a node
// that is "real" even though it lives in another domain's skill list.
const ALL_KNOWN_KEYS = new Set(
  DOMAINS.flatMap((d) => d.skills.map((s) => s.skillKey)),
);

describe("chokepoint coverage — every gating node is serveable", () => {
  for (const domain of DOMAINS) {
    const serveable = (key: string) => hasTemplate(key) || domain.preWarmed.has(key);
    const gatingNodes = [...new Set(domain.edges.map((e) => e.fromKey))];

    it(`${domain.label}: every gating node has a template or pre-warmed items`, () => {
      const unserveable = gatingNodes.filter((k) => !serveable(k));
      expect(
        unserveable,
        `Gating nodes with no template AND not pre-warmed — these render on the ` +
          `frontier but can't be practiced. Either template them (templates.ts) or ` +
          `add them to PRE_WARMED_CONCEPTUAL (coverage.ts) + wire pre-warm: ` +
          unserveable.join(", "),
      ).toEqual([]);
    });

    it(`${domain.label}: every edge endpoint is a real node in the graph`, () => {
      const dangling = domain.edges
        .flatMap((e) => [e.fromKey, e.toKey])
        .filter((k) => !ALL_KNOWN_KEYS.has(k));
      expect(dangling, `Edges reference unknown node keys: ${dangling.join(", ")}`).toEqual([]);
    });

    it(`${domain.label}: PRE_WARMED_CONCEPTUAL entries are real, untemplated nodes`, () => {
      const keys = new Set(domain.skills.map((s) => s.skillKey));
      for (const k of domain.preWarmed) {
        // Only assert for keys that belong to THIS domain's graph.
        if (!keys.has(k)) continue;
        expect(hasTemplate(k), `${k} is templated — remove it from PRE_WARMED_CONCEPTUAL`).toBe(
          false,
        );
      }
    });
  }
});
