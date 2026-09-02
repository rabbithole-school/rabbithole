/**
 * Seed data: authored "Launchpad" instructional content for a curated set of
 * ANCHOR strands (instructional segments v1).
 *
 * These are the strand doorways where a genuinely new *move* appears — the right
 * granularity per the pedagogy review (not per-node; a per-node Launchpad would
 * re-Socratize the loop and bury the signal). Each Launchpad is DECOUPLED from
 * any served item: its `worked_example` teaches the strand's core move on its OWN
 * canonical numbers, so viewing it can never leak a live item's answer.
 *
 * Content here is `provenance: "authored"`, but it is stored through the SAME
 * generate→verify→store path as machine generation (convex/instruction.ts
 * `storeInstructionContent`, gated by convex/lib/practice/instructionVerify.ts).
 * Live generation (practiceGen.generateInstructionContent) emits the identical
 * shape and stores through the same gate; authored seed is what makes e2e work
 * without an ANTHROPIC_API_KEY.
 *
 * The DESIGNATED anchor set is `INSTRUCTION_ANCHOR_STRANDS`; a seed-time coverage
 * check reports any anchor lacking PASSED content (never a silent drop back to
 * fully-Socratic).
 */

import { WHOLE_NUMBER_ARITHMETIC_DOMAIN } from "./wholeNumberArithmeticGraph";
import { FRACTION_ARITHMETIC_DOMAIN } from "./fractionArithmeticGraph";
import { PROBABILITY_DOMAIN } from "./probabilityGraph";
import { GEOMETRY_MEASUREMENT_DOMAIN } from "./geometryMeasurementGraph";
import { RATIO_PROPORTION_PERCENT_DOMAIN } from "./ratioProportionPercentGraph";
import { INTEGERS_COORDINATES_DOMAIN } from "./integersCoordinatesGraph";
import { EARLY_ALGEBRA_DOMAIN } from "./earlyAlgebraGraph";
import { ALGEBRA_1_DOMAIN } from "./algebra1Graph";
import type { MultiStepSequenceSpec } from "../../lib/manipulative/types";

export type SeedInstructionAtom =
  | { kind: "story_hook"; hook: string; fromKey?: string; toKey?: string }
  | { kind: "micro_explain"; text: string }
  | {
      kind: "worked_example";
      strategyLabel: string;
      steps: string[];
      examplePrompt: string;
      exampleAnswer: string;
    }
  | {
      kind: "try_it";
      strategyLabel: string;
      steps: string[];
      examplePrompt: string;
      exampleAnswer: string;
      answerType?: "integer" | "decimal" | "fraction" | "expression" | "multipleChoice";
    }
  | { kind: "manipulative"; spec: string }
  | {
      kind: "video";
      provider: "youtube";
      videoId: string;
      startSec: number;
      endSec: number;
      captionText: string;
      sourceLabel: string;
      sourceUrl: string;
    };

export type SeedLaunchpad = {
  domain: string;
  strand: string;
  title: string;
  subtitle?: string;
  atoms: SeedInstructionAtom[];
};

function khanVideo(
  videoId: string,
  startSec: number,
  endSec: number,
  captionText: string,
): SeedInstructionAtom {
  return {
    kind: "video",
    provider: "youtube",
    videoId,
    startSec,
    endSec,
    captionText,
    sourceLabel: "Khan Academy",
    sourceUrl: `https://www.youtube.com/watch?v=${videoId}`,
  };
}

/** The designated anchor strands (doorways) covered by authored content. Every
 *  math strand across all seven domains has a Launchpad; the seed-time coverage
 *  check fails loudly if any anchor lacks PASSED content. */
export const INSTRUCTION_ANCHOR_STRANDS: { domain: string; strand: string }[] = [
  { domain: WHOLE_NUMBER_ARITHMETIC_DOMAIN, strand: "counting" },
  { domain: WHOLE_NUMBER_ARITHMETIC_DOMAIN, strand: "add-subtract" },
  { domain: WHOLE_NUMBER_ARITHMETIC_DOMAIN, strand: "place-value" },
  { domain: WHOLE_NUMBER_ARITHMETIC_DOMAIN, strand: "mult-divide" },
  { domain: WHOLE_NUMBER_ARITHMETIC_DOMAIN, strand: "number-theory" },
  { domain: FRACTION_ARITHMETIC_DOMAIN, strand: "concept" },
  { domain: FRACTION_ARITHMETIC_DOMAIN, strand: "operations" },
  { domain: FRACTION_ARITHMETIC_DOMAIN, strand: "equivalence" },
  { domain: FRACTION_ARITHMETIC_DOMAIN, strand: "comparison" },
  { domain: FRACTION_ARITHMETIC_DOMAIN, strand: "decimals" },
  { domain: GEOMETRY_MEASUREMENT_DOMAIN, strand: "angles" },
  { domain: GEOMETRY_MEASUREMENT_DOMAIN, strand: "area-perimeter" },
  { domain: GEOMETRY_MEASUREMENT_DOMAIN, strand: "volume" },
  { domain: GEOMETRY_MEASUREMENT_DOMAIN, strand: "coordinate-geometry" },
  { domain: INTEGERS_COORDINATES_DOMAIN, strand: "integer-operations" },
  { domain: INTEGERS_COORDINATES_DOMAIN, strand: "negatives-absvalue" },
  { domain: INTEGERS_COORDINATES_DOMAIN, strand: "rational-ordering" },
  { domain: RATIO_PROPORTION_PERCENT_DOMAIN, strand: "ratios-rates" },
  { domain: RATIO_PROPORTION_PERCENT_DOMAIN, strand: "proportional-reasoning" },
  { domain: RATIO_PROPORTION_PERCENT_DOMAIN, strand: "percent" },
  { domain: PROBABILITY_DOMAIN, strand: "chance" },
  { domain: PROBABILITY_DOMAIN, strand: "theoretical" },
  { domain: PROBABILITY_DOMAIN, strand: "experimental" },
  { domain: PROBABILITY_DOMAIN, strand: "compound" },
  { domain: PROBABILITY_DOMAIN, strand: "data-displays" },
  { domain: PROBABILITY_DOMAIN, strand: "center-spread" },
  { domain: EARLY_ALGEBRA_DOMAIN, strand: "patterns-sequences" },
  { domain: EARLY_ALGEBRA_DOMAIN, strand: "expressions-variables" },
  { domain: EARLY_ALGEBRA_DOMAIN, strand: "equations-1-2-step" },
  { domain: EARLY_ALGEBRA_DOMAIN, strand: "inequalities" },
  { domain: ALGEBRA_1_DOMAIN, strand: "linear-equations" },
  { domain: ALGEBRA_1_DOMAIN, strand: "linear-functions" },
  { domain: ALGEBRA_1_DOMAIN, strand: "systems" },
  { domain: ALGEBRA_1_DOMAIN, strand: "exponents-exponential" },
  { domain: ALGEBRA_1_DOMAIN, strand: "polynomials-factoring" },
  { domain: ALGEBRA_1_DOMAIN, strand: "quadratics" },
];

export const AUTHORED_LAUNCHPADS: SeedLaunchpad[] = [
  {
    domain: WHOLE_NUMBER_ARITHMETIC_DOMAIN,
    strand: "counting",
    title: "Counting tells how many",
    subtitle: "One number word for each thing",
    atoms: [
      {
        kind: "story_hook",
        hook: "Shepherds once dropped one pebble in a pouch for each sheep — one pebble, one sheep. That one-to-one match is what counting really is.",
      },
      {
        kind: "micro_explain",
        text: "Counting matches one number word to each object, in order. The last word you say tells the total — that idea is called cardinality.",
      },
      {
        kind: "manipulative",
        spec: JSON.stringify({
          id: "counting-guided",
          concept: "Counting in groups",
          title: "You counted in groups.",
          completeSummary:
            "Counting one at a time is slow. Seeing five and ten as whole groups is what makes bigger numbers quick.",
          steps: [
            {
              id: "counting-guided-explore",
              kind: "rekenrek",
              total: 20,
              startLeft: 0,
              concept: "The bead rack",
              prompt: "Push beads across and count them as they go.",
            },
            {
              id: "counting-guided-group-five",
              kind: "rekenrek",
              total: 10,
              startLeft: 0,
              goal: { type: "groupOf", value: 5 },
              concept: "A group of five",
              prompt:
                "Push 5 beads across. Notice you can see five without counting one by one.",
            },
            {
              id: "counting-guided-group-ten",
              kind: "rekenrek",
              total: 20,
              startLeft: 0,
              goal: { type: "groupOf", value: 10 },
              concept: "A group of ten",
              prompt: "Now push 10 across — that's two fives.",
            },
            {
              id: "counting-guided-your-turn",
              kind: "rekenrek",
              total: 20,
              startLeft: 0,
              goal: { type: "groupOf", value: 14 },
              concept: "Your turn",
              prompt: "Show 14 as a ten and four more.",
            },
          ],
        } satisfies MultiStepSequenceSpec),
      },
      {
        kind: "worked_example",
        strategyLabel: "Count each once, then stop",
        steps: [
          "Point to each block once, saying 1, 2, 3, 4.",
          "Do not skip a block or count one twice.",
          "The last number you said, 4, is how many there are.",
        ],
        examplePrompt: "You point to four blocks and say 1, 2, 3, 4. How many blocks are there?",
        exampleAnswer: "4",
      },
    ],
  },
  {
    domain: WHOLE_NUMBER_ARITHMETIC_DOMAIN,
    strand: "add-subtract",
    title: "Make a ten to add",
    subtitle: "Turn a hard fact into an easy one",
    atoms: [
      {
        kind: "story_hook",
        hook: "Your hands hold ten fingers for a reason — ten is the number our whole counting system leans on. Making a ten is the oldest shortcut there is.",
      },
      {
        kind: "micro_explain",
        text: "To add near ten, borrow from one number to complete a ten, then add what is left. Ten-plus-something is always easy.",
      },
      {
        kind: "manipulative",
        spec: JSON.stringify({
          id: "add-subtract-guided",
          concept: "Make a ten to add",
          title: "You made a ten.",
          completeSummary:
            "Making a ten first turns a hard fact into an easy one — 9 + 7 becomes 10 + 6.",
          steps: [
            {
              id: "add-subtract-guided-explore",
              kind: "rekenrek",
              total: 20,
              startLeft: 0,
              concept: "The bead rack",
              prompt:
                "Push some beads across. They move in trains — see how they group in fives.",
            },
            {
              id: "add-subtract-guided-make-seven",
              kind: "rekenrek",
              total: 10,
              startLeft: 0,
              goal: { type: "groupOf", value: 7 },
              concept: "Making a number",
              prompt: "Push exactly 7 beads across.",
            },
            {
              id: "add-subtract-guided-ten-first",
              kind: "rekenrek",
              total: 15,
              startLeft: 0,
              goal: { type: "groupOf", value: 10 },
              concept: "Ten first",
              prompt: "Now make a group of exactly 10. What's left over?",
            },
            {
              id: "add-subtract-guided-eight-plus-five",
              kind: "rekenrek",
              total: 13,
              startLeft: 0,
              goal: { type: "groupOf", value: 10 },
              concept: "8 + 5",
              prompt: "8 and 5 make 13 beads. Push 10 across — now you can see 10 and 3.",
            },
            {
              id: "add-subtract-guided-your-turn",
              kind: "rekenrek",
              total: 16,
              startLeft: 0,
              goal: { type: "groupOf", value: 10 },
              concept: "Your turn",
              prompt: "9 + 7. Make a ten.",
            },
          ],
        } satisfies MultiStepSequenceSpec),
      },
      {
        kind: "worked_example",
        strategyLabel: "Fill up to ten, then add the rest",
        steps: [
          "Start with 8 + 5.",
          "Take 2 from the 5 to turn 8 into 10.",
          "That leaves 3 behind.",
          "Now add the easy way: 10 + 3 = 13.",
        ],
        examplePrompt: "Use make-a-ten to add 8 + 5.",
        exampleAnswer: "13",
      },
    ],
  },
  {
    domain: WHOLE_NUMBER_ARITHMETIC_DOMAIN,
    strand: "place-value",
    title: "Bundle into tens",
    subtitle: "Why 47 means 4 tens and 7 ones",
    atoms: [
      {
        kind: "story_hook",
        hook: "Long ago, traders tied sticks into bundles of ten to count huge herds fast. Our number system still works that way: a digit's spot tells you how big a bundle it counts.",
      },
      {
        kind: "micro_explain",
        text: "In a two-digit number, the left digit counts tens (bundles of ten) and the right digit counts ones (loose units). So 47 is 4 bundles of ten plus 7 loose, which is 40 + 7.",
      },
      {
        kind: "manipulative",
        spec: JSON.stringify({
          id: "place-value-guided",
          concept: "A number is its parts",
          title: "You built it out of its parts.",
          completeSummary:
            "Every number is hundreds, tens and ones stacked together — and sliding a digit one place to the left makes it ten times bigger.",
          steps: [
            {
              id: "place-value-guided-explore",
              kind: "placeValue",
              mode: "buildNumber",
              places: [100, 10, 1],
              start: [0, 0, 0],
              concept: "Base-ten bundles",
              prompt: "Add and remove bundles. Watch the number change.",
            },
            {
              id: "place-value-guided-build-thirty-four",
              kind: "placeValue",
              mode: "buildNumber",
              places: [100, 10, 1],
              start: [0, 0, 0],
              goal: { type: "buildValue", value: 34 },
              concept: "Tens and ones",
              prompt: "Build 34.",
            },
            {
              id: "place-value-guided-expanded-form",
              kind: "placeValue",
              mode: "expandedForm",
              places: [100, 10, 1],
              start: [0, 0, 0],
              goal: { type: "buildValue", value: 437 },
              concept: "Expanded form",
              prompt: "Build 437. How many hundreds, tens and ones?",
            },
            {
              id: "place-value-guided-your-turn",
              kind: "placeValue",
              mode: "placeShift",
              places: [1000, 100, 10, 1],
              start: [0, 0, 4, 0],
              goal: { type: "shiftTo", value: 400 },
              concept: "Your turn",
              prompt: "Make 40 ten times bigger.",
            },
          ],
        } satisfies MultiStepSequenceSpec),
      },
      {
        kind: "worked_example",
        strategyLabel: "Split into tens and ones",
        steps: [
          "Take the number 63.",
          "The left digit 6 is in the tens place: 6 bundles of ten = 60.",
          "The right digit 3 is in the ones place: 3 loose ones = 3.",
          "Put the parts back together: 60 + 3 = 63.",
        ],
        examplePrompt: "How many tens and ones are in 63?",
        exampleAnswer: "6 tens and 3 ones (60 + 3)",
      },
    ],
  },
  {
    domain: WHOLE_NUMBER_ARITHMETIC_DOMAIN,
    strand: "mult-divide",
    title: "Multiplication is equal groups",
    subtitle: "Jump instead of counting one at a time",
    atoms: [
      {
        kind: "story_hook",
        hook: "A spider has 8 legs. Four spiders? Instead of counting one leg at a time, you jump by eights. That leap is exactly what multiplication is for.",
      },
      {
        kind: "micro_explain",
        text: "Multiplying counts equal groups. 4 x 3 means 4 groups with 3 in each. You can skip-count the groups: 3, 6, 9, 12, and the last count is the total.",
      },
      {
        kind: "manipulative",
        spec: JSON.stringify({
          id: "mult-divide-guided",
          concept: "Rows and columns",
          title: "You found every rectangle.",
          completeSummary:
            "3 rows of 4 and 4 rows of 3 hold the same 12 eggs — and a square is the rectangle whose sides match.",
          steps: [
            {
              id: "mult-divide-guided-explore",
              kind: "array",
              rows: 2,
              cols: 3,
              maxRows: 10,
              maxCols: 10,
              theme: { fill: { label: "egg" } },
              concept: "Building rectangles",
              prompt: "Drag to change the rows and columns. Count the eggs each time.",
            },
            {
              id: "mult-divide-guided-equal-groups",
              kind: "array",
              rows: 1,
              cols: 1,
              maxRows: 10,
              maxCols: 10,
              theme: { fill: { label: "egg" } },
              goal: { type: "sideEqualsWithProduct", side: 3, product: 12 },
              concept: "Equal groups",
              prompt: "Build 3 rows of 4.",
            },
            {
              id: "mult-divide-guided-another-way",
              kind: "array",
              rows: 1,
              cols: 1,
              maxRows: 12,
              maxCols: 12,
              theme: { fill: { label: "egg" } },
              goal: { type: "productEquals", value: 12 },
              concept: "Another way",
              prompt: "Make 12 eggs a different way.",
            },
            {
              id: "mult-divide-guided-your-turn",
              kind: "array",
              rows: 1,
              cols: 1,
              maxRows: 10,
              maxCols: 10,
              theme: { fill: { label: "egg" } },
              goal: { type: "squareEquals", value: 16 },
              concept: "Your turn",
              prompt: "Build a square with 16 eggs.",
            },
          ],
        } satisfies MultiStepSequenceSpec),
      },
      {
        kind: "worked_example",
        strategyLabel: "Count equal groups by skip-counting",
        steps: [
          "Read 5 x 2 as 5 groups of 2.",
          "Skip-count by 2 five times: 2, 4, 6, 8, 10.",
          "The last count you reach is the total: 10.",
        ],
        examplePrompt: "What is 5 x 2, using equal groups?",
        exampleAnswer: "10",
      },
    ],
  },
  {
    domain: WHOLE_NUMBER_ARITHMETIC_DOMAIN,
    strand: "number-theory",
    title: "Factors and multiples",
    subtitle: "Two ways of looking at a number",
    atoms: [
      {
        kind: "story_hook",
        hook: "Cicadas emerge every 13 or 17 years, both prime. Predators on shorter cycles can almost never line up with them. Number theory is a survival strategy.",
      },
      {
        kind: "micro_explain",
        text: "A factor divides a number evenly. A multiple is what you reach by counting up by a number. 3 and 4 are factors of 12 because 3 x 4 = 12; and 12 is a multiple of 3 because 3, 6, 9, 12.",
      },
      {
        kind: "manipulative",
        spec: JSON.stringify({
          id: "number-theory-guided",
          concept: "Which rectangles can you build?",
          title: "You built the factors.",
          completeSummary:
            "A factor is a side length a rectangle can actually have. A square number is the one that makes a square.",
          steps: [
            {
              id: "number-theory-guided-explore",
              kind: "array",
              rows: 2,
              cols: 5,
              maxRows: 12,
              maxCols: 12,
              theme: { fill: { label: "acorn" } },
              concept: "Rectangles of acorns",
              prompt:
                "Change the rows and columns. Which totals can make more than one rectangle?",
            },
            {
              id: "number-theory-guided-factor-three",
              kind: "array",
              rows: 1,
              cols: 1,
              maxRows: 12,
              maxCols: 12,
              theme: { fill: { label: "acorn" } },
              goal: { type: "sideEqualsWithProduct", side: 3, product: 12 },
              concept: "A factor",
              prompt: "Build 12 acorns with 3 in each row. 3 is a factor of 12.",
            },
            {
              id: "number-theory-guided-factor-five",
              kind: "array",
              rows: 1,
              cols: 1,
              maxRows: 12,
              maxCols: 12,
              theme: { fill: { label: "acorn" } },
              goal: { type: "sideEqualsWithProduct", side: 5, product: 15 },
              concept: "Another factor",
              prompt: "Now show that 5 is a factor of 15.",
            },
            {
              id: "number-theory-guided-your-turn",
              kind: "array",
              rows: 1,
              cols: 1,
              maxRows: 12,
              maxCols: 12,
              theme: { fill: { label: "acorn" } },
              goal: { type: "squareEquals", value: 36 },
              concept: "Your turn",
              prompt: "Build 36 as a perfect square.",
            },
          ],
        } satisfies MultiStepSequenceSpec),
      },
      {
        kind: "worked_example",
        strategyLabel: "List the factor pairs",
        steps: [
          "Find every pair of whole numbers that multiplies to 12.",
          "1 x 12, then 2 x 6, then 3 x 4.",
          "Collect every number you used: 1, 2, 3, 4, 6, 12.",
        ],
        examplePrompt: "What are all the factors of 12?",
        exampleAnswer: "1, 2, 3, 4, 6, 12",
      },
    ],
  },
  {
    domain: FRACTION_ARITHMETIC_DOMAIN,
    strand: "concept",
    title: "A fraction is equal parts",
    subtitle: "What the top and bottom each tell you",
    atoms: [
      {
        kind: "story_hook",
        hook: "Split one pizza fairly among friends and you have invented fractions. Every equal slice is a piece of one whole — that is all a fraction really is.",
      },
      {
        kind: "micro_explain",
        text: "A fraction names equal parts of one whole. In 3/4, the bottom number 4 says the whole is cut into 4 equal parts, and the top number 3 says you have 3 of them.",
      },
      khanVideo(
        "jgWqSjgMAtw",
        0,
        255,
        "Fractions tell how many equal pieces you have out of a whole.",
      ),
      {
        kind: "manipulative",
        spec: JSON.stringify({
          id: "concept-guided",
          concept: "Equal parts of a whole",
          title: "You cut a whole into equal parts.",
          completeSummary:
            "The bottom number says how many equal pieces the whole was cut into. The top number says how many of them you took.",
          steps: [
            {
              id: "concept-guided-explore",
              kind: "partition",
              discs: [{ parts: 4, shaded: 0 }],
              adjustable: ["parts", "shaded"],
              concept: "Cutting a whole",
              prompt:
                "Cut the circle into different numbers of pieces. Shade some. Watch what changes.",
            },
            {
              id: "concept-guided-one-half",
              kind: "partition",
              discs: [{ parts: 2, shaded: 0 }],
              adjustable: ["shaded"],
              goal: { type: "shadedFractionEquals", disc: 0, value: 0.5 },
              concept: "One half",
              prompt: "Shade one half.",
            },
            {
              id: "concept-guided-three-quarters",
              kind: "partition",
              discs: [{ parts: 4, shaded: 0 }],
              adjustable: ["shaded"],
              goal: { type: "shadedFractionEquals", disc: 0, value: 0.75 },
              concept: "Three quarters",
              prompt: "Shade three quarters.",
            },
            {
              id: "concept-guided-thirds",
              kind: "partition",
              discs: [{ parts: 3, shaded: 0 }],
              adjustable: ["shaded"],
              goal: { type: "shadedFractionEquals", disc: 0, value: 2 / 3 },
              concept: "Thirds",
              prompt: "Shade two thirds.",
            },
            {
              id: "concept-guided-your-turn",
              kind: "partition",
              discs: [{ parts: 4, shaded: 0 }],
              adjustable: ["parts", "shaded"],
              goal: {
                type: "shadedFractionEquals",
                disc: 0,
                value: 0.5,
                requireParts: 8,
              },
              concept: "Your turn",
              prompt: "Show one half — but using eighths.",
            },
          ],
        } satisfies MultiStepSequenceSpec),
      },
      {
        kind: "worked_example",
        strategyLabel: "Read the bottom, then the top",
        steps: [
          "Look at 2/5.",
          "The bottom, 5, means the whole is split into 5 equal parts.",
          "The top, 2, means you have 2 of those parts.",
          "So 2/5 is two of five equal pieces.",
        ],
        examplePrompt: "What does 2/5 mean?",
        exampleAnswer: "2 of 5 equal parts",
      },
    ],
  },
  {
    domain: FRACTION_ARITHMETIC_DOMAIN,
    strand: "operations",
    title: "Add fractions with the same bottom",
    subtitle: "Same-size parts just add up",
    atoms: [
      {
        kind: "story_hook",
        hook: "Two slices of a seven-slice pie, plus three more slices of the same pie — you do not need new math, just add the slices you already have.",
      },
      {
        kind: "micro_explain",
        text: "When two fractions share a denominator, the parts are the same size, so you just add how many you have. Keep the bottom, add the tops.",
      },
      {
        kind: "manipulative",
        spec: JSON.stringify({
          id: "operations-guided",
          concept: "Same-size parts add up",
          title: "You added the parts up.",
          completeSummary:
            "When the bottoms match, the pieces are all the same size — so you just count how many you have. Two sevenths and three more sevenths make five sevenths.",
          steps: [
            {
              id: "operations-guided-explore",
              kind: "partition",
              discs: [{ parts: 7, shaded: 0 }],
              adjustable: ["shaded"],
              concept: "Sevenths",
              prompt:
                "Shade the sevenths one at a time. Every piece is the same size — watch the count climb.",
            },
            {
              id: "operations-guided-two-sevenths",
              kind: "partition",
              discs: [{ parts: 7, shaded: 0 }],
              adjustable: ["shaded"],
              goal: { type: "shadedFractionEquals", disc: 0, value: 2 / 7 },
              concept: "Two sevenths",
              prompt: "Shade 2 of the 7 parts — that's two sevenths.",
            },
            {
              id: "operations-guided-add-three",
              kind: "partition",
              discs: [{ parts: 7, shaded: 2 }],
              adjustable: ["shaded"],
              goal: { type: "shadedFractionEquals", disc: 0, value: 5 / 7 },
              concept: "Add three more",
              prompt:
                "Two sevenths are already shaded. Shade 3 more: keep the bottom, add the tops — 2 + 3 = 5 sevenths.",
            },
            {
              id: "operations-guided-your-turn",
              kind: "partition",
              discs: [{ parts: 5, shaded: 1 }],
              adjustable: ["shaded"],
              goal: { type: "shadedFractionEquals", disc: 0, value: 4 / 5 },
              concept: "Your turn",
              prompt: "One fifth is shaded. Add 3 more fifths to make four fifths.",
            },
          ],
        } satisfies MultiStepSequenceSpec),
      },
      {
        kind: "worked_example",
        strategyLabel: "Keep the bottom, add the tops",
        steps: [
          "Add 2/7 + 3/7.",
          "The bottoms match (7), so the parts are the same size.",
          "Add the tops: 2 + 3 = 5.",
          "Keep the bottom the same: 5/7.",
        ],
        examplePrompt: "What is 2/7 + 3/7?",
        exampleAnswer: "5/7",
      },
    ],
  },

  // ── Fraction arithmetic: remaining strands ────────────────────────────────
  {
    domain: FRACTION_ARITHMETIC_DOMAIN,
    strand: "equivalence",
    title: "Different names, same amount",
    subtitle: "Cut into more pieces, same total",
    atoms: [
      {
        kind: "story_hook",
        hook: "Cut a cake into 2 and take 1 piece, or cut it into 4 and take 2 — your plate holds the same amount. 1/2 and 2/4 are two names for one quantity.",
      },
      {
        kind: "micro_explain",
        text: "Multiplying the top and bottom by the same number cuts each part into more, smaller pieces without changing the total. That is why 1/2 = 2/4 = 3/6: equal values, different names.",
      },
      {
        kind: "manipulative",
        spec: JSON.stringify({
          id: "equivalence-guided",
          concept: "Same amount, different cuts",
          title: "You matched them.",
          completeSummary:
            "One half and two quarters cover exactly the same amount of the circle — different cuts, same size piece.",
          steps: [
            {
              id: "equivalence-guided-explore",
              kind: "partition",
              discs: [
                { parts: 2, shaded: 1 },
                { parts: 4, shaded: 1 },
              ],
              adjustable: ["parts", "shaded"],
              concept: "Two wholes",
              prompt: "Change either circle. When do they look like the same amount?",
            },
            {
              id: "equivalence-guided-halves-and-quarters",
              kind: "partition",
              discs: [
                { parts: 2, shaded: 1 },
                { parts: 4, shaded: 0 },
              ],
              adjustable: ["shaded"],
              goal: { type: "discsEqualShadedArea" },
              concept: "Halves and quarters",
              prompt: "The first circle shows one half. Shade the second to match it.",
            },
            {
              id: "equivalence-guided-thirds-and-sixths",
              kind: "partition",
              discs: [
                { parts: 3, shaded: 1 },
                { parts: 6, shaded: 0 },
              ],
              adjustable: ["shaded"],
              goal: { type: "discsEqualShadedArea" },
              concept: "Thirds and sixths",
              prompt: "Match one third using sixths.",
            },
            {
              id: "equivalence-guided-your-turn",
              kind: "partition",
              discs: [
                { parts: 4, shaded: 3 },
                { parts: 8, shaded: 0 },
              ],
              adjustable: ["parts", "shaded"],
              goal: { type: "discsEqualShadedArea" },
              concept: "Your turn",
              prompt: "Make the second circle equal to three quarters.",
            },
          ],
        } satisfies MultiStepSequenceSpec),
      },
      {
        kind: "worked_example",
        strategyLabel: "Multiply top and bottom by the same number",
        steps: [
          "Start with 1/2.",
          "Multiply both the top and the bottom by 3.",
          "Top: 1 x 3 = 3. Bottom: 2 x 3 = 6.",
          "So 1/2 = 3/6, the same amount in more pieces.",
        ],
        examplePrompt: "Write a fraction equal to 1/2 with a bottom of 6.",
        exampleAnswer: "3/6",
      },
    ],
  },
  {
    domain: FRACTION_ARITHMETIC_DOMAIN,
    strand: "comparison",
    title: "Which fraction is bigger?",
    subtitle: "Make the parts the same size first",
    atoms: [
      {
        kind: "story_hook",
        hook: "One chocolate bar snapped into 3, another into 8. A third of a bar beats an eighth every time — bigger pieces win, even when the bottom number is smaller.",
      },
      {
        kind: "micro_explain",
        text: "To compare fractions, make the parts the same size by rewriting them over a common bottom. Then whichever has more parts on top is larger. Same top instead? Fewer pieces means each is bigger.",
      },
      {
        kind: "manipulative",
        spec: JSON.stringify({
          id: "comparison-guided",
          concept: "Where does it sit?",
          title: "You placed every one.",
          completeSummary:
            "Every fraction has its own spot between 0 and 1. Once you can see where two of them sit, you can tell which is bigger without doing any arithmetic.",
          steps: [
            {
              id: "comparison-guided-explore",
              kind: "numberline",
              min: 0,
              max: 1,
              tickStep: 0.5,
              start: 0,
              markers: [
                { value: 0, label: "0" },
                { value: 1, label: "1" },
              ],
              concept: "The line from 0 to 1",
              prompt: "Slide the marker. Where does half feel right?",
            },
            {
              id: "comparison-guided-one-half",
              kind: "numberline",
              min: 0,
              max: 1,
              tickStep: 0.25,
              snap: 0.25,
              start: 0,
              goal: { type: "placeFraction", num: 1, den: 2 },
              concept: "One half",
              prompt: "Put the marker on 1/2.",
            },
            {
              id: "comparison-guided-three-quarters",
              kind: "numberline",
              min: 0,
              max: 1,
              tickStep: 0.25,
              snap: 0.25,
              start: 0,
              goal: { type: "placeFraction", num: 3, den: 4 },
              concept: "Three quarters",
              prompt: "Put the marker on 3/4.",
            },
            {
              id: "comparison-guided-your-turn",
              kind: "numberline",
              min: 0,
              max: 1,
              tickStep: 1,
              start: 0,
              goal: { type: "placeFraction", num: 2, den: 3, tolerance: 0.04 },
              concept: "Your turn",
              prompt: "No ticks to help this time. Where does 2/3 go?",
            },
          ],
        } satisfies MultiStepSequenceSpec),
      },
      {
        kind: "worked_example",
        strategyLabel: "Compare over a common bottom",
        steps: [
          "Compare 2/3 and 3/5.",
          "Rewrite both over a shared bottom of 15: 2/3 = 10/15 and 3/5 = 9/15.",
          "The parts are the same size now, so compare tops: 10 beats 9.",
          "So 2/3 is greater than 3/5.",
        ],
        examplePrompt: "Which is greater, 2/3 or 3/5?",
        exampleAnswer: "2/3",
      },
    ],
  },
  {
    domain: FRACTION_ARITHMETIC_DOMAIN,
    strand: "decimals",
    title: "Decimals are just tenths and hundredths",
    subtitle: "Place value keeps going past the ones",
    atoms: [
      {
        kind: "story_hook",
        hook: "Money already taught you decimals. 75 cents is 7 dimes and 5 pennies — seven tenths and five hundredths of a dollar. Place value simply keeps going past the ones.",
      },
      {
        kind: "micro_explain",
        text: "A decimal point marks where the whole numbers end. The first spot after it counts tenths, the next counts hundredths. So 0.75 is 7 tenths plus 5 hundredths, the same as 75/100.",
      },
      {
        kind: "manipulative",
        spec: JSON.stringify({
          id: "decimals-guided",
          concept: "The same point, two names",
          title: "You found the same point twice.",
          completeSummary:
            "A decimal and a fraction can name the identical spot on the line — 0.5 and one half are the same place.",
          steps: [
            {
              id: "decimals-guided-explore",
              kind: "numberline",
              min: 0,
              max: 1,
              tickStep: 0.1,
              start: 0,
              markers: [
                { value: 0, label: "0" },
                { value: 1, label: "1" },
              ],
              concept: "Tenths",
              prompt: "Slide along and watch the tenths go by.",
            },
            {
              id: "decimals-guided-half",
              kind: "numberline",
              min: 0,
              max: 1,
              tickStep: 0.1,
              snap: 0.1,
              start: 0,
              goal: { type: "placeAt", value: 0.5 },
              concept: "A half is 0.5",
              prompt: "Put the marker on 0.5. That's the same place as one half.",
            },
            {
              id: "decimals-guided-seven-tenths",
              kind: "numberline",
              min: 0,
              max: 1,
              tickStep: 0.1,
              snap: 0.1,
              start: 0,
              goal: { type: "placeAt", value: 0.7 },
              concept: "Seven tenths",
              prompt: "Now put it on 0.7.",
            },
            {
              id: "decimals-guided-your-turn",
              kind: "numberline",
              min: 0,
              max: 1,
              tickStep: 0.5,
              start: 0,
              goal: { type: "placeAt", value: 0.25, tolerance: 0.04 },
              concept: "Your turn",
              prompt: "Fewer ticks this time. Where does 0.25 go?",
            },
          ],
        } satisfies MultiStepSequenceSpec),
      },
      {
        kind: "worked_example",
        strategyLabel: "Read each place after the point",
        steps: [
          "Take 0.42.",
          "The 4 sits in the tenths place: 4/10.",
          "The 2 sits in the hundredths place: 2/100.",
          "Together that is 42 hundredths, written 42/100.",
        ],
        examplePrompt: "Write 0.42 as a fraction.",
        exampleAnswer: "42/100",
      },
    ],
  },

  // ── Geometry & measurement ────────────────────────────────────────────────
  {
    domain: GEOMETRY_MEASUREMENT_DOMAIN,
    strand: "angles",
    title: "An angle measures a turn",
    subtitle: "How far you turn, not how long the sides",
    atoms: [
      {
        kind: "story_hook",
        hook: "A clock's hands sweep angles all day. From 12 to 3 is a quarter turn, ninety degrees. The angle is not about how long the hands are, only how far they turned.",
      },
      {
        kind: "micro_explain",
        text: "An angle measures the turn between two rays from a shared point. A full turn is 360 degrees, a half turn 180, a square corner 90. Making the sides longer does not change the angle.",
      },
      {
        kind: "manipulative",
        spec: JSON.stringify({
          id: "angles-guided",
          concept: "Opening an angle",
          title: "You built the angles.",
          completeSummary:
            "An angle measures how far the ray turned, not how long it is. 90° is a square corner, and everything else is measured against it.",
          steps: [
            {
              id: "angles-guided-explore",
              kind: "protractor",
              startDeg: 20,
              concept: "The turning ray",
              prompt: "Swing the ray around and watch the number on the scale change.",
            },
            {
              id: "angles-guided-right-angle",
              kind: "protractor",
              startDeg: 10,
              goal: { type: "constructAngle", targetDeg: 90 },
              concept: "A right angle",
              prompt: "Open it to 90° — a square corner.",
            },
            {
              id: "angles-guided-half-right-angle",
              kind: "protractor",
              startDeg: 100,
              goal: { type: "constructAngle", targetDeg: 45 },
              concept: "Half of a right angle",
              prompt: "Now make 45°. That's half a square corner.",
            },
            {
              id: "angles-guided-your-turn",
              kind: "protractor",
              startDeg: 20,
              goal: { type: "constructAngle", targetDeg: 135 },
              concept: "Your turn",
              prompt: "Open it past square, to 135°.",
            },
          ],
        } satisfies MultiStepSequenceSpec),
      },
      {
        kind: "worked_example",
        strategyLabel: "Angles on a straight line make 180",
        steps: [
          "Two angles sit together on a straight line, so they total 180 degrees.",
          "One of them measures 110 degrees.",
          "Subtract to find the other: 180 - 110 = 70.",
          "So the missing angle is 70 degrees.",
        ],
        examplePrompt: "Two angles rest on a straight line; one is 110 degrees. What is the other?",
        exampleAnswer: "70 degrees",
      },
    ],
  },
  {
    domain: GEOMETRY_MEASUREMENT_DOMAIN,
    strand: "area-perimeter",
    title: "Perimeter is the fence, area is the field",
    subtitle: "Around the edge versus across the inside",
    atoms: [
      {
        kind: "story_hook",
        hook: "To fence a garden you measure its edge; to lay grass you cover its inside. Same rectangle, two very different questions — that is perimeter versus area.",
      },
      {
        kind: "micro_explain",
        text: "Perimeter is the distance around the edge, so you add up the side lengths. Area is the space inside, counted in unit squares, so for a rectangle you multiply length by width.",
      },
      {
        kind: "manipulative",
        spec: JSON.stringify({
          id: "area-perimeter-guided",
          concept: "Same fence, different field",
          title: "Same fence, different field.",
          completeSummary:
            "The fence never changed length — but a square field holds the most. Perimeter and area are two different questions.",
          steps: [
            {
              id: "area-perimeter-guided-explore",
              kind: "areaPerimeter",
              perimeter: 20,
              startWidth: 3,
              theme: { fill: { label: "capybara" } },
              concept: "A fence of fixed length",
              prompt:
                "Drag to reshape the field. The fence stays the same length — watch how many capybaras fit.",
            },
            {
              id: "area-perimeter-guided-hitting-a-size",
              kind: "areaPerimeter",
              perimeter: 20,
              startWidth: 1,
              theme: { fill: { label: "capybara" } },
              goal: { type: "areaEquals", value: 21 },
              concept: "Hitting a size",
              prompt: "Make the field hold exactly 21 capybaras.",
            },
            {
              id: "area-perimeter-guided-roomiest-field",
              kind: "areaPerimeter",
              perimeter: 24,
              startWidth: 2,
              theme: { fill: { label: "capybara" } },
              goal: { type: "maxArea" },
              concept: "The roomiest field",
              prompt: "Same fence. Fit as many capybaras as you possibly can.",
            },
            {
              id: "area-perimeter-guided-your-turn",
              kind: "areaPerimeter",
              perimeter: 16,
              startWidth: 1,
              theme: { fill: { label: "capybara" } },
              goal: { type: "maxArea" },
              concept: "Your turn",
              prompt: "A shorter fence this time. Find the roomiest field.",
            },
          ],
        } satisfies MultiStepSequenceSpec),
      },
      {
        kind: "worked_example",
        strategyLabel: "Multiply the sides to get area",
        steps: [
          "A rectangle is 5 long and 3 wide.",
          "Area fills the inside: length x width.",
          "Multiply: 5 x 3 = 15 square units.",
          "(Perimeter would instead add the edges: 5 + 3 + 5 + 3 = 16.)",
        ],
        examplePrompt: "What is the area of a 5 by 3 rectangle?",
        exampleAnswer: "15 square units",
      },
    ],
  },
  {
    domain: GEOMETRY_MEASUREMENT_DOMAIN,
    strand: "volume",
    title: "Volume fills a box with cubes",
    subtitle: "Fill a box, layer by layer",
    atoms: [
      {
        kind: "story_hook",
        hook: "Stacking sugar cubes into a box, you fill one floor layer, then stack more layers up. Count all the cubes and you have the volume — space measured in cubes, not squares.",
      },
      {
        kind: "micro_explain",
        text: "Volume is the space inside a solid, counted in unit cubes. For a rectangular box, one floor layer holds length x width cubes, and you stack height layers, so volume is length x width x height.",
      },
      {
        kind: "video",
        provider: "youtube",
        videoId: "I9efKVtLCf4",
        startSec: 0,
        endSec: 116,
        captionText:
          "Cubes stack up to fill a box — watch how the three sides multiply into a volume.",
        sourceLabel: "Khan Academy",
        sourceUrl: "https://www.youtube.com/watch?v=I9efKVtLCf4",
      },
      {
        kind: "try_it",
        strategyLabel: "Multiply the three dimensions",
        examplePrompt: "A box is 5 by 3 by 2. How many unit cubes fill it?",
        steps: [
          "A box is 5 by 3 by 2.",
          "One layer is 5 × 3 = 15 cubes.",
          "There are 2 layers.",
          "So the volume is 15 × 2 = 30.",
        ],
        exampleAnswer: "30",
        answerType: "integer",
      },
      {
        kind: "worked_example",
        strategyLabel: "Multiply the three dimensions",
        steps: [
          "A box is 4 long, 3 wide, and 2 tall.",
          "One floor layer holds 4 x 3 = 12 cubes.",
          "Stack 2 such layers to the top.",
          "Multiply: 12 x 2 = 24 cubic units.",
        ],
        examplePrompt: "What is the volume of a 4 by 3 by 2 box?",
        exampleAnswer: "24 cubic units",
      },
    ],
  },
  {
    domain: GEOMETRY_MEASUREMENT_DOMAIN,
    strand: "coordinate-geometry",
    title: "A grid gives every point an address",
    subtitle: "Two numbers name any point",
    atoms: [
      {
        kind: "story_hook",
        hook: "A city map finds any corner from two numbers: blocks east, then blocks north. Coordinates do the same for the plane — an ordered pair is just an address.",
      },
      {
        kind: "micro_explain",
        text: "A coordinate pair (x, y) locates a point: x tells how far right along the horizontal axis, y how far up the vertical axis. Order matters, so (3, 2) and (2, 3) land on different spots.",
      },
      {
        kind: "manipulative",
        spec: JSON.stringify({
          id: "coordinate-geometry-guided",
          concept: "Finding a spot with two numbers",
          title: "You found it with two numbers.",
          completeSummary:
            "The first number goes across and the second goes up, always in that order — swap them and you land somewhere else.",
          steps: [
            {
              id: "coordinate-geometry-guided-explore",
              kind: "coordinatePlane",
              xMin: 0,
              xMax: 10,
              yMin: 0,
              yMax: 10,
              gridStep: 1,
              draggable: [{ start: { x: 0, y: 0 } }],
              concept: "Across, then up",
              prompt: "Drag the point around. Watch both numbers change.",
            },
            {
              id: "coordinate-geometry-guided-across-first",
              kind: "coordinatePlane",
              xMin: 0,
              xMax: 10,
              yMin: 0,
              yMax: 10,
              gridStep: 1,
              draggable: [{ start: { x: 0, y: 0 } }],
              goal: { type: "placePoint", x: 3, y: 4 },
              concept: "Across first",
              prompt: "Put the point at (3, 4) — across 3, then up 4.",
            },
            {
              id: "coordinate-geometry-guided-order-matters",
              kind: "coordinatePlane",
              xMin: 0,
              xMax: 10,
              yMin: 0,
              yMax: 10,
              gridStep: 1,
              draggable: [{ start: { x: 0, y: 0 } }],
              goal: { type: "placePoint", x: 4, y: 3 },
              concept: "Order matters",
              prompt: "Now put it at (4, 3). Notice that's a different spot.",
            },
            {
              id: "coordinate-geometry-guided-your-turn",
              kind: "coordinatePlane",
              xMin: 0,
              xMax: 10,
              yMin: 0,
              yMax: 10,
              gridStep: 1,
              draggable: [{ start: { x: 0, y: 0 } }],
              goal: { type: "placePoint", x: 6, y: 2 },
              concept: "Your turn",
              prompt: "Last one, on your own: put the point at (6, 2).",
            },
          ],
        } satisfies MultiStepSequenceSpec),
      },
      {
        kind: "worked_example",
        strategyLabel: "Go across, then up",
        steps: [
          "Plot the point (2, 5).",
          "Start at the origin, (0, 0), the corner where the two axes meet.",
          "The first number is across: move right 2 along the x-axis.",
          "The second number is up: move up 5, then mark the point.",
        ],
        examplePrompt: "Plotting (2, 5), how far do you go right, then up?",
        exampleAnswer: "2 right and 5 up",
      },
    ],
  },

  // ── Integers & coordinates ────────────────────────────────────────────────
  {
    domain: INTEGERS_COORDINATES_DOMAIN,
    strand: "integer-operations",
    title: "Adding a negative moves left",
    subtitle: "Left for less, right for more",
    atoms: [
      {
        kind: "story_hook",
        hook: "A thermometer at 5 degrees dropping 8 degrees lands below zero. The number line runs both ways, and a negative is just a set of steps to the left.",
      },
      {
        kind: "micro_explain",
        text: "On a number line, adding a positive moves right and adding a negative moves left. To work out 5 + (-8), start at 5 and step 8 to the left, crossing zero into the negatives.",
      },
      khanVideo(
        "3CKpidALDEg",
        0,
        300,
        "Adding a negative means hopping left on the number line.",
      ),
      {
        kind: "manipulative",
        spec: JSON.stringify({
          id: "integer-operations-guided",
          concept: "Hopping past zero",
          title: "You hopped straight past zero.",
          completeSummary:
            "The line doesn't stop at zero — it keeps going the other way, with the same size steps. That's what a negative number is.",
          steps: [
            {
              id: "integer-operations-guided-explore",
              kind: "numberline",
              min: -10,
              max: 10,
              tickStep: 5,
              snap: 1,
              start: 0,
              markers: [{ value: 0, label: "0" }],
              concept: "Both sides of zero",
              prompt: "Slide along the line. Notice what happens left of zero.",
            },
            {
              id: "integer-operations-guided-forward",
              kind: "numberline",
              min: -10,
              max: 10,
              tickStep: 5,
              snap: 1,
              start: 0,
              goal: { type: "placeAt", value: 3 },
              concept: "Forward",
              prompt: "Start at 0. Hop forward 3.",
            },
            {
              id: "integer-operations-guided-backward",
              kind: "numberline",
              min: -10,
              max: 10,
              tickStep: 5,
              snap: 1,
              start: 0,
              goal: { type: "placeAt", value: -2 },
              concept: "Backward past zero",
              prompt: "Start at 0. Hop back 2.",
            },
            {
              id: "integer-operations-guided-three-minus-five",
              kind: "numberline",
              min: -10,
              max: 10,
              tickStep: 5,
              snap: 1,
              start: 3,
              goal: { type: "placeAt", value: -2 },
              concept: "3 − 5",
              prompt: "You're on 3. Hop back 5 — you'll go through zero.",
            },
            {
              id: "integer-operations-guided-your-turn",
              kind: "numberline",
              min: -10,
              max: 10,
              tickStep: 5,
              snap: 1,
              start: -4,
              goal: { type: "placeAt", value: 3 },
              concept: "Your turn",
              prompt: "You're on −4. Hop forward 7.",
            },
          ],
        } satisfies MultiStepSequenceSpec),
      },
      {
        kind: "worked_example",
        strategyLabel: "Step along the number line",
        steps: [
          "Work out 5 + (-8).",
          "Start at 5.",
          "Adding -8 means move 8 steps to the left.",
          "5 steps reach 0, then 3 more reach -3.",
        ],
        examplePrompt: "What is 5 + (-8)?",
        exampleAnswer: "-3",
      },
    ],
  },
  {
    domain: INTEGERS_COORDINATES_DOMAIN,
    strand: "negatives-absvalue",
    title: "Absolute value is distance from zero",
    subtitle: "How far from zero, ignoring direction",
    atoms: [
      {
        kind: "story_hook",
        hook: "Owe 7 dollars or hold 7 dollars — either way the number's size is 7. Absolute value ignores direction and asks only one thing: how far from zero?",
      },
      {
        kind: "micro_explain",
        text: "The absolute value of a number is its distance from zero, always zero or positive. Both -7 and 7 sit 7 away from zero, so each has absolute value 7. The bars around a number mean that distance.",
      },
      khanVideo(
        "zpln5ExhkyI",
        0,
        220,
        "Absolute value tells how far a number is from zero.",
      ),
      {
        kind: "manipulative",
        spec: JSON.stringify({
          id: "negatives-absvalue-guided",
          concept: "How far from zero",
          title: "You measured from zero.",
          completeSummary:
            "6 and −6 sit the same distance from zero on opposite sides. That distance is what absolute value means.",
          steps: [
            {
              id: "negatives-absvalue-guided-explore",
              kind: "numberline",
              min: -10,
              max: 10,
              tickStep: 5,
              snap: 1,
              start: 0,
              markers: [{ value: 0, label: "0" }],
              concept: "Both directions",
              prompt: "Slide either way from zero. Watch the sign flip.",
            },
            {
              id: "negatives-absvalue-guided-positive-six",
              kind: "numberline",
              min: -10,
              max: 10,
              tickStep: 5,
              snap: 1,
              start: 0,
              goal: { type: "placeAt", value: 6 },
              concept: "Six from zero",
              prompt: "Land on 6. That's six steps from zero.",
            },
            {
              id: "negatives-absvalue-guided-negative-six",
              kind: "numberline",
              min: -10,
              max: 10,
              tickStep: 5,
              snap: 1,
              start: 6,
              goal: { type: "placeAt", value: -6 },
              concept: "The other six",
              prompt: "Now land on −6. Also six steps from zero, the other way.",
            },
            {
              id: "negatives-absvalue-guided-your-turn",
              kind: "numberline",
              min: -10,
              max: 10,
              tickStep: 5,
              snap: 1,
              start: 0,
              goal: { type: "placeAt", value: -9 },
              concept: "Your turn",
              prompt: "Which number is nine steps from zero, going left?",
            },
          ],
        } satisfies MultiStepSequenceSpec),
      },
      {
        kind: "worked_example",
        strategyLabel: "Drop the sign, keep the distance",
        steps: [
          "Find the absolute value of -7.",
          "Locate -7 on the number line.",
          "Measure its distance from zero: 7 steps.",
          "Distance is never negative, so the absolute value of -7 is 7.",
        ],
        examplePrompt: "What is the absolute value of -7?",
        exampleAnswer: "7",
      },
    ],
  },
  {
    domain: INTEGERS_COORDINATES_DOMAIN,
    strand: "rational-ordering",
    title: "Left on the line is always less",
    subtitle: "Further left on the line is smaller",
    atoms: [
      {
        kind: "story_hook",
        hook: "On a winter number line, -10 is colder than -2, even though 10 feels bigger than 2. Further left means smaller, and negatives flip your usual size instinct.",
      },
      {
        kind: "micro_explain",
        text: "One number is less than another when it sits to the left on the number line. For negatives this reverses the usual instinct: -10 is less than -2 because it lies further left, even though 10 exceeds 2.",
      },
      khanVideo(
        "i1i2_9wg6N8",
        0,
        253,
        "Put rational numbers in order by seeing which ones sit farther left or right.",
      ),
      {
        kind: "try_it",
        strategyLabel: "Compare positions, not sizes",
        steps: [
          "Compare -8 and -3.",
          "Place both on the number line.",
          "-8 lies farther left than -3.",
          "Left means less, so -8 is less than -3.",
        ],
        examplePrompt: "Which is less, -8 or -3?",
        exampleAnswer: "-8",
        answerType: "integer",
      },
      {
        kind: "worked_example",
        strategyLabel: "Compare positions, not sizes",
        steps: [
          "Compare -10 and -2.",
          "Place both on the number line.",
          "-10 lies further to the left than -2.",
          "Left means less, so -10 is less than -2.",
        ],
        examplePrompt: "Which is less, -10 or -2?",
        exampleAnswer: "-10",
      },
    ],
  },

  // ── Ratio, proportion & percent ───────────────────────────────────────────
  {
    domain: RATIO_PROPORTION_PERCENT_DOMAIN,
    strand: "ratios-rates",
    title: "A ratio compares two amounts",
    subtitle: "Relationship, not size",
    atoms: [
      {
        kind: "story_hook",
        hook: "A recipe of two cups of flour to one of sugar keeps its taste whether you bake a little or a lot, as long as the ratio holds. Ratios are about relationship, not size.",
      },
      {
        kind: "micro_explain",
        text: "A ratio compares two quantities, like 2 cups of flour to 1 cup of sugar, written 2:1. A rate is a ratio of different units, like miles per hour. Scaling both parts equally keeps the ratio the same.",
      },
      {
        kind: "video",
        provider: "youtube",
        videoId: "Zm0KaIw-35k",
        startSec: 0,
        endSec: 145,
        captionText: "A rate is a ratio you can scale up or down — watch one worked out.",
        sourceLabel: "Khan Academy",
        sourceUrl: "https://www.youtube.com/watch?v=Zm0KaIw-35k",
      },
      {
        kind: "try_it",
        strategyLabel: "Scale both parts equally",
        examplePrompt:
          "At 3:1 flour to sugar, how many cups of sugar go with 9 cups of flour?",
        steps: [
          "The ratio is 3 parts flour to 1 part sugar.",
          "9 cups of flour is 3 groups of 3.",
          "So the sugar scales by the same 3.",
          "1 × 3 = 3 cups of sugar.",
        ],
        exampleAnswer: "3",
        answerType: "integer",
      },
      {
        kind: "worked_example",
        strategyLabel: "Scale both parts equally",
        steps: [
          "A recipe uses a 2:1 ratio of flour to sugar.",
          "You want to use 6 cups of flour.",
          "6 is 2 tripled, so triple the sugar too: 1 x 3 = 3.",
          "Flour to sugar is now 6:3, still the same 2:1 ratio.",
        ],
        examplePrompt: "At 2:1 flour to sugar, how much sugar goes with 6 cups of flour?",
        exampleAnswer: "3 cups",
      },
    ],
  },
  {
    domain: RATIO_PROPORTION_PERCENT_DOMAIN,
    strand: "proportional-reasoning",
    title: "Find the value of one, then scale",
    subtitle: "Find one, then scale up",
    atoms: [
      {
        kind: "story_hook",
        hook: "If three tickets cost 12 dollars, you can price any number of tickets by first finding what a single one costs. The unit rate is the key that unlocks every proportion.",
      },
      {
        kind: "micro_explain",
        text: "In a proportional relationship, two quantities grow at a constant rate. Find the unit rate — the amount for just one — by dividing, then multiply that up to scale to any amount you need.",
      },
      khanVideo(
        "qYjiVWwefto",
        0,
        229,
        "When two amounts grow together by the same rule, you can scale them up.",
      ),
      {
        kind: "try_it",
        strategyLabel: "Divide down to one, multiply up to many",
        steps: [
          "4 notebooks cost 12 dollars.",
          "Find the cost of one: 12 ÷ 4 = 3 dollars.",
          "You want 7 notebooks.",
          "Multiply the unit price: 7 × 3 = 21 dollars.",
        ],
        examplePrompt: "If 4 notebooks cost 12 dollars, what do 7 notebooks cost?",
        exampleAnswer: "21",
        answerType: "integer",
      },
      {
        kind: "worked_example",
        strategyLabel: "Divide down to one, multiply up to many",
        steps: [
          "3 tickets cost 12 dollars.",
          "Find the cost of one: 12 / 3 = 4 dollars each.",
          "You want 5 tickets.",
          "Multiply the unit price: 5 x 4 = 20 dollars.",
        ],
        examplePrompt: "If 3 tickets cost 12 dollars, what do 5 tickets cost?",
        exampleAnswer: "20 dollars",
      },
    ],
  },
  {
    domain: RATIO_PROPORTION_PERCENT_DOMAIN,
    strand: "percent",
    title: "Percent means out of a hundred",
    subtitle: "A yardstick out of a hundred",
    atoms: [
      {
        kind: "story_hook",
        hook: "A phone at 50 percent battery has half its charge, because percent always measures against a hundred. It is a shared yardstick for comparing very different wholes.",
      },
      {
        kind: "micro_explain",
        text: "Percent means per hundred, so 25 percent is 25 out of every 100, the same as 25/100 or 1/4. To take a percent of a number, turn it into that fraction and multiply.",
      },
      {
        kind: "video",
        provider: "youtube",
        videoId: "Lvr2YsxG10o",
        startSec: 0,
        endSec: 170,
        captionText:
          'Percent just means "out of a hundred" — here is where that idea comes from.',
        sourceLabel: "Khan Academy",
        sourceUrl: "https://www.youtube.com/watch?v=Lvr2YsxG10o",
      },
      {
        kind: "try_it",
        strategyLabel: "Turn percent into a fraction, then multiply",
        examplePrompt: "What is 20 percent of 60?",
        steps: [
          "Find 20 percent of 60.",
          "20 percent is 20 out of 100, which is 1/5.",
          "So take one fifth of 60.",
          "60 ÷ 5 = 12.",
        ],
        exampleAnswer: "12",
        answerType: "integer",
      },
      {
        kind: "worked_example",
        strategyLabel: "Turn percent into a fraction, then multiply",
        steps: [
          "Find 25 percent of 40.",
          "25 percent means 25/100, which simplifies to 1/4.",
          "Take a quarter of 40: 40 / 4 = 10.",
          "So 25 percent of 40 comes to 10.",
        ],
        examplePrompt: "What is 25 percent of 40?",
        exampleAnswer: "10",
      },
    ],
  },

  // ── Probability & data ────────────────────────────────────────────────────
  {
    domain: PROBABILITY_DOMAIN,
    strand: "chance",
    title: "Chance runs from impossible to certain",
    subtitle: "From impossible to certain, 0 to 1",
    atoms: [
      {
        kind: "story_hook",
        hook: "The sun rising tomorrow is certain; a coin landing on its edge, near impossible. Every other event lives somewhere between — probability just puts a number on where.",
      },
      {
        kind: "micro_explain",
        text: "Probability measures how likely an event is, on a scale from 0 (impossible) to 1 (certain). One half means as likely as not. The closer to 1, the more likely; the closer to 0, the less.",
      },
      khanVideo(
        "uzkc-qNVoOk",
        0,
        300,
        "Probability is a number that tells how likely something is to happen.",
      ),
      {
        kind: "manipulative",
        spec: JSON.stringify({
          id: "chance-guided",
          concept: "What is likely?",
          title: "You worked out what's likely.",
          completeSummary:
            "Likelihood is just counting: the more ways something can happen, the more often it turns up.",
          steps: [
            {
              id: "chance-guided-explore",
              kind: "dice",
              diceType: "d6",
              count: 1,
              concept: "One die",
              prompt: "Roll it a few times. Does any number come up more than the others?",
            },
            {
              id: "chance-guided-counting-ways",
              kind: "dice",
              diceType: "d6",
              count: 1,
              prediction: {
                type: "favorableCount",
                event: { type: "face", value: 4 },
              },
              concept: "Counting the ways",
              prompt: "How many of the six faces show a 4?",
            },
            {
              id: "chance-guided-more-ways",
              kind: "dice",
              diceType: "d6",
              count: 1,
              prediction: { type: "favorableCount", event: { type: "even" } },
              concept: "More ways, more likely",
              prompt: "How many faces are even?",
            },
            {
              id: "chance-guided-your-turn",
              kind: "dice",
              diceType: "d6",
              count: 2,
              prediction: { type: "mostLikelyTotal" },
              concept: "Your turn",
              prompt: "Two dice. Which total do you think comes up most often?",
            },
          ],
        } satisfies MultiStepSequenceSpec),
      },
      {
        kind: "worked_example",
        strategyLabel: "Favorable outcomes over total",
        steps: [
          "A bag holds 1 red and 3 blue marbles.",
          "Total outcomes: 4 marbles, each equally likely.",
          "Favorable outcomes for red: 1.",
          "Probability of red is 1 out of 4, or 1/4.",
        ],
        examplePrompt: "A bag has 1 red and 3 blue marbles. What is the probability of drawing red?",
        exampleAnswer: "1/4",
      },
    ],
  },
  {
    domain: PROBABILITY_DOMAIN,
    strand: "theoretical",
    title: "Count outcomes before you play",
    subtitle: "Count outcomes, no rolling needed",
    atoms: [
      {
        kind: "story_hook",
        hook: "You can state a fair die's chance of a 6 without rolling once — just count the equally likely faces. Theoretical probability is reasoning, not experimenting.",
      },
      {
        kind: "micro_explain",
        text: "Theoretical probability comes from counting equally likely outcomes, with no experiment needed. It is the number of favorable outcomes divided by the total number of possible outcomes.",
      },
      khanVideo(
        "tXlcE_K_C-Y",
        0,
        300,
        "Theoretical probability comes from counting all the fair possible outcomes.",
      ),
      {
        kind: "try_it",
        strategyLabel: "Divide favorable by total outcomes",
        steps: [
          "Use a fair eight-sided die numbered 1 through 8.",
          "There are 8 equally likely outcomes.",
          "Four outcomes are even: 2, 4, 6, and 8.",
          "The probability is 4/8, which simplifies to 1/2.",
        ],
        examplePrompt: "What is the probability of rolling an even number on a fair eight-sided die?",
        exampleAnswer: "1/2",
        answerType: "fraction",
      },
      {
        kind: "worked_example",
        strategyLabel: "Divide favorable by total faces",
        steps: [
          "Roll one fair six-sided die.",
          "Total equally likely outcomes: 6 faces.",
          "Favorable outcomes for rolling a 4: just 1.",
          "Probability is 1 out of 6, or 1/6.",
        ],
        examplePrompt: "What is the probability of rolling a 4 on a fair six-sided die?",
        exampleAnswer: "1/6",
      },
    ],
  },
  {
    domain: PROBABILITY_DOMAIN,
    strand: "experimental",
    title: "Let the data estimate the odds",
    subtitle: "Learn the odds from real trials",
    atoms: [
      {
        kind: "story_hook",
        hook: "A bottle-cap flipper does not know its true odds, so they flip it a hundred times and count. Experimental probability learns the chance from what actually happened.",
      },
      {
        kind: "micro_explain",
        text: "Experimental probability is measured from real trials: the number of times an event happened divided by the number of trials. With more trials, it tends to close in on the theoretical value.",
      },
      khanVideo(
        "RdehfQJ8i_0",
        0,
        300,
        "Experimental probability uses what happened in real tries.",
      ),
      {
        kind: "try_it",
        strategyLabel: "Successes over trials",
        steps: [
          "A spinner lands on blue 18 times in 30 spins.",
          "Count the successes: 18.",
          "Count the total trials: 30.",
          "Experimental probability is 18/30, which simplifies to 3/5.",
        ],
        examplePrompt: "A spinner lands on blue 18 times in 30 spins. What is the experimental probability?",
        exampleAnswer: "3/5",
        answerType: "fraction",
      },
      {
        kind: "worked_example",
        strategyLabel: "Successes over trials",
        steps: [
          "A cap lands up 40 times in 100 flips.",
          "Count the successes: 40.",
          "Count the total trials: 100.",
          "Experimental probability is 40/100, which is 2/5.",
        ],
        examplePrompt: "A cap lands up 40 times in 100 flips. What is the experimental probability?",
        exampleAnswer: "2/5",
      },
    ],
  },
  {
    domain: PROBABILITY_DOMAIN,
    strand: "compound",
    title: "Multiply the chances of a run",
    subtitle: "Chain the chances by multiplying",
    atoms: [
      {
        kind: "story_hook",
        hook: "A locker with two dials feels safe because each number narrows the odds, and the dials pile up by multiplying. Compound events chain smaller chances together.",
      },
      {
        kind: "micro_explain",
        text: "For independent events happening in a row, multiply their probabilities. Each stage narrows the outcomes, so two half-chances in a row give one quarter, not one half.",
      },
      khanVideo(
        "OqbkCYy37hI",
        0,
        149,
        "For independent events in a row, multiply their chances.",
      ),
      {
        kind: "try_it",
        strategyLabel: "Multiply the two probabilities",
        steps: [
          "Flip a fair coin and roll a fair six-sided die.",
          "The chance of heads is 1/2.",
          "The chance of rolling a 6 is 1/6.",
          "The events are independent, so multiply: 1/2 × 1/6 = 1/12.",
        ],
        examplePrompt: "What is the probability of flipping heads and then rolling a 6?",
        exampleAnswer: "1/12",
        answerType: "fraction",
      },
      {
        kind: "worked_example",
        strategyLabel: "Multiply the two probabilities",
        steps: [
          "Flip a fair coin twice and look for two heads.",
          "Chance of heads on the first flip: 1/2.",
          "Chance of heads on the second flip: 1/2.",
          "The flips are independent, so multiply: 1/2 x 1/2 = 1/4.",
        ],
        examplePrompt: "What is the probability of flipping heads twice in a row?",
        exampleAnswer: "1/4",
      },
    ],
  },
  {
    domain: PROBABILITY_DOMAIN,
    strand: "data-displays",
    title: "A graph is a picture of numbers",
    subtitle: "Turn counts into a picture",
    atoms: [
      {
        kind: "story_hook",
        hook: "A row of bars can reveal in a glance what a page of numbers hides — which choice won, which month spiked. A good display turns data into something you can see.",
      },
      {
        kind: "micro_explain",
        text: "Data displays like bar graphs and dot plots turn counts into lengths or stacks you can compare at a glance. To read one, check the axis labels first, then compare the bar heights or dot columns.",
      },
      {
        kind: "video",
        provider: "youtube",
        videoId: "c02vjunQsJM",
        startSec: 58,
        endSec: 171,
        captionText:
          "A histogram turns a pile of numbers into a shape you can read at a glance.",
        sourceLabel: "Khan Academy",
        sourceUrl: "https://www.youtube.com/watch?v=c02vjunQsJM",
      },
      {
        kind: "try_it",
        strategyLabel: "Read heights off the axis",
        examplePrompt: "Pears reach 9 and plums reach 4. How many more chose pears?",
        steps: [
          "Read the pear bar: it reaches 9.",
          "Read the plum bar: it reaches 4.",
          '"How many more" means subtract.',
          "9 − 4 = 5.",
        ],
        exampleAnswer: "5",
        answerType: "integer",
      },
      {
        kind: "worked_example",
        strategyLabel: "Read heights off the axis",
        steps: [
          "A bar graph shows favorite fruits.",
          "The apple bar rises to 8 on the count axis.",
          "The banana bar rises to 5.",
          "Compare the heights: apples beat bananas by 8 - 5 = 3.",
        ],
        examplePrompt: "Apples reach 8 and bananas reach 5. How many more chose apples?",
        exampleAnswer: "3",
      },
    ],
  },
  {
    domain: PROBABILITY_DOMAIN,
    strand: "center-spread",
    title: "One number for the middle",
    subtitle: "The balance point of the numbers",
    atoms: [
      {
        kind: "story_hook",
        hook: "A coach does not recite every runner's time; they cite the average. The mean is a single stand-in for a whole group — the balance point of the numbers.",
      },
      {
        kind: "micro_explain",
        text: "The mean, or average, summarizes a group with one central number: add all the values, then divide by how many there are. It marks the balance point of the data.",
      },
      khanVideo(
        "GrynkZB3E7M",
        0,
        300,
        "The mean is the fair-share middle you get by adding, then dividing.",
      ),
      {
        kind: "try_it",
        strategyLabel: "Add them up, divide by the count",
        steps: [
          "The values are 5, 7, and 9.",
          "Add them: 5 + 7 + 9 = 21.",
          "Count the values: 3.",
          "Divide: 21 ÷ 3 = 7, the mean.",
        ],
        examplePrompt: "What is the mean of 5, 7, and 9?",
        exampleAnswer: "7",
        answerType: "integer",
      },
      {
        kind: "worked_example",
        strategyLabel: "Add them up, divide by the count",
        steps: [
          "The scores are 4, 6, and 8.",
          "Add them: 4 + 6 + 8 = 18.",
          "Count the values: 3.",
          "Divide: 18 / 3 = 6, the mean.",
        ],
        examplePrompt: "What is the mean of 4, 6, and 8?",
        exampleAnswer: "6",
      },
    ],
  },

  // ── Early algebra ─────────────────────────────────────────────────────────
  {
    domain: EARLY_ALGEBRA_DOMAIN,
    strand: "patterns-sequences",
    title: "Find the rule that repeats",
    subtitle: "Spot the rule, predict the next",
    atoms: [
      {
        kind: "story_hook",
        hook: "Sunflower seeds, pinecones, and piano keys all march in patterns. Spot the rule behind a sequence and you can predict a step you have never seen.",
      },
      {
        kind: "micro_explain",
        text: "A sequence follows a rule. When each term changes by the same amount, find that common step, then keep applying it. The step is the difference between one term and the next.",
      },
      khanVideo(
        "EU0c6qrrevA",
        0,
        66,
        "Find the step that repeats, then use it to continue the pattern.",
      ),
      {
        kind: "try_it",
        strategyLabel: "Find the step, then extend",
        steps: [
          "Look at 4, 9, 14, 19.",
          "Each term rises by 5.",
          "Add 5 to the last term.",
          "19 + 5 = 24.",
        ],
        examplePrompt: "What comes next in 4, 9, 14, 19?",
        exampleAnswer: "24",
        answerType: "integer",
      },
      {
        kind: "worked_example",
        strategyLabel: "Find the step, then extend",
        steps: [
          "Look at 2, 5, 8, 11.",
          "Each term rises by the same step: 5 - 2 = 3.",
          "Add that step to the last term: 11 + 3 = 14.",
          "So the next term is 14.",
        ],
        examplePrompt: "What comes next in 2, 5, 8, 11?",
        exampleAnswer: "14",
      },
    ],
  },
  {
    domain: EARLY_ALGEBRA_DOMAIN,
    strand: "expressions-variables",
    title: "A letter stands for a number",
    subtitle: "A letter you can fill in later",
    atoms: [
      {
        kind: "story_hook",
        hook: "A snack machine charges the same per item no matter which button; call the count n and the cost is one rule for every choice. A variable holds a number you have not fixed yet.",
      },
      {
        kind: "micro_explain",
        text: "A variable is a letter standing in for a number. An expression like 3n means 3 times n. To evaluate it, substitute the value in place of the letter and compute.",
      },
      khanVideo(
        "AJNDeVt9UOo",
        0,
        120,
        "Replace the letter with its number, then do the math.",
      ),
      {
        kind: "manipulative",
        spec: JSON.stringify({
          id: "expressions-variables-guided",
          concept: "The hidden rule",
          title: "You found the hidden rule.",
          completeSummary:
            "A rule that works for every input is what a variable lets you write down: triple it and add one becomes 3n + 1.",
          steps: [
            {
              id: "expressions-variables-guided-explore",
              kind: "functionMachine",
              rule: { op: "affine", m: 2, b: 0 },
              examples: [
                { in: 1, out: 2 },
                { in: 3, out: 6 },
                { in: 5, out: 10 },
              ],
              queryInput: 4,
              concept: "A machine with a rule",
              prompt:
                "Look at what goes in and what comes out. What is the machine doing?",
            },
            {
              id: "expressions-variables-guided-doubling",
              kind: "functionMachine",
              rule: { op: "affine", m: 2, b: 0 },
              examples: [
                { in: 1, out: 2 },
                { in: 3, out: 6 },
                { in: 5, out: 10 },
              ],
              queryInput: 7,
              answer: { value: 14, prompt: "What comes out when 7 goes in?" },
              concept: "Doubling",
              prompt: "This machine doubles. Send 7 through.",
            },
            {
              id: "expressions-variables-guided-adding-five",
              kind: "functionMachine",
              rule: { op: "affine", m: 1, b: 5 },
              examples: [
                { in: 2, out: 7 },
                { in: 4, out: 9 },
                { in: 10, out: 15 },
              ],
              queryInput: 6,
              answer: { value: 11, prompt: "What comes out when 6 goes in?" },
              concept: "Adding five",
              prompt: "Different machine. Work out the rule, then send 6 through.",
            },
            {
              id: "expressions-variables-guided-your-turn",
              kind: "functionMachine",
              rule: { op: "affine", m: 3, b: 1 },
              examples: [
                { in: 1, out: 4 },
                { in: 2, out: 7 },
                { in: 4, out: 13 },
              ],
              queryInput: 5,
              answer: { value: 16, prompt: "What comes out when 5 goes in?" },
              concept: "Your turn",
              prompt: "This one does two things. Send 5 through.",
            },
          ],
        } satisfies MultiStepSequenceSpec),
      },
      {
        kind: "worked_example",
        strategyLabel: "Substitute, then compute",
        steps: [
          "Evaluate 3n when n = 4.",
          "Replace n with 4: 3 x 4.",
          "Multiply: 3 x 4 = 12.",
          "So 3n comes to 12 when n = 4.",
        ],
        examplePrompt: "What is 3n when n = 4?",
        exampleAnswer: "12",
      },
    ],
  },
  {
    domain: EARLY_ALGEBRA_DOMAIN,
    strand: "equations-1-2-step",
    title: "Undo to isolate the unknown",
    subtitle: "Keep the scale balanced",
    atoms: [
      {
        kind: "story_hook",
        hook: "An equation is a balanced scale: whatever you do to one side you must do to the other. To find the unknown, peel away the operations around it in reverse.",
      },
      {
        kind: "micro_explain",
        text: "To solve an equation, undo the operations on the variable using inverses, doing the same to both sides so it stays balanced. Subtraction undoes addition; division undoes multiplication.",
      },
      khanVideo(
        "jWpiMu5LNdg",
        0,
        129,
        "Undo what happened to the letter while keeping both sides equal.",
      ),
      {
        kind: "manipulative",
        spec: JSON.stringify({
          id: "equations-1-2-step-guided",
          concept: "Keeping it balanced",
          title: "You kept it balanced.",
          completeSummary:
            "A balanced scale is what an equals sign means: however much is on one side, the other side has exactly as much — even when part of it is hidden.",
          steps: [
            {
              id: "equations-1-2-step-guided-explore",
              kind: "balance",
              left: 3,
              right: 3,
              adjustable: ["left", "right"],
              maxUnits: 12,
              theme: { fill: { label: "apple" } },
              concept: "The pans",
              prompt: "Add and take away apples. Watch which side drops.",
            },
            {
              id: "equations-1-2-step-guided-making-it-even",
              kind: "balance",
              left: 5,
              right: 2,
              adjustable: ["right"],
              maxUnits: 12,
              theme: { fill: { label: "apple" } },
              goal: { type: "balance" },
              concept: "Making it even",
              prompt: "Add weights to the right until it balances.",
            },
            {
              id: "equations-1-2-step-guided-even-again",
              kind: "balance",
              left: 7,
              right: 3,
              adjustable: ["right"],
              maxUnits: 12,
              theme: { fill: { label: "apple" } },
              goal: { type: "balance" },
              concept: "Even again",
              prompt: "Balance it again.",
            },
            {
              id: "equations-1-2-step-guided-your-turn",
              kind: "balance",
              left: 9,
              right: 2,
              mysteryRight: 4,
              adjustable: ["right"],
              maxUnits: 12,
              theme: { fill: { label: "apple" } },
              goal: { type: "balance" },
              concept: "Your turn",
              prompt:
                "The grey block is a mystery weight. Add just enough to balance the scale.",
            },
          ],
        } satisfies MultiStepSequenceSpec),
      },
      {
        kind: "worked_example",
        strategyLabel: "Do the same to both sides",
        steps: [
          "Solve x + 3 = 7.",
          "The 3 is added to x, so subtract 3 from both sides.",
          "Left: x + 3 - 3 = x. Right: 7 - 3 = 4.",
          "So x = 4.",
        ],
        examplePrompt: "Solve x + 3 = 7.",
        exampleAnswer: "4",
      },
    ],
  },
  {
    domain: EARLY_ALGEBRA_DOMAIN,
    strand: "inequalities",
    title: "A range of answers, not just one",
    subtitle: "A whole range of answers",
    atoms: [
      {
        kind: "story_hook",
        hook: "A ride sign reading \"you must be over 48 inches\" does not name one height — it opens a whole range. Inequalities describe every value that fits, not a single solution.",
      },
      {
        kind: "micro_explain",
        text: "An inequality compares with signs like greater-than or less-than, describing a range of values. Solve it much like an equation, using inverse operations on both sides. Every number that makes it true belongs to the range.",
      },
      khanVideo(
        "y7QLay8wrW8",
        0,
        272,
        "Solve an inequality like an equation to find every number that works.",
      ),
      {
        kind: "try_it",
        strategyLabel: "Isolate the variable as usual",
        steps: [
          "Solve x + 4 > 9.",
          "Subtract 4 from both sides.",
          "Left: x + 4 - 4 = x. Right: 9 - 4 = 5.",
          "So x > 5. The smallest whole-number solution is 6.",
        ],
        examplePrompt: "What is the smallest whole-number solution to x + 4 > 9?",
        exampleAnswer: "6",
        answerType: "integer",
      },
      {
        kind: "worked_example",
        strategyLabel: "Isolate the variable as usual",
        steps: [
          "Solve x + 2 > 5.",
          "Subtract 2 from both sides.",
          "Left: x + 2 - 2 = x. Right: 5 - 2 = 3.",
          "So x > 3: every number greater than 3 works.",
        ],
        examplePrompt: "Solve x + 2 > 5.",
        exampleAnswer: "x > 3",
      },
    ],
  },
  {
    domain: ALGEBRA_1_DOMAIN,
    strand: "linear-equations",
    title: "Keep the balance, then isolate x",
    subtitle: "Combine like terms, then undo operations",
    atoms: [
      {
        kind: "story_hook",
        hook: "Around 820 CE in Baghdad, al-Khwarizmi wrote a book on al-jabr — \"restoring\" an equation by adding the same amount to both sides to remove a subtracted term. That word became our word algebra.",
      },
      {
        kind: "micro_explain",
        text: "An equation says two expressions are equal. First combine like terms on each side, then apply the same inverse operation to both sides to isolate the variable. Every step must keep the two sides equal.",
      },
      khanVideo(
        "_y_Q3_B2Vh8",
        0,
        312,
        "Undo one operation at a time on both sides until the mystery number is alone.",
      ),
      {
        kind: "try_it",
        strategyLabel: "Undo operations in reverse order",
        steps: [
          "Solve 4x + 2 = 18.",
          "Subtract 2 from both sides: 4x = 16.",
          "Divide both sides by 4.",
          "x = 4.",
        ],
        examplePrompt: "Solve 4x + 2 = 18.",
        exampleAnswer: "4",
        answerType: "integer",
      },
      {
        kind: "worked_example",
        strategyLabel: "Collect like terms, then undo",
        steps: [
          "Solve 5x - 2x + 1 = 10.",
          "Combine like terms on the left: 5x - 2x = 3x, so 3x + 1 = 10.",
          "Subtract 1 from both sides: 3x = 9.",
          "Divide both sides by 3: x = 3.",
        ],
        examplePrompt: "Solve 5x - 2x + 1 = 10.",
        exampleAnswer: "3",
      },
    ],
  },
  // Entrance note: linear-functions has two root branches (function
  // identification and slope). The Launchpad teaches the SLOPE branch — the
  // strand's one idea ("a line is one steady rate") lives there, and
  // fn_identify_function is a definition check rather than a doorway moment.
  {
    domain: ALGEBRA_1_DOMAIN,
    strand: "linear-functions",
    title: "A line is one steady rate",
    subtitle: "Slope measures how fast it changes",
    atoms: [
      {
        kind: "story_hook",
        hook: "In 1637 Descartes published La Geometrie, showing that a line drawn on a grid can be captured exactly by an equation linking x and y. That union of picture and formula is why we still call the grid the Cartesian plane.",
      },
      {
        kind: "micro_explain",
        text: "A function gives exactly one output for each input. A linear function changes at a constant rate called the slope, so its graph is a straight line. The slope is the change in output divided by the change in input.",
      },
      {
        kind: "video",
        provider: "youtube",
        videoId: "MeU-KzdCBps",
        startSec: 41,
        endSec: 220,
        captionText:
          "Slope is how steeply a line climbs — watch it measured between two points.",
        sourceLabel: "Khan Academy",
        sourceUrl: "https://www.youtube.com/watch?v=MeU-KzdCBps",
      },
      {
        kind: "try_it",
        strategyLabel: "Rise over run between two points",
        examplePrompt: "What is the slope of the line through (1, 2) and (3, 8)?",
        steps: [
          "Take the two points (1, 2) and (3, 8).",
          "The rise is 8 − 2 = 6.",
          "The run is 3 − 1 = 2.",
          "Slope is rise over run: 6 ÷ 2 = 3.",
        ],
        exampleAnswer: "3",
        answerType: "integer",
      },
      {
        kind: "worked_example",
        strategyLabel: "Rise over run between two points",
        steps: [
          "Find the slope of the line through (2, 3) and (4, 7).",
          "Change in output (y): 7 - 3 = 4.",
          "Change in input (x): 4 - 2 = 2.",
          "Slope = change in output over change in input: 4 / 2 = 2.",
        ],
        examplePrompt: "What is the slope of the line through (2, 3) and (4, 7)?",
        exampleAnswer: "2",
      },
    ],
  },
  {
    domain: ALGEBRA_1_DOMAIN,
    strand: "systems",
    title: "One point that fits every equation",
    subtitle: "The solution satisfies both at once",
    atoms: [
      {
        kind: "story_hook",
        hook: "China's Nine Chapters on the Mathematical Art, compiled nearly two thousand years ago, solved several equations at once by eliminating unknowns on a counting board — elimination itself, centuries before Gauss.",
      },
      {
        kind: "micro_explain",
        text: "A system of equations asks for values that make every equation true at the same time. Its solution is the single point that lies on both lines, so you can test a candidate point by substituting it into each equation.",
      },
      {
        kind: "video",
        provider: "youtube",
        videoId: "uzyd_mIJaoc",
        startSec: 13,
        endSec: 165,
        captionText:
          "Two equations, one point that fits both — watch substitution track it down.",
        sourceLabel: "Khan Academy",
        sourceUrl: "https://www.youtube.com/watch?v=uzyd_mIJaoc",
      },
      {
        kind: "try_it",
        strategyLabel: "Substitute one equation into the other",
        examplePrompt: "y = x − 2 and x + y = 8. What is x?",
        steps: [
          "Start with x + y = 8.",
          "Replace y with x − 2, since y = x − 2.",
          "That gives x + x − 2 = 8, so 2x = 10.",
          "x = 5.",
        ],
        exampleAnswer: "5",
        answerType: "integer",
      },
      {
        kind: "worked_example",
        strategyLabel: "Substitute the point into each equation",
        steps: [
          "Check whether (5, 2) solves x + y = 7 and x - y = 3.",
          "First equation: 5 + 2 = 7, which is true.",
          "Second equation: 5 - 2 = 3, which is true.",
          "Both are true, so (5, 2) is the solution of the system.",
        ],
        examplePrompt: "Is (5, 2) the solution of x + y = 7 and x - y = 3?",
        exampleAnswer: "Yes",
      },
    ],
  },
  {
    domain: ALGEBRA_1_DOMAIN,
    strand: "exponents-exponential",
    title: "An exponent counts repeated factors",
    subtitle: "Same base multiplied? Add the exponents",
    atoms: [
      {
        kind: "story_hook",
        hook: "In The Sand Reckoner, Archimedes set out to count the grains of sand that would fill the universe. To write such vast numbers he built a system of powers of ten, where multiplying powers means adding their exponents.",
      },
      {
        kind: "micro_explain",
        text: "An exponent tells how many equal factors are multiplied, so 2^3 means three factors of 2. When two powers share a base, multiplying them stacks the factors together, which means you add the exponents.",
      },
      khanVideo(
        "CZ5ne_mX5_I",
        0,
        263,
        "When matching powers multiply, add their exponent numbers.",
      ),
      {
        kind: "try_it",
        strategyLabel: "Add exponents on a shared base",
        steps: [
          "Simplify 3^2 · 3^4.",
          "The first power has 2 factors of 3.",
          "The second power has 4 more factors of 3.",
          "Together there are 6 factors, so the product is 3^6.",
        ],
        examplePrompt: "Write 3^2 · 3^4 as a single power of 3.",
        exampleAnswer: "3^6",
        answerType: "expression",
      },
      {
        kind: "worked_example",
        strategyLabel: "Add exponents on a shared base",
        steps: [
          "Simplify 2^3 · 2^2.",
          "2^3 means 2 · 2 · 2, and 2^2 means 2 · 2.",
          "Together that is five factors of 2.",
          "Five factors of 2 is 2^5.",
        ],
        examplePrompt: "Write 2^3 · 2^2 as a single power of 2.",
        exampleAnswer: "2^5",
      },
    ],
  },
  {
    domain: ALGEBRA_1_DOMAIN,
    strand: "polynomials-factoring",
    title: "A polynomial is a sum of power-terms",
    subtitle: "Degree is the highest power present",
    atoms: [
      {
        kind: "story_hook",
        hook: "Around 250 CE, Diophantus of Alexandria wrote Arithmetica using special symbols for the unknown and for its square and cube — an early step from sentences toward the compact symbolic powers we now write as a polynomial.",
      },
      {
        kind: "micro_explain",
        text: "A polynomial is a sum of terms, each a coefficient times a whole-number power of the variable. Its degree is the highest power that appears, and the leading coefficient is the number multiplying that highest-power term.",
      },
      khanVideo(
        "Vm7H0VTlIco",
        0,
        360,
        "A polynomial is built from number-and-variable pieces, and its biggest exponent names its degree.",
      ),
      {
        kind: "try_it",
        strategyLabel: "Find the highest power",
        steps: [
          "Look at 5x^4 - 2x + 7.",
          "The powers present are 4, 1, and 0.",
          "The highest power is 4.",
          "So the polynomial has degree 4.",
        ],
        examplePrompt: "What is the degree of 5x^4 - 2x + 7?",
        exampleAnswer: "4",
        answerType: "integer",
      },
      {
        kind: "worked_example",
        strategyLabel: "Read degree, terms, leading coefficient",
        steps: [
          "Classify 3x^2 + 5x - 2.",
          "The highest power is 2, so the degree is 2.",
          "There are three terms, so it is a trinomial.",
          "The term with the highest power is 3x^2, so the leading coefficient is 3.",
        ],
        examplePrompt: "State the degree and leading coefficient of 3x^2 + 5x - 2.",
        exampleAnswer: "Degree 2, leading coefficient 3",
      },
    ],
  },
  {
    domain: ALGEBRA_1_DOMAIN,
    strand: "quadratics",
    title: "Undo the square to solve",
    subtitle: "An x-squared term gives two answers",
    atoms: [
      {
        kind: "story_hook",
        hook: "Around 820 CE, al-Khwarizmi solved equations with an x-squared term by drawing a literal square and adding rectangles to \"complete\" it into a larger one. That completing-the-square still solves quadratics today.",
      },
      {
        kind: "micro_explain",
        text: "A quadratic equation contains a squared term, and its graph is a parabola. Because squaring a positive and its opposite give the same result, undoing a square usually yields two solutions that differ only in sign.",
      },
      khanVideo(
        "wt6XqG59t5U",
        0,
        328,
        "Undoing a square can give two answers: one positive and one negative.",
      ),
      {
        kind: "try_it",
        strategyLabel: "Take the square root of both sides",
        steps: [
          "Solve x^2 = 25.",
          "Take the square root of both sides.",
          "Both 5 × 5 and -5 × -5 equal 25.",
          "The two solutions are 5 and -5, so the positive one is 5.",
        ],
        examplePrompt: "What is the positive solution to x^2 = 25?",
        exampleAnswer: "5",
        answerType: "integer",
      },
      {
        kind: "worked_example",
        strategyLabel: "Take the square root of both sides",
        steps: [
          "Solve x^2 = 9.",
          "Take the square root of both sides to undo the square.",
          "A positive number has two square roots, one positive and one negative.",
          "So x = 3 or x = -3.",
        ],
        examplePrompt: "Solve x^2 = 9.",
        exampleAnswer: "3 or -3",
      },
    ],
  },
];
