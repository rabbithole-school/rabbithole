import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import {
  angleFigureGeometry,
  compositeRectilinearGeometry,
  coordinatePlaneGeometry,
  labeledRectangleGeometry,
  rectangularPrismGeometry,
} from "../../shared/practicePromptVisual";
import { formatAnswer, formatUnit } from "../lib/practice/answers";
import { gradeTemplateItem, makeItemId } from "../lib/practice/session";
import { generateItem, hasTemplate, type PracticeItem } from "../lib/practice/templates";
import {
  GEOMETRY_MEASUREMENT_DOMAIN,
  GEOMETRY_MEASUREMENT_SKILLS,
} from "../seed/geometryMeasurementGraph";
import schema from "../schema";

const modules = (
  import.meta as ImportMeta & {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("../**/*.ts");

const SKILL_KEYS = GEOMETRY_MEASUREMENT_SKILLS.map((skill) => skill.skillKey);

function requiredItem(skillKey: string, seed: number, form?: string): PracticeItem {
  const item = generateItem(skillKey, seed, form);
  expect(item, `${skillKey} seed=${seed} form=${form ?? "direct"}`).not.toBeNull();
  if (!item) throw new Error(`Missing geometry template: ${skillKey}`);
  return item;
}

function numericAnswer(item: PracticeItem): number {
  if (item.answer.type !== "integer" && item.answer.type !== "decimal") {
    throw new Error(`${item.skillKey} does not have a numeric answer`);
  }
  return item.answer.value;
}

/** What a scholar would type for this item. A unit-bearing family (a stem that
 *  names centimetres / square metres / …) is answered with the VALUE AND THE
 *  UNIT — "112 cm³", not "112" — because the grader now treats the unit as part
 *  of the answer. */
function graderSubmission(item: PracticeItem): string {
  if (item.answer.type === "multipleChoice") return String(item.answer.choiceIndex);
  const value = formatAnswer(item.answer);
  return item.answerUnit ? `${value} ${formatUnit(item.answerUnit)}` : value;
}

describe("geometry-measurement deterministic templates", () => {
  test("every geometry node has exactly one registered template", () => {
    expect(SKILL_KEYS).toHaveLength(60);
    expect(new Set(SKILL_KEYS).size).toBe(60);
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

  test("classification and estimation items always offer 3 or 4 unique choices", () => {
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
            domain: GEOMETRY_MEASUREMENT_DOMAIN,
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
    expect([...kinds].sort()).toEqual([
      "angleFigure",
      "compositeRectilinear",
      "coordinatePlane",
      "labeledRectangle",
      "rectangularPrism",
    ]);
  });

  test("sampled stems agree with their rendered figure specifications", () => {
    const rectangle = requiredItem("area_word_problems", 7);
    expect(rectangle.promptVisual?.kind).toBe("labeledRectangle");
    if (rectangle.promptVisual?.kind !== "labeledRectangle") throw new Error("wrong visual");
    expect(rectangle.stem).toContain(`${rectangle.promptVisual.width} m`);
    expect(rectangle.stem).toContain(`${rectangle.promptVisual.height} m`);
    expect(labeledRectangleGeometry(rectangle.promptVisual).labels.map((label) => label.text))
      .toEqual([
        `${rectangle.promptVisual.width} m`,
        `${rectangle.promptVisual.height} m`,
      ]);

    const composite = requiredItem("perimeter_composite", 11);
    expect(composite.promptVisual?.kind).toBe("compositeRectilinear");
    if (composite.promptVisual?.kind !== "compositeRectilinear") throw new Error("wrong visual");
    const compositeLabels = compositeRectilinearGeometry(composite.promptVisual).labels;
    expect(compositeLabels.map((label) => label.text).sort()).toEqual(
      composite.promptVisual.sideLabels
        .flatMap((side) => side.label ? [side.label] : [])
        .sort(),
    );

    const angle = requiredItem("angle_additivity", 13);
    expect(angle.promptVisual?.kind).toBe("angleFigure");
    if (angle.promptVisual?.kind !== "angleFigure") throw new Error("wrong visual");
    const knownPart = angle.promptVisual.parts?.find((part) => part.label);
    expect(angle.promptVisual.parts?.reduce((sum, part) => sum + part.degrees, 0))
      .toBe(angle.promptVisual.degrees);
    expect(angle.stem).toContain(angle.promptVisual.label ?? "");
    expect(angle.stem).toContain(knownPart?.label ?? "");
    expect(angleFigureGeometry(angle.promptVisual).rays).toHaveLength(3);

    const protractor = requiredItem("angle_measure_protractor", 23);
    expect(protractor.promptVisual?.kind).toBe("angleFigure");
    if (protractor.promptVisual?.kind !== "angleFigure") throw new Error("wrong visual");
    expect(protractor.promptVisual.showProtractorScale).toBe(true);
    expect(angleFigureGeometry(protractor.promptVisual).protractorScale?.ticks)
      .toHaveLength(37);

    const coordinates = requiredItem("coordinate_distance", 17);
    expect(coordinates.promptVisual?.kind).toBe("coordinatePlane");
    if (coordinates.promptVisual?.kind !== "coordinatePlane") throw new Error("wrong visual");
    const [a, b] = coordinates.promptVisual.points;
    const plottedDistance = a.x === b.x ? Math.abs(a.y - b.y) : Math.abs(a.x - b.x);
    expect(numericAnswer(coordinates)).toBe(plottedDistance);
    expect(coordinatePlaneGeometry(coordinates.promptVisual).points).toHaveLength(2);

    const prism = requiredItem("volume_by_layers", 19);
    expect(prism.promptVisual?.kind).toBe("rectangularPrism");
    if (prism.promptVisual?.kind !== "rectangularPrism") throw new Error("wrong visual");
    const layer = prism.promptVisual.length * prism.promptVisual.width;
    expect(prism.stem).toContain(`${layer} unit cubes`);
    expect(prism.stem).toContain(`${prism.promptVisual.height} equal layers`);
    expect(numericAnswer(prism)).toBe(layer * prism.promptVisual.height);
    expect(rectangularPrismGeometry(prism.promptVisual).subdivisionLines.length).toBeGreaterThan(0);
  });

  test("fractional-side items keep answers within 2 decimal places and stay fractional", () => {
    // Guards the pretest-audit fix (2026-07-13): the construct is applying
    // fraction multiplication to fractional side/edge lengths — NOT typing a
    // 4-decimal-place product (e.g. the old 3.5 × 2.5 × 0.75 = 6.5625). A
    // regression here turns a placement probe into a decimal-multiplication
    // gauntlet for a skill the knowledge graph has no node for.
    const decimalPlaces = (value: number): number =>
      (String(value).split(".")[1] ?? "").length;
    const isFractional = (value: number): boolean => !Number.isInteger(value);

    for (let seed = 1; seed <= 200; seed++) {
      const area = requiredItem("area_fraction_side", seed);
      expect(area.promptVisual?.kind).toBe("labeledRectangle");
      if (area.promptVisual?.kind !== "labeledRectangle") throw new Error("wrong visual");
      expect(numericAnswer(area), `area seed=${seed}`).toBe(
        area.promptVisual.width * area.promptVisual.height,
      );
      expect(decimalPlaces(numericAnswer(area)), `area seed=${seed}`).toBeLessThanOrEqual(2);
      expect(
        [area.promptVisual.width, area.promptVisual.height].some(isFractional),
        `area seed=${seed} must keep a fractional side`,
      ).toBe(true);

      const volume = requiredItem("volume_fractional_edges", seed);
      expect(volume.promptVisual?.kind).toBe("rectangularPrism");
      if (volume.promptVisual?.kind !== "rectangularPrism") throw new Error("wrong visual");
      const { length, width, height } = volume.promptVisual;
      expect(numericAnswer(volume), `volume seed=${seed}`).toBe(length * width * height);
      expect(decimalPlaces(numericAnswer(volume)), `volume seed=${seed}`).toBeLessThanOrEqual(2);
      expect(
        [length, width, height].some(isFractional),
        `volume seed=${seed} must keep a fractional edge`,
      ).toBe(true);
    }
  });

  test("supported binary facts use the existing missing-operand form", () => {
    const binarySkills = [
      "partition_rectangles_rows_cols",
      "area_unit_squares",
      "perimeter_polygons",
      "area_rectangle",
      "area_distributive",
      "area_rectilinear_decompose",
      "area_word_problems",
      "area_parallelogram",
      "volume_unit_cubes",
      "volume_by_layers",
      "volume_rectangular_prism",
      "volume_composite_prisms",
      "angle_additivity",
      "coordinate_distance",
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
