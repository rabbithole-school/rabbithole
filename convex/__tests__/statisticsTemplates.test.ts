import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import {
  linePlotGeometry,
  pictographGeometry,
} from "../../shared/practicePromptVisual";
import { formatAnswer } from "../lib/practice/answers";
import { gradeTemplateItem, makeItemId } from "../lib/practice/session";
import { generateItem, hasTemplate, type PracticeItem } from "../lib/practice/templates";
import {
  PROBABILITY_DOMAIN,
  PROBABILITY_EDGES,
  PROBABILITY_SKILLS,
} from "../seed/probabilityGraph";
import schema from "../schema";

const modules = (
  import.meta as ImportMeta & {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("../**/*.ts");

const STATISTICS_SKILLS = PROBABILITY_SKILLS.filter(
  (skill) =>
    skill.strand === "data-displays"
    || skill.strand === "center-spread"
    || skill.strand === "sampling-inference",
);
const STATISTICS_KEYS = STATISTICS_SKILLS.map((skill) => skill.skillKey);
const SAMPLING_INFERENCE_KEYS = STATISTICS_SKILLS
  .filter((skill) => skill.strand === "sampling-inference")
  .map((skill) => skill.skillKey);

function requiredItem(skillKey: string, seed: number): PracticeItem {
  const item = generateItem(skillKey, seed);
  expect(item, `${skillKey} seed=${seed}`).not.toBeNull();
  if (!item) throw new Error(`Missing statistics template: ${skillKey}`);
  return item;
}

function numericAnswer(item: PracticeItem): number {
  if (item.answer.type !== "integer" && item.answer.type !== "decimal") {
    throw new Error(`${item.skillKey} does not have a numeric answer`);
  }
  return item.answer.value;
}

function graderSubmission(item: PracticeItem): string {
  return item.answer.type === "multipleChoice"
    ? String(item.answer.choiceIndex)
    : formatAnswer(item.answer);
}

function selectedChoice(item: PracticeItem): string {
  if (item.answer.type !== "multipleChoice") {
    throw new Error(`${item.skillKey} does not have a multiple-choice answer`);
  }
  const choice = item.choices?.[item.answer.choiceIndex];
  if (!choice) throw new Error(`${item.skillKey} is missing its correct choice`);
  return choice;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
}

describe("probability statistics-strand deterministic templates", () => {
  test("every curated statistics node has exactly one registered template", () => {
    expect(STATISTICS_KEYS).toHaveLength(23);
    expect(new Set(STATISTICS_KEYS).size).toBe(23);
    expect(STATISTICS_SKILLS.filter((skill) => skill.strand === "data-displays")).toHaveLength(7);
    expect(STATISTICS_SKILLS.filter((skill) => skill.strand === "center-spread")).toHaveLength(10);
    expect(SAMPLING_INFERENCE_KEYS).toHaveLength(6);
    for (const skillKey of STATISTICS_KEYS) {
      expect(hasTemplate(skillKey), skillKey).toBe(true);
    }
  });

  test("the statistics extension has 31 edges, with two foreign and one probability-strand prerequisite", () => {
    const statisticsKeys = new Set(STATISTICS_KEYS);
    const statisticsEdges = PROBABILITY_EDGES.filter((edge) => statisticsKeys.has(edge.toKey));
    expect(statisticsEdges).toHaveLength(31);
    expect(statisticsEdges.filter((edge) => !statisticsKeys.has(edge.fromKey))).toEqual([
      { fromKey: "fraction_number_line", toKey: "read_fractional_line_plot" },
      { fromKey: "division_as_sharing", toKey: "mean" },
      { fromKey: "probability_as_fraction", toKey: "estimate_population_from_sample" },
    ]);
    expect(PROBABILITY_EDGES).not.toContainEqual({
      fromKey: "expected_frequency",
      toKey: "estimate_population_from_sample",
    });
    expect(
      PROBABILITY_SKILLS.find(
        (skill) => skill.skillKey === "compare_populations_from_samples",
      )?.ccCodes,
    ).toEqual(["7.SP.B.4"]);
  });

  test("generateItem is deterministic for every skill and seed", () => {
    for (const skillKey of STATISTICS_KEYS) {
      for (let seed = 1; seed <= 30; seed++) {
        expect(generateItem(skillKey, seed), `${skillKey} seed=${seed}`).toEqual(
          generateItem(skillKey, seed),
        );
      }
    }
  });

  test("every generated answer round-trips through its own grader", () => {
    for (const skillKey of STATISTICS_KEYS) {
      for (let seed = 1; seed <= 30; seed++) {
        const item = requiredItem(skillKey, seed);
        const result = gradeTemplateItem(makeItemId(skillKey, seed), graderSubmission(item));
        expect(result, `${skillKey} seed=${seed}`).not.toBeNull();
        expect(result?.correct, `${skillKey} seed=${seed}: ${item.stem}`).toBe(true);
      }
    }
  });

  test("all generated data-display visuals pass the persisted schema validator", async () => {
    const t = convexTest(schema, modules);
    const kinds = new Set<string>();
    await t.run(async (ctx) => {
      for (const skillKey of STATISTICS_KEYS) {
        for (let seed = 1; seed <= 8; seed++) {
          const item = requiredItem(skillKey, seed);
          if (!item.promptVisual) continue;
          kinds.add(item.promptVisual.kind);
          await ctx.db.insert("practiceItems", {
            skillKey,
            domain: PROBABILITY_DOMAIN,
            stem: item.stem,
            answerType: item.answerType,
            answerCanonical: formatAnswer(item.answer),
            promptVisual: item.promptVisual,
            source: "template-test",
            verifiedAt: seed,
          });
        }
      }
    });
    expect([...kinds].sort()).toEqual(["barGraph", "linePlot", "pictograph"]);
  });

  test("graph-reading nodes use the intended visual families", () => {
    let missingBarItems = 0;
    for (let seed = 1; seed <= 60; seed++) {
      expect(requiredItem("read_picture_graph", seed).promptVisual?.kind).toBe("pictograph");
      const barItem = requiredItem("read_bar_graph", seed);
      expect(barItem.promptVisual?.kind).toBe("barGraph");
      if (
        barItem.promptVisual?.kind === "barGraph"
        && barItem.promptVisual.missingBarIndex !== undefined
      ) {
        missingBarItems++;
        const total = Number(barItem.stem.match(/received (\d+) votes/)?.[1]);
        const visible = barItem.promptVisual.bars.reduce(
          (sum, bar) => sum + (bar.value ?? 0),
          0,
        );
        if (barItem.answer.type !== "multipleChoice") {
          throw new Error("Expected a multiple-choice missing-bar item");
        }
        expect(Number(barItem.choices?.[barItem.answer.choiceIndex])).toBe(total - visible);
      }
      expect(requiredItem("read_line_plot", seed).promptVisual?.kind).toBe("linePlot");

      const fractional = requiredItem("read_fractional_line_plot", seed);
      expect(fractional.promptVisual?.kind).toBe("linePlot");
      if (fractional.promptVisual?.kind === "linePlot") {
        expect([2, 4]).toContain(fractional.promptVisual.fractionDenominator);
        expect(linePlotGeometry(fractional.promptVisual).ticks.some(
          (tick) => tick.text.includes("/"),
        )).toBe(true);
      }
    }
    expect(missingBarItems).toBeGreaterThan(0);

    const scaledKinds = new Set(
      Array.from({ length: 60 }, (_, seed) =>
        requiredItem("read_scaled_picture_bar_graph", seed + 1).promptVisual?.kind),
    );
    expect(scaledKinds).toEqual(new Set(["barGraph", "pictograph"]));

    const hasHalfIcon = Array.from({ length: 60 }, (_, seed) => {
      const visual = requiredItem("read_scaled_picture_bar_graph", seed + 1).promptVisual;
      return visual?.kind === "pictograph"
        && pictographGeometry(visual).icons.some((icon) => icon.half);
    }).some(Boolean);
    expect(hasHalfIcon).toBe(true);
  });

  test("mean, median, mode, range, and outlier answers agree with the plotted data", () => {
    for (let seed = 1; seed <= 100; seed++) {
      const meanItem = requiredItem("mean", seed);
      const modeItem = requiredItem("mode", seed);
      const medianItem = requiredItem("median", seed);
      const rangeItem = requiredItem("range", seed);
      const outlierItem = requiredItem("outlier_effect_on_mean_median", seed);
      for (const item of [meanItem, modeItem, medianItem, rangeItem, outlierItem]) {
        expect(item.promptVisual?.kind, `${item.skillKey} seed=${seed}`).toBe("linePlot");
      }
      if (
        meanItem.promptVisual?.kind !== "linePlot"
        || modeItem.promptVisual?.kind !== "linePlot"
        || medianItem.promptVisual?.kind !== "linePlot"
        || rangeItem.promptVisual?.kind !== "linePlot"
        || outlierItem.promptVisual?.kind !== "linePlot"
      ) {
        throw new Error("Expected linePlot statistics visual");
      }

      const meanValues = meanItem.promptVisual.values;
      expect(numericAnswer(meanItem)).toBe(
        meanValues.reduce((sum, value) => sum + value, 0) / meanValues.length,
      );

      const frequencies = new Map<number, number>();
      for (const value of modeItem.promptVisual.values) {
        frequencies.set(value, (frequencies.get(value) ?? 0) + 1);
      }
      const expectedMode = [...frequencies.entries()]
        .sort((a, b) => b[1] - a[1])[0][0];
      expect(numericAnswer(modeItem)).toBe(expectedMode);

      expect(numericAnswer(medianItem)).toBe(median(medianItem.promptVisual.values));
      expect(numericAnswer(rangeItem)).toBe(
        Math.max(...rangeItem.promptVisual.values) - Math.min(...rangeItem.promptVisual.values),
      );

      const outlierValues = outlierItem.promptVisual.values;
      const expectedOutlierAnswer = outlierItem.stem.includes("new mean")
        ? outlierValues.reduce((sum, value) => sum + value, 0) / outlierValues.length
        : median(outlierValues);
      expect(numericAnswer(outlierItem)).toBe(expectedOutlierAnswer);
    }
  });

  test("spread-comparison items plot both labeled sets, vary which set wins, and name the wider set", () => {
    // Guards two fixes: (1) the pretest-audit fix (2026-07-13) — the wide set
    // used to ALWAYS be "Set B", so the correct label never varied and a
    // scholar seeing the item twice could learn "pick Set B" instead of
    // reading spread; (2) both sets now render as labeled series on ONE
    // two-series line plot (no more withheld text-only Set B in the stem).
    const winners = new Set<string>();
    const mean = (values: number[]) =>
      values.reduce((sum, value) => sum + value, 0) / values.length;
    for (let seed = 1; seed <= 60; seed++) {
      const item = requiredItem("compare_same_center_different_spread", seed);
      expect(item.answerType).toBe("multipleChoice");
      expect(item.promptVisual?.kind).toBe("linePlot");
      if (item.answer.type !== "multipleChoice" || item.promptVisual?.kind !== "linePlot") {
        throw new Error("Expected a multiple-choice spread item with a line plot");
      }
      const correct = item.choices?.[item.answer.choiceIndex];
      expect(correct, `seed=${seed}`).toMatch(/^Set [AB]$/);
      winners.add(correct!);

      // Both sets are plotted as labeled series with equal means, different
      // ranges, and the correct label must name the wider of the two.
      const visual = item.promptVisual;
      expect(visual.seriesALabel, `seed=${seed}`).toBe("Set A");
      expect(visual.seriesBLabel, `seed=${seed}`).toBe("Set B");
      const setA = visual.values;
      const setB = visual.valuesB ?? [];
      expect(setA, `seed=${seed}`).toHaveLength(5);
      expect(setB, `seed=${seed}`).toHaveLength(5);
      expect(mean(setA), `seed=${seed}`).toBe(mean(setB));
      // The shared-mean marker is present at the common mean.
      expect(visual.marker?.value, `seed=${seed}`).toBe(mean(setA));
      const rangeA = Math.max(...setA) - Math.min(...setA);
      const rangeB = Math.max(...setB) - Math.min(...setB);
      expect(rangeA, `seed=${seed}`).not.toBe(rangeB);
      expect(correct, `seed=${seed}`).toBe(rangeA > rangeB ? "Set A" : "Set B");
      // The two-series geometry gives each set its own lane above the shared axis.
      const geometry = linePlotGeometry(visual);
      expect(geometry.dots, `seed=${seed}`).toHaveLength(5);
      expect(geometry.dotsB, `seed=${seed}`).toHaveLength(5);
      const laneY = geometry.laneABaseline?.y1 ?? Number.NaN;
      for (const dot of geometry.dots) expect(dot.y, `seed=${seed}`).toBeLessThan(laneY);
      for (const dot of geometry.dotsB ?? []) expect(dot.y, `seed=${seed}`).toBeGreaterThan(laneY);
    }
    expect(winners).toEqual(new Set(["Set A", "Set B"]));
  });

  test("conceptual collection and statistical-question items use honest choices", () => {
    for (let seed = 1; seed <= 30; seed++) {
      const statistical = requiredItem("statistical_question", seed);
      const collection = requiredItem("collect_measurement_data", seed);
      for (const item of [statistical, collection]) {
        expect(item.answerType).toBe("multipleChoice");
        expect(item.choices).toHaveLength(4);
        expect(new Set(item.choices).size).toBe(4);
        expect(item.answer.type).toBe("multipleChoice");
      }
      if (statistical.answer.type !== "multipleChoice" || collection.answer.type !== "multipleChoice") {
        throw new Error("Expected multiple-choice statistics item");
      }
      expect(statistical.choices?.[statistical.answer.choiceIndex]).toMatch(
        /students in our class|sunflower plants in our garden/,
      );
      expect(collection.choices?.[collection.answer.choiceIndex]).toBe(
        "Measure every pencil end to end in centimeters.",
      );
    }
  });

  test("sampling and inference items encode the intended population reasoning", () => {
    const comparisonWinners = new Set<string>();
    const variabilityModes = new Set<string>();
    const variabilityPhrasings = new Map<string, Set<string>>([
      ["justified", new Set()],
      ["population-change", new Set()],
      ["largest-only", new Set()],
      ["random-failed", new Set()],
    ]);
    const variabilityFamily = (choice: string): string => {
      if (
        choice.includes("Different random samples")
        || choice.includes("sample-to-sample variation")
        || choice.includes("need not give identical estimates")
      ) return "justified";
      if (
        choice.includes("population must have changed")
        || choice.includes("population changed")
        || choice.includes("population could not have stayed the same")
      ) return "population-change";
      if (choice.includes("largest") || choice.includes("greatest percentage")) {
        return "largest-only";
      }
      if (
        choice.includes("Random sampling failed")
        || choice.includes("proper random sample")
        || choice.includes("none of the samples was random")
      ) return "random-failed";
      throw new Error(`Unknown sampling-variability choice: ${choice}`);
    };

    for (let seed = 1; seed <= 300; seed++) {
      const population = requiredItem("population_vs_sample", seed);
      expect(selectedChoice(population), population.stem).toMatch(
        /^Population: .+; sample: .+\.$/,
      );
      expect(population.stem).not.toContain(selectedChoice(population));
      expect(population.choices).toHaveLength(4);
      for (const choice of population.choices ?? []) {
        expect(choice, population.stem).toMatch(/^Population: .+; sample: .+\.$/);
        expect(choice, population.stem).not.toContain("survey questions");
        expect(choice, population.stem).not.toContain("everyone who answers favorably");
      }

      const representative = requiredItem("representative_random_sample", seed);
      expect(selectedChoice(representative), representative.stem).toMatch(
        /random number generator|Randomly select/,
      );
      expect(representative.stem).not.toContain(selectedChoice(representative));

      const estimate = requiredItem("estimate_population_from_sample", seed);
      const estimateNumbers = estimate.stem.match(/\d+/g)?.map(Number) ?? [];
      expect(estimateNumbers, estimate.stem).toHaveLength(3);
      const [sampleSize, successes, populationSize] = estimateNumbers;
      expect(numericAnswer(estimate), estimate.stem).toBeCloseTo(
        (successes / sampleSize) * populationSize,
        12,
      );
      expect(estimateNumbers, estimate.stem).not.toContain(numericAnswer(estimate));

      const variability = requiredItem("sampling_variability", seed);
      const inverted = variability.stem.includes("NOT justified");
      variabilityModes.add(inverted ? "inverted" : "direct");
      const selectedVariabilityFamily = variabilityFamily(selectedChoice(variability));
      if (inverted) {
        expect(selectedVariabilityFamily, variability.stem).not.toBe("justified");
      } else {
        expect(selectedVariabilityFamily, variability.stem).toBe("justified");
      }
      const nonSelectedChoices = (variability.choices ?? []).filter(
        (_, index) => index !== (
          variability.answer.type === "multipleChoice"
            ? variability.answer.choiceIndex
            : -1
        ),
      );
      expect(
        nonSelectedChoices.map(variabilityFamily),
        variability.stem,
      ).toEqual(
        inverted
          ? ["justified", "justified", "justified"]
          : expect.arrayContaining(["population-change", "largest-only", "random-failed"]),
      );
      for (const choice of variability.choices ?? []) {
        variabilityPhrasings.get(variabilityFamily(choice))?.add(choice);
      }
      expect(variability.stem).not.toContain(selectedChoice(variability));

      const comparison = requiredItem("compare_populations_from_samples", seed);
      const match = comparison.stem.match(
        /Sample A: ([\d, ]+)\. Sample B: ([\d, ]+)\./,
      );
      expect(match, comparison.stem).not.toBeNull();
      if (!match) continue;
      const sampleA = match[1].split(", ").map(Number);
      const sampleB = match[2].split(", ").map(Number);
      const meanA = sampleA.reduce((sum, value) => sum + value, 0) / sampleA.length;
      const meanB = sampleB.reduce((sum, value) => sum + value, 0) / sampleB.length;
      const rangeA = Math.max(...sampleA) - Math.min(...sampleA);
      const rangeB = Math.max(...sampleB) - Math.min(...sampleB);
      expect(Math.abs(meanA - meanB), comparison.stem).toBeGreaterThanOrEqual(
        2 * Math.max(rangeA, rangeB),
      );
      const higherLabel = meanA > meanB ? "A" : "B";
      const higherRange = higherLabel === "A" ? rangeA : rangeB;
      const lowerRange = higherLabel === "A" ? rangeB : rangeA;
      const expected = `Population ${higherLabel} likely has a higher typical value and ${higherRange > lowerRange ? "more" : "less"} variability.`;
      expect(selectedChoice(comparison), comparison.stem).toBe(expected);
      expect(comparison.stem).not.toContain(selectedChoice(comparison));
      comparisonWinners.add(higherLabel);

      const margin = requiredItem("margin_of_error_range", seed);
      const marginNumbers = margin.stem.match(/\d+/g)?.map(Number) ?? [];
      expect(marginNumbers, margin.stem).toHaveLength(2);
      const [pointEstimate, marginSize] = marginNumbers;
      const selectedPercent = Number(selectedChoice(margin).replace("%", ""));
      expect(selectedPercent, margin.stem).toBeGreaterThanOrEqual(pointEstimate - marginSize);
      expect(selectedPercent, margin.stem).toBeLessThanOrEqual(pointEstimate + marginSize);
      const choicePercents = (margin.choices ?? []).map((choice) =>
        Number(choice.replace("%", "")));
      expect(choicePercents.filter(
        (value) => value >= pointEstimate - marginSize && value <= pointEstimate + marginSize,
      ), margin.stem).toEqual([selectedPercent]);
      expect(choicePercents.some((value) => value < pointEstimate - marginSize), margin.stem).toBe(true);
      expect(choicePercents.some((value) => value > pointEstimate + marginSize), margin.stem).toBe(true);
      expect(margin.stem).not.toContain(selectedChoice(margin));
    }
    expect(comparisonWinners).toEqual(new Set(["A", "B"]));
    expect(variabilityModes).toEqual(new Set(["direct", "inverted"]));
    for (const [family, phrasings] of variabilityPhrasings) {
      expect(phrasings.size, family).toBeGreaterThanOrEqual(2);
    }
  });
});
