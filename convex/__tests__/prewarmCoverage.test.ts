import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "../schema";
import { api, internal } from "../_generated/api";
import { hasTemplate } from "../lib/practice/templates";
import { PRE_WARMED_CONCEPTUAL } from "../lib/practice/coverage";

const modules = (import.meta as ImportMeta & { glob: (p: string) => Record<string, () => Promise<unknown>> }).glob(
  "../**/*.ts",
);

/**
 * A3/A4 coverage guard (raise-the-ceiling §3): PRE_WARMED_CONCEPTUAL is the
 * exact allowlist of genuinely-conceptual nodes that get verified-LLM items
 * instead of a template. This test does NOT call the pre-warm action itself
 * (that hits the model) — it only asserts the allowlist is well-formed:
 * every key is a real seeded node, and none of them is templated (a template
 * appearing for one of these keys means it should be removed from the set).
 */
describe("practiceGen — pre-warm coverage allowlist", () => {
  test("every PRE_WARMED_CONCEPTUAL key is a real node in the seeded graph", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.practiceSkills.seedGraph, {});
    // PRE_WARMED_CONCEPTUAL spans every practice domain, so gather keys from all
    // of them, not just the default domain.
    const wna = await t.query(api.practiceSkills.getDomain, {});
    const fractions = await t.query(api.practiceSkills.getDomain, { domain: "fraction-arithmetic" });
    const probability = await t.query(api.practiceSkills.getDomain, { domain: "probability" });
    const geometry = await t.query(api.practiceSkills.getDomain, { domain: "geometry-measurement" });
    const ratios = await t.query(api.practiceSkills.getDomain, { domain: "ratio-proportion-percent" });
    const integers = await t.query(api.practiceSkills.getDomain, { domain: "integers-coordinates" });
    const algebra = await t.query(api.practiceSkills.getDomain, { domain: "early-algebra" });
    const algebra1 = await t.query(api.practiceSkills.getDomain, { domain: "algebra-1" });
    const nodeKeys = new Set(
      [...wna.skills, ...fractions.skills, ...probability.skills, ...geometry.skills, ...ratios.skills, ...integers.skills, ...algebra.skills, ...algebra1.skills].map(
        (s) => s.skillKey,
      ),
    );

    expect(PRE_WARMED_CONCEPTUAL.size).toBeGreaterThan(0);
    for (const key of PRE_WARMED_CONCEPTUAL) {
      expect(nodeKeys.has(key), `${key} is not a seeded knowledge node`).toBe(true);
    }
  });

  test("every PRE_WARMED_CONCEPTUAL key is currently untemplated", () => {
    for (const key of PRE_WARMED_CONCEPTUAL) {
      expect(hasTemplate(key), `${key} now has a template — it should leave PRE_WARMED_CONCEPTUAL`).toBe(false);
    }
  });
});
