/**
 * The ALGEBRA answer document: one or more algebra-mode expression boxes (see
 * `shared/expressionTemplateInput.ts`) plus the solution-set choices around
 * them. A plain algebra item has exactly one box. A `solutionSet` item lets the
 * scholar add a box per answer ("+ another answer") or say "No solution".
 *
 * Why separate boxes rather than a comma key: a comma inside one expression is
 * punctuation a young scholar has to know the meaning of, and it reads like a
 * thousands separator (`3,2`). A row of answer chips shows "two answers" as
 * two things, keeps each answer's caret and backspace local to it, and needs no
 * new symbol. The wire form is still the contract's comma-joined list.
 *
 * Pure TS, framework-free: vendored into the native app beside its siblings.
 */

import {
  createAlgebraTemplateState,
  expressionTemplateApplyKey,
  expressionTemplateIsComplete,
  expressionTemplateToSubmission,
  type ExpressionTemplateState,
} from "./expressionTemplateInput";

export type AlgebraAnswerState = {
  /** The answer boxes, in the order the scholar added them. Never empty. */
  members: ExpressionTemplateState[];
  /** Which box receives keystrokes. */
  active: number;
  /** A solution set: more boxes may be added, and "No solution" is offered. */
  multi: boolean;
  /** The scholar chose "No solution" (solution sets only). */
  noSolution: boolean;
};

const NAV_KEYS = new Set(["Tab", "ShiftTab", "ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"]);

/** Tap-to-place inside one answer box (which also makes it the active box). */
export function algebraAnswerSetCaret(
  prev: AlgebraAnswerState,
  memberIndex: number,
  op: (member: ExpressionTemplateState) => ExpressionTemplateState,
): AlgebraAnswerState {
  const member = prev.members[memberIndex];
  if (!member) return prev;
  const members = prev.members.slice();
  members[memberIndex] = op(member);
  return { ...prev, members, active: memberIndex };
}

/** The literal a "No solution" answer submits (contract §2). */
export const NO_SOLUTION_SUBMISSION = "none";

export function createAlgebraAnswerState(multi: boolean): AlgebraAnswerState {
  return { members: [createAlgebraTemplateState()], active: 0, multi, noSolution: false };
}

function isEmptyMember(member: ExpressionTemplateState): boolean {
  return member.root.items.length === 0;
}

/** Apply an edit to the active box. Any edit clears a "No solution" choice. */
export function algebraAnswerEditActive(
  prev: AlgebraAnswerState,
  op: (member: ExpressionTemplateState) => ExpressionTemplateState,
): AlgebraAnswerState {
  const member = prev.members[prev.active];
  if (!member) return prev;
  const next = op(member);
  if (next === member && !prev.noSolution) return prev;
  const members = prev.members.slice();
  members[prev.active] = next;
  return { ...prev, members, noSolution: false };
}

/** "+ another answer": open a new empty box after the others and focus it.
 *  Refused while the focused box is still empty, so blanks can't pile up. */
export function algebraAnswerAddMember(prev: AlgebraAnswerState): AlgebraAnswerState {
  if (!prev.multi) return prev;
  if (prev.noSolution) {
    return { ...prev, noSolution: false };
  }
  if (isEmptyMember(prev.members[prev.active])) return prev;
  const empty = prev.members.findIndex(isEmptyMember);
  if (empty !== -1) return { ...prev, active: empty };
  return { ...prev, members: [...prev.members, createAlgebraTemplateState()], active: prev.members.length };
}

export function algebraAnswerSetActive(prev: AlgebraAnswerState, index: number): AlgebraAnswerState {
  if (index < 0 || index >= prev.members.length || index === prev.active) return prev;
  return { ...prev, active: index };
}

/** Remove one answer box (its chip's remove button); at least one box stays. */
export function algebraAnswerRemoveMember(prev: AlgebraAnswerState, index: number): AlgebraAnswerState {
  if (index < 0 || index >= prev.members.length) return prev;
  if (prev.members.length === 1) {
    return { ...prev, members: [createAlgebraTemplateState()], active: 0 };
  }
  const members = prev.members.filter((_, i) => i !== index);
  const active = Math.min(index <= prev.active ? Math.max(0, prev.active - 1) : prev.active, members.length - 1);
  return { ...prev, members, active };
}

export function algebraAnswerToggleNoSolution(prev: AlgebraAnswerState): AlgebraAnswerState {
  if (!prev.multi) return prev;
  return { ...prev, noSolution: !prev.noSolution };
}

/**
 * One keystroke (on-screen key or hardware key) through the shared key map. In
 * a solution set, `,` / `;` mean "another answer", and backspace in an empty
 * extra box removes that box and returns to the end of the previous one.
 */
export function algebraAnswerApplyKey(prev: AlgebraAnswerState, key: string): AlgebraAnswerState {
  if (prev.multi && (key === "," || key === ";")) return algebraAnswerAddMember(prev);
  if (prev.noSolution && NAV_KEYS.has(key)) return prev;
  const isBackspace = key === "⌫" || key === "Backspace";
  if (isBackspace && prev.noSolution) return { ...prev, noSolution: false };
  if (
    isBackspace &&
    prev.multi &&
    prev.members.length > 1 &&
    isEmptyMember(prev.members[prev.active])
  ) {
    const members = prev.members.filter((_, i) => i !== prev.active);
    return { ...prev, members, active: Math.max(0, prev.active - 1) };
  }
  return algebraAnswerEditActive(prev, (member) => expressionTemplateApplyKey(member, key));
}

/**
 * The submission string: `none` for "No solution"; otherwise the filled boxes'
 * answers joined with `,` (empty boxes are ignored). Empty — so Check stays off
 * — while any non-empty box is unfinished or nothing has been entered.
 */
export function algebraAnswerToSubmission(state: AlgebraAnswerState): string {
  if (state.noSolution) return NO_SOLUTION_SUBMISSION;
  const parts: string[] = [];
  for (const member of state.members) {
    if (isEmptyMember(member)) continue;
    if (!expressionTemplateIsComplete(member)) return "";
    parts.push(expressionTemplateToSubmission(member));
  }
  return parts.join(",");
}
