// Shared copy + tiny pure helpers for the "finish-the-check-in" scholar
// SURFACES (PR2): the Home CTA card, the multi-domain check-in's per-item
// domain chip, and the completion/growth map reveal.
//
// Framework-free so web (components/practice/CheckInHomeCard.tsx,
// components/practice/Placement.tsx, components/practice/MapCompletionCard.tsx)
// and native (native/src/components/practice/CheckInHomeCard.tsx,
// native/src/components/practice/NativePlacement.tsx,
// native/src/components/MapCompletionCard.tsx) render the EXACT same words —
// never a drift copy. Each frontend supplies its own arrow glyph (web: an
// <ArrowRight/> icon after the label; native: a trailing "→"), mirroring the
// existing convention in shared/checkInResultCta.ts.
//
// Sentence case throughout (.claude/rules/visual-design.md).
//
// "Mapped = a CONVERGED placement run" (never mastery-row existence); M counts
// only grade-eligible domains. See convex/lib/practice/domainMapStatus.ts.
//
// NOT here: the check-in's own per-sitting pause screen copy ("Great mapping
// today"). That string is deliberately inlined in BOTH frontends because
// shared/checkInPauseVerdictMerge.test.ts is a source-content drift guard that
// reads the two component files — hoisting it into a constant would blind the
// guard to a deletion, which is the exact regression it exists to catch.

// ── Surface 1 — the Home CTA card ("N of M domains mapped") ────────────────

export const CHECK_IN_HOME_TITLE = "Math check-in";

export function checkInHomeSubtitle(mapped: number, eligible: number): string {
  return `${mapped} of ${eligible} domains mapped`;
}

/** No arrow glyph — each frontend appends its own (see file header). "Start"
 *  until the scholar has answered a probe anywhere; "Continue" after (brief
 *  Surface 1). */
export function checkInHomeCta(started: boolean): string {
  return started ? "Continue check-in" : "Start check-in";
}

/** The CTA is an accelerator, not a fixture (decision 5): render ONLY while
 *  there is real servable work left, and disappear PERMANENTLY once every
 *  eligible domain has converged. `hasServable` is a NARROWING of the brief's
 *  `eligibleCount > mappedCount` — it additionally excludes the case where the
 *  only unmapped domains are prereq-`queued`, so the CTA can never open a
 *  check-in with nothing to serve. Shared so a web/native divergence in "when
 *  do we show this" can't happen.
 *
 *  `started` is the OTHER half of "accelerator, not a fixture", and it is what
 *  keeps this card from doubling the day-1 CTA. The never-started state already
 *  has a canonical rendering: the playlist card's own pre-placement skin
 *  ("Math check-in" + "A few math questions to find where to start…" +
 *  "Start check-in") in PlaylistCard / PracticePlaylistCard, which is the
 *  richer home for a scholar who has never seen a check-in AND is literally the
 *  surface that becomes their daily playlist. Before this conjunct, a cold-start
 *  scholar got BOTH cards stacked, each titled "Math check-in", each with a
 *  "Start check-in" button (observed on the test iPad, 2026-08-19; shipped by
 *  #2430, which mounted this accelerator above a playlist whose cold-start state
 *  was already a complete check-in card). That is the T1 double this gate
 *  forbids: ONE canonical rendering per signal.
 *
 *  The handoff is exact, because the playlist card retires its check-in skin on
 *  the SAME signal — `effectiveNeedsPlacement = needsPlacement && !forceChooser`,
 *  and `forceChooser` folds in `mapProgress.started`. So the fat card owns the
 *  never-started state, this accelerator owns every state after the first probe,
 *  and they can never both be a check-in. */
export function showCheckInHomeCard(
  progress:
    | { hasServable: boolean; allMapped: boolean; started: boolean }
    | null
    | undefined,
): boolean {
  return (
    !!progress && progress.hasServable && !progress.allMapped && progress.started
  );
}

// ── Surface 2 — the multi-domain check-in ──────────────────────────────────

/** The per-item domain chip, shown only in the mixed (multi-domain) check-in
 *  so the scholar sees when the subject switches. Reuses the playlist's
 *  `· mapping` reasonTag vocabulary so the check-in reads as MAPPING, never as
 *  a test. */
export function checkInDomainChipLabel(domainLabel: string): string {
  return `${domainLabel} · mapping`;
}

// ── Surface 4 — completion / growth reveal cards ────────────────────────────

export const MAP_COMPLETE_TITLE = "Your map is ready ✨";

export function mapCompleteBody(eligible: number): string {
  return `All ${eligible} domains mapped. Every question from here starts from where you actually are.`;
}

/** No arrow glyph — see file header. */
export const MAP_COMPLETE_CTA = "See your map";

export const MAP_GROWTH_TITLE = "A new domain appeared on your map";

export function mapGrowthBody(
  domainLabel: string,
  mapped: number,
  eligible: number,
): string {
  return `${domainLabel} just opened up for you. Your map: ${mapped} of ${eligible} domains mapped.`;
}

/** No arrow glyph — see file header. Framed as expansion, never "your
 *  check-in is incomplete again" (decision 5 / brief Surface 4). */
export const MAP_GROWTH_CTA = "Map it";
