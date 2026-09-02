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
  (skill) => skill.strand === "data-displays" || skill.strand === "center-spread",
);
const STATISTICS_KEYS = STATISTICS_SKILLS.map((skill) => skill.skillKey);

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

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
}

describe("probability statistics-strand deterministic templates", () => {
  test("every curated statistics node has exactly one registered template", () => {
    expect(STATISTICS_KEYS).toHaveLength(17);
    expect(new Set(STATISTICS_KEYS).size).toBe(17);
    expect(STATISTICS_SKILLS.filter((skill) => skill.strand === "data-displays")).toHaveLength(7);
    expect(STATISTICS_SKILLS.filter((skill) => skill.strand === "center-spread")).toHaveLength(10);
    for (const skillKey of STATISTICS_KEYS) {
      expect(hasTemplate(skillKey), skillKey).toBe(true);
    }
  });

  test("the statistics extension contributes 23 edges, including two cross-domain bridges", () => {
    const statisticsKeys = new Set(STATISTICS_KEYS);
    const statisticsEdges = PROBABILITY_EDGES.filter((edge) => statisticsKeys.has(edge.toKey));
    expect(statisticsEdges).toHaveLength(23);
    expect(statisticsEdges.filter((edge) => !statisticsKeys.has(edge.fromKey))).toEqual([
      { fromKey: "fraction_number_line", toKey: "read_fractional_line_plot" },
      { fromKey: "division_as_sharing", toKey: "mean" },
    ]);
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
});
