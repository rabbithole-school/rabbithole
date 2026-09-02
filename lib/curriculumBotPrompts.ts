// Canonical Curriculum Bot quick-actions ("commands") — one source of truth
// for the prompt text so the unit-editor "Review unit" button and the bot
// pane's empty-state suggestion chips fire the exact same ask. The bot's
// review *procedure* (rate each EQ/EU covered/weak/uncovered, propose
// missing EQs/EUs, flag Bloom's gaps) lives in the system prompt
// (convex/unitDesignerStream.ts); this is just the user-facing trigger.

/**
 * "Review this unit" — the coverage check in both directions: which EQs/EUs
 * no activity genuinely engages, and which the activities imply but the
 * lists are missing. Shipped as the system-prompt procedure in #120.
 */
export const REVIEW_UNIT_PROMPT =
  "Review this unit: check the essential questions and enduring " +
  "understandings against the activities, in both directions — which " +
  "EQs/EUs no activity genuinely engages, and which questions or " +
  "understandings the activities are building toward that are missing " +
  "from the lists. Flag Bloom's-level gaps too.";

export interface CurriculumBotSuggestion {
  /** Stable key for React lists + future analytics. */
  id: string;
  /** Short button label shown in the chip. */
  label: string;
  /** The message sent to the bot when the chip is clicked. */
  prompt: string;
}

/**
 * Suggested "commands" rendered in the unit-scoped Curriculum Bot pane's
 * empty state. Discoverable starting points for a fresh chat — extend by
 * adding entries here.
 */
export const UNIT_BOT_SUGGESTIONS: CurriculumBotSuggestion[] = [
  { id: "review-unit", label: "Review this unit", prompt: REVIEW_UNIT_PROMPT },
];

// ── Debrief bot CTAs ────────────────────────────────────────────────────
// The Debrief tab's heavyweight moves hand the bot a concrete, grounded ask
// (the activity + what real scholars actually did) so the teacher can talk
// through a design fix or a targeted follow-up instead of logging a note.

/**
 * "Improve this activity's design" — the cohort-agnostic, next-generation
 * ask. Fired from the activity Debrief's design-moves strip.
 */
export function reviseActivityPrompt(activityTitle: string): string {
  return (
    `Real scholars have now run the activity "${activityTitle}". ` +
    `Based on how it actually landed, propose 2–3 concrete revisions to ` +
    `its prompt or design to make it work better next time — and explain ` +
    `what evidence each change responds to.`
  );
}

/**
 * "Address this pattern" — a single recurring moment (a misconception that
 * keeps surfacing, a breakthrough worth designing toward). Fired from a
 * saved moment in the Debrief deck.
 */
export function designFixPrompt(
  activityTitle: string,
  momentLabel: string,
  momentExcerpt: string,
): string {
  return (
    `On the activity "${activityTitle}", real scholars hit this: ` +
    `"${momentLabel}" — ${momentExcerpt}. ` +
    `Is this a design problem with the activity? If so, propose a concrete ` +
    `revision to prevent it, and a short follow-up task for the scholars who ` +
    `struggled with it.`
  );
}
