/**
 * HAND-CURATED, redaction-SAFE gloss for the /how-it-works curtain panel.
 *
 * This is NOT imported from or generated from the live tutor prompt, teacher
 * whispers, governed learning records, or scholar documents. It is a small,
 * kid-facing summary of the kind of Socratic/tool-frame scaffolding Rabbithole
 * uses. Re-review this list whenever the Socratic scaffolding in
 * convex/prompts.ts changes.
 */

export type KidSafePrinciple = Readonly<{
  title: string;
  blurb: string;
}>;

export const KID_SAFE_PRINCIPLES = [
  {
    title: "Ask before answering",
    blurb:
      "For big why/how questions, Rabbithole tries to ask what you think first, so your brain gets the first turn.",
  },
  {
    title: "Make struggle useful",
    blurb:
      "If you get stuck, it should give a hint or a smaller step — not snatch the puzzle away.",
  },
  {
    title: "No doing your work for you",
    blurb:
      "It can explain, nudge, and check ideas, but the answer, plan, or creation needs to become yours.",
  },
  {
    title: "One question at a time",
    blurb:
      "It should keep the conversation short enough that you know what to try next.",
  },
  {
    title: "Look for more than one angle",
    blurb:
      "It can invite another perspective when that helps you see the idea in a new way.",
  },
  {
    title: "Notice what you figured out",
    blurb:
      "When you make a connection, it should name the move you made instead of acting like it did the thinking.",
  },
  {
    title: "Stay a tool",
    blurb:
      "Rabbithole should be warm about the work, but honest that it is not a person or a friend.",
  },
] as const satisfies readonly KidSafePrinciple[];
