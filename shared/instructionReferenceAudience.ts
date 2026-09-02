/**
 * Audience gate for the on-demand instructional REFERENCE placement
 * (instructional-content-plan §4.3 "See the move", NodeDrawer.tsx).
 *
 * Same doctrine as the teacher-preview offer guard in
 * `practiceSkills.resolveRunLaunchpad` (its `isSelf` parameter): only the
 * SCHOLAR'S OWN open may write telemetry. A teacher or parent viewing a
 * scholar's node drawer must be able to see the SAME reference content
 * read-only, but their open must never mint or append to that scholar's
 * `instructionEvents` ledger — a teacher/parent browsing many scholars would
 * otherwise silently spend/pollute a signal that is documented SYSTEM-ONLY and
 * scholar-scoped.
 *
 * Deliberately identity-first, not just label-first: some NodeDrawer callers
 * (e.g. the teacher `/teacher/markers` cell-detail surface) never pass an
 * `audience` prop at all, so gating on `audience === "scholar"` alone would
 * silently pass an unlabeled teacher view through. Checking
 * `viewerId === scholarId` is the load-bearing condition; the explicit
 * `"teacher"`/`"parent"` exclusion is defense in depth for a mislabeled call
 * site.
 *
 * UNIFIED, not just a client-side convenience: `convex/instruction.ts`'s
 * `requireScholarSelf` calls this SAME function (server-side, no `audience`
 * arg — a mutation has no redaction label) to reject a teacher/parent's
 * direct `recordInstructionRetrieval` write, even one with otherwise-valid
 * teacher-of-scholar access. One identity check, enforced at both the UI gate
 * (`logRetrieval`) and the server write gate — never two divergent copies.
 */
export function isSelfScholarReference(params: {
  /** The signed-in viewer's own user id, or undefined/null if not resolved yet. */
  viewerId: string | null | undefined;
  /** The scholar the drawer is showing (the `scholarId` prop), if any. */
  scholarId: string | null | undefined;
  /** The drawer's redaction-overlay audience label, if the caller set one. */
  audience?: "scholar" | "teacher" | "parent";
}): boolean {
  if (!params.scholarId || !params.viewerId) return false;
  if (params.audience === "teacher" || params.audience === "parent") return false;
  return params.viewerId === params.scholarId;
}
