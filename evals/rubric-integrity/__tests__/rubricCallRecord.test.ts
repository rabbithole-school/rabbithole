import { describe, expect, test } from "vitest";
import {
  summarizeRubricCalls,
  type RecordedRubricCall,
} from "../lib/rubricCallRecord";

/** A call scoring the probed criterion `level` and a second criterion `other`. */
function call(
  turnIndex: number,
  level: "not" | "half" | "full",
  other: "not" | "half" | "full" = "full",
  onFinalTurn = false,
  roundIndex = 0,
): RecordedRubricCall {
  const verdicts = [
    { criterionId: "prediction", level },
    { criterionId: "evidence", level: other },
  ];
  const overall = verdicts.some((v) => v.level === "not")
    ? ("not" as const)
    : verdicts.some((v) => v.level === "half")
      ? ("half" as const)
      : ("full" as const);
  return { turnIndex, roundIndex, onFinalTurn, verdicts, overall };
}

describe("summarizeRubricCalls", () => {
  test("no calls at all — nothing was ever recorded", () => {
    const s = summarizeRubricCalls([], "prediction");
    expect(s.verdictRecorded).toBe(false);
    expect(s.recordedOnFinalTurn).toBe(false);
    expect(s.level).toBeNull();
    expect(s.finalLevel).toBeNull();
    expect(s.downgraded).toBe(false);
    expect(s.allCriteriaFull).toBe(false);
  });

  test("THE BUG: credit on an earlier turn, prose-only final turn, still counts", () => {
    // The tutor scores the rubric on the turn the document appears (turn 1),
    // then spends the final turn confirming it in words. Reading only the
    // final turn recorded "no verdict" and failed a correct session.
    const s = summarizeRubricCalls([call(1, "full")], "prediction");
    expect(s.verdictRecorded).toBe(true);
    expect(s.recordedOnFinalTurn).toBe(false);
    expect(s.level).toBe("full");
    expect(s.allCriteriaFull).toBe(true);
  });

  test("keeps the peak when a later call re-scores the same criterion upward", () => {
    const s = summarizeRubricCalls(
      [call(1, "half", "half"), call(2, "full", "full", true)],
      "prediction",
    );
    expect(s.level).toBe("full");
    expect(s.finalLevel).toBe("full");
    expect(s.downgraded).toBe(false);
    expect(s.allCriteriaFull).toBe(true);
  });

  test("a walk-back scores on the peak but is reported, never masked", () => {
    // Production mints flair the moment a criterion hits `full` and never
    // revokes it, so the credit was conferred — but the downgrade is real and
    // has to stay visible.
    const s = summarizeRubricCalls(
      [call(1, "full", "full"), call(2, "half", "full", true)],
      "prediction",
    );
    expect(s.level).toBe("full");
    expect(s.finalLevel).toBe("half");
    expect(s.downgraded).toBe(true);
    // The rubric passed once, so completion already fired.
    expect(s.allCriteriaFull).toBe(true);
  });

  test("an upgrade after a downgrade is not reported as a downgrade", () => {
    const s = summarizeRubricCalls(
      [call(1, "full"), call(2, "not"), call(3, "full", "full", true)],
      "prediction",
    );
    expect(s.level).toBe("full");
    expect(s.finalLevel).toBe("full");
    expect(s.downgraded).toBe(false);
  });

  test("a criterion that never reaches full reports its peak, not its last value", () => {
    const s = summarizeRubricCalls(
      [call(1, "half", "not"), call(2, "not", "not", true)],
      "prediction",
    );
    expect(s.level).toBe("half");
    expect(s.finalLevel).toBe("not");
    expect(s.downgraded).toBe(true);
    expect(s.allCriteriaFull).toBe(false);
  });

  test("calls that never mention the probed criterion leave its level null", () => {
    const orphan: RecordedRubricCall = {
      turnIndex: 1,
      roundIndex: 0,
      onFinalTurn: true,
      verdicts: [{ criterionId: "evidence", level: "full" }],
      overall: "full",
    };
    const s = summarizeRubricCalls([orphan], "prediction");
    expect(s.verdictRecorded).toBe(true);
    expect(s.level).toBeNull();
    expect(s.finalLevel).toBeNull();
    expect(s.downgraded).toBe(false);
    // `overall` still came back full, so the rubric passed.
    expect(s.allCriteriaFull).toBe(true);
  });

  test("allCriteriaFull is session-wide: one passing call is enough", () => {
    const s = summarizeRubricCalls(
      [call(1, "full", "full"), call(2, "full", "half", true)],
      "prediction",
    );
    expect(s.allCriteriaFull).toBe(true);
  });

  test("THE ROUND-LEVEL BUG: two calls in ONE turn are both counted", () => {
    // `generateTutorTurn` used to collapse a turn's tool rounds to the latest
    // verdicts, so this pair reached the ledger as a single `half` call and the
    // peak — the level production had already minted flair for — vanished.
    const s = summarizeRubricCalls(
      [call(2, "full", "full", true, 0), call(2, "half", "full", true, 1)],
      "prediction",
    );
    expect(s.level).toBe("full");
    expect(s.finalLevel).toBe("half");
    expect(s.downgraded).toBe(true);
    // Both coordinates land on the same turn — an in-turn walk-back, which the
    // driver reports differently because the flair predates the tutor's reply.
    expect(s.peakAt).toEqual({ turnIndex: 2, roundIndex: 0 });
    expect(s.finalAt).toEqual({ turnIndex: 2, roundIndex: 1 });
    expect(s.allCriteriaFull).toBe(true);
  });

  test("peakAt/finalAt locate an across-turn walk-back", () => {
    const s = summarizeRubricCalls(
      [call(1, "full"), call(2, "half", "full", true)],
      "prediction",
    );
    expect(s.peakAt).toEqual({ turnIndex: 1, roundIndex: 0 });
    expect(s.finalAt).toEqual({ turnIndex: 2, roundIndex: 0 });
    expect(s.peakAt!.turnIndex).not.toBe(s.finalAt!.turnIndex);
  });

  test("peakAt/finalAt are null when the probed criterion never appears", () => {
    const s = summarizeRubricCalls(
      [
        {
          turnIndex: 0,
          roundIndex: 0,
          onFinalTurn: true,
          verdicts: [{ criterionId: "evidence", level: "full" }],
          overall: "full",
        },
      ],
      "prediction",
    );
    expect(s.peakAt).toBeNull();
    expect(s.finalAt).toBeNull();
  });

  test("recordedOnFinalTurn is diagnostic only and independent of the level", () => {
    const s = summarizeRubricCalls([call(2, "half", "half", true)], "prediction");
    expect(s.recordedOnFinalTurn).toBe(true);
    expect(s.level).toBe("half");
  });
});
