/**
 * Workshop right-column copy — the SINGLE SOURCE OF TRUTH for the finalized
 * eyebrow-zone cluster (shown once idea conversations are ON) and the
 * Workshop-level mission subhead. Both frontends render these verbatim, so
 * keeping the copy here means the web WorkshopView and the native Workshop
 * screen can never drift.
 *
 * Framework-agnostic by design: NO React, NO Chakra, NO React Native imports —
 * just plain strings — exactly like shared/brand.ts. (Native consumes a
 * vendored copy under native/vendor/shared/, refreshed by
 * native/scripts/sync-vendor.js.)
 *
 * A chip is a sentence-starter, not a submitted idea: the trailing ellipsis is
 * the whole trick. Tapping a chip PRE-FILLS the Ask Rabbithole composer with
 * the phrase so the kid finishes the thought in their own words. It is an open
 * door, never pressure — no counts, no badges, nothing escalates if ignored.
 * Copy is Andy-approved and must be implemented exactly (COLUMN_BUILD_SPEC.md).
 */

/** The Workshop's mission line — a Workshop-LEVEL subhead under the screen
 *  title, spanning both columns (never a panel zone / eyebrow). Quiet register.
 *  Multi-tenant: named to the scholar's OWN school when one resolves, product-
 *  neutral otherwise — never a hardcoded school. Both frontends call this with
 *  the same scholar's institution, so the two surfaces still can't drift. */
export function workshopMissionLine(institutionName?: string | null): string {
  const belonging = institutionName
    ? `Rabbithole belongs to all of us at ${institutionName}.`
    : "Rabbithole belongs to all of us.";
  return `${belonging} The Workshop is where we build it together.`;
}

/** "You know best" — the invite (Andy's pick, Direction A). Verbatim. */
export const WORKSHOP_INVITE_EYEBROW = "You know best";
export const WORKSHOP_INVITE_LEAD =
  "You're in Rabbithole more than any of us — when something's clunky, or you wish it did something new, you notice first. So tell us.";

/** The three spark chips, in order. Trailing ellipsis (…) is intentional. */
export const WORKSHOP_SPARK_CHIPS = [
  "I have an idea…",
  "Something got in my way today…",
  "I wish Rabbithole could…",
] as const;
