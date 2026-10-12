/**
 * RabbitholeKit.expressionEditor — the app-kit widget wrapper around our SHARED
 * 2-D math input state machine (shared/expressionTemplateInput.ts), for
 * sandboxed vibecode / custom apps.
 *
 * Andy's 2026-09-15 ruling: sandboxed apps that need math entry get OUR keypad
 * (fraction / exponent / root boxes, the value the practice engine grades), not
 * MathLive. This is the THIRD renderer of that one state machine — vanilla DOM,
 * no React, no Chakra — so a scholar builds `1/2`, `x^2`, `√16` inside an app
 * exactly as they do in practice, and the tutor sees what they typed.
 *
 * The bundled artifact (public/app-kit/v2/rh-expression-editor.js, built by
 * scripts/vendor-app-kit.mjs) is an IIFE that publishes
 * `window.RabbitholeKit.expressionEditor`. The companion
 * rh-expression-editor.css carries the brand skin. Both inline under the strict,
 * network-less custom-app CSP through the same host path as the other v2 kit.
 *
 *   const editor = RabbitholeKit.expressionEditor.mount(el, {
 *     onChange(value) { ... }, // value is the graded submission string, e.g. "1/2"
 *   });
 *   editor.getValue(); editor.setValue("12"); editor.focus(); editor.destroy();
 */

import {
  createExpressionTemplateState,
  expressionTemplateApplyKey,
  expressionTemplateInsertEmptyFraction,
  expressionTemplateInsertExponent,
  expressionTemplateInsertRoot,
  expressionTemplateInsertSquareRoot,
  expressionTemplateSeedFromSkeleton,
  expressionTemplateSetCaret,
  expressionTemplateToSubmission,
  type ExpressionTemplateState,
  type SlotId,
} from "../../expressionTemplateInput";
import { buildKeypad } from "./keypad";
import { renderExpression } from "./render";

export type ExpressionEditorMountOptions = {
  /** A locked L1 skeleton (e.g. `F(_/_)`) to seed a fixed-structure editor. */
  template?: string | null;
  /** Raw seed characters (digits / `x`) for an empty, unlocked editor. */
  initialValue?: string;
  /** Called with the graded submission string whenever it changes. `""` until
   *  the structure is fully filled. */
  onChange?: (value: string) => void;
  /** Bridge key under `expressionEditor` in app state; defaults to the host
   *  element's id, else an auto id. */
  id?: string;
  /** Base font size of the answer field (px). Defaults to 26. */
  fontSize?: number;
};

export type ExpressionEditorHandle = {
  getValue: () => string;
  setValue: (value: string) => void;
  focus: () => void;
  destroy: () => void;
};

let autoId = 0;

function seedState(options: ExpressionEditorMountOptions): ExpressionTemplateState {
  if (options.template) {
    const seeded = expressionTemplateSeedFromSkeleton(options.template);
    if (seeded) return seeded;
  }
  return createExpressionTemplateState(options.initialValue ?? "");
}

function publishToBridge(id: string, value: string): void {
  const bridge = (globalThis as { rabbithole?: { setState?: (patch: unknown) => void } })
    .rabbithole;
  if (bridge && typeof bridge.setState === "function") {
    try {
      bridge.setState({ expressionEditor: { [id]: value } });
    } catch (error) {
      console.error("expressionEditor: setState bridge failed", error);
    }
  }
}

export function mount(
  element: HTMLElement,
  options: ExpressionEditorMountOptions = {},
): ExpressionEditorHandle {
  const id = options.id || element.id || `expr-${(autoId += 1)}`;
  const fontSize = options.fontSize ?? 26;
  let state = seedState(options);
  let lastEmitted: string | null = null;
  let destroyed = false;

  const container = document.createElement("div");
  container.className = "rh-expr";
  container.tabIndex = 0;
  const editorHost = document.createElement("div");
  container.appendChild(editorHost);

  const currentValue = (): string => expressionTemplateToSubmission(state);

  const publish = (): void => {
    const value = currentValue();
    if (value === lastEmitted) return;
    lastEmitted = value;
    if (options.onChange) {
      try {
        options.onChange(value);
      } catch (error) {
        console.error("expressionEditor: onChange handler threw", error);
      }
    }
    publishToBridge(id, value);
  };

  const setCaret = (slotId: SlotId, index: number): void =>
    apply((prev) => expressionTemplateSetCaret(prev, slotId, index));

  const rerender = (): void => {
    const { node, fixups } = renderExpression(state, setCaret, { fontSize });
    editorHost.replaceChildren(node);
    for (const fix of fixups) fix();
  };

  function apply(op: (prev: ExpressionTemplateState) => ExpressionTemplateState): void {
    if (destroyed) return;
    state = op(state);
    rerender();
    publish();
  }

  const keypad = buildKeypad(
    {
      onDigit: (digit) => apply((prev) => expressionTemplateApplyKey(prev, digit)),
      onInsertFraction: () => apply(expressionTemplateInsertEmptyFraction),
      onInsertPower: () => apply(expressionTemplateInsertExponent),
      onInsertSquareRoot: () => apply(expressionTemplateInsertSquareRoot),
      onInsertRoot: () => apply(expressionTemplateInsertRoot),
      onDelete: () => apply((prev) => expressionTemplateApplyKey(prev, "\u232B")),
    },
    { locked: !!state.structureLocked },
  );
  container.appendChild(keypad);

  // Hardware keyboard → the same shared key map the on-screen keys use. Scoped
  // to the widget (not window) so multiple editors and the host coexist.
  const onKeydown = (event: KeyboardEvent): void => {
    if (destroyed) return;
    const { key } = event;
    if (/^[0-9]$/.test(key)) apply((prev) => expressionTemplateApplyKey(prev, key));
    else if (key === "x" || key === "X") apply((prev) => expressionTemplateApplyKey(prev, "x"));
    else if (key === "/") {
      event.preventDefault();
      apply((prev) => expressionTemplateApplyKey(prev, "/"));
    } else if (key === "^") {
      event.preventDefault();
      apply((prev) => expressionTemplateApplyKey(prev, "^"));
    } else if (key === "Tab") {
      event.preventDefault();
      apply((prev) => expressionTemplateApplyKey(prev, event.shiftKey ? "ShiftTab" : "Tab"));
    } else if (key === "ArrowRight" || key === "ArrowLeft" || key === "ArrowUp" || key === "ArrowDown") {
      event.preventDefault();
      apply((prev) => expressionTemplateApplyKey(prev, key));
    } else if (key === "Backspace") {
      event.preventDefault();
      apply((prev) => expressionTemplateApplyKey(prev, "\u232B"));
    }
  };
  container.addEventListener("keydown", onKeydown);
  // Any interaction keeps the hardware keyboard routed into this widget.
  const onPointerDown = (): void => {
    if (!destroyed) container.focus({ preventScroll: true });
  };
  container.addEventListener("mousedown", onPointerDown);

  element.appendChild(container);
  rerender();
  publish(); // seed the initial value into the tutor bridge + onChange

  return {
    getValue: currentValue,
    setValue: (value: string) => {
      state = createExpressionTemplateState(value == null ? "" : String(value));
      rerender();
      publish();
    },
    focus: () => container.focus(),
    destroy: () => {
      destroyed = true;
      container.removeEventListener("keydown", onKeydown);
      container.removeEventListener("mousedown", onPointerDown);
      container.remove();
    },
  };
}

export const expressionEditor = { mount };

// Publish the global when loaded as the bundled IIFE inside an app.
const globalScope = globalThis as unknown as {
  RabbitholeKit?: Record<string, unknown>;
};
if (typeof globalScope === "object") {
  globalScope.RabbitholeKit = globalScope.RabbitholeKit ?? {};
  globalScope.RabbitholeKit.expressionEditor = expressionEditor;
}
