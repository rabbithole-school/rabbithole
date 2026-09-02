// The check-in RESULT-screen CTA copy (f14), plus the quiet mid-flow EXIT
// affordance (pilot7 f18 finding).
//
// Finishing the Math Check-In takes the scholar HOME — where the Tree-reveal
// moment card and the playlists chooser land — rather than dumping them straight
// into more practice ("felt punitive"). The button's copy is honest about that
// destination AND reflects the once-only Tree reveal that is about to greet them
// on home: while the reveal is still pending (the first check-in, which just
// unlocked the Tree) it invites them to "See what you unlocked"; once the reveal
// has already been shown (a later re-placement) it's a plain "Back to home".
//
// Framework-free + shared so web (components/practice/Placement.tsx) and native
// (native/src/components/practice/NativePlacement.tsx, via the vendored copy)
// render the EXACT same words — never a drift copy. Each frontend appends its
// own arrow affordance (web: an <ArrowRight/> icon; native: a trailing "→").

export function checkInResultCtaLabel(treeRevealPending: boolean): string {
  return treeRevealPending ? "See what you unlocked" : "Back to home";
}

// ── The mid-flow quiet exit (pilot7 f18 finding) ─────────────────────────
//
// pilot7 (a simulated 7-year-old blind runner) found NO way out of the
// check-in screens other than the browser's own Back button — there was no
// visible leave/Home affordance anywhere before the result screen. Placement
// state is fully resumable server-side (the server persists the served probe
// + every graded answer), so leaving mid-flight is always safe; the fix is a
// small, understated text link — never a prominent button that would read as
// an invitation to bail — that routes home.

/** The quiet exit link's label — deliberately soft/non-alarming, never
 *  "Leave" or "Quit" (this isn't an error state, and the check-in isn't a
 *  trap). Shared so web + native render the identical words. */
export const CHECK_IN_EXIT_LABEL = "I'll come back later";

/** Whether the quiet exit link should render at all on a given check-in
 *  screen. Only for a REAL scholar's own check-in (`homeHref` set) — a
 *  teacher's remote rehearsal has no home to exit to and keeps its existing
 *  `onDone` fallback flow unchanged (mirrors the result screen's own
 *  `homeHref` gate, so the two CTAs can never disagree about when a "home"
 *  destination exists). */
export function checkInExitVisible(homeHref: string | null): boolean {
  return homeHref != null;
}
