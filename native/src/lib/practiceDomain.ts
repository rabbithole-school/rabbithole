/**
 * Native mirror of web `lib/practiceDomainForConcept.ts`. Maps a star/seed's
 * broad display domain (e.g. "Mathematics") to a live practice-drill domain
 * key, for the Sky's "curiosity pull" invitation — the optional "practice
 * this" link in the StarDrawer (roadmap §7/§10, review/learning-lenses-plan).
 *
 * Why a copy instead of importing the web helper: the web lib imports
 * `WHOLE_NUMBER_ARITHMETIC_DOMAIN` from `convex/seed/wholeNumberArithmeticGraph`,
 * which the native build can't resolve (native's `@convex/*` alias only reaches
 * `convex/_generated`, and `@/*` is `native/src`). The allowlist is a single,
 * rarely-changing entry, so a well-commented copy of the slug is the pragmatic,
 * low-drift choice. Keep this in sync with the web helper and the domain
 * constant if either changes.
 *
 * Deliberately conservative allowlist, NOT a fuzzy/derived mapping: only
 * domains with a real practice engine get a link. A star with no entry gets no
 * invitation — never a broken or aspirational link.
 *
 * IMPORTANT: purely additive plumbing for a curiosity-pull invite. It must
 * never gate, hide, dim, or disable a star or its Quest — "a star is never a
 * gate". Only whether the link is SHOWN depends on this mapping.
 */

// Mirrors `WHOLE_NUMBER_ARITHMETIC_DOMAIN` in
// convex/seed/wholeNumberArithmeticGraph.ts (the default practice drill).
const WHOLE_NUMBER_ARITHMETIC_DOMAIN = "whole-number-arithmetic";

// Keyed by the display domain, lowercased — case-insensitive on purpose, since
// a seed's free-text `domain` varies in casing across origins.
const PRACTICE_DOMAIN_BY_DISPLAY_DOMAIN: Record<string, string> = {
  mathematics: WHOLE_NUMBER_ARITHMETIC_DOMAIN,
};

/**
 * The practice-drill domain key for a star's display domain, or `null` when
 * there's no real drill for it yet. Callers MUST treat `null` as "show
 * nothing" — never fall back to a guessed or partial domain.
 */
export function practiceDomainForConcept(
  displayDomain: string | null | undefined,
): string | null {
  const folded = displayDomain?.trim().toLowerCase();
  if (!folded) return null;
  return PRACTICE_DOMAIN_BY_DISPLAY_DOMAIN[folded] ?? null;
}

/**
 * The effective practice-drill domain for a star: prefer the seed's stamped
 * cross-domain on-ramp target (`practiceDomain`, e.g. the fractions on-ramp →
 * "fraction-arithmetic") over the broad display-domain allowlist, so an on-ramp
 * routes into its real target and not back to whole-number arithmetic. Returns
 * `null` when neither resolves — the StarDrawer then shows no invitation.
 */
export function effectivePracticeDomain(star: {
  practiceDomain?: string | null;
  domain?: string | null;
}): string | null {
  const stamped = star.practiceDomain?.trim();
  if (stamped) return stamped;
  return practiceDomainForConcept(star.domain);
}
