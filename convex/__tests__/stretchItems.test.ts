/**
 * Stretch-tier items (Beast-Academy-style deliberate difficulty) — serving +
 * grading integration tests. The invariants under test:
 *
 *   • before a domain summit, a stretch item stays out of the ordinary rotation
 *     and is offered only in the opt-in "Go deeper" tail (`stretch` on
 *     practiceSession), for nodes with DEMONSTRATED fluency;
 *   • a stretch MISS never touches the mastery row (no half-life lapse, no
 *     rep change, no source change) — telemetry only (lane "stretch");
 *   • a stretch SUCCESS records a normal practice rep AND writes ONE depth
 *     observation (masteryObservations, evidenceType "stretch_success") at the
 *     item's Bloom level, deduped per node+level;
 *   • insight and application evidence suppress only their own facet.
 */
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "../schema";
import { api, internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import {
  APPLICATION_EVIDENCE_TYPE,
  STRETCH_EVIDENCE_TYPE,
} from "../practiceSkills";
import { STRETCH_SEED_ITEMS } from "../seed/stretchItems";
import { parseAnswer, rawAnswersEqual, type AnswerType } from "../lib/practice/answers";

const modules = (
  import.meta as ImportMeta & {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("../**/*.ts");

const DOMAIN = "whole-number-arithmetic";
const SKILL_KEY = "stretch_test_skill";
const DAY_MS = 86_400_000;

async function seedScholar(t: ReturnType<typeof convexTest>) {
  return await t.run(async (ctx) =>
    ctx.db.insert("users", {
      name: "Stretch Scholar",
      username: "stretch-scholar",
      role: "scholar",
    }),
  );
}

async function asUser(t: ReturnType<typeof convexTest>, userId: Id<"users">) {
  const sessionId = await t.run(async (ctx) => {
    const session: Omit<Doc<"authSessions">, "_id" | "_creationTime"> = {
      userId,
      expirationTime: Date.now() + 3_600_000,
    };
    return ctx.db.insert("authSessions", session);
  });
  return t.withIdentity({ subject: `${userId}|${sessionId}`, issuer: "https://convex.dev" });
}

async function seedNode(t: ReturnType<typeof convexTest>, nodeKey = SKILL_KEY) {
  await t.run(async (ctx) => {
    await ctx.db.insert("knowledgeNodes", {
      nodeKey,
      label: `Label for ${nodeKey}`,
      domain: DOMAIN,
      strand: "mult-divide",
      source: "practice",
    });
  });
}

async function keepDomainOpen(t: ReturnType<typeof convexTest>) {
  await seedNode(t, "stretch_test_pending_skill");
}

async function seedStretchItem(
  t: ReturnType<typeof convexTest>,
  opts: {
    nodeKey?: string;
    bloomLevel?: number;
    stem?: string;
    answerType?: string;
    answerCanonical?: string;
    choices?: string[];
    storyToKey?: string;
  } = {},
) {
  return await t.run(async (ctx) =>
    ctx.db.insert("practiceItems", {
      skillKey: opts.nodeKey ?? SKILL_KEY,
      domain: DOMAIN,
      stem: opts.stem ?? "Two one-digit numbers sum to 15 and their product ends in 4. The product?",
      answerType: opts.answerType ?? "integer",
      answerCanonical: opts.answerCanonical ?? "54",
      ...(opts.choices ? { choices: opts.choices } : {}),
      verifierKind: "arithmetic",
      tier: "stretch",
      technique: "casework",
      bloomLevel: opts.bloomLevel ?? 4,
      ...(opts.storyToKey ? { storyToKey: opts.storyToKey } : {}),
      source: "authored",
      verifiedAt: Date.now(),
    }),
  );
}

async function seedMastery(
  t: ReturnType<typeof convexTest>,
  scholarId: Id<"users">,
  opts: {
    nodeKey?: string;
    repetition?: number;
    source?: string;
    lastPracticedAt?: number;
    halfLifeDays?: number;
  } = {},
) {
  return await t.run(async (ctx) =>
    ctx.db.insert("practiceMastery", {
      scholarId,
      skillKey: opts.nodeKey ?? SKILL_KEY,
      domain: DOMAIN,
      strand: "mult-divide",
      repetition: opts.repetition ?? 3,
      halfLifeDays: opts.halfLifeDays ?? 30,
      lastPracticedAt: opts.lastPracticedAt ?? Date.now() - DAY_MS,
      lastAttemptAt: Date.now() - DAY_MS,
      frontier: false,
      source: opts.source ?? "practice",
      latencySamplesMs: [1_200, 900, 1_100],
      latencyMedianMs: 1_100,
      latencySpreadMs: 100,
      accelStreak: 2,
      becameFluentAt: Date.now() - 2 * DAY_MS,
      frontierAdvancedAt: Date.now() - 3 * DAY_MS,
      updatedAt: Date.now() - DAY_MS,
    }),
  );
}

async function readMastery(t: ReturnType<typeof convexTest>, scholarId: Id<"users">) {
  return await t.run(async (ctx) => {
    const rows = (await ctx.db.query("practiceMastery").collect()) as Doc<"practiceMastery">[];
    return rows.find((r) => r.scholarId === scholarId && r.skillKey === SKILL_KEY) ?? null;
  });
}

async function readObservations(t: ReturnType<typeof convexTest>) {
  return await t.run(
    async (ctx) => (await ctx.db.query("masteryObservations").collect()) as Doc<"masteryObservations">[],
  );
}

async function readAttempts(t: ReturnType<typeof convexTest>) {
  return await t.run(
    async (ctx) => (await ctx.db.query("practiceAttempts").collect()) as Doc<"practiceAttempts">[],
  );
}

describe("STRETCH_SEED_ITEMS registry — every authored item is well-formed and verifies", () => {
  const typedItems = STRETCH_SEED_ITEMS.filter((it) => it.answerType !== "dialogue");
  const dialogueItems = STRETCH_SEED_ITEMS.filter((it) => it.answerType === "dialogue");

  test.each(typedItems.map((it) => [`${it.skillKey} :: ${it.stem.slice(0, 48)}`, it] as const))(
    "%s — canonical answer parses as its answerType and self-verifies through the grader",
    (_label, item) => {
      const type = item.answerType as AnswerType;
      // A non-empty answer the grader can turn into a truth value.
      expect(item.answer.trim().length).toBeGreaterThan(0);
      expect(parseAnswer(item.answer, type)).not.toBeNull();
      // A scholar typing the canonical string grades correct (the exact path
      // submitAnswer takes for a stored stretch item).
      expect(rawAnswersEqual(item.answer, item.answer, type)).toBe(true);
      // Every stretch item must name an insight technique (the anti-drill gate).
      expect(item.technique.trim().length).toBeGreaterThan(0);
    },
  );

  test("every dialogue item has an empty typed answer and 2–3 server-only rubric criteria", () => {
    for (const item of dialogueItems) {
      expect(item.answer).toBe("");
      const count = item.rubricCriteria?.length ?? 0;
      expect(count).toBeGreaterThanOrEqual(2);
      expect(count).toBeLessThanOrEqual(3);
      for (const criterion of item.rubricCriteria ?? []) {
        expect(criterion.trim().length).toBeGreaterThan(0);
      }
    }
  });

  describe("seedStretchItems — copy updates", () => {
    test("renames the legacy counting-on item in place without duplicating it", async () => {
      const t = convexTest(schema, modules);
      const legacyStem =
        "Instead of starting at 1, count ON from 7 up to 12: 8, 9, 10, 11, 12. How many numbers did you say?";
      const currentStem =
        "Instead of starting at 1, count forward from 7 up to 12: 8, 9, 10, 11, 12. How many numbers did you say?";

      await seedNode(t, "count_on");
      const legacyId = await t.run(async (ctx) =>
        ctx.db.insert("practiceItems", {
          skillKey: "count_on",
          domain: DOMAIN,
          stem: legacyStem,
          answerType: "integer",
          answerCanonical: "5",
          verifierKind: "arithmetic",
          tier: "stretch",
          technique: "structure",
          bloomLevel: 3,
          source: "authored",
          verifiedAt: Date.now(),
        }),
      );

      const first = await t.mutation(internal.seed.stretchItems.seedStretchItems, {});
      expect(first.updated).toBe(1);
      expect(first.inserted).toBe(0);
      expect((await t.run(async (ctx) => ctx.db.get(legacyId)))?.stem).toBe(currentStem);

      const second = await t.mutation(internal.seed.stretchItems.seedStretchItems, {});
      expect(second.updated).toBe(0);
      expect(second.skippedExisting).toBe(1);
      expect(
        await t.run(async (ctx) =>
          ctx.db
            .query("practiceItems")
            .withIndex("by_skill", (q) => q.eq("skillKey", "count_on"))
            .collect(),
        ),
      ).toHaveLength(1);
    });

    test("updates legacy copy without deleting an already-served current row", async () => {
      const t = convexTest(schema, modules);
      const legacyStem =
        "Instead of starting at 1, count ON from 7 up to 12: 8, 9, 10, 11, 12. How many numbers did you say?";
      const currentStem =
        "Instead of starting at 1, count forward from 7 up to 12: 8, 9, 10, 11, 12. How many numbers did you say?";

      await seedNode(t, "count_on");
      const insertItem = async (stem: string) =>
        await t.run(async (ctx) =>
          ctx.db.insert("practiceItems", {
            skillKey: "count_on",
            domain: DOMAIN,
            stem,
            answerType: "integer",
            answerCanonical: "5",
            verifierKind: "arithmetic",
            tier: "stretch",
            technique: "structure",
            bloomLevel: 3,
            source: "authored",
            verifiedAt: Date.now(),
          }),
        );
      const legacyId = await insertItem(legacyStem);
      const duplicateId = await insertItem(currentStem);

      const result = await t.mutation(internal.seed.stretchItems.seedStretchItems, {});
      expect(result.updated).toBe(1);
      expect((await t.run(async (ctx) => ctx.db.get(legacyId)))?.stem).toBe(currentStem);
      expect((await t.run(async (ctx) => ctx.db.get(duplicateId)))?.stem).toBe(currentStem);
    });
  });

  test("no two seed items share the same (skillKey, stem) — the idempotency key", () => {
    const seen = new Set<string>();
    for (const item of STRETCH_SEED_ITEMS) {
      const key = `${item.skillKey}\u0000${item.stem}`;
      expect(seen.has(key)).toBe(false);
      seen.add(key);
    }
  });
});

describe("STRETCH_SEED_ITEMS — mathematical correctness spot-checks", () => {
  // The self-verify test above only proves an answer parses and equals ITSELF —
  // a transcription typo (a wrong-but-well-formed canonical answer) would still
  // pass it. These assert INDEPENDENTLY-computed expected answers for a
  // representative item from each wave-2 strand, matched by a unique stem
  // fragment, so a mis-keyed answer fails loudly.
  const expectations: ReadonlyArray<{ fragment: string; answer: string }> = [
    // geometry-measurement / area-perimeter
    { fragment: "cut into equal squares. It has 3 rows", answer: "5" },
    { fragment: "square and an equilateral triangle have the same perimeter", answer: "6" },
    { fragment: "6-by-13 rectangle is split", answer: "78" },
    { fragment: "small 3-by-3 square cut out of one corner", answer: "36" },
    { fragment: "perimeter of 20. What is the largest area", answer: "25" },
    { fragment: "3/4 of a unit wide and 2/3 of a unit tall", answer: "1/2" },
    { fragment: "parallelogram has base 10 and height 4", answer: "0" },
    { fragment: "trapezoid has parallel sides of 5 and 9", answer: "7" },
    // whole-number-arithmetic / number-theory
    { fragment: "exactly one even number that is prime", answer: "2" },
    { fragment: "7 is a factor of both 21 and 56", answer: "11" },
    { fragment: "smallest whole number bigger than 1 that has an ODD number of factors", answer: "4" },
    { fragment: "smallest whole number you can multiply 72 by", answer: "2" },
    { fragment: "GCF of 12. How many common factors", answer: "6" },
    { fragment: "GCF 4 and LCM 24", answer: "96" },
    { fragment: "ones digit of 2¹⁰", answer: "4" },
    { fragment: "BOTH a perfect square and a perfect cube", answer: "64" },
    { fragment: "clock shows 10 o'clock now", answer: "2" },
    // ratio-proportion-percent / ratios-rates
    { fragment: "apples and oranges in the ratio 3 to 5", answer: "3/8" },
    { fragment: "add 4 more cups of blue", answer: "6" },
    { fragment: "12 : 18 and 20 : 30", answer: "5" },
    { fragment: "pairs with 2?", answer: "5" },
    { fragment: "more orangey", answer: "2/5" },
    { fragment: "6 apples cost the same as 4 oranges", answer: "9" },
    { fragment: "6-pack of the same juice costs 18", answer: "0.5" },
    { fragment: "how many ways can you write this ratio", answer: "4" },
    { fragment: "LONGER is 3 yards than 100 inches", answer: "8" },
    // geometry-measurement / angles
    { fragment: "minute hand of a clock sweeps", answer: "60" },
    { fragment: "halfway between a right angle and a straight angle", answer: "135" },
    { fragment: "how many of its angles can be right angles", answer: "1" },
    { fragment: "two equal sides of length 7", answer: "6" },
    // early-algebra / expressions-variables
    { fragment: "12 − 4 − 2 to make the value as big as possible", answer: "10" },
    { fragment: "20 − 2 × (3 + 4)", answer: "6" },
    { fragment: "the term x, written all by itself", answer: "1" },
    { fragment: "five less than three times four", answer: "7" },
    { fragment: "2 + 3²", answer: "11" },
    { fragment: "SWAP the values so a = 5 and b = 4", answer: "23" },
    { fragment: "perimeter 20 and length 7", answer: "3" },
    { fragment: "2 × (x − 3) + 4 when x = −1", answer: "-4" },
    // whole-number-arithmetic / counting
    { fragment: "count forward from 7 up to 12", answer: "5" },
    { fragment: "14 buttons in a row", answer: "14" },
    // ── WAVE 3 — fraction-arithmetic ──
    // fraction-arithmetic / operations
    { fragment: "1/7 + 2/7 + 3/7", answer: "3" },
    { fragment: "added to 5/12 and the total", answer: "7/12" },
    { fragment: "two eighths-fractions", answer: "3" },
    { fragment: "a is twice as big as b", answer: "2" },
    { fragment: "whole number times 3/8 gives exactly 3", answer: "8" },
    { fragment: "for the first time the answer is a whole number", answer: "6" },
    { fragment: "How many 1/4s are in 3?", answer: "12" },
    { fragment: "7/8 × 5/6 bigger than 5/6", answer: "2" },
    { fragment: "3/4-cup scoops", answer: "8" },
    // fraction-arithmetic / equivalence
    { fragment: "common denominator for 1/6 and 1/4", answer: "12" },
    { fragment: "simplifies to 2/3. Its numerator is 14", answer: "21" },
    { fragment: "twelfths equal 1/2", answer: "6" },
    // fraction-arithmetic / comparison
    { fragment: "3/4, 3/5, 3/7, and 3/10", answer: "4" },
    { fragment: "How many ninths sit strictly between 1/3 and 2/3", answer: "2" },
    { fragment: "greater than 1:  5/4", answer: "2" },
    { fragment: "5/6 in order from smallest to largest", answer: "3/4" },
    // fraction-arithmetic / concept
    { fragment: "denominator 5. What is its numerator", answer: "15" },
    { fragment: "halfway between 0 and 1/2", answer: "1/4" },
    { fragment: "How many thirds are there in 2 1/3", answer: "7" },
    { fragment: "how many quarters are left over", answer: "3" },
    { fragment: "cuts EVERY piece in half", answer: "2" },
    // fraction-arithmetic / decimals
    { fragment: "lowest terms, what is its denominator", answer: "2" },
    { fragment: "LARGEST hundredths value that still rounds down", answer: "0.44" },
    { fragment: "0.9 + 0.09 + 0.009", answer: "0.999" },
    { fragment: "How many 0.25s are in 2?", answer: "8" },
    // ── WAVE 4 — algebra-1 application lane (linear-equations, linear-functions) ──
    { fragment: "greatest whole number of weeks the team can do fieldwork", answer: "9" },
    { fragment: "how many whole dial positions keep the sensor in spec", answer: "7" },
    { fragment: "On what day does the model say rationing begins", answer: "80" },
    { fragment: "For how many of these four lookups is the output completely determined", answer: "2" },
    { fragment: "what was her actual climbing rate in meters per hour", answer: "120" },
    { fragment: "what total should the app show after 40 trips", answer: "173" },
    { fragment: "greatest number of child tickets she can buy", answer: "10" },
    { fragment: "what distance will she actually be walking after 5 weeks", answer: "150" },
    { fragment: "After how many weeks do the two plans hold the same amount", answer: "20" },
  ];

  test.each(expectations.map((e) => [e.fragment, e.answer] as const))(
    "item matching %s has canonical answer %s",
    (fragment, expected) => {
      const matches = STRETCH_SEED_ITEMS.filter((it) => it.stem.includes(fragment));
      expect(matches).toHaveLength(1);
      expect(matches[0].answer).toBe(expected);
      // And the grader agrees the expected string is a correct submission.
      expect(
        rawAnswersEqual(expected, matches[0].answer, matches[0].answerType as AnswerType),
      ).toBe(true);
    },
  );
});

describe("STRETCH_SEED_ITEMS — wave-2 strand coverage", () => {
  const nodeKeys = new Set(STRETCH_SEED_ITEMS.map((it) => it.skillKey));

  // Every node the wave-2 lane committed to authoring must be represented.
  const coveredNodes: Record<string, readonly string[]> = {
    "area-perimeter": [
      "partition_rectangles_rows_cols",
      "area_unit_squares",
      "perimeter_polygons",
      "area_rectangle",
      "area_distributive",
      "area_rectilinear_decompose",
      "area_perimeter_relationship",
      "perimeter_composite",
      "area_perimeter_unknown_side",
      "area_word_problems",
      "same_perimeter_optimize",
      "area_fraction_side",
      "area_parallelogram",
      "area_triangle",
      "area_trapezoid",
      "area_composite_polygons",
    ],
    "number-theory": [
      "prime_or_composite",
      "is_factor",
      "is_multiple",
      "divisibility_rules_2_5_10",
      "divisibility_rules_3_9",
      "factor_pairs",
      "factors_and_multiples",
      "common_factors",
      "prime_factorization",
      "common_multiples",
      "exponents_repeated_mult",
      "gcf",
      "lcm",
      "remainder_cycles",
      "square_cube_numbers",
    ],
    "ratios-rates": [
      "ratio_concept_language",
      "ratio_part_part_to_whole",
      "ratio_order_matters",
      "ratio_equivalent_scale",
      "ratio_reduce",
      "ratio_table_complete",
      "ratio_double_number_line",
      "ratio_compare",
      "rate_unit_whole_numbers",
      "rate_unit_price",
      "rate_constant_speed",
      "rate_measurement_conversion",
      "rate_unit_fractional_quantities",
      "ratio_forms",
    ],
    angles: [
      "angle_concept",
      "angle_turns_circle",
      "benchmark_angles",
      "angle_classification",
      "parallel_perpendicular_lines",
      "angle_additivity",
      "classify_triangles_sides",
      "classify_triangles_angles",
      "classify_quadrilaterals",
      "quadrilateral_hierarchy",
      "angle_sum_triangle",
    ],
    "expressions-variables": [
      "expr_grouping_symbols",
      "expr_evaluate_numerical",
      "expr_variable_meaning",
      "expr_terms_factors_coefficients",
      "expr_translate_words",
      "expr_evaluate_one_variable",
      "expr_evaluate_two_variables",
      "expr_evaluate_exponents",
      "expr_evaluate_fractions",
      "expr_distributive_numeric",
      "expr_evaluate_formulas",
      "expr_multi_step_signed",
    ],
    counting: [
      "count_to_100_tens",
      "count_to_100_ones",
      "count_on",
      "compare_within_10",
      "count_objects_within_20",
      "cardinality_within_10",
    ],
  };

  for (const [strand, keys] of Object.entries(coveredNodes)) {
    test(`${strand}: every committed node has at least one authored item`, () => {
      const missing = keys.filter((k) => !nodeKeys.has(k));
      expect(missing).toEqual([]);
    });
  }
});

describe("STRETCH_SEED_ITEMS — wave-3 fraction-arithmetic strand coverage", () => {
  const nodeKeys = new Set(STRETCH_SEED_ITEMS.map((it) => it.skillKey));

  // Every fraction-arithmetic node the wave-3 lane committed to authoring (the
  // operations strand plus the other fraction strands that were below the 50%
  // stretch bar). Drill-only shells with no genuine same-idea-deeper angle are
  // deliberately absent.
  const coveredNodes: Record<string, readonly string[]> = {
    operations: [
      "add_subtract_like",
      "add_subtract_mixed_like",
      "decompose_fraction",
      "multiply_fraction_by_whole",
      "divide_unit_fractions",
      "fraction_scaling",
      "divide_fractions",
    ],
    equivalence: [
      "common_denominators",
      "simplify_fractions",
      "equivalent_fractions_visual",
    ],
    comparison: [
      "compare_same_numerator",
      "compare_same_denominator",
      "compare_benchmarks",
      "order_fractions",
    ],
    concept: [
      "unit_fraction",
      "whole_as_fraction",
      "fraction_number_line",
      "mixed_improper",
      "fraction_as_parts",
      "partition_shapes",
    ],
    decimals: [
      "decimal_notation_fractions",
      "compare_decimals",
      "decimal_place_value_round",
      "add_subtract_decimals",
      "multiply_decimals",
      "divide_decimals",
    ],
  };

  for (const [strand, keys] of Object.entries(coveredNodes)) {
    test(`fraction-arithmetic/${strand}: every committed node has at least one authored item`, () => {
      const missing = keys.filter((k) => !nodeKeys.has(k));
      expect(missing).toEqual([]);
    });
  }
});

describe("STRETCH_SEED_ITEMS — wave-4 algebra-1 application lane coverage", () => {
  const items = STRETCH_SEED_ITEMS;
  const nodeKeys = new Set(items.map((it) => it.skillKey));

  // The algebra-1 application lane authored exactly one APPLICATION per accepted
  // node in the `linear-equations` and `linear-functions` strands. Coverage is
  // deliberately partial: 8 of the 20 scoped nodes returned REJECT-ALL because
  // no honest, non-headless application exists (a skipped node beats a costume).
  // The rejected nodes are asserted ABSENT so a future well-meaning "fill the
  // gap" pass has to reckon with the bar rather than ship pseudocontext.
  const acceptedNodes: readonly string[] = [
    "lin_ineq_multi_step",
    "lin_ineq_compound",
    "lin_eq_model_context",
    "fn_identify_function",
    "slope_two_points",
    "lin_fn_from_two_points",
    "lin_fn_standard_form",
    "lin_fn_interpret_context",
    "fn_compare_representations",
  ];
  const rejectedNodes: readonly string[] = [
    "lin_eq_combine_terms",
    "lin_eq_distribute",
    "lin_eq_clear_fractions",
    "lin_eq_justify_steps",
    "lin_eq_literal",
    "lin_eq_abs_value",
    "fn_notation_evaluate",
    "slope_from_graph",
    "slope_intercept_form",
    "lin_fn_point_slope",
    "lin_fn_parallel_perpendicular",
  ];

  test("every accepted algebra-1 application node has exactly one authored item", () => {
    for (const key of acceptedNodes) {
      const matches = items.filter((it) => it.skillKey === key);
      expect(matches).toHaveLength(1);
    }
  });

  test("deliberately-rejected nodes ship NO item (REJECT-ALL, not costume math)", () => {
    const present = rejectedNodes.filter((k) => nodeKeys.has(k));
    expect(present).toEqual([]);
  });

  test("every application item is graded (numeric answerType, never dialogue)", () => {
    for (const key of acceptedNodes) {
      const item = items.find((it) => it.skillKey === key);
      expect(item).toBeDefined();
      expect(["integer", "decimal", "fraction"]).toContain(item!.answerType);
    }
  });
});

describe("practiceSession — the 'Go deeper' stretch tail", () => {
  test("a stretch item never serves in the required set; it appears in the stretch tail for a demonstrated-fluent node", async () => {
    const t = convexTest(schema, modules);
    const scholar = await seedScholar(t);
    const asScholar = await asUser(t, scholar);
    await seedNode(t);
    await keepDomainOpen(t);
    const itemId = await seedStretchItem(t);
    // Demonstrated fluent AND due for review (old lastPracticedAt, short
    // half-life) so the skill is in the ordinary queue too.
    await seedMastery(t, scholar, { lastPracticedAt: Date.now() - 30 * DAY_MS, halfLifeDays: 1 });

    const res = await asScholar.query(api.practiceSkills.practiceSession, {
      scholarId: scholar,
      seed: 42,
      domain: DOMAIN,
    });
    const servedIds = (res.items as { itemId: string }[]).map((i) => i.itemId);
    expect(servedIds).not.toContain(`gen#${itemId}`);
    const stretch = res.stretch as { itemId: string; lane?: string; stem: string }[];
    expect(stretch.map((i) => i.itemId)).toContain(`gen#${itemId}`);
    expect(stretch[0].lane).toBe("stretch");
  });

  test("an unknown tier stays dark in both the ordinary rotation and the stretch tail", async () => {
    const t = convexTest(schema, modules);
    const scholar = await seedScholar(t);
    const asScholar = await asUser(t, scholar);
    await seedNode(t);
    const itemId = await t.run(async (ctx) =>
      ctx.db.insert("practiceItems", {
        skillKey: SKILL_KEY,
        domain: DOMAIN,
        stem: "A future application problem.",
        answerType: "integer",
        answerCanonical: "42",
        verifierKind: "arithmetic",
        tier: "application",
        source: "authored",
        verifiedAt: Date.now(),
      }),
    );
    await seedMastery(t, scholar, {
      lastPracticedAt: Date.now() - 30 * DAY_MS,
      halfLifeDays: 1,
    });

    const res = await asScholar.query(api.practiceSkills.practiceSession, {
      scholarId: scholar,
      seed: 42,
      domain: DOMAIN,
    });
    const itemRef = `gen#${itemId}`;
    // This ordinary-rotation assertion fails against the old `tier != stretch`
    // denylist: the unknown-tier row becomes this untemplated skill's only item.
    expect((res.items as { itemId: string }[]).map((item) => item.itemId)).not.toContain(itemRef);
    expect((res.stretch as { itemId: string }[]).map((item) => item.itemId)).not.toContain(itemRef);
  });

  test("provisional fluency (inferred source) is NOT offered a stretch item", async () => {
    const t = convexTest(schema, modules);
    const scholar = await seedScholar(t);
    const asScholar = await asUser(t, scholar);
    await seedNode(t);
    await seedStretchItem(t);
    await seedMastery(t, scholar, { source: "placement" });

    const res = await asScholar.query(api.practiceSkills.practiceSession, {
      scholarId: scholar,
      seed: 42,
      domain: DOMAIN,
    });
    expect(res.stretch).toEqual([]);
  });

  test("application evidence blocks application re-offer but not the stretch facet", async () => {
    const t = convexTest(schema, modules);
    const scholar = await seedScholar(t);
    const asScholar = await asUser(t, scholar);
    await seedNode(t);
    await keepDomainOpen(t);
    const insightItemId = await seedStretchItem(t);
    const applicationItemId = await seedStretchItem(t, {
      stem: "An application with the same answer: 50 + 4?",
      storyToKey: "application world",
    });
    await seedMastery(t, scholar);
    await t.run(async (ctx) => {
      await ctx.db.insert("masteryObservations", {
        scholarId: scholar,
        conceptLabel: `Label for ${SKILL_KEY}`,
        domain: DOMAIN,
        nodeKey: SKILL_KEY,
        observedAt: Date.now(),
        transcriptExcerpt: "prior application solve",
        masteryLevel: 4,
        confidenceScore: 0.85,
        evidenceSummary: "prior",
        evidenceType: APPLICATION_EVIDENCE_TYPE,
        attemptContext: "practice",
        studentInitiated: true,
        isSuperseded: false,
      });
    });

    const res = await asScholar.query(api.practiceSkills.practiceSession, {
      scholarId: scholar,
      seed: 42,
      domain: DOMAIN,
    });
    const served = (res.stretch as { itemId: string }[]).map((item) => item.itemId);
    expect(served).toContain(`gen#${insightItemId}`);
    expect(served).not.toContain(`gen#${applicationItemId}`);
  });

  test("stretch evidence blocks insight re-offer but not the application facet", async () => {
    const t = convexTest(schema, modules);
    const scholar = await seedScholar(t);
    const asScholar = await asUser(t, scholar);
    await seedNode(t);
    await keepDomainOpen(t);
    const insightItemId = await seedStretchItem(t);
    const applicationItemId = await seedStretchItem(t, {
      stem: "An application with the same answer: 50 + 4?",
      storyToKey: "application world",
    });
    await seedMastery(t, scholar);
    await t.run(async (ctx) => {
      await ctx.db.insert("masteryObservations", {
        scholarId: scholar,
        conceptLabel: `Label for ${SKILL_KEY}`,
        domain: DOMAIN,
        nodeKey: SKILL_KEY,
        observedAt: Date.now(),
        transcriptExcerpt: "prior stretch solve",
        masteryLevel: 4,
        confidenceScore: 0.85,
        evidenceSummary: "prior",
        evidenceType: STRETCH_EVIDENCE_TYPE,
        attemptContext: "practice",
        studentInitiated: true,
        isSuperseded: false,
      });
    });

    const res = await asScholar.query(api.practiceSkills.practiceSession, {
      scholarId: scholar,
      seed: 42,
      domain: DOMAIN,
    });
    const served = (res.stretch as { itemId: string }[]).map((item) => item.itemId);
    expect(served).not.toContain(`gen#${insightItemId}`);
    expect(served).toContain(`gen#${applicationItemId}`);
  });

  test("a story-linked application serves in the Go-deeper tail, framed by its hook and nothing else", async () => {
    // The application is NOT offered as its own card at the close (see
    // review/done-screen-options.html option E) — it reaches the scholar
    // through the ordinary Go-deeper tail, carrying the story hook as a frame.
    // This pins that path, and that ONLY the hook crosses the wire.
    const t = convexTest(schema, modules);
    const scholar = await seedScholar(t);
    const asScholar = await asUser(t, scholar);
    await seedNode(t);
    await keepDomainOpen(t);
    const linkedItemId = await seedStretchItem(t, {
      stem: "The linked application: 50 + 4?",
      storyToKey: "application world",
    });
    await seedMastery(t, scholar);
    await t.run(async (ctx) => {
      await ctx.db.insert("knowledgeNodeEdges", {
        fromKey: SKILL_KEY,
        toKey: "application world",
        domain: "sky",
        kind: "bridge",
        method: "curated",
        story: {
          kind: "applies",
          hook: "The linked story hook",
          narrative: "Server-only story narrative",
          source: "SECRET_STORY_SOURCE",
          provenance: "registry",
        },
      });
    });

    const res = await asScholar.query(api.practiceSkills.practiceSession, {
      scholarId: scholar,
      seed: 42,
      domain: DOMAIN,
    });

    expect(res.stretch.map((item) => item.itemId)).toContain(
      `gen#${linkedItemId}`,
    );
    const served = res.stretch.find(
      (item) => item.itemId === `gen#${linkedItemId}`,
    )!;
    expect(served).toMatchObject({
      lane: "stretch",
      storyHook: "The linked story hook",
    });
    // Hook only — the narrative and source stay server-side.
    expect(JSON.stringify(res.stretch)).not.toContain(
      "Server-only story narrative",
    );
    expect(JSON.stringify(res.stretch)).not.toContain("SECRET_STORY_SOURCE");
  });

  test("a node already carrying a stretch_success is not re-offered", async () => {
    const t = convexTest(schema, modules);
    const scholar = await seedScholar(t);
    const asScholar = await asUser(t, scholar);
    await seedNode(t);
    await seedStretchItem(t);
    await seedMastery(t, scholar);
    await t.run(async (ctx) => {
      await ctx.db.insert("masteryObservations", {
        scholarId: scholar,
        conceptLabel: `Label for ${SKILL_KEY}`,
        domain: DOMAIN,
        nodeKey: SKILL_KEY,
        observedAt: Date.now(),
        transcriptExcerpt: "prior stretch solve",
        masteryLevel: 4,
        confidenceScore: 0.85,
        evidenceSummary: "prior",
        evidenceType: STRETCH_EVIDENCE_TYPE,
        attemptContext: "practice",
        studentInitiated: true,
        isSuperseded: false,
      });
    });

    const res = await asScholar.query(api.practiceSkills.practiceSession, {
      scholarId: scholar,
      seed: 42,
      domain: DOMAIN,
    });
    expect(res.stretch).toEqual([]);
  });
});

describe("item-pool curation — the insight-technique gate", () => {
  test("starring an item into the stretch pool without naming its technique is rejected", async () => {
    const t = convexTest(schema, modules);
    const teacher = await t.run(async (ctx) =>
      ctx.db.insert("users", { name: "T", username: "stretch-teacher", role: "teacher" }),
    );
    const asTeacher = await asUser(t, teacher);
    await seedNode(t);

    await expect(
      asTeacher.mutation(api.practiceItemPool.createItem, {
        nodeKey: SKILL_KEY,
        stem: "What is 999999 × 8?", // harder-by-bigger-numbers — not a stretch item
        answerType: "integer",
        answer: "7999992",
        tier: "stretch",
      }),
    ).rejects.toThrow(/insight technique/);

    // Naming the idea makes it legitimate.
    const created = await asTeacher.mutation(api.practiceItemPool.createItem, {
      nodeKey: SKILL_KEY,
      stem: "Two one-digit numbers sum to 15 and their product ends in 4. The product?",
      answerType: "integer",
      answer: "54",
      tier: "stretch",
      technique: "casework",
      bloomLevel: 4,
    });
    expect(created.kind).toBe("word");

    // Re-tiering an already-tagged item keeps working (existing technique counts).
    await asTeacher.mutation(api.practiceItemPool.updateItem, {
      id: created.id,
      tier: "core",
    });
    await asTeacher.mutation(api.practiceItemPool.updateItem, {
      id: created.id,
      tier: "stretch",
    });
  });
});

describe("submitAnswer — stretch grading rules", () => {
  test("a stored multiple-choice application serves choices and grades by zero-based choice index", async () => {
    const t = convexTest(schema, modules);
    const scholar = await seedScholar(t);
    const asScholar = await asUser(t, scholar);
    await seedNode(t);
    await keepDomainOpen(t);
    const itemId = await seedStretchItem(t, {
      stem: "Who has the higher combined average?",
      answerType: "multipleChoice",
      answerCanonical: "1",
      choices: ["Justice", "Jeter", "Exactly tied"],
      storyToKey: "simpson's paradox",
    });
    await seedMastery(t, scholar);

    const session = await asScholar.query(api.practiceSkills.practiceSession, {
      scholarId: scholar,
      seed: 42,
      domain: DOMAIN,
    });
    const served = (session.stretch as { itemId: string; choices?: string[] }[]).find(
      (item) => item.itemId === `gen#${itemId}`,
    );
    expect(served?.choices).toEqual(["Justice", "Jeter", "Exactly tied"]);

    const result = await asScholar.mutation(api.practiceSkills.submitAnswer, {
      scholarId: scholar,
      itemId: `gen#${itemId}`,
      answer: "1",
    });
    expect(result.correct).toBe(true);
  });

  test("an application frame carries only the linked story hook and a missing story never blocks serve", async () => {
    const t = convexTest(schema, modules);
    const scholar = await seedScholar(t);
    const asScholar = await asUser(t, scholar);
    await seedNode(t);
    await keepDomainOpen(t);
    const itemId = await seedStretchItem(t, {
      storyToKey: "application world",
    });
    await seedMastery(t, scholar);
    await t.run(async (ctx) => {
      await ctx.db.insert("knowledgeNodeEdges", {
        fromKey: SKILL_KEY,
        toKey: "application world",
        domain: "sky",
        kind: "bridge",
        method: "curated",
        story: {
          kind: "applies",
          hook: "A safe framing hook",
          narrative: "SECRET_NARRATIVE",
          source: "SECRET_SOURCE",
          provenance: "registry",
        },
      });
    });

    const framed = await asScholar.query(api.practiceSkills.practiceSession, {
      scholarId: scholar,
      seed: 42,
      domain: DOMAIN,
    });
    const served = (framed.stretch as { itemId: string; storyHook?: string }[]).find(
      (item) => item.itemId === `gen#${itemId}`,
    );
    expect(served?.storyHook).toBe("A safe framing hook");
    expect(JSON.stringify(served)).not.toContain("SECRET_NARRATIVE");
    expect(JSON.stringify(served)).not.toContain("SECRET_SOURCE");

    await t.run(async (ctx) => {
      const edge = await ctx.db
        .query("knowledgeNodeEdges")
        .withIndex("by_from", (q) => q.eq("fromKey", SKILL_KEY))
        .first();
      if (edge) await ctx.db.patch(edge._id, { story: undefined });
    });
    const unframed = await asScholar.query(api.practiceSkills.practiceSession, {
      scholarId: scholar,
      seed: 42,
      domain: DOMAIN,
    });
    expect(
      (unframed.stretch as { itemId: string; storyHook?: string }[]).find(
        (item) => item.itemId === `gen#${itemId}`,
      )?.storyHook,
    ).toBeUndefined();
  });

  test("a stretch MISS leaves the mastery row untouched and logs a lane-'stretch' attempt; no depth observation", async () => {
    const t = convexTest(schema, modules);
    const scholar = await seedScholar(t);
    const asScholar = await asUser(t, scholar);
    await seedNode(t);
    const itemId = await seedStretchItem(t);
    await seedMastery(t, scholar);
    const before = await readMastery(t, scholar);

    const res = await asScholar.mutation(api.practiceSkills.submitAnswer, {
      scholarId: scholar,
      itemId: `gen#${itemId}`,
      answer: "56",
    });
    expect(res.correct).toBe(false);

    const after = await readMastery(t, scholar);
    expect(after).toEqual(before);

    const attempts = await readAttempts(t);
    expect(attempts).toHaveLength(1);
    expect(attempts[0].lane).toBe("stretch");
    expect(attempts[0].correct).toBe(false);

    expect(await readObservations(t)).toHaveLength(0);
  });

  test("an honest don't-know on a stretch item is also penalty-free", async () => {
    const t = convexTest(schema, modules);
    const scholar = await seedScholar(t);
    const asScholar = await asUser(t, scholar);
    await seedNode(t);
    const itemId = await seedStretchItem(t);
    await seedMastery(t, scholar);
    const before = await readMastery(t, scholar);

    const res = await asScholar.mutation(api.practiceSkills.submitAnswer, {
      scholarId: scholar,
      itemId: `gen#${itemId}`,
      answer: "",
      dontKnow: true,
    });
    expect(res.correct).toBe(false);

    const after = await readMastery(t, scholar);
    expect(after).toEqual(before);
  });

  test("abandoning a served stretch item leaves the entire mastery row untouched", async () => {
    const t = convexTest(schema, modules);
    const scholar = await seedScholar(t);
    const asScholar = await asUser(t, scholar);
    await seedNode(t);
    await keepDomainOpen(t);
    const itemId = await seedStretchItem(t);
    await seedMastery(t, scholar);
    const before = await readMastery(t, scholar);

    const session = await asScholar.query(api.practiceSkills.practiceSession, {
      scholarId: scholar,
      seed: 42,
      domain: DOMAIN,
    });
    expect((session.stretch as { itemId: string }[]).map((item) => item.itemId)).toContain(
      `gen#${itemId}`,
    );

    // Abandonment is the absence of a grading POST after serve.
    expect(await readMastery(t, scholar)).toEqual(before);
    expect(await readAttempts(t)).toEqual([]);
    expect(await readObservations(t)).toEqual([]);
  });

  test("a stretch SUCCESS bumps the rep AND writes ONE depth observation at the item's Bloom level (deduped)", async () => {
    const t = convexTest(schema, modules);
    const scholar = await seedScholar(t);
    const asScholar = await asUser(t, scholar);
    await seedNode(t);
    const itemId = await seedStretchItem(t, { bloomLevel: 4 });
    await seedMastery(t, scholar, { repetition: 3 });

    const res = await asScholar.mutation(api.practiceSkills.submitAnswer, {
      scholarId: scholar,
      itemId: `gen#${itemId}`,
      answer: "54",
    });

    expect(res.correct).toBe(true);

    const after = await readMastery(t, scholar);
    expect(after?.repetition).toBe(4);
    expect(after?.source).toBe("practice");

    const obs = await readObservations(t);
    expect(obs).toHaveLength(1);
    expect(obs[0].evidenceType).toBe(STRETCH_EVIDENCE_TYPE);
    expect(obs[0].nodeKey).toBe(SKILL_KEY);
    expect(obs[0].masteryLevel).toBe(4);
    expect(obs[0].studentInitiated).toBe(true);
    expect(obs[0].sessionId).toBeUndefined();

    const attempts = await readAttempts(t);
    expect(attempts).toHaveLength(1);
    expect(attempts[0].lane).toBe("stretch");

    // A second stretch solve on the same node at the same level dedupes.
    const item2 = await seedStretchItem(t, {
      bloomLevel: 4,
      stem: "A second stretch item with the same answer: 50 + 4?",
    });
    const res2 = await asScholar.mutation(api.practiceSkills.submitAnswer, {
      scholarId: scholar,
      itemId: `gen#${item2}`,
      answer: "54",
    });
    expect(res2.correct).toBe(true);
    expect(await readObservations(t)).toHaveLength(1);
  });

  test("an application SUCCESS writes application_success instead of stretch_success", async () => {
    const t = convexTest(schema, modules);
    const scholar = await seedScholar(t);
    const asScholar = await asUser(t, scholar);
    await seedNode(t);
    const itemId = await seedStretchItem(t, {
      bloomLevel: 3,
      storyToKey: "application world",
    });
    await seedMastery(t, scholar);

    const result = await asScholar.mutation(api.practiceSkills.submitAnswer, {
      scholarId: scholar,
      itemId: `gen#${itemId}`,
      answer: "54",
    });
    expect(result.correct).toBe(true);

    const observations = await readObservations(t);
    expect(observations).toHaveLength(1);
    expect(observations[0].evidenceType).toBe(APPLICATION_EVIDENCE_TYPE);
    expect(observations[0].masteryLevel).toBe(3);
    expect(observations.some((row) => row.evidenceType === STRETCH_EVIDENCE_TYPE)).toBe(
      false,
    );

    const secondItemId = await seedStretchItem(t, {
      bloomLevel: 3,
      stem: "A second application with the same answer: 50 + 4?",
      storyToKey: "another application world",
    });
    await asScholar.mutation(api.practiceSkills.submitAnswer, {
      scholarId: scholar,
      itemId: `gen#${secondItemId}`,
      answer: "54",
    });
    expect(await readObservations(t)).toHaveLength(1);
  });

  test("a correct UNASSISTED retry (record:false) still earns the depth observation; mastery stays grade-only", async () => {
    const t = convexTest(schema, modules);
    const scholar = await seedScholar(t);
    const asScholar = await asUser(t, scholar);
    await seedNode(t);
    const itemId = await seedStretchItem(t, { bloomLevel: 4 });
    await seedMastery(t, scholar, { repetition: 3 });

    // First attempt: miss (recorded, penalty-free).
    await asScholar.mutation(api.practiceSkills.submitAnswer, {
      scholarId: scholar,
      itemId: `gen#${itemId}`,
      answer: "56",
    });
    const afterMiss = await readMastery(t, scholar);

    // Retry (record:false): correct — the answer was never revealed, so this
    // unassisted solve earns depth evidence, while mastery stays untouched.
    const res = await asScholar.mutation(api.practiceSkills.submitAnswer, {
      scholarId: scholar,
      itemId: `gen#${itemId}`,
      answer: "54",
      record: false,
    });
    expect(res.correct).toBe(true);

    const obs = await readObservations(t);
    expect(obs).toHaveLength(1);
    expect(obs[0].evidenceType).toBe(STRETCH_EVIDENCE_TYPE);
    expect(obs[0].masteryLevel).toBe(4);

    const after = await readMastery(t, scholar);
    expect(after).toEqual(afterMiss);
  });

  test("a HIGHER-Bloom stretch success on the same node adds a second (deeper) observation", async () => {
    const t = convexTest(schema, modules);
    const scholar = await seedScholar(t);
    const asScholar = await asUser(t, scholar);
    await seedNode(t);
    const low = await seedStretchItem(t, { bloomLevel: 3 });
    const high = await seedStretchItem(t, {
      bloomLevel: 5,
      stem: "A deeper one with the same answer: 60 - 6?",
    });
    await seedMastery(t, scholar);

    await asScholar.mutation(api.practiceSkills.submitAnswer, {
      scholarId: scholar,
      itemId: `gen#${low}`,
      answer: "54",
    });
    await asScholar.mutation(api.practiceSkills.submitAnswer, {
      scholarId: scholar,
      itemId: `gen#${high}`,
      answer: "54",
    });
    const obs = await readObservations(t);
    expect(obs).toHaveLength(2);
    expect(obs.map((o) => o.masteryLevel).sort()).toEqual([3, 5]);
  });
});
