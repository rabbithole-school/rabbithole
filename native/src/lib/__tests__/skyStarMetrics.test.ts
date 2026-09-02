import { describe, it, expect } from "vitest";
import { classifySkyNode } from "../../../vendor/shared/skyTiers";
import { attenAt, MAX_ZOOM, MIN_ZOOM } from "../skyDisplay";
import {
  DOT_GROWTH_CAP,
  featureStarMetrics,
  ARROW_TIP_CLEARANCE,
  arrowTipGap,
  MIN_HIT_R,
  SEED_GLOW_R,
  starGrowthAt,
  starHitRadius,
  territoryDotR,
} from "../skyStarMetrics";

// The regression these tests exist for: sky.tsx's FeatureStar used to compute
// its own visit-count size ramp and ignore shared/skyTiers' visualRadius/glow
// entirely, so a mastery star ("you've shown this") drew 3.3-4.9x the diameter
// of a seed ("an invitation to explore"). skyLayout.test.ts could not catch it
// — it asserts on the layout DATA, which was correct all along; the RENDERER
// discarded it. So these assert the geometry that is actually drawn.

/** Build a star the way the real pipeline does — through the shared classifier. */
function star(role: "seed" | "mastery" | "starter" | "standard" | "territory", refCount = 1) {
  const d = classifySkyNode({
    role: role === "territory" ? undefined : role,
    domain: "science",
    refCount,
    hopTier: 3,
  });
  return { role, visualRadius: d.r, glow: d.glow };
}

describe("feature star size ladder", () => {
  const seed = featureStarMetrics(star("seed"));
  const mastery = featureStarMetrics(star("mastery"));
  const masteryMulti = featureStarMetrics(star("mastery", 4));
  const territoryR = territoryDotR(star("territory"), 1);

  it("keeps the seed as the sky's largest layer", () => {
    // An invitation is the only actionable object on the map. It must never be
    // out-shouted by something the scholar has already finished.
    expect(mastery.diameter).toBeLessThan(seed.diameter);
    expect(masteryMulti.diameter).toBeLessThan(seed.diameter);
  });

  it("keeps mastery clearly above the deep-field territory dots", () => {
    expect(mastery.diameter).toBeGreaterThan(territoryR * 2);
  });

  it("holds mastery inside the calibrated 0.55-0.80x band of a seed", () => {
    for (const m of [mastery, masteryMulti]) {
      const ratio = m.diameter / seed.diameter;
      expect(ratio).toBeGreaterThanOrEqual(0.55);
      expect(ratio).toBeLessThanOrEqual(0.8);
    }
  });

  it("lets a multi-reference mastery star read slightly stronger", () => {
    expect(masteryMulti.diameter).toBeGreaterThan(mastery.diameter);
  });

  it("draws a ring for a seed and a filled core for everything else", () => {
    expect(seed.isRing).toBe(true);
    expect(mastery.isRing).toBe(false);
  });

  it("never lets one star's own visualRadius escape the budget", () => {
    // A hostile/out-of-range value must not reintroduce a 75px bloom.
    const huge = featureStarMetrics({ role: "mastery", visualRadius: 99, glow: 9 });
    expect(huge.diameter).toBeLessThan(seed.diameter);
  });

  it("ignores visit count entirely", () => {
    const a = featureStarMetrics({ role: "mastery", visualRadius: 1.7, glow: 0.6 });
    const b = featureStarMetrics({
      ...{ role: "mastery", visualRadius: 1.7, glow: 0.6 },
      // visitCount/pinned are not part of the metrics contract — passing them
      // must change nothing. They used to drive a 12/13/15 x 4.2/4.6/5.0 ramp.
      ...({ visitCount: 40, pinned: true } as object),
    });
    expect(b.diameter).toBe(a.diameter);
  });
});

describe("zoom growth", () => {
  it("caps feature stars with the SAME ceiling as territory dots", () => {
    // These used to diverge: dots capped at DOT_GROWTH_CAP, feature stars grew
    // unbounded as s^0.57 (~3.27x at MAX_ZOOM) — which is how a mastery bloom
    // reached ~245px, and it silently broke the seed:blue-star ratio that
    // attenAt's own doc-comment promises holds "at every zoom".
    expect(starGrowthAt(MAX_ZOOM)).toBeCloseTo(DOT_GROWTH_CAP, 6);
  });

  it("never shrinks a star below its rest size", () => {
    expect(starGrowthAt(MIN_ZOOM)).toBeCloseTo(MIN_ZOOM, 6);
    expect(starGrowthAt(1)).toBeCloseTo(1, 6);
  });

  it("grows monotonically and continuously across the whole range", () => {
    let prev = 0;
    for (let s = MIN_ZOOM; s <= MAX_ZOOM; s += 0.05) {
      const g = starGrowthAt(s);
      expect(g).toBeGreaterThanOrEqual(prev - 1e-9);
      prev = g;
    }
  });

  it("preserves the size ladder at EVERY camera scale", () => {
    const seed = featureStarMetrics(star("seed"));
    const mastery = featureStarMetrics(star("mastery", 4));
    const terr = star("territory");
    for (let s = MIN_ZOOM; s <= MAX_ZOOM; s += 0.05) {
      const g = starGrowthAt(s);
      expect(mastery.diameter * g).toBeLessThan(seed.diameter * g);
      expect(mastery.diameter * g).toBeGreaterThan(territoryDotR(terr, g) * 2);
    }
  });

  it("holds every mastery star under a 35px on-screen ceiling", () => {
    const mastery = featureStarMetrics(star("mastery", 4));
    expect(mastery.diameter * starGrowthAt(MAX_ZOOM)).toBeLessThan(35);
  });

  it("keeps the seed's own settled geometry untouched", () => {
    // The small gold ring is a settled 2026-07-06 decision and the fixed point
    // the rest of the ladder is calibrated against — it must not drift.
    expect(featureStarMetrics(star("seed")).diameter).toBeCloseTo(SEED_GLOW_R * 2, 6);
  });

  describe("the bright heart", () => {
    // Regression net for the SECOND half of the inverted hierarchy: the size
    // ladder was already correct on-device and mastery stars still read as hard
    // white pips, because the renderer painted an opaque white disc across the
    // whole core. The heart must stay a genuine pinprick — small enough that a
    // star reads as a point of light, never as a filled white disc.
    it("keeps every star's heart well inside its core", () => {
      for (const s of [star("seed"), star("mastery"), star("mastery", 4), star("territory")]) {
        const m = featureStarMetrics(s);
        expect(m.heartR).toBeGreaterThan(0);
        expect(m.heartR).toBeLessThan(m.coreR * 0.5);
      }
    });

    it("never lets a mastery heart out-shine a seed's lit centre", () => {
      const seed = featureStarMetrics(star("seed"));
      const mastery = featureStarMetrics(star("mastery", 4));
      expect(mastery.heartR).toBeLessThan(seed.heartR);
    });

    it("scales the heart with the star, so the ratio holds at every zoom", () => {
      const m = featureStarMetrics(star("mastery"));
      for (let s = MIN_ZOOM; s <= MAX_ZOOM; s += 0.25) {
        const g = starGrowthAt(s);
        expect((m.heartR * g) / (m.coreR * g)).toBeCloseTo(m.heartR / m.coreR, 10);
      }
    });
  });

  describe("tap target (starHitRadius)", () => {
    // The regression: the hit test compared a CONTENT-space distance against a
    // fixed 48, so the tap target was multiplied by the camera — ~29pt across
    // at MIN_ZOOM and ~384pt at MAX_ZOOM, where one star covered a third of the
    // iPad and swallowed every neighbouring tap. The radius must be a SCREEN
    // measurement, so these assert against zoom, which the old code could not
    // even express.
    it("stays a constant screen size across the whole zoom range", () => {
      for (const s of [star("seed"), star("mastery"), star("mastery", 4), star("territory")]) {
        const radii: number[] = [];
        for (let z = MIN_ZOOM; z <= MAX_ZOOM; z += 0.25) {
          radii.push(starHitRadius(s, starGrowthAt(z)));
        }
        const min = Math.min(...radii);
        const max = Math.max(...radii);
        // Not "exactly equal": a hypothetical huge glyph may exceed the floor.
        // But it must never breathe by more than the glyph's own growth cap.
        expect(max / min).toBeLessThanOrEqual(DOT_GROWTH_CAP);
        expect(max).toBeLessThan(40); // < 80pt across, vs the old 384pt.
      }
    });

    it("never drops below Apple's 44pt minimum touch target", () => {
      for (const s of [star("seed"), star("mastery"), star("territory")]) {
        expect(starHitRadius(s, starGrowthAt(MIN_ZOOM))).toBeGreaterThanOrEqual(MIN_HIT_R);
      }
    });

    it("is sized off the core, never the bloom halo", () => {
      // The bloom fades to nothing, so treating its radius as touchable is what
      // made stars feel like they had sloppy overlapping edges. In practice the
      // 44pt floor dominates every star at every zoom (the whole GLYPH is only
      // ~15pt across), so the guarantee that matters is: growing the soft bloom
      // must never grow the target.
      const s = star("seed");
      const m = featureStarMetrics(s);
      expect(starHitRadius(s, 1)).toBe(Math.max(MIN_HIT_R, m.coreR));
      // Widening the soft halo must not widen the target: the radius is a
      // function of coreR alone, never of `diameter` (the bloom's extent).
      expect(starHitRadius(s, 1)).toBe(
        starHitRadius({ ...s, glow: (s.glow ?? 0) * 4 }, 1),
      );
    });
  });

  describe("lattice arrow tip gap", () => {
    // The regression: the gap was a flat `10 * atten`, i.e. 10-16.5 SCREEN pt of
    // empty space before the target star. Invisible while a mastery bloom was
    // ~245px across; once P1 shrank cores to ~3.4pt the same constant left every
    // arrow hanging one to two star-diameters short — "the lines don't connect
    // to the stars". The gap must therefore be a function of the TARGET STAR,
    // so retuning star sizes can never detach the lattice again.
    it("lands the tip a fixed clearance outside the target star at every zoom", () => {
      for (const s of [star("seed"), star("mastery"), star("mastery", 4)]) {
        const core = featureStarMetrics(s).coreR;
        for (let z = MIN_ZOOM; z <= MAX_ZOOM; z += 0.25) {
          const growth = starGrowthAt(z);
          const screenR = core * growth;
          // gap is CONTENT units; on screen it is gap * z.
          const screenGap = arrowTipGap(screenR, z) * z;
          expect(screenGap).toBeCloseTo(screenR + ARROW_TIP_CLEARANCE, 6);
        }
      }
    });

    it("is far tighter than the old flat constant it replaces", () => {
      const s = star("mastery");
      const core = featureStarMetrics(s).coreR;
      for (let z = MIN_ZOOM; z <= MAX_ZOOM; z += 0.5) {
        const growth = starGrowthAt(z);
        const oldScreenGap = 10 * attenAt(z) * z; // === 10 * growth below the cap
        const newScreenGap = arrowTipGap(core * growth, z) * z;
        expect(newScreenGap).toBeLessThan(oldScreenGap);
      }
    });

    it("still leaves visible air, so the arrowhead never buries itself", () => {
      const s = star("seed");
      const core = featureStarMetrics(s).coreR;
      expect(arrowTipGap(core, 1) - core).toBeGreaterThan(0);
    });
  });
});
