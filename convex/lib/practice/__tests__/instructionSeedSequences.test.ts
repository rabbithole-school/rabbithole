import { describe, expect, test } from "vitest";
import { parseInstructionManipulative } from "../../../../lib/manipulative/types";
import { AUTHORED_LAUNCHPADS } from "../../../seed/instructionSeed";

function launchpad(key: string) {
  const entry = AUTHORED_LAUNCHPADS.find((candidate) => {
    return `${candidate.domain}:${candidate.strand}` === key;
  });
  expect(entry, `missing authored Launchpad ${key}`).toBeDefined();
  return entry!;
}

function parsedSequence(key: string) {
  const entry = launchpad(key);
  const manipulativeAtoms = entry.atoms.filter((atom) => atom.kind === "manipulative");
  expect(manipulativeAtoms, `${key} should have exactly one manipulative atom`).toHaveLength(1);
  const parsed = parseInstructionManipulative(manipulativeAtoms[0].spec);
  expect(parsed?.mode, `${key} should parse as a sequence`).toBe("sequence");
  if (!parsed || parsed.mode !== "sequence") {
    throw new Error(`${key} did not parse as a sequence`);
  }
  return parsed.spec;
}

describe("authored guided-manipulative sequences", () => {
  /**
   * The verifier CANNOT catch this class of error, which is why it is pinned
   * here. `assertGradableManipulative` only checks that a functionMachine has a
   * usable typed answer — never that the answer is ARITHMETICALLY TRUE for the
   * spec's own hidden rule. A transcription slip (rule 3n+1, input 5, answer 15)
   * verifies clean and then teaches a child the wrong answer. Every authored
   * challenge step must satisfy its own rule.
   */
  test("every authored functionMachine answer matches its own hidden rule", () => {
    let checked = 0;
    for (const entry of AUTHORED_LAUNCHPADS) {
      const key = `${entry.domain}:${entry.strand}`;
      for (const atom of entry.atoms) {
        if (atom.kind !== "manipulative") continue;
        const parsed = parseInstructionManipulative(atom.spec);
        if (!parsed || parsed.mode !== "sequence") continue;
        for (const step of parsed.spec.steps) {
          if (step.kind !== "functionMachine" || !step.answer) continue;
          const { m, b } = step.rule;
          expect(
            step.answer.value,
            `${key} step "${step.id}": rule ${m}n+${b} on input ${step.queryInput}`,
          ).toBe(m * step.queryInput + b);
          checked += 1;
        }
      }
    }
    // Guard the guard: if the authored set stops containing functionMachine
    // challenge steps, this test must fail loudly rather than pass vacuously.
    expect(checked).toBeGreaterThan(0);
  });

  test("the areaEquals target is reachable with the fixed perimeter", () => {
    const sequence = parsedSequence("geometry-measurement:area-perimeter");
    const areaStep = sequence.steps.find((step) => {
      return step.kind === "areaPerimeter" && step.goal?.type === "areaEquals";
    });
    expect(areaStep?.kind).toBe("areaPerimeter");
    if (areaStep?.kind !== "areaPerimeter" || areaStep.goal?.type !== "areaEquals") {
      throw new Error("area-perimeter sequence has no areaEquals step");
    }

    const halfPerimeter = areaStep.perimeter / 2;
    const reachableAreas = Array.from(
      { length: halfPerimeter - 1 },
      (_, index) => (index + 1) * (halfPerimeter - (index + 1)),
    );

    expect(areaStep.perimeter).toBe(20);
    expect(areaStep.goal.value).toBe(21);
    expect(reachableAreas).toContain(areaStep.goal.value);
    expect(3 * 7).toBe(areaStep.goal.value);
  });
});
