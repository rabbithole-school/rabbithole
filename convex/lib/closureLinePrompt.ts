/**
 * The model-facing spec for the GOVERNED closure-line generator
 * (convex/closureLines.ts). Lives beside the other prompt builders in
 * convex/lib/ (observerShared.ts, etc.); CLOSURE_PROMPT_VERSION is persisted
 * with each generated closure line.
 *
 * This is a CONSTRAINED REPHRASING task, not open generation: the caller hands a
 * small, already-redacted signal (skill LABELS + a coarse effort SHAPE + a few
 * booleans — never a raw score, streak, or another learner) and the model
 * returns ONE growth-framed line. The hard rules below are also enforced
 * mechanically after the fact by shared/closureGuard.ts, so a line that breaks
 * them is dropped and the deterministic fallback renders instead.
 *
 * Design ground truth: review/practice/completion-messaging-plan.html §4,
 * review/anti-parasocial-design.md, review/learner-parent-pedagogy.md.
 */

import type {
  ClosureKind,
  ClosureSignal,
  PracticeSignal,
  DailySignal,
} from "../../shared/closureLines";
import { SCHOLAR_PRONOUN_GUIDANCE } from "./scholarPronouns";

// Bump when model-visible prompt wording or cached-output eligibility rules change.
export const CLOSURE_PROMPT_VERSION = "closure-line-v3-2026-08-20";

export const CLOSURE_SYSTEM = [
  "You write ONE short closure line for a gifted elementary scholar's practice or day recap.",
  "You are a METHOD finishing a moment of work — not a character, not a friend. Name what the scholar's THINKING built, in the THIRD PERSON, about the WORK.",
  SCHOLAR_PRONOUN_GUIDANCE,
  "",
  "This is growth-mindset framing done RIGHT: celebrate the MOVEMENT on the map and the thinking as a fact about the work — never a compliment aimed at the child, never their traits.",
  "",
  "HARD RULES (a line that breaks any of these is thrown away):",
  "- No trait or caliber praise: never 'smart', 'brilliant', 'genius', 'gifted', 'a natural', 'amazing', 'best', 'perfect'.",
  "- No first person and no simulated feelings: never 'I', 'I'm', 'my', 'proud', 'excited', 'I loved', 'miss you', 'friend'. (You may say 'we'/'your' — the method and the scholar.)",
  "- No numbers of any kind: no score, count, percentage, streak, or timer.",
  "- No comparison to any other learner.",
  "- Frame a hard set as 'not yet' + where the next building starts — never as 'wrong' or 'failed'.",
  "- Every clause must map to something in the signal. Invent NO skills, topics, or facts that aren't given.",
  "- Do NOT list or name the skills. The screen already shows the full roster in a card directly beneath your line, so naming two of them is the same thing said twice — and worse, a partial version of it. Speak about the WORK and how it went (the effort shape), not about which skills they were.",
  "- At most two sentences (one is usually best). Warm, concrete, plain words a 7-10 year old reads easily.",
  "- If the signal is thin, return a short honest generic line about doing the thinking — do not pad or fabricate.",
  "",
  "Return ONLY the line itself — no quotes, no label, no preamble. One or two short emoji at the end are fine but optional.",
].join("\n");

function joinList(labels: string[]): string {
  const s = labels.filter((l) => l && l.trim().length > 0);
  if (s.length === 0) return "(none)";
  if (s.length === 1) return s[0];
  if (s.length === 2) return `${s[0]} and ${s[1]}`;
  return `${s.slice(0, -1).join(", ")}, and ${s[s.length - 1]}`;
}

const EFFORT_PHRASE: Record<string, string> = {
  steady: "steady — most of it landed",
  stretched: "stretched past the edge",
  hardSet: "a hard set — lots of not-yet",
};

/** Build the user message from the redacted signal. Only labels + the coarse
 *  shape reach the model here — the same guarantee the surfaces render under. */
export function buildClosureUserMessage(kind: ClosureKind, signal: ClosureSignal): string {
  if (kind === "practice") {
    const s = signal as PracticeSignal;
    const wrapLine =
      s.wrap === "tuneup"
        ? "This was a quick TUNE-UP (keeping already-learned skills fresh — no score is shown)."
        : s.wrap === "challenge"
          ? s.challengeMoved
            ? "This was an above-level CHALLENGE, and the scholar's frontier MOVED (cleared it)."
            : "This was an above-level CHALLENGE — a real reach past the usual work."
          : "This was a normal practice session.";
    return [
      "Write the closure line for a practice done-screen.",
      wrapLine,
      `Skills worked this run: ${joinList(s.skills)}.`,
      s.frontierSkills.length > 0
        ? `Skills tested INTO above the usual level: ${joinList(s.frontierSkills)}.`
        : "",
      `How the set went (coarse, never a score): ${EFFORT_PHRASE[s.effortShape] ?? "steady"}.`,
      "",
      "One sentence. Name the work + the movement. Not the number.",
    ]
      .filter(Boolean)
      .join("\n");
  }

  const s = signal as DailySignal;
  return [
    "Write the closure ARC for a whole-day 'Look what you did today' recap.",
    `Skills that became the scholar's own today (proven fluent): ${joinList(s.yoursNow)}.`,
    `Skills whose access opened up today (new ground on the map): ${joinList(s.newOnMap)}.`,
    `Skills practiced today: ${joinList(s.practiced)}.`,
    `Activities finished today: ${joinList(s.finished)}.`,
    "",
    "At most two sentences, connecting what led to what. Lead with the strongest movement (became-fluent > opened-access > finished > practiced).",
  ]
    .filter(Boolean)
    .join("\n");
}
