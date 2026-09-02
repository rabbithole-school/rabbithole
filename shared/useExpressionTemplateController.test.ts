/**
 * Regression guard for the expression editor's ONE piece of React state
 * discipline: a keystroke must apply to the LATEST document, even when several
 * keys land before React re-renders.
 *
 * There is no React renderer in this workspace (vitest runs on `edge-runtime`),
 * so instead of pulling one in we mock `react` itself with a ~30-line hook
 * runtime that models the exact contract the bug lived in:
 *
 *   • hook state persists across "renders" (a slot list, like React's fiber),
 *   • `render()` produces handlers whose CLOSURES capture that render's values,
 *   • calling a handler does NOT re-render.
 *
 * "A burst" = calling handlers from a single render, which is what a fast
 * typist, a held key-repeat, or an automated driver actually produce. Under the
 * old closure-capture implementation the burst tests below fail (the first key
 * is lost); with the ref mirror they compose exactly like slow typing.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Minimal hook runtime (see the header). Only the three hooks this module uses.
// ---------------------------------------------------------------------------
let slots: unknown[] = [];
let cursor = 0;

function useState<T>(initial: T | (() => T)): [T, (next: T) => void] {
  const i = cursor++;
  if (slots.length <= i) {
    slots[i] = typeof initial === "function" ? (initial as () => T)() : initial;
  }
  const set = (next: T) => {
    slots[i] = next;
  };
  return [slots[i] as T, set];
}

function useRef<T>(initial: T): { current: T } {
  const i = cursor++;
  if (slots.length <= i) slots[i] = { current: initial };
  return slots[i] as { current: T };
}

// Deliberately NOT memoizing: a fresh closure every render is the worst case,
// and memoization would only hide staleness, never create it.
function useCallback<T>(fn: T): T {
  cursor++;
  return fn;
}

vi.mock("react", () => ({ useState, useRef, useCallback }));

const { useExpressionTemplateController } = await import("./useExpressionTemplateController");
const { createExpressionTemplateState } = await import("./expressionTemplateInput");

/** Re-run the hook from the top, as React would on a state change. Named
 *  `useRender` only to satisfy the rules-of-hooks lint — the fake runtime above
 *  is what actually gives it hook semantics. */
function render(onSubmissionChange: (s: string) => void) {
  cursor = 0;
  // eslint-disable-next-line react-hooks/rules-of-hooks -- the fake runtime above provides hook semantics
  return useExpressionTemplateController({
    onSubmissionChange,
    initialize: () => createExpressionTemplateState(""),
  });
}

describe("useExpressionTemplateController", () => {
  let submissions: string[];
  const publish = (s: string) => submissions.push(s);

  beforeEach(() => {
    slots = [];
    cursor = 0;
    submissions = [];
  });

  it("composes a BURST of keys from one render (the fast-typist bug)", () => {
    const c = render(publish);
    // All three from the SAME render — no re-render in between.
    c.applyKey("1");
    c.applyKey("/");
    c.applyKey("6");
    expect(render(publish).state && submissions.at(-1)).toBe("1/6");
  });

  it("gives the same result whether keys arrive fast or slow", () => {
    render(publish).applyKey("1");
    render(publish).applyKey("/");
    render(publish).applyKey("6");
    const slow = submissions.at(-1);

    slots = [];
    cursor = 0;
    submissions = [];
    const c = render(publish);
    c.applyKey("1");
    c.applyKey("/");
    c.applyKey("6");
    expect(submissions.at(-1)).toBe(slow);
  });

  it("keeps a burst of digits in order", () => {
    const c = render(publish);
    "1234".split("").forEach((k) => c.applyKey(k));
    expect(submissions.at(-1)).toBe("1234");
  });

  it("composes a glyph-button insert inside a burst (mixed number)", () => {
    const c = render(publish);
    c.applyKey("2");
    c.insertFraction();
    c.applyKey("1");
    c.applyKey("Tab");
    c.applyKey("2");
    expect(submissions.at(-1)).toBe("2 1/2");
  });

  it("composes an exponent insert inside a burst", () => {
    const c = render(publish);
    c.applyKey("1");
    c.applyKey("3");
    c.insertPower();
    c.applyKey("2");
    expect(submissions.at(-1)).toBe("13^2");
  });

  it("applies backspace in a burst against the latest document", () => {
    const c = render(publish);
    c.applyKey("1");
    c.applyKey("6");
    c.applyKey("⌫");
    expect(submissions.at(-1)).toBe("1");
  });

  it("reset installs a fresh document and publishes its submission", () => {
    const c = render(publish);
    c.applyKey("7");
    expect(submissions.at(-1)).toBe("7");
    c.reset(createExpressionTemplateState(""));
    expect(submissions.at(-1)).toBe("");
    // …and the next keystroke applies to the RESET document, not the old one.
    c.applyKey("4");
    expect(submissions.at(-1)).toBe("4");
  });

  it("routes caret moves through the same latest-document path", () => {
    const c = render(publish);
    c.applyKey("1");
    c.applyKey("2");
    const boxId = render(publish).state.root.id;
    c.setCaret(boxId, 0);
    c.applyKey("9"); // lands at the caret we just set, i.e. in front
    expect(submissions.at(-1)).toBe("912");
  });

  it("reports nav keys separately from edits", () => {
    const nav: boolean[] = [];
    cursor = 0;
    const c = useExpressionTemplateController({
      onSubmissionChange: publish,
      onKeyDispatched: (isNav) => nav.push(isNav),
      initialize: () => createExpressionTemplateState(""),
    });
    c.applyKey("1");
    c.applyKey("Tab");
    c.insertFraction();
    expect(nav).toEqual([false, true, false]);
  });
});
