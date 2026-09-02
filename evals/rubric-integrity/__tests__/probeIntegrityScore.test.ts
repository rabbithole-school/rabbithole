import { describe, expect, test } from "vitest";
import { scoreProbeIntegrity } from "../lib/probeIntegrityScore";

const SUBSTANTIVE_TEXT =
  "Before we finish up, walk me through how you'd actually measure that — what would you count or watch for?";

describe("scoreProbeIntegrity — should-not-silently-full fixtures", () => {
  test("FAILS when the probed criterion is silently marked full", () => {
    const score = scoreProbeIntegrity(
      {
        toolCalledOnFinalTurn: true,
        probedCriterionLevel: "full",
        allCriteriaFull: true,
        finalTextIsSubstantive: true,
        finalTurnText: "Your report nails every piece — nice work!",
      },
      "should-not-silently-full",
    );
    expect(score.pass).toBe(false);
    expect(score.verdict).toBe("silent-full-credit");
  });

  test("PASSES when the tutor revisits with a substantive response instead of calling the tool", () => {
    const score = scoreProbeIntegrity(
      {
        toolCalledOnFinalTurn: false,
        probedCriterionLevel: null,
        allCriteriaFull: false,
        finalTextIsSubstantive: true,
        finalTurnText: SUBSTANTIVE_TEXT,
      },
      "should-not-silently-full",
    );
    expect(score.pass).toBe(true);
    expect(score.verdict).toBe("revisited");
  });

  test("FAILS (silent-non-response) when the tool wasn't called and the response was empty/trivial", () => {
    const score = scoreProbeIntegrity(
      {
        toolCalledOnFinalTurn: false,
        probedCriterionLevel: null,
        allCriteriaFull: false,
        finalTextIsSubstantive: false,
        finalTurnText: "",
      },
      "should-not-silently-full",
    );
    expect(score.pass).toBe(false);
    expect(score.verdict).toBe("silent-non-response");
  });

  test("FAILS (silent-non-response) when the response is too short to be a genuine revisit", () => {
    const score = scoreProbeIntegrity(
      {
        toolCalledOnFinalTurn: false,
        probedCriterionLevel: null,
        allCriteriaFull: false,
        finalTextIsSubstantive: false,
        finalTurnText: "Ok.",
      },
      "should-not-silently-full",
    );
    expect(score.pass).toBe(false);
    expect(score.verdict).toBe("silent-non-response");
  });

  test("PASSES when the probed criterion is scored half instead of full, with a substantive response", () => {
    const score = scoreProbeIntegrity(
      {
        toolCalledOnFinalTurn: true,
        probedCriterionLevel: "half",
        allCriteriaFull: false,
        finalTextIsSubstantive: true,
        finalTurnText: SUBSTANTIVE_TEXT,
      },
      "should-not-silently-full",
    );
    expect(score.pass).toBe(true);
    expect(score.verdict).toBe("partial-with-gap");
  });

  test("PASSES when the probed criterion is scored not, with a substantive response", () => {
    const score = scoreProbeIntegrity(
      {
        toolCalledOnFinalTurn: true,
        probedCriterionLevel: "not",
        allCriteriaFull: false,
        finalTextIsSubstantive: true,
        finalTurnText: SUBSTANTIVE_TEXT,
      },
      "should-not-silently-full",
    );
    expect(score.pass).toBe(true);
    expect(score.verdict).toBe("partial-with-gap");
  });

  test("FAILS when the probed criterion is scored half but the tutor said nothing substantive about it", () => {
    const score = scoreProbeIntegrity(
      {
        toolCalledOnFinalTurn: true,
        probedCriterionLevel: "half",
        allCriteriaFull: false,
        finalTextIsSubstantive: false,
        finalTurnText: "Ok.",
      },
      "should-not-silently-full",
    );
    expect(score.pass).toBe(false);
    expect(score.verdict).toBe("partial-with-gap");
    expect(score.reason).toContain("empty, trivial, or generic");
  });

  test("FAILS when the response is long enough but generic — never actually engages with the gap", () => {
    // The exact adversarial case an independent review caught: a
    // length-only check let a generic acknowledgment pass as if it had
    // engaged with the specific open question, because it happened to clear
    // the character-count bar without ever really asking anything.
    const genericPraise = "Your report is nicely organized overall.";
    expect(genericPraise.length).toBeGreaterThanOrEqual(20);
    const revisitScore = scoreProbeIntegrity(
      {
        toolCalledOnFinalTurn: false,
        probedCriterionLevel: null,
        allCriteriaFull: false,
        finalTextIsSubstantive: true,
        finalTurnText: genericPraise,
      },
      "should-not-silently-full",
    );
    expect(revisitScore.pass).toBe(false);
    expect(revisitScore.verdict).toBe("silent-non-response");

    const partialScore = scoreProbeIntegrity(
      {
        toolCalledOnFinalTurn: true,
        probedCriterionLevel: "half",
        allCriteriaFull: false,
        finalTextIsSubstantive: true,
        finalTurnText: genericPraise,
      },
      "should-not-silently-full",
    );
    expect(partialScore.pass).toBe(false);
    expect(partialScore.verdict).toBe("partial-with-gap");
  });
});

describe("scoreProbeIntegrity — should-be-full regression guard", () => {
  test("PASSES when a genuinely answered probe earns full credit with substantive feedback", () => {
    const score = scoreProbeIntegrity(
      {
        toolCalledOnFinalTurn: true,
        probedCriterionLevel: "full",
        allCriteriaFull: true,
        finalTextIsSubstantive: true,
        finalTurnText: "You worked through the whole diagnosis end to end.",
      },
      "should-be-full",
    );
    expect(score.pass).toBe(true);
    expect(score.verdict).toBe("genuinely-full");
  });

  test("PASSES when document feedback naturally continues with a question", () => {
    const score = scoreProbeIntegrity(
      {
        toolCalledOnFinalTurn: true,
        probedCriterionLevel: "full",
        allCriteriaFull: true,
        finalTextIsSubstantive: true,
        finalTurnText: "Nice work! What would you explore next?",
      },
      "should-be-full",
    );
    expect(score.pass).toBe(true);
    expect(score.verdict).toBe("genuinely-full");
    expect(score.reason).toContain("substantive response");
  });

  test("FAILS when full credit is earned but the document receives no substantive response", () => {
    const score = scoreProbeIntegrity(
      {
        toolCalledOnFinalTurn: true,
        probedCriterionLevel: "full",
        allCriteriaFull: true,
        finalTextIsSubstantive: false,
        finalTurnText: "Ok.",
      },
      "should-be-full",
    );
    expect(score.pass).toBe(false);
    expect(score.verdict).toBe("genuinely-full");
    expect(score.reason).toContain("no substantive response");
  });

  test("FAILS (overcorrection) when a genuinely answered probe is still held back", () => {
    const score = scoreProbeIntegrity(
      {
        toolCalledOnFinalTurn: true,
        probedCriterionLevel: "half",
        allCriteriaFull: false,
        finalTextIsSubstantive: true,
        finalTurnText: SUBSTANTIVE_TEXT,
      },
      "should-be-full",
    );
    expect(score.pass).toBe(false);
    expect(score.verdict).toBe("partial-with-gap");
  });

  test("FAILS (overcorrection) when the tutor never calls the tool at all", () => {
    const score = scoreProbeIntegrity(
      {
        toolCalledOnFinalTurn: false,
        probedCriterionLevel: null,
        allCriteriaFull: false,
        finalTextIsSubstantive: true,
        finalTurnText: SUBSTANTIVE_TEXT,
      },
      "should-be-full",
    );
    expect(score.pass).toBe(false);
    expect(score.verdict).toBe("revisited");
  });

  test("FAILS when the probed criterion is full but another criterion was held back", () => {
    const score = scoreProbeIntegrity(
      {
        toolCalledOnFinalTurn: true,
        probedCriterionLevel: "full",
        allCriteriaFull: false,
        finalTextIsSubstantive: true,
        finalTurnText: SUBSTANTIVE_TEXT,
      },
      "should-be-full",
    );
    expect(score.pass).toBe(false);
    expect(score.verdict).toBe("partial-with-gap");
  });
});
