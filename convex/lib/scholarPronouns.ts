// The policy, injected once into a system prompt.
export const SCHOLAR_PRONOUN_GUIDANCE =
  "**Scholar pronouns:** Default to singular they/them/their, and never infer pronouns from a name, appearance, age, voice, interests, or other personal details. Use other pronouns only when a human user has explicitly established them for that scholar in the current conversation or supplied context — never treat an earlier AI response as pronoun evidence, and fall back to they/them whenever sources conflict.";

// The same rule again, on the line where a scholar's name is injected. The
// observer had the policy above in its system prompt and still wrote "he" about
// a scholar four days later: a name at the point of generation beats a rule
// thousands of tokens earlier. Measured on the real observer path (Opus 4.8,
// 4 names x 8 samples): 16/32 generations leaked a guessed gender without this
// line, 2/32 with it.
export const SCHOLAR_NAME_PRONOUN_HINT =
  "(pronouns unknown — default they/them; never infer from a name)";
