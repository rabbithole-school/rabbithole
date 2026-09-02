// Pure, framework-free Sky *display* rules for the native star map — the
// level-of-detail (LOD) gating, the seed/mastery "feature" split, and the
// capped, collision-rejected label selection. Kept out of sky.tsx so the rules
// are unit-testable without a device, and mirror the web engine (lib/atlasEngine
// + shared/skyTiers): tier 0 (seeds) at rest, tier N reveals at zoom bucket ≥ N;
// only seeds + lit mastery carry a glow; territory is a plain dot.

export type ZoomBucket = 0 | 1 | 2 | 3;

/**
 * Camera zoom clamp, expressed as a RATIO of the at-rest framing. Native's base
 * (at-rest) camera scale is 1, so on this surface the ratio IS the scale — which
 * is what lets `zoomBucketFor` read `scale` directly. Mirrors atlasEngine's
 * onWheel clamp (`baseZoom*0.6 … baseZoom*4`): the ratio ladder in
 * `zoomBucketFor` must be able to reach bucket 3 (ratio ≥ 2.8) with real headroom
 * PAST it so the deep field can spread apart as you keep zooming — hence max 4
 * (the old 3.5 put bucket 3 right at the ceiling, which is why deep zoom felt
 * shallow + crammed). Min 0.6 = a touch of zoom-out, matching web.
 */
export const MIN_ZOOM = 0.6;
export const MAX_ZOOM = 8; // was 4 — Andy wants 2× deeper exploration zoom (2026-07-06)

/**
 * Per-bucket sublinear growth damping for stars: without it a tiny dot balloons
 * into a blob at deep zoom (the "deep field too distracting" failure). Stars
 * still grow with the camera — just sublinearly. Applied to BOTH the territory
 * dots AND the feature (seed/mastery) stars, so the seed = 1.5× blue-star size
 * ratio stays constant at every zoom. Mirrors atlasEngine's ATTEN exactly
 * ([1, 0.9, 0.72, 0.55]); index by zoom bucket.
 */
export const STAR_ATTEN = [1, 0.9, 0.72, 0.55] as const;

/** CONTINUOUS attenuation — the smooth curve the STAR_ATTEN ladder always
 * approximated (s^-0.43 fits the tuned anchors: 1.3→.89, 1.9→.76, 4→.55).
 * Discrete per-bucket steps made every bucket crossing SNAP star/dot/stroke
 * sizes ~20% at once, which read as flicker while zooming (Andy, 2026-07-06);
 * evaluating the curve per-frame/per-snapshot makes size a continuous function
 * of the camera — displayed size grows as s^0.57, no step at any boundary.
 * Worklet-safe (pure Math). Clamped to 1 below scale 1 (no inflation zoomed out). */
export const ATTEN_EXP = 0.43;
export function attenAt(scale: number): number {
  "worklet";
  return scale <= 1 ? 1 : Math.pow(scale, -ATTEN_EXP);
}

/**
 * Quantized zoom buckets. MUST stay in lockstep with the `zoomBucket` worklet in
 * sky.tsx (that copy runs on the UI thread inside useAnimatedReaction; this copy
 * is the JS/testable source used for the derived visible/label sets).
 * Thresholds mirror lib/atlasEngine bucketOf.
 */
export function zoomBucketFor(scale: number): ZoomBucket {
  if (scale < 1.3) return 0;
  if (scale < 1.9) return 1;
  if (scale < 2.8) return 2;
  return 3;
}

/**
 * Tier LOD gate — tier 0 (seeds) is always visible; a deeper tier only reveals
 * once the camera is zoomed into its bucket. Mirrors atlasEngine.tierVisibleNow
 * (t===0 || (t===1&&b>=1) || (t===2&&b>=2) || (t===3&&b>=3)).
 */
export function tierVisibleAtBucket(tier: number, bucket: number): boolean {
  if (tier <= 0) return true;
  if (tier === 1) return bucket >= 1;
  if (tier === 2) return bucket >= 2;
  return bucket >= 3;
}

/**
 * Opacity for a *visible* star. Hidden tiers return 0 (the fix for the old
 * tierOpacity, which floored at 0.085-0.2 and so painted the whole field at
 * rest). Once a tier IS revealed it renders at web's ENGINE_CSS strength —
 * t1/t2 fully opaque (op 1), the deep field (tier 3) at .72 (the web's
 * `.zl3 .t3` opacity).
 */
export function starOpacityAtBucket(tier: number, bucket: number): number {
  if (!tierVisibleAtBucket(tier, bucket)) return 0;
  if (tier <= 0) return 1;
  if (tier === 1) return 1;
  if (tier === 2) return 1;
  return 0.72;
}

/** The minimal star shape the display rules read. */
export type DisplayStar = {
  role?: string;
  seedId?: string;
  visited?: boolean;
  completed?: boolean;
  refCount?: number | null;
  visitCount?: number | null;
};

/**
 * A "feature" star earns the expensive glow/ring/twinkle treatment: seeds (the
 * gold invitations) and lit mastery (a demonstrated understanding). Everything
 * else — standards, untouched territory — is a plain, glowless, un-animated dot.
 * This is the split that lets us cap the number of glowing elements.
 */
export function isFeatureStar(star: DisplayStar): boolean {
  if (star.role === "seed") return true;
  if (star.role === "mastery") return true;
  return !!(star.visited || star.completed);
}

/**
 * The set of star IDs actually PAINTED for a given render pass: every
 * tier-visible territory dot, plus the feature stars that survived the
 * GLOW_CAP cut. Edges are gated on this — see `edgeIsDrawable`.
 *
 * The subtle part is the feature branch. A feature star that loses the
 * GLOW_CAP race gets NO territory-dot fallback, because both territory layers
 * skip every `isFeatureStar` — so it vanishes completely and any edge into it
 * is a line to nowhere. Passing the ALREADY-CAPPED feature list (not the
 * tier-visible candidates) is what makes this correct.
 */
export function paintedStarIds<T extends DisplayStar & { _id: string; displayTier: number }>(
  stars: readonly T[],
  renderTiers: ReadonlySet<number>,
  cappedFeatures: readonly T[],
): Set<string> {
  const ids = new Set<string>();
  for (const s of stars) {
    if (isFeatureStar(s)) continue;
    if (!renderTiers.has(s.displayTier)) continue;
    ids.add(s._id);
  }
  for (const f of cappedFeatures) ids.add(f._id);
  return ids;
}

/**
 * Should this edge be stroked? Both endpoints must be painted, or it renders as
 * a stray line — or worse, an arrowhead landing in empty space.
 *
 * Stars were always tier-gated and capped; edges were culled ONLY by a viewport
 * intersection test, so the deep prerequisite graph drew its edges across the
 * opening view while its nodes stayed hidden (Andy, 2026-07-26: "some of the
 * lines don't connect to stars").
 */
export function edgeIsDrawable(
  edge: { s: string; t: string },
  painted: ReadonlySet<string>,
): boolean {
  return painted.has(edge.s) && painted.has(edge.t);
}

/**
 * Which stars may compete for a label slot this pass — policy only; the caller
 * still measures the text and runs `selectLabels` for collisions and the cap.
 *
 * Gated on `painted` for exactly the reason `edgeIsDrawable` is: a feature star
 * that loses the GLOW_CAP cut renders NOTHING (both territory layers skip every
 * `isFeatureStar`), so labeling it strands the text in empty space with no star
 * beneath it — the label version of "a line to nowhere". It only bites at real
 * density (40 mastery stars + the tier-0 invitations clears GLOW_CAP = 46),
 * which is why sparse fixtures never showed it.
 *
 * Seeds — and any star carrying a `seedId` — label as soon as their tier
 * reveals, because an invitation you can't read isn't an invitation. Plain
 * territory waits for the deepest label bucket.
 */
export function labelableStars<T extends DisplayStar & { _id: string; displayTier: number }>(
  stars: readonly T[],
  opts: {
    renderTiers: ReadonlySet<number>;
    painted: ReadonlySet<string>;
    bucket: number;
    nonSeedBucket: number;
  },
): T[] {
  const out: T[] = [];
  for (const s of stars) {
    if (!opts.renderTiers.has(s.displayTier)) continue;
    if (!opts.painted.has(s._id)) continue;
    if (s.role !== "seed" && !s.seedId && opts.bucket < opts.nonSeedBucket) continue;
    out.push(s);
  }
  return out;
}

/**
 * Label priority — highest wins a slot first. Seeds (actionable invitations)
 * lead, then lit mastery, then reached standards / convergence (refCount),
 * then a night-museum "starter" cold-start star (a discoverable someday
 * invitation, but never louder than a real seed/standard), then plain
 * territory (whose label only reveals on deep zoom). Mirrors the imp scoring
 * in atlasEngine's sky branch.
 */
export function starLabelPriority(star: DisplayStar): number {
  const refBonus = Math.min(4, Math.max(0, (star.refCount ?? 1) - 1));
  if (star.role === "seed") return 100;
  if (star.seedId) return 90;
  if (star.role === "mastery" || star.visited || star.completed) return 60 + refBonus;
  if (star.role === "standard") return 40 + refBonus;
  if (star.role === "starter") return 25 + refBonus;
  return 10 + refBonus;
}

export type LabelCandidate = {
  id: string;
  /** screen-space anchor of the star (px). */
  sx: number;
  sy: number;
  /** higher = placed first. */
  priority: number;
  /** screen-space label box size (px) — constant, never scaled by the camera. */
  width: number;
  height: number;
  /** label sits above (true) or below the anchor. */
  above: boolean;
};

export type LabelViewport = { width: number; height: number; margin: number };

function overlaps(
  a: { x: number; y: number; w: number; h: number },
  b: { x: number; y: number; w: number; h: number },
): boolean {
  return !(a.x + a.w < b.x || b.x + b.w < a.x || a.y + a.h < b.y || b.y + b.h < a.y);
}

/**
 * Pick up to `cap` labels that don't collide, highest priority first. Off-screen
 * candidates (outside viewport + margin) are dropped. Screen-space AABB
 * rejection — the native analogue of atlasEngine.relayoutLabels. Pure + stable:
 * ties broken by id so the result is deterministic. Returns the kept ids.
 */
export function selectLabels(
  cands: LabelCandidate[],
  viewport: LabelViewport,
  cap: number,
): string[] {
  const sorted = [...cands].sort(
    (a, b) => b.priority - a.priority || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
  const placed: { x: number; y: number; w: number; h: number }[] = [];
  const keep: string[] = [];
  const { width, height, margin } = viewport;
  for (const c of sorted) {
    if (keep.length >= cap) break;
    if (c.sx < -margin || c.sx > width + margin || c.sy < -margin || c.sy > height + margin) {
      continue;
    }
    const box = {
      x: c.sx - c.width / 2,
      y: c.above ? c.sy - c.height : c.sy,
      w: c.width,
      h: c.height,
    };
    if (placed.some((p) => overlaps(box, p))) continue;
    placed.push(box);
    keep.push(c.id);
  }
  return keep;
}
