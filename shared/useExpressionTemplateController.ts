/**
 * The ONE piece of React state discipline the 2-D expression editor needs, shared
 * by the web hook (`hooks/useExpressionTemplate.ts`) and the native controls
 * (`native/src/components/practice/NativePracticeControls.tsx`).
 *
 * WHY this exists — a keystroke must always apply to the LATEST document.
 * Both surfaces used to hold the editor document in `useState` and apply each
 * keystroke against the value captured in the handler's closure:
 *
 *     const onKey = useCallback((k) => commit(applyKey(templateState, k)),
 *                               [templateState, ...]);
 *
 * That is correct only if React re-renders (and hands the handler a fresh
 * closure) between every two keystrokes. It doesn't have to: two key events
 * delivered before the next commit — a fast typist, held key-repeat, or an
 * automated driver — both read the SAME stale document, so the first keystroke
 * is silently lost. Reproduced on the iPad simulator: typing "1", "/", "6" in a
 * burst produced a fraction whose numerator was `6` and whose denominator was
 * empty (the "1" and the caret move into the denominator were both dropped);
 * the same three keys typed a second apart produced the correct 1/6.
 *
 * The fix is a ref mirror: the ref is the source of truth for "the document as
 * of the last committed keystroke" and is updated SYNCHRONOUSLY, so a burst of
 * keys composes exactly like a slow sequence. `useState` remains, purely to
 * drive rendering.
 *
 * A functional `setState(prev => …)` would fix the staleness too, but the
 * updater must stay pure — and every edit here has to also publish the derived
 * submission string to the host (`onSubmissionChange`). The ref keeps that
 * side effect where it belongs, in the event handler.
 *
 * This module is the only React in `shared/` (the rest is framework-free so it
 * can be vendored into React Native). React itself is common to both surfaces,
 * so it vendors cleanly — a DOM or Chakra import would not.
 */

import { useCallback, useRef, useState } from "react";

import {
  expressionTemplateApplyKey,
  expressionTemplateInsertEmptyFraction,
  expressionTemplateInsertExponent,
  expressionTemplateInsertRoot,
  expressionTemplateInsertSquareRoot,
  expressionTemplateSetCaret,
  expressionTemplateToSubmission,
  type ExpressionTemplateState,
  type SlotId,
} from "./expressionTemplateInput";

export type ExpressionTemplateController<
  S extends ExpressionTemplateState | null = ExpressionTemplateState | null,
> = {
  /** The document to render. `null` before the first `reset` (web seeds lazily);
   *  statically non-null for a caller that passes `initialize`. */
  state: S;
  /** Install a freshly seeded document (new item / retry). Publishes its submission. */
  reset: (next: ExpressionTemplateState) => void;
  /** A keystroke — on-screen key or hardware keyboard — through the shared key map. */
  applyKey: (key: string) => void;
  /** Direct manipulation: put the caret in a specific box at a specific index. */
  setCaret: (id: SlotId, index: number) => void;
  insertFraction: () => void;
  insertPower: () => void;
  insertSquareRoot: () => void;
  insertRoot: () => void;
};

// A caller that seeds eagerly (`initialize`) can never observe a null document,
// so the overload hands it a non-nullable `state` instead of making every use
// site re-assert it.
export function useExpressionTemplateController(args: {
  onSubmissionChange: (submission: string) => void;
  onKeyDispatched?: (isNavKey: boolean) => void;
  initialize: () => ExpressionTemplateState;
}): ExpressionTemplateController<ExpressionTemplateState>;
export function useExpressionTemplateController(args: {
  onSubmissionChange: (submission: string) => void;
  onKeyDispatched?: (isNavKey: boolean) => void;
  initialize?: undefined;
}): ExpressionTemplateController<ExpressionTemplateState | null>;
export function useExpressionTemplateController({
  onSubmissionChange,
  onKeyDispatched,
  initialize,
}: {
  /** Publish the flat submission string after every edit. */
  onSubmissionChange: (submission: string) => void;
  /** Told whether the key that just landed was pure navigation (no edit). */
  onKeyDispatched?: (isNavKey: boolean) => void;
  /** Optional lazy seed, for a surface that wants a document on first render. */
  initialize?: () => ExpressionTemplateState;
}): ExpressionTemplateController {
  const [state, setState] = useState<ExpressionTemplateState | null>(
    () => initialize?.() ?? null,
  );
  // The authoritative "latest document" — see the module comment. Seeded from
  // the same lazy initializer so the very first keystroke can't read `null`.
  const latest = useRef<ExpressionTemplateState | null>(state);

  const reset = useCallback(
    (next: ExpressionTemplateState) => {
      latest.current = next;
      setState(next);
      onSubmissionChange(expressionTemplateToSubmission(next));
    },
    [onSubmissionChange],
  );

  /** Apply an edit to the LATEST document (never the render-closure's copy). */
  const commit = useCallback(
    (op: (prev: ExpressionTemplateState) => ExpressionTemplateState) => {
      const prev = latest.current;
      if (!prev) return;
      const next = op(prev);
      latest.current = next;
      setState(next);
      onSubmissionChange(expressionTemplateToSubmission(next));
    },
    [onSubmissionChange],
  );

  const applyKey = useCallback(
    (key: string) => {
      onKeyDispatched?.(isNavKey(key));
      commit((prev) => expressionTemplateApplyKey(prev, key));
    },
    [commit, onKeyDispatched],
  );

  const setCaret = useCallback(
    (id: SlotId, index: number) => commit((prev) => expressionTemplateSetCaret(prev, id, index)),
    [commit],
  );

  // The glyph buttons are real EDITS (they change the submission), so they fire
  // the non-nav key-dispatched hook exactly like a keystroke.
  const insertFraction = useCallback(() => {
    onKeyDispatched?.(false);
    commit(expressionTemplateInsertEmptyFraction);
  }, [commit, onKeyDispatched]);

  const insertPower = useCallback(() => {
    onKeyDispatched?.(false);
    commit(expressionTemplateInsertExponent);
  }, [commit, onKeyDispatched]);

  const insertRoot = useCallback(() => {
    onKeyDispatched?.(false);
    commit(expressionTemplateInsertRoot);
  }, [commit, onKeyDispatched]);

  const insertSquareRoot = useCallback(() => {
    onKeyDispatched?.(false);
    commit(expressionTemplateInsertSquareRoot);
  }, [commit, onKeyDispatched]);

  return {
    state,
    reset,
    applyKey,
    setCaret,
    insertFraction,
    insertPower,
    insertSquareRoot,
    insertRoot,
  };
}

/** Keys that only MOVE the caret — no edit, so no "first keystroke" instrument. */
const NAV_KEYS = new Set([
  "Tab",
  "ShiftTab",
  "ArrowLeft",
  "ArrowRight",
  "ArrowUp",
  "ArrowDown",
]);

export function isNavKey(key: string): boolean {
  return NAV_KEYS.has(key);
}
