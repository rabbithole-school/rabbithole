/**
 * What a Custom Quest is ABOUT, read from both fields the scholar typed.
 *
 * The Custom Quest dialog (web + native) has a title ("e.g. Why do octopuses
 * have 3 hearts?") and an optional "a little more" description. Young
 * scholars often put their own NAME in the first field and the real idea in
 * the second. Taking the title alone as the topic then designs a whole quest
 * around the name: a K–2 scholar who titled a quest with their name (which is
 * also an ordinary word) and described a dragon game got a four-step quest
 * about the ordinary word, and the tutor faithfully parked the dragon game as
 * off-mission (2026-10).
 *
 * So the bake and the path menu (`bakePaths.suggestBakePaths`) both read the
 * topic through here:
 *   - no description → the title is the topic (unchanged);
 *   - the title is just the scholar's own name/username → the description is
 *     the topic;
 *   - a one-word title → both together, "title: description", so a label
 *     ("Pebble: a dragon matching game") no longer outranks the idea, while a
 *     real one-word topic keeps its referent ("Sharks: I like them");
 *   - otherwise → title is the topic, description is steering (unchanged).
 */

type ScholarNames = {
  name?: string;
  firstName?: string;
  username?: string;
} | null;

/** Lowercase, letters/digits only — so "Kai!" and "kai" compare equal. */
function norm(s: string): string {
  return s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
}

function scholarNameKeys(scholar: ScholarNames): Set<string> {
  const keys = new Set<string>();
  if (!scholar) return keys;
  // First names only (plus the whole name and username): a surname like
  // "Rivers" is too often a real topic word.
  for (const raw of [scholar.name, scholar.firstName, scholar.username]) {
    if (raw) keys.add(norm(raw));
  }
  for (const raw of [scholar.name, scholar.firstName]) {
    const first = raw?.trim().split(/\s+/)[0];
    if (first) keys.add(norm(first));
  }
  keys.delete("");
  return keys;
}

export function customQuestTopic(
  title: string,
  description: string | null | undefined,
  scholar: ScholarNames,
): { topic: string; rationale: string | null } {
  const t = title.trim();
  const d = description?.trim() || null;
  if (!d) return { topic: t, rationale: null };

  if (scholarNameKeys(scholar).has(norm(t))) {
    return { topic: d, rationale: null };
  }

  if (!/\s/.test(t)) return { topic: `${t}: ${d}`, rationale: null };

  return { topic: t, rationale: d };
}
