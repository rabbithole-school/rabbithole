/**
 * writingMechanicsPolicy — the ONE sentence-block every assessor of a scholar's
 * written work shares about spelling, punctuation, capitalization, handwriting
 * and typing.
 *
 * Andy's ruling (2026-10-11, TRA-502): dictation is a first-class input method
 * for any activity that is not explicitly about spelling or typing. A scholar
 * who dictates into the writing box produces text with no record of how it got
 * there (the box carries no per-document modality), and speech-to-text output
 * arrives punctuated and spelled by the engine, not the child — so judging
 * mechanics anywhere else would grade the transcription engine, or punish the
 * child who chose the mic. The default is therefore "mechanics never move a
 * verdict", and an activity opts back in with `assessesWritingMechanics`.
 *
 * A criterion that is ONLY about conventions cannot be assessed on an unflagged
 * activity, so the judge sets it aside: `full` (so `overall` and completion
 * still pass) plus `waived: true`, which `mintFlair` honours by awarding no
 * flair for it (convex/deliverables.ts).
 *
 * Pure: no ctx, no db, no network. Callers: the Check-my-work judge
 * (rubricCheckPrompt.ts), the scan/photo assessor (deliverableAssess.ts), the
 * tutor's rubric-scoring section (sessionHelpers.ts) and the per-scholar
 * criteria generator (deliverables.ts). Keeping the wording here is what keeps
 * those four consistent.
 */

/** Unflagged (the default): spelling and typing never lower a verdict. */
export const WRITING_MECHANICS_NOT_ASSESSED = `Writing conventions: spelling, punctuation, capitalization, handwriting neatness and typing accuracy are NOT part of how this work is judged, and they must never lower a verdict. Scholars here write by typing, by dictating with the microphone, or by hand on paper, and dictation is a first-class way to write: dictated words are the scholar's own words and earn full credit. Dictated, young or handwritten work often has little or no punctuation, run-on sentences, or invented spelling — read through all of that to the meaning. Judge what the scholar communicated (ideas, evidence, structure, reasoning). This overrides "apply each criterion as written" for conventions only. If a criterion is only about spelling, punctuation, capitalization, typing, handwriting, neatness or "mechanics", this activity does not assess it: give that criterion "full", set waived to true on it, and say in its note that conventions are not assessed here — never "half" or "not" for it. If a criterion mixes conventions with other things, judge it on the other things alone (and do not set waived).`;

/** Flagged: the activity is explicitly about spelling and/or typing. */
export const WRITING_MECHANICS_ASSESSED = `Writing conventions: this activity is explicitly about spelling and/or typing, so spelling, punctuation, capitalization and typing accuracy ARE assessed here, exactly as the rubric describes them (calibrated to how the scholar reads and writes, their read and write levels, never to their talk level). Apply those criteria on their merits. A criterion that is not about mechanics is still judged on meaning alone. Do not set waived.`;

/** Criteria generator, flagged activity. */
export const WRITING_MECHANICS_CRITERIA_ALLOWED =
  "This activity is explicitly about spelling and/or typing: one criterion may cover writing mechanics (spelling, punctuation, capitalization, typing accuracy), calibrated to how the scholar reads and writes (their read and write levels), never to their talk level.";

/** Criteria generator, unflagged activity (the default). */
export const WRITING_MECHANICS_CRITERIA_FORBIDDEN =
  "Do NOT write a criterion about spelling, punctuation, capitalization, handwriting, typing or neatness: scholars here may dictate their writing, and dictation is a first-class way to write. Every criterion is about the ideas, evidence, structure and reasoning.";

/**
 * The policy block for an activity. `undefined`/`null`/`false` all mean "not
 * flagged" — the field is optional and an unset value is the default.
 */
export function writingMechanicsPolicy(
  assessesWritingMechanics: boolean | null | undefined,
): string {
  return assessesWritingMechanics === true
    ? WRITING_MECHANICS_ASSESSED
    : WRITING_MECHANICS_NOT_ASSESSED;
}
