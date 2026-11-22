/**
 * Regression guard for the device-review bug: on the gallery's first pad,
 * tapping "(" then "x" left an EMPTY box. The pad component rebuilt the answer
 * in an effect that depended on the host's `onChange`; the gallery (like any
 * host passing an inline arrow) hands a new `onChange` every render, the first
 * keystroke published a submission, the host re-rendered, and the rebuild
 * wiped the document. The pure model tests could not see it.
 *
 * This drives what a tap actually runs — `algebraPadPress` on the real
 * `useAlgebraAnswerController` — under a small hook runtime that models React's
 * memoisation (useCallback deps), effects (deps compared after each render) and
 * a host that re-renders whenever the submission it holds changes, with a NEW
 * `onChange` closure every render.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

// ── Minimal React hook runtime ───────────────────────────────────────────────
let slots: unknown[] = [];
let cursor = 0;
let pendingEffects: Array<() => void> = [];
let dirty = false;

function depsEqual(a: unknown[] | undefined, b: unknown[] | undefined): boolean {
  return !!a && !!b && a.length === b.length && a.every((v, i) => Object.is(v, b[i]));
}
function useState<T>(initial: T | (() => T)): [T, (next: T) => void] {
  const i = cursor++;
  if (slots.length <= i) slots[i] = typeof initial === "function" ? (initial as () => T)() : initial;
  return [
    slots[i] as T,
    (next: T) => {
      if (!Object.is(slots[i], next)) dirty = true;
      slots[i] = next;
    },
  ];
}
function useRef<T>(initial: T): { current: T } {
  const i = cursor++;
  if (slots.length <= i) slots[i] = { current: initial };
  return slots[i] as { current: T };
}
function useCallback<T>(fn: T, deps: unknown[]): T {
  const i = cursor++;
  const prev = slots[i] as { fn: T; deps: unknown[] } | undefined;
  if (prev && depsEqual(prev.deps, deps)) return prev.fn;
  slots[i] = { fn, deps };
  return fn;
}
function useEffect(effect: () => void, deps?: unknown[]): void {
  const i = cursor++;
  const prev = slots[i] as { deps?: unknown[] } | undefined;
  if (prev && deps && depsEqual(prev.deps, deps)) return;
  slots[i] = { deps };
  pendingEffects.push(effect);
}
vi.mock("react", () => ({ useState, useRef, useCallback, useEffect }));

const { useAlgebraAnswerController } = await import("../../../vendor/shared/useAlgebraAnswerController");
const { createAlgebraAnswerState } = await import("../../../vendor/shared/algebraAnswerInput");
const { algebraPadPress, algebraPadResetKey, algebraPadRows, algebraHardwareKeys } = await import("../algebraPad");
type Key = ReturnType<typeof algebraPadRows>[number][number];

// ── A host like the gallery: holds the submission, inline onChange ──────────
function mountHost(solutionSet: boolean, focusKey = "item-1:answering") {
  slots = [];
  let hostSubmission = "";
  let key = focusKey;
  const renderOnce = () => {
    cursor = 0;
    pendingEffects = [];
    dirty = false;
    // eslint-disable-next-line react-hooks/rules-of-hooks -- the fake runtime above gives hook semantics
    const controller = useAlgebraAnswerController({
      // A NEW closure every render, as an inline arrow is.
      onSubmissionChange: (s: string) => {
        if (s !== hostSubmission) dirty = true;
        hostSubmission = s;
      },
      initialize: () => createAlgebraAnswerState(solutionSet),
      resetKey: algebraPadResetKey(key),
    });
    for (const effect of pendingEffects) effect();
    return controller;
  };
  // Render until the host settles, the way React keeps rendering after a state change.
  const settle = () => {
    let controller = renderOnce();
    for (let guard = 0; dirty && guard < 20; guard++) controller = renderOnce();
    return controller;
  };
  let controller = settle();
  const keys = [...algebraPadRows("logs", { solutionSet }).flat(), ...algebraHardwareKeys("logs", { solutionSet })];
  const find = (label: string): Key => {
    const k = keys.find((x) => x.kind !== "spacer" && (x.kind === "op" ? `{${x.op}}` === label : x.label === label));
    if (!k) throw new Error(`no key ${label}`);
    return k;
  };
  return {
    tap(...labels: string[]) {
      for (const label of labels) {
        algebraPadPress(controller, find(label));
        controller = settle();
      }
    },
    hardware(...chars: string[]) {
      for (const c of chars) {
        controller.applyKey(c);
        controller = settle();
      }
    },
    addAnswer() {
      controller.addMember();
      controller = settle();
    },
    setFocusKey(next: string) {
      key = next;
      controller = settle();
    },
    get submission() {
      return hostSubmission;
    },
    get state() {
      return controller.state;
    },
  };
}

beforeEach(() => {
  slots = [];
});

describe("first input into a structure that starts the answer (on-screen keys)", () => {
  it("( then x keeps the bracket and the x", () => {
    const pad = mountHost(false);
    pad.tap("(", "x");
    expect(pad.state.members[0].root.items[0].kind).toBe("group");
    pad.tap(")");
    expect(pad.submission).toBe("(x)");
  });

  it("the device repro reads back exactly", () => {
    const pad = mountHost(false);
    pad.tap("(", "x", "+", "3", ")", "(", "x", "−", "2", ")");
    expect(pad.submission).toBe("(x+3)(x-2)");
  });

  it("( then 2", () => {
    const pad = mountHost(false);
    pad.tap("(", "2", ")");
    expect(pad.submission).toBe("(2)");
  });

  it.each([
    [["{fraction}", "x", "→", "2"], "x/2"],
    [["{power}", "x", "→", "2"], "x^2"],
    [["{sqrt}", "x"], "√(x)"],
    [["{root}", "3", "→", "8"], "∛8"],
    [["{log}", "2", "→", "8"], "log_2(8)"],
    [["{ln}", "x"], "ln(x)"],
    [["{square}", "y"], "y^2"],
  ])("%j as the first input → %s", (taps, expected) => {
    const pad = mountHost(false);
    pad.tap(...taps);
    expect(pad.submission).toBe(expected);
  });

  it.each([
    [["(", "x", "−", "1", ")"], "(x-1)"],
    [["{fraction}", "1", "→", "x"], "1/x"],
    [["{sqrt}", "5"], "√5"],
    [["{power}", "2", "→", "x"], "2^x"],
  ])("first chip AND a second chip both take %j", (taps, expected) => {
    const first = mountHost(true);
    first.tap(...taps);
    expect(first.submission).toBe(expected);
    const second = mountHost(true);
    second.tap("3");
    second.addAnswer();
    second.tap(...taps);
    expect(second.submission).toBe(`3,${expected}`);
  });

  it("rebuilds on a new item or a retry, and never on a verdict", () => {
    const pad = mountHost(false);
    pad.tap("(", "x", ")");
    pad.setFocusKey("item-1:feedback");
    expect(pad.submission).toBe("(x)");
    pad.setFocusKey("item-1:answering");
    expect(pad.submission).toBe("");
    pad.tap("x");
    pad.setFocusKey("item-2:answering");
    expect(pad.submission).toBe("");
  });
});

describe("first character into each structure, hardware keys", () => {
  it.each([
    [["(", "x", ")"], "(x)"],
    [["(", "2", ")"], "(2)"],
    [["|", "x", "|"], "abs(x)"],
  ])("%j", (chars, expected) => {
    const pad = mountHost(false);
    pad.hardware(...chars);
    expect(pad.submission).toBe(expected);
  });

  it("/ and ^ at the very start open an empty structure that keeps its first character", () => {
    const frac = mountHost(false);
    frac.hardware("/", "x", "ArrowDown", "2");
    expect(frac.submission).toBe("x/2");
    const pow = mountHost(false);
    pow.hardware("^", "x", "ArrowUp", "3");
    expect(pow.submission).toBe("x^3");
  });

  it("a hardware comma opens the next solution-set chip, which then takes a bracket", () => {
    const pad = mountHost(true);
    pad.hardware("2", ",", "(", "x", ")");
    expect(pad.submission).toBe("2,(x)");
  });
});
