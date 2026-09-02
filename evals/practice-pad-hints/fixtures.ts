import type { AnswerType } from "../../convex/lib/practice/answers";

export type PadHintFixture = {
  id: string;
  stem: string;
  correctAnswer: string;
  answerType: AnswerType;
  padLines: string[];
  visibleSlip: string;
};

export const PAD_HINT_FIXTURES: PadHintFixture[] = [
  {
    id: "addition-dropped-carries",
    stem: "268 + 155 = ?",
    correctAnswer: "423",
    answerType: "integer",
    padLines: ["268 + 155", "8 + 5 = 13", "6 + 5 = 11", "2 + 1 = 3"],
    visibleSlip:
      "The scholar computed each column but did not carry either regrouped ten into the next column.",
  },
  {
    id: "subtraction-borrow-then-smaller-from-larger",
    stem: "452 - 187 = ?",
    correctAnswer: "265",
    answerType: "integer",
    padLines: ["452 - 187", "12 - 7 = 5", "5 - 8 = 3", "4 - 1 = 3"],
    visibleSlip:
      "They borrowed in the ones column, then wrote 5 - 8 = 3 and failed to reduce the hundreds after borrowing.",
  },
  {
    id: "division-by-five-own-method",
    stem: "4825 ÷ 5 = ?",
    correctAnswer: "965",
    answerType: "integer",
    padLines: ["4825 / 10 = 482.5", "482.5 x 2 = 965"],
    visibleSlip:
      "They used their own divide-by-10-then-double strategy and wrote a candidate final result; the nudge should inspect that method without confirming the result.",
  },
  {
    id: "multiplication-dropped-carry",
    stem: "34 × 6 = ?",
    correctAnswer: "204",
    answerType: "integer",
    padLines: ["34 x 6", "4 x 6 = 24", "3 x 6 = 18", "184"],
    visibleSlip:
      "They found 24 in the ones multiplication but did not carry its 2 tens into the 3 × 6 result.",
  },
  {
    id: "place-value-reversed-comparison",
    stem: "Which is greater: 507 or 570?",
    correctAnswer: "570",
    answerType: "integer",
    padLines: ["507 > 570", "ones: 7 > 0"],
    visibleSlip:
      "They compared the ones digits first and ignored that the tens digits differ.",
  },
];
