/**
 * React state for the algebra answer document (`shared/algebraAnswerInput.ts`),
 * with the same ref discipline as `useExpressionTemplateController`: the ref is
 * the latest document, updated synchronously, so a burst of keystrokes composes
 * exactly like a slow sequence. `useState` only drives rendering. Every edit
 * publishes the submission string to the host.
 *
 * The host's callbacks are read through refs, so every function this returns is
 * STABLE for the life of the component. That matters: the document is rebuilt
 * when `resetKey` changes, and an earlier version re-ran that rebuild whenever
 * the host passed a new `onSubmissionChange` — which an inline arrow does on
 * every render. The first keystroke published a submission, the host
 * re-rendered, and the rebuild wiped the answer (device review: `(` then `x`
 * left an empty box).
 */

import { useCallback, useEffect, useRef, useState } from "react";

import {
  algebraAnswerAddMember,
  algebraAnswerApplyKey,
  algebraAnswerEditActive,
  algebraAnswerRemoveMember,
  algebraAnswerSetActive,
  algebraAnswerSetCaret,
  algebraAnswerToSubmission,
  algebraAnswerToggleNoSolution,
  type AlgebraAnswerState,
} from "./algebraAnswerInput";
import {
  expressionTemplateSetCaret,
  type ExpressionTemplateState,
  type SlotId,
} from "./expressionTemplateInput";

export type AlgebraAnswerController = {
  state: AlgebraAnswerState;
  reset: (next: AlgebraAnswerState) => void;
  /** A keystroke, on-screen or hardware, through the shared key map. */
  applyKey: (key: string) => void;
  /** A structural key (fraction, power, x², roots, log, ln, |…|). */
  edit: (op: (member: ExpressionTemplateState) => ExpressionTemplateState) => void;
  setCaret: (memberIndex: number, slotId: SlotId, index: number) => void;
  setActive: (memberIndex: number) => void;
  addMember: () => void;
  removeMember: (memberIndex: number) => void;
  toggleNoSolution: () => void;
};

export function useAlgebraAnswerController({
  onSubmissionChange,
  initialize,
  resetKey = null,
}: {
  onSubmissionChange: (submission: string) => void;
  initialize: () => AlgebraAnswerState;
  /**
   * Rebuild the document from `initialize()` whenever this changes to a new
   * non-null value (a new item, or answering again after feedback). `null`
   * means "keep what is there" (e.g. while a verdict shows the answer).
   */
  resetKey?: string | null;
}): AlgebraAnswerController {
  const [state, setState] = useState<AlgebraAnswerState>(initialize);
  const latest = useRef<AlgebraAnswerState>(state);
  const publish = useRef(onSubmissionChange);
  const init = useRef(initialize);
  useEffect(() => {
    publish.current = onSubmissionChange;
    init.current = initialize;
  });

  const reset = useCallback((next: AlgebraAnswerState) => {
    latest.current = next;
    setState(next);
    publish.current(algebraAnswerToSubmission(next));
  }, []);

  // The key the current document was built for. Seeded with the mount-time key
  // so mounting does not rebuild what `useState` just built.
  const builtFor = useRef<string | null>(resetKey);
  useEffect(() => {
    if (resetKey === builtFor.current) return;
    builtFor.current = resetKey;
    if (resetKey !== null) reset(init.current());
  }, [resetKey, reset]);

  const commit = useCallback((op: (prev: AlgebraAnswerState) => AlgebraAnswerState) => {
    const prev = latest.current;
    const next = op(prev);
    if (next === prev) return;
    latest.current = next;
    setState(next);
    publish.current(algebraAnswerToSubmission(next));
  }, []);

  const applyKey = useCallback((key: string) => commit((prev) => algebraAnswerApplyKey(prev, key)), [commit]);
  const edit = useCallback(
    (op: (member: ExpressionTemplateState) => ExpressionTemplateState) =>
      commit((prev) => algebraAnswerEditActive(prev, op)),
    [commit],
  );
  const setCaret = useCallback(
    (memberIndex: number, slotId: SlotId, index: number) =>
      commit((prev) =>
        algebraAnswerSetCaret(prev, memberIndex, (member) => expressionTemplateSetCaret(member, slotId, index)),
      ),
    [commit],
  );
  const setActive = useCallback((i: number) => commit((prev) => algebraAnswerSetActive(prev, i)), [commit]);
  const addMember = useCallback(() => commit(algebraAnswerAddMember), [commit]);
  const removeMember = useCallback((i: number) => commit((prev) => algebraAnswerRemoveMember(prev, i)), [commit]);
  const toggleNoSolution = useCallback(() => commit(algebraAnswerToggleNoSolution), [commit]);

  return { state, reset, applyKey, edit, setCaret, setActive, addMember, removeMember, toggleNoSolution };
}
