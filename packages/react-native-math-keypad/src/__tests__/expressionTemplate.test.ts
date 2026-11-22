import { describe, expect, it } from "vitest";

import {
  createAlgebraTemplateState,
  createExpressionTemplateState,
  expressionTemplateInsertGroup,
  expressionTemplateInsertLog,
  expressionTemplateInsertSquare,
  expressionTemplateApplyKey,
  expressionTemplateBackspace,
  expressionTemplateInsertExponent,
  expressionTemplateInsertFraction,
  expressionTemplateInsertEmptyFraction,
  expressionTemplateInsertRoot,
  expressionTemplateInsertSquareRoot,
  expressionTemplateInsertToken,
  expressionTemplateIsComplete,
  expressionTemplateMoveDown,
  expressionTemplateMoveLeft,
  expressionTemplateMoveRight,
  expressionTemplateMoveUp,
  expressionTemplateNextSlot,
  expressionTemplatePrevSlot,
  expressionTemplateSeedFromSkeleton,
  expressionTemplateSetActiveSlot,
  expressionTemplateSetCaret,
  expressionTemplateSlotIsEmpty,
  expressionTemplateToLatex,
  expressionTemplateToSubmission,
  type ExpressionTemplateState,
  type Item,
} from "../model/expressionTemplate";

/** Fill the active box, then submit — small helper for the assertions below. */
function typeInto(state: ExpressionTemplateState, digits: string): ExpressionTemplateState {
  let s = state;
  for (const d of digits) s = expressionTemplateInsertToken(s, d);
  return s;
}

describe("expressionTemplateSeedFromSkeleton (L1 scaffold)", () => {
  it("builds a locked single fraction from F(_/_) with focus on the numerator", () => {
    const state = expressionTemplateSeedFromSkeleton("F(_/_)");
    expect(state).not.toBeNull();
    expect(state!.structureLocked).toBe(true);
    // Two empty boxes, focus on the first (numerator).
    expect(expressionTemplateSlotIsEmpty(state!, state!.activeSlotId)).toBe(true);
    expect(expressionTemplateIsComplete(state!)).toBe(false);
  });

  it("nests: F(F(_/_)/_) is a complex fraction with three boxes", () => {
    const state = expressionTemplateSeedFromSkeleton("F(F(_/_)/_)")!;
    expect(state).not.toBeNull();
    // Fill all three boxes by walking the tree via NextSlot and typing.
    let s: ExpressionTemplateState = state;
    // numerator-of-inner, denominator-of-inner, outer-denominator
    s = expressionTemplateInsertToken(s, "2");
    s = expressionTemplateSetActiveSlot(s, nthEmpty(s));
    s = expressionTemplateInsertToken(s, "3");
    s = expressionTemplateSetActiveSlot(s, nthEmpty(s));
    s = expressionTemplateInsertToken(s, "4");
    expect(expressionTemplateIsComplete(s)).toBe(true);
    // Minimal parens: inner `2/3` is atomic on both sides → bare; the outer
    // fraction's numerator is compound (contains `/`) → wrapped. Grades as
    // (2/3)/4 through the expression grader.
    expect(expressionTemplateToSubmission(s)).toBe("(2/3)/4");
  });

  it("returns null for a non-fraction skeleton (caller falls back to L3)", () => {
    expect(expressionTemplateSeedFromSkeleton("_")).toBeNull();
    expect(expressionTemplateSeedFromSkeleton("F(_/_)+_")).toBeNull();
    expect(expressionTemplateSeedFromSkeleton("garbage")).toBeNull();
  });

  it("a locked scaffold refuses structural edits (fraction/exponent are no-ops)", () => {
    const state = expressionTemplateSeedFromSkeleton("F(_/_)")!;
    expect(expressionTemplateInsertFraction(state)).toBe(state);
    expect(expressionTemplateInsertExponent(state)).toBe(state);
  });

  it("a locked scaffold's backspace clears digits but never deletes a box", () => {
    let s = expressionTemplateSeedFromSkeleton("F(_/_)")!;
    const numId = s.activeSlotId;
    s = expressionTemplateInsertToken(s, "5");
    expect(expressionTemplateSlotIsEmpty(s, numId)).toBe(false);
    s = expressionTemplateBackspace(s);
    // Box emptied…
    expect(expressionTemplateSlotIsEmpty(s, numId)).toBe(true);
    // …but the fraction structure survives (still two boxes → not complete).
    expect(expressionTemplateIsComplete(s)).toBe(false);
    // A further backspace on the empty box does not collapse the template.
    const s2 = expressionTemplateBackspace(s);
    expect(expressionTemplateIsComplete(s2)).toBe(false);
  });
});

describe("expressionTemplateSetActiveSlot (tap-to-focus)", () => {
  it("moves focus to a real slot and is a no-op for unknown/same ids", () => {
    const state = expressionTemplateInsertFraction(createExpressionTemplateState(""));
    const num = state.activeSlotId;
    // Same id → same reference.
    expect(expressionTemplateSetActiveSlot(state, num)).toBe(state);
    // Unknown id → same reference.
    expect(expressionTemplateSetActiveSlot(state, "slot_999")).toBe(state);
    // A real other slot → focus moves.
    const other = otherEmpty(state, num);
    const moved = expressionTemplateSetActiveSlot(state, other);
    expect(moved.activeSlotId).toBe(other);
  });
});

describe("locked scaffold: focus can never escape to a container box", () => {
  // Seed ids are deterministic: parseSide numbers the numerator slot_0 and the
  // denominator slot_1, then the root container slot_2. Focus starts on slot_0.
  it("backspace on an EMPTY box keeps focus put, never jumps to the root", () => {
    let s = expressionTemplateSeedFromSkeleton("F(_/_)")!;
    const numId = s.activeSlotId; // slot_0 (numerator)
    s = expressionTemplateBackspace(s); // nothing to delete in the empty numerator
    expect(s.activeSlotId).toBe(numId); // stayed — did NOT escape to slot_2 (root)
  });

  it("the exact corruption sequence (empty-num backspace → type) now grades clean", () => {
    // Pre-fix repro: empty-numerator backspace moved focus to the root container,
    // so the next digit appended OUTSIDE the boxes (F(_/_) + "5" → "2/35"). Fixed:
    let s = expressionTemplateSeedFromSkeleton("F(_/_)")!;
    s = expressionTemplateBackspace(s); // the escape trigger
    s = expressionTemplateApplyKey(s, "5"); // must fill the numerator, not root
    s = expressionTemplateSetActiveSlot(s, otherEmpty(s, s.activeSlotId)); // denominator
    s = expressionTemplateApplyKey(s, "6");
    expect(expressionTemplateIsComplete(s)).toBe(true);
    expect(expressionTemplateToSubmission(s)).toBe("5/6"); // clean, no stray "…5" tail
  });

  it("tapping the fraction container (root) is a no-op while locked", () => {
    const s = expressionTemplateSeedFromSkeleton("F(_/_)")!;
    expect(expressionTemplateSetActiveSlot(s, "slot_2")).toBe(s); // root holds the fraction
  });

  it("Tab (nextSlot) visits only the fillable boxes, skipping the container", () => {
    let s = expressionTemplateSeedFromSkeleton("F(_/_)")!; // focus slot_0 (num)
    s = expressionTemplateNextSlot(s);
    expect(s.activeSlotId).toBe("slot_1"); // → denominator
    s = expressionTemplateNextSlot(s);
    expect(s.activeSlotId).toBe("slot_0"); // wraps to numerator, never lands on slot_2
  });

  it("even a stray token write into the container is refused while locked", () => {
    const s = expressionTemplateSeedFromSkeleton("F(_/_)")!;
    // Force-focus the root (bypassing the setActiveSlot guard) and try to type:
    const forced: ExpressionTemplateState = { ...s, activeSlotId: "slot_2" };
    expect(expressionTemplateInsertToken(forced, "9")).toBe(forced); // no-op
  });

  it("UNLOCKED backspace fallback still steps focus back (behavior preserved)", () => {
    let s = createExpressionTemplateState(""); // root slot_0
    s = expressionTemplateInsertFraction(s); // num slot_1 focused, den slot_2
    s = expressionTemplateBackspace(s); // empty numerator → step back
    expect(s.activeSlotId).toBe("slot_0"); // root IS focusable when unlocked
  });
});

describe("L3 free build still nests and grades", () => {
  it("builds (1)/(2) then powers it, unlocked", () => {
    let s = createExpressionTemplateState("");
    s = expressionTemplateInsertFraction(s); // focus → numerator
    s = typeInto(s, "1");
    s = expressionTemplateSetActiveSlot(s, otherEmpty(s, s.activeSlotId));
    s = typeInto(s, "2");
    expect(expressionTemplateIsComplete(s)).toBe(true);
    // Minimal parens: a simple single fraction submits bare as `1/2` — exactly
    // what the strict `answerType: "fraction"` grader accepts.
    expect(expressionTemplateToSubmission(s)).toBe("1/2");
    expect(s.structureLocked).toBeFalsy();
  });
});

describe("expressionTemplateApplyKey (shared web+native key router)", () => {
  it("maps a digit to a token, '/' to a fraction, '^' to an exponent", () => {
    let s = createExpressionTemplateState("");
    s = expressionTemplateApplyKey(s, "5");
    expect(expressionTemplateToSubmission(s)).toBe("5");
    // '^' raises the just-typed token, focus lands in the exponent box.
    s = expressionTemplateApplyKey(s, "^");
    s = expressionTemplateApplyKey(s, "2");
    expect(expressionTemplateToSubmission(s)).toBe("5^2");
  });

  it("routes BOTH the glyph '⌫' and a raw 'Backspace' to delete", () => {
    let s = createExpressionTemplateState("");
    s = expressionTemplateApplyKey(s, "7");
    s = expressionTemplateApplyKey(s, "9");
    expect(expressionTemplateToSubmission(s)).toBe("79");
    s = expressionTemplateApplyKey(s, "\u232B"); // ⌫ glyph (on-screen key)
    expect(expressionTemplateToSubmission(s)).toBe("7");
    s = expressionTemplateApplyKey(s, "Backspace"); // hardware key name
    expect(expressionTemplateToSubmission(s)).toBe("");
  });

  it("drives the exact WEB integration flow: L1 skeleton → digit, tap box, digit → 5/6", () => {
    // Mirrors PracticeSession's onTemplateKey + onFocusSlot on an L1 fraction
    // item (answerFormat "F(_/_)"): the submission the CTA gates on is EMPTY
    // until every box is filled, then becomes the graded answer string.
    let s = expressionTemplateSeedFromSkeleton("F(_/_)")!;
    expect(expressionTemplateToSubmission(s)).toBe(""); // half-built → Check disabled
    s = expressionTemplateApplyKey(s, "5"); // fills the focused numerator
    expect(expressionTemplateToSubmission(s)).toBe(""); // still incomplete
    s = expressionTemplateSetActiveSlot(s, otherEmpty(s, s.activeSlotId)); // tap denominator
    s = expressionTemplateApplyKey(s, "6");
    expect(expressionTemplateIsComplete(s)).toBe(true);
    expect(expressionTemplateToSubmission(s)).toBe("5/6"); // Check now enabled
  });

  it("L3 free build via the router alone: '/', '1', tap, '2' → 1/2", () => {
    let s = createExpressionTemplateState("");
    s = expressionTemplateApplyKey(s, "/"); // insert fraction, focus → numerator
    s = expressionTemplateApplyKey(s, "1");
    s = expressionTemplateSetActiveSlot(s, otherEmpty(s, s.activeSlotId));
    s = expressionTemplateApplyKey(s, "2");
    expect(expressionTemplateToSubmission(s)).toBe("1/2");
  });
});

describe("smart '/' wraps the trailing operand as the numerator", () => {
  it("typing `12` then '/' moves 12 into the numerator and focuses the denominator", () => {
    let s = createExpressionTemplateState("");
    s = expressionTemplateApplyKey(s, "1");
    s = expressionTemplateApplyKey(s, "2");
    s = expressionTemplateApplyKey(s, "/"); // 12 → numerator, cursor → denominator
    // Cursor is in the (empty) denominator, so typing 4 fills the bottom.
    s = expressionTemplateApplyKey(s, "4");
    expect(expressionTemplateIsComplete(s)).toBe(true);
    expect(expressionTemplateToSubmission(s)).toBe("12/4");
  });

  it("the natural keystroke journey `3 / 4` builds ¾ end to end", () => {
    let s = createExpressionTemplateState("");
    for (const k of ["3", "/", "4"]) s = expressionTemplateApplyKey(s, k);
    expect(expressionTemplateToSubmission(s)).toBe("3/4");
  });

  it("'/' on an EMPTY box still makes a bare skeleton, cursor in the numerator", () => {
    let s = createExpressionTemplateState("");
    s = expressionTemplateApplyKey(s, "/"); // empty → skeleton, focus numerator
    s = expressionTemplateApplyKey(s, "7"); // fills numerator (not denominator)
    s = expressionTemplateSetActiveSlot(s, otherEmpty(s, s.activeSlotId));
    s = expressionTemplateApplyKey(s, "8");
    expect(expressionTemplateToSubmission(s)).toBe("7/8");
  });

  it("locked scaffolds ignore '/' entirely (structure is fixed)", () => {
    const s = expressionTemplateSeedFromSkeleton("F(_/_)")!;
    expect(expressionTemplateApplyKey(s, "/")).toBe(s);
  });
});

describe("smart '^' raises the trailing operand as the base", () => {
  it("the keystroke journey `2 ^ 3` builds 2³", () => {
    let s = createExpressionTemplateState("");
    for (const k of ["2", "^", "3"]) s = expressionTemplateApplyKey(s, k);
    expect(expressionTemplateToSubmission(s)).toBe("2^3");
  });

  describe("n-th-root atom", () => {
    it("builds a coefficient, index, and radicand, then serializes to plain and LaTex forms", () => {
      let s = createExpressionTemplateState("");
      s = typeInto(s, "3");
      s = expressionTemplateInsertRoot(s);
      s = typeInto(s, "2");
      s = expressionTemplateMoveDown(s);
      s = typeInto(s, "7");
      expect(expressionTemplateIsComplete(s)).toBe(true);
      expect(expressionTemplateToSubmission(s)).toBe("3√7");
      expect(expressionTemplateToLatex(s)).toBe("3\\sqrt{7}");
    });

    it("serializes a cube root through an immutable edit", () => {
      let s: ExpressionTemplateState = {
        root: {
          id: "slot_0",
          items: [
            {
              kind: "root",
              index: { id: "slot_1", items: [{ kind: "token", value: "3" }] },
              radicand: { id: "slot_2", items: [{ kind: "token", value: "8" }] },
            },
          ],
        },
        activeSlotId: "slot_2",
        caretIndex: 1,
        nextId: 3,
      };
      s = expressionTemplateSetCaret(s, "slot_2", 0);

      expect(expressionTemplateIsComplete(s)).toBe(true);
      expect(expressionTemplateToSubmission(s)).toBe("∛8");
      expect(expressionTemplateToLatex(s)).toBe("\\sqrt[3]{8}");
    });

    it("builds a coefficient before a cube root without mistaking it for the index", () => {
      let s = createExpressionTemplateState("");
      s = typeInto(s, "2");
      s = expressionTemplateInsertRoot(s);
      s = typeInto(s, "3");
      s = expressionTemplateMoveDown(s);
      s = typeInto(s, "3");
      expect(expressionTemplateToSubmission(s)).toBe("2∛3");
      expect(expressionTemplateToLatex(s)).toBe("2\\sqrt[3]{3}");
    });

    it("serializes an imported integer index with the bracketed root grammar", () => {
      const s: ExpressionTemplateState = {
        root: {
          id: "slot_0",
          items: [
            {
              kind: "root",
              index: { id: "slot_1", items: [{ kind: "token", value: "4" }] },
              radicand: { id: "slot_2", items: [{ kind: "token", value: "8" }] },
            },
          ],
        },
        activeSlotId: "slot_2",
        caretIndex: 1,
        nextId: 3,
      };
      expect(expressionTemplateIsComplete(s)).toBe(true);
      expect(expressionTemplateToSubmission(s)).toBe("√[4]8");
      expect(expressionTemplateToLatex(s)).toBe("\\sqrt[4]{8}");
    });

    it("enters the radicand when backspacing over a root and unwraps an empty root", () => {
      let s = createExpressionTemplateState("");
      s = expressionTemplateInsertRoot(s);
      s = expressionTemplateBackspace(s);
      expect(expressionTemplateSlotIsEmpty(s, "slot_0")).toBe(true);
    });

    it("starts in the index and moves into the radicand with ArrowDown", () => {
      let s = createExpressionTemplateState("");
      s = expressionTemplateInsertRoot(s);
      expect(s.activeSlotId).toBe("slot_1");
      s = expressionTemplateApplyKey(s, "3");
      s = expressionTemplateApplyKey(s, "ArrowDown");
      expect(s.activeSlotId).toBe("slot_2");
    });

    it("treats a blank explicit index as a complete square root", () => {
      let s = createExpressionTemplateState("");
      s = expressionTemplateInsertRoot(s);
      const indexId = s.activeSlotId;
      s = expressionTemplateApplyKey(s, "ArrowDown");
      s = typeInto(s, "7");

      expect(s.activeSlotId).not.toBe(indexId);
      expect(expressionTemplateIsComplete(s)).toBe(true);
      expect(expressionTemplateToSubmission(s)).toBe("√7");
      expect(expressionTemplateToLatex(s)).toBe("\\sqrt{7}");
    });

    it("inserts an implicit square root directly into the radicand without an index focus stop", () => {
      let s = createExpressionTemplateState("");
      s = expressionTemplateInsertSquareRoot(s);
      const radicandId = s.activeSlotId;
      s = typeInto(s, "7");

      expect(expressionTemplateIsComplete(s)).toBe(true);
      expect(expressionTemplateToSubmission(s)).toBe("√7");
      s = expressionTemplateApplyKey(s, "Tab");
      expect(s.activeSlotId).toBe(radicandId);
    });

    it("expands an implicit square root into an editable index on ArrowUp", () => {
      let s = createExpressionTemplateState("");
      s = expressionTemplateInsertSquareRoot(s);
      s = typeInto(s, "7");
      s = expressionTemplateApplyKey(s, "ArrowUp");

      expect(s.activeSlotId).not.toBe("slot_0");
      expect(expressionTemplateSlotIsEmpty(s, s.activeSlotId)).toBe(true);
      s = typeInto(s, "3");
      s = expressionTemplateMoveDown(s);
      s = typeInto(s, "8");
      expect(expressionTemplateToSubmission(s)).toBe("∛78");
    });

    it("moves from the index to the radicand with Tab", () => {
      let s = createExpressionTemplateState("");
      s = expressionTemplateInsertRoot(s);
      s = expressionTemplateApplyKey(s, "Tab");
      expect(s.activeSlotId).toBe("slot_2");
    });

    it("accepts multi-digit integer indices and keeps focus in the index until navigation", () => {
      let s = createExpressionTemplateState("");
      s = expressionTemplateInsertRoot(s);
      s = expressionTemplateInsertToken(s, "x");
      expect(expressionTemplateSlotIsEmpty(s, s.activeSlotId)).toBe(true);
      s = expressionTemplateInsertToken(s, "1");
      const indexId = s.activeSlotId;
      s = expressionTemplateInsertToken(s, "2");
      expect(s.activeSlotId).toBe(indexId);
      expect(expressionTemplateToSubmission(s)).toBe("");
      s = expressionTemplateMoveDown(s);
      s = expressionTemplateInsertToken(s, "2");
      expect(expressionTemplateToSubmission(s)).toBe("√[12]2");
      expect(expressionTemplateToLatex(s)).toBe("\\sqrt[12]{2}");
    });

    it("keeps zero and one as incomplete explicit indices", () => {
      for (const index of ["0", "1"]) {
        let s = createExpressionTemplateState("");
        s = expressionTemplateInsertRoot(s);
        s = expressionTemplateInsertToken(s, index);
        s = expressionTemplateMoveDown(s);
        s = expressionTemplateInsertToken(s, "9");
        expect(expressionTemplateIsComplete(s), `index=${index}`).toBe(false);
        expect(expressionTemplateToSubmission(s), `index=${index}`).toBe("");
      }
    });

    it("rejects non-canonical and unsafe explicit indices", () => {
      for (const index of ["02", "03", "007", "12345678901234567"]) {
        let s = createExpressionTemplateState("");
        s = expressionTemplateInsertRoot(s);
        s = typeInto(s, index);
        s = expressionTemplateMoveDown(s);
        s = expressionTemplateInsertToken(s, "9");

        expect(expressionTemplateIsComplete(s), `index=${index}`).toBe(false);
        expect(expressionTemplateToSubmission(s), `index=${index}`).toBe("");
      }
    });

    it("rejects structure inside an index and collapses a cleared index to an implicit square root", () => {
      let s = createExpressionTemplateState("");
      s = expressionTemplateInsertRoot(s);
      expect(expressionTemplateInsertFraction(s)).toBe(s);
      expect(expressionTemplateInsertExponent(s)).toBe(s);
      s = typeInto(s, "3");
      s = expressionTemplateApplyKey(s, "ArrowDown");
      s = typeInto(s, "8");
      s = expressionTemplateApplyKey(s, "ArrowUp");
      s = expressionTemplateBackspace(s);
      s = expressionTemplateBackspace(s);
      expect(expressionTemplateToSubmission(s)).toBe("√8");
      expect((s.root.items[0] as Extract<Item, { kind: "root" }>).index).toBeNull();
    });
  });

  it("'^' on an EMPTY box makes a fillable ▢^▢ skeleton, cursor in the base", () => {
    let s = createExpressionTemplateState("");
    s = expressionTemplateApplyKey(s, "^"); // empty → ▢^▢ skeleton, focus base
    s = expressionTemplateApplyKey(s, "2"); // fills the base (not the exponent)
    s = expressionTemplateSetActiveSlot(s, otherEmpty(s, s.activeSlotId));
    s = expressionTemplateApplyKey(s, "3");
    expect(expressionTemplateToSubmission(s)).toBe("2^3");
  });

  it("Tab from the base lands in the exponent of a fresh ▢^▢", () => {
    let s = createExpressionTemplateState("");
    s = expressionTemplateApplyKey(s, "^"); // focus base
    const baseId = s.activeSlotId;
    s = expressionTemplateApplyKey(s, "Tab"); // → exponent
    expect(s.activeSlotId).not.toBe(baseId);
    s = expressionTemplateApplyKey(s, "5");
    s = expressionTemplateSetActiveSlot(s, baseId);
    s = expressionTemplateApplyKey(s, "4");
    expect(expressionTemplateToSubmission(s)).toBe("4^5");
  });

  it("ArrowUp/ArrowDown move between a power's base and exponent", () => {
    let s = createExpressionTemplateState("");
    s = expressionTemplateApplyKey(s, "^"); // focus base
    const baseId = s.activeSlotId;
    s = expressionTemplateMoveUp(s); // base → exponent
    const expId = s.activeSlotId;
    expect(expId).not.toBe(baseId);
    s = expressionTemplateMoveDown(s); // exponent → base
    expect(s.activeSlotId).toBe(baseId);
  });

  it("backspace on an empty base of an empty ▢^▢ deletes the whole power", () => {
    let s = createExpressionTemplateState("");
    s = expressionTemplateApplyKey(s, "^"); // ▢^▢, focus empty base
    s = expressionTemplateBackspace(s); // both sides empty → drop the power
    expect(expressionTemplateSlotIsEmpty(s, "slot_0")).toBe(true);
    expect(s.activeSlotId).toBe("slot_0");
  });
});

describe("Tab / Shift-Tab cycle the fillable boxes (wrapping)", () => {
  it("skips an L3 fraction container so the next digit is never silently rejected", () => {
    let s = createExpressionTemplateState("");
    s = expressionTemplateApplyKey(s, "1");
    s = expressionTemplateApplyKey(s, "/"); // 1 becomes the numerator
    s = expressionTemplateApplyKey(s, "2"); // denominator

    s = expressionTemplateApplyKey(s, "Tab");
    s = expressionTemplateApplyKey(s, "4");

    // Tab wraps directly from denominator to numerator. Before the fix, it
    // landed in the root container and rejected "4", leaving the answer 1/2.
    expect(expressionTemplateToSubmission(s)).toBe("14/2");
  });

  it("preserves Tab direction when click focus is already on an excluded L3 container", () => {
    let s = createExpressionTemplateState("");
    s = expressionTemplateApplyKey(s, "2");
    s = expressionTemplateInsertEmptyFraction(s);
    s = expressionTemplateApplyKey(s, "1");
    s = expressionTemplateMoveDown(s);
    s = expressionTemplateApplyKey(s, "2");
    s = expressionTemplateSetActiveSlot(s, "slot_0"); // mixed-number container

    expect(expressionTemplateNextSlot(s).activeSlotId).toBe("slot_1");
    expect(expressionTemplatePrevSlot(s).activeSlotId).toBe("slot_2");
  });

  it("Shift-Tab wraps backward, the mirror of Tab", () => {
    let s = expressionTemplateSeedFromSkeleton("F(_/_)")!; // focus slot_0 (num)
    s = expressionTemplatePrevSlot(s);
    expect(s.activeSlotId).toBe("slot_1"); // wraps back to denominator
    s = expressionTemplatePrevSlot(s);
    expect(s.activeSlotId).toBe("slot_0"); // back to numerator
  });

  it("Tab and Shift-Tab route through the shared key map", () => {
    let s = expressionTemplateSeedFromSkeleton("F(_/_)")!;
    s = expressionTemplateApplyKey(s, "Tab");
    expect(s.activeSlotId).toBe("slot_1");
    s = expressionTemplateApplyKey(s, "ShiftTab");
    expect(s.activeSlotId).toBe("slot_0");
  });
});

describe("Arrow keys navigate between boxes", () => {
  it("←/→ step linearly and do NOT wrap at the ends", () => {
    let s = expressionTemplateSeedFromSkeleton("F(_/_)")!; // slot_0 num, slot_1 den
    // At the first box, ArrowLeft stays put (no wrap).
    expect(expressionTemplateMoveLeft(s).activeSlotId).toBe("slot_0");
    s = expressionTemplateMoveRight(s); // → denominator
    expect(s.activeSlotId).toBe("slot_1");
    // At the last box, ArrowRight stays put (no wrap).
    expect(expressionTemplateMoveRight(s).activeSlotId).toBe("slot_1");
  });

  it("↓ goes numerator→denominator, ↑ goes denominator→numerator", () => {
    let s = expressionTemplateSeedFromSkeleton("F(_/_)")!; // focus numerator
    s = expressionTemplateMoveDown(s);
    expect(s.activeSlotId).toBe("slot_1"); // denominator
    s = expressionTemplateMoveUp(s);
    expect(s.activeSlotId).toBe("slot_0"); // numerator
  });

  it("↑/↓ are no-ops outside a fraction (predictable, never jumps)", () => {
    let s = createExpressionTemplateState("");
    s = expressionTemplateApplyKey(s, "5"); // a flat token in the root box
    expect(expressionTemplateMoveUp(s)).toBe(s);
    expect(expressionTemplateMoveDown(s)).toBe(s);
  });

  it("arrows route through the shared key map by name", () => {
    let s = expressionTemplateSeedFromSkeleton("F(_/_)")!;
    s = expressionTemplateApplyKey(s, "ArrowDown");
    expect(s.activeSlotId).toBe("slot_1");
    s = expressionTemplateApplyKey(s, "ArrowUp");
    expect(s.activeSlotId).toBe("slot_0");
    s = expressionTemplateApplyKey(s, "ArrowRight");
    expect(s.activeSlotId).toBe("slot_1");
    s = expressionTemplateApplyKey(s, "ArrowLeft");
    expect(s.activeSlotId).toBe("slot_0");
  });

  it("a LOCKED scaffold's arrows never escape to the container box", () => {
    let s = expressionTemplateSeedFromSkeleton("F(_/_)")!; // only slot_0/slot_1 fillable
    for (const k of ["ArrowRight", "ArrowRight", "ArrowDown", "ArrowUp", "ArrowLeft", "ArrowLeft"]) {
      s = expressionTemplateApplyKey(s, k);
      expect(s.activeSlotId === "slot_0" || s.activeSlotId === "slot_1").toBe(true);
    }
  });
});

describe("backspace at an empty edge UNWRAPS the structure (unlocked only)", () => {
  it("deletes a fully-empty fraction and refocuses the container", () => {
    let s = createExpressionTemplateState(""); // root slot_0
    s = expressionTemplateInsertFraction(s); // empty → num slot_1 focus, den slot_2
    s = expressionTemplateBackspace(s); // empty numerator, both sides empty → unwrap
    expect(s.activeSlotId).toBe("slot_0"); // back on the (now empty) root box
    expect(expressionTemplateSlotIsEmpty(s, "slot_0")).toBe(true);
    // The fraction is gone — typing produces a flat token, not a fraction.
    s = expressionTemplateApplyKey(s, "9");
    expect(expressionTemplateToSubmission(s)).toBe("9");
  });

  it("undoes '^': backspace on an empty exponent restores the bare base", () => {
    let s = createExpressionTemplateState("");
    s = expressionTemplateApplyKey(s, "5");
    s = expressionTemplateApplyKey(s, "^"); // 5 → base, cursor in empty exponent
    s = expressionTemplateBackspace(s); // empty exponent → undo the power
    expect(s.activeSlotId).toBe("slot_0");
    expect(expressionTemplateToSubmission(s)).toBe("5"); // base survives, power gone
  });

  it("does NOT unwrap when the other fraction side still has content", () => {
    let s = createExpressionTemplateState("");
    s = expressionTemplateInsertFraction(s); // num slot_1 focus, den slot_2
    s = expressionTemplateApplyKey(s, "1"); // numerator = 1
    s = expressionTemplateSetActiveSlot(s, "slot_2"); // focus empty denominator
    s = expressionTemplateBackspace(s); // denominator empty BUT numerator has 1
    // The fraction survives (numerator content is not lost); focus steps back.
    expect(expressionTemplateSlotIsEmpty(s, "slot_1")).toBe(false);
    expect(s.activeSlotId).toBe("slot_1"); // stepped back to the numerator
  });

  it("a LOCKED scaffold never unwraps on backspace", () => {
    let s = expressionTemplateSeedFromSkeleton("F(_/_)")!;
    s = expressionTemplateBackspace(s); // empty numerator, locked → no unwrap
    // Still a two-box fraction (incomplete), focus held on the numerator.
    expect(expressionTemplateIsComplete(s)).toBe(false);
    expect(s.activeSlotId).toBe("slot_0");
  });
});

describe("insertion bar: caret moves and edits mid-slot (per-char tokens)", () => {
  it("←/→ walk the caret WITHIN a number, and a digit inserts at the caret", () => {
    let s = createExpressionTemplateState("");
    for (const k of ["1", "3"]) s = expressionTemplateApplyKey(s, k); // "13", caret at end
    s = expressionTemplateApplyKey(s, "ArrowLeft"); // caret between 1 and 3
    s = expressionTemplateApplyKey(s, "2"); // insert 2 at the caret → "123"
    expect(expressionTemplateToSubmission(s)).toBe("123");
  });

  it("backspace deletes the glyph LEFT of the caret, not the last one typed", () => {
    let s = createExpressionTemplateState("");
    for (const k of ["1", "2", "3"]) s = expressionTemplateApplyKey(s, k); // "123"
    s = expressionTemplateApplyKey(s, "ArrowLeft"); // caret between 2 and 3
    s = expressionTemplateApplyKey(s, "Backspace"); // removes the 2 → "13"
    expect(expressionTemplateToSubmission(s)).toBe("13");
  });

  it("click-to-place (setCaret) drops the bar at a precise gap, then inserts there", () => {
    let s = createExpressionTemplateState("");
    for (const k of ["4", "5"]) s = expressionTemplateApplyKey(s, k); // "45"
    s = expressionTemplateSetCaret(s, s.activeSlotId, 0); // caret before the 4
    s = expressionTemplateApplyKey(s, "9"); // → "945"
    expect(expressionTemplateToSubmission(s)).toBe("945");
  });
});

describe("mixed numbers: whole number + fraction serialize as `W N/D`", () => {
  it("the empty-insert fraction glyph builds `2 1/2` from a whole then a fraction", () => {
    let s = createExpressionTemplateState("");
    s = expressionTemplateApplyKey(s, "2"); // whole part
    s = expressionTemplateInsertEmptyFraction(s); // glyph: empty ▢/▢ after the 2, caret → numerator
    s = expressionTemplateApplyKey(s, "1"); // numerator
    s = expressionTemplateApplyKey(s, "ArrowDown"); // → denominator
    s = expressionTemplateApplyKey(s, "2"); // denominator
    expect(expressionTemplateIsComplete(s)).toBe(true);
    // Serializes with a SPACE (the codebase's mixed convention), never `2(1/2)`.
    expect(expressionTemplateToSubmission(s)).toBe("2 1/2");
  });

  it("a bare single fraction is still `n/d` (no stray whole part)", () => {
    let s = createExpressionTemplateState("");
    s = expressionTemplateInsertEmptyFraction(s); // caret → numerator
    s = expressionTemplateApplyKey(s, "3");
    s = expressionTemplateApplyKey(s, "ArrowDown");
    s = expressionTemplateApplyKey(s, "4");
    expect(expressionTemplateToSubmission(s)).toBe("3/4");
  });

  it("the exponent glyph GRABS the operand to its left as the base (`1` → `1^▢`)", () => {
    let s = createExpressionTemplateState("");
    s = expressionTemplateApplyKey(s, "1"); // a standalone 1, caret after it
    s = expressionTemplateInsertExponent(s); // glyph: grab the 1 as base, caret → exponent
    s = expressionTemplateApplyKey(s, "2"); // exponent
    // The 1 became the base (not a sibling), so this reads 1^2 — never `1 ▢^▢`.
    expect(expressionTemplateToSubmission(s)).toBe("1^2");
  });

  it("the exponent glyph with no operand to grab inserts an empty `▢^▢`", () => {
    let s = createExpressionTemplateState("");
    s = expressionTemplateInsertExponent(s); // nothing to grab → empty base, caret → base
    s = expressionTemplateApplyKey(s, "2"); // base
    s = expressionTemplateApplyKey(s, "ArrowUp"); // base → exponent
    s = expressionTemplateApplyKey(s, "3");
    expect(expressionTemplateToSubmission(s)).toBe("2^3");
  });

  it("`^` with the caret in a power's base hops to the existing exponent (never nests)", () => {
    let s = createExpressionTemplateState("");
    for (const k of ["3", "^", "2"]) s = expressionTemplateApplyKey(s, k); // 3^2, caret in exponent
    s = expressionTemplateApplyKey(s, "ArrowDown"); // exponent → base (caret after the 3)
    s = expressionTemplateApplyKey(s, "^"); // must FOCUS the 2, not build (3^▢)^2
    s = expressionTemplateApplyKey(s, "5"); // lands in the existing exponent, appended
    // Still a single power — the base is 3, the exponent became 25.
    expect(expressionTemplateToSubmission(s)).toBe("3^25");
  });

  it("a COMPOUND fractional part uses explicit `+` so it isn't read as multiplication", () => {
    let s = createExpressionTemplateState("");
    s = expressionTemplateApplyKey(s, "2"); // whole part
    s = expressionTemplateInsertEmptyFraction(s); // ▢/▢ after the 2, caret → outer numerator
    s = expressionTemplateInsertEmptyFraction(s); // nest a fraction in the numerator
    s = expressionTemplateApplyKey(s, "1"); // inner numerator
    s = expressionTemplateApplyKey(s, "Tab"); // → inner denominator
    s = expressionTemplateApplyKey(s, "3");
    s = expressionTemplateApplyKey(s, "Tab"); // → outer denominator
    s = expressionTemplateApplyKey(s, "4");
    // `2 (1/3)/4` would grade as 2×(1/3)/4; the explicit `+` gives the true mixed
    // value 2 + (1/3)/4 = 2 + 1/12.
    expect(expressionTemplateToSubmission(s)).toBe("2+(1/3)/4");
  });
});

describe("nonsense guard: a number can't sit to the RIGHT of a fraction/power", () => {
  it("typing a digit after a completed fraction is a no-op (kills `(1/2)2`)", () => {
    let s = createExpressionTemplateState("");
    for (const k of ["1", "/", "2"]) s = expressionTemplateApplyKey(s, k); // 1/2, caret in denominator
    // Put the caret in the ROOT, right after the fraction, then try to type.
    s = expressionTemplateSetCaret(s, "slot_0", 1); // root slot, index after the fraction
    const before = s;
    s = expressionTemplateApplyKey(s, "2"); // blocked — nothing valid can go here
    expect(s).toBe(before); // exact no-op
    expect(expressionTemplateToSubmission(s)).toBe("1/2");
  });

  it("but a whole number to the LEFT of a fraction is allowed (that's a mixed number)", () => {
    let s = createExpressionTemplateState("");
    s = expressionTemplateInsertEmptyFraction(s); // ▢/▢, caret in numerator
    s = expressionTemplateApplyKey(s, "1");
    s = expressionTemplateApplyKey(s, "ArrowDown");
    s = expressionTemplateApplyKey(s, "2"); // fraction is 1/2
    // Move to the root, BEFORE the fraction, and type the whole part.
    s = expressionTemplateSetCaret(s, "slot_0", 0);
    s = expressionTemplateApplyKey(s, "2"); // allowed → whole part
    expect(expressionTemplateToSubmission(s)).toBe("2 1/2");
  });

  it("typing a digit to the LEFT of a power is a no-op (kills the `13^2` concatenation)", () => {
    let s = createExpressionTemplateState("");
    for (const k of ["3", "^", "2"]) s = expressionTemplateApplyKey(s, k); // 3^2
    // Put the caret in the ROOT, right BEFORE the power, then try to type.
    s = expressionTemplateSetCaret(s, "slot_0", 0);
    const before = s;
    s = expressionTemplateApplyKey(s, "1"); // blocked — `1` before `3^2` reads as "13^2"
    expect(s).toBe(before); // exact no-op
    expect(expressionTemplateToSubmission(s)).toBe("3^2");
    // (Unlike a fraction, there's no "mixed power" — a whole left of a power is nonsense.)
  });

  it("pressing `^` with the caret before an existing digit is a no-op (kills `3^2 · 1`)", () => {
    let s = createExpressionTemplateState("");
    s = expressionTemplateApplyKey(s, "1"); // a standalone 1
    s = expressionTemplateSetCaret(s, "slot_0", 0); // caret BEFORE the 1
    const before = s;
    s = expressionTemplateInsertExponent(s); // would drop ▢^▢ to the LEFT of the 1 → nonsense
    expect(s).toBe(before); // exact no-op
    expect(expressionTemplateToSubmission(s)).toBe("1");
  });
});

// ── helpers ────────────────────────────────────────────────────────────────
// Find the first still-empty slot id by brute-forcing the small id space.
function nthEmpty(state: ExpressionTemplateState): string {
  for (let i = 0; i < 20; i++) {
    const id = `slot_${i}`;
    if (expressionTemplateSlotIsEmpty(state, id)) return id;
  }
  throw new Error("no empty slot");
}

function otherEmpty(state: ExpressionTemplateState, notId: string): string {
  for (let i = 0; i < 20; i++) {
    const id = `slot_${i}`;
    if (id !== notId && expressionTemplateSlotIsEmpty(state, id)) return id;
  }
  throw new Error("no other empty slot");
}

// ═══════════════════════════════════════════════════════════════════════════
// ALGEBRA MODE — key sequences → model → the plain answer string.
// Keys are applyKey keys; `{…}` names an on-screen structural key; arrows are
// the caret keys.
// ═══════════════════════════════════════════════════════════════════════════

function algebraKey(state: ExpressionTemplateState, key: string): ExpressionTemplateState {
  switch (key) {
    case "{frac}":
      return expressionTemplateInsertEmptyFraction(state);
    case "{pow}":
      return expressionTemplateInsertExponent(state);
    case "{sq}":
      return expressionTemplateInsertSquare(state);
    case "{sqrt}":
      return expressionTemplateInsertSquareRoot(state);
    case "{root}":
      return expressionTemplateInsertRoot(state);
    case "{log}":
      return expressionTemplateInsertLog(state);
    case "{ln}":
      return expressionTemplateInsertGroup(state, "ln");
    case "{abs}":
      return expressionTemplateInsertGroup(state, "abs");
    case "→":
      return expressionTemplateApplyKey(state, "ArrowRight");
    case "←":
      return expressionTemplateApplyKey(state, "ArrowLeft");
    case "↓":
      return expressionTemplateApplyKey(state, "ArrowDown");
    case "↑":
      return expressionTemplateApplyKey(state, "ArrowUp");
    default:
      return expressionTemplateApplyKey(state, key);
  }
}

/** Split a script into keys: `{name}` groups stay whole, every other character
 *  is its own key. Spaces are ignored. */
function keysOf(script: string): string[] {
  return script.match(/\{[a-z]+\}|\S/gu) ?? [];
}

function typeAlgebra(script: string, start = createAlgebraTemplateState()): ExpressionTemplateState {
  return keysOf(script).reduce(algebraKey, start);
}

describe("algebra mode: key sequences serialize to the answer grammar", () => {
  const cases: Array<[string, string]> = [
    ["(x+3)(x-2)", "(x+3)(x-2)"],
    ["3+2i", "3+2i"],
    ["x^2/3", "x^(2/3)"],
    ["x{pow}{frac}1↓3", "x^(1/3)"],
    ["{log}2(x+1", "log_2(x+1)"],
    ["{log}2(x+1)", "log_2(x+1)"],
    ["(x+1)/x-2", "(x+1)/(x-2)"],
    ["2{sqrt}3", "2√3"],
    ["-1/2", "-1/2"],
    ["2±3i", "2±3i"],
    ["x{sq}+3x-4", "x^2+3x-4"],
    ["x^2+1", "x^2+1"],
    ["2^(x+1)", "2^(x+1)"],
    ["e^2x", "e^(2x)"],
    ["{ln}x", "ln(x)"],
    ["{log}→100", "log(100)"],
    ["{log}(100", "log(100)"],
    ["x^-2", "x^(-2)"],
    ["{sqrt}x+1", "√(x+1)"],
    ["{root}3→8", "∛8"],
    ["{root}4→x", "√[4](x)"],
    ["{sqrt}x", "√(x)"],
    ["{sqrt}(x+1", "√(x+1)"],
    ["|x-3|", "abs(x-3)"],
    ["{abs}x-3", "abs(x-3)"],
    ["2(x+1)", "2(x+1)"],
    ["x(x+1)", "x(x+1)"],
    ["(x+1)^2", "(x+1)^2"],
    ["(x+1){sq}", "(x+1)^2"],
    ["3x^2", "3x^2"],
    ["x^2→y", "x^2*y"],
    ["1/x", "1/x"],
    ["2/3x", "2/(3x)"],
    ["(2x+1)/3", "(2x+1)/3"],
    ["5e^-0.2t", "5e^(-0.2t)"],
    ["n{sq}+1", "n^2+1"],
    ["2^n", "2^n"],
    ["3(2)^(n-1)", "3(2)^(n-1)"],
    ["i", "i"],
    ["-i", "-i"],
    ["{log}x(8", "log_x(8)"],
    ["2x^2-8x+6", "2x^2-8x+6"],
    ["π", "π"],
    ["2π", "2π"],
    ["x*y", "x*y"],
    ["x×y", "x*y"],
    ["xy", "x*y"],
    ["2{frac}1↓2", "2 1/2"],
    ["{sqrt}3→x", "√3*x"],
    ["{sqrt}2→/2", "(√2)/2"],
    ["1/(x-1)", "1/(x-1)"],
    ["x^(1/2)", "x^(1/2)"],
    ["4-x{sq}", "4-x^2"],
    ["X+Y", "x+y"],
    ["x−3", "x-3"],
    ["(x-2)(x+2)(x-1)", "(x-2)(x+2)(x-1)"],
    ["-3±{sqrt}5", "-3±√5"],
    ["(1+{sqrt}2)/2", "(1+√2)/2"],
  ];
  it.each(cases)("%s → %s", (script, expected) => {
    expect(expressionTemplateToSubmission(typeAlgebra(script))).toBe(expected);
  });

  it("covers at least forty distinct answers", () => {
    expect(new Set(cases.map(([, e]) => e)).size).toBeGreaterThanOrEqual(40);
  });
});

describe("algebra mode: structure and caret", () => {
  it("( builds a bracket group with the caret inside; ) steps out of it", () => {
    let s = typeAlgebra("(x");
    expect(s.root.items).toHaveLength(1);
    expect(s.root.items[0].kind).toBe("group");
    expect(s.activeSlotId).not.toBe("slot_0");
    s = algebraKey(s, ")");
    expect(s.activeSlotId).toBe("slot_0");
    expect(s.caretIndex).toBe(1);
  });

  it(") with no enclosing bracket is a no-op", () => {
    const s = typeAlgebra("x");
    expect(algebraKey(s, ")")).toBe(s);
  });

  it(") steps out of a bracket from inside a nested exponent", () => {
    const s = typeAlgebra("(x^(2");
    const out = typeAlgebra("))", s);
    expect(out.activeSlotId).toBe("slot_0");
    expect(expressionTemplateToSubmission(out)).toBe("(x^(2))");
  });

  it("→ at the end of every structure steps back onto the line", () => {
    for (const open of ["x{pow}2", "{frac}1↓2", "{sqrt}2", "{log}2(8", "{ln}x", "{abs}x", "(x"]) {
      const s = algebraKey(typeAlgebra(open), "→");
      expect(s.activeSlotId).toBe("slot_0");
      expect(s.caretIndex).toBe(1);
    }
  });

  it("← from just after a structure walks back into its last box", () => {
    for (const open of ["x{pow}2→", "{sqrt}2→", "{log}2(8)", "{ln}x→", "(x)", "{frac}1↓2→"]) {
      const s = algebraKey(typeAlgebra(open), "←");
      expect(s.activeSlotId).not.toBe("slot_0");
    }
  });

  it("a simple exponent ends when an operator is typed; a compound one does not", () => {
    expect(expressionTemplateToSubmission(typeAlgebra("x^n-1"))).toBe("x^n-1");
    expect(expressionTemplateToSubmission(typeAlgebra("x^(n-1)"))).toBe("x^(n-1)");
    expect(expressionTemplateToSubmission(typeAlgebra("x^2x+1"))).toBe("x^(2x+1)");
  });

  it("^ right after a power re-enters its exponent instead of stacking a tower", () => {
    const s = typeAlgebra("x{sq}^");
    expect(s.activeSlotId).not.toBe("slot_0");
    expect(expressionTemplateToSubmission(typeAlgebra("x{sq}^0"))).toBe("x^20");
  });

  it("x² with nothing to square opens the base box with the 2 in place", () => {
    const s = typeAlgebra("{sq}");
    expect(s.activeSlotId).not.toBe("slot_0");
    expect(expressionTemplateToSubmission(typeAlgebra("{sq}y"))).toBe("y^2");
  });

  it("a log base may stay empty (base 10), and ↑/↓ move between base and argument", () => {
    let s = typeAlgebra("{log}");
    const base = s.activeSlotId;
    s = algebraKey(s, "↑");
    expect(s.activeSlotId).not.toBe(base);
    s = algebraKey(s, "↓");
    expect(s.activeSlotId).toBe(base);
  });

  it("a root's index box takes digits only", () => {
    const s = typeAlgebra("{root}");
    expect(algebraKey(s, "x")).toBe(s);
    expect(algebraKey(s, "+")).toBe(s);
  });

  it("refuses characters the grammar cannot hold", () => {
    const s = typeAlgebra("x");
    for (const c of ["=", "$", "#", "&", "!", ",", ";"]) expect(algebraKey(s, c)).toBe(s);
  });

  it("÷ builds a fraction like /", () => {
    expect(expressionTemplateToSubmission(typeAlgebra("6÷4"))).toBe("6/4");
  });
});

describe("algebra mode: backspace through structures", () => {
  it("deletes characters, steps into a structure on its right edge, and unwraps a bracket at its start", () => {
    let s = typeAlgebra("(x+1)");
    s = algebraKey(s, "⌫"); // into the bracket, caret after 1
    expect(s.activeSlotId).not.toBe("slot_0");
    s = algebraKey(s, "⌫"); // deletes 1
    s = typeAlgebra("←←", s); // caret before x
    s = algebraKey(s, "⌫"); // unwraps: the brackets go, x+ stays
    expect(s.activeSlotId).toBe("slot_0");
    expect(s.root.items.map((it) => (it.kind === "token" ? it.value : it.kind))).toEqual(["x", "+"]);
  });

  it("removes an empty log, ln, |…|, bracket, fraction or root, and undoes an empty exponent", () => {
    for (const open of ["{log}", "{ln}", "{frac}", "{abs}", "(", "{sqrt}"]) {
      const s = algebraKey(typeAlgebra(open), "⌫");
      expect(s.root.items).toHaveLength(0);
      expect(s.activeSlotId).toBe("slot_0");
    }
    const undone = algebraKey(typeAlgebra("x^"), "⌫");
    expect(expressionTemplateToSubmission(undone)).toBe("x");
  });

  it("backspace from the end empties a whole log without ever losing the caret", () => {
    let s = typeAlgebra("{log}2(8)");
    for (let i = 0; i < 12 && s.root.items.length > 0; i++) {
      s = algebraKey(s, "⌫");
    }
    expect(s.root.items).toHaveLength(0);
    expect(s.activeSlotId).toBe("slot_0");
  });
});

describe("algebra mode: Check stays off for a visibly unfinished answer", () => {
  it.each(["x+", "+x", "x+*2", "(", "x^", "{log}", "{log}2", "{frac}1", "{sqrt}", "-"])(
    "%s is incomplete",
    (script) => {
      const s = typeAlgebra(script);
      expect(expressionTemplateIsComplete(s)).toBe(false);
      expect(expressionTemplateToSubmission(s)).toBe("");
    },
  );

  it.each(["x*-2", "-x", "±3", "3±-1", "{log}→8"])("%s is complete", (script) => {
    expect(expressionTemplateIsComplete(typeAlgebra(script))).toBe(true);
  });
});

describe("algebra mode: LaTeX preview", () => {
  it("renders the new structures", () => {
    expect(expressionTemplateToLatex(typeAlgebra("{log}2(x"))).toBe("\\log_{2}\\left(x\\right)");
    expect(expressionTemplateToLatex(typeAlgebra("{abs}x"))).toBe("\\left|x\\right|");
    expect(expressionTemplateToLatex(typeAlgebra("{ln}x"))).toBe("\\ln\\left(x\\right)");
    expect(expressionTemplateToLatex(typeAlgebra("2±x×y"))).toBe("2\\pm x\\times y");
  });
});

describe("constrained mode is untouched by algebra mode", () => {
  it("still refuses operators, letters other than x, and brackets", () => {
    const s = createExpressionTemplateState("");
    for (const c of ["+", "-", "*", "(", ")", "y", "i", "|", "÷"]) {
      expect(expressionTemplateApplyKey(s, c)).toBe(s);
    }
  });

  it("the algebra-only ops are no-ops outside algebra mode", () => {
    const s = createExpressionTemplateState("2");
    expect(expressionTemplateInsertSquare(s)).toBe(s);
    expect(expressionTemplateInsertLog(s)).toBe(s);
    expect(expressionTemplateInsertGroup(s, "paren")).toBe(s);
  });

  it("still serializes a mixed number the old way", () => {
    let s = createExpressionTemplateState("2");
    s = expressionTemplateInsertEmptyFraction(s);
    s = typeInto(s, "1");
    s = expressionTemplateMoveDown(s);
    s = typeInto(s, "2");
    expect(expressionTemplateToSubmission(s)).toBe("2 1/2");
  });
});
