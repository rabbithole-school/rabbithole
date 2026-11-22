// The redaction guard for `dispatch_feature_proposal` (review/
// rabbithole-introspection-plan.html §5/§7 Phase 2). The deployment's code
// repo may be PUBLIC, and even a private proposals repo is a task PROMPT that lands
// in GitHub's systems — so the rule is "product signal only, zero data"
// (§5): a brief may describe a product problem and acceptance criteria,
// but must never carry a Convex id or a count-like quantification of real
// students (cohort sizes, percentages, "N kids", fractions).
//
// This is belt-and-suspenders (§8) on top of the bot's own judgment and
// system-prompt instruction. A false-positive just means the model has to
// rephrase; a false-negative would leak student data into a GitHub-hosted
// artifact. Pure module (no Convex imports) so it unit-tests as a plain
// function, mirroring lib/scholarReadPolicy.ts.

export type RedactionResult =
  | { ok: true }
  | { ok: false; reason: string; match: string };

// Convex document ids are long, unpunctuated, lowercase-alphanumeric
// tokens (base32-ish). 20+ contiguous chars with at least one digit is a
// good, conservative fingerprint — English prose essentially never
// produces one.
const ID_LIKE = /\b(?=[a-z0-9]*\d)[a-z0-9]{20,}\b/i;

// "N scholars/kids/teachers/…", "N%", "N out of M" / "N/M" — the count-
// like phrasing §5 singles out ("no names, no ids, no counts, no cohort
// sizes").
const COUNT_NOUN = /\b\d+(\.\d+)?\s+(scholars?|students?|kids?|children|teachers?|staff|families|parents?|cohorts?|classes?|reps?|repetitions?)\b/i;
const PERCENT = /\b\d+(\.\d+)?\s?%/;
const FRACTION_OF = /\b\d+\s*(\/|out of)\s*\d+\b/i;

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * The first known person name that appears in `brief` as a whole word, or
 * null. Each name is checked whole (e.g. "Kai Smith") and by its first word
 * (e.g. "Kai"); a first word under three letters is skipped as too noisy.
 * Matching is case-sensitive on the stored spelling, so a name that is also a
 * common word ("Will", "Hope") only matches where it is capitalized.
 */
export function findKnownName(
  brief: string,
  knownNames: readonly string[],
): string | null {
  for (const raw of knownNames) {
    const full = raw.trim().replace(/\s+/g, " ");
    if (!full) continue;
    const first = full.split(" ")[0];
    const candidates = first.length >= 3 && first !== full ? [full, first] : [full];
    for (const candidate of candidates) {
      if (candidate.length < 3) continue;
      const re = new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRegExp(candidate)}($|[^\\p{L}\\p{N}])`, "u");
      if (re.test(brief)) return candidate;
    }
  }
  return null;
}

/**
 * Reject a brief containing a Convex id, count-like real-student data, or
 * (when the caller supplies them) the name of a real person. Returns the
 * offending match so a refusal message can point at it (without needing to
 * re-scan).
 */
export function checkBriefRedaction(
  brief: string,
  opts: { knownNames?: readonly string[] } = {},
): RedactionResult {
  if (opts.knownNames && opts.knownNames.length > 0) {
    const name = findKnownName(brief, opts.knownNames);
    if (name) {
      return {
        ok: false,
        reason:
          "contains the name of a real scholar — briefs must carry product signal only, never a person's name",
        match: name,
      };
    }
  }
  const idMatch = brief.match(ID_LIKE);
  if (idMatch) {
    return {
      ok: false,
      reason:
        "looks like it contains a Convex id (a long alphanumeric token) — briefs must carry product signal only, never a record identifier",
      match: idMatch[0],
    };
  }
  const countMatch =
    brief.match(COUNT_NOUN) ?? brief.match(PERCENT) ?? brief.match(FRACTION_OF);
  if (countMatch) {
    return {
      ok: false,
      reason:
        "looks like it contains count-like data about real scholars (a number of students, a percentage, or a fraction) — describe the product problem qualitatively instead",
      match: countMatch[0],
    };
  }
  return { ok: true };
}
