// The policy, injected once into a system prompt.
export const SCHOLAR_PRONOUN_GUIDANCE =
  "**Scholar pronouns:** Default to singular they/them/their, and never infer pronouns from a name, appearance, age, voice, interests, or other personal details. Use other pronouns only when a human user has explicitly established them for that scholar in the current conversation or supplied context — never treat an earlier AI response as pronoun evidence, and fall back to they/them whenever sources conflict.";

// The same rule again, on the line where a scholar's name is injected. The
// observer had the policy above in its system prompt and still wrote "he" about
// a scholar four days later: a name at the point of generation beats a rule
// thousands of tokens earlier. Measured on the real observer path (Opus 4.8,
// 4 names x 8 samples): 16/32 generations leaked a guessed gender without this
// line, 2/32 with it. That measurement used a longer wording that also repeated
// "never infer from a name"; the clause was dropped as redundant with the
// policy constant above, which states it once in the same prompt. The
// proximity of the rule to the name is what the measurement isolated.
//
// Belongs on EVERY prompt that injects a scholar's name AND generates
// third-person prose about them — the policy constant alone is the 16/32 case.
// It shipped on the observer only (#2814), so the end-of-day check-in kept
// misgendering a scholar in Slack; it is now on all of them.
// Deliberately NOT on surfaces that write in the second person (the tutor's
// SCHOLAR NAME line, interpretive.ts's sky, sessions.ts's reflection) — those
// address the scholar directly and forbid third-person reference outright.
export const SCHOLAR_NAME_PRONOUN_HINT =
  "(pronouns unknown — default they/them)";

/** Longest stored pronoun string. Comfortably fits "she/they" and friends. */
export const MAX_PRONOUNS_LENGTH = 40;

/**
 * Normalize a staff-entered pronoun string for storage, or null to clear.
 *
 * This value is interpolated into a model-facing prompt line, so it is
 * flattened to a single line and capped: a stored newline would let roster
 * data open a new "instruction" line in the prompt.
 */
export function normalizePronouns(raw: string | null): string | null {
  if (raw === null) return null;
  const flattened = raw.replace(/\s+/g, " ").trim();
  if (flattened === "") return null;
  return flattened.slice(0, MAX_PRONOUNS_LENGTH);
}

/**
 * The parenthetical that follows an injected scholar name.
 *
 * With pronouns recorded this states them; without, it falls back to the
 * measured unknown-case hint above. STAFF-FACING GENERATORS ONLY — see the
 * `users.pronouns` comment in schema.ts for why peer- and parent-visible
 * prose deliberately stays on the universal they/them default instead.
 */
export function scholarNamePronounHint(pronouns?: string | null): string {
  const normalized = normalizePronouns(pronouns ?? null);
  return normalized
    ? `(pronouns: ${normalized} — use exactly these)`
    : SCHOLAR_NAME_PRONOUN_HINT;
}
