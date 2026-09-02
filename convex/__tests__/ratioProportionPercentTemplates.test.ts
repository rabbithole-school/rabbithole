import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { formatAnswer } from "../lib/practice/answers";
import { classifyDomain } from "../lib/domainTaxonomy";
import { gradeTemplateItem, makeItemId } from "../lib/practice/session";
import { generateItem, hasTemplate, type PracticeItem } from "../lib/practice/templates";
import {
  RATIO_PROPORTION_PERCENT_DOMAIN,
  RATIO_PROPORTION_PERCENT_EDGES,
  RATIO_PROPORTION_PERCENT_SKILLS,
} from "../seed/ratioProportionPercentGraph";
import schema from "../schema";

const modules = (
  import.meta as ImportMeta & {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("../**/*.ts");

const SKILL_KEYS = RATIO_PROPORTION_PERCENT_SKILLS.map((skill) => skill.skillKey);

function requiredItem(skillKey: string, seed: number, form?: string): PracticeItem {
  const item = generateItem(skillKey, seed, form);
  expect(item, `${skillKey} seed=${seed} form=${form ?? "direct"}`).not.toBeNull();
  if (!item) throw new Error(`Missing ratio template: ${skillKey}`);
  return item;
}

function graderSubmission(item: PracticeItem): string {
  return item.answer.type === "multipleChoice"
    ? String(item.answer.choiceIndex)
    : formatAnswer(item.answer);
}

describe("ratio-proportion-percent deterministic templates", () => {
  test("the authoritative graph is registered without advisory metadata", () => {
    expect(RATIO_PROPORTION_PERCENT_DOMAIN).toBe("ratio-proportion-percent");
    expect(RATIO_PROPORTION_PERCENT_SKILLS).toHaveLength(39);
    expect(RATIO_PROPORTION_PERCENT_EDGES).toHaveLength(68);
    expect(new Set(SKILL_KEYS).size).toBe(39);
    expect(classifyDomain(RATIO_PROPORTION_PERCENT_DOMAIN, "percent")).toEqual({
      domain: RATIO_PROPORTION_PERCENT_DOMAIN,
      strand: "percent",
    });
  });

  test("every ratio, rate, percent, and proportion node has a template", () => {
    for (const skillKey of SKILL_KEYS) {
      expect(hasTemplate(skillKey), skillKey).toBe(true);
    }
  });

  test("generateItem is deterministic for every skill and seed", () => {
    for (const skillKey of SKILL_KEYS) {
      for (let seed = 1; seed <= 30; seed++) {
        expect(generateItem(skillKey, seed), `${skillKey} seed=${seed}`).toEqual(
          generateItem(skillKey, seed),
        );
      }
    }
  });

  test("every generated answer round-trips through its own grader", () => {
    for (const skillKey of SKILL_KEYS) {
      for (let seed = 1; seed <= 30; seed++) {
        const item = requiredItem(skillKey, seed);
        const result = gradeTemplateItem(makeItemId(skillKey, seed), graderSubmission(item));
        expect(result, `${skillKey} seed=${seed}`).not.toBeNull();
        expect(result?.correct, `${skillKey} seed=${seed}: ${item.stem}`).toBe(true);
      }
    }
  });

  test("multiple-choice items always offer 3 or 4 unique, gradeable choices", () => {
    let multipleChoiceItems = 0;
    for (const skillKey of SKILL_KEYS) {
      for (let seed = 1; seed <= 30; seed++) {
        const item = requiredItem(skillKey, seed);
        if (item.answerType !== "multipleChoice") continue;
        multipleChoiceItems++;
        expect(item.choices?.length, `${skillKey} seed=${seed}`).toBeGreaterThanOrEqual(3);
        expect(item.choices?.length, `${skillKey} seed=${seed}`).toBeLessThanOrEqual(4);
        expect(new Set(item.choices).size, `${skillKey} seed=${seed}`).toBe(item.choices?.length);
        expect(item.answer.type, `${skillKey} seed=${seed}`).toBe("multipleChoice");
        if (item.answer.type === "multipleChoice") {
          expect(item.answer.choiceIndex).toBeGreaterThanOrEqual(0);
          expect(item.answer.choiceIndex).toBeLessThan(item.choices?.length ?? 0);
        }
      }
    }
    expect(multipleChoiceItems).toBeGreaterThan(0);
  });

  test("all generated prompt visuals pass the persisted schema validator", async () => {
    const t = convexTest(schema, modules);
    const kinds = new Set<string>();
    let inserted = 0;
    await t.run(async (ctx) => {
      for (const skillKey of SKILL_KEYS) {
        for (let seed = 1; seed <= 5; seed++) {
          const item = requiredItem(skillKey, seed);
          if (!item.promptVisual) continue;
          kinds.add(item.promptVisual.kind);
          await ctx.db.insert("practiceItems", {
            skillKey,
            domain: RATIO_PROPORTION_PERCENT_DOMAIN,
            stem: item.stem,
            answerType: item.answerType,
            answerCanonical: formatAnswer(item.answer),
            promptVisual: item.promptVisual,
            source: "template-test",
            verifiedAt: seed,
          });
          inserted++;
        }
      }
    });

    expect(inserted).toBeGreaterThan(0);
    expect([...kinds].sort()).toEqual(["areamodel", "array", "coordinatePlane"]);
  });

  test("proportional graph visuals preserve the exact relationship being assessed", () => {
    for (const skillKey of [
      "prop_plot_equivalent_pairs",
      "prop_constant_graph",
      "prop_interpret_point",
      "prop_interpret_unit_point",
      "prop_match_representations",
    ]) {
      for (let seed = 1; seed <= 20; seed++) {
        const item = requiredItem(skillKey, seed);
        expect(item.promptVisual?.kind, `${skillKey} seed=${seed}`).toBe("coordinatePlane");
        if (item.promptVisual?.kind !== "coordinatePlane") throw new Error("wrong visual");
        for (const point of item.promptVisual.points) {
          expect(point.x).toBeGreaterThanOrEqual(item.promptVisual.xMin);
          expect(point.x).toBeLessThanOrEqual(item.promptVisual.xMax);
          expect(point.y).toBeGreaterThanOrEqual(item.promptVisual.yMin);
          expect(point.y).toBeLessThanOrEqual(item.promptVisual.yMax);
        }
      }
    }
  });

  test("supported binary relationships use the existing missing-operand form", () => {
    const binarySkills = [
      "ratio_equivalent_scale",
      "ratio_table_complete",
      "ratio_double_number_line",
      "rate_constant_speed",
      "rate_measurement_conversion",
      "percent_of_quantity",
      "percent_find_whole",
      "percent_increase",
      "percent_decrease",
      "prop_table_from_rule",
      "prop_missing_value",
    ];
    for (const skillKey of binarySkills) {
      for (let seed = 1; seed <= 10; seed++) {
        const item = requiredItem(skillKey, seed, "missing");
        expect(item.form, `${skillKey} seed=${seed}`).toBe("missing");
        expect(
          gradeTemplateItem(makeItemId(skillKey, seed, "missing"), graderSubmission(item))
            ?.correct,
          `${skillKey} seed=${seed}: ${item.stem}`,
        ).toBe(true);
      }
    }
  });
});
