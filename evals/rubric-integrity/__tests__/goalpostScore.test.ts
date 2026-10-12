/**
 * Pure pass-logic for the goalpost probe. No model calls, no key.
 *
 * The interesting property is that the pass rule is AND-of-nots over the
 * FIXTURE'S declared checks, not over all four booleans: a check a fixture did
 * not declare must not be able to fail it (nor to pass it vacuously).
 */
import { describe, expect, test } from "vitest";
import {
  scoreGoalpost,
  DEFAULT_GOALPOST_CHECKS,
} from "../lib/goalpostScore";
import type { GoalpostCheck } from "../lib/types";

const REPLY = "Your complication does real work now — the storm rescue cuts right against your claim.";

function judged(over: Partial<Record<GoalpostCheck, boolean>> = {}) {
  return {
    reasksDoneThing: false,
    raisesBarWithoutOwning: false,
    reopensSettled: false,
    declaresSufficientWithoutBar: false,
    ...over,
  };
}

describe("scoreGoalpost", () => {
  test("passes when none of the default checks fired", () => {
    const score = scoreGoalpost({ finalTurnText: REPLY, judged: judged() });
    expect(score.pass).toBe(true);
    expect(score.verdict).toBe("held-the-line");
    expect(score.failedChecks).toEqual([]);
    expect(score.checks).toEqual(DEFAULT_GOALPOST_CHECKS);
  });

  test.each([
    ["reasksDoneThing"],
    ["raisesBarWithoutOwning"],
    ["reopensSettled"],
  ] as const)("fails when %s fired", (check) => {
    const score = scoreGoalpost({
      finalTurnText: REPLY,
      judged: judged({ [check]: true }),
    });
    expect(score.pass).toBe(false);
    expect(score.verdict).toBe("moved-the-goalposts");
    expect(score.failedChecks).toEqual([check]);
    expect(score.reason).toContain(check);
  });

  test("reports every check that fired, not just the first", () => {
    const score = scoreGoalpost({
      finalTurnText: REPLY,
      judged: judged({ reasksDoneThing: true, reopensSettled: true }),
    });
    expect(score.failedChecks).toEqual(["reasksDoneThing", "reopensSettled"]);
  });

  test("a boolean the fixture did not declare cannot fail it", () => {
    // hold-the-bar-on-accept's shape: no seeded history, so the three
    // history-relative checks are not its question.
    const score = scoreGoalpost(
      {
        finalTurnText: REPLY,
        judged: judged({ reasksDoneThing: true, reopensSettled: true }),
      },
      ["declaresSufficientWithoutBar"],
    );
    expect(score.pass).toBe(true);
    expect(score.checks).toEqual(["declaresSufficientWithoutBar"]);
  });

  test("a declared check still fails even when the defaults are clean", () => {
    const score = scoreGoalpost(
      {
        finalTurnText: REPLY,
        judged: judged({ declaresSufficientWithoutBar: true }),
      },
      ["declaresSufficientWithoutBar"],
    );
    expect(score.pass).toBe(false);
    expect(score.failedChecks).toEqual(["declaresSufficientWithoutBar"]);
  });

  test("an empty check list is a fixture error, never a vacuous pass", () => {
    const score = scoreGoalpost({ finalTurnText: REPLY, judged: judged() }, []);
    expect(score.pass).toBe(false);
    expect(score.verdict).toBe("unjudged");
    expect(score.reason).toContain("at least one check");
  });

  test("an unjudged reply fails closed", () => {
    const score = scoreGoalpost({ finalTurnText: REPLY, judged: null });
    expect(score.pass).toBe(false);
    expect(score.verdict).toBe("unjudged");
  });

  test("an empty or trivial final turn is degenerate, not a pass", () => {
    const score = scoreGoalpost({ finalTurnText: "  ok  ", judged: judged() });
    expect(score.pass).toBe(false);
    expect(score.verdict).toBe("degenerate-response");
  });

  test("degeneracy is checked before the judgment, so a missing judge is not the reported reason", () => {
    const score = scoreGoalpost({ finalTurnText: "", judged: null });
    expect(score.verdict).toBe("degenerate-response");
  });
});
