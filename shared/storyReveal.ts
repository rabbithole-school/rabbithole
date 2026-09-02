/**
 * Story reveal card — the night-sky reveal timings + locked copy, shared so the
 * web (components/practice/StoryMomentCard.tsx) and native
 * (native/src/components/practice/StoryMomentCard.tsx) twins read as the SAME
 * motion and the SAME words (2026-07-04 parity rule). Vendored to
 * native/vendor/shared/storyReveal.ts by native/scripts/sync-vendor.js — a
 * fork here would be a scholar-facing parity gap by construction.
 *
 * The reveal is a DECLARED charm layer on a kid-facing celebratory surface
 * (visual-design.md's charm exception): a field of small twinkling stars, ONE
 * of them brightening into the story's authored emoji, then the words. It runs
 * ONCE per mount, never loops, and collapses to its settled end state instantly
 * under reduced motion. The emoji is the story's real referent (the cicada test
 * holds — the art comes from the registry), so the charm asserts no false count.
 */

/**
 * Reveal phase timings in ms, measured from card mount. Web drives these as CSS
 * animation-delays/durations; native mirrors them with Reanimated
 * withDelay/withTiming. The two surfaces must read as one motion, so both import
 * from here (or its vendored copy) rather than restating the numbers.
 *
 * The sequence (proposal direction B + Andy's tweaks):
 *   1. 0–150ms      night surface + star field fade in, stars twinkle.
 *   2. ~150–300ms   one hero star brightens (scale + glow bloom).
 *   3. ~300–430ms   the story emoji springs in where the star shone.
 *   4. ~420–600ms   eyebrow + hook + teaser fade+rise as one group.
 *   5. settle       the field fades DOWN to faint + the shine dies away.
 */
export const STORY_REVEAL_MS = {
  /** Night surface + star field fade in (step 1). */
  fieldIn: 150,
  /** The one hero star brightens/blooms (step 2). */
  shineStart: 150,
  shineDur: 150,
  /** The story emoji springs in where the star shone (step 3). */
  emojiStart: 300,
  emojiDur: 130,
  /** Eyebrow + hook + teaser fade+rise as one group (step 4). */
  textStart: 420,
  textDur: 180,
  /** The field fades DOWN to faint + the shine dies (settle). */
  settleStart: 560,
  settleDur: 340,
  /** Whole reveal wall-clock — settleStart + settleDur. */
  total: 900,
} as const;

/**
 * The faint opacity the star field settles to (step 5). It is ALSO the base
 * (static) opacity, so under reduced motion — where every animation is skipped —
 * the field renders straight at this calm end state instead of full brightness.
 */
export const STORY_FIELD_SETTLED_OPACITY = 0.35;

/** How long the transient tap hint dwells before it fades back out (ms). */
export const STORY_HINT_MS = 2000;

/**
 * Locked card copy — byte-identical on both surfaces (visual-design.md sentence
 * case + web/native parity). Change these in ONE place; the vendored copy keeps
 * native in lockstep.
 */
export const STORY_CARD_COPY = {
  /**
   * The unified eyebrow. Replaces the old two competing eyebrows (✦ NEW STORY /
   * Waiting in your Quests ✦) and carries the WHERE on its own: 🚀 echoes the
   * app-wide quest glyph (the sky's "Begin Quest 🚀"), so the story's durable
   * home — the Quests tab — is named without a second label.
   */
  eyebrow: "🚀 Quest unlocked",
  /**
   * The transient tap hint. Tapping the card no longer navigates (the Quests
   * tab's standing invitation owns opening from here on); it just points there.
   * "Quests" is the tab's proper name.
   */
  hint: "Find this in your Quests tab",
} as const;
