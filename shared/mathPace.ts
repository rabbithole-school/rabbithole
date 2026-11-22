/**
 * When a term's learned pace may be stated at all: the one gate the Math
 * report's drafter evidence (convex/lib/parentReport.ts → mathPaceLines) and
 * the parent Math page's "New math learned" tile both read, so a parent never
 * sees a pace on the page that the report would refuse to state.
 */

/** Fewer skills than this turning fluent in a term, and no pace is stated.
 *  Anchored on real data: scholars with almost no practice turned 5 or fewer
 *  skills fluent in a term, while every regularly practising scholar turned 26
 *  or more. */
export const MIN_FLUENT_SKILLS_FOR_PACE = 8;

/** The skills behind a term's pace: those learned in it and those that went
 *  fluent already known (the `LearnedPace` fields, convex/lib/practice/frontierGrade.ts). */
export interface PaceSkillCounts {
  learnedSkills: number;
  knownSkills: number;
}

/** True when enough skills turned fluent this term for its pace to mean anything. */
export function hasEnoughFluentSkillsForPace(pace: PaceSkillCounts | null | undefined): boolean {
  return pace != null && pace.learnedSkills + pace.knownSkills >= MIN_FLUENT_SKILLS_FOR_PACE;
}
