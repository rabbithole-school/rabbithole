/**
 * Seed data: the authored "Launchpad" doorway for the algorithms strand of
 * discrete-math (counting an algorithm's steps, and big-O growth).
 *
 * One strand doorway, stored through the same verify→store gate as the rest
 * of `instructionSeed.ts`, which spreads these lists into
 * `AUTHORED_LAUNCHPADS` and `INSTRUCTION_ANCHOR_STRANDS`. Items in this strand
 * carry their own worked steps, so the move a scholar sees on a framed item is
 * about that item; this doorway is the strand's "See an example" content.
 *
 * Launchpad atoms render as plain text or through `FractionText`, neither of
 * which draws the fenced code listing a practice stem can. So the code here is
 * short enough to read on one line.
 */

import { DISCRETE_MATH_DOMAIN } from "./discreteMathGraph";
import type { SeedLaunchpad } from "./instructionSeed";

export const ALGORITHMS_ANCHOR_STRANDS: { domain: string; strand: string }[] = [
  { domain: DISCRETE_MATH_DOMAIN, strand: "algorithms" },
];

export const ALGORITHMS_STRAND_LAUNCHPADS: SeedLaunchpad[] = [
  {
    domain: DISCRETE_MATH_DOMAIN,
    strand: "algorithms",
    title: "Count the steps before you run it",
    subtitle: "How much more work does a bigger input cost?",
    atoms: [
      {
        kind: "story_hook",
        hook: "Guess a number from 1 to 1,000,000. Asking “is it 1? is it 2?” could take a million guesses. Asking “is it above 500,000?” and halving again each time takes at most 20.",
      },
      {
        kind: "micro_explain",
        text: "To compare two programs, count their steps for an input of size n. A loop over n items takes about n steps. A loop inside a loop takes n · n. A loop that halves n takes very few. What matters most is how fast the count grows as n gets big.",
      },
      {
        kind: "worked_example",
        strategyLabel: "Count the inner loop, then multiply",
        steps: [
          "The code: for i in range(5): for j in range(5): step()",
          "range(5) counts 0, 1, 2, 3, 4. That is 5 values.",
          "One run of the inner loop calls step() 5 times.",
          "The outer loop runs the inner loop 5 times.",
          "So step() runs 5 · 5 = 25 times.",
        ],
        examplePrompt: "for i in range(5): for j in range(5): step(). How many times does step() run?",
        exampleAnswer: "25",
      },
      {
        kind: "try_it",
        strategyLabel: "Double n and watch the count",
        steps: [
          "With n = 10, two nested loops call step() 10 · 10 = 100 times.",
          "Double n to 20: now each loop runs 20 times.",
          "20 · 20 = 400. The input doubled and the work went up 4 times.",
        ],
        examplePrompt: "Two nested loops each run n times. They take 100 steps when n = 10. How many steps when n = 20?",
        exampleAnswer: "400",
        answerType: "integer",
      },
    ],
  },
];
