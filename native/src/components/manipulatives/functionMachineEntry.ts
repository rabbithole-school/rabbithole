/**
 * Typing rules for the Function Machine's two number boxes (native), kept out of
 * the component file so they test without a renderer. The keys come from the
 * shared manipulative `NumberPad`; `applyKey` is the practice pad's own folding.
 */

import { applyKey } from "@/lib/practicePad";

/** Digits a box holds (sign aside) — the bank's largest answer is 150. */
const MAX_DIGITS = 4;

/**
 * Fold one pad key into a box's text: the shared `applyKey`, capped at
 * `MAX_DIGITS` digits, with a lone leading 0 replaced rather than extended
 * ("0" then "5" reads "5", never "05").
 */
export function typeFunctionMachineKey(prev: string, key: string): string {
  if (/^\d$/.test(key)) {
    const digits = prev.replace("-", "");
    if (digits.length >= MAX_DIGITS) return prev;
    if (digits === "0") return prev.replace(/0$/, key);
  }
  return applyKey(prev, key);
}

/** A whole number typed in a box, or null while it is empty or just "-". */
export function parseFunctionMachineNumber(text: string): number | null {
  return /^-?\d+$/.test(text) ? Number(text) : null;
}
