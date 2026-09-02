/**
 * The DISPLAY registry for practice-engine domains — the teacher-facing name and
 * discipline for each prerequisite DAG that the practice engine can run.
 *
 * The engine itself is domain-parametric (every core query takes an optional
 * `domain` slug); the GRAPH DATA for each domain lives in `convex/seed/*Graph.ts`
 * and is wired into the node tables by `PRACTICE_GRAPHS` in
 * `convex/knowledgeNodes.ts`. This module is the small, data-light companion that
 * maps each domain slug → a human `label` + `discipline` bucket, so teacher
 * surfaces can offer a domain picker without importing the (large) seed graphs.
 *
 * Single source of truth for the slug set is still `PRACTICE_GRAPHS`; a drift
 * test (convex/__tests__/practiceDomains.test.ts) asserts this list stays in
 * lock-step with the registered graphs, so adding a domain there without a label
 * here fails CI.
 */

import { WHOLE_NUMBER_ARITHMETIC_DOMAIN } from "../../seed/wholeNumberArithmeticGraph";
import { FRACTION_ARITHMETIC_DOMAIN } from "../../seed/fractionArithmeticGraph";
import { PROBABILITY_DOMAIN } from "../../seed/probabilityGraph";
import { GEOMETRY_MEASUREMENT_DOMAIN } from "../../seed/geometryMeasurementGraph";
import { RATIO_PROPORTION_PERCENT_DOMAIN } from "../../seed/ratioProportionPercentGraph";
import { INTEGERS_COORDINATES_DOMAIN } from "../../seed/integersCoordinatesGraph";
import { EARLY_ALGEBRA_DOMAIN } from "../../seed/earlyAlgebraGraph";
import { ALGEBRA_1_DOMAIN } from "../../seed/algebra1Graph";
import { DISCRETE_MATH_DOMAIN } from "../../seed/discreteMathGraph";
// Human labels live in a dependency-free shared module so native can vendor them
// (this file can't be vendored — it pulls in the seed graphs above). Single
// source of truth for the labels; PRACTICE_DOMAINS below reads from it.
import { PRACTICE_DOMAIN_LABELS } from "../../../shared/practiceDomainLabels";

export type PracticeDomainInfo = {
  /** The kebab-slug domain key (matches `practiceMastery.domain`, node `domain`). */
  domain: string;
  /** Teacher-facing name, e.g. "Whole-number arithmetic". */
  label: string;
  /** The discipline bucket a picker groups by, e.g. "Mathematics". */
  discipline: string;
};

/** The registered practice domains, in display order. Grouped by discipline in
 *  the UI. Keep in lock-step with `PRACTICE_GRAPHS` (drift-tested). */
export const PRACTICE_DOMAINS: PracticeDomainInfo[] = [
  { domain: WHOLE_NUMBER_ARITHMETIC_DOMAIN, label: PRACTICE_DOMAIN_LABELS[WHOLE_NUMBER_ARITHMETIC_DOMAIN], discipline: "Mathematics" },
  { domain: FRACTION_ARITHMETIC_DOMAIN, label: PRACTICE_DOMAIN_LABELS[FRACTION_ARITHMETIC_DOMAIN], discipline: "Mathematics" },
  { domain: PROBABILITY_DOMAIN, label: PRACTICE_DOMAIN_LABELS[PROBABILITY_DOMAIN], discipline: "Mathematics" },
  { domain: GEOMETRY_MEASUREMENT_DOMAIN, label: PRACTICE_DOMAIN_LABELS[GEOMETRY_MEASUREMENT_DOMAIN], discipline: "Mathematics" },
  { domain: RATIO_PROPORTION_PERCENT_DOMAIN, label: PRACTICE_DOMAIN_LABELS[RATIO_PROPORTION_PERCENT_DOMAIN], discipline: "Mathematics" },
  { domain: INTEGERS_COORDINATES_DOMAIN, label: PRACTICE_DOMAIN_LABELS[INTEGERS_COORDINATES_DOMAIN], discipline: "Mathematics" },
  { domain: EARLY_ALGEBRA_DOMAIN, label: PRACTICE_DOMAIN_LABELS[EARLY_ALGEBRA_DOMAIN], discipline: "Mathematics" },
  { domain: ALGEBRA_1_DOMAIN, label: PRACTICE_DOMAIN_LABELS[ALGEBRA_1_DOMAIN], discipline: "Mathematics" },
  { domain: DISCRETE_MATH_DOMAIN, label: PRACTICE_DOMAIN_LABELS[DISCRETE_MATH_DOMAIN], discipline: "Mathematics" },
];

const BY_DOMAIN = new Map(PRACTICE_DOMAINS.map((d) => [d.domain, d]));

/**
 * Foundational-first PRIORITY for the mixed "Math Check-In" (the multi-domain
 * first placement). The orchestrator (convex/practiceSkills.ts → serveNext)
 * probes eligible domains in THIS order first, ahead of its least-answered
 * round-robin, so the most foundational territories PLACE within the first
 * sitting's probe budget (CHECK_IN_SITTING_PROBE_BUDGET) instead of every domain
 * getting a shallow, unfinished dusting. Whole-number arithmetic then fraction
 * arithmetic lead; every other domain shares the trailing rank and still
 * interleaves by least-answered among themselves.
 *
 * This is a priority PRIOR, never an override of the cross-domain prerequisite
 * gate: a domain is only ever picked once its prerequisite domains are placed
 * (the gate runs first). It codifies explicitly what the prereq DAG already tends
 * to produce, and stays correct if a future foundational domain lands without a
 * gating edge. Keep next to the registry above.
 */
export const CHECK_IN_DOMAIN_PRIORITY: readonly string[] = [
  WHOLE_NUMBER_ARITHMETIC_DOMAIN,
  FRACTION_ARITHMETIC_DOMAIN,
  // …everything else trails, sharing one rank (interleaves by least-answered).
];

/** The check-in placement-priority rank of a domain (lower = probed sooner).
 *  Unlisted domains share the trailing rank, so they keep round-robining. */
export function checkInDomainPriority(domain: string): number {
  const i = CHECK_IN_DOMAIN_PRIORITY.indexOf(domain);
  return i >= 0 ? i : CHECK_IN_DOMAIN_PRIORITY.length;
}

/** The human label for a domain slug, falling back to the slug itself. */
export function practiceDomainLabel(domain: string): string {
  return BY_DOMAIN.get(domain)?.label ?? domain;
}

/** The full display info for a domain slug, or undefined if unregistered. */
export function practiceDomainInfo(domain: string): PracticeDomainInfo | undefined {
  return BY_DOMAIN.get(domain);
}

// The pure alias/slug resolver lives in the dependency-free shared module (so
// native can vendor it — this file can't be, it pulls in the seed graphs). Re-
// exported here so callers get it from the same place as the domain registry.
export { resolvePracticeDomainSlug } from "../../../shared/practiceDomainLabels";
