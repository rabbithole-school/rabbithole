// @vitest-environment jsdom

/**
 * The app-kit expression-editor widget must render and behave as a faithful
 * THIRD renderer of the shared `expressionTemplateInput` state machine. These
 * tests mount the real widget into a jsdom document, drive it with the same
 * keys/glyphs a scholar would press, and assert that `getValue()` equals
 * exactly what the shared model produces for the same key sequence — plus that
 * `onChange` and the `window.rabbithole.setState` tutor bridge both fire.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createExpressionTemplateState,
  expressionTemplateApplyKey,
  expressionTemplateInsertEmptyFraction,
  expressionTemplateInsertExponent,
  expressionTemplateInsertRoot,
  expressionTemplateInsertSquareRoot,
  expressionTemplateToSubmission,
  type ExpressionTemplateState,
} from "../../expressionTemplateInput";
import { mount } from "./index";

type Action = { key: string } | { glyph: "frac" | "power" | "sqrt" | "root" };

const GLYPH_LABEL: Record<string, string> = {
  frac: "Insert a fraction",
  power: "Insert an exponent",
  sqrt: "Insert a square root",
  root: "Insert a root with an index",
};

function dispatchKey(container: HTMLElement, key: string): void {
  container.dispatchEvent(
    new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }),
  );
}

function clickGlyph(container: HTMLElement, glyph: string): void {
  const btn = container.querySelector<HTMLElement>(
    `[aria-label="${GLYPH_LABEL[glyph]}"]`,
  );
  if (!btn) throw new Error(`keypad glyph not found: ${glyph}`);
  btn.click();
}

/** Apply the same action to the REFERENCE state machine the widget wraps. */
function applyToReference(state: ExpressionTemplateState, action: Action): ExpressionTemplateState {
  if ("key" in action) return expressionTemplateApplyKey(state, action.key);
  switch (action.glyph) {
    case "frac":
      return expressionTemplateInsertEmptyFraction(state);
    case "power":
      return expressionTemplateInsertExponent(state);
    case "sqrt":
      return expressionTemplateInsertSquareRoot(state);
    case "root":
      return expressionTemplateInsertRoot(state);
  }
}

function driveWidget(container: HTMLElement, action: Action): void {
  if ("key" in action) dispatchKey(container, action.key);
  else clickGlyph(container, action.glyph);
}

let host: HTMLElement;
let setState: ReturnType<typeof vi.fn>;

beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
  setState = vi.fn();
  (globalThis as { rabbithole?: unknown }).rabbithole = { setState };
});

afterEach(() => {
  host.remove();
  delete (globalThis as { rabbithole?: unknown }).rabbithole;
});

/** Drive both the widget and a fresh reference model, return the reference. */
function run(
  actions: Action[],
  onChange?: (value: string) => void,
  id = "test",
): { handle: ReturnType<typeof mount>; container: HTMLElement; reference: ExpressionTemplateState } {
  const handle = mount(host, { id, ...(onChange ? { onChange } : {}) });
  const container = host.querySelector<HTMLElement>(".rh-expr")!;
  let reference = createExpressionTemplateState("");
  for (const action of actions) {
    driveWidget(container, action);
    reference = applyToReference(reference, action);
  }
  return { handle, container, reference };
}

describe("app-kit expression editor widget", () => {
  it("builds a fraction from digits + the / key, matching the shared model", () => {
    const { handle, container, reference } = run([
      { key: "1" },
      { key: "/" },
      { key: "2" },
    ]);
    expect(handle.getValue()).toBe(expressionTemplateToSubmission(reference));
    expect(handle.getValue()).toBe("1/2");
    // The 2-D structure is real DOM: a stacked fraction with a bar and boxes.
    expect(container.querySelector(".rh-expr-fraction")).not.toBeNull();
    expect(container.querySelectorAll(".rh-expr-box").length).toBeGreaterThan(0);
  });

  it("builds an exponent via the ^ key, matching the shared model", () => {
    const { handle, container, reference } = run([
      { key: "x" },
      { key: "^" },
      { key: "2" },
    ]);
    expect(handle.getValue()).toBe(expressionTemplateToSubmission(reference));
    expect(handle.getValue()).toBe("x^2");
    expect(container.querySelector(".rh-expr-power")).not.toBeNull();
  });

  it("inserts a square root via the keypad glyph, matching the shared model", () => {
    const { handle, container, reference } = run([{ glyph: "sqrt" }, { key: "9" }]);
    expect(handle.getValue()).toBe(expressionTemplateToSubmission(reference));
    expect(handle.getValue()).toBe("√9");
    expect(container.querySelector(".rh-expr-root")).not.toBeNull();
  });

  it("builds a mixed number via the fraction glyph (no grab), matching the model", () => {
    const { handle, reference } = run([
      { key: "2" },
      { glyph: "frac" }, // empty ▢/▢ after the 2, caret in the numerator
      { key: "1" },
      { key: "ArrowDown" }, // numerator → denominator
      { key: "2" },
    ]);
    expect(handle.getValue()).toBe(expressionTemplateToSubmission(reference));
    expect(handle.getValue()).toBe("2 1/2");
  });

  it("backspace and arrow keys walk/edit the model identically", () => {
    // 3/4, arrow-left into the numerator gap, backspace the 3, retype 5 → 5/4.
    const actions: Action[] = [
      { key: "3" },
      { key: "/" },
      { key: "4" },
      { key: "ArrowUp" }, // denominator → numerator
      { key: "Backspace" }, // delete the 3
      { key: "5" },
    ];
    const { handle, reference } = run(actions);
    expect(handle.getValue()).toBe(expressionTemplateToSubmission(reference));
    expect(handle.getValue()).toBe("5/4");
  });

  it("fires onChange with the graded value on every change", () => {
    const onChange = vi.fn();
    const { handle } = run([{ key: "1" }, { key: "/" }, { key: "2" }], onChange);
    expect(onChange).toHaveBeenCalled();
    expect(onChange).toHaveBeenLastCalledWith("1/2");
    expect(handle.getValue()).toBe("1/2");
  });

  it("publishes to the window.rabbithole.setState tutor bridge on change", () => {
    run([{ key: "1" }, { key: "/" }, { key: "2" }], undefined, "answer-a");
    expect(setState).toHaveBeenCalled();
    expect(setState).toHaveBeenLastCalledWith({
      expressionEditor: { "answer-a": "1/2" },
    });
  });

  it("getValue / setValue / focus / destroy round-trip", () => {
    const handle = mount(host, { id: "rt", initialValue: "12" });
    expect(handle.getValue()).toBe("12");
    handle.setValue("7");
    expect(handle.getValue()).toBe("7");
    handle.focus();
    expect(host.querySelector(".rh-expr")).not.toBeNull();
    handle.destroy();
    expect(host.querySelector(".rh-expr")).toBeNull();
  });
});
