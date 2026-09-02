import { describe, it, expect } from "vitest";
import {
  layoutSky,
  layoutSkyField,
  type SkyFieldPayload,
  type SkyStar,
  type Layout,
} from "../skyLayout";

// ── helpers ──────────────────────────────────────────────────────────────────

const DOMAINS = ["Math", "Reading", "Science", "History", "Art"];

function star(id: string, domain: string, reach?: number | null): SkyStar {
  return { _id: id, topic: `Topic ${id}`, domain, blurb: "", reach };
}

function makeStars(n: number): SkyStar[] {
  return Array.from({ length: n }, (_, i) =>
    star(`s${i}`, DOMAINS[i % DOMAINS.length], i % 3),
  );
}

function minPairwiseDist(pts: { x: number; y: number }[]): number {
  let min = Infinity;
  for (let a = 0; a < pts.length; a++) {
    for (let b = a + 1; b < pts.length; b++) {
      min = Math.min(min, Math.hypot(pts[b].x - pts[a].x, pts[b].y - pts[a].y));
    }
  }
  return min;
}

const W = 820;
const H = 1100;

// ── invariants shared across star counts ─────────────────────────────────────

function assertInvariants(layout: Layout, inputStars: SkyStar[], label: string) {
  const { stars, cx, cy } = layout;
  const maxR = Math.min(W, H) * 0.46;
  const hubKeepOut = maxR * 0.34;
  const MIN_DIST = 168;

  it(`[${label}] all coordinates finite`, () => {
    for (const s of stars) {
      expect(Number.isFinite(s.x)).toBe(true);
      expect(Number.isFinite(s.y)).toBe(true);
    }
  });

  it(`[${label}] depth within [0, 1]`, () => {
    for (const s of stars) {
      expect(s.depth).toBeGreaterThanOrEqual(0);
      expect(s.depth).toBeLessThanOrEqual(1);
    }
  });

  it(`[${label}] hub keep-out respected`, () => {
    for (const s of stars) {
      const d = Math.hypot(s.x - cx, s.y - cy);
      expect(d).toBeGreaterThanOrEqual(hubKeepOut - 0.5);
    }
  });

  if (stars.length > 1) {
    it(`[${label}] stars don't overlap (min pair dist ≥ 80% of minDist)`, () => {
      expect(minPairwiseDist(stars)).toBeGreaterThanOrEqual(MIN_DIST * 0.8);
    });
  }

  it(`[${label}] layout is deterministic`, () => {
    // Re-run with the identical input — must produce bit-exact coordinates.
    const again = layoutSky(inputStars, W, H);
    stars.forEach((s, i) => {
      expect(s.x).toBe(again.stars[i].x);
      expect(s.y).toBe(again.stars[i].y);
    });
  });
}

// ── main tests ────────────────────────────────────────────────────────────────

describe("layoutSky — dimensions", () => {
  it("returns the passed width and height", () => {
    const { width, height, cx, cy } = layoutSky(makeStars(3), W, H);
    expect(width).toBe(W);
    expect(height).toBe(H);
    expect(cx).toBe(W / 2);
    expect(cy).toBe(H / 2);
  });
});

describe("layoutSky — empty input", () => {
  it("returns empty stars array without throwing", () => {
    const layout = layoutSky([], W, H);
    expect(layout.stars).toHaveLength(0);
  });
});

describe("layoutSky — single star", () => {
  const singleStar = [star("a", "Math", 1)];
  const layout = layoutSky(singleStar, W, H);
  assertInvariants(layout, singleStar, "1 star");

  it("produces exactly one positioned star", () => {
    expect(layout.stars).toHaveLength(1);
  });
});

describe("layoutSky — 3 stars", () => {
  const stars3 = makeStars(3);
  const layout = layoutSky(stars3, W, H);
  assertInvariants(layout, stars3, "3 stars");
  it("produces 3 positioned stars", () => expect(layout.stars).toHaveLength(3));
});

describe("layoutSky — 8 stars", () => {
  const stars8 = makeStars(8);
  const layout = layoutSky(stars8, W, H);
  assertInvariants(layout, stars8, "8 stars");
  it("produces 8 positioned stars", () => expect(layout.stars).toHaveLength(8));
});

describe("layoutSky — 14 stars", () => {
  const stars14 = makeStars(14);
  const layout = layoutSky(stars14, W, H);
  assertInvariants(layout, stars14, "14 stars");
  it("produces 14 positioned stars", () => expect(layout.stars).toHaveLength(14));
});

describe("layoutSky — 18 stars (stress)", () => {
  const stars18 = makeStars(18);
  const layout = layoutSky(stars18, W, H);
  assertInvariants(layout, stars18, "18 stars");
  it("produces 18 positioned stars", () => expect(layout.stars).toHaveLength(18));
});

describe("layoutSky — reach clamping", () => {
  it("null reach is treated as 1 → depth in [0,1]", () => {
    const layout = layoutSky([star("x", "Math", null)], W, H);
    expect(layout.stars[0].depth).toBeGreaterThanOrEqual(0);
    expect(layout.stars[0].depth).toBeLessThanOrEqual(1);
  });

  it("undefined reach is treated as 1 → depth in [0,1]", () => {
    const layout = layoutSky([star("y", "Math", undefined)], W, H);
    expect(layout.stars[0].depth).toBeGreaterThanOrEqual(0);
    expect(layout.stars[0].depth).toBeLessThanOrEqual(1);
  });

  it("reach=0 gives minimum depth (≥ 0.35)", () => {
    const layout = layoutSky([star("z0", "Math", 0)], W, H);
    // reach=0 → depth = 0.35 + 0 = 0.35
    expect(layout.stars[0].depth).toBeCloseTo(0.35, 5);
  });

  it("reach=2 gives maximum depth (≤ 1)", () => {
    const layout = layoutSky([star("z2", "Math", 2)], W, H);
    // reach=2 → depth = 0.35 + 0.65 = 1.0
    expect(layout.stars[0].depth).toBeCloseTo(1.0, 5);
  });

  it("out-of-range reach > 2 is clamped to 2", () => {
    const a = layoutSky([star("hi", "Math", 99)], W, H);
    const b = layoutSky([star("hi", "Math", 2)], W, H);
    expect(a.stars[0].depth).toBeCloseTo(b.stars[0].depth, 5);
  });

  it("out-of-range reach < 0 is clamped to 0", () => {
    const a = layoutSky([star("lo", "Math", -5)], W, H);
    const b = layoutSky([star("lo", "Math", 0)], W, H);
    expect(a.stars[0].depth).toBeCloseTo(b.stars[0].depth, 5);
  });
});

describe("layoutSky — same domain grouping", () => {
  it("all-same-domain stars spread around a single wedge", () => {
    // All stars in one domain → one wedge of 2π → stars still separate
    const stars = Array.from({ length: 5 }, (_, i) => star(`d${i}`, "Math", 1));
    const layout = layoutSky(stars, W, H);
    expect(layout.stars).toHaveLength(5);
    if (layout.stars.length > 1) {
      expect(minPairwiseDist(layout.stars)).toBeGreaterThan(0);
    }
  });
});

describe("layoutSky — multi-domain ordering", () => {
  it("stable sort: domains always come out in alphabetical order", () => {
    // Two runs with the same stars but given in different order
    const run1 = layoutSky(
      [star("a", "Zebra", 1), star("b", "Alpha", 1)],
      W,
      H,
    );
    const run2 = layoutSky(
      [star("b", "Alpha", 1), star("a", "Zebra", 1)],
      W,
      H,
    );
    // "Alpha" star should have the same x,y in both runs
    const alpha1 = run1.stars.find((s) => s._id === "b")!;
    const alpha2 = run2.stars.find((s) => s._id === "b")!;
    expect(alpha1.x).toBeCloseTo(alpha2.x, 5);
    expect(alpha1.y).toBeCloseTo(alpha2.y, 5);
  });
});

describe("layoutSky — extra SkyStar fields are preserved", () => {
  it("passes through optional fields untouched", () => {
    const s: SkyStar = {
      _id: "rich",
      topic: "Topology",
      domain: "Math",
      blurb: "Knots",
      connectionTo: "prev",
      suggestionType: "related",
      pinned: true,
      visited: true,
      visitCount: 3,
      structured: false,
      reach: 1,
    };
    const layout = layoutSky([s], W, H);
    const p = layout.stars[0];
    expect(p.connectionTo).toBe("prev");
    expect(p.pinned).toBe(true);
    expect(p.visitCount).toBe(3);
  });
});

describe("layoutSkyField — night-museum roles (mastery/starter)", () => {
  const field: SkyFieldPayload = {
    nodes: [
      { id: "mastery:count_to_10", label: "Count to 10", domain: "Mathematics", source: "mastery", x: 40, y: 40, refCount: 1, hopTier: 0 },
      { id: "starter-registry:foo", label: "A someday star", domain: "exploration", source: "starter", x: 90, y: 90, refCount: 1, hopTier: 0 },
      { id: "territory-only", label: "Untouched", domain: "science", source: "standard", x: 60, y: 60, refCount: 1, hopTier: 3 },
    ],
    lit: { "mastery:count_to_10": 1 },
    starter: ["starter-registry:foo"],
    seedMeta: {
      "mastery:count_to_10": {
        kind: "mastery",
        blurb: "Practice keeps it bright.",
        pinned: false,
        structured: false,
        visited: false,
        visitCount: 0,
        completed: false,
        suggestionType: "",
        strand: "counting",
      },
      "starter-registry:foo": {
        kind: "starter",
        blurb: "A curated hook.",
        pinned: false,
        structured: false,
        visited: false,
        visitCount: 0,
        completed: false,
        suggestionType: "",
        strand: null,
      },
    },
  };

  it("a lit mastery float gets role 'mastery', tier 0 (rest-visible, like a seed), and is interactive with no seedId", () => {
    const layout = layoutSkyField(field, W, H);
    const byId = new Map(layout.stars.map((s) => [s.conceptId, s]));
    const mastery = byId.get("mastery:count_to_10")!;
    expect(mastery.role).toBe("mastery");
    expect(mastery.displayTier).toBe(0);
    expect(mastery.interactive).toBe(true);
    expect(mastery.seedId).toBeUndefined();
    expect(mastery.blurb).toBe("Practice keeps it bright.");
  });

  it("a starter float gets role 'starter', tier 0 (also rest-visible), and is interactive with no seedId", () => {
    const layout = layoutSkyField(field, W, H);
    const byId = new Map(layout.stars.map((s) => [s.conceptId, s]));
    const starter = byId.get("starter-registry:foo")!;
    expect(starter.role).toBe("starter");
    expect(starter.displayTier).toBe(0);
    expect(starter.interactive).toBe(true);
    expect(starter.seedId).toBeUndefined();
    expect(starter.blurb).toBe("A curated hook.");
  });

  it("a mastery star is dimmer/smaller than a seed (glow hierarchy)", () => {
    const withSeed: SkyFieldPayload = {
      ...field,
      nodes: [
        ...field.nodes,
        { id: "seed-a", label: "Seed", domain: "Mathematics", source: "seed", x: 50, y: 50, refCount: 1, hopTier: 0 },
      ],
      seeds: ["seed-a"],
      seedMeta: {
        ...field.seedMeta,
        "seed-a": {
          kind: "seed",
          seedId: "seed-doc",
          blurb: "an invitation",
          pinned: false,
          structured: false,
          visited: false,
          visitCount: 0,
          completed: false,
          suggestionType: "frontier",
        },
      },
    };
    const layout = layoutSkyField(withSeed, W, H);
    const byId = new Map(layout.stars.map((s) => [s.conceptId, s]));
    const mastery = byId.get("mastery:count_to_10")!;
    const seed = byId.get("seed-a")!;
    expect(mastery.visualRadius).toBeLessThan(seed.visualRadius);
    expect(mastery.glow).toBeLessThan(seed.glow);
  });

  it("a plain territory node (no seedMeta) is NOT interactive", () => {
    const layout = layoutSkyField(field, W, H);
    const byId = new Map(layout.stars.map((s) => [s.conceptId, s]));
    expect(byId.get("territory-only")?.interactive).toBe(false);
  });

  it("with no seeds at all, the initial camera frames on the mastery/starter cluster instead of the flat identity", () => {
    const layout = layoutSkyField(field, W, H);
    // The fallback fires: no seeds anywhere in `field`, but mastery+starter
    // exist, so initialCamera should NOT be the flat/unzoomed {tx:0,ty:0,scale:1}
    // a truly empty field would produce.
    expect(layout.initialCamera).not.toEqual({ tx: 0, ty: 0, scale: 1 });
    expect(layout.initialCamera.scale).toBeGreaterThan(1);
  });

  it("with only 1-2 seeds (below the cold-start bar), the camera blends seeds AND the museum layer, not seeds alone", () => {
    const fewSeeds: SkyFieldPayload = {
      ...field,
      nodes: [
        ...field.nodes,
        // A single real seed, far from the mastery/starter cluster.
        { id: "seed-far", label: "Seed", domain: "Mathematics", source: "seed", x: 5, y: 5, refCount: 1, hopTier: 0 },
      ],
      seeds: ["seed-far"],
      seedMeta: {
        ...field.seedMeta,
        "seed-far": {
          kind: "seed",
          seedId: "seed-doc",
          blurb: "an invitation",
          pinned: false,
          structured: false,
          visited: false,
          visitCount: 0,
          completed: false,
          suggestionType: "frontier",
        },
      },
    };
    const blended = layoutSkyField(fewSeeds, W, H);
    // Framing on the lone seed alone would center near (5,5)-in-content-space;
    // blending in the museum stars (at 40,40 / 90,90) pulls the centroid (and
    // therefore tx/ty) noticeably away from a seed-only framing.
    const seedOnlyFrame = layoutSkyField(
      { ...fewSeeds, lit: {}, starter: [] },
      W,
      H,
    );
    expect(blended.initialCamera.tx).not.toBeCloseTo(seedOnlyFrame.initialCamera.tx, 0);
  });

  it("a totally empty field still falls back to the flat identity camera", () => {
    const empty: SkyFieldPayload = { nodes: [] };
    const layout = layoutSkyField(empty, W, H);
    expect(layout.initialCamera).toEqual({ tx: 0, ty: 0, scale: 1 });
  });
});

describe("layoutSkyField — shared deep-field tiers", () => {
  const field: SkyFieldPayload = {
    nodes: [
      { id: "seed", label: "Seed", domain: "exploration", source: "seed", x: 20, y: 20, refCount: 1, hopTier: 3 },
      { id: "lit", label: "Lit", domain: "math", source: "mastery", x: 35, y: 30, refCount: 2, hopTier: 0 },
      { id: "near", label: "Near", domain: "science", source: "standard", x: 55, y: 45, refCount: 1, hopTier: 2 },
      { id: "overflow", label: "Overflow", domain: "art", source: "seed", x: 68, y: 60, refCount: 1, hopTier: 2 },
      { id: "deep", label: "Deep", domain: "history", source: "standard", x: 80, y: 75, refCount: 1, hopTier: 3 },
    ],
    lit: { lit: 1 },
    standardLit: ["near"],
    seeds: ["seed"],
    threads: [["lit", "seed"]],
    prereqEdges: [{ s: "lit", t: "near" }, { s: "near", t: "deep" }],
    seedMeta: {
      seed: {
        seedId: "seed-doc",
        blurb: "Try this next",
        pinned: true,
        structured: false,
        visited: false,
        visitCount: 0,
        completed: false,
        suggestionType: "related",
      },
      overflow: {
        seedId: "overflow-doc",
        blurb: "Reveal this by zooming",
        pinned: false,
        structured: false,
        visited: false,
        visitCount: 0,
        completed: false,
        suggestionType: "connection",
      },
    },
  };

  it("maps seeds/touched/near/deep with the shared tier model", () => {
    const layout = layoutSkyField(field, W, H);
    const byId = new Map(layout.stars.map((s) => [s.conceptId, s]));
    expect(byId.get("seed")?.displayTier).toBe(0);
    expect(byId.get("seed")?.seedId).toBe("seed-doc");
    // Lit mastery is REST-VISIBLE (tier 0) too, independent of hopTier — see
    // shared/skyTiers.ts classifySkyNode. Only standard/territory still grade
    // by hop distance.
    expect(byId.get("lit")?.displayTier).toBe(0);
    expect(byId.get("near")?.displayTier).toBe(2);
    expect(byId.get("overflow")?.displayTier).toBe(2);
    expect(byId.get("overflow")?.role).toBe("territory");
    expect(byId.get("overflow")?.seedId).toBe("overflow-doc");
    expect(byId.get("deep")?.displayTier).toBe(3);
    expect(layout.latticeEdges).toHaveLength(2);
    expect(layout.threads).toHaveLength(1);
  });
});
