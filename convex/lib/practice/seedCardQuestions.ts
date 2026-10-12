/**
 * The question each cross-domain preview seed asks on the done-screen card
 * (shared/questionCard.ts). Keyed by the seed's `topic` — the stable mint-once
 * identity in crossDomainSeeds.ts (never renamed) — and resolved at READ time,
 * so seeds minted before a question existed still get it.
 *
 * Same authoring rules as storyCardQuestions.ts: a predict-or-solve question a
 * kid can answer with the seed's GATE skill, 2–4 short choices, one true
 * answer, a ≤ 14-word reveal that stands alone, every claim true.
 */
import type { CardQuestion } from "../../../shared/questionCard";

export const SEED_CARD_QUESTIONS: Record<string, CardQuestion> = {
  "Doubling a penny: why day 30 is not what you guess": {
    prompt: "A million dollars today, or a penny that doubles every day for 30 days?",
    choices: ["The million dollars", "The doubling penny"],
    answerIndex: 1,
    reveal: "The penny wins: over $5 million.",
    whyLabel: "How?! →",
  },
  "Counting by 2s → odd, even, and how computers count (binary)": {
    prompt: "If you could only use the digits 0 and 1, how high could you count?",
    choices: ["Only up to 1", "Up to 100", "As high as you like"],
    answerIndex: 2,
    reveal: "Just 0 and 1 can write any number: 2 is 10, 3 is 11.",
  },
  "Times tables → hidden patterns (why the 9s digits always add to 9)": {
    prompt: "9 × 7 = 63, and 6 + 3 = 9. Do the digits of every 9s answer up to 90 add to 9?",
    choices: ["Yes, every one", "Only some of them", "Only 63"],
    answerIndex: 0,
    reveal: "Every nines answer up to 90 has digits that add to 9.",
  },
  "Remainders → clock math (why 15:00 is 3 o'clock)": {
    prompt: "It's 9 o'clock. What will the clock say 100 hours from now?",
    choices: ["1 o'clock", "4 o'clock", "7 o'clock", "9 o'clock"],
    answerIndex: 0,
    reveal: "1 o'clock: 100 hours is 8 laps of the clock plus 4.",
  },
  "Place value → how big is a billion, really? (Fermi estimation)": {
    prompt: "A million seconds is about 12 days. How long is a billion seconds?",
    choices: ["About 1 month", "About 1 year", "About 32 years"],
    answerIndex: 2,
    reveal: "A billion seconds is almost 32 years, not just a bit longer.",
  },
  "Multiplication → the area of everything (rooms, fields, screens)": {
    prompt: "A full HD screen is 1920 dots across and 1080 dots down. About how many dots is that?",
    choices: ["About 2 million", "About 3,000", "About 200,000"],
    answerIndex: 0,
    reveal: "1920 × 1080 is 2,073,600 tiny dots of light.",
  },
  "Rounding → how scientists write giant and tiny numbers": {
    prompt: "10⁷ means 1 followed by 7 zeros. Which is bigger: 9 × 10⁶ or 2 × 10⁷?",
    choices: ["9 × 10⁶", "2 × 10⁷", "They're the same"],
    answerIndex: 1,
    reveal: "2 × 10⁷ is 20 million: the power of ten beats the 9.",
  },
  "Making ten → the number systems people invented (Babylonian 60s, Mayan 20s)": {
    prompt: "Why does an hour have 60 minutes, not 100?",
    choices: ["A king picked it", "60 is easy to count", "Ancient people counted in 60s"],
    answerIndex: 2,
    reveal: "The Babylonians counted in sixties, and every clock still does.",
  },
  "Skip-counting → rhythm, beats, and time signatures in music": {
    prompt: "A waltz goes ONE two three, ONE two three… Is beat number 100 a loud ONE or a quiet beat?",
    choices: ["A loud ONE", "A quiet beat"],
    answerIndex: 0,
    reveal: "Beat 100 is loud: 99 beats is exactly 33 bars of three.",
  },
  "Sharing fairly → fractions (what if it doesn't come out even?)": {
    prompt: "Who gets more cookie: 4 friends sharing 3 cookies, or 2 friends sharing 1 cookie?",
    choices: ["3 cookies, 4 friends", "1 cookie, 2 friends", "The same amount"],
    answerIndex: 0,
    reveal: "3 cookies for 4 friends gives each three quarters: more than half.",
  },
  "Subtracting past zero: is there a number to the left of 0?": {
    prompt: "It's 5 degrees outside, then it gets 9 degrees colder. What's the temperature now?",
    choices: ["0, it can't go lower", "4 degrees", "4 below zero"],
    answerIndex: 2,
    reveal: "5 minus 9 is −4: four steps past zero on the cold side.",
  },
  "Which numbers refuse to be a rectangle?": {
    prompt: "Which number of dots can't make a rectangle with more than one row?",
    choices: ["15", "21", "23", "27"],
    answerIndex: 2,
    reveal: "Only 23 makes just one long line: numbers like that are called prime.",
  },
  "4 + 3 × 2: why two careful kids get 14 and 10": {
    prompt: "Multiply before you add: did someone prove that rule, or did people simply agree on it?",
    choices: ["Someone proved it", "People agreed on it"],
    answerIndex: 1,
    reveal: "Multiply-first was never proved; people agreed on it, like driving on one side.",
  },
  "Different-looking fractions that are secretly the same": {
    prompt: "Which is more chocolate: 4 squares of a 6-square bar, or 6 squares of a same-size 9-square bar?",
    choices: ["The 4 squares", "The 6 squares", "Exactly the same"],
    answerIndex: 2,
    reveal: "4 of 6 and 6 of 9 are both two thirds of the bar.",
  },
  "6 × 13 in two pieces — and what if 13 hides a letter?": {
    prompt: "6 × 13 is 6 tens plus 6 threes. What is 6 × (10 + a mystery number)?",
    choices: ["60 + 6 mystery numbers", "60 + the mystery number", "Can't know without it"],
    answerIndex: 0,
    reveal: "6 × (10 + mystery) is 60 plus six mysteries: that's algebra.",
  },
  "From a rectangle of squares to a box of cubes": {
    prompt: "A box holds 8 sugar cubes: 2 long, 2 wide, 2 tall. Double every side. How many cubes now?",
    choices: ["16", "32", "64"],
    answerIndex: 2,
    reveal: "Doubling every side makes 4 layers of 16: 64 cubes, eight times more.",
  },
  "Two dice: is a total of 7 as likely as a total of 12?": {
    prompt: "Rolling two dice, which happens more often: a total of 7, or doubles (both dice the same)?",
    choices: ["A total of 7", "Doubles", "Exactly as often"],
    answerIndex: 2,
    reveal: "Six of the 36 rolls make 7, and six are doubles.",
  },
  "Skip-counting as a staircase: what decides how steeply it climbs": {
    prompt: "One staircase climbs by 2s, another by 5s. After 10 steps, how much higher is the 5s staircase?",
    choices: ["3 higher", "30 higher", "The same height"],
    answerIndex: 1,
    reveal: "Counting by 5s pulls 3 ahead of 2s every step: 30 after ten.",
  },
  "Multiplying by 10 again and again: where do the zeros come from?": {
    prompt: "What is 100 × 100 × 100?",
    choices: ["300", "30,000", "1,000,000"],
    answerIndex: 2,
    reveal: "Zeros add up: 100 × 100 × 100 is a million, six zeros.",
  },
  "The addition table's mirror: why 3+6 and 6+3 match": {
    prompt: "Which is bigger: 3 + 6 or 6 + 3?",
    choices: ["They're the same", "3 + 6", "6 + 3"],
    answerIndex: 0,
    reveal: "An addition table folds onto itself: swapping numbers never changes the sum.",
  },
  "Subtraction as distance: the gap between two numbers": {
    prompt: "On a number line, which pair is farther apart: 2 and 7, or 4 and 9?",
    choices: ["2 and 7", "4 and 9", "Exactly the same"],
    answerIndex: 2,
    reveal: "7 − 2 and 9 − 4 are both 5: subtraction measures the gap.",
  },
  "Odd or even? Predict a sum without adding it up": {
    prompt: "Someone secretly adds two odd numbers. Is the answer odd or even?",
    choices: ["Always odd", "Always even", "It depends"],
    answerIndex: 1,
    reveal: "Odd plus odd is always even: the two leftover dots pair up.",
  },
  "Adding 1+2+...+10 the fast way (Gauss's trick)": {
    prompt: "1 + 2 + 3 + … + 10 makes 55. What does 1 + 2 + 3 + … + 20 make?",
    choices: ["110", "155", "210"],
    answerIndex: 2,
    reveal: "Pair 1 with 20, 2 with 19…: ten pairs of 21 make 210.",
  },
  "Magic squares: nine numbers, one total every way": {
    prompt: "Put 1 to 9 in a 3-by-3 grid so every row, column and diagonal adds the same. How many ways, ignoring turns and flips?",
    choices: ["Only 1", "About 10", "Hundreds"],
    answerIndex: 0,
    reveal: "The 1-to-9 magic square has exactly one pattern, turned or flipped 8 ways.",
  },
  "How many handshakes if everyone greets everyone once?": {
    prompt: "Six friends each shake hands with everyone else once. How many handshakes is that?",
    choices: ["12", "15", "30", "36"],
    answerIndex: 1,
    reveal: "Each handshake uses two people, so 6 × 5 counts each twice: 15.",
  },
  "Reverse and add: do all numbers fall into a palindrome?": {
    prompt: "Reverse and add: 68 + 86 = 154. Repeat, and 68 hits 1111, a palindrome, in 3 steps. How many steps for 196?",
    choices: ["4 steps", "About 20 steps", "Nobody knows"],
    answerIndex: 2,
    reveal: "Computers have run 196 for decades and never found a palindrome.",
  },
};

export function seedCardQuestion(topic: string): CardQuestion | undefined {
  return SEED_CARD_QUESTIONS[topic];
}
