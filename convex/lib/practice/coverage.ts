/**
 * Chokepoint coverage policy (raise-the-ceiling §3).
 *
 * THE INVARIANT: every GATING node (any node that is the `fromKey` of a buildsOn
 * edge) must be serveable — otherwise the frontier can render a node that can't
 * be practiced, can't accrue reps, can't become fluent, and can't be probed at
 * placement (isProbeable = hasTemplate). A node is serveable when it satisfies:
 *
 *     hasTemplate(nodeKey)  ||  PRE_WARMED_CONCEPTUAL.has(nodeKey)
 *
 * Most untemplated nodes are mechanical and simply get a template (§6 form
 * engine covers the property nodes). A handful are genuinely conceptual — the
 * item's *quality* wants the LLM layer, not a template — so they are pre-warmed
 * with verified items at seed/deploy time (see practiceGen.generateVerifiedItems
 * and the pre-warm seed step). This set is that allowlist: the single source of
 * truth shared by the coverage CI test (A3) and the pre-warm wiring (A4).
 *
 * Adding a node here is a deliberate decision that its items come from the
 * verified-LLM pipeline, NOT that it may stay unserveable — the CI test treats
 * membership as "covered", so an entry with no seeded items in prod is a
 * coverage hole the seed/deploy step must fill.
 */
export const PRE_WARMED_CONCEPTUAL: ReadonlySet<string> = new Set([
  // ── fraction-arithmetic (Wave D) ────────────────────────────────────────
  // The genuinely conceptual/visual fraction gating nodes — "partition a shape
  // into fourths", "place 3/4 on a number line", "a/b as a copies of 1/b". The
  // computational fraction skills, `unit_fraction`, and `fraction_as_division`
  // (a ÷ b written as the fraction a/b — now a genuine templated item answered
  // in the native 2-D expression editor) are templated (templates.ts); the
  // remaining visual roots want the LLM's contextual/visual framing, so they're
  // pre-warmed with verified items.
  "partition_shapes",
  "fraction_as_parts",
  "fraction_number_line",
  "equivalent_fractions_visual",
]);
