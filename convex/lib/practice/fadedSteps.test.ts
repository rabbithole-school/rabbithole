import { describe, expect, test } from "vitest";
import { applyFade, clampFadeLevel, deriveStepHint, scaffoldLevelFor, type WorkedStep } from "./fadedSteps";
import { FLUENT_REPS, OVERLEARNED_REPS } from "./scheduler";
import { FADED_FRACTION_ADDITION_ITEMS } from "../../practiceSkills";

const STEPS: WorkedStep[] = [
  { text: "Find a common denominator for 4 and 3: 12.", blankText: "Find a common denominator: ___" },
  { text: "Convert: 1/4 = 3/12 and 1/3 = 4/12.", blankText: "Convert both fractions: ___" },
  { text: "Add the numerators: 3/12 + 4/12 = 7/12.", blankText: "Add the numerators: ___" },
  { text: "Simplify: 7/12 is already in lowest terms.", blankText: "Simplify the result: ___" },
];

const COMPLETION_PROMPT = "Your turn — finish the last step and enter the answer.";

describe("scaffoldLevelFor — the fade-level mapping (completion effect: min 1)", () => {
  test("no row → level 1 (not_started still hides the last, answer-producing step)", () => {
    expect(scaffoldLevelFor(undefined)).toBe(1);
    expect(scaffoldLevelFor(null)).toBe(1);
  });

  test("repetition 0 → level 1 (last step faded — never a full answer key)", () => {
    expect(scaffoldLevelFor({ repetition: 0 })).toBe(1);
  });

  test("repetition 1 (practicing, low) → level 2", () => {
    expect(scaffoldLevelFor({ repetition: 1 })).toBe(2);
  });

  test("repetition 2 (practicing, high) → level 3", () => {
    expect(scaffoldLevelFor({ repetition: 2 })).toBe(3);
  });

  test("repetition >= FLUENT_REPS (accessProven) → fully bare (Infinity sentinel)", () => {
    expect(scaffoldLevelFor({ repetition: FLUENT_REPS })).toBe(Number.POSITIVE_INFINITY);
    expect(scaffoldLevelFor({ repetition: OVERLEARNED_REPS })).toBe(Number.POSITIVE_INFINITY);
    expect(scaffoldLevelFor({ repetition: OVERLEARNED_REPS + 10 })).toBe(Number.POSITIVE_INFINITY);
  });

  test("never returns below the minimum of 1", () => {
    expect(scaffoldLevelFor({ repetition: -5 })).toBe(1);
  });
});

describe("clampFadeLevel", () => {
  test("clamps within [0, stepsLength]", () => {
    expect(clampFadeLevel(-1, 4)).toBe(0);
    expect(clampFadeLevel(0, 4)).toBe(0);
    expect(clampFadeLevel(2, 4)).toBe(2);
    expect(clampFadeLevel(4, 4)).toBe(4);
    expect(clampFadeLevel(99, 4)).toBe(4);
  });

  test("the Infinity sentinel clamps to the full step count", () => {
    expect(clampFadeLevel(Number.POSITIVE_INFINITY, 4)).toBe(4);
  });
});

describe("applyFade — backward fading (last step fades first)", () => {
  test("level 0 (mechanical): every step revealed, no faded steps, no completion prompt", () => {
    // scaffoldLevelFor never returns 0 anymore, but applyFade must still handle
    // a raw 0 mechanically (no fade).
    const result = applyFade(STEPS, 0);
    expect(result.revealed).toHaveLength(4);
    expect(result.revealed.map((s) => s.text)).toEqual(STEPS.map((s) => s.text));
    expect(result.faded).toHaveLength(0);
    expect(result.selfExplainPrompt).toBeUndefined();
  });

  test("level 1: fades the LAST step only, keeps the first 3 revealed", () => {
    const result = applyFade(STEPS, 1);
    expect(result.revealed).toHaveLength(3);
    expect(result.revealed.map((s) => s.text)).toEqual(STEPS.slice(0, 3).map((s) => s.text));
    expect(result.faded).toHaveLength(1);
    expect(result.faded[0]).toEqual({ blankText: "Simplify the result: ___" });
  });

  test("level 2: fades the last TWO steps (backward order), not the first two", () => {
    const result = applyFade(STEPS, 2);
    expect(result.revealed).toHaveLength(2);
    expect(result.revealed.map((s) => s.text)).toEqual(STEPS.slice(0, 2).map((s) => s.text));
    expect(result.faded).toHaveLength(2);
    expect(result.faded).toEqual([
      { blankText: "Add the numerators: ___" },
      { blankText: "Simplify the result: ___" },
    ]);
  });

  test("level >= steps.length: every step faded (bare problem)", () => {
    const result = applyFade(STEPS, 4);
    expect(result.revealed).toHaveLength(0);
    expect(result.faded).toHaveLength(4);
    const infResult = applyFade(STEPS, Number.POSITIVE_INFINITY);
    expect(infResult.revealed).toHaveLength(0);
    expect(infResult.faded).toHaveLength(4);
  });

  test("a faded step's real `text` never appears anywhere in the result", () => {
    for (const level of [1, 2, 3, 4]) {
      const result = applyFade(STEPS, level);
      const serialized = JSON.stringify(result);
      // Every faded step's real text is absent from the whole payload.
      const fadedTexts = STEPS.slice(STEPS.length - level).map((s) => s.text);
      for (const text of fadedTexts) {
        expect(serialized.includes(text)).toBe(false);
      }
    }
  });

  test("a missing blankText falls back to the generic placeholder", () => {
    const noBlank: WorkedStep[] = [{ text: "Step one." }, { text: "Step two." }];
    const result = applyFade(noBlank, 1);
    expect(result.faded).toEqual([{ blankText: "___" }]);
  });

  test("completion prompt fires whenever there's a revealed step AND a faded step", () => {
    expect(applyFade(STEPS, 1).selfExplainPrompt).toBe(COMPLETION_PROMPT);
    expect(applyFade(STEPS, 2).selfExplainPrompt).toBe(COMPLETION_PROMPT);
    expect(applyFade(STEPS, 3).selfExplainPrompt).toBe(COMPLETION_PROMPT);
  });

  test("no completion prompt once every step is faded (a bare problem needs no card)", () => {
    expect(applyFade(STEPS, 4).selfExplainPrompt).toBeUndefined();
    expect(applyFade(STEPS, Number.POSITIVE_INFINITY).selfExplainPrompt).toBeUndefined();
  });

  test("empty steps array is a no-op", () => {
    const result = applyFade([], 3);
    expect(result.revealed).toEqual([]);
    expect(result.faded).toEqual([]);
    expect(result.selfExplainPrompt).toBeUndefined();
  });
});

describe("load-bearing invariant — the answer is NEVER in the revealed scaffold", () => {
  // The whole point of the completion effect: a scholar can't copy the answer
  // off the scaffold at ANY fade level they can reach. Derive the reachable raw
  // levels straight from scaffoldLevelFor over the full repetition range, then
  // assert every seeded item's `answer` string is absent from every revealed
  // step's text at each of those levels.
  const reachableLevels = [
    scaffoldLevelFor(undefined),
    ...[0, 1, 2, 3, 4, 5, 10].map((repetition) => scaffoldLevelFor({ repetition })),
  ];

  test("the seed fixture is non-empty (guards against an accidental empty loop)", () => {
    expect(FADED_FRACTION_ADDITION_ITEMS.length).toBeGreaterThan(0);
  });

  for (const item of FADED_FRACTION_ADDITION_ITEMS) {
    test(`"${item.stem}" (answer ${item.answer}) never leaks its answer into any revealed step`, () => {
      // The answer must live ONLY in the final, answer-producing step.
      const stepsWithAnswer = item.workedSteps.filter((s) => s.text.includes(item.answer));
      expect(stepsWithAnswer).toEqual([item.workedSteps[item.workedSteps.length - 1]]);

      for (const level of reachableLevels) {
        const { revealed } = applyFade(item.workedSteps, level);
        // The last step (which carries the answer) must always be faded, so no
        // revealed step's text ever contains the answer string.
        for (const step of revealed) {
          expect(step.text.includes(item.answer)).toBe(false);
        }
      }
    });
  }
});

// ── The teaching moment's tier-2 hint ────────────────────────────────────────

describe("deriveStepHint — the middle rung of the hint ladder", () => {
  test("sets the move UP with its operands, but leaves the result open", () => {
    expect(deriveStepHint("Add the partial quotients: 100 + 30 + 6 = 136.", "136")).toBe(
      "Add the partial quotients: 100 + 30 + 6 = ?",
    );
  });

  test("blanks a result the sentence states in PROSE, not just after an =", () => {
    expect(deriveStepHint("Sorted: 3, 5, 7, 9, 11. The middle one is 7.", "7")).toBe(
      "Sorted: 3, 5, 7, 9, 11. The middle one is ?",
    );
  });

  test("blanks EVERY result position — a step may assert the answer twice", () => {
    const hint = deriveStepHint("8 − 8 = 0, so the fraction is 0/16 = 0.", "0");
    expect(hint).toBe("8 − 8 = ?, so the fraction is 0/16 = ?");
  });

  test("keeps an OPERAND that merely happens to equal the answer", () => {
    // The answer is 1, and 1 appears as an INPUT to the move. Blanking it would
    // destroy the very setup the hint exists to give.
    expect(deriveStepHint("Multiply across: 8 × 1 = 8 over 8 × 1 = 8.", "8")).toContain("8 × 1");
  });

  test("never matches the answer glued inside a longer number", () => {
    // "5" must not fire inside 557, 5.7 or 5/8.
    expect(deriveStepHint("Add: 552 + 5 = 557.", "557")).toBe("Add: 552 + 5 = ?");
    expect(deriveStepHint("Halve it: 11.4 ÷ 2 = 5.7.", "5.7")).toBe("Halve it: 11.4 ÷ 2 = ?");
  });

  test("blanks only the RESULT side — the left of the = is the setup", () => {
    expect(deriveStepHint("Write it over the denominator: 3/8 = 3/8.", "3/8")).toBe(
      "Write it over the denominator: 3/8 = ?",
    );
  });

  test("collapses '= ? = ?' when the value was already in simplest form", () => {
    // "6/8 = 3/4 = 3/4" — the simplify rung was a no-op, so two result
    // positions blank in a row and read as noise.
    expect(deriveStepHint("Simplify: 6/8 = 3/4 = 3/4.", "3/4")).toBe("Simplify: 6/8 = ?");
  });

  test("returns undefined when the answer is never asserted as a result", () => {
    expect(deriveStepHint("Think about what the question is asking.", "42")).toBeUndefined();
  });

  test("returns undefined when blanking leaves no operands set up", () => {
    // Nothing is set up — the 'hint' would be a bare "?", which is the blank.
    expect(deriveStepHint("The answer is 42.", "42")).toBeUndefined();
  });

  test("an empty answer is not a rung", () => {
    expect(deriveStepHint("Add: 2 + 2 = 4.", "  ")).toBeUndefined();
  });
});
