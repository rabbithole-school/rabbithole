/**
 * "Code it" missions: Python Quests a teacher can offer a scholar who has
 * become fluent on a practice skill. A mission also unlocks on its own, with
 * no teacher, for a scholar fluent on its skill by practice who has not turned
 * coding challenges off (lib/codeItUnlock.ts, questProposals.startUnlockedCodeIt).
 *
 * Each one is an ordinary Python Quest offer (questProposals.offerQuestForUser,
 * kind "python"): the scholar writes the program in the Python bench with the
 * tutor as lab partner, and the program is what they show. Nothing here is
 * practice. A mission is never graded and never moves mastery; the practice
 * engine does not know these exist.
 *
 * A mission is one line within the Quest mission limit, and it has to carry
 * three things on its own, because the bench cannot be handed starter code or
 * a task: what to write, one example call with its result, and what "done"
 * looks like. The example result is checked by the test beside this file, so
 * a mission can never state a wrong answer.
 *
 * Pure data, keyed by the skill's node key.
 */

export type CodeItMission = {
  /** The practice skill this mission extends (a `knowledgeNodes.nodeKey`). */
  skillKey: string;
  /** The Quest's name, as the scholar sees it. */
  title: string;
  /** The Quest's one-line mission. */
  mission: string;
};

/** The Quest mission and title limits (units.ts QUEST_MISSION_LIMITS and the
 *  proposal's name limit), written out because this file stays pure; a test
 *  holds them equal. */
export const CODE_IT_MISSION_MAX = 140;
export const CODE_IT_TITLE_MAX = 80;

export const CODE_IT_MISSIONS: readonly CodeItMission[] = [
  {
    skillKey: "seq_arithmetic_explicit",
    title: "seq(n): any term of a sequence",
    mission:
      "Write seq(n) for 7, 11, 15, … so seq(1) gives 7. You're done when seq(100) matches the rule you'd write on paper.",
  },
  {
    skillKey: "seq_recursive",
    title: "Loop or leap",
    mission:
      "A sequence starts at 3 and doubles. Write term(n) with a loop, then as one formula, so term(4) gives 24. Done when both agree up to n = 20.",
  },
  {
    skillKey: "series_geometric_sum",
    title: "Race the sum formula",
    mission:
      "Write total(n) that adds 1 + 2 + 4 + … for n terms with a loop, so total(4) gives 15. Done when the sum formula agrees for n up to 30.",
  },
  {
    skillKey: "series_infinite_geometric",
    title: "Adding forever",
    mission:
      "Write partial(n) that adds the first n terms of 1 + 1/2 + 1/4 + … so partial(3) gives 1.75. Done when you can say what it closes in on.",
  },
  {
    skillKey: "log_evaluate",
    title: "How many halvings?",
    mission:
      "Write halvings(n) that counts how often n halves before it drops below 1, so halvings(8) gives 4. Done when you can predict halvings(1024).",
  },
  {
    skillKey: "exp_model_doubling_halflife",
    title: "Doubling time",
    mission:
      "Write doublings(start, goal) that counts doublings until start reaches goal, so doublings(100, 3200) gives 5. Done when a log predicts it.",
  },
  {
    skillKey: "quad_complex_roots",
    title: "Roots that are not on the number line",
    mission:
      "Write roots(a, b, c) for ax² + bx + c = 0 using cmath, so roots(1, -4, 13) gives 2+3j and 2-3j. Done when it works for any quadratic.",
  },
  {
    skillKey: "cx_multiply",
    title: "Multiply complex numbers by hand",
    mission:
      "Write times(a, b, c, d) for (a+bi)(c+di) using only real numbers, so times(7, 3, 7, -3) gives (58, 0). Done when it matches Python's own.",
  },
  {
    skillKey: "fn_compose",
    title: "A function that makes functions",
    mission:
      "Write compose(f, g) that returns a new function, so compose(f, g)(3) equals f(g(3)). Done when you show compose(g, f) can differ.",
  },
  {
    skillKey: "poly_remainder_theorem",
    title: "Evaluate any polynomial",
    mission:
      "Write p(coeffs, x) that evaluates a polynomial from its coefficients, so p([1, 0, -4], 3) gives 5. Done when it finds a zero of your cubic.",
  },
];

const BY_SKILL = new Map(CODE_IT_MISSIONS.map((m) => [m.skillKey, m]));

/** The mission for a skill, or null when the skill has none. */
export function codeItMissionFor(skillKey: string): CodeItMission | null {
  return BY_SKILL.get(skillKey) ?? null;
}

/** The `ideaKey` that makes offering the same mission to the same scholar
 *  twice one offer (questProposals.offerQuestAs). */
export function codeItIdeaKey(skillKey: string): string {
  return `code-it:${skillKey}`;
}
