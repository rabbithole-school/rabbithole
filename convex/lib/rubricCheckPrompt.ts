/**
 * rubricCheckPrompt — the model-facing strings of the "Submit & check" rubric
 * judge (`checkRubric` in convex/deliverables.ts).
 *
 * Extracted VERBATIM out of the action handler so an eval harness can drive
 * the exact prompt production sends instead of a hand-rolled paraphrase of it
 * (the repo's standing lesson: a probe that differs from the shipped path
 * manufactures phantom results). Same shape as convex/lib/rubricScoreTool.ts,
 * which does this for the tutor-side `update_rubric_score` path.
 *
 * Pure: no ctx, no db, no network. `checkRubric` is the only production
 * caller; evals/rubric-check is the only other one.
 *
 * NOTE for future editors: changing anything in here changes how real
 * scholars' work is graded. It is prompt surface, not plumbing.
 */
import {
  DEFAULT_INSTITUTION_PROMPT_PROFILE,
  type InstitutionPromptProfile,
} from "./institutionPromptProfile";
import { writingMechanicsPolicy } from "./writingMechanicsPolicy";
import { levelsPromptLine } from "./readingLevels";
import {
  renderCriteriaForRubricCheck,
  type DeliverableCriterion,
} from "./deliverable";

export const buildRubricSystemPrompt = (
  profile: InstitutionPromptProfile = DEFAULT_INSTITUTION_PROMPT_PROFILE,
): string => `You evaluate a scholar's deliverable against an explicit rubric. The scholar is a gifted elementary-age child at ${profile.schoolName}. Be DIRECT and HONEST. Do not be sycophantic.

Your job: judge each numbered criterion individually, then give an overall verdict. Critique is the point — when something misses a criterion, say so clearly and specifically. When it lands, acknowledge it concisely and move on.

Per-criterion verdicts:
- "full"  — the criterion is met as written.
- "half"  — partially met. Something concrete is still missing or imprecise.
- "not"   — not met at all, or the submission is off-topic for this criterion.

Overall:
- "full"  — every criterion is "full". This is a PASS.
- "half"  — at least one criterion is "half" or "not", but the submission shows real engagement. Scholar should revise.
- "not"   — the submission doesn't engage with the rubric at all.

Tone:
- Speak to the scholar in second person.
- Respectful but not coddling. Bright kids handle — and want — honest feedback.
- No reflexive praise. Avoid "Great job!", "Nice effort!", "I love that you...", "I appreciate...", or any other empty validation.
- Specific beats generic. "Your explanation of lift conflates Bernoulli's principle with Newton's third law" beats "Your physics could be clearer."
- Per-criterion notes are 1 sentence each. The summary is 1–3 short paragraphs.

Calibration:
- Apply each criterion as written (the one exception is the writing-conventions policy in the request, which wins for spelling, punctuation and typing). If a criterion demands specifics, vague answers don't earn "full". If it demands a count (e.g., "3-5 sentences"), enforce it.
- At the boundary, lean toward "half" with a specific path forward — not "full" with hedging. Re-submission is unlimited; honest "almost, here's what's missing" is more useful than a wishy-washy pass.
- If the scholar wrote something clever but off-topic for the criterion, that's "not" or "half" — acknowledge the cleverness briefly, redirect to what was asked for.
- Length isn't quality. A short tight answer can be "full"; a long meandering one can be "half".

You MUST call the report_rubric_check tool with your verdicts. Do not respond with raw text.`;

/**
 * The user turn `checkRubric` sends alongside the system prompt above:
 * activity framing, the deliverable prompt, the optional reading-level
 * calibration line, the numbered rubric, the optional per-scholar angle, and
 * the submission itself. Assembled exactly as the action handler did inline.
 */
export function buildRubricCheckUserMessage(input: {
  activityTitle: string;
  activityDescription?: string | null;
  deliverablePrompt: string;
  /** Null/absent drops the calibration line entirely — as in production. */
  readingLevel?: string | null;
  criteria: DeliverableCriterion[];
  angle?: { title: string; description: string } | null;
  submissionText?: string | null;
  /**
   * The activity's `assessesWritingMechanics` flag. Unset/false (the default)
   * tells the judge that spelling, punctuation and typing never move a
   * verdict — dictated work earns full credit (TRA-502).
   */
  assessesWritingMechanics?: boolean | null;
}): string {
  // Per-scholar angle (if this activity has scholar angles).
  const angleLine = input.angle
    ? `\n\nThe scholar's chosen angle: ${input.angle.title} — ${input.angle.description}`
    : "";

  const rubricBlock = renderCriteriaForRubricCheck(input.criteria);
  const readingLevelLine = input.readingLevel
    ? `${levelsPromptLine(input.readingLevel)}. CALIBRATE level-dependent criteria (length, vocabulary) to the talk level${input.assessesWritingMechanics === true ? "; calibrate mechanics to how they read and write (the read and write levels), never to the talk level" : ""} — but apply level-INDEPENDENT criteria (specificity, structure, engagement, originality) at the same bar regardless of level. Don't grade-inflate.`
    : null;
  return [
    `Activity: ${input.activityTitle}${input.activityDescription ? ` — ${input.activityDescription}` : ""}`,
    `Deliverable prompt: ${input.deliverablePrompt}`,
    readingLevelLine,
    writingMechanicsPolicy(input.assessesWritingMechanics),
    `RUBRIC (numbered criteria — return one verdict per id):`,
    rubricBlock,
    angleLine ? angleLine : null,
    "",
    "── The scholar's submission ──",
    input.submissionText ?? "(non-text deliverable; see attached content if present)",
  ]
    .filter((s) => s !== null)
    .join("\n");
}
