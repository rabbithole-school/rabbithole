/**
 * Authoring-guard tests: a manipulative spec with a usable `goal` passes,
 * one without throws (or reads `false` from `isGradableManipulative`) —
 * mirroring `isSolved`'s own `if (!g) return false;` gate per kind so the
 * guard rejects EXACTLY the specs that would otherwise be silently ungradable.
 */

import { describe, expect, it } from "vitest";
import { assertGradableManipulative, assertRenderableManipulative, isGradableManipulative } from "../authoring";
import type {
  ArraySpec,
  AreaPerimeterSpec,
  BalanceSpec,
  CoordinatePlaneSpec,
  DistributeSpec,
  DistributorSpec,
  RekenrekSpec,
  FunctionMachineSpec,
  ManipulativeSpec,
  NumberLineSpec,
  PartitionSpec,
  ProtractorSpec,
  RiemannSpec,
} from "../types";

const partitionWithGoal: PartitionSpec = {
  kind: "partition",
  id: "pt-1",
  concept: "Equivalent fractions",
  prompt: "Make one half.",
  discs: [{ parts: 4, shaded: 1 }],
  adjustable: ["parts", "shaded"],
  goal: { type: "shadedFractionEquals", disc: 0, value: 0.5 },
};

const partitionNoGoal: PartitionSpec = {
  ...partitionWithGoal,
  id: "pt-explainer",
  goal: undefined,
};

const numberLineWithGoal: NumberLineSpec = {
  kind: "numberline",
  id: "nl-1",
  concept: "Whole numbers",
  prompt: "Put the knob on 7.",
  min: 0,
  max: 10,
  tickStep: 1,
  start: 3,
  goal: { type: "placeAt", value: 7 },
};

const numberLineNoGoal: NumberLineSpec = { ...numberLineWithGoal, id: "nl-explainer", goal: undefined };

const commonMultipleLine: NumberLineSpec = {
  ...numberLineWithGoal,
  id: "nl-common-multiple",
  min: 0,
  max: 30,
  start: 0,
  multipleTracks: [3, 5],
  goal: { type: "firstCommonMultiple", tolerance: 0.5 },
};

const arrayWithGoal: ArraySpec = {
  kind: "array",
  id: "ar-1",
  concept: "Factors",
  prompt: "Build a rectangle of 12 tiles.",
  rows: 1,
  cols: 1,
  goal: { type: "productEquals", value: 12 },
};

const arrayNoGoal: ArraySpec = { ...arrayWithGoal, id: "ar-explainer", goal: undefined };

const balanceWithGoal: BalanceSpec = {
  kind: "balance",
  id: "bal-1",
  concept: "Equality",
  prompt: "Balance the scale.",
  left: 3,
  right: 1,
  adjustable: ["left", "right"],
  goal: { type: "balance" },
};

const balanceNoGoal: BalanceSpec = { ...balanceWithGoal, id: "bal-explainer", goal: undefined };

const areaPerimeterWithGoal: AreaPerimeterSpec = {
  kind: "areaPerimeter",
  id: "ap-1",
  concept: "Area vs. perimeter",
  prompt: "Maximize the area.",
  perimeter: 16,
  startWidth: 1,
  goal: { type: "maxArea" },
};

const areaPerimeterNoGoal: AreaPerimeterSpec = { ...areaPerimeterWithGoal, id: "ap-explainer", goal: undefined };

const distributeWithGoal: DistributeSpec = {
  kind: "distribute",
  id: "dist-1",
  concept: "Distributive property",
  prompt: "Split at column 5.",
  width: 8,
  height: 7,
  startColumn: 1,
  goal: { type: "splitAt", column: 5 },
};

const distributeNoGoal: DistributeSpec = { ...distributeWithGoal, id: "dist-explainer", goal: undefined };

const rekenrekWithGoal: RekenrekSpec = {
  kind: "rekenrek",
  id: "rack-1",
  concept: "Make-ten strategy",
  prompt: "Push 13 beads into a group of 10.",
  total: 13,
  goal: { type: "groupOf", value: 10 },
};

const rekenrekNoGoal: RekenrekSpec = { ...rekenrekWithGoal, id: "rack-explainer", goal: undefined };

const distributorWithGoal: DistributorSpec = {
  kind: "distributor",
  id: "share-1",
  concept: "Division as sharing",
  prompt: "Share 13 onto 4 plates.",
  total: 13,
  groups: 4,
  goal: { type: "shareEqually" },
};

const distributorNoGoal: DistributorSpec = { ...distributorWithGoal, id: "share-explainer", goal: undefined };

const riemannWithGoal: RiemannSpec = {
  kind: "riemann",
  id: "rie-1",
  concept: "Area under a graph",
  prompt: "Approximate the distance.",
  slope: 2,
  intercept: 0,
  tMax: 4,
  startBars: 1,
  goal: { type: "approximateWithin", tolerance: 1 },
};

const riemannNoGoal: RiemannSpec = { ...riemannWithGoal, id: "rie-explainer", goal: undefined };

const functionMachineSpec: FunctionMachineSpec = {
  kind: "functionMachine",
  id: "fm-1",
  concept: "Functions & patterns",
  prompt: "Figure out the rule.",
  rule: { op: "affine", m: 2, b: 0 },
  examples: [{ in: 1, out: 2 }],
  queryInput: 7,
};

const protractorConstructWithGoal: ProtractorSpec = {
  kind: "protractor",
  id: "pro-construct-1",
  concept: "Constructing angles",
  prompt: "Construct a 65° angle.",
  startDeg: 10,
  goal: { type: "constructAngle", targetDeg: 65 },
};

const protractorNoGoal: ProtractorSpec = { ...protractorConstructWithGoal, id: "pro-explainer", goal: undefined };

const coordinatePlaneWithGoal: CoordinatePlaneSpec = {
  kind: "coordinatePlane",
  id: "cp-1",
  concept: "Plotting a point",
  prompt: "Plot the point (4, 2).",
  xMin: 0,
  xMax: 8,
  yMin: 0,
  yMax: 8,
  gridStep: 1,
  draggable: [{ start: { x: 1, y: 6 } }],
  goal: { type: "placePoint", x: 4, y: 2 },
};

const coordinatePlaneNoGoal: CoordinatePlaneSpec = { ...coordinatePlaneWithGoal, id: "cp-explainer", goal: undefined };

describe("isGradableManipulative / assertGradableManipulative", () => {
  const gradable: ManipulativeSpec[] = [
    partitionWithGoal,
    numberLineWithGoal,
    arrayWithGoal,
    balanceWithGoal,
    areaPerimeterWithGoal,
    distributeWithGoal,
    rekenrekWithGoal,
    distributorWithGoal,
    riemannWithGoal,
    functionMachineSpec, // no `goal` field exists on this kind — always gradable
    protractorConstructWithGoal,
    coordinatePlaneWithGoal,
  ];

  it.each(gradable.map((spec) => [spec.kind, spec] as const))(
    "accepts a %s spec with a usable goal",
    (_kind, spec) => {
      expect(isGradableManipulative(spec)).toBe(true);
      expect(() => assertGradableManipulative(spec)).not.toThrow();
    },
  );

  const ungradable: ManipulativeSpec[] = [
    partitionNoGoal,
    numberLineNoGoal,
    arrayNoGoal,
    balanceNoGoal,
    areaPerimeterNoGoal,
    distributeNoGoal,
    rekenrekNoGoal,
    distributorNoGoal,
    riemannNoGoal,
    protractorNoGoal,
    coordinatePlaneNoGoal,
  ];

  it.each(ungradable.map((spec) => [spec.kind, spec] as const))(
    "rejects a %s explainer spec with no goal",
    (_kind, spec) => {
      expect(isGradableManipulative(spec)).toBe(false);
      expect(() => assertGradableManipulative(spec)).toThrow(/ungradable/i);
    },
  );

  it("rejects a partition shadedFractionEquals goal pointing at a disc that doesn't exist", () => {
    const spec: PartitionSpec = {
      ...partitionWithGoal,
      id: "pt-bad-disc",
      discs: [{ parts: 4, shaded: 1 }],
      goal: { type: "shadedFractionEquals", disc: 5, value: 0.5 },
    };
    expect(isGradableManipulative(spec)).toBe(false);
    expect(() => assertGradableManipulative(spec)).toThrow();
  });

  it("rejects a protractor spec whose starting angle already reads as solved", () => {
    // startDeg lands inside the goal's own tolerance band of the target — the
    // scholar would be handed a puzzle that's already done.
    const alreadySolvedExact: ProtractorSpec = {
      ...protractorConstructWithGoal,
      id: "pro-already-solved-exact",
      startDeg: 65, // exactly the target
    };
    expect(isGradableManipulative(alreadySolvedExact)).toBe(false);
    expect(() => assertGradableManipulative(alreadySolvedExact)).toThrow(/ungradable/i);

    const alreadySolvedWithinTolerance: ProtractorSpec = {
      ...protractorConstructWithGoal,
      id: "pro-already-solved-within-tolerance",
      startDeg: 66.5, // within the default ±2° of targetDeg: 65
    };
    expect(isGradableManipulative(alreadySolvedWithinTolerance)).toBe(false);
    expect(() => assertGradableManipulative(alreadySolvedWithinTolerance)).toThrow(/ungradable/i);
  });

  it("rejects a stale legacy 'measureAngle' spec loudly (that goal mode was killed — gameable)", () => {
    // Models a pre-existing DB row from before the measureAngle mode was
    // removed (2026-07, for being gameable: the answer was a drawn ray a kid
    // could visually match instead of reading the scale). `goal.type` here is
    // no longer a valid `ProtractorGoal` at the type level, so this is
    // deliberately cast through `unknown` the way a real untyped JSON blob
    // pulled from Convex storage would arrive — the guard must reject it
    // LOUDLY (throw) rather than let it render brokenly (a `targetDeg`-less
    // goal would otherwise silently read `NaN` and never be provably solved).
    const staleMeasureSpec = {
      ...protractorConstructWithGoal,
      id: "pro-stale-measure",
      goal: { type: "measureAngle", drawnDeg: 50 },
    } as unknown as ProtractorSpec;
    expect(isGradableManipulative(staleMeasureSpec)).toBe(false);
    expect(() => assertGradableManipulative(staleMeasureSpec)).toThrow(/ungradable/i);
  });

  it("the error message names the kind and id", () => {
    expect(() => assertGradableManipulative(partitionNoGoal)).toThrow(/partition/);
    expect(() => assertGradableManipulative(partitionNoGoal)).toThrow(/pt-explainer/);
  });

  it("accepts a well-formed array sideEqualsWithProduct goal (side evenly divides product)", () => {
    const spec: ArraySpec = {
      ...arrayWithGoal,
      id: "ar-side-6-of-24",
      goal: { type: "sideEqualsWithProduct", side: 6, product: 24 },
    };
    expect(isGradableManipulative(spec)).toBe(true);
    expect(() => assertGradableManipulative(spec)).not.toThrow();
  });

  it("rejects an array sideEqualsWithProduct goal where the side does not evenly divide the product", () => {
    // Authored wrong (e.g. a typo'd side/product pair) — no array can ever
    // satisfy "one side is 5 AND the total is 24" (24 / 5 is not an integer),
    // so this must never be persisted as a gradable item.
    const spec: ArraySpec = {
      ...arrayWithGoal,
      id: "ar-side-bad",
      goal: { type: "sideEqualsWithProduct", side: 5, product: 24 },
    };
    expect(isGradableManipulative(spec)).toBe(false);
    expect(() => assertGradableManipulative(spec)).toThrow(/ungradable/i);
  });

  it("accepts a well-formed array squareEquals goal (value is a perfect square)", () => {
    const spec: ArraySpec = {
      ...arrayWithGoal,
      id: "ar-square-16",
      goal: { type: "squareEquals", value: 16 },
    };
    expect(isGradableManipulative(spec)).toBe(true);
    expect(() => assertGradableManipulative(spec)).not.toThrow();
  });

  it("rejects an array squareEquals goal whose value isn't a perfect square", () => {
    // No square array can ever multiply to 20 — never persistable.
    const spec: ArraySpec = {
      ...arrayWithGoal,
      id: "ar-square-bad",
      goal: { type: "squareEquals", value: 20 },
    };
    expect(isGradableManipulative(spec)).toBe(false);
    expect(() => assertGradableManipulative(spec)).toThrow(/ungradable/i);
  });
});

describe("assertRenderableManipulative", () => {
  // Regression: initialStateFor's switch (in authoring.ts) previously had no
  // "rekenrek"/"distributor" cases and no default, so it silently returned
  // `undefined` for those two kinds instead of failing to typecheck. That
  // `undefined` state then crashed `rekenrekSolved`/`distributorSolved`
  // (e.g. `s.left` on `undefined`), which assertRenderableManipulative caught
  // and reported as "missing structural fields" — wrongly rejecting every
  // structurally-valid rekenrek/distributor spec, including the ones
  // already proven gradable above.
  it("accepts a structurally-valid rekenrek spec (does not throw)", () => {
    expect(() => assertRenderableManipulative(rekenrekWithGoal)).not.toThrow();
  });

  it("accepts a structurally-valid distributor spec (does not throw)", () => {
    expect(() => assertRenderableManipulative(distributorWithGoal)).not.toThrow();
  });

  it("accepts a structurally-valid protractor spec (does not throw)", () => {
    expect(() => assertRenderableManipulative(protractorConstructWithGoal)).not.toThrow();
  });

  it("still rejects a spec missing structural fields for a kind that DOES need them", () => {
    const brokenPartition: PartitionSpec = {
      kind: "partition",
      id: "pt-broken",
      concept: "Equivalent fractions",
      prompt: "Make one half.",
      // no `discs` — initialPartition(spec).discs would crash the renderer.
      discs: undefined as unknown as PartitionSpec["discs"],
      adjustable: ["parts", "shaded"],
      goal: { type: "discsEqualShadedArea" },
    };
    expect(() => assertRenderableManipulative(brokenPartition)).toThrow(/renderer/);
  });
});

describe("first common multiple authoring guards", () => {
  it("accepts valid tracks whose derived answer is in range and unsolved at start", () => {
    expect(isGradableManipulative(commonMultipleLine)).toBe(true);
  });

  it.each([
    { multipleTracks: undefined },
    { multipleTracks: [0, 5] as [number, number] },
    { multipleTracks: [3.5, 5] as [number, number] },
    { max: 14 },
    { start: 15 },
  ])("rejects invalid derived LCM configuration %#", (change) => {
    expect(isGradableManipulative({ ...commonMultipleLine, ...change })).toBe(false);
  });
});

describe("coordinatePlane authoring guards", () => {
  it("rejects a spec whose draggable already starts on the goal target (must not start solved)", () => {
    const alreadySolved: CoordinatePlaneSpec = {
      ...coordinatePlaneWithGoal,
      id: "cp-already-solved",
      draggable: [{ start: { x: 4, y: 2 } }], // == goal.{x:4,y:2}
    };
    expect(isGradableManipulative(alreadySolved)).toBe(false);
    expect(() => assertGradableManipulative(alreadySolved)).toThrow(/ungradable/i);
  });

  it("rejects a placePoints goal whose target count doesn't match the draggable count", () => {
    const mismatched: CoordinatePlaneSpec = {
      ...coordinatePlaneWithGoal,
      id: "cp-mismatched-count",
      draggable: [{ start: { x: 1, y: 1 } }, { start: { x: 2, y: 2 } }],
      goal: { type: "placePoints", points: [{ x: 5, y: 5 }] }, // 1 target, 2 draggables
    };
    expect(isGradableManipulative(mismatched)).toBe(false);
  });

  it("rejects a goal target that doesn't land exactly on a grid line", () => {
    const offGrid: CoordinatePlaneSpec = {
      ...coordinatePlaneWithGoal,
      id: "cp-off-grid",
      gridStep: 2,
      goal: { type: "placePoint", x: 3, y: 2 }, // 3 isn't a multiple of gridStep=2 from xMin=0
    };
    expect(isGradableManipulative(offGrid)).toBe(false);
  });

  it("rejects more than 3 draggable points", () => {
    const tooMany: CoordinatePlaneSpec = {
      ...coordinatePlaneWithGoal,
      id: "cp-too-many",
      draggable: [{ start: { x: 1, y: 1 } }, { start: { x: 2, y: 2 } }, { start: { x: 3, y: 3 } }, { start: { x: 4, y: 4 } }],
      goal: {
        type: "placePoints",
        points: [{ x: 5, y: 5 }, { x: 6, y: 6 }, { x: 7, y: 7 }, { x: 8, y: 8 }],
      },
    };
    expect(isGradableManipulative(tooMany)).toBe(false);
  });

  it("rejects a completeRectangle goal whose fixedPoints don't form a valid rectangle triple", () => {
    const badTriple: CoordinatePlaneSpec = {
      ...coordinatePlaneWithGoal,
      id: "cp-bad-triple",
      fixedPoints: [{ x: 0, y: 0 }, { x: 0, y: 1 }, { x: 0, y: 2 }], // colinear — no valid 4th corner
      draggable: [{ start: { x: 5, y: 5 } }],
      goal: { type: "completeRectangle" },
    };
    expect(isGradableManipulative(badTriple)).toBe(false);
  });

  it("accepts a well-formed reflectPoint spec", () => {
    const reflect: CoordinatePlaneSpec = {
      ...coordinatePlaneWithGoal,
      id: "cp-reflect",
      xMin: -6,
      xMax: 6,
      yMin: -6,
      yMax: 6,
      draggable: [{ start: { x: 2, y: 2 } }],
      goal: { type: "reflectPoint", point: { x: -4, y: 3 }, across: "x" },
    };
    expect(isGradableManipulative(reflect)).toBe(true);
    expect(() => assertGradableManipulative(reflect)).not.toThrow();
  });

  it("accepts every coordinatePlane example from the scholar-facing gallery", async () => {
    const { ALL_SPECS } = await import("@/components/manipulative/library");
    const coordinatePlaneSpecs = ALL_SPECS.filter(
      (s): s is CoordinatePlaneSpec => s.kind === "coordinatePlane",
    );
    // Sanity: the gallery actually authored some (one per goal type + an
    // explainer + extra credit) — this guard is meaningless against an empty list.
    expect(coordinatePlaneSpecs.length).toBeGreaterThanOrEqual(4);
    for (const spec of coordinatePlaneSpecs) {
      if (spec.goal == null) {
        expect(() => assertRenderableManipulative(spec)).not.toThrow();
        continue;
      }
      expect(isGradableManipulative(spec)).toBe(true);
      expect(() => assertGradableManipulative(spec)).not.toThrow();
      expect(() => assertRenderableManipulative(spec)).not.toThrow();
    }
  });
});
