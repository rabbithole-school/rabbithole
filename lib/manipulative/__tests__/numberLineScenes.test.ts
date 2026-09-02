import { describe, expect, it } from "vitest";
import { assertGradableManipulative, assertRenderableManipulative } from "../authoring";
import { normalizeNumberLineValue, numberLineSolved } from "../logic";
import type { NumberLineSpec } from "../types";

const horizontalDefault: NumberLineSpec = {
  kind: "numberline",
  id: "number-line-default",
  concept: "Whole numbers",
  prompt: "Put the knob on 7.",
  min: 0,
  max: 10,
  tickStep: 1,
  snap: 1,
  start: 3,
  goal: { type: "placeAt", value: 7 },
};

const verticalScenes: NumberLineSpec[] = [
  {
    kind: "numberline",
    id: "research-station-hike",
    concept: "Positive and negative elevation",
    prompt: "Guide the hiker to the research station at +5 above sea level.",
    min: -2,
    max: 8,
    tickStep: 1,
    snap: 1,
    start: 1,
    orientation: "vertical",
    handleLabel: "Hiker",
    scene: { type: "mountain" },
    markers: [{ value: 0, label: "Sea level" }],
    goal: { type: "placeAt", value: 5 },
  },
  {
    kind: "numberline",
    id: "elevator-basement-floor",
    concept: "Negative numbers",
    prompt: "Take the elevator to basement floor −3.",
    min: -4,
    max: 5,
    tickStep: 1,
    snap: 1,
    start: 2,
    orientation: "vertical",
    handleLabel: "Elevator",
    scene: { type: "building" },
    markers: [{ value: 0, label: "Ground floor" }],
    goal: { type: "placeAt", value: -3 },
  },
];

describe("vertical number line scenes", () => {
  it.each(verticalScenes)("accepts $id as renderable and gradable", (spec) => {
    expect(() => assertRenderableManipulative(spec)).not.toThrow();
    expect(() => assertGradableManipulative(spec)).not.toThrow();
    const target =
      spec.goal?.type === "placeAt" ? spec.goal.value : Number.NaN;
    expect(numberLineSolved(spec, { value: target })).toBe(true);
    expect(numberLineSolved(spec, { value: target + 1 })).toBe(false);
  });

  it("keeps the omitted orientation and scene as a valid horizontal number line", () => {
    expect(horizontalDefault.orientation).toBeUndefined();
    expect(horizontalDefault.scene).toBeUndefined();
    expect(() => assertRenderableManipulative(horizontalDefault)).not.toThrow();
    expect(() => assertGradableManipulative(horizontalDefault)).not.toThrow();
  });

  it("reports exact authored floor values after internal coordinate conversion", () => {
    const elevator = verticalScenes[1];
    const internalValue = 6 * (10 / 9);
    const roundTripped = elevator.min + (internalValue / 10) * 9;

    expect(roundTripped).not.toBe(2);
    expect(normalizeNumberLineValue(elevator, roundTripped)).toBe(2);
  });

  it("removes announcement dust from unsnapped accessibility steps", () => {
    const unsnapped: NumberLineSpec = {
      ...verticalScenes[0],
      snap: undefined,
      tickStep: 0.1,
      min: 0,
      max: 1,
      start: 0,
      scene: undefined,
    };

    expect(normalizeNumberLineValue(unsnapped, 0.2 + 0.1)).toBe(0.3);
  });

  it("rejects scene specs that would render misleading context", () => {
    expect(() =>
      assertRenderableManipulative({
        ...verticalScenes[0],
        orientation: "horizontal",
      }),
    ).toThrow(/requires orientation "vertical"/);
    expect(() =>
      assertRenderableManipulative({
        ...verticalScenes[0],
        min: 10,
        max: 20,
      }),
    ).toThrow(/requires zero inside the visible range/);
    expect(() =>
      assertRenderableManipulative({
        ...verticalScenes[1],
        tickStep: 0.5,
      }),
    ).toThrow(/integer floor spacing/);
  });
});
