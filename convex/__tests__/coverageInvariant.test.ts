import { describe, expect, it } from "vitest";
import { hasTemplate } from "../lib/practice/templates";
import { PRE_WARMED_CONCEPTUAL } from "../lib/practice/coverage";
import { PRACTICE_GRAPHS } from "../knowledgeNodes";

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
 * Iterates PRACTICE_GRAPHS directly so every registered domain inherits the
 * same gate without a second registry to update.
 */
// Every node key across ALL registered domains — the combined graph is what the
// rebuild validates acyclic at seed time, so a cross-domain buildsOn edge (e.g.
// probability's `fraction_as_parts → probability_as_fraction`) references a node
// that is "real" even though it lives in another domain's skill list.
const ALL_KNOWN_KEYS = new Set(
  PRACTICE_GRAPHS.flatMap((graph) =>
    graph.skills.map((skill) => skill.skillKey),
  ),
);

describe("chokepoint coverage — every gating node is serveable", () => {
  it("every PRE_WARMED_CONCEPTUAL key exists in the registered domain graphs", () => {
    expect(PRE_WARMED_CONCEPTUAL.size).toBeGreaterThan(0);
    const unknown = [...PRE_WARMED_CONCEPTUAL].filter(
      (key) => !ALL_KNOWN_KEYS.has(key),
    );
    expect(
      unknown,
      `PRE_WARMED_CONCEPTUAL references unknown node keys: ${unknown.join(", ")}`,
    ).toEqual([]);
  });

  // One test per invariant, each looping ALL registered domains internally —
  // this still validates every domain's curriculum data, just without a
  // separate named test per domain.
  it("every gating node across every domain has a template or pre-warmed items", () => {
    const failures: string[] = [];
    for (const domain of PRACTICE_GRAPHS) {
      const serveable = (key: string) =>
        hasTemplate(key) || PRE_WARMED_CONCEPTUAL.has(key);
      const gatingNodes = [...new Set(domain.edges.map((e) => e.fromKey))];
      const unserveable = gatingNodes.filter((k) => !serveable(k));
      if (unserveable.length > 0) {
        failures.push(`${domain.domain}: ${unserveable.join(", ")}`);
      }
    }
    expect(
      failures,
      `Gating nodes with no template AND not pre-warmed — these render on the ` +
        `frontier but can't be practiced. Either template them (templates.ts) or ` +
        `add them to PRE_WARMED_CONCEPTUAL (coverage.ts) + wire pre-warm: ` +
        failures.join(" | "),
    ).toEqual([]);
  });

  it("every edge endpoint across every domain is a real node in the graph", () => {
    const failures: string[] = [];
    for (const domain of PRACTICE_GRAPHS) {
      const dangling = domain.edges
        .flatMap((e) => [e.fromKey, e.toKey])
        .filter((k) => !ALL_KNOWN_KEYS.has(k));
      if (dangling.length > 0) {
        failures.push(`${domain.domain}: ${dangling.join(", ")}`);
      }
    }
    expect(failures, `Edges reference unknown node keys: ${failures.join(" | ")}`).toEqual([]);
  });

  it("PRE_WARMED_CONCEPTUAL entries across every domain are real, untemplated nodes", () => {
    const failures: string[] = [];
    for (const domain of PRACTICE_GRAPHS) {
      const keys = new Set(domain.skills.map((s) => s.skillKey));
      for (const k of PRE_WARMED_CONCEPTUAL) {
        // Only assert for keys that belong to THIS domain's graph.
        if (!keys.has(k)) continue;
        if (hasTemplate(k)) {
          failures.push(
            `${domain.domain}: ${k} is templated — remove it from PRE_WARMED_CONCEPTUAL`,
          );
        }
      }
    }
    expect(failures).toEqual([]);
  });
});
