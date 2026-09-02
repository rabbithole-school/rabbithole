import { describe, expect, test } from "vitest";

import {
  deckModeFromSlots,
  payoffOrderingIssues,
  speciesSlotsForDeckMode,
} from "./prisonersDilemmaHelpers";
import { validatePrisonersDilemmaSpec } from "@/lib/simulator/templates/prisonersDilemma";
import { defaultPrisonersDilemmaSpec } from "./prisonersDilemma";

describe("prisonersDilemma payoff constraint hints", () => {
  test("the canonical matrix has no ordering issues", () => {
    expect(
      payoffOrderingIssues({ mutualCooperation: 3, temptation: 5, sucker: 0, mutualDefection: 1 }),
    ).toEqual([]);
  });

  test("flags temptation not exceeding mutual cooperation", () => {
    const issues = payoffOrderingIssues({
      mutualCooperation: 3,
      temptation: 2,
      sucker: 0,
      mutualDefection: 1,
    });
    expect(issues).toContain("Temptation must be greater than mutual cooperation.");
  });

  test("flags mutual cooperation not exceeding mutual defection", () => {
    const issues = payoffOrderingIssues({
      mutualCooperation: 1,
      temptation: 5,
      sucker: 0,
      mutualDefection: 2,
    });
    expect(issues).toContain("Mutual cooperation must be greater than mutual defection.");
  });

  test("flags mutual defection not exceeding the sucker payoff", () => {
    const issues = payoffOrderingIssues({
      mutualCooperation: 3,
      temptation: 5,
      sucker: 2,
      mutualDefection: 1,
    });
    expect(issues).toContain("Mutual defection must be greater than the sucker payoff.");
  });

  test("flags mutual cooperation not beating alternating exploitation", () => {
    // temptation + sucker = 5, 2*mutualCooperation = 4 -- violates the tit-for-tat guard.
    const issues = payoffOrderingIssues({
      mutualCooperation: 2,
      temptation: 5,
      sucker: 0,
      mutualDefection: 1,
    });
    expect(issues).toContain(
      "Mutual cooperation must beat alternating exploitation: 2× mutual cooperation must exceed temptation + sucker.",
    );
  });

  test("hint set agrees with the real server validator: legal matrix -> no issues and validateSpec passes", () => {
    const spec = defaultPrisonersDilemmaSpec({
      id: "prisonersDilemma",
      version: 1,
      senseIds: ["history"],
      actionKinds: ["cooperate", "defect"],
      metricKeys: [],
      summaryMetricKeys: [],
    });
    expect(spec.templateId).toBe("prisonersDilemma");
    if (spec.templateId !== "prisonersDilemma") throw new Error("unreachable");
    expect(payoffOrderingIssues(spec.config.payoffMatrix)).toEqual([]);
    expect(() => validatePrisonersDilemmaSpec(spec)).not.toThrow();
  });

  test("hint set agrees with the real server validator: illegal matrix -> issues and validateSpec throws", () => {
    const spec = defaultPrisonersDilemmaSpec({
      id: "prisonersDilemma",
      version: 1,
      senseIds: ["history"],
      actionKinds: ["cooperate", "defect"],
      metricKeys: [],
      summaryMetricKeys: [],
    });
    if (spec.templateId !== "prisonersDilemma") throw new Error("unreachable");
    const broken = {
      ...spec,
      config: { ...spec.config, payoffMatrix: { mutualCooperation: 1, temptation: 5, sucker: 0, mutualDefection: 2 } },
    };
    expect(payoffOrderingIssues(broken.config.payoffMatrix).length).toBeGreaterThan(0);
    expect(() => validatePrisonersDilemmaSpec(broken)).toThrow();
  });
});

describe("prisonersDilemma deck mode", () => {
  test("deckModeFromSlots reads self-play from one slot and two-decks from two", () => {
    expect(
      deckModeFromSlots([
        { slotId: "deck", label: "Deck", countMin: 2, countMax: 2, defaultCount: 2, senses: [{ senseId: "history" }] },
      ]),
    ).toBe("selfPlay");
    expect(
      deckModeFromSlots([
        { slotId: "deck_a", label: "Deck A", countMin: 1, countMax: 1, defaultCount: 1, senses: [{ senseId: "history" }] },
        { slotId: "deck_b", label: "Deck B", countMin: 1, countMax: 1, defaultCount: 1, senses: [{ senseId: "history" }] },
      ]),
    ).toBe("twoDecks");
  });

  test("speciesSlotsForDeckMode(selfPlay) collapses to one slot summing to 2 automata", () => {
    const slots = speciesSlotsForDeckMode("selfPlay", [
      { slotId: "deck_a", label: "Deck A", countMin: 1, countMax: 1, defaultCount: 1, senses: [{ senseId: "history" }], starterHint: "Tit for tat" },
      { slotId: "deck_b", label: "Deck B", countMin: 1, countMax: 1, defaultCount: 1, senses: [{ senseId: "history" }] },
    ]);
    expect(slots).toHaveLength(1);
    expect(slots[0].defaultCount).toBe(2);
    expect(slots[0].countMin).toBe(2);
    expect(slots[0].countMax).toBe(2);
    expect(slots[0].label).toBe("Deck A");
    expect(slots[0].starterHint).toBe("Tit for tat");
    expect(slots.reduce((sum, s) => sum + s.defaultCount, 0)).toBe(2);
  });

  test("speciesSlotsForDeckMode(twoDecks) splits to two slots each defaulting to 1", () => {
    const slots = speciesSlotsForDeckMode("twoDecks", [
      { slotId: "deck", label: "Deck", countMin: 2, countMax: 2, defaultCount: 2, senses: [{ senseId: "history" }], starterHint: "Always cooperate" },
    ]);
    expect(slots).toHaveLength(2);
    expect(slots.reduce((sum, s) => sum + s.defaultCount, 0)).toBe(2);
    expect(slots[0].starterHint).toBe("Always cooperate");
    expect(slots[1].defaultCount).toBe(1);
  });

  test("every senses package for every slot stays exactly the fixed history sense", () => {
    for (const mode of ["selfPlay", "twoDecks"] as const) {
      const slots = speciesSlotsForDeckMode(mode, []);
      for (const slot of slots) {
        expect(slot.senses).toEqual([{ senseId: "history" }]);
      }
    }
  });
});
