import { describe, expect, test } from "vitest";
import {
  generatedAnswerUnit,
  MAX_AVOID_PROMPT_CHARS,
  MAX_AVOID_PROMPTS,
  normalizeInstructionAtoms,
  sanitizeAvoidPrompts,
} from "../practiceGen";
import { verifyInstructionContent } from "../lib/practice/instructionVerify";

describe("sanitizeAvoidPrompts", () => {
  test("keeps only the first 20 non-empty prompts", () => {
    const prompts = Array.from({ length: 25 }, (_, index) => `Prompt ${index + 1}`);

    expect(sanitizeAvoidPrompts(prompts)).toEqual(
      prompts.slice(0, MAX_AVOID_PROMPTS),
    );
  });

  test("truncates each prompt to 300 characters", () => {
    expect(sanitizeAvoidPrompts(["x".repeat(500)])).toEqual([
      "x".repeat(MAX_AVOID_PROMPT_CHARS),
    ]);
  });

  test("drops empty and whitespace-only prompts", () => {
    expect(sanitizeAvoidPrompts(["", "   ", "\n\t", "Keep me"])).toEqual([
      "Keep me",
    ]);
  });

  test("passes normal input through unchanged", () => {
    const prompts = ["What is 6 × 7?", "Share 12 shells among 3 groups."];

    expect(sanitizeAvoidPrompts(prompts)).toEqual(prompts);
  });
});

describe("instruction Launchpad generation", () => {
  test("an unparseable generated try_it is rejected by the existing verify gate", () => {
    const atoms = normalizeInstructionAtoms([
      {
        kind: "try_it",
        strategyLabel: "Combine equal groups",
        steps: ["3 groups of 4 make 12", "12 + 4 = ___"],
        examplePrompt: "What is 4 groups of 4?",
        exampleAnswer: "not-a-number",
      },
    ]);

    expect(atoms).toHaveLength(1);
    expect(atoms[0]).toMatchObject({ kind: "try_it", answerType: "integer" });
    const result = verifyInstructionContent({
      title: "Combine equal groups",
      atoms,
    });
    expect(result.status).toBe("failed");
    expect(result.report).toMatch(/shared grader/i);
  });
});

describe("generatedAnswerUnit — the answer-unit gate on generated word problems", () => {
  const VOLUME_STEM = "A crate is 4 by 4 by 7. What is its volume in cubic centimeters?";

  test("no unit emitted → the item grades value-only, as it always has", () => {
    expect(generatedAnswerUnit(VOLUME_STEM, undefined)).toBeUndefined();
    expect(generatedAnswerUnit(VOLUME_STEM, "")).toBeUndefined();
  });

  test("a unit the stem asks for is kept, canonicalized to its display form", () => {
    expect(generatedAnswerUnit(VOLUME_STEM, "cm³")).toBe("cm³");
    // An alias for the same unit canonicalizes to the same display form.
    expect(generatedAnswerUnit(VOLUME_STEM, "cubic centimeters")).toBe("cm³");
  });

  test("a unit the STEM never asks for is dropped — it would be a wrong-answer trap", () => {
    // The model can emit a unit on a problem that never named one; requiring it
    // would mark a correct bare answer wrong, which is strictly worse than the
    // pre-existing unit-free grading.
    expect(generatedAnswerUnit("Maya packs 6 boxes with 7 shells each. How many shells?", "cm³")).toBeUndefined();
    // A trailing digit keeps the alias inside a larger token, not a named unit.
    expect(generatedAnswerUnit("The sample code is 8m4.", "m")).toBeUndefined();
  });

  test("a unit the grading registry can't normalize is dropped", () => {
    expect(generatedAnswerUnit("How many liters does the tank hold?", "liters")).toBeUndefined();
  });
});
