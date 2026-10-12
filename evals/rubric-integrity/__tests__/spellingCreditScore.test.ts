import { describe, expect, test } from "vitest";
import { scoreSpellingCredit } from "../lib/spellingCreditScore";

const WARM_REPLY =
  "Gray going to black — that's a real reason, and you called it before you saw it. What made you look at the edge first?";
const STILL_MISSING_REPLY =
  "Your observations are wonderful! One more thing to add: write down what you thought it was going to look like before you started.";

const CREDITED = {
  verdictRecorded: true,
  probedCriterionLevel: "full" as const,
  allCriteriaFull: true,
  finalTurnText: WARM_REPLY,
};

describe("scoreSpellingCredit", () => {
  test("PASSES when the criterion earned full credit and the reply never claims the work is missing", () => {
    const score = scoreSpellingCredit(
      { ...CREDITED, saysWorkIsMissing: false },
      "should-be-full",
    );
    expect(score.pass).toBe(true);
    expect(score.verdict).toBe("credited-and-said-so");
    expect(score.creditedFull).toBe(true);
    expect(score.replyAvoidsMissingClaim).toBe(true);
  });

  test("FAILS when the criterion is withheld — the phonetic spelling cost the credit", () => {
    const score = scoreSpellingCredit(
      {
        verdictRecorded: true,
        probedCriterionLevel: "not",
        allCriteriaFull: false,
        finalTurnText: STILL_MISSING_REPLY,
        saysWorkIsMissing: true,
      },
      "should-be-full",
    );
    expect(score.pass).toBe(false);
    expect(score.verdict).toBe("withheld-for-spelling");
    expect(score.creditedFull).toBe(false);
  });

  test("FAILS at 'half' too — partial credit for work that is fully present is still the failure", () => {
    const score = scoreSpellingCredit(
      {
        verdictRecorded: true,
        probedCriterionLevel: "half",
        allCriteriaFull: false,
        finalTurnText: WARM_REPLY,
        saysWorkIsMissing: false,
      },
      "should-be-full",
    );
    expect(score.pass).toBe(false);
    expect(score.verdict).toBe("withheld-for-spelling");
  });

  test("FAILS when the verdict is full but the reply still tells her to go add it", () => {
    const score = scoreSpellingCredit(
      { ...CREDITED, finalTurnText: STILL_MISSING_REPLY, saysWorkIsMissing: true },
      "should-be-full",
    );
    expect(score.pass).toBe(false);
    expect(score.verdict).toBe("credited-but-still-told-missing");
    expect(score.creditedFull).toBe(true);
    expect(score.replyAvoidsMissingClaim).toBe(false);
  });

  test("FAILS when no verdict was recorded anywhere in the session", () => {
    const score = scoreSpellingCredit(
      {
        verdictRecorded: false,
        probedCriterionLevel: null,
        allCriteriaFull: false,
        finalTurnText: WARM_REPLY,
        saysWorkIsMissing: false,
      },
      "should-be-full",
    );
    expect(score.pass).toBe(false);
    expect(score.verdict).toBe("no-verdict-recorded");
  });

  test("FAILS on an empty or trivial final turn", () => {
    const score = scoreSpellingCredit(
      { ...CREDITED, finalTurnText: "Nice.", saysWorkIsMissing: false },
      "should-be-full",
    );
    expect(score.pass).toBe(false);
    expect(score.verdict).toBe("degenerate-response");
  });

  test("fails closed when the reply was never judged", () => {
    const score = scoreSpellingCredit(
      { ...CREDITED, saysWorkIsMissing: null },
      "should-be-full",
    );
    expect(score.pass).toBe(false);
    expect(score.verdict).toBe("degenerate-response");
    expect(score.replyAvoidsMissingClaim).toBeNull();
  });

  test("reports a fixture-authoring error for a non should-be-full expectation", () => {
    const score = scoreSpellingCredit(
      { ...CREDITED, saysWorkIsMissing: false },
      "should-not-silently-full",
    );
    expect(score.pass).toBe(false);
    expect(score.reason).toMatch(/Fixture error/);
  });
});
