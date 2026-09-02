/**
 * FAST MATH — the ONE user-facing name for fact automaticity, in one place.
 *
 * The same activity used to answer to two names: "Fast math" (the card eyebrow,
 * the teacher grid column, the reading itself) and "Quick facts" (the practice
 * beat, the card's CTA, the loading and empty states). A scholar practicing
 * "quick facts" to raise their "fast math" had no way to know those were one
 * thing. Every scholar- and teacher-visible mention now spells it from here, so
 * the name can only ever be changed in one edit.
 *
 * Deliberately NOT renamed: internal identifiers, which are data rather than
 * copy — the `fact_sprint` segment kind, the `?quickFacts=1` practice entry
 * parameter, and the `factKey` / fact-record tables.
 */

/** Standalone or sentence-initial: headings, eyebrows, buttons, chips. */
export const FAST_MATH_NAME = "Fast math";

/** Mid-sentence, e.g. "Keep practicing fast math to prepare…". */
export const FAST_MATH_NAME_INLINE = "fast math";

/**
 * The automaticity readout — "263 of 418 facts automatic".
 *
 * The individual items stay plain "facts": the surface has already named
 * itself Fast math, and "418 fast math facts" would re-name them a third time.
 */
export function fastMathAutomaticFraction(
  automaticCount: number,
  denominator: number,
): string {
  return `${automaticCount} of ${denominator} facts automatic`;
}
