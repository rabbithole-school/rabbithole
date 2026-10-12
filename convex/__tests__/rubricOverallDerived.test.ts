import { describe, expect, test } from "vitest";
import { RUBRIC_TOOL } from "../deliverables";
import { scoreRubricVerdicts } from "../lib/deliverable";

// Production defect this pins: the grader model omitted `overall` on ~13% of
// borderline gradings — stop_reason "tool_use", every other field present, so
// not truncation. `checkRubric` passed the gap straight into applyCheckResult,
// whose validator requires a not/half/full literal, and that runMutation sits
// OUTSIDE the action's try/catch. The action threw, nothing was stored, and the
// scholar's "Check my work" simply failed. It clustered on `half` submissions —
// borderline work, which is what a struggling scholar produces.
//
// The fix is to stop asking: `overall` is a summary of data the model already
// returns, so it is derived with the same rule the tutor path uses.
const CRITERIA = [
  { id: "obs", label: "Careful observation", description: "Names what is seen" },
  { id: "pred", label: "A reasoned prediction", description: "Predicts with a reason" },
];

describe("rubric overall is derived, not requested", () => {
  test("the model is not required to return `overall`", () => {
    expect(RUBRIC_TOOL.input_schema.required).not.toContain("overall");
    // Still required — these are judgment the model alone can supply.
    expect(RUBRIC_TOOL.input_schema.required).toContain("verdicts");
    expect(RUBRIC_TOOL.input_schema.required).toContain("feedback");
  });

  test("a tool call with `overall` omitted still yields a valid aggregate", () => {
    // The exact shape of the 15/112 failing calls.
    const raw = {
      verdicts: [
        { criterionId: "obs", level: "full" as const, note: "Three colors named." },
        { criterionId: "pred", level: "half" as const, note: "Stops short of the noun." },
      ],
      feedback: "Nearly there.",
    };
    const scored = scoreRubricVerdicts(CRITERIA, raw.verdicts);
    expect(scored.overall).toBe("half");
    expect(["not", "half", "full"]).toContain(scored.overall);
    expect(scored.passed).toBe(false);
  });

  test("derivation disagrees with the old model-authored definition, on purpose", () => {
    // checkRubric's prompt called this "half" ("at least one criterion is half
    // OR not"); the tutor path calls it "not". One column, two meanings. The
    // derived rule is the tutor path's, so the two graders now agree.
    const scored = scoreRubricVerdicts(CRITERIA, [
      { criterionId: "obs", level: "full" },
      { criterionId: "pred", level: "not" },
    ]);
    expect(scored.overall).toBe("not");
  });

  test("every criterion full is a pass", () => {
    const scored = scoreRubricVerdicts(CRITERIA, [
      { criterionId: "obs", level: "full" },
      { criterionId: "pred", level: "full" },
    ]);
    expect(scored.overall).toBe("full");
    expect(scored.passed).toBe(true);
  });

  test("a criterion the model skipped is filled, not dropped", () => {
    const scored = scoreRubricVerdicts(CRITERIA, [
      { criterionId: "obs", level: "full", note: "Good." },
    ]);
    expect(scored.verdicts).toHaveLength(2);
    expect(scored.verdicts.find((v) => v.criterionId === "pred")?.level).toBe("not");
  });
});
