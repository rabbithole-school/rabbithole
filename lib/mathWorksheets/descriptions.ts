/**
 * What each worksheet skill is, written for a parent who arrived from search:
 * the skill in plain words, what it builds on and what comes next.
 *
 * The text lives in descriptions.json, keyed by skillKey. It was drafted from
 * the skill graph and the templates' real problems and then checked against
 * both, so a description promises only what a printed sheet asks. Public copy
 * for the worksheet pages only: the tutor, the practice engine and every
 * scholar surface read the graph's own labels and notes, never this file.
 */

import COPY from "./descriptions.json";

export type SkillCopy = {
  /** One sentence, ≤ 95 characters; starts the search snippet. */
  gist: string;
  /** 2 to 4 sentences for "About this skill". */
  about: string;
};

const BY_KEY: Record<string, SkillCopy> = COPY;

export function skillCopy(skillKey: string): SkillCopy | undefined {
  return BY_KEY[skillKey];
}

/** Every key with copy, for the tests. */
export function describedSkillKeys(): string[] {
  return Object.keys(BY_KEY);
}
