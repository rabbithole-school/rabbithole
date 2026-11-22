/**
 * Shared pieces for the algorithms strand's templates.
 *
 * Every snippet is Python, shown as a fenced listing the stem renderer draws
 * monospaced (shared/practiceStemBlocks.ts). The thing being counted is always
 * a call to `step()`, so "how many steps" has one meaning in every item and a
 * test can run the listing and count the calls.
 *
 * The listings keep to a small subset on purpose: `for … in range(…)`,
 * `for … in <list>`, `while`, `if`/`else`, `break`, `def`/`return`, integer
 * arithmetic with `//`, and `len`. No `**` and no `^`, because the display
 * layer superscripts a caret.
 */
import type { WorkedStep } from "../fadedSteps";
import { stemCodeBlock } from "../../../../shared/practiceStemBlocks";

export const STEP_QUESTION = "How many times does step() run?";

/** A fenced listing followed by the question. */
export function codeStem(lines: readonly string[], question: string = STEP_QUESTION): string {
  return `${stemCodeBlock(lines)}\n${question}`;
}

export function step(text: string, blankText: string): WorkedStep {
  return { text, blankText };
}

/** 1048576 → "1,048,576". Hand-rolled so it reads the same in every runtime. */
export function commas(n: number): string {
  return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/** Whole-number floor of log base `b` (b ≥ 2, n ≥ 1), by repeated division. */
export function floorLog(n: number, b: number): number {
  let count = 0;
  let rest = n;
  while (rest >= b) {
    rest = Math.floor(rest / b);
    count += 1;
  }
  return count;
}

/** `n → n // b → …` down to 1, for a worked step: [100, 50, 25, 12, 6, 3, 1]. */
export function divideChain(n: number, b: number): number[] {
  const chain = [n];
  let rest = n;
  while (rest > 1) {
    rest = Math.floor(rest / b);
    chain.push(rest);
  }
  return chain;
}

export const LOOP_VARS = ["i", "j", "k"] as const;
