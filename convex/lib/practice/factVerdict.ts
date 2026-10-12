/**
 * FACT VERDICT — the instant, client-side check for a bare arithmetic fact.
 *
 * A Fast math round is a speed drill: a scholar answering `7 × 8 = ?` should see
 * the verdict the moment they press enter, not after a Convex round trip. Every
 * Quick-facts template stem is `a + b = ?`, `a − b = ?`, or `a × b = ?`
 * (convex/lib/practice/templates.ts), so the client can derive the answer from
 * the stem the scholar is already looking at — no answer field is ever served,
 * and the anti-offloading rule (the correct answer stays server-only) holds:
 * nothing here is more than the arithmetic the stem itself states.
 *
 * The verdict is PROVISIONAL. The server still grades and records the attempt
 * through the ordinary `submitAnswer` path, and its verdict wins on any
 * disagreement (see `local:provisionalGraded` in shared/practiceMachine.ts).
 * Comparison goes through the server's own parser (`rawAnswersEqual`), so the
 * two only disagree if the grading policy itself overrides correctness.
 *
 * Returns null — "no opinion, ask the server" — for anything that is not
 * exactly one of those stems on an integer, unit-free item. Imports only its
 * sibling, so it vendors into native byte-identically (native/scripts/
 * sync-vendor.js).
 */

import { rawAnswersEqual } from "./answers";

const FACT_STEM = /^\s*(\d{1,3})\s*([+−×])\s*(\d{1,3})\s*=\s*\?\s*$/;

/** The arithmetic answer a bare fact stem states, or null if it isn't one. */
export function factStemAnswer(stem: string): number | null {
  const match = FACT_STEM.exec(stem);
  if (!match) return null;
  const a = Number(match[1]);
  const b = Number(match[3]);
  switch (match[2]) {
    case "+":
      return a + b;
    case "−":
      return a - b;
    case "×":
      return a * b;
    default:
      return null;
  }
}

/** True/false when the item is a bare fact the client can check itself; null
 *  when only the server can grade it. */
export function localFactVerdict(
  item: { stem: string; answerType: string; answerUnit?: string },
  raw: string,
): boolean | null {
  if (item.answerType !== "integer" || item.answerUnit) return null;
  const expected = factStemAnswer(item.stem);
  if (expected === null) return null;
  return rawAnswersEqual(raw, String(expected), "integer");
}
