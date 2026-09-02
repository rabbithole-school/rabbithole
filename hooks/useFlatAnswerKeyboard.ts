"use client";

import { useEffect } from "react";

/**
 * Web-only: routes a hardware keyboard into a flat (single-line) practice answer.
 *
 * On web we assume a laptop with a real keyboard, so the practice surfaces no
 * longer render an on-screen number pad (the old `AnswerPad`) — the keyboard IS
 * the pad. This is the single source of truth for that key routing, shared by
 * every flat-answer surface (the drill's non-template branch, the placement
 * quiz, and the teaching step) so the mapping lives in exactly one place.
 *
 * The key set mirrors what `applyKey` (shared/practiceLoop.ts) understands, so
 * the keyboard can produce every answer the on-screen pad used to: digits, a
 * fraction slash `/`, a decimal point `.`, a leading minus `-` (sign toggle),
 * and the remainder `R` (typed as `r`/`R`); Backspace deletes; Enter submits.
 * The 2-D fraction/power/root editor has its OWN richer, structure-aware handler and
 * does NOT use this hook.
 */
export function useFlatAnswerKeyboard({
  enabled,
  onKey,
  onEnter,
  allowUnit = false,
}: {
  /** When false, no listener is attached (e.g. during feedback, or a non-flat item). */
  enabled: boolean;
  /** Receives a single logical key already normalised to `applyKey`'s vocabulary. */
  onKey: (key: string) => void;
  /** Fired on Enter (typically submit / check). Omit to ignore Enter. */
  onEnter?: () => void;
  /**
   * The unit-bearing item's carve-out (mirrors `sanitizePadInput`'s `allowUnit`
   * on native): the answer to "…in cubic centimeters" IS "112 cm³", so the
   * numeric allowlist would make it literally untypeable. Letters, space, `^`
   * and the degree sign `°` pass through as themselves — including `r`, which on
   * these items is a letter, not the remainder token. Default false ⇒
   * byte-identical to before.
   */
  allowUnit?: boolean;
}) {
  useEffect(() => {
    if (!enabled) return;
    const handler = (e: KeyboardEvent) => {
      if (/^[0-9]$/.test(e.key) || e.key === "/" || e.key === "-" || e.key === ".") onKey(e.key);
      else if (
        allowUnit &&
        !e.metaKey &&
        !e.ctrlKey &&
        !e.altKey &&
        (/^[a-zA-Z]$/.test(e.key) || e.key === " " || e.key === "^" || e.key === "°")
      ) {
        // Space would otherwise scroll the page out from under the problem.
        if (e.key === " ") e.preventDefault();
        onKey(e.key);
      } else if (e.key === "r" || e.key === "R") onKey("R");
      else if (e.key === "Backspace") onKey("⌫");
      else if (e.key === "Enter") onEnter?.();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [enabled, onKey, onEnter, allowUnit]);
}
