/**
 * The mastery dial's dot palette — the one place a mastery state becomes a
 * colour.
 *
 * This existed in THREE hand-synced copies (components/KnowledgeNodeDial.tsx,
 * components/NodeDrawer.tsx, native/src/components/tree/treeGlyphs.tsx), each
 * carrying a "keep in sync with…" comment, which is the shape of a fact with no
 * canonical home. They are now all this module. Framework-free so both
 * frontends read the same hexes; `shared/masteryLexicon.ts` is its sibling for
 * the same states' WORDS.
 *
 * ── Surfaces ──────────────────────────────────────────────────────────────
 * The palette was chosen against the tree's PAPER plane, where the whole point
 * of the locked grey is to be the quietest mark on the page. Put the identical
 * hexes on a night surface (the Home map card's navy) and the ranking does not
 * merely fade — it INVERTS, because contrast is measured against the
 * background, and #d7dbd4 is nearly white:
 *
 *              vs paper #fff   vs night #101736
 *   locked         1.40×            12.50×   ← quietest becomes LOUDEST
 *   frontier       1.89×             9.30×
 *   fluent         3.34×             5.25×
 *
 * So "a skill you have merely been shown" would shout over "a skill you made
 * fluent". `MASTERY_DOT_COLOR_NIGHT` therefore re-states the SAME INTENT for a
 * dark surface rather than reusing the same numbers.
 *
 * What deliberately does NOT change between surfaces: the earned hues. Amber IS
 * frontier and green IS fluent — that identity is the signal the dial exists to
 * carry, it is legible on both surfaces (9.30× / 5.25× on night), and the
 * roadmap locked it. Only the two colours whose job is defined RELATIVE to the
 * background move: the quiet locked dot, and the "hollow" fill that must read
 * as the surface showing through.
 */

import { palette } from "./brand";
import { status } from "./brand";
import type { MasteryState } from "./treeMapLayout";

/** Where a dial is being drawn. `paper` is the tree plane and every light card. */
export type DialSurface = "paper" | "night";

/**
 * The canonical palette, on paper.
 *
 *   green  #3a9e6b  — fluent mastery
 *   amber  #e0b84e  — active frontier
 *   grey   #d7dbd4  — locked / not yet reachable
 *   teal   #0f766e  — overlearned ("beyond fluent, durable"; the old forest
 *                     #14663f was too close to fluent green at small sizes)
 *   red    status.red (#EF4444) — struggling (≥2 recent unaddressed misses)
 *
 * `struggling` is a teacher/parent-facing state (redacted from the scholar's own
 * map). Like the earned amber/green hues it is a MEANINGFUL signal, not a
 * background-relative mark, so it stays CONSTANT across surfaces (legible on both
 * paper and the night navy) — no night override, matching frontier/fluent.
 *
 * `placed` = provisional (access-proven but INFERRED credit). Same fluent-green
 * HUE as `fluent`, but callers draw it HOLLOW — a green ring over
 * `dialHollowFill` — so it reads "on your map at this level, not yet proven".
 * No new hue: the ring vs. fill IS the signal.
 */
export const MASTERY_DOT_COLOR: Record<MasteryState, string> = {
  locked: "#d7dbd4",
  frontier: "#e0b84e",
  placed: "#3a9e6b",
  fluent: "#3a9e6b",
  overlearned: "#0f766e",
  struggling: status.red,
};

/**
 * Night-surface overrides — deltas only, so anything absent is inherited and
 * the earned hues cannot drift apart across surfaces.
 *
 * `locked` becomes `navy.400`, an existing brand token rather than a minted
 * hex: 2.93× on the card's navy, i.e. below fluent's 5.25×, which restores the
 * ranking the paper palette encodes (frontier and fluent are the earned marks;
 * locked is the quiet one).
 */
const MASTERY_DOT_COLOR_NIGHT: Partial<Record<MasteryState, string>> = {
  locked: palette.navy[400],
};

/** The dot colour for a mastery state on a given surface. */
export function masteryDotColor(
  mastery: MasteryState,
  surface: DialSurface = "paper",
): string {
  if (surface === "night") {
    return MASTERY_DOT_COLOR_NIGHT[mastery] ?? MASTERY_DOT_COLOR[mastery];
  }
  return MASTERY_DOT_COLOR[mastery];
}

/**
 * The fill under a HOLLOW (`placed`) dot. It must match the surface behind it,
 * so the ring reads as an empty node rather than a white blob punched into a
 * dark card — the one value that is *defined* as "the background".
 */
export function dialHollowFill(surface: DialSurface = "paper"): string {
  return surface === "night" ? palette.navy[900] : "#ffffff";
}
