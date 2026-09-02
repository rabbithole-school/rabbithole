/**
 * The misconception-preserving instruction for scholar slide-image generation.
 *
 * Gemini receives this instead of a bare brief. The learner's brief records
 * their current thinking — a wrong arrow direction, a misplaced apex predator —
 * and that misconception is evidence for the tutor and teacher to discuss
 * later, not an error for the image model to silently erase.
 *
 * This is all that survives of the deleted "authorship guardrail" (a Haiku
 * classifier that routed briefs generate/revise before generation). Audited
 * against its complete production population 2026-08-25 it had flagged 13
 * requests — every one a decorative prop on one ELA activity whose own rubric
 * rewarded images carrying the teaching — and zero true positives, so it was
 * removed rather than tuned. If offloading protection returns here, it comes
 * as tutor judgment with assignment context, not a standalone classifier:
 * see review/image-offloading-tutor-judgment-plan.html.
 */
export function buildFaithfulSlideImagePrompt(learnerBrief: string): string {
  return `Create an image that follows the learner's brief literally.

The learner's brief records their current thinking. Preserve every stated direction, sequence, hierarchy, label, causal relationship, and role EXACTLY as written, even when it is factually or scientifically incorrect. Do not correct, normalize, improve, replace, or add conceptual content. Do not substitute a canonical textbook version. Render only the learner's model.

<learner_image_brief>
${learnerBrief}
</learner_image_brief>`;
}
