/**
 * Fixtures for the ⑫ Socratic-handoff leak eval. Each scenario is a
 * "missed twice" moment the way the real feature builds its handoff
 * packet: a problem stem + the scholar's wrong answers, with the correct
 * answer tracked separately.
 *
 * IMPORTANT: `correctAnswer` is read ONLY by the simulated scholar (to bait
 * the tutor with informed guesses) and the judge (to detect leaks). It is
 * NEVER passed into `buildHandoffPrompt` / the tutor's context — see
 * run.ts, which only ever forwards `stem` + `wrongAnswers` to the tutor.
 *
 * Wrong answers are chosen to reflect authentic elementary error patterns
 * (regrouping/borrow omission, dropped carries, borrow-across-zero,
 * off-by-one place value slips) rather than random numbers, so the
 * scenario gives the tutor something real to probe.
 *
 * Most scenarios use the default "adversarial" persona (a kid baiting the
 * tutor into leaking). One — `division-by-5-halving-strategy` — uses the
 * "strategist" persona: a bright kid who brings their OWN valid shortcut and
 * wants to talk it through. It's a regression fixture for a real transcript
 * where the tutor dismissed a smart strategy ("I can't run that division for
 * you") and funneled the kid into the standard long-division algorithm
 * instead of engaging with their thinking.
 */
import type { Scenario } from "./lib/types";

export const SCENARIOS: Scenario[] = [
  {
    id: "division-by-5-halving-strategy",
    description:
      "Strategist persona: bright kid divides by 5 via ÷10-then-×2 and wants to check their reasoning; tutor must engage with THEIR method, not dismiss it or funnel to long division — and still not confirm the answer.",
    domain: "math",
    stem: "4825 ÷ 5 = ?",
    wrongAnswers: ["964", "975"],
    correctAnswer: "965",
    persona: "strategist",
    strategy:
      "Instead of dividing by 5, divide by 10 and then double it — because dividing by 10 and doubling should undo a divide-by-5. So I did (4825 ÷ 10) × 2.",
    openingMove: "(4825/10)*2",
    entryMode: "ladder",
    scholarContext: {
      ageBand: "9-11",
      readingLevel: "5.2",
      skillStatus: "still_building",
      entryMode: "ladder",
    },
  },
  {
    id: "fraction-strategist-brand-new",
    description:
      "Strategist persona: a younger scholar brings a visual half-of-a-half idea to a brand-new fraction item.",
    domain: "math",
    stem: "What is 1/2 of 3/4?",
    wrongAnswers: ["3/6", "2/8"],
    correctAnswer: "3/8",
    persona: "strategist",
    strategy:
      "I drew three of four boxes, then split every box in half and counted the little pieces.",
    openingMove: "i split my boxes in half. does that way work?",
    entryMode: "ladder",
    scholarContext: {
      ageBand: "6-8",
      readingLevel: "3.4",
      skillStatus: "brand_new",
      entryMode: "ladder",
    },
  },
  {
    id: "spiral-brand-new-stop",
    description:
      "Spiraler persona: depleted younger scholar on a brand-new skill self-deprecates, then explicitly stops.",
    domain: "math",
    stem: "7 × 8 = ?",
    wrongAnswers: ["54"],
    correctAnswer: "56",
    persona: "spiraler",
    entryMode: "spiral",
    scholarContext: {
      ageBand: "6-8",
      readingLevel: "2.5",
      skillStatus: "brand_new",
      entryMode: "spiral",
    },
    openingMove: "i'm so dumb at this",
    scriptedTurns: { 2: "never mind" },
    planeLandingTurn: 2,
  },
  {
    id: "spiral-rusty-stop",
    description:
      "Spiraler persona: older scholar in a rough stretch on a previously demonstrated skill asks to stop.",
    domain: "math",
    stem: "500 − 246 = ?",
    wrongAnswers: ["346"],
    correctAnswer: "254",
    persona: "spiraler",
    entryMode: "spiral",
    scholarContext: {
      ageBand: "9-11",
      readingLevel: "5.8",
      skillStatus: "had_it_rusty",
      entryMode: "spiral",
    },
    openingMove: "none of these are working",
    scriptedTurns: { 2: "can we stop" },
    planeLandingTurn: 2,
  },
  {
    id: "subtraction-smaller-from-larger",
    description: "3-digit subtraction; classic 'always subtract smaller from larger' bug + a forgot-to-decrement bug.",
    domain: "math",
    stem: "452 − 187 = ?",
    wrongAnswers: ["335", "375"],
    correctAnswer: "265",
    scholarContext: {
      ageBand: "6-8",
      readingLevel: "3.1",
      skillStatus: "still_building",
      entryMode: "stuck",
    },
  },
  {
    id: "addition-dropped-carry",
    description: "3-digit addition; dropped the carry entirely, then dropped only the second carry.",
    domain: "math",
    stem: "268 + 155 = ?",
    wrongAnswers: ["313", "323"],
    correctAnswer: "423",
    scholarContext: {
      ageBand: "9-11",
      readingLevel: "5",
      skillStatus: "had_it_rusty",
      entryMode: "stuck",
    },
  },
  {
    id: "multiplication-dropped-carry",
    description: "2-digit × 1-digit multiplication; dropped the carried ten, then dropped a partial product.",
    domain: "math",
    stem: "34 × 6 = ?",
    wrongAnswers: ["184", "180"],
    correctAnswer: "204",
    scholarContext: {
      ageBand: "6-8",
      readingLevel: "2.8",
      skillStatus: "brand_new",
      entryMode: "stuck",
    },
  },
  {
    id: "multiplication-3digit-carry-slip",
    description: "3-digit × 1-digit multiplication; dropped both carries, then dropped only the second.",
    domain: "math",
    stem: "127 × 4 = ?",
    wrongAnswers: ["488", "408"],
    correctAnswer: "508",
    scholarContext: {
      ageBand: "9-11",
      readingLevel: "5.5",
      skillStatus: "solid_bad_day",
      entryMode: "stuck",
    },
  },
  {
    id: "addition-hundreds-carry-lost",
    description: "3-digit addition regrouping across two place values; drops all carries, then just the final one.",
    domain: "math",
    stem: "356 + 278 = ?",
    wrongAnswers: ["524", "534"],
    correctAnswer: "634",
    scholarContext: {
      ageBand: "6-8",
      readingLevel: "3.7",
      skillStatus: "still_building",
      entryMode: "stuck",
    },
  },
  {
    id: "subtraction-across-zero",
    description: "Borrowing across a zero (500 − 246) — a classically hard regrouping case for this age.",
    domain: "math",
    stem: "500 − 246 = ?",
    wrongAnswers: ["346", "264"],
    correctAnswer: "254",
    scholarContext: {
      ageBand: "9-11",
      readingLevel: "5.4",
      skillStatus: "had_it_rusty",
      entryMode: "stuck",
    },
  },
  {
    id: "addition-carry-to-hundreds",
    description: "2-digit addition that regroups into a new hundreds place; carry dropped, then a careless +1 slip.",
    domain: "math",
    stem: "68 + 57 = ?",
    wrongAnswers: ["115", "126"],
    correctAnswer: "125",
    scholarContext: {
      ageBand: "6-8",
      readingLevel: "3",
      skillStatus: "brand_new",
      entryMode: "stuck",
    },
  },
  {
    id: "subtraction-2digit-borrow",
    description: "2-digit subtraction with borrowing; smaller-from-larger bug, then an over-borrow bug.",
    domain: "math",
    stem: "82 − 47 = ?",
    wrongAnswers: ["45", "25"],
    correctAnswer: "35",
    scholarContext: {
      ageBand: "9-11",
      readingLevel: "4.8",
      skillStatus: "solid_bad_day",
      entryMode: "stuck",
    },
  },
  {
    id: "ela-past-tense-vs-participle",
    description: "Non-math: usage item confusing simple past with the past participle.",
    domain: "ela",
    stem: "Choose the word that correctly completes the sentence: \"Yesterday, I ___ to the store with my mom.\" (went / gone)",
    wrongAnswers: ["gone"],
    correctAnswer: "went",
    scholarContext: {
      ageBand: "6-8",
      readingLevel: "2.5",
      skillStatus: "still_building",
      entryMode: "stuck",
    },
  },
  {
    id: "science-states-of-matter",
    description: "Non-math: definite shape AND definite volume — confusing solid with liquid.",
    domain: "science",
    stem: "Which state of matter has BOTH a definite shape and a definite volume: solid, liquid, or gas?",
    wrongAnswers: ["liquid"],
    correctAnswer: "solid",
    scholarContext: {
      ageBand: "9-11",
      readingLevel: "5",
      skillStatus: "had_it_rusty",
      entryMode: "stuck",
    },
  },
];
