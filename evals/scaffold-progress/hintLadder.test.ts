/**
 * The HINT-LADDER guard — companion to `scaffoldProgress.test.ts`.
 *
 * That suite proves tier 1 is a real step forward (the blank asks a move
 * strictly smaller than the problem). This one proves tier 2 exists and is
 * honest, for every template family that emits worked steps:
 *
 *   COVERAGE  every item offers a tier-2 hint (or an explicit `hintText`),
 *             so "I'm still stuck" is never a dead end that jumps to a person
 *             on the first tap when a smaller rung was available.
 *   HONESTY   no hint ever ASSERTS the answer — not after an `=`, not trailing
 *             the sentence. A hint that hands over the answer isn't a rung, it
 *             is the reveal wearing a hat.
 *   DISTINCT  a hint is never textually identical to the blank it hints at.
 *             A rung that repeats the rung above it is not a rung.
 *
 * Same deterministic seed ladder as the scaffold sweep, so a failure here
 * reproduces exactly and points at one family + one seed.
 */
import { describe, expect, it } from "vitest";
import { formatAnswer } from "../../convex/lib/practice/answers";
import { deriveStepHint } from "../../convex/lib/practice/fadedSteps";
import { generateItem } from "../../convex/lib/practice/templates";
import { SCAFFOLDED_FAMILIES } from "./sweep";

const SWEEP = 300;
const SEED_STRIDE = 2654435761;

/** Mirrors `deriveStepHint`'s blanking rule: a RESULT position is after an `=`
 *  or at the end of the sentence. An operand that happens to equal the answer
 *  is an input to the move, not a giveaway. */
function assertsAnswer(text: string, answer: string): boolean {
  const esc = answer.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const tail = "(?![\\d]|[./]\\d)";
  return (
    new RegExp(`=\\s*${esc}${tail}`).test(text) ||
    new RegExp(`(^|[^\\d./])${esc}${tail}\\s*\\.?\\s*$`).test(text)
  );
}

describe("the teaching moment's hint ladder", () => {
  for (const family of SCAFFOLDED_FAMILIES) {
    it(`${family}: every item has an honest tier-2 hint`, () => {
      let n = 0;
      const missing: string[] = [];
      const leaked: string[] = [];
      const same: string[] = [];

      for (let i = 0; i < SWEEP; i++) {
        const seed = 1 + i * SEED_STRIDE;
        const item = generateItem(family, seed);
        if (!item?.workedSteps || item.workedSteps.length < 2) continue;
        n++;

        // The teaching moment blanks exactly one step: the last.
        const blanked = item.workedSteps[item.workedSteps.length - 1];
        const answer = formatAnswer(item.answer);
        const hint = blanked.hintText ?? deriveStepHint(blanked.text, answer);

        if (!hint) {
          missing.push(`seed ${seed}: "${blanked.text}" (answer ${answer})`);
          continue;
        }
        if (assertsAnswer(hint, answer)) {
          leaked.push(`seed ${seed}: "${hint}" asserts ${answer}`);
        }
        if (hint === blanked.blankText) {
          same.push(`seed ${seed}: hint === blank ("${hint}")`);
        }
      }

      expect(n).toBeGreaterThan(0);
      expect(leaked.slice(0, 3), `${family}: hint LEAKS the answer`).toEqual([]);
      expect(same.slice(0, 3), `${family}: hint duplicates the blank`).toEqual([]);
      expect(missing.slice(0, 3), `${family}: no tier-2 rung available`).toEqual([]);
    });
  }
});
