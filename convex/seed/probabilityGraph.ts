/**
 * Seed data: the probability prerequisite knowledge graph.
 *
 * OUR graph — license-clean, ours to evolve; CCSS codes ride along as tags.
 * Modeled on the whole-number-arithmetic graph (same SeedSkill/SeedEdge shape),
 * loaded by the multi-graph rebuild in convex/knowledgeNodes.ts.
 *
 * DOMAIN SLUG is "probability" (kebab-ready, already a single token) —
 * deliberately not a separate "statistics" slug: data displays and statistics
 * extend the same probability domain so scholars can move between chance and
 * data without a second domain registration.
 *
 * Six strands:
 *   • chance       — likelihood language and the 0-to-1 scale
 *   • theoretical  — sample spaces, simple theoretical probability, fractions,
 *                    and complements
 *   • experimental — observed frequencies, long-run behavior, expected counts
 *   • compound     — two-dice sample spaces and total distributions
 *   • data-displays — picture graphs, bar graphs, and whole/fraction line plots
 *   • center-spread — statistical questions, center, variability, and outliers
 *
 * CROSS-DOMAIN (D4, Stage 3): three LIVE cross-domain prerequisite edges —
 * `fraction_as_parts` (fraction-arithmetic, grade 3) → `probability_as_fraction`
 * (grade 7), `fraction_number_line` → `read_fractional_line_plot`, and
 * `division_as_sharing` → `mean`. Each bridge names a genuine conceptual
 * prerequisite and is stamped with the to-side domain ("probability") by the
 * rebuild, so loadDomain("probability") sees it and the engine's foreign-aware
 * `stateOf` resolves real mastery in the source domain. The 2026-07-19
 * entrance-coverage audit added NO new hard gates here: counting → the
 * data-display entrances and comparison → `ordering` were declined (genuine but
 * near-universal, and they would hijack the surfaced prereq gate — see the
 * P10/P11 HOLD notes), and `fraction_number_line` → `likelihood_scale` was
 * deferred as contestable (see /CONTESTED_EDGES.md). The combined graph is
 * validated acyclic at seed time (assertCombinedGraphValid in knowledgeNodes.ts).
 */

import type { SeedSkill, SeedEdge } from "./wholeNumberArithmeticGraph";

export const PROBABILITY_DOMAIN = "probability";

export const PROBABILITY_SKILLS: SeedSkill[] = [
  {
    skillKey: "likelihood_scale",
    label: "Describe likelihood on a 0-to-1 probability scale",
    grade: "7",
    ccCodes: ["7.SP.C.5"],
    strand: "chance",
    rationale: "Anchor impossible, certain, and in-between events on the 0–1 scale so probability starts as calibrated judgment, not a formula.",
  },
  {
    skillKey: "sample_space",
    label: "List the sample space for a simple chance process",
    grade: "7",
    ccCodes: ["7.SP.C.7"],
    strand: "theoretical",
    rationale: "Name every possible outcome before counting favorable ones — the habit that keeps probability reasoning honest.",
  },
  {
    skillKey: "theoretical_probability_simple",
    label: "Find theoretical probability for a simple event",
    grade: "7",
    ccCodes: ["7.SP.C.5", "7.SP.C.7a"],
    strand: "theoretical",
    rationale: "Compare favorable outcomes with all equally likely outcomes, turning a chance question into a precise ratio.",
  },
  {
    skillKey: "probability_as_fraction",
    label: "Write probability as a fraction of favorable outcomes",
    grade: "7",
    ccCodes: ["7.SP.C.5"],
    strand: "theoretical",
    rationale: "Treat probability as a fraction that can be simplified, interpreted, and compared like any other rational number.",
  },
  {
    skillKey: "complement_probability",
    label: "Use the complement to find the probability of NOT an event",
    grade: "7",
    ccCodes: ["7.SP.C.5"],
    strand: "theoretical",
    rationale: "Reason that what does not happen fills the rest of the sample space — a first elegant shortcut in probability.",
  },
  {
    skillKey: "experimental_probability",
    label: "Estimate probability from experimental results",
    grade: "7",
    ccCodes: ["7.SP.C.6"],
    strand: "experimental",
    rationale: "Use data from trials to estimate chance, while noticing that experiments wobble around the theoretical target.",
  },
  {
    skillKey: "law_of_large_numbers",
    label: "Explain why more trials usually stabilize experimental probability",
    grade: "7",
    ccCodes: ["7.SP.C.6"],
    strand: "experimental",
    rationale: "See that many trials make the random wiggle shrink in proportion, connecting short-run surprise to long-run pattern.",
  },
  {
    skillKey: "expected_frequency",
    label: "Use probability to predict an expected frequency",
    grade: "7",
    ccCodes: ["7.SP.C.6"],
    strand: "experimental",
    rationale: "Scale a probability up to a number of trials, turning a fraction into a useful forecast for what should happen about how often.",
  },
  {
    skillKey: "compound_two_dice",
    label: "Analyze totals when rolling two fair dice",
    grade: "7",
    ccCodes: ["7.SP.C.8"],
    strand: "compound",
    rationale: "Build a two-dimensional sample space and notice why middle totals are more likely than edge totals.",
  },

  // ── Statistics extension: data displays (grades 2–3) ─────────────────────
  {
    skillKey: "read_picture_graph",
    label: "Read a one-symbol picture graph and its key",
    grade: "2",
    ccCodes: ["2.MD.D.10"],
    strand: "data-displays",
    rationale: "Decode what each picture stands for and read category totals accurately — the most concrete bridge from counting objects to reading data displays.",
  },
  {
    skillKey: "read_bar_graph",
    label: "Read a single-unit bar graph",
    grade: "2",
    ccCodes: ["2.MD.D.10"],
    strand: "data-displays",
    rationale: "Read bar lengths against a labeled scale and connect each bar to its category — data as quantity represented by length.",
  },
  {
    skillKey: "read_line_plot",
    label: "Read a whole-number line plot",
    grade: "2",
    ccCodes: ["2.MD.D.9"],
    strand: "data-displays",
    rationale: "Treat each mark as one observation at a numbered position, then count frequencies and recover facts from the display.",
  },
  {
    skillKey: "collect_measurement_data",
    label: "Collect repeated measurement data with consistent units",
    grade: "3",
    ccCodes: ["2.MD.D.9", "3.MD.B.4"],
    strand: "data-displays",
    rationale: "Measure the same attribute across several objects with one agreed unit so the resulting values can be compared and represented honestly.",
  },
  {
    skillKey: "compare_graph_categories",
    label: "Answer comparison questions from a picture graph or bar graph",
    grade: "2",
    ccCodes: ["2.MD.D.10"],
    strand: "data-displays",
    rationale: "Use represented category totals to ask how many more, fewer, or in all — reading a graph as evidence rather than decoration.",
  },
  {
    skillKey: "read_scaled_picture_bar_graph",
    label: "Read a scaled picture graph or scaled bar graph",
    grade: "3",
    ccCodes: ["3.MD.B.3"],
    strand: "data-displays",
    rationale: "Apply a scale such as one symbol or interval meaning 2, 5, or 10, resisting the trap of counting marks as single units.",
  },
  {
    skillKey: "read_fractional_line_plot",
    label: "Represent and read measurements on a line plot marked in halves or fourths",
    grade: "3",
    ccCodes: ["3.MD.B.4"],
    strand: "data-displays",
    rationale: "Place repeated measurements on a fractional number line and read them back, joining data collection, fraction position, and frequency in one compact display.",
  },

  // ── Statistics extension: center and spread (grades 5–7) ────────────────
  {
    skillKey: "statistical_question",
    label: "Recognize a statistical question that expects variable answers",
    grade: "6",
    ccCodes: ["6.SP.A.1"],
    strand: "center-spread",
    rationale: "Distinguish questions answered by one fixed fact from questions answered by a distribution — the conceptual doorway into statistics.",
  },
  {
    skillKey: "ordering",
    label: "Order a numerical data set from least to greatest",
    grade: "5",
    ccCodes: [],
    strand: "center-spread",
    rationale: "Arrange observations without losing repeats so positions, endpoints, and clusters become visible before any summary is calculated.",
  },
  {
    skillKey: "mean",
    label: "Find the mean as a fair share of the total",
    grade: "6",
    ccCodes: ["6.SP.A.3", "6.SP.B.5c"],
    strand: "center-spread",
    rationale: "Pool all values and redistribute the total equally — division as sharing gives the average a meaning before it becomes an algorithm.",
  },
  {
    skillKey: "mode",
    label: "Find and interpret the mode of a data set",
    grade: "5",
    ccCodes: [],
    strand: "center-spread",
    rationale: "Identify the value or category that occurs most often while allowing ties or no mode — a frequency summary, not a middle or average.",
  },
  {
    skillKey: "median",
    label: "Find the median as the middle of an ordered data set",
    grade: "6",
    ccCodes: ["6.SP.A.3", "6.SP.B.5c"],
    strand: "center-spread",
    rationale: "Locate the middle position after ordering, averaging the two middle values when needed — center determined by rank rather than total.",
  },
  {
    skillKey: "range",
    label: "Find the range as the distance from the least value to the greatest",
    grade: "6",
    ccCodes: ["6.SP.A.2", "6.SP.B.5c"],
    strand: "center-spread",
    rationale: "Subtract the minimum from the maximum to capture the data's full span — a first numerical view of variability.",
  },
  {
    skillKey: "mean_balance_point",
    label: "Interpret the mean as the balance point of a data set",
    grade: "6",
    ccCodes: ["6.SP.A.3"],
    strand: "center-spread",
    rationale: "See amounts above the mean balance equal deficits below it, connecting fair sharing to a structural property of the distribution.",
  },
  {
    skillKey: "compare_same_center_different_spread",
    label: "Compare data sets with the same center but different variability",
    grade: "6",
    ccCodes: ["6.SP.A.2", "6.SP.A.3", "6.SP.B.5c"],
    strand: "center-spread",
    rationale: "Notice that equal means or medians do not make distributions alike — one can cluster tightly while another spreads far out.",
  },
  {
    skillKey: "typical_distance_from_fair_share",
    label: "Reason about the typical distance from the fair-share mean",
    grade: "7",
    ccCodes: ["6.SP.B.5c"],
    strand: "center-spread",
    rationale: "Compare absolute distances from the mean and summarize their typical size — a MAD-lite view of spread without hiding behind a formula.",
  },
  {
    skillKey: "outlier_effect_on_mean_median",
    label: "Predict how an outlier affects the mean and median",
    grade: "7",
    ccCodes: ["6.SP.B.5d"],
    strand: "center-spread",
    rationale: "Reason that an extreme value pulls the fair-share mean much more than the positional median, then choose the more revealing center for the context.",
  },
];

export const PROBABILITY_EDGES: SeedEdge[] = [
  { fromKey: "likelihood_scale", toKey: "sample_space" },
  { fromKey: "sample_space", toKey: "theoretical_probability_simple" },
  { fromKey: "theoretical_probability_simple", toKey: "probability_as_fraction" },
  { fromKey: "theoretical_probability_simple", toKey: "complement_probability" },
  { fromKey: "theoretical_probability_simple", toKey: "experimental_probability" },
  { fromKey: "theoretical_probability_simple", toKey: "compound_two_dice" },
  { fromKey: "sample_space", toKey: "compound_two_dice" },
  { fromKey: "experimental_probability", toKey: "law_of_large_numbers" },
  { fromKey: "experimental_probability", toKey: "expected_frequency" },

  // ── Cross-domain bridge (D4, Stage 3) — LIVE ─────────────────────────────
  // Writing a probability as a fraction of favorable outcomes genuinely builds
  // on understanding what a fraction IS. `fraction_as_parts` is a grade-3
  // fraction-arithmetic node, so this edge is grade-FORWARD (3 → 7) and
  // pedagogically sound. Declared HERE (in the probability graph) so the rebuild
  // stamps it `domain: "probability"` (the to-side domain) — loadDomain(
  // "probability") then sees it, and the engine's foreign-aware `stateOf`
  // (buildFrontierStateOf, convex/practiceSkills.ts) resolves the foreign
  // fraction prereq against the scholar's real fraction mastery instead of
  // reading it as never-practiced. `probability_as_fraction` is a LEAF (nothing
  // downstream depends on it), so gating it strands nothing else in probability.
  // This is the live demonstrator that exercises the D4 seam end-to-end.
  { fromKey: "fraction_as_parts", toKey: "probability_as_fraction" },

  // ── Statistics extension: 21 internal + 2 cross-domain edges ─────────────
  { fromKey: "read_picture_graph", toKey: "compare_graph_categories" },
  { fromKey: "read_bar_graph", toKey: "compare_graph_categories" },
  { fromKey: "read_picture_graph", toKey: "read_scaled_picture_bar_graph" },
  { fromKey: "read_bar_graph", toKey: "read_scaled_picture_bar_graph" },
  { fromKey: "read_line_plot", toKey: "read_fractional_line_plot" },
  // Fraction positions transfer directly to a line plot marked in halves/fourths.
  { fromKey: "fraction_number_line", toKey: "read_fractional_line_plot" },
  { fromKey: "collect_measurement_data", toKey: "read_fractional_line_plot" },
  { fromKey: "compare_graph_categories", toKey: "mode" },
  { fromKey: "ordering", toKey: "mode" },
  { fromKey: "ordering", toKey: "median" },
  { fromKey: "ordering", toKey: "range" },
  { fromKey: "ordering", toKey: "mean" },
  // Mean begins with the already-learned meaning of division as fair sharing.
  { fromKey: "division_as_sharing", toKey: "mean" },
  { fromKey: "mean", toKey: "mean_balance_point" },
  { fromKey: "statistical_question", toKey: "compare_same_center_different_spread" },
  { fromKey: "mean", toKey: "compare_same_center_different_spread" },
  { fromKey: "median", toKey: "compare_same_center_different_spread" },
  { fromKey: "range", toKey: "compare_same_center_different_spread" },
  { fromKey: "mean_balance_point", toKey: "typical_distance_from_fair_share" },
  { fromKey: "range", toKey: "typical_distance_from_fair_share" },
  { fromKey: "mean", toKey: "outlier_effect_on_mean_median" },
  { fromKey: "median", toKey: "outlier_effect_on_mean_median" },
  { fromKey: "compare_same_center_different_spread", toKey: "outlier_effect_on_mean_median" },

  // Audited and deliberately declined / deferred cross-domain hard gates:
  // P10 HOLD: Whole-number comparison → `ordering` is a true dependency (sorting
  //   a data set IS iterated comparison) but comparison is basic and near-universal
  //   by grade 5, so gating the sort node on it adds clutter without changing
  //   placement for any real g5 learner (cf. early-algebra P6). Left off.
  // P11 HOLD: Counting → the data-display entrances (`read_picture_graph`,
  //   `read_bar_graph`, `read_line_plot`) is a true dependency (you read a
  //   display by counting its units/marks), but `count_objects_within_20` is
  //   grade K and near-universal by these grade-2 nodes, so the edges moved
  //   placement almost nowhere in simulation — AND, being the lowest-grade
  //   prereq, they would hijack the user-facing prereq-gate recommendation from
  //   the substantive "division" down to trivial "counting". Genuine but
  //   net-negative; left off (cf. P6/P10).
  // CONTESTED (deferred to /CONTESTED_EDGES.md, NOT added): `fraction_number_line`
  //   → `likelihood_scale`. The 0-to-1 probability scale genuinely rests on
  //   fraction number-line sense on [0,1] (a #881-style "silently assumed
  //   fluency" gap), BUT `likelihood_scale` is the chance-strand ROOT the engine
  //   is built and tested to serve as an ungated fresh-scholar entry
  //   (practiceSkills serveability tests); a hard `buildsOn` gate here removes
  //   the entire chance/theoretical strand from a fraction-less scholar's
  //   frontier. That is a product-judgment call (soft/invitation edge or a
  //   re-grade, à la the gcf/lcm Decision #4 hold), not a curation-lane default.
];

/**
 * INFERENCE-ONLY cross-domain edges (kind:"implies") — genuine information
 * dependencies from the 2026-07-19 entrance audit, given a home that never gates.
 * An `implies` edge feeds the two blessed inference consumers only (implicit
 * credit + placement diagnostic), and is structurally invisible to the frontier
 * gate and the surfaced prereq recommendation (both key off kind:"buildsOn").
 *
 * The implication CONTRACT — vetted against the real target TEMPLATES, not the
 * node labels — is: the target's item genuinely exercises the source skill, so a
 * scholar fluent in the source can be trusted through the target (placement) and a
 * correct target answer is evidence for the source (implicit credit). Only edges
 * that pass hold: the data-display entrances all literally COUNT (`read_picture_
 * graph` counts 2-6 icons, `read_bar_graph` reads a bar's units, `read_line_plot`
 * counts marks at a value), so `count_objects_within_20` genuinely underlies them.
 *
 * PRUNED (an adversarial template-vetting review (§5) — target template does NOT exercise
 * the source, so they would mint false credit once wired): `compare_3digit ->
 * ordering` (target only orders {2..9}), `perimeter_polygons ->
 * collect_measurement_data` (target picks a consistent-units plan; no perimeter),
 * `compare_within_10 -> statistical_question` (target classifies variable-answer
 * questions; no comparison). The 5 CONTESTED edges (see /CONTESTED_EDGES.md) and
 * the grade-inverted `division_as_sharing -> partition_shapes` also stay OUT.
 * Stamped with this (to-side) domain by the rebuild, like the cross-domain
 * buildsOn edges.
 */
export const PROBABILITY_IMPLIES_EDGES: SeedEdge[] = [
  // reading a one-symbol picture graph IS counting the represented icons (2-6).
  { fromKey: "count_objects_within_20", toKey: "read_picture_graph" },
  // a single-unit bar graph is read by counting/reading the bar's whole-number units.
  { fromKey: "count_objects_within_20", toKey: "read_bar_graph" },
  // a whole-number line plot is read by counting the marks at a position.
  { fromKey: "count_objects_within_20", toKey: "read_line_plot" },
];
