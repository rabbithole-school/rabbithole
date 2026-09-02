/**
 * The slug → human-label map for practice domains — framework-free and
 * dependency-free, so BOTH the web registry
 * (`convex/lib/practice/domains.ts`, which sources `PRACTICE_DOMAINS[].label`
 * from here) and the native practice surface (via the vendored copy produced by
 * `native/scripts/sync-vendor.js`) read the SAME labels, never a hand-maintained
 * drift copy. Imports nothing, so it resolves standalone in either module graph
 * — unlike `convex/lib/practice/domains.ts`, which pulls in the seed graphs for
 * the domain-slug constants and so can't be vendored into native.
 *
 * Keyed by the kebab domain slug (matches `knowledgeNodes.domain` and the
 * seed-graph `*_DOMAIN` constants). Adding a domain: add its label here AND
 * register its graph — the drift test (`convex/__tests__/practiceDomains.test.ts`)
 * asserts the registry stays in lock-step with the registered graphs.
 *
 * This module also owns `resolvePracticeDomainSlug` — the pure alias/slug
 * resolver for user- or URL-supplied domain strings — for the same reason: it's
 * dependency-free, so both web and the vendored native surface share one copy.
 */

export const PRACTICE_DOMAIN_LABELS: Record<string, string> = {
  "whole-number-arithmetic": "Whole-number arithmetic",
  "fraction-arithmetic": "Fractions",
  probability: "Probability",
  "geometry-measurement": "Geometry & measurement",
  "ratio-proportion-percent": "Ratios, rates & percent",
  "integers-coordinates": "Integers & the coordinate plane",
  "early-algebra": "Early algebra",
  "algebra-1": "Algebra 1",
  "discrete-math": "Discrete math",
};

/** The human label for a practice-domain slug, falling back to the slug itself. */
export function practiceDomainLabel(domain: string): string {
  return PRACTICE_DOMAIN_LABELS[domain] ?? domain;
}

/** Domain-specific kid-facing headlines for strands whose slugs are shared
 * across domains but describe different mathematical ideas. */
const DOMAIN_STRAND_HEADLINE_OVERRIDES: Record<string, Record<string, string>> = {
  "discrete-math": {
    counting: "Combinatorics",
    "number-theory": "Odds, Evens & Remainders",
  },
};

/**
 * Resolve a kid-facing strand headline in its domain context, falling back to
 * the backward-compatible global strand headline when no override exists.
 */
export function strandHeadlineFor(domain: string, strand: string): string {
  return DOMAIN_STRAND_HEADLINE_OVERRIDES[domain]?.[strand] ?? strandHeadline(strand);
}

/**
 * Natural-language aliases → registered domain slug, for the strings a scholar
 * (or a hand-typed / shared URL) might supply for `?domain=`. Keys are stored in
 * the same normalized form `resolvePracticeDomainSlug` computes (lowercased,
 * runs of spaces/hyphens/underscores collapsed to a single "-"), so "Fractions",
 * "fraction", and "FRACTION" all hit the same entry. Every value MUST be a key
 * of `PRACTICE_DOMAIN_LABELS` (a registered slug) — asserted by the unit test.
 */
const PRACTICE_DOMAIN_ALIASES: Record<string, string> = {
  fractions: "fraction-arithmetic",
  fraction: "fraction-arithmetic",
  chance: "probability",
  geometry: "geometry-measurement",
  measurement: "geometry-measurement",
  "geometry-measurement": "geometry-measurement",
  ratio: "ratio-proportion-percent",
  ratios: "ratio-proportion-percent",
  percent: "ratio-proportion-percent",
  proportions: "ratio-proportion-percent",
  integers: "integers-coordinates",
  "negative-numbers": "integers-coordinates",
  negatives: "integers-coordinates",
  algebra: "early-algebra",
  equations: "early-algebra",
  patterns: "early-algebra",
  algebra1: "algebra-1",
  "algebra-one": "algebra-1",
  quadratics: "algebra-1",
  discrete: "discrete-math",
  combinatorics: "discrete-math",
  logic: "discrete-math",
  "graph-theory": "discrete-math",
  "whole-number": "whole-number-arithmetic",
  "whole-numbers": "whole-number-arithmetic",
  arithmetic: "whole-number-arithmetic",
};

/**
 * Map a user- or URL-supplied domain string to a REGISTERED practice-domain slug,
 * or `null` when it can't be resolved. Pure and dependency-free (it lives here,
 * not in `convex/lib/practice/domains.ts`, so the web page AND the vendored
 * native practice surface share ONE resolver — the domains.ts module re-exports
 * this and can't itself be vendored, as it pulls in the seed graphs).
 *
 * Resolution order:
 *   1. Exact registered slug — matched case/space/hyphen-insensitively, so
 *      "fraction-arithmetic", "Fraction Arithmetic", and "Probability" all work.
 *   2. A small alias map of the natural guesses ("fractions" → fraction-arithmetic,
 *      "chance" → probability, "arithmetic" → whole-number-arithmetic, …).
 *   3. Otherwise `null`. Callers MUST treat `null` as "no domain given" and fall
 *      to the scholar's normal default — never silently substitute a default
 *      domain (an unknown `?domain=` must not restart a whole-number placement).
 */
export function resolvePracticeDomainSlug(
  input: string | null | undefined,
): string | null {
  if (!input) return null;
  const key = input.trim().toLowerCase().replace(/[\s_-]+/g, "-");
  if (!key) return null;
  // 1. Exact registered slug (registered slugs are already normalized kebab).
  if (Object.prototype.hasOwnProperty.call(PRACTICE_DOMAIN_LABELS, key)) return key;
  // 2. Natural-language alias (keys are pre-normalized the same way as `key`).
  return PRACTICE_DOMAIN_ALIASES[key] ?? null;
}

/**
 * Short, kid-facing HEADLINE for a practice-strand slug (`knowledgeNodes.strand`
 * / `practiceMastery.strand`) — the "You pick" moment's hook on the scholar
 * home (e.g. "Multiplication & Division"), never the raw kebab-case identity.
 * Curated for the strands the registered practice graphs actually use today;
 * falls back to a title-cased split of the slug for anything not yet in the
 * map, so a newly-seeded strand still reads sentence-like instead of a raw
 * "mult-divide". Framework-free like the rest of this module, for the same
 * web+native vendoring reason.
 */
const STRAND_HEADLINES: Record<string, string> = {
  "add-subtract": "Addition & Subtraction",
  "mult-divide": "Multiplication & Division",
  "place-value": "Place Value",
  counting: "Counting",
  "number-theory": "Factors & Multiples",
  concept: "Fraction Concepts",
  equivalence: "Equivalent Fractions",
  comparison: "Comparing Fractions",
  operations: "Fraction Operations",
  decimals: "Decimals",
  chance: "Chance & Likelihood",
  theoretical: "Theoretical Probability",
  experimental: "Experimental Probability",
  compound: "Probability of Two Events",
  "data-displays": "Reading Data Displays",
  "center-spread": "Averages & Spread",
  "measurement-data": "Measuring, Time & Money",
  "area-perimeter": "Area & Perimeter",
  volume: "Volume",
  angles: "Angles",
  "coordinate-geometry": "Grids & Coordinates",
  "ratios-rates": "Ratios & Rates",
  percent: "Percent",
  "proportional-reasoning": "Scaling & Proportions",
  "negatives-absvalue": "Negatives & Absolute Value",
  "integer-operations": "Integer Operations",
  "rational-ordering": "Ordering Signed Numbers",
  "expressions-variables": "Expressions & Variables",
  "equations-1-2-step": "Solving Equations",
  "patterns-sequences": "Patterns & Sequences",
  inequalities: "Solving Inequalities",
  "linear-equations": "Linear Equations & Inequalities",
  "linear-functions": "Linear Functions",
  systems: "Systems of Equations",
  "exponents-exponential": "Exponents & Exponential Growth",
  "polynomials-factoring": "Polynomials & Factoring",
  quadratics: "Quadratics",
  // Discrete-math strands are curated in DOMAIN_STRAND_HEADLINE_OVERRIDES when
  // their slugs overlap with another domain.
  "graph-theory": "Networks & Paths",
  logic: "Logic & Deduction",
};

export function strandHeadline(strand: string): string {
  const curated = STRAND_HEADLINES[strand];
  if (curated) return curated;
  return strand
    .split(/[-_]/)
    .filter(Boolean)
    .map((word) => word[0].toUpperCase() + word.slice(1))
    .join(" ");
}

/**
 * The PLAIN, uncurated title-case of a strand slug ("add-subtract" → "Add
 * Subtract") — the teacher-facing label used by the Math Skills studio's domain
 * rail, strand headings, cohort tree and the bulk focus dialog.
 *
 * Distinct from {@link strandHeadline}, which is the kid-facing CURATED headline
 * ("Addition & Subtraction"). They live together deliberately: same input, two
 * audiences, so the difference is visible rather than rediscovered. Previously
 * this was exported from the (now retired) `components/MathFocusEditor.tsx` and
 * hand-copied into two more components; this is its one home.
 */
export function humanizeStrand(strand: string): string {
  return strand
    .split(/[-_]/)
    .map((word) => (word ? word[0].toUpperCase() + word.slice(1) : word))
    .join(" ");
}

/**
 * Short, kid-facing CONCEPT nouns for the specific cross-domain prerequisite
 * SKILLS that gate a later practice domain — keyed by the prerequisite's
 * `nodeKey` (globally unique; graphValidation). Used to phrase the gated-entry
 * note NAMING THE ACTUAL PREREQUISITE (Andy's "recommend the specific X, but let
 * them proceed"): e.g. `division_as_sharing` → "division", so a scholar
 * self-selecting Fractions reads "Fractions builds on division — we recommend
 * getting comfortable with division first, but you can try it now if you want a
 * challenge." An unmapped prereq falls back to the prerequisite DOMAIN's label,
 * so the note always names *something* concrete rather than a generic "gated".
 * Dependency-free (lives here, vendored to native) so both frontends share it.
 */
export const PRACTICE_PREREQ_CONCEPTS: Record<string, string> = {
  division_as_sharing: "division",
  fraction_as_parts: "fractions",
  arrays_concept: "arrays",
  multiply_fractions: "fraction multiplication",
  mult_2digit_by_1digit: "multiplication",
  fraction_as_division: "fraction division",
  divide_fractions: "dividing fractions",
  powers_of_ten: "powers of ten",
  multiply_fraction_by_whole: "fraction multiplication",
  fraction_scaling: "fraction scaling",
  order_of_operations: "order of operations",
  long_division_2digit_divisor: "long division",
  fraction_number_line: "fractions on a number line",
  order_fractions: "ordering fractions",
  add_subtract_unlike: "adding and subtracting fractions",
  four_quadrant_plane: "the coordinate plane",
  mult_distributive: "the distributive property",
  exponents_repeated_mult: "whole-number exponents",
  integer_expressions: "signed-number expressions",
  add_subtract_integers: "integer addition and subtraction",
  divide_integers: "integer division",
  prop_table_from_rule: "proportional input-output tables",
  prop_constant_graph: "rates on proportional graphs",
  // Decimals-strand foreign prerequisites (WNA → fraction-arithmetic) and the
  // decimal nodes that in turn gate geometry / percent items.
  place_value_relationships: "place value",
  round_multidigit: "rounding",
  add_multidigit_algorithm: "multi-digit addition",
  subtract_multidigit_algorithm: "multi-digit subtraction",
  long_division_1digit_divisor: "long division",
  decimal_notation_fractions: "decimal notation",
  add_subtract_decimals: "adding and subtracting decimals",
  multiply_decimals: "decimal multiplication",
  eq_both_sides: "equations with the variable on both sides",
  expr_multi_step_signed: "multi-step signed expressions",
  eq_parentheses: "equations with parentheses",
  ineq_two_step: "two-step inequalities",
  eq_identity_contradiction: "equations with no or many solutions",
  pattern_graph_rate_change: "rate of change on a graph",
  pattern_linear_table_rule: "linear table rules",
  prop_write_equation: "proportional equations",
  multiply_integers: "integer multiplication",
  percent_change: "percent change",
  absolute_value_distance_zero: "absolute value",
  eq_two_step_integers: "two-step integer equations",
  eq_two_step_fraction_decimal: "two-step fraction and decimal equations",
  ineq_negative_coefficient: "inequalities with negative coefficients",
  // discrete-math's WNA prerequisites (the ones not already named above).
  equal_groups_concept: "equal groups",
  divisibility_rules_2_5_10: "divisibility rules",
  divisibility_rules_3_9: "the 3s and 9s divisibility rules",
  remainder_cycles: "remainder cycles",
  prime_or_composite: "primes and composites",
  square_cube_numbers: "square numbers",
  gcf: "greatest common factor",
};

/** The short concept noun for a cross-domain prerequisite skill (by `nodeKey`),
 *  falling back to `domainFallbackLabel` (lowercased) when the skill isn't in
 *  the concept map — so the gated-entry note always names a real prerequisite. */
export function practicePrereqConcept(
  nodeKey: string,
  domainFallbackLabel: string,
): string {
  return PRACTICE_PREREQ_CONCEPTS[nodeKey] ?? domainFallbackLabel.toLowerCase();
}
