/**
 * Pure decision logic for the Concept Atlas's tap-to-open behavior, extracted
 * so it can be unit-tested without rendering the full `ConceptAtlasView`
 * (which needs live Convex queries + the canvas atlas engine).
 *
 * A scholar's OWN Sky always renders with `canCurate=false` — `ConceptDrawer`
 * is a teacher curation tool (facepile of who's seeded a concept, a seed/
 * destination action with a scholar picker), not something scholar-facing.
 * That means the ONLY genuinely tappable stars on a scholar's own Sky are
 * pulled-next SEED stars (`isInteractiveSeed`); every other star (demonstrated
 * mastery, standards reached) is a deliberate no-op tap there.
 *
 * `tapOpensSomething` answers "did this tap actually open something" — the
 * debut-Sky tap hint (FTUE M7: "Tap a star to open it…") must dismiss ONLY on
 * a tap that opened something, never on a no-op tap. A no-op tap dismissing
 * the hint would teach a kid the wrong lesson: tapped, nothing happened, AND
 * the instruction that told them to tap also vanished (a code-review-caught
 * regression on the first ship of this hint).
 */
export function tapOpensSomething(
  id: string,
  opts: { isInteractiveSeed: boolean; canCurate: boolean },
): boolean {
  // A seed star (pulled-next invitation) always opens the Begin Quest sheet.
  if (opts.isInteractiveSeed) return true;
  // Curator surfaces (teacher/admin, never a scholar's own Sky) open the
  // ConceptDrawer for any real concept id. Galaxy free-float seeds carry a
  // synthetic (`seed:<scholar>:<seed>`) id, not a real knowledgeNodes id —
  // hover-only, so they never open a drawer even when `canCurate` is true.
  if (opts.canCurate && !id.startsWith("seed:")) return true;
  return false;
}
