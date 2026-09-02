// The policy, injected once into a system prompt.
export const SCHOLAR_PRONOUN_GUIDANCE =
  "**Scholar pronouns:** Default to singular they/them/their, and never infer pronouns from a name, appearance, age, voice, interests, or other personal details. Use other pronouns only when a human user has explicitly established them for that scholar in the current conversation or supplied context — never treat an earlier AI response as pronoun evidence, and fall back to they/them whenever sources conflict.";

// The same rule again, on the line where a scholar's name is injected. The
// observer had the policy above in its system prompt and still wrote "he" about
// a scholar four days later: a name at the point of generation beats a rule
// thousands of tokens earlier. Measured on the real observer path (Opus 4.8,
// 4 names x 8 samples): 16/32 generations leaked a guessed gender without this
// line, 2/32 with it.
//
// Belongs on EVERY prompt that injects a scholar's name AND generates
// third-person prose about them — the policy constant alone is the 16/32 case.
// It shipped on the observer only (#2814), so the end-of-day check-in kept
// misgendering a scholar in Slack; it is now on all of them.
// Deliberately NOT on surfaces that write in the second person (the tutor's
// SCHOLAR NAME line, interpretive.ts's sky, sessions.ts's reflection) — those
// address the scholar directly and forbid third-person reference outright.
export const SCHOLAR_NAME_PRONOUN_HINT =
  "(pronouns unknown — default they/them; never infer from a name)";
