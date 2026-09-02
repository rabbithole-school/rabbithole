import { describe, it, expect } from "vitest";
import {
  attenAt,
  edgeIsDrawable,
  isFeatureStar,
  labelableStars,
  paintedStarIds,
  MAX_ZOOM,
  MIN_ZOOM,
  selectLabels,
  starLabelPriority,
  STAR_ATTEN,
  starOpacityAtBucket,
  tierVisibleAtBucket,
  zoomBucketFor,
  type DisplayStar,
  type LabelCandidate,
} from "../skyDisplay";

// ── zoom range (web parity: baseZoom*0.6 … baseZoom*4; native base scale = 1) ──

describe("zoom range", () => {
  it("matches the web onWheel clamp ratios (0.6 … 4)", () => {
    expect(MIN_ZOOM).toBe(0.6);
    expect(MAX_ZOOM).toBe(8);
  });

  it("leaves real headroom PAST the bucket-3 threshold (2.8) so the deep field can spread", () => {
    // bucket 3 opens at ratio 2.8; the ceiling is 4 → [2.8, 4] of exploration
    // room (the old 3.5 max left only [2.8, 3.5], which felt shallow + crammed).
    expect(zoomBucketFor(2.8)).toBe(3);
    expect(MAX_ZOOM - 2.8).toBeGreaterThan(1);
    expect(zoomBucketFor(MAX_ZOOM)).toBe(3);
  });
});

// ── per-bucket star growth damping (web parity: atlasEngine ATTEN) ─────────────

describe("attenAt (continuous damping)", () => {
  it("is 1 at and below rest scale", () => {
    expect(attenAt(1)).toBe(1);
    expect(attenAt(0.6)).toBe(1);
  });
  it("tracks the tuned STAR_ATTEN anchors within a few percent", () => {
    expect(attenAt(1.3)).toBeCloseTo(0.89, 1);
    expect(attenAt(1.9)).toBeCloseTo(0.76, 1);
    expect(attenAt(4)).toBeCloseTo(0.55, 1);
  });
  it("is monotonically decreasing (no size snaps possible)", () => {
    let prev = attenAt(1);
    for (let z = 1.05; z <= 4; z += 0.05) {
      const a = attenAt(z);
      expect(a).toBeLessThanOrEqual(prev);
      prev = a;
    }
  });
});

describe("STAR_ATTEN", () => {
  it("mirrors the web ATTEN exactly, so stars grow sublinearly and never balloon", () => {
    expect([...STAR_ATTEN]).toEqual([1, 0.9, 0.72, 0.55]);
  });

  it("is a no-op at rest (bucket 0) so the at-rest look is unchanged", () => {
    expect(STAR_ATTEN[0]).toBe(1);
  });
});

// ── zoom buckets ──────────────────────────────────────────────────────────────

describe("zoomBucketFor", () => {
  it("quantizes scale into 4 buckets at the atlasEngine thresholds", () => {
    expect(zoomBucketFor(0.6)).toBe(0);
    expect(zoomBucketFor(1)).toBe(0);
    expect(zoomBucketFor(1.29)).toBe(0);
    expect(zoomBucketFor(1.3)).toBe(1);
    expect(zoomBucketFor(1.89)).toBe(1);
    expect(zoomBucketFor(1.9)).toBe(2);
    expect(zoomBucketFor(2.79)).toBe(2);
    expect(zoomBucketFor(2.8)).toBe(3);
    expect(zoomBucketFor(4)).toBe(3);
  });
});

// ── LOD gating ────────────────────────────────────────────────────────────────

describe("tierVisibleAtBucket", () => {
  it("shows only tier 0 (seeds) at rest", () => {
    expect(tierVisibleAtBucket(0, 0)).toBe(true);
    expect(tierVisibleAtBucket(1, 0)).toBe(false);
    expect(tierVisibleAtBucket(2, 0)).toBe(false);
    expect(tierVisibleAtBucket(3, 0)).toBe(false);
  });

  it("reveals tier N once bucket ≥ N", () => {
    expect(tierVisibleAtBucket(1, 1)).toBe(true);
    expect(tierVisibleAtBucket(2, 1)).toBe(false);
    expect(tierVisibleAtBucket(2, 2)).toBe(true);
    expect(tierVisibleAtBucket(3, 2)).toBe(false);
    expect(tierVisibleAtBucket(3, 3)).toBe(true);
  });
});

describe("starOpacityAtBucket", () => {
  it("returns 0 for a tier not yet revealed (no more painting the field at rest)", () => {
    expect(starOpacityAtBucket(1, 0)).toBe(0);
    expect(starOpacityAtBucket(2, 1)).toBe(0);
    expect(starOpacityAtBucket(3, 2)).toBe(0);
  });

  it("seeds are always full opacity", () => {
    expect(starOpacityAtBucket(0, 0)).toBe(1);
    expect(starOpacityAtBucket(0, 3)).toBe(1);
  });

  it("tier 1 + tier 2 render fully opaque once revealed (web ENGINE_CSS op 1)", () => {
    expect(starOpacityAtBucket(1, 1)).toBe(1);
    expect(starOpacityAtBucket(1, 3)).toBe(1);
    expect(starOpacityAtBucket(2, 2)).toBe(1);
    expect(starOpacityAtBucket(2, 3)).toBe(1);
  });

  it("the deep field (tier 3) tops out at ~.72 at bucket 3 (web .zl3 .t3)", () => {
    expect(starOpacityAtBucket(3, 3)).toBeCloseTo(0.72, 5);
  });
});

// ── feature split ─────────────────────────────────────────────────────────────

describe("isFeatureStar", () => {
  it("seeds and lit mastery are features (glow/ring/twinkle)", () => {
    expect(isFeatureStar({ role: "seed" })).toBe(true);
    expect(isFeatureStar({ role: "mastery" })).toBe(true);
    expect(isFeatureStar({ visited: true })).toBe(true);
    expect(isFeatureStar({ completed: true })).toBe(true);
  });

  it("standards, a cold-start starter, and untouched territory are NOT features (plain dots)", () => {
    expect(isFeatureStar({ role: "standard" })).toBe(false);
    expect(isFeatureStar({ role: "starter" })).toBe(false);
    expect(isFeatureStar({ role: "territory" })).toBe(false);
    expect(isFeatureStar({ role: "territory", seedId: "overflow" })).toBe(false);
    expect(isFeatureStar({})).toBe(false);
  });
});

// ── label priority ────────────────────────────────────────────────────────────

describe("starLabelPriority", () => {
  it("orders seeds > mastery > standard > starter > territory", () => {
    const seed = starLabelPriority({ role: "seed" });
    const mastery = starLabelPriority({ role: "mastery" });
    const standard = starLabelPriority({ role: "standard" });
    const starter = starLabelPriority({ role: "starter" });
    const territory = starLabelPriority({ role: "territory" });
    expect(seed).toBeGreaterThan(mastery);
    expect(mastery).toBeGreaterThan(standard);
    expect(standard).toBeGreaterThan(starter);
    expect(starter).toBeGreaterThan(territory);
  });

  it("prioritizes a zoom-revealed invitation without promoting it to a feature star", () => {
    const overflow = starLabelPriority({
      role: "territory",
      seedId: "overflow",
    });
    expect(overflow).toBeLessThan(starLabelPriority({ role: "seed" }));
    expect(overflow).toBeGreaterThan(starLabelPriority({ role: "mastery" }));
  });

  it("convergence (higher refCount) breaks ties within a role", () => {
    expect(starLabelPriority({ role: "standard", refCount: 4 })).toBeGreaterThan(
      starLabelPriority({ role: "standard", refCount: 1 }),
    );
  });
});

// ── label selection: cap + collision + cull ────────────────────────────────────

const VP = { width: 400, height: 800, margin: 40 };

function cand(
  id: string,
  sx: number,
  sy: number,
  priority: number,
  opts: Partial<LabelCandidate> = {},
): LabelCandidate {
  return { id, sx, sy, priority, width: 60, height: 20, above: false, ...opts };
}

describe("selectLabels", () => {
  it("respects the cap", () => {
    // 20 well-separated candidates, cap 5 → exactly 5 kept.
    const cands = Array.from({ length: 20 }, (_, i) =>
      cand(`c${i}`, 20 + (i % 4) * 100, 20 + Math.floor(i / 4) * 60, 10 + i),
    );
    expect(selectLabels(cands, VP, 5)).toHaveLength(5);
  });

  it("keeps the highest priority first", () => {
    const cands = [cand("lo", 100, 100, 1), cand("hi", 100, 100, 99)];
    // Both overlap; only one survives — must be the higher-priority one.
    const keep = selectLabels(cands, VP, 10);
    expect(keep).toEqual(["hi"]);
  });

  it("rejects colliding labels but keeps well-separated ones", () => {
    const cands = [
      cand("a", 100, 100, 10),
      cand("b", 108, 104, 9), // overlaps a
      cand("c", 300, 500, 8), // far away
    ];
    const keep = selectLabels(cands, VP, 10);
    expect(keep).toContain("a");
    expect(keep).toContain("c");
    expect(keep).not.toContain("b");
  });

  it("drops off-screen candidates (viewport + margin cull)", () => {
    const cands = [
      cand("onscreen", 200, 400, 10),
      cand("waybelow", 200, 5000, 99),
      cand("wayleft", -500, 400, 99),
    ];
    const keep = selectLabels(cands, VP, 10);
    expect(keep).toEqual(["onscreen"]);
  });

  it("is deterministic for equal-priority ties", () => {
    const cands = [cand("b", 100, 100, 5), cand("a", 100, 100, 5)];
    // Same score → id-stable ordering → 'a' wins the shared slot both runs.
    expect(selectLabels(cands, VP, 10)).toEqual(["a"]);
    expect(selectLabels([...cands].reverse(), VP, 10)).toEqual(["a"]);
  });
});

// ── edge endpoint gating ──────────────────────────────────────────────────────
// Regression: edges were culled ONLY by a viewport intersection test while
// stars were tier-gated AND GLOW_CAP-capped, so the deep prerequisite graph
// stroked its edges across the opening view with none of its nodes drawn.

describe("paintedStarIds / edgeIsDrawable", () => {
  const mk = (
    _id: string,
    displayTier: number,
    extra: Partial<{ role: string; visited: boolean }> = {},
  ) => ({ _id, displayTier, ...extra }) as never;

  const seed = mk("seed1", 0, { role: "seed" });
  const mastery = mk("mast1", 0, { role: "mastery" });
  const evicted = mk("mast2", 0, { role: "mastery" });
  const terrShallow = mk("terr1", 0, { role: "territory" });
  const terrDeep = mk("terr2", 3, { role: "territory" });
  const stars = [seed, mastery, evicted, terrShallow, terrDeep];

  // Bucket 0: only tier 0 renders, and GLOW_CAP admitted seed+mastery but not `evicted`.
  const painted = paintedStarIds(stars, new Set([0]), [seed, mastery]);

  it("paints tier-visible territory and the capped feature stars", () => {
    expect(painted.has("seed1")).toBe(true);
    expect(painted.has("mast1")).toBe(true);
    expect(painted.has("terr1")).toBe(true);
  });

  it("omits a star whose tier has not been revealed yet", () => {
    expect(painted.has("terr2")).toBe(false);
  });

  it("omits a feature star evicted by the glow cap", () => {
    // It gets no territory-dot fallback either — both territory layers skip
    // every isFeatureStar — so it is drawn nowhere at all.
    expect(painted.has("mast2")).toBe(false);
  });

  it("draws an edge only when BOTH endpoints are painted", () => {
    expect(edgeIsDrawable({ s: "seed1", t: "mast1" }, painted)).toBe(true);
    expect(edgeIsDrawable({ s: "seed1", t: "terr2" }, painted)).toBe(false);
    expect(edgeIsDrawable({ s: "terr2", t: "seed1" }, painted)).toBe(false);
    expect(edgeIsDrawable({ s: "seed1", t: "mast2" }, painted)).toBe(false);
    expect(edgeIsDrawable({ s: "terr2", t: "mast2" }, painted)).toBe(false);
  });

  it("reveals the deep lattice once its tier renders", () => {
    const deep = paintedStarIds(stars, new Set([0, 1, 2, 3]), [seed, mastery, evicted]);
    expect(edgeIsDrawable({ s: "seed1", t: "terr2" }, deep)).toBe(true);
    expect(edgeIsDrawable({ s: "mast2", t: "terr2" }, deep)).toBe(true);
  });
});

describe("labelableStars", () => {
  // Returns the shape `labelableStars` is generic over, rather than `as never`
  // — that cast made `stars` a `never[]`, so every `.map((s) => s._id)` below
  // was a type error AND nothing in this block was actually type-checked.
  const mk = (
    _id: string,
    displayTier: number,
    extra: Partial<{ role: string; seedId: string }> = {},
  ): DisplayStar & { _id: string; displayTier: number } => ({
    _id,
    displayTier,
    ...extra,
  });

  const seed = mk("seed1", 0, { role: "seed" });
  const mastery = mk("mast1", 0, { role: "mastery" });
  const evicted = mk("mast2", 0, { role: "mastery" });
  const overflow = mk("ovf1", 1, { role: "territory", seedId: "s9" });
  const terr = mk("terr1", 0, { role: "territory" });
  const stars = [seed, mastery, evicted, overflow, terr];

  const renderTiers = new Set([0, 1]);
  // GLOW_CAP admitted seed + mastery; `evicted` lost the cut.
  const painted = paintedStarIds(stars, renderTiers, [seed, mastery]);
  const ids = (bucket: number) =>
    labelableStars(stars, { renderTiers, painted, bucket, nonSeedBucket: 3 }).map((s) => s._id);

  it("labels seeds and seed-bearing overflow at rest", () => {
    expect(ids(0)).toContain("seed1");
    expect(ids(0)).toContain("ovf1");
  });

  it("holds plain territory and mastery back until the deepest label bucket", () => {
    expect(ids(0)).not.toContain("terr1");
    expect(ids(0)).not.toContain("mast1");
    expect(ids(3)).toContain("terr1");
    expect(ids(3)).toContain("mast1");
  });

  it("never labels a feature star evicted by the glow cap", () => {
    // The regression: it renders NOTHING (no territory-dot fallback), so its
    // label floated in empty space with no star under it — Andy, 2026-07-27,
    // "the label is too far away from its dot regardless of zoom level".
    expect(painted.has("mast2")).toBe(false);
    expect(ids(0)).not.toContain("mast2");
    expect(ids(3)).not.toContain("mast2");
  });

  it("never labels an unrevealed tier", () => {
    const shallow = paintedStarIds(stars, new Set([0]), [seed, mastery]);
    const only0 = labelableStars(stars, {
      renderTiers: new Set([0]),
      painted: shallow,
      bucket: 3,
      nonSeedBucket: 3,
    }).map((s) => s._id);
    expect(only0).not.toContain("ovf1");
  });
});
