import { describe, expect, it } from "vitest";

import type {
  EcosystemGridSimulatorSpec,
  PrisonersDilemmaSimulatorSpec,
} from "@/lib/simulator/contract";
import { MAX_THEME_LABEL_LEN } from "@/convex/lib/themeIconArt";
import {
  composeSpeciesIconLabel,
  chartMetricKeys,
  chartTimeSpan,
  canAddSpeciesSlot,
  colorForSlotIndex,
  criterionFeedbackSentence,
  criterionSentence,
  deckDisplayPrompt,
  formatMetric,
  isBetter,
  isPoolEntityKind,
  metricLabel,
  isRoundTokenEntityKind,
  personalDeltaHeadline,
  runCompareDisplayValue,
  runCriterionScore,
  sensesLine,
  tokenBadgeGlyph,
} from "../helpers";

function specWith(
  criterion: EcosystemGridSimulatorSpec["criterion"],
): EcosystemGridSimulatorSpec {
  return {
    version: 1,
    templateId: "ecosystemGrid",
    templateVersion: 1,
    config: {
      width: 8,
      height: 8,
      boundary: "bounded",
      initialResourceDensity: 0.3,
      resourceRegrowthPerTick: 0.02,
      corpseDecayTicks: 5,
      baseMetabolicCost: 1,
      reproductionEnergyThreshold: 10,
      maxAutomata: 12,
      environmentalNoise: { enabled: false, amplitude: 0 },
    },
    criterion,
    speciesSlots: [],
    tickBudget: { iterationTicks: 20, seasonTicks: 60, absoluteMaxTicks: 120 },
    interpreter: { kind: "llm", role: "AUTOMATON" },
    microWorld: false,
  };
}

function adversarialSpec(
  speciesSlots: PrisonersDilemmaSimulatorSpec["speciesSlots"] = [],
): PrisonersDilemmaSimulatorSpec {
  return {
    version: 1,
    templateId: "prisonersDilemma",
    templateVersion: 1,
    config: {
      noiseProbability: 0,
      payoffMatrix: {
        mutualCooperation: 3,
        temptation: 5,
        sucker: 0,
        mutualDefection: 1,
      },
      maxAutomata: 2,
    },
    criterion: {
      kind: "adversarial",
      scoreMetricKeys: ["deckA.totalScore", "deckB.totalScore"],
    },
    speciesSlots,
    tickBudget: { iterationTicks: 20, seasonTicks: 60, absoluteMaxTicks: 120 },
    interpreter: { kind: "llm", role: "AUTOMATON" },
    microWorld: false,
  };
}

describe("workbench helpers", () => {
  it("reads the criterion direction when picking the better score", () => {
    const maximize = specWith({ kind: "measured", metricKey: "longevity", direction: "maximize" });
    const minimize = specWith({ kind: "measured", metricKey: "deaths", direction: "minimize" });
    const target = specWith({ kind: "measured", metricKey: "livingSpecies", direction: "target", target: 3 });
    expect(isBetter(maximize, 40, 30)).toBe(true);
    expect(isBetter(minimize, 2, 5)).toBe(true);
    expect(isBetter(target, 3, 1)).toBe(true); // closer to target wins
    expect(isBetter(target, 6, 3)).toBe(false);
  });

  it("pulls the criterion score off a run's scores", () => {
    const spec = specWith({ kind: "measured", metricKey: "longevity", direction: "maximize" });
    expect(runCriterionScore(spec, [{ key: "longevity", value: 41 }, { key: "deaths", value: 3 }])).toBe(41);
    expect(runCriterionScore(spec, [{ key: "deaths", value: 3 }])).toBeNull();
    const gallery = specWith({ kind: "gallery", frameKey: "reef" });
    expect(runCriterionScore(gallery, [{ key: "longevity", value: 41 }])).toBeNull();
  });

  it("writes a neutral criterion sentence per direction", () => {
    expect(criterionSentence(specWith({ kind: "measured", metricKey: "longevity", direction: "maximize" }))).toMatch(/high/i);
    expect(criterionSentence(specWith({ kind: "measured", metricKey: "deaths", direction: "minimize" }))).toMatch(/low/i);
    expect(criterionSentence(specWith({ kind: "gallery", frameKey: "reef", curatorNote: "Make it lush" }))).toBe("Make it lush");
  });

  it("uses survival wording and singular-aware labels for a scored species slot", () => {
    const survival = specWith({
      kind: "measured",
      metricKey: "scoringSlotSurvivors",
      direction: "maximize",
    });
    expect(criterionSentence(survival)).toBe("Keep your species alive through the last day");
    expect(metricLabel("scoringSlotSurvivors", 1)).toBe("living member of your species");
    expect(metricLabel("scoringSlotSurvivors", 2)).toBe("living members of your species");
    expect(`${formatMetric(1)} ${metricLabel("scoringSlotSurvivors", 1)}`).toBe(
      "1 living member of your species",
    );
  });

  it("uses an extinction outcome instead of criterion feedback or a score", () => {
    const spec = specWith({ kind: "measured", metricKey: "livingSpecies", direction: "maximize" });
    expect(criterionFeedbackSentence(spec, true)).toBe("No automata survived.");
    expect(runCriterionScore(spec, [])).toBeNull();
  });

  it("keeps an extinct run's measured final value display-only in Compare", () => {
    const spec = specWith({ kind: "measured", metricKey: "longevity", direction: "maximize" });
    expect(
      runCompareDisplayValue(
        spec,
        [],
        [{ key: "longevity", value: 24 }],
        true,
      ),
    ).toEqual({ value: 24, terminal: true });
    expect(
      runCompareDisplayValue(
        spec,
        [{ key: "longevity", value: 99 }],
        [{ key: "longevity", value: 24 }],
        true,
      ),
    ).toEqual({ value: 24, terminal: true });
    expect(runCompareDisplayValue(spec, [], [{ key: "deaths", value: 3 }], true)).toBeNull();
  });

  it("uses criterion scores for non-terminal Compare results", () => {
    const spec = specWith({ kind: "measured", metricKey: "longevity", direction: "maximize" });
    expect(
      runCompareDisplayValue(
        spec,
        [{ key: "longevity", value: 41 }],
        [{ key: "longevity", value: 12 }],
        false,
      ),
    ).toEqual({ value: 41, terminal: false });
  });

  it("describes the opponent shape for adversarial criteria", () => {
    const slot = {
      slotId: "trader_ana",
      label: "Trader Ana",
      countMin: 1,
      countMax: 1,
      defaultCount: 1,
      senses: [],
    };
    expect(criterionSentence(adversarialSpec([{ ...slot, countMin: 2, countMax: 2, defaultCount: 2 }]))).toBe(
      "See what happens when your strategy meets a copy of itself",
    );
    expect(
      criterionSentence(
        adversarialSpec([
          slot,
          {
            ...slot,
            slotId: "trader_ben",
            label: "Trader Ben",
            locked: true,
          },
        ]),
      ),
    ).toBe("Adapt your strategy to one fixed, readable partner");
    expect(criterionSentence(adversarialSpec([slot, { ...slot, slotId: "trader_ben" }]))).toBe(
      "Test the strategies against each other, round by round",
    );
  });

  it("summarizes senses", () => {
    expect(sensesLine([{ senseId: "vision", range: 4 }, { senseId: "smell" }])).toBe("vision 4 · smell");
    expect(sensesLine([])).toBe("no senses");
  });

  describe("deckDisplayPrompt (locked-slot rendering, shared by web + native)", () => {
    it("shows the persisted card prompt for an unlocked slot", () => {
      const slot = { starterHint: "Find algae." };
      expect(deckDisplayPrompt(slot, { prompt: "A scholar-authored strategy." })).toBe(
        "A scholar-authored strategy.",
      );
    });

    it("keeps all twelve ecosystem roster colors distinct and caps only that roster at twelve", () => {
      expect(new Set(Array.from({ length: 12 }, (_, index) => colorForSlotIndex(index))).size).toBe(12);
      const elevenSlots = Array.from({ length: 11 }, (_, index) => ({
        slotId: `species-${index + 1}`,
        label: `Species ${index + 1}`,
        countMin: 0,
        countMax: 1,
        defaultCount: 0,
        senses: [],
      }));
      expect(canAddSpeciesSlot({ ...specWith({ kind: "gallery", frameKey: "reef" }), speciesSlots: elevenSlots })).toBe(
        true,
      );
      expect(
        canAddSpeciesSlot({
          ...specWith({ kind: "gallery", frameKey: "reef" }),
          speciesSlots: [...elevenSlots, { ...elevenSlots[0], slotId: "species-12", label: "Species 12" }],
        }),
      ).toBe(false);
    });

    it("selects distinct evidence metrics for a one-species ecosystem", () => {
      const spec = {
        ...specWith({ kind: "measured", metricKey: "longevity", direction: "maximize" }),
        speciesSlots: [
          {
            slotId: "grazer",
            label: "Grazer",
            countMin: 1,
            countMax: 1,
            defaultCount: 1,
            senses: [],
          },
        ],
      };
      const samples = [{
        values: [
          { key: "longevity", value: 4 },
          { key: "livingAutomata", value: 1 },
          { key: "livingSpecies", value: 1 },
          { key: "resourceBiomass", value: 8 },
          { key: "totalEnergy", value: 7 },
        ],
      }];
      expect(chartMetricKeys(spec, samples)).toEqual([
        "longevity",
        "totalEnergy",
        "resourceBiomass",
        "livingAutomata",
      ]);
    });

    it("retains living-species evidence when a multi-species ecosystem makes it distinct", () => {
      const spec = {
        ...specWith({ kind: "measured", metricKey: "longevity", direction: "maximize" }),
        speciesSlots: [
          { slotId: "a", label: "A", countMin: 1, countMax: 1, defaultCount: 1, senses: [] },
          { slotId: "b", label: "B", countMin: 1, countMax: 1, defaultCount: 1, senses: [] },
        ],
      };
      const samples = [{
        values: [
          { key: "longevity", value: 4 },
          { key: "livingAutomata", value: 2 },
          { key: "livingSpecies", value: 2 },
          { key: "resourceBiomass", value: 8 },
          { key: "totalEnergy", value: 7 },
        ],
      }];
      expect(chartMetricKeys(spec, samples)).toContain("livingSpecies");
    });

    it("keeps an early terminal marker inside the chart's run-budget domain", () => {
      expect(chartTimeSpan([{ tick: 10 }], 30)).toBe(30);
      expect(chartTimeSpan([{ tick: 30 }], 30)).toBe(30);
    });

    it("always shows the authored starterHint for a locked slot, ignoring the card", () => {
      const slot = { locked: true, starterHint: "Cooperate first, forgive once." };
      expect(deckDisplayPrompt(slot, { prompt: "A scholar tried to rewrite this." })).toBe(
        "Cooperate first, forgive once.",
      );
      expect(deckDisplayPrompt(slot, { prompt: "" })).toBe("Cooperate first, forgive once.");
    });

    it("falls back to empty text for a locked slot with no authored hint", () => {
      expect(deckDisplayPrompt({ locked: true }, { prompt: "anything" })).toBe("");
    });
  });

  describe("personalDeltaHeadline", () => {
    const spec = specWith({ kind: "measured", metricKey: "longevity", direction: "maximize" });

    it("stays neutral on the first scored run (no baseline to compare against)", () => {
      // Only run so far, bestScore == runScore — a vacuous "your best deck yet".
      expect(personalDeltaHeadline(spec, 40, 40, 1)).toBeNull();
    });

    it("shows the superlative once a second run beats the prior best", () => {
      expect(personalDeltaHeadline(spec, 50, 40, 2)).toBe("your best deck yet");
    });

    it("shows the superlative on a tie", () => {
      expect(personalDeltaHeadline(spec, 40, 40, 2)).toBe("your best deck yet");
    });

    it("shows the personal-delta copy when the second run is worse", () => {
      expect(personalDeltaHeadline(spec, 30, 40, 2)).toBe("-10 vs your best");
    });

    it("stays neutral with no runScore or bestScore even past the first run", () => {
      expect(personalDeltaHeadline(spec, null, 40, 3)).toBeNull();
      expect(personalDeltaHeadline(spec, 40, null, 3)).toBeNull();
    });

    it("suppresses a superlative for an extinct outcome", () => {
      expect(personalDeltaHeadline(spec, 50, 40, 3, true)).toBeNull();
    });
  });

  describe("personalDeltaHeadline for target-direction criteria (review Finding 2)", () => {
    // target 50: raw score sign is meaningless for "closer to target" — a
    // numerically higher run can be objectively FURTHER from the goal.
    const spec = specWith({
      kind: "measured",
      metricKey: "livingSpecies",
      direction: "target",
      target: 50,
    });

    it("shows the superlative when the second run lands exactly on target", () => {
      expect(personalDeltaHeadline(spec, 50, 48, 2)).toBe("your best deck yet");
    });

    it("shows the superlative on a tie (identical scores)", () => {
      expect(personalDeltaHeadline(spec, 48, 48, 2)).toBe("your best deck yet");
    });

    it("shows the superlative when the run is genuinely closer to target (not exact)", () => {
      // best=48 (distance 2), run=49 (distance 1) — a real improvement.
      expect(personalDeltaHeadline(spec, 49, 48, 2)).toBe("your best deck yet");
    });

    it("reports distance-to-target when a numerically HIGHER run is objectively worse", () => {
      // best=48 (distance 2), run=53 (distance 3) — +5 raw would lie; the run
      // is further from the target despite the higher number.
      expect(personalDeltaHeadline(spec, 53, 48, 2)).toBe("1 further from target vs your best");
    });

    it("reports distance-to-target when a numerically LOWER run is also worse", () => {
      // best=48 (distance 2), run=40 (distance 10) — worse in both raw and distance terms.
      expect(personalDeltaHeadline(spec, 40, 48, 2)).toBe("8 further from target vs your best");
    });
  });

  describe("composeSpeciesIconLabel (species icon generation sees the world's setting)", () => {
    it("composes world:<setting phrase>:<species>, all lowercased", () => {
      expect(composeSpeciesIconLabel("ecosystemGrid", "Grazers")).toBe(
        "world:coral reef ecosystem:grazers",
      );
    });

    it("collapses internal whitespace runs to a single space", () => {
      expect(composeSpeciesIconLabel("ecosystemGrid", "Grazer   Fish")).toBe(
        composeSpeciesIconLabel("ecosystemGrid", "Grazer Fish"),
      );
    });

    it("trims the final composed string's outer edges but preserves an internal leading space (whole-string normalization, unchanged since #2159/#2161)", () => {
      // Normalization operates on the WHOLE composed string (trim only trims
      // the outer edges) — a species label with its OWN leading/trailing
      // whitespace collapses that internal run to a single space rather than
      // stripping it, because it isn't at the string's absolute start/end.
      expect(composeSpeciesIconLabel("ecosystemGrid", "  Grazers  ")).toBe(
        "world:coral reef ecosystem: grazers",
      );
    });

    it("is stable: same template + species always composes the same key", () => {
      const a = composeSpeciesIconLabel("ecosystemGrid", "Grazers");
      const b = composeSpeciesIconLabel("ecosystemGrid", "Grazers");
      expect(a).toBe(b);
    });

    it("composes the authored setting phrase per template (fixes the 4/24 word-prior misgenerations)", () => {
      expect(composeSpeciesIconLabel("ecosystemGrid", "Grazers")).toBe(
        "world:coral reef ecosystem:grazers",
      );
      expect(composeSpeciesIconLabel("prisonersDilemma", "Trader Ben")).toBe(
        "world:two trading partners:trader ben",
      );
      expect(composeSpeciesIconLabel("matrixGame", "Row Player")).toBe(
        "world:two players in a strategy game:row player",
      );
      expect(composeSpeciesIconLabel("publicGoods", "Contributor")).toBe(
        "world:village of neighbors:contributor",
      );
    });

    it("falls back to the raw template id for an unknown/future template (no phrase authored yet)", () => {
      expect(composeSpeciesIconLabel("someFutureTemplate", "Widget")).toBe(
        "world:somefuturetemplate:widget",
      );
    });

    it("differs by template, so the same species label draws differently per template's setting", () => {
      const grid = composeSpeciesIconLabel("ecosystemGrid", "Sharer");
      const goods = composeSpeciesIconLabel("publicGoods", "Sharer");
      expect(grid).not.toBe(goods);
    });

    it("no longer includes the world title (dropped: the setting phrase alone does the steering work, and titles pushed 7 of #2159's keys over the cache's length cap)", () => {
      expect(composeSpeciesIconLabel("ecosystemGrid", "Grazers")).not.toContain("the reef");
    });

    describe("MAX_THEME_LABEL_LEN cache-key cap (manipulativeThemeIcons.ensure REJECTS anything longer, silently)", () => {
      // Import the REAL cap `convex/manipulativeThemeIcons.ts` enforces, so this
      // test fails loudly if the two ever drift instead of the helper silently
      // clamping to a stale number.
      it("every current template clears the cap even with a realistic 30-char species label", () => {
        const speciesLabel30 = "abcdefghijklmnopqrstuvwxyz1234";
        expect(speciesLabel30).toHaveLength(30);
        for (const template of [
          "ecosystemGrid",
          "prisonersDilemma",
          "matrixGame", // the longest authored phrase — the tightest budget
          "publicGoods",
        ]) {
          const label = composeSpeciesIconLabel(template, speciesLabel30);
          expect(label.length).toBeLessThanOrEqual(MAX_THEME_LABEL_LEN);
        }
      });

      it("clamps by truncating the species TAIL, never the setting phrase", () => {
        const speciesLabel30 = "abcdefghijklmnopqrstuvwxyz1234";
        // matrixGame has the longest phrase (30 chars), so its prefix
        // ("world:two players in a strategy game:") leaves the least budget —
        // this composition overflows MAX_THEME_LABEL_LEN before clamping.
        const label = composeSpeciesIconLabel("matrixGame", speciesLabel30);
        expect(label.length).toBe(MAX_THEME_LABEL_LEN);
        expect(label.startsWith("world:two players in a strategy game:")).toBe(true);
        // The species tail is a truncated PREFIX of the original label, not a
        // different string entirely — clamping never rewrites the phrase.
        expect(speciesLabel30.startsWith(label.slice("world:two players in a strategy game:".length))).toBe(
          true,
        );
      });

      it("does not clamp a realistic composition that already clears the cap", () => {
        const label = composeSpeciesIconLabel("ecosystemGrid", "Grazers");
        expect(label.length).toBeLessThan(MAX_THEME_LABEL_LEN);
        expect(label).toBe("world:coral reef ecosystem:grazers");
      });
    });
  });
});

describe("round-token / pool entity classification", () => {
  describe("isRoundTokenEntityKind", () => {
    it.each([
      "token:cooperate",
      "token:defect",
      "token:optionA",
      "token:optionB",
      "token:contribute",
      "token:withhold",
    ])("recognizes %s as a token entity kind", (kind) => {
      expect(isRoundTokenEntityKind(kind)).toBe(true);
    });

    it.each(["automaton", "corpse", "pool", "token:", ""])(
      "does not recognize %s as a token entity kind",
      (kind) => {
        expect(isRoundTokenEntityKind(kind)).toBe(false);
      },
    );
  });

  describe("isPoolEntityKind", () => {
    it("recognizes the publicGoods pool entity kind", () => {
      expect(isPoolEntityKind("pool")).toBe(true);
    });

    it.each(["automaton", "corpse", "token:contribute", "poolside", ""])(
      "does not recognize %s as the pool entity kind",
      (kind) => {
        expect(isPoolEntityKind(kind)).toBe(false);
      },
    );
  });

  describe("tokenBadgeGlyph", () => {
    it.each([
      ["Cooperate", "C"],
      ["Defect", "D"],
      ["Contribute", "C"],
      ["Withhold", "W"],
      ["Hunt stag", "H"],
    ] as const)("takes the uppercased first letter of %s", (label, glyph) => {
      expect(tokenBadgeGlyph(label)).toBe(glyph);
    });

    it("falls back to a plain dot for a missing or blank label", () => {
      expect(tokenBadgeGlyph(undefined)).toBe("•");
      expect(tokenBadgeGlyph("   ")).toBe("•");
      expect(tokenBadgeGlyph("")).toBe("•");
    });
  });
});
