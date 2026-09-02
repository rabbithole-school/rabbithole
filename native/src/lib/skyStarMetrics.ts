// Pure geometry for the Sky map's FEATURE stars (seeds + lit mastery). Split
// out of sky.tsx so the sizes that actually get DRAWN are testable.
//
// WHY this file exists: the renderer used to compute its own visit-count size
// ramp and ignore `star.visualRadius` / `star.glow` entirely — the very fields
// shared/skyTiers.ts computes for exactly this purpose. Nothing caught it,
// because skyLayout.test.ts asserts on the layout DATA (which was correct) and
// the renderer quietly discarded it. So a mastery star ("you've shown this")
// drew 3.3-4.9x the diameter of a seed ("an invitation to explore"), inverting
// the sky's whole hierarchy: the one actionable object was the smallest thing
// on screen, and the finished thing was a 75px anonymous white bloom.
//
// The ladder these metrics enforce, at camera scale 1:
//
//     seed (invitation)   ~15.3px   1.00x   <- the sky's brightest layer
//     mastery (earned)    ~10.6px   0.69x
//     territory (field)    ~4.8px   0.31x
//
// Native is deliberately tuned for iPad here rather than matching the web
// engine pixel-for-pixel (Andy, 2026-07-26: "native feeling good should be the
// main priority"). What is NOT negotiable is the ORDERING — shared/skyTiers
// states it outright for mastery: "Deliberately DIMMER + SMALLER than a seed
// ... never competing with a real invitation."

import { attenAt } from "./skyDisplay";

/** Turns the tiny shared classifySkyNode radii (1.6-2.5) into on-screen px. */
export const DOT_SCALE = 1.7;
/** Deep-field dots render at this fraction of their size — quiet background. */
export const NON_SEED_DOT_SCALE = 0.7;
/**
 * Screen-size growth ceiling. Displayed size grows as s*attenAt(s) = s^0.57;
 * this caps it so nothing balloons at deep zoom (Andy 2026-07-06: blue/green
 * stars should max out at 50% of the old 8x-zoom maximum).
 *
 * Applied to territory dots AND feature stars. Feature stars used to be
 * UNCAPPED, which silently broke the invariant attenAt's own doc-comment
 * claims ("the seed = 1.5x blue-star size ratio stays constant at every
 * zoom") — above scale ~2.41 the dots stopped growing and the stars kept
 * going, reaching ~3.27x at MAX_ZOOM. That is where the ~245px blooms came
 * from. One shared cap restores the stated invariant.
 */
export const DOT_GROWTH_CAP = 1.65;

// ── Seed ("invitation") — SETTLED 2026-07-06, do not retune ───────────────────
// A seed reads as a small gold RING whose outer edge is ~1.5x a regular blue
// territory dot's diameter — a quiet, tasteful invitation, NOT the old ~10x
// glow bloom. Only a subtle halo extends past the ring. These four constants
// are the fixed point everything else on this map is calibrated against.
export const BLUE_STAR_R = 2.0 * DOT_SCALE; // ≈3.4px — a blue territory dot's radius at rest.
export const SEED_RING_OUTER_R = BLUE_STAR_R * 1.5; // ≈5.1px
export const SEED_RING_STROKE = 1.5; // gold ring line weight (px)
export const SEED_GLOW_R = SEED_RING_OUTER_R * 1.5; // ≈7.7px — subtle halo past the ring

// ── Mastery / lit non-seed stars ──────────────────────────────────────────────
// Pinned to the seed's settled geometry (above) so the ladder cannot drift
// again: an earned star is ~0.69x an invitation, comfortably above a territory
// dot but never competing with a live seed.
export const MASTERY_CORE_R = SEED_RING_OUTER_R * 0.55; // ≈2.8px
export const MASTERY_GLOW_R = SEED_GLOW_R * 0.69; // ≈5.3px → Ø ≈10.6

/**
 * The canonical mastery radius (shared/skyTiers classifySkyNode, role
 * "mastery" with refCount <= 1) that the two constants above are tuned for.
 * A star's own `visualRadius` modulates against this — so a multi-reference
 * mastery star reads slightly stronger than a single-reference one, exactly as
 * the shared model intends — while the clamp keeps every non-seed inside the
 * budget. This replaces the old visit-count ramp, which had no basis in the
 * shared model and was what produced the 12/13/15 x 4.2/4.6/5.0 blowout.
 */
export const MASTERY_REF_R = 1.7;
const MASTERY_MOD_MIN = 0.85;
const MASTERY_MOD_MAX = 1.12;

// ── The bright heart ─────────────────────────────────────────────────────────
// Fixing the SIZE ladder alone did not fix the hierarchy, because the renderer
// also painted an opaque white disc across a non-seed's whole core (plus a
// second white disc on top of that at half radius). At mastery's ~5.6px core
// the two stacked discs covered the entire visible star, so its own colour
// never showed and every earned concept read as a hard white pip — still
// out-shouting the gold invitations even at 0.69x their diameter. Brightness
// and chroma carry the hierarchy just as much as size does, and shared/skyTiers
// says "DIMMER + smaller", not just smaller.
//
// So the white is now a small HEART inside a body that keeps the star's own
// colour, and a seed gets a lit heart inside its ring — an invitation that is
// visibly ON rather than a hollow outline reading as "empty / unavailable".
/** White pinprick inside a non-seed's coloured body, as a fraction of coreR. */
export const CORE_HEART_RATIO = 0.45;
/** Lit centre dot inside a seed's gold ring, as a fraction of the ring radius. */
export const SEED_HEART_RATIO = 0.42;

export type FeatureStarLike = {
  role?: string;
  visualRadius?: number;
  glow?: number;
};

export type FeatureStarMetrics = {
  /** Radius of the outer bloom/halo in content px at camera scale 1. */
  bloomR: number;
  /** Radius of the bright core (for a seed: the gold ring's radius). */
  coreR: number;
  /**
   * Radius of the small bright HEART at the very centre — a seed's lit centre
   * dot inside its ring, or a non-seed's white pinprick inside its coloured
   * body. Deliberately small: a star should read as a point of light with a
   * halo, never as a filled disc.
   */
  heartR: number;
  /** Overall drawn diameter — bloomR * 2. */
  diameter: number;
  /** Seeds draw a hollow ring; everything else draws a filled core. */
  isRing: boolean;
  /** False for a star the shared model gives no glow (canonical territory). */
  hasBloom: boolean;
};

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

/**
 * Drawn geometry for one feature star, in content px at camera scale 1.
 * Multiply by `starGrowthAt(scale)` for the on-screen size.
 */
export function featureStarMetrics(star: FeatureStarLike): FeatureStarMetrics {
  if (star.role === "seed") {
    const ringR = SEED_RING_OUTER_R - SEED_RING_STROKE / 2;
    return {
      bloomR: SEED_GLOW_R,
      coreR: ringR,
      heartR: ringR * SEED_HEART_RATIO,
      diameter: SEED_GLOW_R * 2,
      isRing: true,
      hasBloom: true,
    };
  }
  const mod = clamp(
    (star.visualRadius ?? MASTERY_REF_R) / MASTERY_REF_R,
    MASTERY_MOD_MIN,
    MASTERY_MOD_MAX,
  );
  const bloomR = MASTERY_GLOW_R * mod;
  const coreR = MASTERY_CORE_R * mod;
  return {
    bloomR,
    coreR,
    heartR: coreR * CORE_HEART_RATIO,
    diameter: bloomR * 2,
    isRing: false,
    // Canonical territory carries glow 0; a lit one still earns a faint halo,
    // so only an explicit 0 with no fallback suppresses it.
    hasBloom: (star.glow ?? 1) > 0,
  };
}

/**
 * On-screen size multiplier at a given camera scale — the CONTINUOUS attenAt
 * curve, hard-capped. Shared by territory dots and feature stars so the ladder
 * between them holds at every zoom. Worklet-safe (pure Math).
 */
export function starGrowthAt(scale: number): number {
  "worklet";
  return Math.min(scale * attenAt(scale), DOT_GROWTH_CAP);
}

/** Drawn radius of a plain (non-feature) territory dot at a given growth factor. */
export function territoryDotR(star: FeatureStarLike, growth: number): number {
  return Math.max(
    1.1 * growth,
    (star.visualRadius ?? 1.8) * DOT_SCALE * NON_SEED_DOT_SCALE * growth,
  );
}

/**
 * Minimum tap-target RADIUS in screen points — half of Apple's 44pt minimum
 * touch target. A sky star's drawn core is only ~5-8pt across even at full
 * zoom, so in practice this floor is what a scholar is actually aiming at.
 */
export const MIN_HIT_R = 22;

/**
 * Tap-target radius for a star, in SCREEN POINTS.
 *
 * The hit test used to measure distance in CONTENT units against a fixed 48,
 * which meant the target silently scaled with the camera: ~29pt across at the
 * minimum zoom and ~384pt at MAX_ZOOM, where a single star swallowed a third of
 * the iPad and stole taps meant for its neighbours. Screen space is the only
 * frame a finger actually lives in, so the target is defined here and never
 * multiplied by the camera again.
 *
 * Sized off the CORE, not the bloom: the bloom is a soft halo that fades to
 * nothing, so treating its full radius as touchable made stars feel like they
 * had sloppy, overlapping edges. In practice the floor dominates at every
 * zoom — the core term only matters if the glyph is ever retuned much larger.
 */
export function starHitRadius(star: FeatureStarLike, growth: number): number {
  return Math.max(MIN_HIT_R, featureStarMetrics(star).coreR * growth);
}

/**
 * Air (in SCREEN points) left between a prereq arrow's tip and the edge of the
 * star it points at.
 */
export const ARROW_TIP_CLEARANCE = 2.5;

/**
 * How far short of the target star's CENTRE a prereq arrow must stop, in
 * CONTENT units (the space `LatticeArrow` draws in).
 *
 * The gap used to be a flat `10 * atten`, which lands at `10 * growth` screen
 * points — 10-16.5pt of empty space. That was invisible back when a mastery
 * star's bloom was ~245px across and swallowed it whole; once the size ladder
 * shrank cores to ~3.4pt (see this file's header) the same constant left every
 * arrow hanging one to two star-diameters short of its target, which reads as
 * "the lines don't connect to the stars".
 *
 * So the gap is derived from the star actually being pointed at, not guessed:
 * the tip always lands exactly ARROW_TIP_CLEARANCE outside that star's drawn
 * edge, at every zoom. Retuning star sizes can no longer detach the lattice.
 */
export function arrowTipGap(targetScreenR: number, scale: number): number {
  return (targetScreenR + ARROW_TIP_CLEARANCE) / Math.max(scale, 0.0001);
}
