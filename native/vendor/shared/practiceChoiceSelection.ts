/**
 * The framework-free select-and-recompose logic for the scholar-home "Today's
 * Math Playlists" tile row (raise-the-ceiling §C-2 follow-up: tiles used to
 * read as launch buttons that showed one set but served another — "what you
 * see isn't what you'll start". Now the tiles are peer SELECTIONS — Today's
 * blend + up to 3 strand cards — and picking one recomposes the preview below
 * before anything launches). BOTH surfaces share this:
 *   • web    — components/practice/PlaylistCard.tsx
 *   • native — native/src/components/practice/PracticePlaylistCard.tsx (via
 *              the vendored copy under native/vendor/shared/, synced by
 *              native/scripts/sync-vendor.js)
 *
 * Two pure concerns, deliberately kept out of either component so the
 * select/deselect toggle and the CTA copy can never drift between platforms:
 *   1. `nextTileSelection` — the peer-tile tap rule: tapping "Today's blend"
 *      always selects the blend; tapping a strand card selects it, unless
 *      it's already the current selection, in which case tapping it AGAIN
 *      deselects back to the blend (folds the old "tap-again to deselect"
 *      affordance into the same tap, now that the blend is itself a sibling
 *      tile instead of a separate ✕ control).
 *   2. `deriveStartCta` — the CTA's verb + trailing decoration ("→" or "?")
 *      + primary/secondary emphasis. A picked strand always reads
 *      "Start with <headline>" + "→" — an explicit, unambiguous action,
 *      regardless of the blend's caught-up/continue state; the blend keeps
 *      its existing verb ladder (Start check-in / Practice more / Continue /
 *      Start) unchanged.
 *
 * Imports nothing so it resolves standalone under Metro when vendored.
 */

export type PlaylistChoiceCard = {
  domain: string;
  strand: string;
};

/** `null` means "Today's blend" (the default set) is the active selection. */
export type PlaylistTileSelection<Card extends PlaylistChoiceCard> = Card | null;

function sameCard<Card extends PlaylistChoiceCard>(a: Card, b: Card): boolean {
  return a.domain === b.domain && a.strand === b.strand;
}

/**
 * The peer-tile tap rule. `tapped` is `"blend"` for the "Today's blend" tile,
 * or the strand card that was tapped. Selecting the already-selected strand
 * card again deselects back to the blend; anything else just selects what was
 * tapped (a single-select radio group, not independent per-tile toggles).
 */
export function nextTileSelection<Card extends PlaylistChoiceCard>(
  current: PlaylistTileSelection<Card>,
  tapped: "blend" | Card,
): PlaylistTileSelection<Card> {
  if (tapped === "blend") return null;
  if (current && sameCard(current, tapped)) return null;
  return tapped;
}

/**
 * The scholar's EFFECTIVE domain set today — a teacher's mixed pin (≥2
 * domains), a single pin, or (no pin at all) the auto-blend of every domain
 * the scholar has STARTED. Both platforms need this to answer one question
 * honestly before building the Start link: "is the tile the scholar just
 * picked actually inside what would otherwise be served?" A picked domain
 * OUTSIDE this set (a not-yet-started "new territory" domain, or ANY tile
 * whose domain a standing pin doesn't cover — e.g. `choiceSetForSelf`
 * rounds across every registered domain, not just the pinned one) must carry
 * an EXPLICIT domain override on the Start link, or the practice screen falls
 * through to its OWN standing/auto-blend resolution — which wins over an
 * unmatched choice hint (practiceSession's own `choiceHint.domain === domain`
 * gate) — silently serving a DIFFERENT territory than the one just previewed.
 * A pick INSIDE this set needs no override; the practice screen's own
 * resolution already serves it correctly (blend included).
 *
 * FOCUS MODE deliberately keeps this started/pin-based reading: without a
 * `?domain=` override the practice screen resolves the scholar's PRIMARY
 * focus domain, so an active-but-unstarted domain's tile must still be
 * flagged outside-set (an "active focus domains" reading here would drop the
 * override and silently serve the primary instead of the picked domain).
 */
export function effectiveDomainSet(inputs: {
  standingDomains?: string[];
  standingDomain?: string;
  startedDomains: string[];
}): string[] {
  if (inputs.standingDomains && inputs.standingDomains.length > 1) return inputs.standingDomains;
  if (inputs.standingDomain) return [inputs.standingDomain];
  return inputs.startedDomains;
}

/** True when `domain` is NOT in the scholar's effective domain set — the tile
 *  pick needs an explicit domain override on its Start link (see
 *  `effectiveDomainSet` above). */
export function isDomainOutsideEffectiveSet(
  domain: string,
  domainSet: string[],
): boolean {
  return !domainSet.includes(domain);
}

/**
 * Whether a no-pin practice ENTRY should gate behind the mixed multi-domain
 * check-in (web: `checkInAllDomains`/`?checkin=all` in
 * app/scholar/practice/page.tsx; native already keyed this off its own
 * `?checkin=all` route flag — see native/src/app/practice.tsx). Only an
 * EXPLICIT check-in entry (the "Finish your Check-In" tile) or a scholar with
 * NOTHING started yet (no blend exists to drill at all) takes the gate.
 *
 * pilot7 f19 finding (review/pilot7/findings-day2-parked.md): web used to set
 * `checkInAllDomains = true` for EVERY no-pin entry — the ordinary "Today's
 * blend" continue AND an already-started strand pick, not just the explicit
 * check-in tile. Combined with the mixed-placement gate taking priority over
 * the playlist, an incomplete or sitting-paused check-in on some UNRELATED
 * domain silently parked every entrance into practice, even though
 * `practiceSession` was already serving valid items for the scholar's placed
 * domain(s). Scoping the gate to explicit intent (mirroring native) means an
 * incomplete/paused check-in never again preempts a runnable drill.
 */
export function needsCheckInGate(inputs: {
  /** The scholar tapped the dedicated "Finish your Check-In" CTA (web
   *  `?checkin=all`; native's existing `checkin === "all"`). */
  isExplicitCheckIn: boolean;
  /** How many domains the scholar has already started — zero means there is
   *  no blend to drill, so even an ordinary no-pin entry must check in. */
  startedDomainCount: number;
}): boolean {
  return inputs.isExplicitCheckIn || inputs.startedDomainCount === 0;
}

/** The blend's own state — everything `deriveStartCta` needs to pick its verb
 *  ladder when NO strand is selected (mirrors the existing PlaylistCard/
 *  PracticePlaylistCard `ctaVerb` logic, now centralized). */
export type BlendCtaState = {
  needsPlacement: boolean;
  /** True when the check-in has already been ENTERED — any domain in flight or
   *  converged, straight off the shared map derivation
   *  (`practiceSkills.mapProgressForScholar.started`, finish-the-check-in
   *  decision 6). Pilot7 f18 finding: leaving mid-flight, before any domain
   *  placed, left the home CTA reading "Start check-in" as if nothing had
   *  happened. Only meaningful while `needsPlacement` is still true; ignored
   *  otherwise. */
  checkInStarted?: boolean;
  caughtUp: boolean;
  practicedToday: boolean;
  hasNextUp: boolean;
};

export type StartCta = {
  /** Bare verb, no trailing punctuation ("Start", "Continue", "Practice more",
   *  "Start check-in", "Resume check-in", "Start with Multiplication & Division"). */
  verb: string;
  /** Trailing decoration: "→" for an actionable start/continue, "?" for the
   *  caught-up nudge (mirrors the pre-existing web/native rendering). */
  suffix: "→" | "?";
  /** Filled/primary vs. outlined/secondary CTA styling. */
  primary: boolean;
};

/**
 * The Start CTA's copy + emphasis. A picked strand (`selection` set) always
 * wins with an explicit "Start with <headline>" — deliberately NOT threaded
 * through the blend's caught-up/continue ladder, since choosing a specific
 * strand is its own unambiguous action regardless of how "done" the default
 * blend looks. `selection.strandLabel` is the kid-facing headline (e.g. via
 * `strandHeadlineFor(card.domain, card.strand)`), not the raw strand slug.
 *
 * `needsPlacement` itself forks on `checkInStarted` (pilot7 f18 finding): a
 * scholar who has never entered the check-in sees "Start check-in", but one
 * whose map derivation already reports a domain in flight or converged — so
 * home still reads `needsPlacement: true` — sees "Resume check-in" instead,
 * honest about there being a check-in already underway.
 */
export function deriveStartCta(
  selection: { strandLabel: string } | null,
  blend: BlendCtaState,
): StartCta {
  if (selection) {
    return { verb: `Start with ${selection.strandLabel}`, suffix: "→", primary: true };
  }
  if (blend.needsPlacement) {
    return {
      verb: blend.checkInStarted ? "Resume check-in" : "Start check-in",
      suffix: "→",
      primary: true,
    };
  }
  if (blend.caughtUp) return { verb: "Practice more", suffix: "?", primary: false };
  if (blend.practicedToday && blend.hasNextUp) return { verb: "Continue", suffix: "→", primary: true };
  return { verb: "Start", suffix: "→", primary: true };
}

/**
 * The practice CTA's ACCESSIBLE label — a screen-reader-friendly sentence
 * ("Start your math check-in", "Continue your math playlist with Fractions")
 * that's more descriptive than the terse visual `verb`. Built from the SAME
 * `StartCta` the button visually renders (`deriveStartCta`'s return value),
 * so a verb-ladder fork can never silently diverge from what assistive tech
 * announces — the exact bug this fixes: the aria-label/accessibilityLabel
 * used to be a SEPARATE hard-coded ternary that never forked on
 * `checkInStarted`, so a scholar who left the check-in mid-flight and came
 * back saw the button say "Resume check-in" but heard "Start your math
 * check-in" read aloud. The needsPlacement branch below derives its fork
 * directly from `startCta.verb` (never re-checks `checkInStarted` itself),
 * so it's structurally impossible for the two to disagree.
 *
 * Shared so web (`components/practice/PlaylistCard.tsx`) and native
 * (`native/src/components/practice/PracticePlaylistCard.tsx`, via the
 * vendored copy) render the identical accessible text — never a drift copy.
 */
export function practiceCtaAccessibleLabel(
  startCta: StartCta,
  context: {
    /** A strand/new-territory tile is selected (`selectedChoice` truthy). */
    hasSelectedChoice: boolean;
    needsPlacement: boolean;
    caughtUp: boolean;
    practicedToday: boolean;
    /** The next-up skill's kid-facing label, or `null` if there isn't one. */
    nextUpLabel: string | null;
    firstPostPlacementBlock: boolean;
  },
): string {
  // A picked strand's aria text is IDENTICAL to its visual verb ("Start with
  // <headline>") — reusing `startCta.verb` directly rather than
  // reconstructing the headline is itself single-source (nothing to fork).
  if (context.hasSelectedChoice) return startCta.verb;
  if (context.needsPlacement) {
    // `startCta.verb` is exactly "Start check-in" or "Resume check-in" here —
    // the SAME string the button renders — so this substitution can never
    // disagree with what's on screen.
    return startCta.verb.replace("check-in", "your math check-in");
  }
  if (context.caughtUp) return "Practice more math";
  if (context.practicedToday && context.nextUpLabel) {
    return `Continue your math playlist with ${context.nextUpLabel}`;
  }
  if (context.firstPostPlacementBlock) return "Start your first math playlist";
  return "Start today's math playlist";
}

// ── Tile icons (Andy's play-session follow-up: "give each a phosphor icon") ──
//
// ONE shared name map so web + native can't drift — this module stores icon
// NAMES only (a string), never a component (that would drag in a React/RN
// dependency this file deliberately has none of). Each platform resolves its
// own component from the name:
//   • web    — the name IS the `@phosphor-icons/react` export
//     (components/practice/PlaylistCard.tsx does `PhosphorIcons[name]`).
//   • native — a hand-drawn react-native-svg twin per name, following the
//     existing PrepIcons.tsx convention (single ~1.8 stroke, monochrome) —
//     see native/src/components/practice/PlaylistTileIcons.tsx.

/** The tile KINDS a "Today's Math Playlists" tile can be. "strand" and
 *  "new-territory" both resolve their icon by DOMAIN — the icon names the
 *  subject (e.g. geometry), not whether it's newly offered; the small "NEW"
 *  corner mark is what distinguishes a new-territory tile visually, not a
 *  different icon. Kept as a distinct kind anyway (rather than folding into
 *  "strand") so a caller can't accidentally omit a domain for it — the type
 *  overload below requires one for both. "stretch" is the standing
 *  challenge-lane tile (the Stretch tile), visible only when the session has
 *  a non-empty challenge tail. */
export type PlaylistTileKind = "blend" | "strand" | "new-territory" | "stretch";

const BLEND_ICON_NAME = "Shuffle";
const STRETCH_ICON_NAME = "Anchor";

/** Practice-domain slug → Phosphor icon name. Keyed on the same registered
 *  slugs as shared/practiceDomainLabels.ts (PRACTICE_DOMAIN_LABELS) — kept as
 *  a separate map here (rather than merged into that file) since this one is
 *  UI iconography, not the domain registry itself. */
const DOMAIN_ICON_NAMES: Record<string, string> = {
  "whole-number-arithmetic": "Calculator",
  "fraction-arithmetic": "ChartPieSlice",
  probability: "DiceFive",
  "geometry-measurement": "Ruler",
  "ratio-proportion-percent": "Percent",
  "integers-coordinates": "GridFour",
  "early-algebra": "Function",
  "algebra-1": "BracketsCurly",
};

/** Fallback for a domain not yet in `DOMAIN_ICON_NAMES` (e.g. a newly
 *  registered practice domain whose icon hasn't been curated yet) — keeps the
 *  carousel from ever rendering an icon-less tile. A generic math glyph,
 *  distinct from every curated per-domain icon above. */
const DOMAIN_ICON_FALLBACK = "MathOperations";

export function playlistTileIconName(kind: "blend" | "stretch"): string;
export function playlistTileIconName(kind: "strand" | "new-territory", domain: string): string;
export function playlistTileIconName(kind: PlaylistTileKind, domain?: string): string {
  if (kind === "blend") return BLEND_ICON_NAME;
  if (kind === "stretch") return STRETCH_ICON_NAME;
  return DOMAIN_ICON_NAMES[domain ?? ""] ?? DOMAIN_ICON_FALLBACK;
}

// ── The collapsed-set expander label ─────────────────────────────────────

/**
 * The quiet "N more in …" expander under the multipack rows. Andy's play-
 * session finding: once a scholar has chosen a specific playlist (a strand or
 * new-territory tile), "N more in today's set" reads wrong — that set is now
 * the CHOSEN playlist's, not the generic daily blend's. Names the chosen
 * playlist's own headline instead; falls back to "today's set" for the blend
 * (or no selection at all) exactly as before. `selection` is `null` for the
 * blend — matches `deriveStartCta`'s own selection shape, so a caller already
 * holding one can pass it straight through to both.
 */
export function expandMoreLabel(
  hiddenCount: number,
  selection: { strandLabel: string } | null,
): string {
  return `${hiddenCount} more in ${selection ? selection.strandLabel : "today's set"}`;
}
