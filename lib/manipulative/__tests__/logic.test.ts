import { describe, expect, test } from "vitest";
import {
  advanceSequence,
  approxEqual,
  answerSolved,
  applyFunctionMachineRule,
  areaPerimeterArea,
  areaPerimeterSolved,
  arraySolved,
  balanceSolved,
  balanceTilt,
  clamp,
  coordinatePlaneSolved,
  countFactorPairs,
  currentSequenceStep,
  distributeSolved,
  distributorPerGroupMax,
  distributorRemainder,
  distributorSolved,
  rekenrekGeometry,
  rekenrekSolved,
  initialCoordinatePlane,
  initialRekenrek,
  fractionValue,
  functionMachineSolved,
  functionMachineStateFromTypedAnswer,
  gcd,
  heightForPerimeter,
  initialProtractor,
  isSequenceComplete,
  isSolved,
  leftSumArea,
  maxAreaForPerimeter,
  numberLineSolved,
  partitionSolved,
  pointSetsEqual,
  protractorSolved,
  rectangleMissingCorner,
  riemannSolved,
  sequenceProgress,
  trueArea,
} from "../logic";
import type {
  AreaPerimeterSpec,
  ArraySpec,
  BalanceSpec,
  CoordinatePlaneSpec,
  DistributeSpec,
  DistributorSpec,
  RekenrekSpec,
  FunctionMachineSpec,
  MultiStepSequenceSpec,
  NumberLineSpec,
  PartitionSpec,
  ProtractorSpec,
  RiemannSpec,
} from "../types";
import { isChallenge } from "../types";
import { gradeManipulativeSubmission } from "../grade";

describe("utilities", () => {
  test("clamp / gcd / fractionValue", () => {
    expect(clamp(5, 0, 3)).toBe(3);
    expect(clamp(-1, 0, 3)).toBe(0);
    expect(gcd(12, 8)).toBe(4);
    expect(gcd(7, 0)).toBe(7);
    expect(fractionValue(3, 6)).toBe(0.5);
    expect(fractionValue(1, 0)).toBe(0);
    expect(countFactorPairs(36)).toBe(5);
  });
  test("approxEqual tolerance", () => {
    expect(approxEqual(0.1 + 0.2, 0.3)).toBe(true);
    expect(approxEqual(0.5, 0.51, 0.02)).toBe(true);
    expect(approxEqual(0.5, 0.6, 0.02)).toBe(false);
  });
  test("perimeter geometry", () => {
    expect(heightForPerimeter(24, 6)).toBe(6);
    expect(heightForPerimeter(24, 11)).toBe(1);
    expect(maxAreaForPerimeter(24)).toBe(36); // 6x6
    expect(maxAreaForPerimeter(20)).toBe(25); // 5x5
  });
  test("typed answers compare numeric commitments", () => {
    expect(answerSolved({ value: 3 }, "3")).toBe(true);
    expect(answerSolved({ value: 3 }, "3.0")).toBe(true);
    expect(answerSolved({ value: 3 }, "")).toBe(false);
    expect(answerSolved({ value: 3 }, "4")).toBe(false);
  });
});

const partition = (over: Partial<PartitionSpec>): PartitionSpec => ({
  kind: "partition",
  id: "t",
  concept: "c",
  prompt: "p",
  discs: [{ parts: 2, shaded: 1 }],
  adjustable: ["parts", "shaded"],
  ...over,
});

describe("partitionSolved", () => {
  test("no goal is never solved", () => {
    expect(partitionSolved(partition({}), { discs: [{ parts: 2, shaded: 1 }] })).toBe(false);
  });
  test("shadedFractionEquals accepts any equivalent fraction", () => {
    const spec = partition({ goal: { type: "shadedFractionEquals", disc: 0, value: 0.5 } });
    expect(partitionSolved(spec, { discs: [{ parts: 2, shaded: 1 }] })).toBe(true);
    expect(partitionSolved(spec, { discs: [{ parts: 4, shaded: 2 }] })).toBe(true);
    expect(partitionSolved(spec, { discs: [{ parts: 6, shaded: 3 }] })).toBe(true);
    expect(partitionSolved(spec, { discs: [{ parts: 3, shaded: 1 }] })).toBe(false);
  });
  test("discsEqualShadedArea requires non-zero equal areas", () => {
    const spec = partition({ discs: [{ parts: 2, shaded: 1 }, { parts: 6, shaded: 1 }], goal: { type: "discsEqualShadedArea" } });
    expect(partitionSolved(spec, { discs: [{ parts: 2, shaded: 1 }, { parts: 6, shaded: 3 }] })).toBe(true);
    expect(partitionSolved(spec, { discs: [{ parts: 2, shaded: 1 }, { parts: 6, shaded: 1 }] })).toBe(false);
    expect(partitionSolved(spec, { discs: [{ parts: 2, shaded: 0 }, { parts: 6, shaded: 0 }] })).toBe(false);
  });
});

const line = (over: Partial<NumberLineSpec>): NumberLineSpec => ({
  kind: "numberline",
  id: "t",
  concept: "c",
  prompt: "p",
  min: 0,
  max: 10,
  tickStep: 1,
  start: 0,
  ...over,
});

describe("numberLineSolved", () => {
  test("placeAt within default tolerance", () => {
    const spec = line({ goal: { type: "placeAt", value: 7 } });
    expect(numberLineSolved(spec, { value: 7 })).toBe(true);
    expect(numberLineSolved(spec, { value: 7.2 })).toBe(true); // 0.3 tol on 0..10
    expect(numberLineSolved(spec, { value: 8 })).toBe(false);
  });
  test("placeFraction converts and compares", () => {
    const spec = line({ min: 0, max: 1, tickStep: 0.25, goal: { type: "placeFraction", num: 3, den: 4 } });
    expect(numberLineSolved(spec, { value: 0.75 })).toBe(true);
    expect(numberLineSolved(spec, { value: 0.5 })).toBe(false);
  });
});

const pro = (over: Partial<ProtractorSpec>): ProtractorSpec => ({
  kind: "protractor",
  id: "t",
  concept: "c",
  prompt: "p",
  startDeg: 10,
  ...over,
});

describe("protractorSolved", () => {
  test("no goal is never solved", () => {
    expect(initialProtractor(pro({ startDeg: 50 }))).toEqual({ angleDeg: 50 });
    expect(protractorSolved(pro({}), { angleDeg: 10 })).toBe(false);
  });

  test("constructAngle: the initial free-ray position is not solved", () => {
    const spec = pro({ startDeg: 10, goal: { type: "constructAngle", targetDeg: 65 } });
    expect(protractorSolved(spec, initialProtractor(spec))).toBe(false);
  });
  test("constructAngle: solved once the free ray reads the target within tolerance", () => {
    const spec = pro({ goal: { type: "constructAngle", targetDeg: 65 } });
    expect(protractorSolved(spec, { angleDeg: 65 })).toBe(true);
    expect(protractorSolved(spec, { angleDeg: 66.5 })).toBe(true); // default ±2°
    expect(protractorSolved(spec, { angleDeg: 68 })).toBe(false);
    expect(protractorSolved(spec, { angleDeg: 60 })).toBe(false);
  });
  test("constructAngle: a custom tolerance is honored", () => {
    const spec = pro({ goal: { type: "constructAngle", targetDeg: 65, tolerance: 5 } });
    expect(protractorSolved(spec, { angleDeg: 69 })).toBe(true);
    expect(protractorSolved(spec, { angleDeg: 71 })).toBe(false);
  });
});

const arr = (over: Partial<ArraySpec>): ArraySpec => ({
  kind: "array",
  id: "t",
  concept: "c",
  prompt: "p",
  rows: 1,
  cols: 1,
  ...over,
});

describe("arraySolved", () => {
  test("productEquals accepts every factor pair (commutativity)", () => {
    const spec = arr({ goal: { type: "productEquals", value: 12 } });
    for (const [r, c] of [[3, 4], [4, 3], [2, 6], [6, 2], [1, 12], [12, 1]]) {
      expect(arraySolved(spec, { rows: r, cols: c })).toBe(true);
    }
    expect(arraySolved(spec, { rows: 3, cols: 5 })).toBe(false);
  });
  test("factorPairCountEquals checks the product and its unordered factor pairs", () => {
    const spec = arr({ goal: { type: "factorPairCountEquals", product: 36, count: 5 } });
    expect(arraySolved(spec, { rows: 6, cols: 6 })).toBe(true);
    expect(arraySolved(spec, { rows: 4, cols: 9 })).toBe(true);
    expect(arraySolved(spec, { rows: 5, cols: 7 })).toBe(false);
  });
  test("sideEqualsWithProduct requires the SPECIFIC side, not just any factor pair sharing the product", () => {
    const spec = arr({ goal: { type: "sideEqualsWithProduct", side: 6, product: 24 } });
    // Either orientation of the required side counts (commutativity)…
    expect(arraySolved(spec, { rows: 6, cols: 4 })).toBe(true);
    expect(arraySolved(spec, { rows: 4, cols: 6 })).toBe(true);
    // …but a DIFFERENT factor pair with the same product must NOT pass, even
    // though it satisfies bare productEquals — this is the exact regression
    // the tightened goal exists to close (review finding, wave-2 content
    // coverage: a 3×8 array must not prove "6 is a factor of 24").
    expect(arraySolved(spec, { rows: 3, cols: 8 })).toBe(false);
    expect(arraySolved(spec, { rows: 2, cols: 12 })).toBe(false);
    expect(arraySolved(spec, { rows: 1, cols: 24 })).toBe(false);
  });
  test("squareEquals requires rows === cols, not just any factor pair of the value", () => {
    const spec = arr({ goal: { type: "squareEquals", value: 16 } });
    expect(arraySolved(spec, { rows: 4, cols: 4 })).toBe(true);
    // A non-square factor pair must NOT pass even though it shares the
    // product — a 2×8 array does not prove "4² = 16".
    expect(arraySolved(spec, { rows: 2, cols: 8 })).toBe(false);
    expect(arraySolved(spec, { rows: 1, cols: 16 })).toBe(false);
    // Wrong product, still square — also not solved.
    expect(arraySolved(spec, { rows: 5, cols: 5 })).toBe(false);
  });
});

const bal = (over: Partial<BalanceSpec>): BalanceSpec => ({
  kind: "balance",
  id: "t",
  concept: "c",
  prompt: "p",
  left: 0,
  right: 0,
  adjustable: ["left", "right"],
  ...over,
});

describe("balance", () => {
  test("tilt accounts for the mystery block", () => {
    const spec = bal({ mysteryRight: 3, goal: { type: "balance" } });
    expect(balanceTilt(spec, { left: 5, right: 2 })).toBe(0);
    expect(balanceSolved(spec, { left: 5, right: 2 })).toBe(true); // 5 = 2 + 3
    expect(balanceSolved(spec, { left: 4, right: 2 })).toBe(false);
  });
  test("no goal never solved", () => {
    expect(balanceSolved(bal({}), { left: 1, right: 1 })).toBe(false);
  });
});

const ap = (over: Partial<AreaPerimeterSpec>): AreaPerimeterSpec => ({
  kind: "areaPerimeter",
  id: "t",
  concept: "c",
  prompt: "p",
  perimeter: 24,
  startWidth: 2,
  ...over,
});

describe("areaPerimeter", () => {
  test("area = w * h", () => {
    expect(areaPerimeterArea(ap({}), { width: 6 })).toBe(36);
    expect(areaPerimeterArea(ap({}), { width: 11 })).toBe(11);
  });
  test("maxArea solved only at the square", () => {
    const spec = ap({ goal: { type: "maxArea" } });
    expect(areaPerimeterSolved(spec, { width: 6 })).toBe(true);
    expect(areaPerimeterSolved(spec, { width: 5 })).toBe(false);
  });
  test("areaEquals target", () => {
    const spec = ap({ goal: { type: "areaEquals", value: 20 } });
    expect(areaPerimeterSolved(spec, { width: 2 })).toBe(true); // 2x10
    expect(areaPerimeterSolved(spec, { width: 10 })).toBe(true); // 10x2
    expect(areaPerimeterSolved(spec, { width: 6 })).toBe(false);
  });
});

const dist = (over: Partial<DistributeSpec>): DistributeSpec => ({
  kind: "distribute",
  id: "t",
  concept: "c",
  prompt: "p",
  width: 8,
  height: 7,
  startColumn: 2,
  ...over,
});

describe("distribute", () => {
  test("splitAt checks the integer split column", () => {
    const spec = dist({ goal: { type: "splitAt", column: 5 } });
    expect(distributeSolved(spec, { column: 5 })).toBe(true);
    expect(distributeSolved(spec, { column: 4 })).toBe(false);
  });
  test("no goal never solved", () => {
    expect(distributeSolved(dist({}), { column: 5 })).toBe(false);
  });
});

const rack = (over: Partial<RekenrekSpec>): RekenrekSpec => ({
  kind: "rekenrek",
  id: "t",
  concept: "c",
  prompt: "p",
  total: 10,
  ...over,
});

describe("rekenrek", () => {
  test("groupOf accepts a group of the target on EITHER side", () => {
    const spec = rack({ total: 13, goal: { type: "groupOf", value: 10 } });
    expect(rekenrekSolved(spec, { left: 10 })).toBe(true); // left group of 10
    expect(rekenrekSolved(spec, { left: 3 })).toBe(true); // right group of 10
    expect(rekenrekSolved(spec, { left: 7 })).toBe(false);
    expect(rekenrekSolved(spec, { left: 0 })).toBe(false);
  });
  test("no goal never solved", () => {
    expect(rekenrekSolved(rack({}), { left: 5 })).toBe(false);
  });
  test("initialRekenrek clamps the start into [0, total]", () => {
    expect(initialRekenrek(rack({ total: 8, startLeft: 20 })).left).toBe(8);
    expect(initialRekenrek(rack({ total: 8, startLeft: -3 })).left).toBe(0);
    expect(initialRekenrek(rack({ total: 8 })).left).toBe(0);
  });
});

describe("rekenrekGeometry", () => {
  // Mirror the renderers' rest-position formulas at both fully packed extremes.
  const fits = (width: number, sizingCount: number) => {
    const { D, railLeft, railRight } = rekenrekGeometry(width, sizingCount);
    const fullyLeft = [railLeft, railLeft + (sizingCount - 1) * D];
    const fullyRight = [railRight - (sizingCount - 1) * D, railRight];
    return [fullyLeft, fullyRight].every(
      ([first, last]) => first - D / 2 >= 0 && last + D / 2 <= width,
    );
  };

  test("both packed extremes fit the stage at every plausible width", () => {
    for (let width = 300; width <= 900; width += 4) {
      for (const sizingCount of [1, 4, 5, 7, 10]) {
        expect(fits(width, sizingCount), `${sizingCount} beads at ${width}px`).toBe(true);
      }
    }
  });

  test("a ten-bead rod shrinks below the 44px finger target in the practice column", () => {
    // PracticeSession's column is 460px; the Manipulative card's padding leaves
    // ~420px of stage. Ten 44px beads need 468px, which is what overflowed.
    const { D } = rekenrekGeometry(420, 10);
    expect(D).toBeLessThan(44);
    expect(fits(420, 10)).toBe(true);
  });

  test("a wide stage still reaches the 44px target and caps at 56", () => {
    expect(rekenrekGeometry(600, 10).D).toBeGreaterThanOrEqual(44);
    expect(rekenrekGeometry(560, 5).D).toBe(56);
    expect(rekenrekGeometry(2000, 10).D).toBe(56);
  });

  test("the rail keeps slack so a split shows a gap, not a seam", () => {
    for (const width of [360, 420, 560]) {
      const { D } = rekenrekGeometry(width, 10);
      const bareRail = width - 2 * 14 - 10 * D;
      expect(bareRail, `${width}px`).toBeGreaterThanOrEqual(D);
    }
  });

  test("an unmeasured stage degrades to the minimum bead rather than NaN", () => {
    expect(rekenrekGeometry(0, 10).D).toBe(24);
  });
});

const share = (over: Partial<DistributorSpec>): DistributorSpec => ({
  kind: "distributor",
  id: "t",
  concept: "c",
  prompt: "p",
  total: 13,
  groups: 4,
  ...over,
});

describe("distributor", () => {
  test("shareEqually is solved only at the max equal deal (true quotient)", () => {
    const spec = share({ total: 13, groups: 4, goal: { type: "shareEqually" } });
    expect(distributorPerGroupMax(spec)).toBe(3);
    expect(distributorSolved(spec, { perGroup: 3 })).toBe(true);
    expect(distributorSolved(spec, { perGroup: 2 })).toBe(false); // under-dealt
    expect(distributorRemainder(spec, { perGroup: 3 })).toBe(1); // true remainder
    expect(distributorRemainder(spec, { perGroup: 2 })).toBe(5);
  });
  test("exact division leaves no remainder", () => {
    const spec = share({ total: 12, groups: 4, goal: { type: "shareEqually" } });
    expect(distributorSolved(spec, { perGroup: 3 })).toBe(true);
    expect(distributorRemainder(spec, { perGroup: 3 })).toBe(0);
  });
  test("no goal never solved", () => {
    expect(distributorSolved(share({}), { perGroup: 3 })).toBe(false);
  });
});

const rie = (over: Partial<RiemannSpec>): RiemannSpec => ({
  kind: "riemann",
  id: "t",
  concept: "c",
  prompt: "p",
  slope: 2,
  intercept: 1,
  tMax: 4,
  startBars: 4,
  ...over,
});

describe("riemann", () => {
  test("trueArea integrates the speed line", () => {
    expect(trueArea(rie({}))).toBe(20);
  });
  test("leftSumArea uses left endpoints", () => {
    expect(leftSumArea(rie({}), 4)).toBe(16);
  });
  test("approximateWithin compares estimate to true area", () => {
    const spec = rie({ slope: 0.5, intercept: 1, tMax: 8, goal: { type: "approximateWithin", tolerance: 1 } });
    expect(riemannSolved(spec, { bars: 4 })).toBe(false);
    expect(riemannSolved(spec, { bars: 16 })).toBe(true);
  });
});

const fm = (over: Partial<FunctionMachineSpec>): FunctionMachineSpec => ({
  kind: "functionMachine",
  id: "t",
  concept: "c",
  prompt: "p",
  rule: { op: "affine", m: 2, b: 0 },
  examples: [
    { in: 1, out: 2 },
    { in: 3, out: 6 },
  ],
  queryInput: 7,
  answer: { value: 14, prompt: "What comes out when 7 goes in?" },
  ...over,
});

describe("functionMachine", () => {
  test("applyFunctionMachineRule computes m·in + b", () => {
    expect(applyFunctionMachineRule({ op: "affine", m: 2, b: 0 }, 7)).toBe(14);
    expect(applyFunctionMachineRule({ op: "affine", m: 1, b: 3 }, 20)).toBe(23);
    expect(applyFunctionMachineRule({ op: "affine", m: 2, b: 1 }, 6)).toBe(13);
  });
  test("solved when the prediction matches rule(queryInput)", () => {
    const spec = fm({});
    expect(functionMachineSolved(spec, { predicted: 14 })).toBe(true);
  });
  test("near-miss: off-by-one / wrong-rule prediction is not solved", () => {
    const spec = fm({});
    expect(functionMachineSolved(spec, { predicted: 13 })).toBe(false); // off by one
    expect(functionMachineSolved(spec, { predicted: 9 })).toBe(false); // mistook it for +2
  });
  test("no prediction yet is not solved", () => {
    expect(functionMachineSolved(fm({}), { predicted: null })).toBe(false);
  });
  test("a +b rule (not just ×m) is handled the same way", () => {
    const spec = fm({ rule: { op: "affine", m: 1, b: 3 }, queryInput: 20, answer: { value: 23, prompt: "p" } });
    expect(functionMachineSolved(spec, { predicted: 23 })).toBe(true);
    expect(functionMachineSolved(spec, { predicted: 20 })).toBe(false);
  });
});

describe("functionMachineStateFromTypedAnswer", () => {
  // This is the EXACT mapping `FunctionMachineManipulative` runs to echo the
  // frame's typed answer into the shared `state` channel practice mode
  // submits (a real bug fixed 2026-08-03: the renderer used to never emit
  // any state at all, so practice-mode Done could never fire for a
  // functionMachine item). Driving `isSolved` through this function — as the
  // convex seed tests now do — exercises the SAME mapping the renderer runs,
  // instead of hand-constructing a `{predicted}` object that could silently
  // drift from what typing actually produces.
  test("a valid typed integer becomes {predicted: n}", () => {
    expect(functionMachineStateFromTypedAnswer("14")).toEqual({ predicted: 14 });
    expect(functionMachineStateFromTypedAnswer("-3")).toEqual({ predicted: -3 });
    expect(functionMachineStateFromTypedAnswer("  7  ")).toEqual({ predicted: 7 });
  });
  test("empty or whitespace-only input is null — nothing committed yet", () => {
    expect(functionMachineStateFromTypedAnswer("")).toBeNull();
    expect(functionMachineStateFromTypedAnswer("   ")).toBeNull();
    expect(functionMachineStateFromTypedAnswer(undefined)).toBeNull();
    expect(functionMachineStateFromTypedAnswer(null)).toBeNull();
  });
  test("non-numeric input is null, never a garbage prediction", () => {
    expect(functionMachineStateFromTypedAnswer("abc")).toBeNull();
    expect(functionMachineStateFromTypedAnswer("14x")).toBeNull();
  });
  test("round-trips through isSolved exactly like the renderer would", () => {
    const spec = fm({});
    expect(isSolved(spec, functionMachineStateFromTypedAnswer("14"))).toBe(true);
    expect(isSolved(spec, functionMachineStateFromTypedAnswer("13"))).toBe(false);
  });
  test("an empty typed answer (nothing committed) grades as incorrect, never throws", () => {
    // Mirrors the real submit path: `gradeManipulativeSubmission` wraps
    // `isSolved` in a try/catch specifically so a null/malformed submission
    // can never crash the grader — see lib/manipulative/grade.ts. In the
    // live app this state is unreachable (Done stays disabled while `state`
    // is null), but the grader must still be safe against it.
    const spec = fm({});
    const specJson = JSON.stringify(spec);
    const submittedJson = JSON.stringify(functionMachineStateFromTypedAnswer(""));
    expect(gradeManipulativeSubmission(specJson, submittedJson).correct).toBe(false);
  });
});

describe("isSolved dispatch + isChallenge", () => {
  test("routes by kind", () => {
    expect(isSolved(arr({ goal: { type: "productEquals", value: 12 } }), { rows: 3, cols: 4 })).toBe(true);
    expect(isSolved(line({ goal: { type: "placeAt", value: 7 } }), { value: 7 })).toBe(true);
    expect(isSolved(dist({ goal: { type: "splitAt", column: 5 } }), { column: 5 })).toBe(true);
    expect(isSolved(rie({ goal: { type: "approximateWithin", tolerance: 4 } }), { bars: 4 })).toBe(true);
    expect(isSolved(fm({}), { predicted: 14 })).toBe(true);
    expect(isSolved(fm({}), { predicted: 1 })).toBe(false);
    expect(isSolved(pro({ goal: { type: "constructAngle", targetDeg: 65 } }), { angleDeg: 65 })).toBe(true);
    expect(isSolved(pro({ goal: { type: "constructAngle", targetDeg: 65 } }), { angleDeg: 10 })).toBe(false);
  });
  test("isChallenge reflects presence of a goal or typed answer", () => {
    expect(isChallenge(arr({}))).toBe(false);
    expect(isChallenge(arr({ goal: { type: "productEquals", value: 6 } }))).toBe(true);
    expect(isChallenge(bal({ answer: { value: 3, prompt: "What is x?" } }))).toBe(true);
    expect(isChallenge(fm({}))).toBe(true);
    expect(isChallenge(pro({}))).toBe(false);
    expect(isChallenge(pro({ goal: { type: "constructAngle", targetDeg: 50 } }))).toBe(true);
  });
});

describe("MultiStepSequenceSpec (Model A: a linked, data-authored playlist)", () => {
  const numberlineStep: NumberLineSpec = {
    kind: "numberline",
    id: "seq-numberline",
    concept: "Number sense",
    prompt: "Step 1 — put the knob on 5.",
    min: 0,
    max: 10,
    tickStep: 1,
    snap: 1,
    start: 1,
    goal: { type: "placeAt", value: 5 },
  };
  const partitionStep: PartitionSpec = {
    kind: "partition",
    id: "seq-partition",
    concept: "Equivalent fractions",
    prompt: "Step 2 — now make one half.",
    discs: [{ parts: 4, shaded: 1 }],
    adjustable: ["parts", "shaded"],
    partsRange: [2, 12],
    goal: { type: "shadedFractionEquals", disc: 0, value: 0.5 },
  };
  const seq: MultiStepSequenceSpec = {
    id: "seq-test",
    concept: "A linked sequence (Model A)",
    title: "Two-step warm-up",
    completeSummary: "Both steps solved.",
    steps: [numberlineStep, partitionStep],
  };

  test("currentSequenceStep returns each step in order, then null once past the end", () => {
    expect(currentSequenceStep(seq, 0)).toBe(numberlineStep);
    expect(currentSequenceStep(seq, 1)).toBe(partitionStep);
    expect(currentSequenceStep(seq, 2)).toBeNull();
  });

  test("isSequenceComplete is false until stepIndex has advanced past the last step", () => {
    expect(isSequenceComplete(seq, 0)).toBe(false);
    expect(isSequenceComplete(seq, 1)).toBe(false);
    expect(isSequenceComplete(seq, 2)).toBe(true);
  });

  test("advanceSequence just increments — the ONLY state a Model-A sequence carries between steps", () => {
    expect(advanceSequence(0)).toBe(1);
    expect(advanceSequence(1)).toBe(2);
  });

  test("sequenceProgress reports 1-based current, capped at total, for the {mode:'steps'} progress indicator", () => {
    expect(sequenceProgress(seq, 0)).toEqual({ current: 1, total: 2 });
    expect(sequenceProgress(seq, 1)).toEqual({ current: 2, total: 2 });
    // Past the end, current stays capped at total rather than overshooting to 3.
    expect(sequenceProgress(seq, 2)).toEqual({ current: 2, total: 2 });
  });

  test("a full walk of the sequence: advance from step 0 through completion", () => {
    let stepIndex = 0;
    expect(currentSequenceStep(seq, stepIndex)).toBe(numberlineStep);
    expect(isSequenceComplete(seq, stepIndex)).toBe(false);

    stepIndex = advanceSequence(stepIndex);
    expect(currentSequenceStep(seq, stepIndex)).toBe(partitionStep);
    expect(isSequenceComplete(seq, stepIndex)).toBe(false);

    stepIndex = advanceSequence(stepIndex);
    expect(currentSequenceStep(seq, stepIndex)).toBeNull();
    expect(isSequenceComplete(seq, stepIndex)).toBe(true);
  });
});

// ── coordinatePlane — the 2D sibling of numberline ───────────────────────────
const plane = (over: Partial<CoordinatePlaneSpec>): CoordinatePlaneSpec => ({
  kind: "coordinatePlane",
  id: "cp-t",
  concept: "c",
  prompt: "p",
  xMin: 0,
  xMax: 10,
  yMin: 0,
  yMax: 10,
  gridStep: 1,
  draggable: [{ start: { x: 1, y: 1 } }],
  ...over,
});

describe("initialCoordinatePlane", () => {
  test("snaps each draggable start onto the grid", () => {
    const spec = plane({
      gridStep: 2,
      draggable: [{ start: { x: 3.4, y: 5.1 } }, { start: { x: 7.9, y: 0.6 } }],
    });
    expect(initialCoordinatePlane(spec)).toEqual({
      points: [
        { x: 4, y: 6 },
        { x: 8, y: 0 },
      ],
    });
  });

  test("clamps a snapped start into range", () => {
    const spec = plane({ xMin: 0, xMax: 4, yMin: 0, yMax: 4, gridStep: 1, draggable: [{ start: { x: 9, y: -3 } }] });
    expect(initialCoordinatePlane(spec)).toEqual({ points: [{ x: 4, y: 0 }] });
  });

  test("is NOT solved before any drag — a freshly-initialized challenge always starts unsolved", () => {
    const spec = plane({ draggable: [{ start: { x: 1, y: 1 } }], goal: { type: "placePoint", x: 4, y: 2 } });
    expect(coordinatePlaneSolved(spec, initialCoordinatePlane(spec))).toBe(false);
  });
});

describe("coordinatePlaneSolved — placePoint", () => {
  test("true only when the single draggable sits exactly on the target", () => {
    const spec = plane({ goal: { type: "placePoint", x: 4, y: 2 } });
    expect(coordinatePlaneSolved(spec, { points: [{ x: 4, y: 2 }] })).toBe(true);
    expect(coordinatePlaneSolved(spec, { points: [{ x: 4, y: 3 }] })).toBe(false);
    expect(coordinatePlaneSolved(spec, { points: [{ x: 3, y: 2 }] })).toBe(false);
  });

  test("works in a four-quadrant range with negative coordinates", () => {
    const spec = plane({ xMin: -5, xMax: 5, yMin: -5, yMax: 5, goal: { type: "placePoint", x: -3, y: -2 } });
    expect(coordinatePlaneSolved(spec, { points: [{ x: -3, y: -2 }] })).toBe(true);
    expect(coordinatePlaneSolved(spec, { points: [{ x: 3, y: -2 }] })).toBe(false);
  });
});

describe("coordinatePlaneSolved — placePoints (order-insensitive)", () => {
  const spec = plane({
    draggable: [{ start: { x: 1, y: 1 } }, { start: { x: 2, y: 2 } }],
    goal: { type: "placePoints", points: [{ x: 5, y: 6 }, { x: 8, y: 1 }] },
  });

  test("true when the draggables land on the targets in the AUTHORED order", () => {
    expect(coordinatePlaneSolved(spec, { points: [{ x: 5, y: 6 }, { x: 8, y: 1 }] })).toBe(true);
  });

  test("true when the draggables land on the targets in the OPPOSITE order (order-insensitive)", () => {
    expect(coordinatePlaneSolved(spec, { points: [{ x: 8, y: 1 }, { x: 5, y: 6 }] })).toBe(true);
  });

  test("false when only one target is covered", () => {
    expect(coordinatePlaneSolved(spec, { points: [{ x: 5, y: 6 }, { x: 0, y: 0 }] })).toBe(false);
  });

  test("false when both draggables pile onto the SAME target (each target needs its own point)", () => {
    expect(coordinatePlaneSolved(spec, { points: [{ x: 5, y: 6 }, { x: 5, y: 6 }] })).toBe(false);
  });
});

describe("rectangleMissingCorner", () => {
  test("derives the 4th corner from any 3 given (order-independent)", () => {
    expect(rectangleMissingCorner([{ x: 0, y: 0 }, { x: 4, y: 0 }, { x: 0, y: 3 }])).toEqual({ x: 4, y: 3 });
    expect(rectangleMissingCorner([{ x: 4, y: 3 }, { x: 0, y: 0 }, { x: 4, y: 0 }])).toEqual({ x: 0, y: 3 });
  });

  test("returns null for anything other than exactly 3 points", () => {
    expect(rectangleMissingCorner([{ x: 0, y: 0 }, { x: 4, y: 0 }])).toBeNull();
    expect(rectangleMissingCorner([{ x: 0, y: 0 }, { x: 4, y: 0 }, { x: 0, y: 3 }, { x: 4, y: 3 }])).toBeNull();
  });

  test("returns null when the 3 points don't form a valid rectangle triple", () => {
    // Three colinear points share one x value 3x — no valid "lone" x/y split.
    expect(rectangleMissingCorner([{ x: 0, y: 0 }, { x: 0, y: 1 }, { x: 0, y: 2 }])).toBeNull();
  });
});

describe("coordinatePlaneSolved — completeRectangle", () => {
  const spec = plane({
    fixedPoints: [{ x: 1, y: 1, label: "A" }, { x: 6, y: 1, label: "B" }, { x: 1, y: 4, label: "C" }],
    draggable: [{ start: { x: 4, y: 5 } }],
    goal: { type: "completeRectangle" },
  });

  test("true only on the derived missing corner", () => {
    expect(coordinatePlaneSolved(spec, { points: [{ x: 6, y: 4 }] })).toBe(true);
    expect(coordinatePlaneSolved(spec, { points: [{ x: 6, y: 1 }] })).toBe(false);
  });
});

describe("coordinatePlaneSolved — reflectPoint", () => {
  test("across the x-axis flips the y sign", () => {
    const spec = plane({
      xMin: -6, xMax: 6, yMin: -6, yMax: 6,
      goal: { type: "reflectPoint", point: { x: -4, y: 3 }, across: "x" },
    });
    expect(coordinatePlaneSolved(spec, { points: [{ x: -4, y: -3 }] })).toBe(true);
    expect(coordinatePlaneSolved(spec, { points: [{ x: 4, y: 3 }] })).toBe(false);
  });

  test("across the y-axis flips the x sign, including negative-coordinate source points", () => {
    const spec = plane({
      xMin: -6, xMax: 6, yMin: -6, yMax: 6,
      goal: { type: "reflectPoint", point: { x: -2.5, y: -1.5 }, across: "y" },
      gridStep: 0.5,
    });
    expect(coordinatePlaneSolved(spec, { points: [{ x: 2.5, y: -1.5 }] })).toBe(true);
    expect(coordinatePlaneSolved(spec, { points: [{ x: -2.5, y: -1.5 }] })).toBe(false);
  });
});

describe("coordinatePlaneSolved — no goal (explainer) is never solved", () => {
  test("returns false with no goal regardless of state", () => {
    const spec = plane({});
    expect(coordinatePlaneSolved(spec, { points: [{ x: 1, y: 1 }] })).toBe(false);
  });
});

describe("pointSetsEqual", () => {
  test("multiset equality regardless of order", () => {
    expect(pointSetsEqual([{ x: 1, y: 2 }, { x: 3, y: 4 }], [{ x: 3, y: 4 }, { x: 1, y: 2 }])).toBe(true);
    expect(pointSetsEqual([{ x: 1, y: 2 }], [{ x: 1, y: 2 }, { x: 3, y: 4 }])).toBe(false);
    expect(pointSetsEqual([{ x: 1, y: 2 }, { x: 1, y: 2 }], [{ x: 1, y: 2 }, { x: 3, y: 4 }])).toBe(false);
  });
});
