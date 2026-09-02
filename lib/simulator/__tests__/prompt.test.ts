import { describe, expect, it } from "vitest";

import type { SimulatorSpec } from "../contract";
import {
  approximateTokens,
  buildAutomatonPrompt,
  decisionHash,
  isExactLegalAction,
} from "../prompt";
import { ECOSYSTEM_GRID } from "../templates/ecosystemGrid";

const SPEC: SimulatorSpec = {
  version: 1,
  templateId: "ecosystemGrid",
  templateVersion: 1,
  config: {
    width: 4,
    height: 4,
    boundary: "bounded",
    initialResourceDensity: 0.5,
    resourceRegrowthPerTick: 0.2,
    corpseDecayTicks: 3,
    baseMetabolicCost: 1,
    reproductionEnergyThreshold: 12,
    maxAutomata: 4,
    environmentalNoise: { enabled: false, amplitude: 0 },
  },
  criterion: { kind: "measured", metricKey: "longevity", direction: "maximize" },
  speciesSlots: [
    {
      slotId: "grazer",
      label: "Grazers",
      countMin: 1,
      countMax: 4,
      defaultCount: 1,
      senses: [{ senseId: "vision", range: 2 }],
    },
  ],
  tickBudget: { iterationTicks: 5, seasonTicks: 20, absoluteMaxTicks: 20 },
  interpreter: { kind: "llm", role: "AUTOMATON" },
  microWorld: true,
};

describe("World Automaton prompt", () => {
  it("keeps a substantive cacheable prefix over the 4,096-token floor", async () => {
    const prompt = await buildAutomatonPrompt({
      template: ECOSYSTEM_GRID,
      spec: SPEC,
      deckCard: { slotId: "grazer", count: 1, prompt: "Graze before moving." },
      observation: { self: { id: "grazer:1" } },
      legalActions: [{ kind: "rest" }, { kind: "noop" }],
      tick: 0,
      phase: "day",
    });
    // Heuristic: UTF-8 bytes / 4. This intentionally understates many JSON and
    // punctuation-heavy prompts; provider token counting can replace it later.
    expect(approximateTokens(prompt.cacheablePrefix)).toBeGreaterThanOrEqual(4_096);
    expect(prompt.cacheControlEligible).toBe(true);
  });

  it("keeps the prefix stable while isolating model-visible dynamic input", async () => {
    const first = await buildAutomatonPrompt({
      template: ECOSYSTEM_GRID,
      spec: SPEC,
      deckCard: { slotId: "grazer", count: 1, prompt: "Graze." },
      observation: { self: { id: "grazer:1", energy: 4 } },
      legalActions: [{ kind: "graze", at: { x: 0, y: 0 } }],
      tick: 1,
      phase: "day",
    });
    const second = await buildAutomatonPrompt({
      template: ECOSYSTEM_GRID,
      spec: SPEC,
      deckCard: { slotId: "grazer", count: 1, prompt: "Hide." },
      observation: { self: { id: "grazer:2", energy: 9 } },
      legalActions: [{ kind: "hide" }],
      tick: 7,
      phase: "night",
      scratch: "resource was nearby",
    });
    expect(first.cacheablePrefix).toBe(second.cacheablePrefix);
    expect(first.cacheablePrefixHash).toBe(second.cacheablePrefixHash);
    expect(first.dynamicSuffix).not.toBe(second.dynamicSuffix);
    expect(first.chooseActionTool).toEqual(second.chooseActionTool);
  });

  it("hashes every model-visible field and revalidates exact cached actions", async () => {
    const base = {
      modelId: "automaton-model",
      cacheablePrefixHash: "prefix",
      templateId: "ecosystemGrid",
      templateVersion: 1,
      speciesPrompt: "Graze.",
      slotId: "grazer",
      observation: { energy: 2 },
      tick: 4,
      tickPhase: "day",
      legalActions: [{ kind: "rest" }],
    };
    expect(await decisionHash(base)).not.toBe(
      await decisionHash({ ...base, observation: { energy: 3 } }),
    );
    expect(await decisionHash(base)).not.toBe(
      await decisionHash({ ...base, tick: 5 }),
    );
    expect(await decisionHash(base)).toBe(
      await decisionHash({ ...base, legalActions: [...base.legalActions].reverse() }),
    );
    expect(isExactLegalAction({ kind: "rest" }, base.legalActions)).toBe(true);
    expect(isExactLegalAction({ kind: "hide" }, base.legalActions)).toBe(false);
  });
});
