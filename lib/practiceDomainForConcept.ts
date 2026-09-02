/**
 * Maps a star/seed's display domain (a broad academic discipline like
 * "Mathematics" — see the domain guidance in convex/prompts.ts §"Concept
 * labels and domains") to a live practice-drill domain key, for the sky's
 * "curiosity pull" invitation (an optional "practice this" link in the star
 * drawer — roadmap §7/§10, review/learning-lenses-plan.html).
 *
 * Deliberately conservative allowlist, NOT a fuzzy/derived mapping: only
 * domains that have a real practice engine behind them get a link. A star
 * with no entry here gets no invitation at all — never a broken or
 * aspirational link. Extend this map as more domains grow a drill.
 *
 * IMPORTANT: this is purely additive plumbing for a curiosity-pull invite. It
 * must never be used to gate, hide, dim, or disable a star or its Quest —
 * "a star is never a gate" (roadmap §7). Only whether a link is SHOWN depends
 * on this mapping; the star itself is always visible and always launchable.
 */

import { WHOLE_NUMBER_ARITHMETIC_DOMAIN } from "@/convex/seed/wholeNumberArithmeticGraph";

// Keyed by the display domain, lowercased — case-insensitive on purpose,
// since seeds' `domain` free-text can vary in casing across origins (AI
// observer, teacher-authored, dev fixtures).
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
 * The practice-drill href (`/scholar/practice?domain=…`) for a star's display
 * domain, or `null` when there's no drill to link to.
 */
export function practiceHrefForConcept(
  displayDomain: string | null | undefined,
): string | null {
  const domain = practiceDomainForConcept(displayDomain);
  return domain ? `/scholar/practice?domain=${encodeURIComponent(domain)}` : null;
}

/**
 * The practice-drill href for a KNOWN practice-domain slug (e.g. a seed's
 * stamped `practiceDomain` — the cross-domain on-ramp target). Unlike
 * `practiceHrefForConcept`, this takes a real drill-domain key directly (not a
 * broad display domain), so it never consults the allowlist. Returns `null`
 * only for an empty slug.
 */
export function practiceHrefForDomain(
  practiceDomain: string | null | undefined,
): string | null {
  const slug = practiceDomain?.trim();
  return slug ? `/scholar/practice?domain=${encodeURIComponent(slug)}` : null;
}
