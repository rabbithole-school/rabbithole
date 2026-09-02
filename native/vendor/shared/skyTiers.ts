// Shared, framework-free Sky display rules. Web and native render with different
// primitives, but the scholar-facing reveal model must stay identical.

const DOMAIN_PALETTE = [
  "#6fd3ab", "#9f7ae0", "#e0a96f", "#6fb6e0", "#e07a9f", "#d8d36f",
  "#7c87e8", "#56c2a6", "#c084e0", "#ecc878", "#6fb0d8", "#d8956f",
  "#8fd06f", "#d07a7a",
] as const;

const DOMAIN_COLORS: Record<string, string> = {
  math: "#6fd3ab",
  mathematics: "#6fd3ab",
  geometry: "#56c2a6",
  biology: "#9f7ae0",
  science: "#9f7ae0",
  "life science": "#9f7ae0",
  chemistry: "#c084e0",
  "physical science": "#7c87e8",
  physics: "#7c87e8",
  "earth & space science": "#6fb0d8",
  "earth-science": "#6fb0d8",
  writing: "#e0a96f",
  reading: "#ecc878",
  "ela/literacy": "#e0a96f",
  english: "#e6b86f",
  language: "#e6b86f",
  linguistics: "#e0c06f",
  "speaking & listening": "#e0c06f",
  music: "#6fb6e0",
  history: "#e07a9f",
  economics: "#d8956f",
  "civics-econ": "#d8956f",
  engineering: "#7c87e8",
  psychology: "#d8d36f",
  philosophy: "#c0b0e8",
  design: "#e0a96f",
  "social-emotional": "#d8d36f",
  exploration: "#caa23a",
};

// The at-rest "consideration set": how many seed invitations the Sky lights as
// tier-0 stars (gold ring, tappable Begin Quest) before zoom. A legible sky is a
// HANDFUL of invitations, not the whole accrued pile — older/overflow seeds are
// NOT dropped, they lose tier-0 prominence and join the field, revealed on zoom
// by hop-tier like any other territory. The single source of truth for BOTH the
// server read (convex/concepts.ts skyFieldForScholar → seeds array) and the
// direct seed list (convex/lib/seeds.ts buildScholarSky → native me.tsx).
// Native vendors this file, so web ⟷ native stay in lockstep.
export const SEED_CONSIDERATION_CAP = 8;

// The SKY MAP's own tier-0 cap (convex/concepts.ts skyFieldForScholar → the
// native sky screen + web ConceptAtlasView). Deliberately a SEPARATE constant
// from SEED_CONSIDERATION_CAP above even while it holds the same value: the
// shared constant is also the bound on the teacher-facing Class Galaxy payload
// (GALAXY_SEED_PER_SCHOLAR) and on the flat seed LIST (buildScholarSky →
// native "me" tab), so tuning what the map lights at rest
// through the shared constant silently resizes a teacher's galaxy payload too.
// The map is the only surface where the cap is a legibility judgement about a
// rendered field of stars; the others are list/payload bounds. Keep them
// independent so that judgement can be made on its own evidence.
export const SKY_FIELD_SEED_CAP = 8;

// ── Night-museum layers (Wave 4 §1: lit constellations + warm cold-start) ──
// Two ADDITIVE layers on top of the seed/invitation sky above, both display-
// only (labels + a light positioning hint — never a repetition count, mastery
// score, or the row's `source`): a scholar's demonstrated-fluent practice
// skills glow as a "lit constellation", and a brand-new scholar with too few
// real invitations gets a warm starter layer blended in instead of an empty
// void. Single source of truth for both frontends (native vendors this file).

/** The fixed "you've built this" mastery color — independent of domain, so a
 *  lit skill reads the same warm violet wherever it sits (matches the
 *  existing mastery-role color the teacher Atlas already uses below). */
export const MASTERY_STAR_COLOR = "#c79cf2";

/** How many fluent practice skills the mastery layer surfaces at once (most
 *  recently earned first), so an advanced scholar's sky doesn't fill with
 *  noise. */
export const MASTERY_STAR_CAP = 40;

/** Mastery stars sit close to the hub — an inner, already-lit ring — so the
 *  seed/invitation layer (which spans the full 0..2 `reach` range) stays the
 *  outermost, BRIGHTEST layer. */
export const MASTERY_STAR_REACH = 0.15;

/** Fewer real sky stars (seeds) than this and the cold-start layer blends in
 *  (frontier "next step" stars + a curated cross-domain sampler), so a brand-
 *  new scholar's first look isn't an empty void. */
export const SKY_COLD_START_MIN_STARS = 3;

/** A cold-start "next step" star (one per practiced strand's frontier skill)
 *  sits at a middling reach — a real, near-term invitation, not a far dream. */
export const STARTER_FRONTIER_REACH = 0.9;

/** A cold-start curated cross-domain sampler sits far out — a "someday" star,
 *  display-only until the scholar earns real invitations of their own. */
export const STARTER_REGISTRY_REACH = 1.8;

/** How many curated cross-domain gate entries the cold-start layer samples. */
export const STARTER_REGISTRY_COUNT = 3;

export type SkyRole = "mastery" | "standard" | "seed" | "starter" | undefined;
export type SkyDisplayTier = 0 | 1 | 2 | 3;

export type SkyNodeDisplay = {
  tier: SkyDisplayTier;
  c: string;
  r: number;
  glow: number;
  meta: string;
  ring?: boolean;
};

function hashColor(s: string): string {
  let h = 0;
  for (const c of s) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return DOMAIN_PALETTE[h % DOMAIN_PALETTE.length];
}

export function domainColor(domain: string | null | undefined): string {
  const raw = domain || "other";
  return DOMAIN_COLORS[raw.toLowerCase()] ?? hashColor(raw);
}

export function skyDisplayTier({
  isSeed,
  hopTier,
}: {
  isSeed?: boolean;
  hopTier?: number | null;
}): SkyDisplayTier {
  if (isSeed) return 0;
  const hop = hopTier ?? 3;
  if (hop === 0) return 1;
  if (hop <= 2) return 2;
  return 3;
}

export function classifySkyNode({
  role,
  domain,
  refCount,
  hopTier,
}: {
  role: SkyRole;
  domain: string | null | undefined;
  refCount?: number | null;
  hopTier?: number | null;
}): SkyNodeDisplay {
  const dom = domainColor(domain);
  if (role === "seed") {
    return {
      tier: 0,
      c: "#e7c25c",
      r: 2.5,
      glow: 1.2,
      meta: "an invitation to explore",
      ring: true,
    };
  }

  if (role === "mastery") {
    // REST-VISIBLE (tier 0, like a seed) — the whole point of "you built
    // this" is that it's true on first glance, not something you have to
    // zoom to discover. Independent of hopTier (unlike standard/territory
    // below): a demonstrated skill doesn't need graph proximity to earn its
    // place in the sky. Deliberately DIMMER + SMALLER than a seed (r/glow
    // both below the seed's 2.5/1.2) so it reads as a faint, warm, earned
    // glow — never competing with a real invitation, which stays the
    // sky's unambiguous brightest layer.
    return {
      tier: 0,
      c: MASTERY_STAR_COLOR,
      r: 1.7 + ((refCount ?? 1) > 1 ? 0.3 : 0),
      glow: 0.6,
      meta: "you've shown this",
    };
  }
  // Cold-start "someday" star (see convex/lib/skyMuseum.ts) — also REST-
  // VISIBLE (tier 0): a brand-new scholar's sky must show something on first
  // glance, not a blank void that only reveals on zoom. A domain-colored,
  // muted cousin of a real seed/mastery star — dimmer than both, but still a
  // legible, tappable point.
  if (role === "starter") {
    return {
      tier: 0,
      c: dom,
      r: 1.5,
      glow: 0.4,
      meta: "a star to grow into",
    };
  }

  const tier = skyDisplayTier({ hopTier });
  if (role === "standard") {
    return { tier, c: dom, r: 2.0, glow: 1.2, meta: "reached" };
  }
  return {
    tier,
    c: dom,
    r: tier >= 3 ? 1.6 : 1.9,
    glow: 0,
    meta: "in the wider field",
  };
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

export function layoutAtlasPoint(
  point: { x: number; y: number },
  center: { x: number; y: number },
  declumpK = 0.7,
): { x: number; y: number } {
  const dx = point.x - center.x;
  const dy = point.y - center.y;
  const r = Math.hypot(dx, dy) || 1e-3;
  const gamma = 1 - 0.55 * declumpK;
  const maxR = 62;
  const k = (maxR * Math.pow(Math.min(r / maxR, 1), gamma)) / r;
  return {
    x: clamp(center.x + dx * k, 2, 98),
    y: clamp(center.y + dy * k, 2, 98),
  };
}
