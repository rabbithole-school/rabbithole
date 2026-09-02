import { describe, expect, test } from "vitest";
import { parseInstructionManipulative } from "../../../../lib/manipulative/types";
import { AUTHORED_LAUNCHPADS } from "../../../seed/instructionSeed";
import { verifyInstructionContent } from "../instructionVerify";

const DESIGNED_SEQUENCES = [
  {
    key: "whole-number-arithmetic:add-subtract",
    sequenceId: "add-subtract-guided",
    stepCount: 5,
  },
  {
    key: "fraction-arithmetic:concept",
    sequenceId: "concept-guided",
    stepCount: 5,
  },
  {
    key: "fraction-arithmetic:equivalence",
    sequenceId: "equivalence-guided",
    stepCount: 4,
  },
  {
    key: "whole-number-arithmetic:mult-divide",
    sequenceId: "mult-divide-guided",
    stepCount: 4,
  },
  {
    key: "whole-number-arithmetic:place-value",
    sequenceId: "place-value-guided",
    stepCount: 4,
  },
  {
    key: "fraction-arithmetic:comparison",
    sequenceId: "comparison-guided",
    stepCount: 4,
  },
  {
    key: "integers-coordinates:integer-operations",
    sequenceId: "integer-operations-guided",
    stepCount: 5,
  },
  {
    key: "whole-number-arithmetic:mult-divide",
    designTitle: "Sharing fairly",
    stepCount: 4,
    parked: true,
  },
  {
    key: "early-algebra:equations-1-2-step",
    sequenceId: "equations-1-2-step-guided",
    stepCount: 4,
  },
  {
    key: "geometry-measurement:area-perimeter",
    sequenceId: "area-perimeter-guided",
    stepCount: 4,
  },
  {
    key: "whole-number-arithmetic:counting",
    sequenceId: "counting-guided",
    stepCount: 4,
  },
  {
    key: "whole-number-arithmetic:number-theory",
    sequenceId: "number-theory-guided",
    stepCount: 4,
  },
  {
    key: "fraction-arithmetic:operations",
    sequenceId: "operations-guided",
    stepCount: 4,
  },
  {
    key: "fraction-arithmetic:decimals",
    sequenceId: "decimals-guided",
    stepCount: 4,
  },
  {
    key: "geometry-measurement:angles",
    sequenceId: "angles-guided",
    stepCount: 4,
  },
  {
    key: "geometry-measurement:coordinate-geometry",
    sequenceId: "coordinate-geometry-guided",
    stepCount: 4,
  },
  {
    key: "integers-coordinates:negatives-absvalue",
    sequenceId: "negatives-absvalue-guided",
    stepCount: 4,
  },
  {
    key: "early-algebra:expressions-variables",
    sequenceId: "expressions-variables-guided",
    stepCount: 4,
  },
  {
    key: "probability:chance",
    sequenceId: "chance-guided",
    stepCount: 4,
  },
] as const;

const EXPECTED_VIDEO_IDS = new Map([
  ["fraction-arithmetic:concept", "jgWqSjgMAtw"],
  ["geometry-measurement:volume", "I9efKVtLCf4"],
  ["integers-coordinates:integer-operations", "3CKpidALDEg"],
  ["integers-coordinates:negatives-absvalue", "zpln5ExhkyI"],
  ["integers-coordinates:rational-ordering", "i1i2_9wg6N8"],
  ["ratio-proportion-percent:percent", "Lvr2YsxG10o"],
  ["ratio-proportion-percent:ratios-rates", "Zm0KaIw-35k"],
  ["ratio-proportion-percent:proportional-reasoning", "qYjiVWwefto"],
  ["probability:chance", "uzkc-qNVoOk"],
  ["probability:theoretical", "tXlcE_K_C-Y"],
  ["probability:experimental", "RdehfQJ8i_0"],
  ["probability:compound", "OqbkCYy37hI"],
  ["probability:center-spread", "GrynkZB3E7M"],
  ["early-algebra:patterns-sequences", "EU0c6qrrevA"],
  ["early-algebra:expressions-variables", "AJNDeVt9UOo"],
  ["early-algebra:equations-1-2-step", "jWpiMu5LNdg"],
  ["early-algebra:inequalities", "y7QLay8wrW8"],
  ["algebra-1:linear-equations", "_y_Q3_B2Vh8"],
  ["algebra-1:linear-functions", "MeU-KzdCBps"],
  ["algebra-1:systems", "uzyd_mIJaoc"],
  ["algebra-1:exponents-exponential", "CZ5ne_mX5_I"],
  ["algebra-1:polynomials-factoring", "Vm7H0VTlIco"],
  ["algebra-1:quadratics", "wt6XqG59t5U"],
  ["probability:data-displays", "c02vjunQsJM"],
]);

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
    for (const expected of DESIGNED_SEQUENCES) {
      if (!("sequenceId" in expected)) continue;
      for (const step of parsedSequence(expected.key).steps) {
        if (step.kind !== "functionMachine") continue;
        // No typed answer ⇒ an explore rung, which has nothing to be wrong about.
        if (!step.answer) continue;
        const { m, b } = step.rule;
        expect(
          step.answer.value,
          `${expected.key} step "${step.id}": rule ${m}n+${b} on input ${step.queryInput}`,
        ).toBe(m * step.queryInput + b);
        checked += 1;
      }
    }
    // Guard the guard: if the authored set stops containing functionMachine
    // challenge steps, this test must fail loudly rather than pass vacuously.
    expect(checked).toBeGreaterThan(0);
  });

  test("tracks all 18 authored sequences", () => {
    expect(DESIGNED_SEQUENCES.filter((expected) => "sequenceId" in expected)).toHaveLength(18);

    const authoredIds: string[] = [];
    for (const expected of DESIGNED_SEQUENCES) {
      if (!("sequenceId" in expected)) continue;
      const sequence = parsedSequence(expected.key);
      authoredIds.push(sequence.id, ...sequence.steps.map((step) => step.id));
    }
    expect(new Set(authoredIds).size).toBe(authoredIds.length);
  });

  test("every authored Launchpad passes the production verifier", () => {
    for (const entry of AUTHORED_LAUNCHPADS) {
      const result = verifyInstructionContent({
        title: entry.title,
        subtitle: entry.subtitle,
        atoms: entry.atoms,
      });
      expect(result.status, `${entry.domain}:${entry.strand}: ${result.report}`).toBe("passed");
    }
  });

  test("the authored video clips use the expected verified video ids", () => {
    const actual = new Map<string, string>();
    for (const entry of AUTHORED_LAUNCHPADS) {
      const key = `${entry.domain}:${entry.strand}`;
      for (const atom of entry.atoms) {
        if (atom.kind === "video") actual.set(key, atom.videoId);
      }
    }

    expect(actual).toEqual(EXPECTED_VIDEO_IDS);
    for (const key of EXPECTED_VIDEO_IDS.keys()) {
      const kinds = launchpad(key).atoms.map((atom) => atom.kind);
      expect(kinds.slice(0, 3)).toEqual(["story_hook", "micro_explain", "video"]);
      expect(kinds.at(-1)).toBe("worked_example");
      expect(kinds.slice(3, -1)).toEqual(
        kinds.includes("manipulative") ? ["manipulative"] : ["try_it"],
      );
    }
  });

  test("every authored video is followed by a try-it or manipulative atom", () => {
    let checked = 0;
    for (const entry of AUTHORED_LAUNCHPADS) {
      entry.atoms.forEach((atom, index) => {
        if (atom.kind !== "video") return;
        const hasLaterDoAtom = entry.atoms
          .slice(index + 1)
          .some((laterAtom) => laterAtom.kind === "try_it" || laterAtom.kind === "manipulative");
        expect(
          hasLaterDoAtom,
          `${entry.domain}:${entry.strand} video ${atom.videoId} needs a later do atom`,
        ).toBe(true);
        checked += 1;
      });
    }
    expect(checked).toBe(EXPECTED_VIDEO_IDS.size);
  });

  test("every authored video clip is at most six minutes", () => {
    let checked = 0;
    for (const entry of AUTHORED_LAUNCHPADS) {
      for (const atom of entry.atoms) {
        if (atom.kind !== "video") continue;
        expect(
          atom.endSec - atom.startSec,
          `${entry.domain}:${entry.strand} video ${atom.videoId}`,
        ).toBeLessThanOrEqual(360);
        checked += 1;
      }
    }
    expect(checked).toBe(EXPECTED_VIDEO_IDS.size);
  });

  for (const expected of DESIGNED_SEQUENCES) {
    if (!("sequenceId" in expected)) {
      test(`${expected.designTitle} stays parked because mult-divide is occupied`, () => {
        const sequence = parsedSequence(expected.key);
        expect(sequence.steps).toHaveLength(expected.stepCount);
        expect(sequence.steps.every((step) => step.kind === "array")).toBe(true);
      });
      continue;
    }

    test(`${expected.sequenceId} parses with ${expected.stepCount} steps`, () => {
      const entry = launchpad(expected.key);
      expect(
        entry.atoms.filter((atom) => atom.kind !== "video").map((atom) => atom.kind),
      ).toEqual(["story_hook", "micro_explain", "manipulative", "worked_example"]);

      const sequence = parsedSequence(expected.key);
      expect(sequence.id).toBe(expected.sequenceId);
      expect(sequence.steps).toHaveLength(expected.stepCount);
      expect("goal" in sequence.steps[0] ? sequence.steps[0].goal : undefined).toBeUndefined();
      expect(new Set(sequence.steps.map((step) => step.id)).size).toBe(expected.stepCount);
    });
  }

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
