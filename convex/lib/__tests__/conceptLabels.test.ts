import { describe, it, expect } from "vitest";
import { conceptLabelsNearDuplicate, conceptLabelWords, AUTO_MERGE_THRESHOLD } from "../conceptLabels";

describe("conceptLabelsNearDuplicate — DETECTION default (0.7, for the eval gate)", () => {
  it("flags the near-twin labels the observer piles up at scale", () => {
    // A production-observed pile reduced to synthetic lexical near-twins.
    expect(
      conceptLabelsNearDuplicate(
        "Systematic bug isolation and reproduction",
        "Systematic bug isolation and reporting",
      ),
    ).toBe(true);
    expect(
      conceptLabelsNearDuplicate("User experience design and accessibility", "User experience design and control schemes"),
    ).toBe(true);
  });

  it("keeps genuinely distinct same-stem concepts apart", () => {
    expect(conceptLabelsNearDuplicate("Area of rectangles", "Area of triangles")).toBe(false);
    expect(conceptLabelsNearDuplicate("Pulley systems and mechanical advantage", "Pulley systems and friction")).toBe(false);
    expect(conceptLabelsNearDuplicate("Seasonal animal adaptations", "Animal circulatory systems")).toBe(false);
  });

  it("never merges on a single content word (avoids broad swallowing narrow)", () => {
    expect(conceptLabelsNearDuplicate("Fractions", "Fractions and decimals")).toBe(false);
    expect(conceptLabelsNearDuplicate("Gravity", "Gravity, mass, and free fall")).toBe(false);
  });

  it("is order- and punctuation-insensitive on the content words", () => {
    expect(conceptLabelsNearDuplicate("Mechanical advantage of pulleys", "Pulleys: mechanical advantage")).toBe(true);
  });

  it("drops connective stopwords from the content set", () => {
    expect(conceptLabelWords("Value-based pricing and utility reasoning")).toEqual(
      new Set(["value", "pricing", "utility", "reasoning"]),
    );
  });
});

describe("conceptLabelsNearDuplicate — ENFORCEMENT (AUTO_MERGE_THRESHOLD, conservative)", () => {
  const dup = (a: string, b: string) => conceptLabelsNearDuplicate(a, b, AUTO_MERGE_THRESHOLD);

  it("collapses exact duplicates and qualifier/suffix variants", () => {
    expect(dup("Sensor-actuated mechanisms", "Sensor-actuated mechanisms")).toBe(true);
    expect(dup("Sensor-actuated mechanisms", "Sensor-actuated mechanisms (Engineering)")).toBe(true);
    expect(dup("Subtraction of fractions with common denominators", "Addition and subtraction of fractions with common denominators")).toBe(true);
  });

  it("does NOT merge two labels that each carry a distinguishing word (the real false-merge averted)", () => {
    // Distinct skills; both 0.75 overlap — merged by the loose gate, NOT by enforcement.
    expect(dup("Addition of fractions with like denominators", "Subtraction of fractions with like denominators")).toBe(false);
    expect(dup("Systematic bug isolation and reproduction", "Systematic bug isolation and reporting")).toBe(false);
    expect(dup("Multi-functional object design", "Multi-functional robot design")).toBe(false);
  });
});
