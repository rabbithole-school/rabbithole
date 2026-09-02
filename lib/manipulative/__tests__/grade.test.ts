/**
 * Grade-path tests for a manipulative rendered as a practiceItem — the shared
 * `gradeManipulativeSubmission` the Convex verifier (submitAnswer) calls.
 */

import { describe, expect, it } from "vitest";
import { gradeManipulativeSubmission, parseManipulativeSpec } from "../grade";
import type {
  ArraySpec,
  AreaPerimeterSpec,
  BalanceSpec,
  DistributeSpec,
  DistributorSpec,
  RekenrekSpec,
  ManipulativeKind,
  ManipulativeSpec,
  NumberLineSpec,
  PartitionSpec,
  RiemannSpec,
} from "../types";

const json = (v: unknown) => JSON.stringify(v);

type GoalCase = {
  name: string;
  kind: ManipulativeKind;
  goalVariant: string;
  spec: ManipulativeSpec;
  solved: unknown;
  nearMiss: unknown;
  mismatched: unknown;
  alsoSolved?: unknown[];
  alsoIncorrect?: unknown[];
};

const partitionHalfSpec: PartitionSpec = {
  kind: "partition",
  id: "pt-half",
  concept: "Equivalent fractions",
  prompt: "Shade one half.",
  discs: [{ parts: 4, shaded: 0 }],
  adjustable: ["parts", "shaded"],
  partsRange: [1, 12],
  goal: { type: "shadedFractionEquals", disc: 0, value: 0.5 },
};

const partitionEqualAreaSpec: PartitionSpec = {
  kind: "partition",
  id: "pt-equal",
  concept: "Equivalent shaded area",
  prompt: "Make the two shaded areas equal.",
  discs: [
    { parts: 2, shaded: 0 },
    { parts: 6, shaded: 0 },
  ],
  adjustable: ["parts", "shaded"],
  partsRange: [1, 12],
  goal: { type: "discsEqualShadedArea" },
};

const numberLinePlaceAtSpec: NumberLineSpec = {
  kind: "numberline",
  id: "nl-decimal",
  concept: "Decimal magnitude",
  prompt: "Place the point at 3.25.",
  min: 0,
  max: 5,
  tickStep: 1,
  snap: 0.01,
  start: 0,
  goal: { type: "placeAt", value: 3.25, tolerance: 0.01 },
};

const numberLineFractionSpec: NumberLineSpec = {
  kind: "numberline",
  id: "nl-fraction",
  concept: "Fraction magnitude",
  prompt: "Place the point at three fourths.",
  min: 0,
  max: 1,
  tickStep: 0.25,
  snap: 0.01,
  start: 0,
  goal: { type: "placeFraction", num: 3, den: 4, tolerance: 0.01 },
};

const arrayProductSpec: ArraySpec = {
  kind: "array",
  id: "ar-product",
  concept: "Multiplication arrays",
  prompt: "Build an array with product 12.",
  rows: 1,
  cols: 1,
  maxRows: 12,
  maxCols: 12,
  goal: { type: "productEquals", value: 12 },
};

const arrayAreaSpec: ArraySpec = {
  kind: "array",
  id: "ar-area",
  concept: "Area as rows times columns",
  prompt: "Build an area of 15 square units.",
  rows: 1,
  cols: 1,
  maxRows: 15,
  maxCols: 15,
  goal: { type: "areaEquals", value: 15 },
};

const arrayFactorCountSpec: ArraySpec = {
  kind: "array",
  id: "ar-factors",
  concept: "Factor pairs",
  prompt: "Build a product with exactly three factor pairs.",
  rows: 1,
  cols: 1,
  maxRows: 12,
  maxCols: 12,
  goal: { type: "factorPairCountEquals", product: 12, count: 3 },
};

const balanceSpec: BalanceSpec = {
  kind: "balance",
  id: "bal-1",
  concept: "Equality",
  prompt: "Make the beam level.",
  left: 5,
  right: 1,
  mysteryRight: 4,
  adjustable: ["left", "right"],
  maxUnits: 10,
  goal: { type: "balance" },
};

const areaEqualsSpec: AreaPerimeterSpec = {
  kind: "areaPerimeter",
  id: "ap-area",
  concept: "Area with fixed perimeter",
  prompt: "Fence in exactly 16 square units.",
  perimeter: 16,
  startWidth: 1,
  goal: { type: "areaEquals", value: 16 },
};

const maxAreaSpec: AreaPerimeterSpec = {
  kind: "areaPerimeter",
  id: "ap-max",
  concept: "Maximizing area",
  prompt: "Find the largest area with 18 units of fence.",
  perimeter: 18,
  startWidth: 1,
  goal: { type: "maxArea" },
};

const distributeSpec: DistributeSpec = {
  kind: "distribute",
  id: "dist-1",
  concept: "Distributive property",
  prompt: "Split the rectangle after column 4.",
  width: 9,
  height: 3,
  startColumn: 1,
  goal: { type: "splitAt", column: 4 },
};

const rekenrekSpec: RekenrekSpec = {
  kind: "rekenrek",
  id: "rack-1",
  concept: "Make-ten strategy",
  prompt: "Push 13 beads into a group of 10 and the rest.",
  total: 13,
  goal: { type: "groupOf", value: 10 },
};

const distributorSpec: DistributorSpec = {
  kind: "distributor",
  id: "share-1",
  concept: "Division as sharing",
  prompt: "Share 13 onto 4 plates.",
  total: 13,
  groups: 4,
  goal: { type: "shareEqually" },
};

const riemannSpec: RiemannSpec = {
  kind: "riemann",
  id: "rie-1",
  concept: "Area under a rate graph",
  prompt: "Use enough bars to get close to the true distance.",
  slope: 2,
  intercept: 0,
  tMax: 4,
  startBars: 1,
  minBars: 1,
  maxBars: 20,
  goal: { type: "approximateWithin", tolerance: 2.1 },
};

const partitionState = { discs: [{ parts: 3, shaded: 1 }] };

const cases: GoalCase[] = [
  {
    name: "partition shadedFractionEquals accepts equivalent fractions",
    kind: "partition",
    goalVariant: "shadedFractionEquals",
    spec: partitionHalfSpec,
    solved: { discs: [{ parts: 4, shaded: 2 }] },
    alsoSolved: [{ discs: [{ parts: 6, shaded: 3 }] }],
    nearMiss: { discs: [{ parts: 6, shaded: 2 }] },
    mismatched: { discs: [{ parts: 3, shaded: 1 }] },
  },
  {
    name: "partition discsEqualShadedArea requires equal non-zero shaded area",
    kind: "partition",
    goalVariant: "discsEqualShadedArea",
    spec: partitionEqualAreaSpec,
    solved: {
      discs: [
        { parts: 2, shaded: 1 },
        { parts: 6, shaded: 3 },
      ],
    },
    nearMiss: {
      discs: [
        { parts: 2, shaded: 1 },
        { parts: 6, shaded: 2 },
      ],
    },
    alsoIncorrect: [
      {
        discs: [
          { parts: 2, shaded: 0 },
          { parts: 6, shaded: 0 },
        ],
      },
    ],
    mismatched: { discs: [{ parts: 2, shaded: 1 }] },
  },
  {
    name: "numberline placeAt honors tolerance",
    kind: "numberline",
    goalVariant: "placeAt",
    spec: numberLinePlaceAtSpec,
    solved: { value: 3.25 },
    alsoSolved: [{ value: 3.259 }],
    nearMiss: { value: 3.261 },
    mismatched: partitionState,
  },
  {
    name: "numberline placeFraction converts numerator and denominator",
    kind: "numberline",
    goalVariant: "placeFraction",
    spec: numberLineFractionSpec,
    solved: { value: 0.75 },
    alsoSolved: [{ value: 0.741 }],
    nearMiss: { value: 0.739 },
    mismatched: partitionState,
  },
  {
    name: "array productEquals grades rows times columns",
    kind: "array",
    goalVariant: "productEquals",
    spec: arrayProductSpec,
    solved: { rows: 3, cols: 4 },
    alsoSolved: [{ rows: 2, cols: 6 }],
    nearMiss: { rows: 3, cols: 5 },
    mismatched: partitionState,
  },
  {
    name: "array areaEquals uses the same filled-rectangle product",
    kind: "array",
    goalVariant: "areaEquals",
    spec: arrayAreaSpec,
    solved: { rows: 3, cols: 5 },
    alsoSolved: [{ rows: 1, cols: 15 }],
    nearMiss: { rows: 4, cols: 4 },
    mismatched: partitionState,
  },
  {
    name: "array factorPairCountEquals checks product and factor-pair count",
    kind: "array",
    goalVariant: "factorPairCountEquals",
    spec: arrayFactorCountSpec,
    solved: { rows: 3, cols: 4 },
    alsoSolved: [{ rows: 2, cols: 6 }],
    nearMiss: { rows: 2, cols: 5 },
    mismatched: partitionState,
  },
  {
    name: "balance grades level net tilt",
    kind: "balance",
    goalVariant: "balance",
    spec: balanceSpec,
    solved: { left: 5, right: 1 },
    alsoSolved: [{ left: 6, right: 2 }],
    nearMiss: { left: 5, right: 0 },
    mismatched: { rows: 5, cols: 1 },
  },
  {
    name: "areaPerimeter areaEquals uses width times derived height",
    kind: "areaPerimeter",
    goalVariant: "areaEquals",
    spec: areaEqualsSpec,
    solved: { width: 4 },
    nearMiss: { width: 3 },
    mismatched: partitionState,
  },
  {
    name: "areaPerimeter maxArea accepts symmetric maxima",
    kind: "areaPerimeter",
    goalVariant: "maxArea",
    spec: maxAreaSpec,
    solved: { width: 4 },
    alsoSolved: [{ width: 5 }],
    nearMiss: { width: 3 },
    mismatched: partitionState,
  },
  {
    name: "distribute splitAt requires the exact split column",
    kind: "distribute",
    goalVariant: "splitAt",
    spec: distributeSpec,
    solved: { column: 4 },
    nearMiss: { column: 3 },
    mismatched: partitionState,
  },
  {
    name: "rekenrek groupOf accepts a target group on either side",
    kind: "rekenrek",
    goalVariant: "groupOf",
    spec: rekenrekSpec,
    solved: { left: 10 },
    alsoSolved: [{ left: 3 }],
    nearMiss: { left: 7 },
    mismatched: partitionState,
  },
  {
    name: "distributor shareEqually requires the max equal deal",
    kind: "distributor",
    goalVariant: "shareEqually",
    spec: distributorSpec,
    solved: { perGroup: 3 },
    nearMiss: { perGroup: 2 },
    mismatched: partitionState,
  },
  {
    name: "riemann approximateWithin compares the left sum to true area",
    kind: "riemann",
    goalVariant: "approximateWithin",
    spec: riemannSpec,
    solved: { bars: 8 },
    nearMiss: { bars: 7 },
    mismatched: partitionState,
  },
];

describe("gradeManipulativeSubmission goal fidelity", () => {
  it.each(cases)("$name", ({ spec, solved, alsoSolved = [], nearMiss, alsoIncorrect = [] }) => {
    expect(gradeManipulativeSubmission(json(spec), json(solved)).correct).toBe(true);
    for (const equivalent of alsoSolved) {
      expect(gradeManipulativeSubmission(json(spec), json(equivalent)).correct).toBe(true);
    }
    expect(gradeManipulativeSubmission(json(spec), json(nearMiss)).correct).toBe(false);
    for (const incorrect of alsoIncorrect) {
      expect(gradeManipulativeSubmission(json(spec), json(incorrect)).correct).toBe(false);
    }
  });

  it.each(cases)("rejects a mismatched/forged state for $kind $goalVariant", ({ spec, mismatched }) => {
    expect(gradeManipulativeSubmission(json(spec), json(mismatched)).correct).toBe(false);
  });

  it.each(cases)("grades malformed JSON as incorrect for $kind $goalVariant", ({ spec, solved }) => {
    expect(gradeManipulativeSubmission("not json {", json(solved)).correct).toBe(false);
    expect(gradeManipulativeSubmission("", json(solved)).correct).toBe(false);
    expect(gradeManipulativeSubmission(json({ noKind: true }), json(solved)).correct).toBe(false);
    expect(gradeManipulativeSubmission(json(spec), "not json {").correct).toBe(false);
    expect(gradeManipulativeSubmission(json(spec), "").correct).toBe(false);
  });

  it("a wrong-shape state that would THROW in a predicate grades incorrect, not error", () => {
    // partitionSolved reads state.discs[...] — a non-partition state has none.
    // The grader must be total: swallow the throw as incorrect (never a pass).
    expect(() =>
      gradeManipulativeSubmission(json(partitionHalfSpec), json({ width: 4 })),
    ).not.toThrow();
    expect(gradeManipulativeSubmission(json(partitionHalfSpec), json({ width: 4 })).correct).toBe(
      false,
    );
    expect(gradeManipulativeSubmission(json(partitionHalfSpec), json(null)).correct).toBe(false);
  });
});

describe("parseManipulativeSpec", () => {
  it("returns the spec for valid JSON with a kind", () => {
    expect(parseManipulativeSpec(json(areaEqualsSpec))?.kind).toBe("areaPerimeter");
  });

  it("returns null for junk / missing / kindless input", () => {
    expect(parseManipulativeSpec(undefined)).toBeNull();
    expect(parseManipulativeSpec("nope")).toBeNull();
    expect(parseManipulativeSpec(json({ noKind: true }))).toBeNull();
  });
});
