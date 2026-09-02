import { describe, expect, test } from "vitest";
import {
  resolveThemeLabel,
  normalizeThemeLabel,
  type ManipulativeTheme,
} from "../types";
import { arraySolved, areaPerimeterSolved, balanceSolved } from "../logic";
import type { ArraySpec, AreaPerimeterSpec, BalanceSpec } from "../types";

describe("resolveThemeLabel", () => {
  test("prefers the generative fill.label", () => {
    expect(resolveThemeLabel({ fill: { label: "rocket" } })).toBe("rocket");
  });

  test("shims the deprecated fillIcon enum (values are valid labels)", () => {
    expect(resolveThemeLabel({ fillIcon: "pig" })).toBe("pig");
    expect(resolveThemeLabel({ fillIcon: "apple" })).toBe("apple");
    expect(resolveThemeLabel({ fillIcon: "cauldron" })).toBe("cauldron");
  });

  test("fill.label wins over a legacy fillIcon", () => {
    const theme: ManipulativeTheme = {
      fill: { label: "rocket" },
      fillIcon: "pig",
    };
    expect(resolveThemeLabel(theme)).toBe("rocket");
  });

  test("returns undefined for an un-themed / blank spec", () => {
    expect(resolveThemeLabel(undefined)).toBeUndefined();
    expect(resolveThemeLabel({})).toBeUndefined();
    expect(resolveThemeLabel({ fill: { label: "   " } })).toBeUndefined();
  });
});

describe("normalizeThemeLabel", () => {
  test("collapses case + whitespace so variants share one cached asset", () => {
    expect(normalizeThemeLabel("Rocket Ship")).toBe("rocket ship");
    expect(normalizeThemeLabel("rocket  ship ")).toBe("rocket ship");
    expect(normalizeThemeLabel("\tPIG\n")).toBe("pig");
  });
});

// The charm layer is PURE DECORATION — a themed spec must grade identically to
// the same spec without a theme. (Regression guard for the invariant every
// renderer relies on: the icon is a 1:1 visual stand-in, never a source of
// truth for the count.)
describe("theme never affects grading", () => {
  test("array", () => {
    const base: ArraySpec = {
      kind: "array",
      id: "t",
      concept: "c",
      prompt: "p",
      rows: 2,
      cols: 2,
      goal: { type: "productEquals", value: 12 },
    };
    const themed: ArraySpec = { ...base, theme: { fill: { label: "apple" } } };
    for (const s of [
      { rows: 3, cols: 4 },
      { rows: 2, cols: 2 },
    ]) {
      expect(arraySolved(themed, s)).toBe(arraySolved(base, s));
    }
  });

  test("areaPerimeter", () => {
    const base: AreaPerimeterSpec = {
      kind: "areaPerimeter",
      id: "t",
      concept: "c",
      prompt: "p",
      perimeter: 16,
      startWidth: 2,
      goal: { type: "maxArea" },
    };
    const themed: AreaPerimeterSpec = {
      ...base,
      theme: { fill: { label: "pig" } },
    };
    for (const w of [2, 4, 5]) {
      expect(areaPerimeterSolved(themed, { width: w })).toBe(
        areaPerimeterSolved(base, { width: w }),
      );
    }
  });

  test("balance", () => {
    const base: BalanceSpec = {
      kind: "balance",
      id: "t",
      concept: "c",
      prompt: "p",
      left: 0,
      right: 0,
      adjustable: ["left"],
      mysteryRight: 5,
      goal: { type: "balance" },
    };
    const themed: BalanceSpec = {
      ...base,
      theme: { fill: { label: "cauldron" } },
    };
    for (const left of [3, 5, 8]) {
      const state = { left, right: 0 };
      expect(balanceSolved(themed, state)).toBe(balanceSolved(base, state));
    }
  });
});
