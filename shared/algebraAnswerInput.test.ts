import { describe, expect, it } from "vitest";

import {
  algebraAnswerAddMember,
  algebraAnswerApplyKey,
  algebraAnswerEditActive,
  algebraAnswerRemoveMember,
  algebraAnswerSetActive,
  algebraAnswerToSubmission,
  algebraAnswerToggleNoSolution,
  createAlgebraAnswerState,
  type AlgebraAnswerState,
} from "./algebraAnswerInput";
import { expressionTemplateInsertSquareRoot } from "./expressionTemplateInput";

function type(state: AlgebraAnswerState, keys: string): AlgebraAnswerState {
  return [...keys].reduce(algebraAnswerApplyKey, state);
}

describe("algebra answer: a single expression", () => {
  it("submits the one box's answer", () => {
    expect(algebraAnswerToSubmission(type(createAlgebraAnswerState(false), "(x+3)(x-2)"))).toBe("(x+3)(x-2)");
  });

  it("never grows a second box or a No-solution choice", () => {
    const s = type(createAlgebraAnswerState(false), "3");
    expect(algebraAnswerAddMember(s)).toBe(s);
    expect(algebraAnswerToggleNoSolution(s)).toBe(s);
    // A comma is not an algebra character, so it is simply refused.
    expect(algebraAnswerApplyKey(s, ",")).toBe(s);
  });
});

describe("algebra answer: a solution set", () => {
  it("joins the answers with commas, in the order entered", () => {
    let s = type(createAlgebraAnswerState(true), "3");
    s = algebraAnswerAddMember(s);
    s = type(s, "-2");
    expect(s.members).toHaveLength(2);
    expect(algebraAnswerToSubmission(s)).toBe("3,-2");
  });

  it("a typed comma means another answer", () => {
    expect(algebraAnswerToSubmission(type(createAlgebraAnswerState(true), "3,-2,1/2"))).toBe("3,-2,1/2");
  });

  it("± stays inside one answer (the grader expands it)", () => {
    expect(algebraAnswerToSubmission(type(createAlgebraAnswerState(true), "2±3i"))).toBe("2±3i");
  });

  it("does not pile up empty boxes", () => {
    const s = createAlgebraAnswerState(true);
    expect(algebraAnswerAddMember(s)).toBe(s);
    const one = algebraAnswerAddMember(type(s, "1"));
    expect(algebraAnswerAddMember(one)).toBe(one);
  });

  it("returns to an existing empty box rather than adding another", () => {
    let s = type(createAlgebraAnswerState(true), "1,");
    s = algebraAnswerSetActive(s, 0);
    s = algebraAnswerAddMember(s);
    expect(s.members).toHaveLength(2);
    expect(s.active).toBe(1);
  });

  it("backspace in an empty extra box removes it and returns to the previous one", () => {
    let s = type(createAlgebraAnswerState(true), "4,");
    expect(s.members).toHaveLength(2);
    s = algebraAnswerApplyKey(s, "⌫");
    expect(s.members).toHaveLength(1);
    expect(s.active).toBe(0);
    s = algebraAnswerApplyKey(s, "⌫");
    expect(algebraAnswerToSubmission(s)).toBe("");
  });

  it("ignores empty boxes but blocks Check while any answer is unfinished", () => {
    let s = type(createAlgebraAnswerState(true), "3,");
    expect(algebraAnswerToSubmission(s)).toBe("3");
    s = type(s, "x+");
    expect(algebraAnswerToSubmission(s)).toBe("");
  });

  it("No solution submits `none`, and any edit takes it back", () => {
    let s = type(createAlgebraAnswerState(true), "5");
    s = algebraAnswerToggleNoSolution(s);
    expect(algebraAnswerToSubmission(s)).toBe("none");
    expect(algebraAnswerApplyKey(s, "ArrowLeft")).toBe(s);
    const typed = algebraAnswerApplyKey(s, "2");
    expect(typed.noSolution).toBe(false);
    expect(algebraAnswerToSubmission(typed)).toBe("52");
    const backed = algebraAnswerApplyKey(s, "⌫");
    expect(backed.noSolution).toBe(false);
    expect(algebraAnswerToSubmission(backed)).toBe("5");
  });

  it("structural keys edit the active box", () => {
    let s = createAlgebraAnswerState(true);
    s = algebraAnswerEditActive(s, expressionTemplateInsertSquareRoot);
    s = type(s, "7");
    expect(algebraAnswerToSubmission(s)).toBe("√7");
  });

  it("removing a chip keeps at least one box", () => {
    let s = type(createAlgebraAnswerState(true), "1,2");
    s = algebraAnswerRemoveMember(s, 0);
    expect(algebraAnswerToSubmission(s)).toBe("2");
    s = algebraAnswerRemoveMember(s, 0);
    expect(s.members).toHaveLength(1);
    expect(algebraAnswerToSubmission(s)).toBe("");
  });
});
