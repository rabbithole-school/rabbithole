import { describe, expect, test } from "vitest";
import { goalText, describeState } from "../logic";
import type {
  ArraySpec,
  AreaPerimeterSpec,
  BalanceSpec,
  CoordinatePlaneSpec,
  DiceSpec,
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

/**
 * Unit tests for the tutor-facing describers (U-4): `goalText` restates the
 * TASK and `describeState` describes the CURRENT board — across all 14 kinds,
 * with the load-bearing no-solution-leak property for compute-style goals (the
 * derived answer must appear in NEITHER output). See the describer header in
 * lib/manipulative/logic.ts.
 */

// Minimal ManipulativeMeta each spec needs (id/concept/prompt).
const meta = (id: string, concept: string, prompt: string) => ({ id, concept, prompt });

// ── one representative spec per kind (challenge form) ────────────────────────
const partition: PartitionSpec = {
  ...meta("p", "Unit fractions", "Make one half."),
  kind: "partition",
  discs: [{ parts: 2, shaded: 0 }],
  adjustable: ["parts", "shaded"],
  goal: { type: "shadedFractionEquals", disc: 0, value: 0.5 },
};
const numberline: NumberLineSpec = {
  ...meta("n", "Number sense", "Place 7."),
  kind: "numberline",
  min: 0,
  max: 10,
  tickStep: 1,
  start: 0,
  goal: { type: "placeAt", value: 7 },
};
const array: ArraySpec = {
  ...meta("a", "Multiplication", "Make 12."),
  kind: "array",
  rows: 1,
  cols: 1,
  goal: { type: "productEquals", value: 12 },
};
const balance: BalanceSpec = {
  ...meta("b", "Equality", "Balance it."),
  kind: "balance",
  left: 3,
  right: 1,
  adjustable: ["left", "right"],
  goal: { type: "balance" },
};
const distribute: DistributeSpec = {
  ...meta("d", "Distributive property", "Split it."),
  kind: "distribute",
  width: 6,
  height: 3,
  startColumn: 1,
  goal: { type: "splitAt", column: 4 },
};
const rekenrek: RekenrekSpec = {
  ...meta("rk", "Make-ten strategy", "Group of 10."),
  kind: "rekenrek",
  total: 13,
  goal: { type: "groupOf", value: 10 },
};
const riemann: RiemannSpec = {
  ...meta("r", "Area under a curve", "Estimate the distance."),
  kind: "riemann",
  slope: 1,
  intercept: 0,
  tMax: 4,
  startBars: 2,
  goal: { type: "approximateWithin", tolerance: 0.5 },
};
describe("goalText — restates the task for each of the 14 kinds", () => {
  const cases: Array<[string, ManipulativeSpec, RegExp]> = [
    ["partition", partition, /1\/2/],
    ["numberline", numberline, /\b7\b/],
    ["array (product)", array, /\b12\b/],
    ["balance", balance, /balance/i],
    ["areaPerimeter (areaEquals)", areaPerimeterEqual(), /\b15\b/],
    ["distribute", distribute, /column 4/],
    ["rekenrek", rekenrek, /\b10\b/],
    ["distributor", distributorSpec(), /17 counters/],
    ["riemann", riemann, /left-sum bars/i],
    ["functionMachine", functionMachineSpec(), /input is 10/],
    ["dice (favorableCount)", diceSpec(), /even number/],
    ["protractor (construct)", protractorConstruct(), /65°/],
    ["coordinatePlane (placePoint)", coordPlacePoint(), /\(3, 4\)/],
  ];
  test.each(cases)("%s produces a non-empty task string", (_name, spec, re) => {
    const text = goalText(spec);
    expect(text.length).toBeGreaterThan(0);
    expect(text).toMatch(re);
  });
});

describe("describeState — describes the current board for each of the 14 kinds", () => {
  const cases: Array<[string, ManipulativeSpec, string, RegExp]> = [
    ["partition", partition, JSON.stringify({ discs: [{ parts: 4, shaded: 1 }] }), /1\/4/],
    ["numberline", numberline, JSON.stringify({ value: 3 }), /\b3\b/],
    ["array", array, JSON.stringify({ rows: 2, cols: 5 }), /2 by 5/],
    ["balance", balance, JSON.stringify({ left: 3, right: 1 }), /left pan holds 3/],
    ["areaPerimeter", areaPerimeterEqual(), JSON.stringify({ width: 2 }), /2 wide/],
    ["distribute", distribute, JSON.stringify({ column: 2 }), /column 2/],
    ["rekenrek", rekenrek, JSON.stringify({ left: 4 }), /4 beads pushed to the left/],
    ["distributor", distributorSpec(), JSON.stringify({ perGroup: 1 }), /leftover pile/],
    ["riemann", riemann, JSON.stringify({ bars: 3 }), /3 left-sum bars/],
    ["functionMachine", functionMachineSpec(), JSON.stringify({ predicted: 99 }), /is 99/],
    ["dice", diceSpec(), JSON.stringify({ rollCount: 4, predicted: { num: 5, den: 1 } }), /predicted 5/],
    ["protractor", protractorConstruct(), JSON.stringify({ angleDeg: 40 }), /40°/],
    ["coordinatePlane", coordPlacePoint(), JSON.stringify({ points: [{ x: 1, y: 1 }] }), /\(1, 1\)/],
  ];
  test.each(cases)("%s describes the board", (_name, spec, stateJson, re) => {
    const text = describeState(spec, stateJson);
    expect(text.length).toBeGreaterThan(0);
    expect(text).toMatch(re);
  });

  test("malformed / kind-mismatched JSON is total (neutral fallback, never throws)", () => {
    expect(() => describeState(partition, "not json {")).not.toThrow();
    expect(describeState(partition, "not json {")).toMatch(/hasn't been changed yet/);
    // A valid-JSON but wrong-shape payload also degrades gracefully.
    expect(() => describeState(partition, JSON.stringify({ nope: true }))).not.toThrow();
  });
});

// ── no-solution-leak property (compute-style goals) ──────────────────────────
// For every goal where the kid must COMPUTE the answer, the derived answer must
// appear in NEITHER goalText NOR describeState (of a plausible wrong state). We
// match on whole-number TOKENS (\b…\b) so "3" doesn't spuriously "appear" inside
// "13"/"30", and pick each wrong state so its own visible numbers never collide
// with a forbidden answer. This is the load-bearing anti-offloading guarantee.
function hasToken(text: string, token: string): boolean {
  const escaped = token.replace(/[.*+?^${}()|[\]\\-]/g, "\\$&");
  return new RegExp(`(^|[^\\w-])${escaped}([^\\w]|$)`).test(text);
}

describe("no-solution-leak: derived answers never appear (compute-style goals)", () => {
  const cases: Array<{ name: string; spec: ManipulativeSpec; wrongState: unknown; forbidden: string[] }> = [
    {
      // 17 ÷ 5 = 3 remainder 2 — never state 3 or 2. Wrong deal: 1 each (leftover 12).
      name: "distributor quotient + remainder",
      spec: distributorSpec(),
      wrongState: { perGroup: 1 },
      forbidden: ["3", "2"],
    },
    {
      // factor-pair COUNT of 12 is 3 — never state 3. Wrong array: 2×5.
      name: "array factorPairCount",
      spec: factorPairSpec(),
      wrongState: { rows: 2, cols: 5 },
      forbidden: ["3"],
    },
    {
      // maxArea for perimeter 12 is 9 — never state 9. Wrong width 1 → area 5.
      name: "areaPerimeter maxArea",
      spec: maxAreaSpec(),
      wrongState: { width: 1 },
      forbidden: ["9"],
    },
    {
      // machine output for input 10 (out = 2·in + 1) is 21 — never state 21.
      name: "functionMachine output",
      spec: functionMachineSpec(),
      wrongState: { predicted: 99 },
      forbidden: ["21"],
    },
    {
      // P(even on a d6) = 3 favorable — never state 3. Wrong prediction 5.
      name: "dice favorableCount",
      spec: diceSpec(),
      wrongState: { rollCount: 0, predicted: { num: 5, den: 1 } },
      forbidden: ["3"],
    },
    {
      // reflection of (3,2) across x is (3,-2) — never state the image -2.
      name: "coordinatePlane reflectPoint image",
      spec: coordReflect(),
      wrongState: { points: [{ x: 1, y: 1 }] },
      forbidden: ["-2"],
    },
    {
      // completeRectangle missing corner is (4,3) — never state 4 or 3.
      // (goalText enumerates none of the corners; wrong state is (1,1).)
      name: "coordinatePlane completeRectangle corner",
      spec: coordCompleteRect(),
      wrongState: { points: [{ x: 1, y: 1 }] },
      forbidden: ["4", "3"],
    },
    {
      // hidden mystery block is worth 5 — never state 5. Wrong pans 2 / 1.
      name: "balance mystery weight",
      spec: balanceMystery(),
      wrongState: { left: 2, right: 1 },
      forbidden: ["5"],
    },
    {
      // LCM(3,5) is 15 — the tracks are named, but their first coincidence is not.
      name: "number line first common multiple",
      spec: {
        ...meta("lcm-no-leak", "Least common multiple", "Reveal both tracks."),
        kind: "numberline",
        min: 0,
        max: 30,
        tickStep: 5,
        snap: 1,
        start: 0,
        multipleTracks: [3, 5],
        goal: { type: "firstCommonMultiple" },
      },
      wrongState: { value: 30 },
      forbidden: ["15"],
    },
  ];

  test.each(cases)("$name leaks nothing", ({ spec, wrongState, forbidden }) => {
    const gt = goalText(spec);
    const ds = describeState(spec, JSON.stringify(wrongState));
    for (const answer of forbidden) {
      expect(hasToken(gt, answer), `goalText leaked "${answer}": ${gt}`).toBe(false);
      expect(hasToken(ds, answer), `describeState leaked "${answer}": ${ds}`).toBe(false);
    }
  });
});

// ── spec factories (kept local so the tables above read cleanly) ─────────────
function areaPerimeterEqual(): AreaPerimeterSpec {
  return {
    ...meta("apE", "Area & perimeter", "Fence 15 sq units."),
    kind: "areaPerimeter",
    perimeter: 16,
    startWidth: 1,
    goal: { type: "areaEquals", value: 15 },
  };
}
function maxAreaSpec(): AreaPerimeterSpec {
  return {
    ...meta("apM", "Area & perimeter", "Biggest pen."),
    kind: "areaPerimeter",
    perimeter: 12,
    startWidth: 1,
    goal: { type: "maxArea" },
  };
}
function distributorSpec(): DistributorSpec {
  return {
    ...meta("ds", "Division as sharing", "Share 17 onto 5 plates."),
    kind: "distributor",
    total: 17,
    groups: 5,
    goal: { type: "shareEqually" },
  };
}
function factorPairSpec(): ArraySpec {
  return {
    ...meta("fp", "Factors", "Factor pairs of 12."),
    kind: "array",
    rows: 1,
    cols: 1,
    goal: { type: "factorPairCountEquals", product: 12, count: 3 },
  };
}
function functionMachineSpec(): FunctionMachineSpec {
  return {
    ...meta("fm", "Functions", "Find the rule."),
    kind: "functionMachine",
    rule: { op: "affine", m: 2, b: 1 },
    examples: [
      { in: 2, out: 5 },
      { in: 6, out: 13 },
    ],
    queryInput: 10,
  };
}
function diceSpec(): DiceSpec {
  return {
    ...meta("dc", "Probability", "How many even faces?"),
    kind: "dice",
    diceType: "d6",
    prediction: { type: "favorableCount", event: { type: "even" } },
  };
}
function protractorConstruct(): ProtractorSpec {
  return {
    ...meta("pc", "Angles", "Construct 65°."),
    kind: "protractor",
    startDeg: 10,
    goal: { type: "constructAngle", targetDeg: 65 },
  };
}
function coordPlacePoint(): CoordinatePlaneSpec {
  return {
    ...meta("cp", "Coordinates", "Plot (3, 4)."),
    kind: "coordinatePlane",
    xMin: 0,
    xMax: 10,
    yMin: 0,
    yMax: 10,
    gridStep: 1,
    draggable: [{ start: { x: 0, y: 0 } }],
    goal: { type: "placePoint", x: 3, y: 4 },
  };
}
function coordReflect(): CoordinatePlaneSpec {
  return {
    ...meta("cr", "Reflections", "Reflect across x."),
    kind: "coordinatePlane",
    xMin: -6,
    xMax: 6,
    yMin: -6,
    yMax: 6,
    gridStep: 1,
    draggable: [{ start: { x: 0, y: 0 } }],
    goal: { type: "reflectPoint", point: { x: 3, y: 2 }, across: "x" },
  };
}
function coordCompleteRect(): CoordinatePlaneSpec {
  return {
    ...meta("crr", "Rectangles", "Complete the rectangle."),
    kind: "coordinatePlane",
    xMin: 0,
    xMax: 8,
    yMin: 0,
    yMax: 8,
    gridStep: 1,
    fixedPoints: [
      { x: 0, y: 0 },
      { x: 4, y: 0 },
      { x: 0, y: 3 },
    ],
    draggable: [{ start: { x: 1, y: 1 } }],
    goal: { type: "completeRectangle" },
  };
}
function balanceMystery(): BalanceSpec {
  return {
    ...meta("bm", "Solve for x", "Balance with the mystery block."),
    kind: "balance",
    left: 2,
    right: 1,
    adjustable: ["left"],
    mysteryRight: 5,
    goal: { type: "balance" },
  };
}
