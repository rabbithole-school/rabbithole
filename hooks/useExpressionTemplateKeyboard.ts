"use client";

import { useEffect } from "react";

/**
 * Routes the hardware keyboard into the 2-D expression editor's shared model,
 * so a scholar who touch-types builds a fraction/power/root exactly like tapping the
 * on-screen glyph keys. Shared by the practice session AND placement (single
 * source of truth):
 *
 *   • digits + the variable `x` build the active box
 *   • `/` splits a fraction, `^` raises an exponent
 *   • Tab / Shift-Tab and the arrow keys move between boxes (Tab wraps; ↑/↓ hop
 *     a fraction's numerator ↔ denominator)
 *   • Backspace deletes (or unwraps an empty structure)
 *   • Enter submits (via `onSubmit`)
 *
 * A structured answer never needs `-` / `.` / `r`, so those stay inert. The
 * non-digit math + navigation keys are `preventDefault`'d so the browser's own
 * `/` quick-find, Tab focus-move, or arrow-scroll can't steal a keystroke
 * mid-answer. Web-only (the iPad drives the same model from its on-screen
 * keypad); the listener is inert unless `enabled`.
 */
export function useExpressionTemplateKeyboard({
  enabled,
  onKey,
  onSubmit,
  captureNavigation = true,
}: {
  enabled: boolean;
  onKey: (k: string) => void;
  onSubmit?: () => void;
  /** False for feedback-state edit detection, where arrows/Tab must remain inert. */
  captureNavigation?: boolean;
}) {
  useEffect(() => {
    if (!enabled) return;
    const handler = (e: KeyboardEvent) => {
      if (/^[0-9]$/.test(e.key)) onKey(e.key);
      else if (e.key === "x" || e.key === "X") onKey("x");
      else if (e.key === "/") {
        e.preventDefault();
        onKey("/");
      } else if (e.key === "^") {
        e.preventDefault();
        onKey("^");
      } else if (captureNavigation && e.key === "Tab") {
        e.preventDefault();
        onKey(e.shiftKey ? "ShiftTab" : "Tab");
      } else if (captureNavigation && e.key === "ArrowRight") {
        e.preventDefault();
        onKey("ArrowRight");
      } else if (captureNavigation && e.key === "ArrowLeft") {
        e.preventDefault();
        onKey("ArrowLeft");
      } else if (captureNavigation && e.key === "ArrowUp") {
        e.preventDefault();
        onKey("ArrowUp");
      } else if (captureNavigation && e.key === "ArrowDown") {
        e.preventDefault();
        onKey("ArrowDown");
      } else if (e.key === "Backspace") {
        onKey("⌫");
      } else if (e.key === "Enter") {
        onSubmit?.();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [captureNavigation, enabled, onKey, onSubmit]);
}
