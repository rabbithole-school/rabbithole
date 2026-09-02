import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "../schema";
import { api, internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import {
  PRACTICE_DOMAINS,
  practiceDomainLabel,
  practiceDomainInfo,
  resolvePracticeDomainSlug,
} from "../lib/practice/domains";
import { REGISTERED_PRACTICE_DOMAINS } from "../knowledgeNodes";
import {
  PRACTICE_PREREQ_CONCEPTS,
  strandHeadline,
  strandHeadlineFor,
} from "../../shared/practiceDomainLabels";

const modules = (import.meta as ImportMeta & { glob: (p: string) => Record<string, () => Promise<unknown>> }).glob("../**/*.ts");

async function seedUser(t: ReturnType<typeof convexTest>, username = "domuser") {
  return await t.run(async (ctx) =>
    ctx.db.insert("users", { name: "Domain User", username, role: "scholar" }),
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

describe("practice domains — display registry", () => {
  test("PRACTICE_DOMAINS stays in lock-step with the registered practice graphs", () => {
    const registrySlugs = PRACTICE_DOMAINS.map((d) => d.domain).sort();
    const graphSlugs = [...REGISTERED_PRACTICE_DOMAINS].sort();
    // A graph without a label (or a label without a graph) is a drift bug: the
    // teacher picker would offer an empty/phantom domain, or hide a real one.
    expect(registrySlugs).toEqual(graphSlugs);
  });

  test("every registered domain has a non-empty label and discipline", () => {
    for (const d of PRACTICE_DOMAINS) {
      expect(d.label.trim().length).toBeGreaterThan(0);
      expect(d.discipline.trim().length).toBeGreaterThan(0);
    }
    // No duplicate slugs.
    const slugs = PRACTICE_DOMAINS.map((d) => d.domain);
    expect(new Set(slugs).size).toBe(slugs.length);
  });

  test("helpers resolve known slugs and fall back for unknown ones", () => {
    const known = PRACTICE_DOMAINS[0];
    expect(practiceDomainLabel(known.domain)).toBe(known.label);
    expect(practiceDomainInfo(known.domain)).toEqual(known);
    // Unknown slug → label falls back to the slug, info is undefined.
    expect(practiceDomainLabel("no-such-domain")).toBe("no-such-domain");
    expect(practiceDomainInfo("no-such-domain")).toBeUndefined();
  });

  test("statistics, integers, and early-algebra strands have curated kid-facing headlines", () => {
    expect(strandHeadline("data-displays")).toBe("Reading Data Displays");
    expect(strandHeadline("center-spread")).toBe("Averages & Spread");
    expect(strandHeadline("negatives-absvalue")).toBe("Negatives & Absolute Value");
    expect(strandHeadline("integer-operations")).toBe("Integer Operations");
    expect(strandHeadline("number-theory")).toBe("Factors & Multiples");
    expect(strandHeadline("rational-ordering")).toBe("Ordering Signed Numbers");
    expect(strandHeadline("expressions-variables")).toBe("Expressions & Variables");
    expect(strandHeadline("equations-1-2-step")).toBe("Solving Equations");
    expect(strandHeadline("patterns-sequences")).toBe("Patterns & Sequences");
    expect(strandHeadline("inequalities")).toBe("Solving Inequalities");
    expect(strandHeadline("decimals")).toBe("Decimals");
    expect(strandHeadline("linear-equations")).toBe("Linear Equations & Inequalities");
    expect(strandHeadline("linear-functions")).toBe("Linear Functions");
    expect(strandHeadline("systems")).toBe("Systems of Equations");
    expect(strandHeadline("exponents-exponential")).toBe("Exponents & Exponential Growth");
    expect(strandHeadline("polynomials-factoring")).toBe("Polynomials & Factoring");
    expect(strandHeadline("quadratics")).toBe("Quadratics");
  });

  test("pins the approved global strand headlines", () => {
    expect(strandHeadline("compound")).toBe("Probability of Two Events");
    expect(strandHeadline("coordinate-geometry")).toBe("Grids & Coordinates");
    expect(strandHeadline("proportional-reasoning")).toBe("Scaling & Proportions");
    expect(strandHeadline("graph-theory")).toBe("Networks & Paths");
  });

  test("resolves shared strands by domain, with global fallback", () => {
    expect(strandHeadlineFor("whole-number-arithmetic", "counting")).toBe("Counting");
    expect(strandHeadlineFor("whole-number-arithmetic", "number-theory")).toBe(
      "Factors & Multiples",
    );
    expect(strandHeadlineFor("discrete-math", "counting")).toBe("Combinatorics");
    expect(strandHeadlineFor("discrete-math", "number-theory")).toBe(
      "Odds, Evens & Remainders",
    );
    expect(strandHeadlineFor("discrete-math", "logic")).toBe("Logic & Deduction");
  });

  test("every integers, early-algebra, and Algebra 1 foreign prerequisite has a specific concept label", () => {
    expect(PRACTICE_PREREQ_CONCEPTS).toMatchObject({
      order_of_operations: "order of operations",
      long_division_2digit_divisor: "long division",
      fraction_number_line: "fractions on a number line",
      order_fractions: "ordering fractions",
      add_subtract_unlike: "adding and subtracting fractions",
      multiply_fractions: "fraction multiplication",
      divide_fractions: "dividing fractions",
      four_quadrant_plane: "the coordinate plane",
      fraction_as_parts: "fractions",
      mult_distributive: "the distributive property",
      exponents_repeated_mult: "whole-number exponents",
      integer_expressions: "signed-number expressions",
      add_subtract_integers: "integer addition and subtraction",
      divide_integers: "integer division",
      prop_table_from_rule: "proportional input-output tables",
      prop_constant_graph: "rates on proportional graphs",
      // Decimals-strand foreign prerequisites (#881/#888 follow-up):
      place_value_relationships: "place value",
      round_multidigit: "rounding",
      add_multidigit_algorithm: "multi-digit addition",
      subtract_multidigit_algorithm: "multi-digit subtraction",
      long_division_1digit_divisor: "long division",
      decimal_notation_fractions: "decimal notation",
      add_subtract_decimals: "adding and subtracting decimals",
      multiply_decimals: "decimal multiplication",
      eq_both_sides: "equations with the variable on both sides",
      eq_parentheses: "equations with parentheses",
      ineq_two_step: "two-step inequalities",
      eq_identity_contradiction: "equations with no or many solutions",
      pattern_graph_rate_change: "rate of change on a graph",
      pattern_linear_table_rule: "linear table rules",
      multiply_integers: "integer multiplication",
      percent_change: "percent change",
      absolute_value_distance_zero: "absolute value",
      prop_write_equation: "proportional equations",
    });
  });
});

describe("resolvePracticeDomainSlug — URL/alias → registered slug", () => {
  const REGISTERED = new Set(PRACTICE_DOMAINS.map((d) => d.domain));

  test("exact registered slugs pass through unchanged", () => {
    for (const d of PRACTICE_DOMAINS) {
      expect(resolvePracticeDomainSlug(d.domain)).toBe(d.domain);
    }
  });

  test("natural aliases map to the right registered slug", () => {
    expect(resolvePracticeDomainSlug("fractions")).toBe("fraction-arithmetic");
    expect(resolvePracticeDomainSlug("fraction")).toBe("fraction-arithmetic");
    expect(resolvePracticeDomainSlug("probability")).toBe("probability");
    expect(resolvePracticeDomainSlug("chance")).toBe("probability");
    expect(resolvePracticeDomainSlug("geometry")).toBe("geometry-measurement");
    expect(resolvePracticeDomainSlug("measurement")).toBe("geometry-measurement");
    expect(resolvePracticeDomainSlug("geometry measurement")).toBe("geometry-measurement");
    expect(resolvePracticeDomainSlug("ratio")).toBe("ratio-proportion-percent");
    expect(resolvePracticeDomainSlug("ratios")).toBe("ratio-proportion-percent");
    expect(resolvePracticeDomainSlug("percent")).toBe("ratio-proportion-percent");
    expect(resolvePracticeDomainSlug("proportions")).toBe("ratio-proportion-percent");
    expect(resolvePracticeDomainSlug("integers")).toBe("integers-coordinates");
    expect(resolvePracticeDomainSlug("negative numbers")).toBe("integers-coordinates");
    expect(resolvePracticeDomainSlug("negatives")).toBe("integers-coordinates");
    expect(resolvePracticeDomainSlug("algebra")).toBe("early-algebra");
    expect(resolvePracticeDomainSlug("equations")).toBe("early-algebra");
    expect(resolvePracticeDomainSlug("patterns")).toBe("early-algebra");
    expect(resolvePracticeDomainSlug("algebra-1")).toBe("algebra-1");
    expect(resolvePracticeDomainSlug("algebra1")).toBe("algebra-1");
    expect(resolvePracticeDomainSlug("algebra-one")).toBe("algebra-1");
    expect(resolvePracticeDomainSlug("quadratics")).toBe("algebra-1");
    expect(resolvePracticeDomainSlug("whole number")).toBe("whole-number-arithmetic");
    expect(resolvePracticeDomainSlug("whole-number")).toBe("whole-number-arithmetic");
    expect(resolvePracticeDomainSlug("arithmetic")).toBe("whole-number-arithmetic");
  });

  test("is case / space / hyphen / underscore insensitive", () => {
    expect(resolvePracticeDomainSlug("FRACTIONS")).toBe("fraction-arithmetic");
    expect(resolvePracticeDomainSlug("  Fractions  ")).toBe("fraction-arithmetic");
    expect(resolvePracticeDomainSlug("Fraction-Arithmetic")).toBe("fraction-arithmetic");
    expect(resolvePracticeDomainSlug("fraction_arithmetic")).toBe("fraction-arithmetic");
    expect(resolvePracticeDomainSlug("Whole   Number")).toBe("whole-number-arithmetic");
    expect(resolvePracticeDomainSlug("whole_number")).toBe("whole-number-arithmetic");
    expect(resolvePracticeDomainSlug("Probability")).toBe("probability");
    expect(resolvePracticeDomainSlug("Geometry_Measurement")).toBe("geometry-measurement");
    expect(resolvePracticeDomainSlug("Ratio_Proportion_Percent")).toBe("ratio-proportion-percent");
    expect(resolvePracticeDomainSlug("Integers Coordinates")).toBe("integers-coordinates");
    expect(resolvePracticeDomainSlug("NEGATIVE_NUMBERS")).toBe("integers-coordinates");
    expect(resolvePracticeDomainSlug("Early Algebra")).toBe("early-algebra");
    expect(resolvePracticeDomainSlug("EQUATIONS")).toBe("early-algebra");
    expect(resolvePracticeDomainSlug("Algebra 1")).toBe("algebra-1");
    expect(resolvePracticeDomainSlug("ALGEBRA_ONE")).toBe("algebra-1");
  });

  test("unknown / empty / nullish input resolves to null (never a default)", () => {
    // The load-bearing guard: an unknown domain must NOT silently become
    // whole-number arithmetic (which would restart placement) — it resolves to
    // null so the caller falls to the scholar's normal auto-blend.
    expect(resolvePracticeDomainSlug("geometry")).toBe("geometry-measurement");
    expect(resolvePracticeDomainSlug("not-a-domain")).toBeNull();
    expect(resolvePracticeDomainSlug("")).toBeNull();
    expect(resolvePracticeDomainSlug("   ")).toBeNull();
    expect(resolvePracticeDomainSlug(null)).toBeNull();
    expect(resolvePracticeDomainSlug(undefined)).toBeNull();
  });

  test("every non-null result — and every alias target — is a registered slug", () => {
    for (const input of [
      "fractions",
      "fraction",
      "chance",
      "geometry",
      "measurement",
      "geometry measurement",
      "ratio",
      "ratios",
      "percent",
      "proportions",
      "integers",
      "negative numbers",
      "negatives",
      "algebra",
      "equations",
      "patterns",
      "arithmetic",
      "whole number",
      ...PRACTICE_DOMAINS.map((d) => d.domain),
    ]) {
      const resolved = resolvePracticeDomainSlug(input);
      expect(resolved).not.toBeNull();
      expect(REGISTERED.has(resolved as string)).toBe(true);
    }
  });
});

describe("standingPractice.listDomains", () => {
  test("returns every seeded registered domain, in registry order", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.practiceSkills.seedGraph, {});
    const user = await seedUser(t);
    const domains = await (await asUser(t, user)).query(api.standingPractice.listDomains, {});

    // seedGraph loads all registered graphs → all appear, in registry order.
    expect(domains.map((d) => d.domain)).toEqual(PRACTICE_DOMAINS.map((d) => d.domain));
    for (const d of domains) {
      expect(d.label.length).toBeGreaterThan(0);
      expect(d.discipline.length).toBeGreaterThan(0);
    }
  });

  test("filters out registered domains with no seeded nodes (empty deployment → [])", async () => {
    const t = convexTest(schema, modules);
    const user = await seedUser(t);
    const domains = await (await asUser(t, user)).query(api.standingPractice.listDomains, {});
    // Nothing seeded → the picker offers nothing (never an empty domain).
    expect(domains).toEqual([]);
  });
});

describe("standingPractice.domainStrandCounts", () => {
  test("returns a positive strand count for every seeded domain", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.practiceSkills.seedGraph, {});
    const teacher = await t.run(async (ctx) =>
      ctx.db.insert("users", { name: "T", username: "count-teacher", role: "teacher" }),
    );
    const counts = await (await asUser(t, teacher)).query(
      api.standingPractice.domainStrandCounts,
      {},
    );
    // Every domain the picker lists should carry a "N strands" meta ≥ 1, and
    // it must equal the distinct-strand tally the rail would compute.
    const listed = await (await asUser(t, teacher)).query(
      api.standingPractice.listDomains,
      {},
    );
    for (const d of listed) {
      expect(counts[d.domain]).toBeGreaterThan(0);
      const strands = await (await asUser(t, teacher)).query(
        api.standingPractice.domainStrands,
        { domain: d.domain },
      );
      expect(counts[d.domain]).toBe(strands.strands.length);
    }
  });

  test("empty deployment → no counts", async () => {
    const t = convexTest(schema, modules);
    const teacher = await t.run(async (ctx) =>
      ctx.db.insert("users", { name: "T", username: "count-teacher-2", role: "teacher" }),
    );
    const counts = await (await asUser(t, teacher)).query(
      api.standingPractice.domainStrandCounts,
      {},
    );
    expect(counts).toEqual({});
  });
});
