/**
 * Teacher-facing scholar-search empty-state copy — pure, framework-free.
 *
 * The teacher's roster is institution-scoped for privacy, so a search for a
 * scholar who lives in ANOTHER institution correctly returns nothing. A terse
 * "No matches." reads as product breakage ("this lost my kid"). This helper
 * builds honest, scope-aware miss copy — used by the roster rail filter
 * (`ScholarListColumn`), the ⌘K command palette (`CommandPalette`), and the
 * shared scholar picker (`ScholarPicker`) — so all three stay identical.
 *
 * PRIVACY HARD RULE: the copy NEVER discloses that the scholar exists
 * elsewhere and NEVER names any institution other than the one the teacher is
 * currently viewing. It names only the active institution (`institutionName`)
 * and nudges toward an admin — nothing about where a missing scholar might be.
 * (Web-only surfaces, so — unlike `roomCueCopy.ts` — this is not vendored to
 * the native app.)
 */

/** The active institution lens scope (mirrors `InstitutionLensScope`):
 *  a single institution vs. an admin viewing every institution at once. */
export type ScholarSearchScope = "institution" | "all";

export interface NoScholarMatchArgs {
  /** The name of the institution the teacher is currently viewing, or null
   *  when it isn't known yet (still loading / no institution resolved). */
  institutionName: string | null;
  /** "institution" = one institution in view · "all" = every institution. */
  scope: ScholarSearchScope;
  /** The command palette also searches curriculum, so its miss copy must not
   *  claim only scholars were searched. When true, the lead phrase is the
   *  scope-agnostic "Nothing by that name" and the admin nudge is qualified to
   *  "if you expected a scholar." */
  includesCurriculum?: boolean;
}

/**
 * The empty-state text for an ACTIVE-QUERY scholar-search miss.
 *
 * - Single institution in view → name it and add the "check with an admin"
 *   nudge, so the teacher understands the roster is scoped, not broken.
 * - `scope === "all"` (or no institution name yet) → a plain, generic string
 *   with no institution name and no nudge: there is genuinely nowhere else in
 *   view, so an admin nudge would be noise.
 *
 * Never emits any other institution's name or any "exists elsewhere" phrasing.
 */
export function noScholarMatchCopy({
  institutionName,
  scope,
  includesCurriculum = false,
}: NoScholarMatchArgs): string {
  const lead = includesCurriculum ? "Nothing by that name" : "No scholar named that";
  if (scope === "all" || !institutionName) {
    return `${lead}.`;
  }
  const nudge = includesCurriculum
    ? "If you expected a scholar here, check with an admin."
    : "If you expected them here, check with an admin.";
  return `${lead} at ${institutionName}. ${nudge}`;
}
