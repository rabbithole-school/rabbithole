import { describe, expect, test } from "vitest";
import {
  parseInstructionManipulative,
  type MultiStepSequenceSpec,
  type NumberLineSpec,
} from "../types";

const step: NumberLineSpec = {
  kind: "numberline",
  id: "instruction-numberline",
  concept: "Number sense",
  prompt: "Put the point on 5.",
  min: 0,
  max: 10,
  tickStep: 1,
  start: 1,
  goal: { type: "placeAt", value: 5 },
};

const sequence: MultiStepSequenceSpec = {
  id: "instruction-sequence",
  concept: "Number sense",
  title: "Build toward five",
  steps: [step, { ...step, id: "instruction-numberline-2", goal: { type: "placeAt", value: 7 } }],
};

describe("parseInstructionManipulative", () => {
  test("discriminates a single ManipulativeSpec", () => {
    expect(parseInstructionManipulative(JSON.stringify(step))).toEqual({
      mode: "single",
      spec: step,
    });
  });

  test("discriminates a MultiStepSequenceSpec", () => {
    expect(parseInstructionManipulative(JSON.stringify(sequence))).toEqual({
      mode: "sequence",
      spec: sequence,
    });
  });

  test("returns null for malformed JSON or a malformed outer shape", () => {
    expect(parseInstructionManipulative("{not-json")).toBeNull();
    expect(
      parseInstructionManipulative(
        JSON.stringify({ ...sequence, steps: "not-an-array" }),
      ),
    ).toBeNull();
  });
});
