/**
 * Pure helpers for turning a Web Assignment session's captured metadata
 * (`webActivitySessions.extracted`) into the input for a cheap Haiku pass
 * that writes the one-line `summary` shown on the teacher card.
 *
 * Kept pure + here (not in the action) so the prompt input is
 * unit-testable and the action (convex/webActivitySummary.ts) stays a thin
 * wrapper around the model call. The deterministic course label the card
 * always shows is trivial enough to live inline in the card.
 *
 * Tests: convex/__tests__/webSessionSummary.test.ts
 */

import { SCHOLAR_PRONOUN_GUIDANCE } from "./scholarPronouns";

export type WebSessionExtract = {
  xpToday?: number;
  xpGoal?: number;
  courseName?: string;
  percentComplete?: number;
  tasksCompletedToday?: number;
  taskSummaries?: string[];
} | null | undefined;

/** Did this session capture anything worth an LLM summary? */
export function webSessionHasContent(e: WebSessionExtract): boolean {
  if (!e) return false;
  return (
    (typeof e.tasksCompletedToday === "number" && e.tasksCompletedToday > 0) ||
    (typeof e.xpToday === "number" && e.xpToday > 0)
  );
}

/**
 * Compact, model-friendly fact block describing the session. Null when
 * there's nothing meaningful (caller skips the LLM call so we don't burn a
 * token to say "did nothing"). Deliberately terse — Haiku turns it into one
 * sentence.
 */
export function webSessionFacts(e: WebSessionExtract): string | null {
  if (!webSessionHasContent(e) || !e) return null;
  const lines: string[] = [];
  if (e.courseName?.trim()) lines.push(`Course: ${e.courseName.trim()}`);
  if (typeof e.xpToday === "number" && typeof e.xpGoal === "number") {
    const met = e.xpGoal > 0 && e.xpToday >= e.xpGoal;
    lines.push(
      `XP today: ${e.xpToday}/${e.xpGoal}${met ? " (daily goal met)" : ""}`,
    );
  }
  if (typeof e.tasksCompletedToday === "number") {
    lines.push(`Tasks completed today: ${e.tasksCompletedToday}`);
  }
  if (e.taskSummaries && e.taskSummaries.length > 0) {
    lines.push("Tasks:");
    for (const t of e.taskSummaries.slice(0, 15)) lines.push(`- ${t}`);
  }
  return lines.length > 0 ? lines.join("\n") : null;
}

/** Haiku system prompt — kept here so it's reviewable + stable. */
export const WEB_SUMMARY_SYSTEM =
  `${SCHOLAR_PRONOUN_GUIDANCE}\n` +
  "You summarize a student's external-practice session (e.g. a math-fluency site) " +
  "for their teacher, in ONE concise factual sentence (max ~25 words). " +
  "Use only the structured data given. Name the topics worked on when listed. " +
  "Mention XP earned vs the daily goal when present. " +
  "No praise, no encouragement, no second person, no quotes, no trailing fluff. " +
  "Example: Completed 3 fourth-grade lessons on fraction comparison and prime numbers, earning 21 of 15 daily XP (goal met).";

/** Clean a model's reply into a stored one-liner (or null if unusable). */
export function cleanSummary(raw: string): string | null {
  const cleaned = raw
    .trim()
    .replace(/[\r\n]+/g, " ")
    .replace(/^["'`]+|["'`]+$/g, "")
    .trim();
  if (!cleaned || cleaned.length > 280) return null;
  return cleaned;
}
