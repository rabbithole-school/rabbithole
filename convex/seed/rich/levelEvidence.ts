// Fictional evidence behind the profile's Talk / Read / Write rows (TRA-515),
// for ONE dev-cast scholar, so a branch preview shows every evidence line and
// the growth chart. Written by `reconcileLevelEvidenceFixture`
// (seedRichCohort.ts), which refreshes it on every seed — outside the cohort's
// skip-guard — so its "last 7 days" lines never go stale.

/** Keoni (K, talk 1) becomes a by-voice beginner reader. */
export const LEVEL_EVIDENCE_SCHOLAR = "keoni_alama";

/**
 * Five tutor sessions, each with the observer's talk judgment. Turns are
 * mostly dictated, as a by-voice beginner's are.
 */
export const levelEvidenceSessions: {
  title: string;
  talkLevel: string;
  turns: { content: string; spoken: boolean }[];
}[] = [
  {
    title: "Why do frogs live by ponds?",
    talkLevel: "1",
    turns: [
      { content: "frogs like water because their skin gets dry", spoken: true },
      { content: "frog", spoken: false },
    ],
  },
  {
    title: "Building a fox den",
    talkLevel: "2",
    turns: [
      { content: "the fox digs a den so the babies stay warm and hidden", spoken: true },
      { content: "the den has two doors in case something comes in", spoken: true },
    ],
  },
  {
    title: "How tall can a tree get?",
    talkLevel: "2",
    turns: [
      { content: "trees get enormous because they keep growing every year", spoken: true },
      { content: "big tree", spoken: false },
    ],
  },
  {
    title: "Ships and why they float",
    talkLevel: "3",
    turns: [
      { content: "a ship floats because it pushes the water out of the way", spoken: true },
      { content: "if it is heavy it sinks deeper but it still floats", spoken: true },
    ],
  },
  {
    title: "Pigs in the mud",
    talkLevel: "2",
    turns: [{ content: "pigs roll in mud to stay cool", spoken: true }],
  },
];

/**
 * Your-turn lines read aloud in the latest session, as `compareReading` would
 * score them. "ship" read as "sip" twice → the Read row names "sh".
 */
export const levelEvidenceReadAlouds: {
  line: string;
  heard: string;
  words: number;
  matched: number;
  attempted: boolean;
  missedUnits: string[];
}[] = [
  { line: "Can a pig dig?", heard: "can a pig dig", words: 4, matched: 4, attempted: true, missedUnits: [] },
  { line: "A ship is big.", heard: "a sip is big", words: 4, matched: 3, attempted: true, missedUnits: ["sh"] },
  { line: "Kits nap.", heard: "kits nap", words: 2, matched: 2, attempted: true, missedUnits: [] },
  { line: "A ship can sit.", heard: "a sip can sit", words: 4, matched: 3, attempted: true, missedUnits: ["sh"] },
  { line: "Dig, dig, dig!", heard: "dig dig dig", words: 3, matched: 3, attempted: true, missedUnits: [] },
  { line: "Can I sip it?", heard: "I can't read that", words: 4, matched: 0, attempted: false, missedUnits: [] },
];
