import { describe, expect, test } from "vitest";

import {
  EXAMPLE_ECOSYSTEM_AUTHOR_INPUT,
  EXAMPLE_PRISONERS_DILEMMA_AUTHOR_INPUT,
  assembleSimulatorSpec,
  validatedSimulatorSpec,
} from "../simulatorTemplatesCatalog";
import {
  buildDegenerateProbe,
  criterionSeparation,
  degenerateProbePlan,
} from "../simulatorRedTeam";

const spread = (min: number, max: number, mean = (min + max) / 2) => ({
  count: 2,
  min,
  max,
  mean,
});

describe("buildDegenerateProbe", () => {
  test.each([
    EXAMPLE_ECOSYSTEM_AUTHOR_INPUT,
    EXAMPLE_PRISONERS_DILEMMA_AUTHOR_INPUT,
  ])("builds ready, unconditional policies for $templateId", async (authorInput) => {
    const spec = validatedSimulatorSpec(assembleSimulatorSpec(authorInput));

    for (const variant of degenerateProbePlan(spec.templateId).variants) {
      const probe = await buildDegenerateProbe(spec, variant);
      expect(probe.simulatorSpec.interpreter.kind).toBe("scripted");
      expect(probe.compiledPolicySnapshot).toHaveLength(spec.speciesSlots.length);
      for (const frozen of probe.compiledPolicySnapshot) {
        if (frozen.status === "fallback") {
          expect(spec.templateId).toBe("prisonersDilemma");
          expect(frozen.reason).toBe("missing");
          continue;
        }
        expect(frozen.policyHash).toMatch(/^[a-f0-9]{64}$/);
        expect(frozen.policy.rules).toHaveLength(1);
        expect(frozen.policy.rules[0].when).toEqual([]);
        expect(frozen.policy.rules[0].then.kind).not.toBe("abstain");
      }
    }
  });

  test("uses template-specific greedy actions", async () => {
    const ecosystem = await buildDegenerateProbe(
      validatedSimulatorSpec(assembleSimulatorSpec(EXAMPLE_ECOSYSTEM_AUTHOR_INPUT)),
      "greedy",
    );
    expect(
      ecosystem.compiledPolicySnapshot.map(
        (frozen) =>
          frozen.status === "ready" ? frozen.policy.rules[0].then : null,
      ),
    ).toEqual([
      expect.objectContaining({ kind: "action", actionKind: "graze" }),
      expect.objectContaining({ kind: "action", actionKind: "eat" }),
    ]);

    const dilemma = await buildDegenerateProbe(
      validatedSimulatorSpec(
        assembleSimulatorSpec(EXAMPLE_PRISONERS_DILEMMA_AUTHOR_INPUT),
      ),
      "greedy",
    );
    expect(
      dilemma.compiledPolicySnapshot.every(
        (frozen) =>
          frozen.status === "fallback" ||
          (frozen.policy.rules[0].then.kind === "action" &&
            frozen.policy.rules[0].then.actionKind === "defect"),
      ),
    ).toBe(true);
  });

  test("uses the registry's first action for a generic empty policy", async () => {
    const ecosystem = await buildDegenerateProbe(
      validatedSimulatorSpec(assembleSimulatorSpec(EXAMPLE_ECOSYSTEM_AUTHOR_INPUT)),
      "empty",
    );
    const ecosystemPolicy = ecosystem.compiledPolicySnapshot[0];
    expect(ecosystemPolicy.status).toBe("ready");
    if (ecosystemPolicy.status !== "ready") throw new Error("Expected ready policy");
    expect(ecosystemPolicy.policy.rules[0].then).toEqual({
      kind: "action",
      actionKind: "move",
      target: { kind: "none" },
    });

    const dilemma = await buildDegenerateProbe(
      validatedSimulatorSpec(
        assembleSimulatorSpec(EXAMPLE_PRISONERS_DILEMMA_AUTHOR_INPUT),
      ),
      "empty",
    );
    const dilemmaPolicy = dilemma.compiledPolicySnapshot[0];
    expect(dilemmaPolicy.status).toBe("ready");
    if (dilemmaPolicy.status !== "ready") throw new Error("Expected ready policy");
    expect(dilemmaPolicy.policy.rules[0].then).toEqual({
      kind: "action",
      actionKind: "cooperate",
      target: { kind: "none" },
    });
  });

  test("gives Prisoner's Dilemma exactly two distinct starter matchups", async () => {
    const spec = validatedSimulatorSpec(
      assembleSimulatorSpec(EXAMPLE_PRISONERS_DILEMMA_AUTHOR_INPUT),
    );
    expect(degenerateProbePlan(spec.templateId).variants).toEqual([
      "empty",
      "greedy",
    ]);
    const probes = await Promise.all(
      degenerateProbePlan(spec.templateId).variants.map((variant) =>
        buildDegenerateProbe(spec, variant),
      ),
    );
    const matchupPairs = probes.map((probe) => {
      expect(probe.matchupPolicyHashes).toBeDefined();
      return `${probe.matchupPolicyHashes!.policyHash}:${probe.matchupPolicyHashes!.opponentPolicyHash}`;
    });
    expect(new Set(matchupPairs).size).toBe(matchupPairs.length);
    expect(
      probes.every(
        (probe) =>
          probe.compiledPolicySnapshot[1]?.status === "fallback" &&
          probe.deck[1]?.prompt === spec.speciesSlots[1]?.starterHint,
      ),
    ).toBe(true);
  });

  test("gracefully skips greedy for an unknown or matrix template", () => {
    expect(degenerateProbePlan("futureTemplate")).toEqual({
      variants: ["empty"],
      note: "No template-specific greedy probe yet.",
    });
    expect(degenerateProbePlan("matrixGame")).toEqual({
      variants: ["empty"],
      note: "No template-specific greedy probe yet.",
    });
  });
});

describe("criterionSeparation", () => {
  const starter = spread(10, 12);

  test("does not invent a band before both starter duplicates finish", () => {
    expect(
      criterionSeparation({
        starter: { count: 1, min: 11, max: 11, mean: 11 },
        degenerate: spread(5, 5),
        direction: "maximize",
      }),
    ).toBeNull();
  });

  test("separates only beyond the observed duplicate-run spread", () => {
    expect(
      criterionSeparation({
        starter,
        degenerate: spread(8, 8),
        direction: "maximize",
      }),
    ).toEqual({
      verdict: "separated",
      referenceAdvantage: 3,
      noiseBand: 2,
    });
  });

  test("treats the exact noise-band edge as close", () => {
    expect(
      criterionSeparation({
        starter,
        degenerate: spread(9, 9),
        direction: "maximize",
      })?.verdict,
    ).toBe("close");
  });

  test("calls a tie or better result degenerate-wins", () => {
    for (const score of [11, 13]) {
      expect(
        criterionSeparation({
          starter,
          degenerate: spread(score, score),
          direction: "maximize",
        })?.verdict,
      ).toBe("degenerate-wins");
    }
  });

  test("treats an observed zero-width band as calibrated", () => {
    expect(
      criterionSeparation({
        starter: spread(10, 10),
        degenerate: spread(10, 10),
        direction: "maximize",
      }),
    ).toEqual({
      verdict: "degenerate-wins",
      referenceAdvantage: 0,
      noiseBand: 0,
    });
    expect(
      criterionSeparation({
        starter: spread(10, 10),
        degenerate: spread(9, 9),
        direction: "maximize",
      })?.verdict,
    ).toBe("separated");
  });

  test("is direction-aware for minimize and target criteria", () => {
    expect(
      criterionSeparation({
        starter: spread(2, 4),
        degenerate: spread(8, 8),
        direction: "minimize",
      })?.verdict,
    ).toBe("separated");
    expect(
      criterionSeparation({
        starter: spread(9, 11),
        degenerate: spread(10, 10),
        direction: "target",
        target: 10,
      })?.verdict,
    ).toBe("degenerate-wins");
  });

  test("can compare adversarial decks while retaining starter calibration", () => {
    expect(
      criterionSeparation({
        starter,
        reference: spread(20, 20),
        degenerate: spread(17, 17),
        direction: "maximize",
      }),
    ).toEqual({
      verdict: "separated",
      referenceAdvantage: 3,
      noiseBand: 2,
    });
  });
});
