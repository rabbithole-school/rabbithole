import { type ReactElement, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { router, useLocalSearchParams } from "expo-router";
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import Svg, { Circle, Defs, Line, Polygon, RadialGradient, Stop } from "react-native-svg";
import * as Haptics from "expo-haptics";
import Animated, {
  cancelAnimation,
  Easing,
  runOnJS,
  useAnimatedReaction,
  useAnimatedStyle,
  useDerivedValue,
  useSharedValue,
  withDecay,
  withRepeat,
  withSequence,
  withSpring,
  withTiming,
  type SharedValue,
} from "react-native-reanimated";

import { api, type Id } from "@/lib/convex";
import {
  layoutSkyField,
  type Camera,
  type PositionedEdge,
  type PositionedStar,
  type SkyFieldPayload,
} from "@/lib/skyLayout";
import {
  edgeIsDrawable,
  isFeatureStar,
  labelableStars,
  MAX_ZOOM,
  paintedStarIds,
  MIN_ZOOM,
  selectLabels,
  starLabelPriority,
  attenAt,
  starOpacityAtBucket,
  tierVisibleAtBucket,
  type LabelCandidate,
} from "@/lib/skyDisplay";
import {
  arrowTipGap,
  featureStarMetrics,
  SEED_RING_STROKE,
  starGrowthAt,
  starHitRadius,
  territoryDotR,
} from "@/lib/skyStarMetrics";
import { segmentIntersectsRect } from "@/lib/crispSvg";
import { colorForDomain, palette } from "@/theme";
import { StarDrawer } from "@/components/StarDrawer";
import { TreeMapNative } from "@/components/tree/TreeMapNative";
import { useMapGates } from "@/hooks/useMapGates";

// The night sky. A deep-space canvas of the scholar's seeds, laid out as a
// constellation around a hub. Pinch to zoom, drag to pan, tap a star to open
// a StarDrawer with mastery evidence and a quest CTA.
// Stars are glowing SVG radial-gradient points sized by visit count and lit by
// mastery, mirroring the web sky (components/sky/skyVisuals.tsx). The whole chart
// is one pan/zoom stage: background dust, lines, hub,
// and stars move together. No device-motion — that read as unstable.

const SPACE = palette.navy[900];
// Header height BELOW the safe-area inset — single source of truth for both the
// top bar's own height and the content-top offset in tree mode, so the segmented
// [Sky Map | Tree Map] pill (~42pt tall, plus ~6pt breathing top/bottom) can
// never overlap the tree webview again.
const HEADER_H = 54;
const DUST_COLOR = "#cfd0ee";
// Background dust translates at this fraction of the pan delta — sits "behind"
// the stars without needing device motion, the same depth cue as a parallax scroll.
const DUST_PARALLAX = 0.35;
// Cap fling velocity so a hard swipe doesn't launch the map off-screen.
const MAX_FLING_VELOCITY = 2500;

// Prereq/unlock lattice + thread arrows: a thin, OPAQUE dark-blue vector overlay.
// navy[500] (#222656, the brand's base navy) is the truest "dark blue", but at a
// 1px width it's nearly invisible on the near-black sky (SPACE = navy[900]
// #0d0f22 → only ~1.25:1 contrast). navy[400] (#596091) is the darkest navy that
// still reads clearly as a crisp 1px dark-blue line on that background (~2.5:1),
// so it's the base. A selected star's prereq chain brightens to navy[200]
// (#9ea2bf) so the hovered edges still pop while staying in the blue family.
// Darkened a half-step below navy[400] (2026-07-06, Andy: reduce contrast) —
// now that the lattice renders at native screen resolution the lines read
// stronger than the old soft raster did, so the color comes down to compensate.
// #3e4374 = the navy[400] (#596091) ↔ navy[500] (#222656) midpoint.
const LATTICE_COLOR = "#3e4374"; // opaque dark blue, 1px base
const LATTICE_COLOR_ACTIVE = palette.navy[200]; // #9ea2bf — brighter blue when selected

type SkyViewMode = "sky" | "tree";

// ── Level-of-detail + label caps ──────────────────────────────────────────────
// Only a HANDFUL of glowing seed/mastery stars and a HARD-capped set of
// collision-free labels are ever on screen at once — the rest of the field is
// plain, glowless dots gated in by zoom bucket. This is what keeps the map at
// 60fps with ~900 nodes (see native/src/lib/skyDisplay.ts for the rules).
const LABEL_CAP = 28; // max simultaneously-visible labels (web sky caps at 70).
const GLOW_CAP = 46; // max glowing (seed + lit mastery) star components.
// ── Press / hover feedback ───────────────────────────────────────────────────
// A star has no Pressable of its own — the gesture canvas owns every touch and
// hit-tests to the nearest star — so touching one used to produce no feedback
// at all until the drawer animated in. These give the touch somewhere to land:
// the star flares under a finger and lifts slightly under an iPadOS trackpad
// pointer. Pressed is deliberately well clear of hovered; a hover that looks
// like a press implies the drawer is already opening.
const PRESS_SCALE = 1.5;
const HOVER_SCALE = 1.22;
const PRESS_SPRING = { damping: 13, stiffness: 320, mass: 0.5 } as const;
// Focus halo radius, in the same content units as the star geometry. Scale
// alone is nearly invisible on a ~10px glyph, and the halo doubles as an honest
// hint at how generous the tap target actually is (see starHitRadius).
const FOCUS_RING_R = 11;
// At the opening zoom the seeds are the headline: everything else stays a small,
// UNLABELED dot until you zoom in to explore a region. Non-seed labels reveal
// only at bucket ≥ this (deeper than any seed-framed opening, which tops out at
// bucket 2), and non-seed dots render at NON_SEED_DOT_SCALE of their size so the
// deep field reads as quiet background, not a competing wall of stars.
const NON_SEED_LABEL_BUCKET = 3;
// Live-hide hysteresis for non-seed labels: REVEAL is settle-time and needs
// bucket 3 (scale >= 2.8, conservative — no flicker while still zooming in);
// HIDE is LIVE — a per-label worklet watches the camera and fades the label the
// moment the zoom drops below this, mid-gesture, without waiting for the settle
// recompute (Andy, 2026-07-06: hide aggressively, show conservatively). The
// 0.1 gap below the bucket-3 boundary keeps the two edges from chattering.
const NON_SEED_LABEL_HIDE_SCALE = 2.7;
// Label text reads too small on iPad at the base size (same finding as the Tree
// map). SKY_LABEL_SCALE enlarges the label font AND its collision-box dims
// together (so labels stay legible without clipping/overlap — fewer fit, which
// is correct). Matches the Tree's TREE_LABEL_SCALE (1.6). Tunable.
// 1.6 matched the Tree embed's old TREE_LABEL_SCALE but read CHUNKY next to the
// app's 12.5-17px body text (Andy, 2026-07-06) — 1.25 (~14.4px) sits inside it.
const SKY_LABEL_SCALE = 1.25;
const LABEL_FONT = 11.5 * SKY_LABEL_SCALE; // ≈14.4 — constant on-screen px (never scaled by the camera).
const LABEL_LINE_H = 14 * SKY_LABEL_SCALE; // ≈17.5
const LABEL_MAX_W = 150 * SKY_LABEL_SCALE; // ≈187.5
const LABEL_PAD = 3 * SKY_LABEL_SCALE; // ≈3.75
const LABEL_BOX_W = LABEL_MAX_W + 8;
// Star/dot geometry — the whole size ladder (seed > mastery > territory), the
// zoom growth cap, and the DOT_SCALE unit conversion live in lib/skyStarMetrics
// so the sizes that actually get DRAWN are unit-testable. See that file's header
// for why (the renderer used to ignore shared/skyTiers' visualRadius/glow and
// invert the hierarchy, with no test able to catch it).
// Viewport cull margin (fraction of the screen kept painted beyond the edges) so
// a pan/fling doesn't reveal blank gutters before the set is recomputed.
const CULL_MARGIN = 0.6;
// The TOP camera scale of each zoom bucket (zoomBucket boundaries + MAX_ZOOM).
// Feature stars + the hub are drawn at (atten × this) and the follow worklet
// scales them DOWN to the live camera — the raster is only ever minified.
// WHY screen-space (measured 2026-07-06): everything inside the camera canvas
// composites through a CONTENT-resolution buffer under Fabric/Reanimated, so
// no transform-based oversample can add density there (blur at 4× zoom was
// IDENTICAL with a 1× and a 2.25× oversampled drawing). Screen-space overlays
// (like the labels, which are pin-sharp at every zoom) have no such ceiling.
const BUCKET_TOP_SCALE = [1.3, 1.9, 2.8, MAX_ZOOM] as const;
// Screen-space lattice layer: fraction of the viewport kept painted beyond each
// edge so a pan/fling doesn't reveal blank gutters before the settle re-render.
// The layer's raster is viewport-sized × (1+2m)² — zoom-independent memory.
const LATTICE_MARGIN = 0.25;

// ── Bucket cross-fade (web parity) ─────────────────────────────────────────────
// When the zoom bucket flips, a newly-revealed tier FADES IN (mounts at opacity 0
// and ramps to its target) and a hidden tier FADES OUT (ramps to 0, then unmounts
// after the fade) — instead of the old hard pop where tiers mounted/unmounted
// abruptly. Mirrors the web atlasEngine, which CSS-transitions `.astar` opacity
// .5s and `.albl` (labels) .4s on a zl-bucket class flip. Driven by per-tier
// Reanimated shared values set via withTiming on the bucket change, so the fade
// runs entirely on the UI thread — NO per-frame JS.
const FADE_STAR_MS = 500; // stars + feature glow (web `.astar` opacity .5s ease)
const FADE_LABEL_MS = 200; // labels — 200ms, matching the web tree's label fade
const FADE_EASING = Easing.out(Easing.ease);
// Keep an outgoing tier mounted just past its fade so it can fade OUT before being
// dropped from the render set (web removes a faded label ~450ms after opacity 0).
const FADE_RETAIN_MS = FADE_STAR_MS + 80;

const ABSOLUTE_FILL = {
  position: "absolute",
  top: 0,
  left: 0,
  right: 0,
  bottom: 0,
} as const;

function hash01(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return ((h >>> 0) % 1000) / 1000;
}

/**
 * Faint background "dust" — the deterministic ambient layer, laid out over a
 * 2×2-viewport tile anchored at (−W/2, −H/2) so the parallax drift can't pull
 * a bare edge into view. Density matches the web sky's 30-per-viewport; the
 * count scales with the area so the look is unchanged.
 *
 * Coordinates are TILE-space (0…2W), i.e. screen space at any zoom: the dust
 * plane never scales (see `dustLayerStyle`), so `r` is a real pixel radius.
 */
const DUST_TILE = 2;
function backgroundDust(width: number, height: number) {
  const dots: { x: number; y: number; r: number; o: number }[] = [];
  for (let i = 0; i < 30 * DUST_TILE * DUST_TILE; i++) {
    dots.push({
      x: ((hash01(`bgx${i}`) * 96 + 2) / 100) * width * DUST_TILE,
      y: ((hash01(`bgy${i}`) * 92 + 4) / 100) * height * DUST_TILE,
      r: hash01(`bgs${i}`) > 0.8 ? 3 : 2,
      o: 0.35 + hash01(`bgo${i}`) * 0.4,
    });
  }
  return dots;
}

// Quantized zoom buckets — the UI-thread copy driving the derived-state reaction.
// MUST stay in lockstep with zoomBucketFor in lib/skyDisplay (kept a separate,
// workletized copy because a plain imported fn can't be called inside the
// useAnimatedReaction worklet).
function zoomBucket(z: number) {
  "worklet";
  if (z < 1.3) return 0;
  if (z < 1.9) return 1;
  if (z < 2.8) return 2;
  return 3;
}

// Bucket boundaries (zoomBucket's thresholds) + a ±3% hysteresis band so
// hovering the camera at a boundary can't re-trigger the tier cross-fades
// back and forth — the second half of the zoom-flicker fix (the first half
// is the continuous attenAt sizing).
const BUCKET_BOUNDS = [1.3, 1.9, 2.8] as const;
function hystBucket(z: number, prev: number): number {
  "worklet";
  const raw = zoomBucket(z);
  if (raw === prev) return prev;
  if (raw > prev) return z >= BUCKET_BOUNDS[raw - 1] * 1.03 ? raw : prev;
  return z <= BUCKET_BOUNDS[prev - 1] * 0.97 ? raw : prev;
}

// A "feature" star — a seed (gold ring + glow) or lit mastery (white core +
// colored glow). These are the ONLY glowing/animated star components, and their
// count is capped (GLOW_CAP). Territory is drawn separately as plain dots. The
// old per-star bucket-opacity worklets are gone: visibility is now decided by
// the derived `features` set (off the render loop), so each mounted FeatureStar
// only animates its twinkle.
function FeatureStar({
  star,
  bucket,
  tx,
  ty,
  scale,
  pressedStarId,
  hoveredStarId,
}: {
  star: PositionedStar;
  bucket: number;
  tx: SharedValue<number>;
  ty: SharedValue<number>;
  scale: SharedValue<number>;
  pressedStarId: SharedValue<string | null>;
  hoveredStarId: SharedValue<string | null>;
}) {
  const color = star.color ?? colorForDomain(star.domain);
  const isSeed = star.role === "seed";
  const lit = !!(star.visited || star.completed || star.role === "mastery");
  // Drawn geometry comes from lib/skyStarMetrics — a seed's settled ring/halo,
  // or a non-seed's seed-pinned budget modulated by the star's own shared
  // `visualRadius`. There is deliberately NO visit-count size ramp: visit count
  // is not part of the sky's visual vocabulary anywhere else, and ramping on it
  // is what grew a finished concept to 3.3-4.9x the diameter of a live
  // invitation (see skyStarMetrics' header).
  const metrics = featureStarMetrics(star);

  const tw = useSharedValue(lit ? 0.85 : 1);
  // Twinkle is a mount-only animation: its timing is derived from the star's
  // identity + lit state as they are AT MOUNT and deliberately never restarts
  // (a keyed FeatureStar keeps a fixed star; a rare lit flip must not re-seed
  // the loop). Snapshot those inputs once so the effect's dep set is honestly
  // empty of reactive values.
  const [twinkle] = useState(() => {
    const delay = (star._id.charCodeAt(0) % 7) * 160;
    return { delay, lo: lit ? 0.7 : 0.5, dur: lit ? 1900 : 1100 };
  });
  useEffect(() => {
    tw.set(withRepeat(
      withSequence(
        withTiming(twinkle.lo, { duration: twinkle.dur + twinkle.delay, easing: Easing.inOut(Easing.ease) }),
        withTiming(1, { duration: twinkle.dur + twinkle.delay, easing: Easing.inOut(Easing.ease) }),
      ),
      -1,
      true,
    ));
    return () => cancelAnimation(tw);
  }, [twinkle, tw]);
  const twinkleStyle = useAnimatedStyle(() => ({ opacity: tw.get() }));

  // Seed: a small gold ring (outer edge ≈1.5× a blue star) inside a subtle halo.
  // Non-seed: a small bright core inside a warm halo in the star's OWN shared
  // color (mastery = MASTERY_STAR_COLOR) — not another wash of white.
  const D = metrics.diameter;
  const r = D / 2;
  const coreR = metrics.coreR;
  const gradId = `g${star._id.replace(/[^a-zA-Z0-9_-]/g, "")}`;

  // Bloom gradient stops — a soft halo in the star's OWN colour, under the core.
  // Seeds keep their gold bloom. Non-seeds no longer get a white inner stop: the
  // old treatment ran white -> #FFF8E1 -> #FFECB3 over a 25-37px radius, which at
  // any real mastery density painted the field with low-frequency "cotton ball"
  // bokeh and (Andy, 2026-07-26) "gives mixed messages about its importance".
  // The halo now stays chromatic all the way in, so an earned star reads as a
  // coloured point of light rather than a wash of white.
  // (An array, not a Fragment — react-native-svg types RadialGradient children
  // as an element list.)
  const bloomStops = isSeed
    ? [
        <Stop key="0" offset="0" stopColor={color} stopOpacity={0.95} />,
        <Stop key="1" offset="0.35" stopColor={color} stopOpacity={0.5} />,
        <Stop key="2" offset="1" stopColor={color} stopOpacity={0} />,
      ]
    : [
        <Stop key="0" offset="0" stopColor={color} stopOpacity={0.7} />,
        <Stop key="1" offset="0.55" stopColor={color} stopOpacity={0.34} />,
        <Stop key="2" offset="1" stopColor={color} stopOpacity={0} />,
      ];

  // SCREEN-SPACE star (like SkyLabel): the glyph lives OUTSIDE the camera
  // canvas — a per-frame worklet pins it to the star's screen position — because
  // inside the canvas everything composites through a content-resolution buffer
  // that no oversample can beat (see BUCKET_TOP_SCALE). It is DRAWN at the
  // largest size its bucket can display (atten × bucket-top scale) and the
  // worklet scales it DOWN to the live camera, so the raster is always minified
  // (crisp), never stretched (blurry). Size damping is the CONTINUOUS attenAt
  // curve (skyDisplay) evaluated per-frame in the worklet — displayed size is
  // base × s·attenAt(s) at every camera scale, so a bucket crossing changes
  // ONLY the raster density (drawn ÷ worklet factors cancel exactly) and the
  // glyph never snaps in size mid-zoom (the old per-bucket STAR_ATTEN steps
  // read as flicker). The seed = 1.5× blue-star ratio holds at every zoom.
  //
  // starGrowthAt applies DOT_GROWTH_CAP — the SAME ceiling territory dots use.
  // Feature stars were previously uncapped, so above scale ~2.41 the dots
  // stopped growing while the stars kept going (s^0.57 → ~3.27× at MAX_ZOOM),
  // which is what let a mastery bloom reach ~245px. Both the drawn factor and
  // the worklet factor clamp identically, so they still cancel exactly and a
  // bucket crossing changes only raster density.
  const b = Math.max(0, Math.min(3, bucket));
  const top = BUCKET_TOP_SCALE[b];
  const rr = starGrowthAt(top); // drawn size factor = the bucket-top's capped size
  // Primitives + explicit deps — see SkyLabel's follow worklet for why (a live
  // re-layout must rebuild the closure or the glyph strands at its old spot).
  const sx = star.x;
  const sy = star.y;
  // Press / hover reaction. A star has no Pressable of its own (the gesture
  // canvas owns every touch), so the canvas publishes WHICH star is under the
  // pointer and each star springs itself. Only interactive stars react — a
  // territory dot that flared under the finger would promise a drawer that
  // never opens.
  const id = star._id;
  const reactive = star.interactive;
  const react = useDerivedValue(() => {
    if (!reactive) return 1;
    const target =
      pressedStarId.get() === id ? PRESS_SCALE : hoveredStarId.get() === id ? HOVER_SCALE : 1;
    return withSpring(target, PRESS_SPRING);
  }, [id, reactive, pressedStarId, hoveredStarId]);
  const focusStyle = useAnimatedStyle(
    () => ({
      opacity: reactive
        ? withTiming(
            pressedStarId.get() === id ? 1 : hoveredStarId.get() === id ? 0.55 : 0,
            { duration: 110 },
          )
        : 0,
    }),
    [id, reactive, pressedStarId, hoveredStarId],
  );
  const follow = useAnimatedStyle(
    () => ({
      transform: [
        { translateX: sx * scale.get() + tx.get() },
        { translateY: sy * scale.get() + ty.get() },
        { scale: (starGrowthAt(scale.get()) / rr) * react.get() },
      ],
    }),
    [sx, sy, rr, tx, ty, scale, react],
  );
  return (
    <Animated.View pointerEvents="none" style={[styles.starAnchor, follow]}>
      {/* Focus halo — fades in under a finger or an iPadOS pointer. Sits BELOW
          the glyph so it reads as the star lighting its own surroundings. */}
      {reactive && (
        <Animated.View
          pointerEvents="none"
          style={[
            {
              position: "absolute",
              left: -FOCUS_RING_R * rr,
              top: -FOCUS_RING_R * rr,
              width: FOCUS_RING_R * 2 * rr,
              height: FOCUS_RING_R * 2 * rr,
              borderRadius: FOCUS_RING_R * rr,
              borderWidth: 1.25 * rr,
              borderColor: color,
              backgroundColor: `${color}22`,
            },
            focusStyle,
          ]}
        />
      )}
      <Animated.View style={[{ position: "absolute", left: -r * rr, top: -r * rr }, twinkleStyle]}>
        <Svg width={D * rr} height={D * rr}>
          <Defs>
            <RadialGradient id={gradId} cx="50%" cy="50%" r="50%">
              {bloomStops}
            </RadialGradient>
          </Defs>
          {/* soft colored bloom */}
          {metrics.hasBloom && (
            <Circle cx={r * rr} cy={r * rr} r={r * rr} fill={`url(#${gradId})`} />
          )}
          {metrics.isRing ? (
            // Seed: a gold ring (the "invitation" cue Andy likes) over the glow,
            // now with a LIT centre dot. A bare ring on a near-black field reads
            // as an empty/disabled outline — exactly backwards for the one
            // object on this map a scholar can act on.
            <>
              <Circle
                cx={r * rr}
                cy={r * rr}
                r={coreR * rr}
                fill="none"
                stroke={color}
                strokeWidth={SEED_RING_STROKE * rr}
              />
              <Circle cx={r * rr} cy={r * rr} r={metrics.heartR * rr} fill={color} />
            </>
          ) : (
            // Non-seed: a body in the star's OWN colour with a small white
            // heart. NOT a white disc at core radius — see CORE_HEART_RATIO in
            // skyStarMetrics for why that alone kept the hierarchy inverted
            // after the size ladder was already fixed.
            <>
              <Circle
                cx={r * rr}
                cy={r * rr}
                r={coreR * rr}
                fill={color}
                fillOpacity={lit ? 0.92 : 0.75}
              />
              <Circle
                cx={r * rr}
                cy={r * rr}
                r={metrics.heartR * rr}
                fill="#ffffff"
                fillOpacity={lit ? 0.85 : 0.5}
              />
            </>
          )}
        </Svg>
      </Animated.View>
      {/* pinned stars get a thin white ring (seeds already carry their gold ring) */}
      {star.pinned && !isSeed && (
        <View
          pointerEvents="none"
          style={{
            position: "absolute",
            width: (coreR * 2 + 8) * rr,
            height: (coreR * 2 + 8) * rr,
            borderRadius: (coreR + 4) * rr,
            left: -(coreR + 4) * rr,
            top: -(coreR + 4) * rr,
            borderWidth: 1.5 * rr,
            borderColor: palette.white,
            opacity: 0.6,
          }}
        />
      )}
    </Animated.View>
  );
}

/**
 * Press / hover halo for interactive stars that get NO FeatureStar of their own.
 *
 * `hitTest` opens a drawer for ANY star the server attached seedMeta to, but
 * only the capped `features` set mounts a FeatureStar (with its built-in halo).
 * The remainder — overflow invitations past the tier-0 consideration cap, and
 * cold-start "starter" stars — render as plain territory dots inside the camera
 * canvas, where per-dot animated SVG props would be far too expensive. So they
 * were the one tappable thing on this map that gave no reaction at all, which
 * is exactly the "looks inert but isn't" mixed message the reaction states were
 * added to kill.
 *
 * One instance covers all of them: it reads the same pressed/hovered shared
 * values, looks the id up in a UI-thread-readable position index, and parks
 * itself off-screen (opacity 0) whenever the lit star is a FeatureStar or none.
 */
function TerritoryFocusHalo({
  index,
  pressedStarId,
  hoveredStarId,
  tx,
  ty,
  scale,
}: {
  index: SharedValue<Record<string, { x: number; y: number; c: string }>>;
  pressedStarId: SharedValue<string | null>;
  hoveredStarId: SharedValue<string | null>;
  tx: SharedValue<number>;
  ty: SharedValue<number>;
  scale: SharedValue<number>;
}) {
  // Spring on the REACTION only, never on live camera scale — same split as
  // FeatureStar. A spring that also chased scale.value would lag every pinch.
  const react = useDerivedValue(() => {
    const pressed = pressedStarId.get() !== null && index.get()[pressedStarId.get()!] !== undefined;
    const hovered = hoveredStarId.get() !== null && index.get()[hoveredStarId.get()!] !== undefined;
    return withSpring(pressed ? PRESS_SCALE : hovered ? HOVER_SCALE : 1, PRESS_SPRING);
  }, [index, pressedStarId, hoveredStarId]);
  const follow = useAnimatedStyle(() => {
    const id = pressedStarId.get() ?? hoveredStarId.get();
    const e = id === null ? undefined : index.get()[id];
    // No entry → this star draws its own halo (or nothing is lit). Park the
    // view far off-screen rather than unmounting: no React work per touch.
    if (!e) return { transform: [{ translateX: -9999 }, { translateY: -9999 }, { scale: 1 }] };
    return {
      transform: [
        { translateX: e.x * scale.get() + tx.get() },
        { translateY: e.y * scale.get() + ty.get() },
        { scale: starGrowthAt(scale.get()) * react.get() },
      ],
    };
  }, [index, pressedStarId, hoveredStarId, tx, ty, scale, react]);
  const skin = useAnimatedStyle(() => {
    const pid = pressedStarId.get();
    const hid = hoveredStarId.get();
    const lit = pid !== null && index.get()[pid] !== undefined;
    const e = lit ? index.get()[pid!] : hid !== null ? index.get()[hid] : undefined;
    return {
      opacity: withTiming(e ? (lit ? 1 : 0.55) : 0, { duration: 110 }),
      borderColor: e?.c ?? "transparent",
      backgroundColor: e ? `${e.c}22` : "transparent",
    };
  }, [index, pressedStarId, hoveredStarId]);
  return (
    <Animated.View pointerEvents="none" style={[styles.starAnchor, follow]}>
      <Animated.View
        pointerEvents="none"
        style={[
          {
            position: "absolute",
            left: -FOCUS_RING_R,
            top: -FOCUS_RING_R,
            width: FOCUS_RING_R * 2,
            height: FOCUS_RING_R * 2,
            borderRadius: FOCUS_RING_R,
            borderWidth: 1.25,
          },
          skin,
        ]}
      />
    </Animated.View>
  );
}

// The YOU hub — screen-space like FeatureStar (see BUCKET_TOP_SCALE). Drawn at
// the bucket's top scale (the hub has NO atten damping — it grows linearly with
// the camera) and worklet-scaled down to the live zoom, so it stays crisp from
// rest to MAX_ZOOM.
function HubGlyph({
  cx,
  cy,
  bucket,
  tx,
  ty,
  scale,
}: {
  cx: number;
  cy: number;
  bucket: number;
  tx: SharedValue<number>;
  ty: SharedValue<number>;
  scale: SharedValue<number>;
}) {
  const top = BUCKET_TOP_SCALE[Math.max(0, Math.min(3, bucket))];
  // Explicit deps — see SkyLabel's follow worklet.
  const follow = useAnimatedStyle(
    () => ({
      transform: [
        { translateX: cx * scale.get() + tx.get() },
        { translateY: cy * scale.get() + ty.get() },
        { scale: scale.get() / top },
      ],
    }),
    [cx, cy, top, tx, ty, scale],
  );
  return (
    <Animated.View pointerEvents="none" style={[styles.starAnchor, follow]}>
      <View
        style={{
          position: "absolute",
          width: 90 * top,
          height: 90 * top,
          borderRadius: 45 * top,
          marginLeft: -45 * top,
          marginTop: -45 * top,
          backgroundColor: palette.yellow[300],
          opacity: 0.12,
        }}
      />
      <View
        style={{
          width: 26 * top,
          height: 26 * top,
          borderRadius: 13 * top,
          marginLeft: -13 * top,
          marginTop: -13 * top,
          backgroundColor: palette.yellow[300],
          shadowColor: palette.yellow[400],
          shadowOpacity: 1,
          shadowRadius: 20 * top,
          shadowOffset: { width: 0, height: 0 },
        }}
      />
      <Text
        style={{
          position: "absolute",
          top: 19 * top,
          left: -22 * top,
          width: 44 * top,
          textAlign: "center",
          color: palette.yellow[300],
          fontSize: 10 * top,
          fontFamily: "HankenGrotesk_700Bold",
          letterSpacing: 1.8 * top,
          opacity: 0.7,
        }}
      >
        YOU
      </Text>
    </Animated.View>
  );
}

// A single star label — a constant on-screen-size text pinned to the star's
// SCREEN position (star.x * scale + tx). Living in a non-transformed overlay is
// what keeps the font a fixed ~11.5pt at every zoom instead of ballooning with
// the camera. Which labels render (and that they don't collide) is decided off
// the render loop; this component only tracks the pan/zoom transform.
function SkyLabel({
  star,
  above,
  tx,
  ty,
  scale,
  reveal,
}: {
  star: PositionedStar;
  above: boolean;
  tx: SharedValue<number>;
  ty: SharedValue<number>;
  scale: SharedValue<number>;
  reveal: SharedValue<number>;
}) {
  const color = star.role === "seed" ? "#fff2b3" : star.color ?? colorForDomain(star.domain);
  // LIVE hide gate (non-seed labels only — seeds are labelled at every zoom):
  // reveal is settle-time (conservative), but hiding tracks the camera LIVE —
  // the moment a pinch-out crosses below NON_SEED_LABEL_HIDE_SCALE this fades
  // the label out mid-gesture, instead of leaving stale labels floating until
  // the gesture ends. Reaction-on-crossing (not per-frame withTiming restarts).
  const gated = star.role !== "seed";
  const gate = useSharedValue(1);
  useAnimatedReaction(
    () => !gated || scale.get() >= NON_SEED_LABEL_HIDE_SCALE,
    (show, prev) => {
      if (prev !== null && show === prev) return;
      gate.set(withTiming(show ? 1 : 0, { duration: FADE_LABEL_MS, easing: FADE_EASING }));
    },
  );
  // Position captured as PRIMITIVES with an EXPLICIT deps array: when a live
  // field update re-lays-out the sky (a seed approved mid-session, the atlas
  // re-baked), the star objects are replaced and every follower worklet MUST
  // rebuild — a stale closure leaves the label floating away from its star
  // (seen 2026-07-06: Skip-counting's label stranded at its pre-bake position).
  const sx = star.x;
  const sy = star.y;
  const follow = useAnimatedStyle(
    () => ({
      // Cross-fade with the star's tier on a bucket flip (200ms, web parity) ×
      // the live hide gate above.
      opacity: reveal.get() * gate.get(),
      transform: [
        { translateX: sx * scale.get() + tx.get() },
        { translateY: sy * scale.get() + ty.get() },
      ],
    }),
    [sx, sy, reveal, gate, tx, ty, scale],
  );
  return (
    <Animated.View style={[styles.labelAnchor, follow]} pointerEvents="none">
      <Text
        style={[
          styles.starLabel,
          star.completed && styles.completedStarLabel,
          { color },
          above ? { bottom: 10 } : { top: 10 },
        ]}
        numberOfLines={2}
      >
        {star.completed ? `✓ ${star.topic}` : star.topic}
      </Text>
    </Animated.View>
  );
}

// A prereq→unlock arrow, drawn IN the crisp lattice layer at CONTENT-space coords
// mapped into the layer's oversampled raster: a content point v is drawn at
// (v − ox) · res, and every size is × res (see crispSvg.ts). The line weight,
// arrowhead size, and the tip's gap from the target star are computed in CONTENT
// space and damped per bucket by `atten` (STAR_ATTEN[bucket], the SAME multiplier
// the dots use): base ~1px at rest, growing sublinearly like the stars; res is a
// raster multiplier applied ON TOP of that content-space damping, purely for
// crispness. The unit-vector geometry stays in content space — only the final
// draw values are transformed.
/**
 * The drawn SCREEN radius of whatever glyph a star renders as — a feature
 * star's core, or a territory dot. What the lattice needs in order to stop its
 * arrows at a star's edge instead of guessing.
 */
function starScreenR(st: PositionedStar | undefined, growth: number): number {
  if (!st) return 0;
  return isFeatureStar(st) ? featureStarMetrics(st).coreR * growth : territoryDotR(st, growth);
}

function LatticeArrow({
  edge,
  active,
  color,
  atten,
  tipGap,
  ox,
  oy,
  res,
}: {
  edge: PositionedEdge;
  active: boolean;
  color: string;
  atten: number;
  tipGap: number;
  ox: number;
  oy: number;
  res: number;
}) {
  const dx = edge.x2 - edge.x1;
  const dy = edge.y2 - edge.y1;
  const len = Math.hypot(dx, dy) || 1;
  const ux = dx / len; // unit vector — dimensionless, content space
  const uy = dy / len;
  // Content-space gap so the tip clears the TARGET STAR'S OWN drawn edge —
  // derived from that star's radius rather than a flat constant, which is what
  // left arrows hanging short once the size ladder shrank the cores (see
  // arrowTipGap in lib/skyStarMetrics).
  const gap = tipGap;
  const endX = edge.x2 - ux * gap;
  const endY = edge.y2 - uy * gap;
  // Arrowhead: content-space, same per-bucket damping as the stroke + stars.
  const size = (active ? 6 : 5) * atten;
  const bx = endX - ux * size;
  const by = endY - uy * size;
  const px = -uy * (size * 0.5);
  const py = ux * (size * 0.5);
  // Transform ONLY the final draw values into the crisp layer's raster space.
  const X = (v: number) => (v - ox) * res;
  const Y = (v: number) => (v - oy) * res;
  return (
    <>
      <Line
        x1={X(edge.x1)}
        y1={Y(edge.y1)}
        x2={X(endX)}
        y2={Y(endY)}
        stroke={color}
        strokeWidth={0.5 * (active ? 1.5 : 1) * atten * res}
        opacity={1}
      />
      <Polygon
        points={`${X(endX)},${Y(endY)} ${X(bx + px)},${Y(by + py)} ${X(bx - px)},${Y(by - py)}`}
        fill={color}
        opacity={1}
      />
    </>
  );
}

// ── Zoom controls ─────────────────────────────────────────────────────────────

const ZOOM_SPRING = { damping: 28, stiffness: 300, mass: 0.8 } as const;

/* CRASH NOTE — never call runOnJS from this spring's completion callback.
   `runOnJS(...)` inside a withTiming/withSpring/withDecay COMPLETION CALLBACK can
   hard-crash the app (SIGABRT, no red box: `JSIWorkletsModuleProxy::toOptimizedObject`
   → `JSScheduler::scheduleOnJS`) when the React Compiler is enabled, which it is
   here. Hit for real in the workbench BottomSheet on 2026-07-28 and fixed there
   the same way `ui/Drawer.tsx` does it: drive the follow-up off a plain JS timer,
   which never crosses the UI-worklet→JS boundary.

   Recenter went from dormant to exposed when this file moved to `.get()/.set()`:
   ZoomControls stopped violating `react-hooks/immutability`, so the React Compiler
   stopped bailing out of it and started memoizing it.

   Sizing the timer: a spring has no duration, so this can't mirror an animation
   length the way Drawer's 190ms close does — it has to outlast the spring's own
   termination. Two things make that longer than it first looks, and BOTH were got
   wrong on the first pass here:

     1. The decay ENVELOPE is not the displacement. With damping 28 / stiffness
        300 / mass 0.8: α = c/2m = 17.5, ω₀ = √(k/m) ≈ 19.36, ω_d ≈ 8.29, and
        x(t) = e^(−αt)·[cos(ω_d t) + (α/ω_d)·sin(ω_d t)]. That bracket peaks near
        2, so reading e^(−αt) alone understates real travel by up to ~2×.
     2. Reanimated 4.5 does NOT stop on the old restDisplacement/restSpeed
        defaults. It stops when relative energy x² + (m/k)·v² < 6e-9
        (packages/react-native-reanimated/src/animation/spring/springUtils.ts).
        For this spring that lands at ~601ms — far past where the envelope
        suggests it is done.

   So 700ms, which clears the ~601ms termination with margin. Erring LATE costs
   one extra beat of labels culled to the old framing; erring EARLY culls
   mid-flight, and on the scale axis (a recenter from MAX_ZOOM=8 down to a ~1.15
   home scale) 450ms still had ~5px of residual travel across a 1000pt span.
   Re-derive this — do not scale it by eye — if ZOOM_SPRING changes. */
const RECENTER_SETTLE_MS = 700;

function ZoomControls({
  tx,
  ty,
  scale,
  home,
  onSettle,
}: {
  tx: SharedValue<number>;
  ty: SharedValue<number>;
  scale: SharedValue<number>;
  // Where "Recenter" returns to — the seed-framed opening camera (matches the
  // initial load). Undefined until the layout is ready → falls back to origin.
  home?: Camera;
  /** Called once the recenter spring has effectively landed (RECENTER_SETTLE_MS
   *  after it starts) — re-culls the settle-derived sets (labels, features, crisp
   *  layers) for the home framing; without it a recenter after a long pan left
   *  them culled to the OLD viewport (cross-model review finding, 2026-07-06). */
  onSettle: () => void;
}) {
  const insets = useSafeAreaInsets();

  // Pending re-cull for an in-flight recenter (see the CRASH NOTE above).
  const settleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (settleTimer.current) clearTimeout(settleTimer.current);
    },
    [],
  );

  const recenter = useCallback(() => {
    const h = home ?? { tx: 0, ty: 0, scale: 1 };
    tx.set(withSpring(h.tx, ZOOM_SPRING));
    ty.set(withSpring(h.ty, ZOOM_SPRING));
    scale.set(withSpring(h.scale, ZOOM_SPRING));
    // The old completion callback fired `onSettle` only when the spring finished,
    // skipping the re-cull if a touch interrupted it. Dropping that guard is safe
    // but not free: `onSettle` is `bumpLabels` (`setLabelEpoch(e => e + 1)`), which
    // is stable and safe to repeat, though each call invalidates several
    // camera-derived memos. So an interrupted recenter now costs ONE redundant
    // re-cull — the interrupting pan/pinch already re-culls on its own end, and
    // that pass is what fixes the final framing. Correctness is unaffected; if this
    // ever shows up in a profile, gate the callback on a "was interrupted" flag set
    // from the gesture handlers rather than restoring the completion callback.
    if (settleTimer.current) clearTimeout(settleTimer.current);
    settleTimer.current = setTimeout(() => {
      settleTimer.current = null;
      onSettle();
    }, RECENTER_SETTLE_MS);
  }, [tx, ty, scale, home, onSettle]);

  return (
    <View
      style={[
        styles.recenterWrap,
        { right: insets.right + 18, bottom: insets.bottom + 18 },
      ]}
      pointerEvents="box-none"
    >
      <Pressable
        onPress={recenter}
        hitSlop={12}
        accessibilityRole="button"
        accessibilityLabel="Recenter"
      >
        <Text style={styles.recenterText}>Recenter</Text>
      </Pressable>
    </View>
  );
}

export default function SkyScreen() {
  const insets = useSafeAreaInsets();
  const { width, height } = useWindowDimensions();
  // Deep-linked lens (`?view=tree|sky`, default sky). The daily-recap card
  // pushes here with `view: "tree"` so the map opens on the Tree lens — the
  // surface that shows the movement the card names.
  const { view } = useLocalSearchParams<{ view?: string }>();
  const me = useQuery(api.users.currentUser, {});
  const scholarId = me?._id;
  const field = useQuery(
    api.concepts.skyFieldForScholar,
    scholarId ? { scholarId } : "skip",
  );
  const createFromSeed = useMutation(api.sessions.createFromSeed);

  const [selected, setSelected] = useState<PositionedStar | null>(null);
  const [starting, setStarting] = useState(false);
  const [viewMode, setViewMode] = useState<SkyViewMode>(view === "tree" ? "tree" : "sky");
  // Milestone reveals (f6): a scholar reaches the map only for lenses that have
  // real data. Neither unlocked → bounce home (no padlock); the requested lens
  // locked but the other open → coerce to the open one.
  const gates = useMapGates();
  useEffect(() => {
    if (gates.isLoading || me === undefined) return;
    if (!gates.sky && !gates.tree) {
      router.replace("/");
      return;
    }
    if (viewMode === "tree" && !gates.tree && gates.sky) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- institution gates must coerce an unavailable deep-linked lens to the only unlocked lens.
      setViewMode("sky");
    }
    if (viewMode === "sky" && !gates.sky && gates.tree) {
      setViewMode("tree");
    }
  }, [gates.isLoading, gates.sky, gates.tree, viewMode, me]);
  // Consume the one-time reveal on genuine ARRIVAL at a map's surface (J10(b)).
  // The Home reveal card teaches the access path (pull DOWN for the Sky map, and
  // the "View your frontier" card on the Math tab for the Math Skills Tree) and
  // stays up until the child actually reaches the map
  // HERE — the moment a lens becomes visible we record ITS reveal, once per
  // lens, and never again. So the card doubles as onboarding for the gesture and
  // retires itself on arrival. This screen only mounts on a real pull-to-open
  // navigation (never a preload), and the still-mounted Home card hides via its
  // own latch when `pending` flips false.
  const acknowledgeReveal = useMutation(api.mapGates.acknowledgeReveal);
  const consumedRef = useRef<Set<SkyViewMode>>(new Set());
  useEffect(() => {
    if (gates.isLoading) return;
    const m = viewMode;
    const unlocked = m === "sky" ? gates.sky : gates.tree;
    const pending = m === "sky" ? gates.skyRevealPending : gates.treeRevealPending;
    if (!unlocked || !pending || consumedRef.current.has(m)) return;
    consumedRef.current.add(m);
    void acknowledgeReveal({ map: m });
  }, [
    gates.isLoading,
    gates.sky,
    gates.tree,
    gates.skyRevealPending,
    gates.treeRevealPending,
    viewMode,
    acknowledgeReveal,
  ]);
  // Zoom bucket as React state, driven from the UI thread (useAnimatedReaction
  // below) only when it CROSSES a threshold — so the visible-set + label
  // recomputes happen off the render loop, not per frame.
  //
  // labelEpoch is bumped on ANY gesture end (pan OR pinch). It drives the label /
  // territory / feature re-cull, which a pan genuinely needs (new stars enter the
  // viewport as you drag, so labels must re-collide for the new framing). The
  // prereq/thread lattice needs NO such epoch: it's drawn in the camera canvas at
  // content-space coords (like the dots), so pan + zoom ride the continuous canvas
  // transform and it only re-renders on sky/bucket/selection.
  const [bucket, setBucket] = useState(0);
  const [labelEpoch, setLabelEpoch] = useState(0);
  const bumpLabels = useCallback(() => setLabelEpoch((e) => e + 1), []);

  // One SVG, not N absolutely-positioned Views: the tile carries 4× the dots of
  // the old viewport-sized layer, and a single node is cheaper than 30 were.
  const dustLayer = useMemo(() => {
    const dots = backgroundDust(width, height);
    return (
      <Svg
        width={width * DUST_TILE}
        height={height * DUST_TILE}
        style={{ position: "absolute", left: -width / 2, top: -height / 2 }}
        pointerEvents="none"
      >
        {dots.map((d, i) => (
          <Circle key={`d${i}`} cx={d.x} cy={d.y} r={d.r / 2} fill={DUST_COLOR} opacity={d.o} />
        ))}
      </Svg>
    );
  }, [width, height]);
  // SKY LENS ONLY — null in tree mode. The Tree is served entirely by
  // <TreeMapNative /> (a sibling overlay further down that owns its own layout,
  // camera and gestures), so a second tree layout here only painted a dead lens
  // of sky-renderer dots + lattice UNDERNEATH the tree every frame. Every
  // consumer of `sky` already null-guards (the layers it feeds are `{sky && …}`
  // / `if (!sky) return null`), which is why null is the whole fix.
  const sky = useMemo(() => {
    if (!field || viewMode !== "sky") return null;
    return layoutSkyField(field as SkyFieldPayload, width, height);
  }, [field, viewMode, width, height]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- switching lenses must discard a selection belonging to the outgoing map layout.
    setSelected(null);
  }, [viewMode]);

  // Pan + pinch transform of the whole canvas.
  const tx = useSharedValue(0);
  const ty = useSharedValue(0);
  const scale = useSharedValue(1);

  // Open the map on the seed-framed camera (center-of-gravity of the seeds,
  // zoomed to the seed neighborhood) instead of the whole-atlas fit — so the
  // scholar's live invitations are centered and prominent, not crammed into a
  // corner of the deep field. Frames the first time a lens actually has a layout
  // (keyed by viewMode, so the gate coercion tree→sky still frames on arrival),
  // but deliberately NOT on every reactive `field` refresh, so it never yanks
  // the camera out from under an active exploration. No-ops in tree mode —
  // `sky` is null there and TreeMapNative owns its own camera.
  const framedForRef = useRef<string | null>(null);
  useEffect(() => {
    if (!sky) return;
    if (framedForRef.current === viewMode) return;
    framedForRef.current = viewMode;
    const cam = sky.initialCamera;
    tx.set(cam.tx);
    ty.set(cam.ty);
    scale.set(cam.scale);
    // Re-derive the crisp layers + labels AT the framed camera immediately —
    // without this the first frames show the scale-1 snapshots stretched to the
    // seed-framed zoom, then pop when the bucket commits (first-open flicker).
    bumpLabels();
  }, [sky, viewMode, tx, ty, scale, bumpLabels]);

  // Per-tier reveal (0 → 1) driving the bucket cross-fade. One shared value per
  // gated tier (1/2/3), ramped via withTiming when the bucket flips; the tier
  // layers multiply their base opacity by it, so a tier fades IN/OUT instead of
  // popping. Tier 0 (seeds) is always present (never fades). A separate set runs
  // the shorter label fade (web `.albl` .4s vs `.astar` .5s). All UI-thread — no
  // per-frame JS.
  const reveal1 = useSharedValue(0);
  const reveal2 = useSharedValue(0);
  const reveal3 = useSharedValue(0);
  const labelReveal1 = useSharedValue(0);
  const labelReveal2 = useSharedValue(0);
  const labelReveal3 = useSharedValue(0);
  const alwaysVisible = useSharedValue(1); // tier-0 (seed) layers never fade

  // The Sky lens gates by zoom bucket (tier 0 seeds at rest, deeper tiers reveal
  // on zoom). The Tree lens shows its whole prereq lattice at once.
  const gateByBucket = viewMode === "sky";

  // Which display tiers are currently MOUNTED. Normally the tiers visible at the
  // current bucket, but an outgoing tier is retained past its fade so it can fade
  // OUT before unmounting (the fade-in of a newly-revealed tier is handled by its
  // reveal value ramping from 0). Kept off `bucket` so the derived sets below key
  // off the mounted set, not the raw bucket.
  const [renderTiers, setRenderTiers] = useState<Set<number>>(() => new Set([0]));

  // Cross-fade + mount/unmount on a bucket (or lens) change. Ramp each gated
  // tier's reveal value toward its target (visible → 1, hidden → 0) so tiers fade
  // rather than pop; mount any newly-revealed tier immediately (it fades in from
  // its current 0); and keep an outgoing tier mounted for the fade before dropping
  // it. withTiming runs on the UI thread — no per-frame JS.
  useEffect(() => {
    const visible = (tier: number) => !gateByBucket || tierVisibleAtBucket(tier, bucket);
    const starCfg = { duration: FADE_STAR_MS, easing: FADE_EASING };
    const labelCfg = { duration: FADE_LABEL_MS, easing: FADE_EASING };
    reveal1.set(withTiming(visible(1) ? 1 : 0, starCfg));
    reveal2.set(withTiming(visible(2) ? 1 : 0, starCfg));
    reveal3.set(withTiming(visible(3) ? 1 : 0, starCfg));
    labelReveal1.set(withTiming(visible(1) ? 1 : 0, labelCfg));
    labelReveal2.set(withTiming(visible(2) ? 1 : 0, labelCfg));
    labelReveal3.set(withTiming(visible(3) ? 1 : 0, labelCfg));

    const vis = new Set<number>([0, 1, 2, 3].filter((t) => visible(t)));
    // Mount target tiers now (they fade in); retain any currently-mounted tier so
    // it can fade out.
    // eslint-disable-next-line react-hooks/set-state-in-effect -- preserves outgoing tiers during the native cross-fade instead of unmounting them at the bucket change.
    setRenderTiers((prev) => {
      let changed = false;
      const next = new Set(prev);
      for (const t of vis) {
        if (!next.has(t)) {
          next.add(t);
          changed = true;
        }
      }
      return changed ? next : prev;
    });
    // After the fade, drop tiers that are no longer visible (fade-out complete).
    const timer = setTimeout(() => {
      setRenderTiers((prev) => {
        if (prev.size === vis.size && [...prev].every((t) => vis.has(t))) return prev;
        return new Set(vis);
      });
    }, FADE_RETAIN_MS);
    return () => clearTimeout(timer);
  }, [
    bucket,
    gateByBucket,
    reveal1,
    reveal2,
    reveal3,
    labelReveal1,
    labelReveal2,
    labelReveal3,
  ]);

  // Fully-revealed (target) opacity for a territory tier — the value its reveal
  // ramps toward. Sky: web ENGINE_CSS strength via starOpacityAtBucket (t1/t2 → 1,
  // deep field t3 → .72). Tree: the ungated depth-dimmed ramp.
  const terrBase = useCallback(
    (tier: number) =>
      gateByBucket ? starOpacityAtBucket(tier, tier) : Math.max(0.55, 0.85 - tier * 0.08),
    [gateByBucket],
  );
  const terrBase0 = terrBase(0);
  const terrBase1 = terrBase(1);
  const terrBase2 = terrBase(2);
  const terrBase3 = terrBase(3);

  // ── Derived visible sets (recomputed off the render loop) ───────────────────
  // Territory: plain, glowless dots — the bulk of the field. Tier-gated by bucket
  // and viewport-culled, so at rest this is EMPTY (only seeds show) and even at
  // deep zoom only what's on screen is painted, as one flat SVG layer.
  // ── FULL-FIELD UNDERLAY — the zoom-out continuity backdrop ────────────────
  // The crisp screen-space layers only cover the viewport (+25% margin), so a
  // pinch-OUT used to shrink them and reveal blank gutters until the settle
  // re-render — the "popping" while fingers are down (Andy, 2026-07-06). This
  // single content-resolution SVG draws the WHOLE field (lattice + territory,
  // tier opacity baked) and rides the camera transform continuously, so
  // de-culled regions are always covered — slightly soft until the crisp
  // layers re-render pixel-aligned on top of it at settle (their opaque
  // strokes/dots draw at identical geometry, hiding it exactly).
  const underlayStyle = useAnimatedStyle(
    () => ({
      transform: [
        { translateX: tx.get() },
        { translateY: ty.get() },
        { scale: scale.get() },
      ],
    }),
    [tx, ty, scale],
  );
  const features = useMemo(() => {
    if (!sky) return [] as PositionedStar[];
    // Shared camera values are sampled at each gesture settle; this state-only
    // epoch deliberately invalidates the snapshot when the camera comes to rest.
    void labelEpoch;
    const sc = scale.get();
    const ox = tx.get();
    const oy = ty.get();
    const mx = width * (1 + CULL_MARGIN);
    const my = height * (1 + CULL_MARGIN);
    const vis = sky.stars.filter((s) => {
      if (!isFeatureStar(s)) return false;
      if (!renderTiers.has(s.displayTier)) return false;
      const sx = s.x * sc + ox;
      const sy = s.y * sc + oy;
      return !(sx < -mx || sx > width + mx || sy < -my || sy > height + my);
    });
    vis.sort((a, b) => starLabelPriority(b) - starLabelPriority(a));
    return vis.slice(0, GLOW_CAP);
  }, [sky, renderTiers, labelEpoch, width, height, scale, tx, ty]);

  // Position index for TerritoryFocusHalo: every star `hitTest` will open that
  // does NOT get a FeatureStar this pass (overflow invitations past the tier-0
  // cap, cold-start starters, anything trimmed by GLOW_CAP). Keyed off the
  // rendered `features` set, not `isFeatureStar`, so the complement is exact.
  const focusIndex = useSharedValue<Record<string, { x: number; y: number; c: string }>>({});
  useEffect(() => {
    const drawn = new Set(features.map((f) => f._id));
    const m: Record<string, { x: number; y: number; c: string }> = {};
    for (const s of sky?.stars ?? []) {
      if (!s.interactive || drawn.has(s._id)) continue;
      m[s._id] = { x: s.x, y: s.y, c: s.color ?? colorForDomain(s.domain) };
    }
    focusIndex.set(m);
  }, [sky, features, focusIndex]);

  // Every star ID actually PAINTED this pass — the capped feature set plus the
  // tier-visible territory dots. Edges are gated on this (see fieldUnderlay /
  // latticeSvg): an edge whose endpoint isn't drawn is a line to nowhere.
  //
  // WHY: stars were tier-gated and GLOW_CAP-capped, but edges were culled ONLY
  // by a viewport intersection test, so the deep prerequisite graph — whose
  // nodes sit at tiers that don't render until you zoom in — still drew its
  // edges across the opening view. On a real field that reads as a dense knot
  // of arrows far off to one side with no stars under it, plus stray strokes
  // and arrowheads landing in empty space (Andy, 2026-07-26: "some of the lines
  // don't connect to stars").
  const paintedIds = useMemo(
    () => (sky ? paintedStarIds(sky.stars, renderTiers, features) : new Set<string>()),
    [sky, renderTiers, features],
  );

  // Star lookup for the lattice: an arrow has to know how big the star it
  // points AT is drawn, so it can stop at that star's edge.
  const starById = useMemo(() => {
    const m = new Map<string, PositionedStar>();
    for (const st of sky?.stars ?? []) m.set(st._id, st);
    return m;
  }, [sky]);

  const fieldUnderlay = useMemo(() => {
    if (!sky) return null;
    // See `features`: this memo samples stable shared values at gesture settle.
    void labelEpoch;
    const s0 = Math.max(scale.get(), 0.0001);
    const att = attenAt(s0);
    const g = starGrowthAt(s0);
    const sel = selected?.conceptId ?? null;
    // Both endpoints must actually be painted, or the segment is a line to
    // nowhere. The global prereq lattice additionally waits for the bucket that
    // reveals its nodes — below that the practice graph contributes only noise.
    const drawn = (edge: PositionedEdge) => edgeIsDrawable(edge, paintedIds);
    const latticeOpen = bucket >= NON_SEED_LABEL_BUCKET;
    return (
      <Svg width={sky.width} height={sky.height} style={StyleSheet.absoluteFill} pointerEvents="none">
        {sky.threads.map((edge, i) =>
          drawn(edge) ? (
            <Line
              key={`ut-${edge.s}-${edge.t}-${i}`}
              x1={edge.x1}
              y1={edge.y1}
              x2={edge.x2}
              y2={edge.y2}
              stroke={LATTICE_COLOR}
              strokeWidth={0.5 * att}
              opacity={1}
            />
          ) : null,
        )}
        {sky.latticeEdges.map((edge, i) => {
          const active = !!sel && (edge.s === sel || edge.t === sel);
          // A selected star's own prereqs/unlocks light at any zoom — but still
          // only where both ends are drawn.
          if (!active && !latticeOpen) return null;
          if (!drawn(edge)) return null;
          return (
            <LatticeArrow
              key={`ul-${edge.s}-${edge.t}-${i}`}
              edge={edge}
              active={active}
              color={active ? LATTICE_COLOR_ACTIVE : LATTICE_COLOR}
              atten={att}
              tipGap={arrowTipGap(starScreenR(starById.get(edge.t), g), s0)}
              ox={0}
              oy={0}
              res={1}
            />
          );
        })}
        {sky.stars.map((st) => {
          if (isFeatureStar(st)) return null;
          if (!renderTiers.has(st.displayTier)) return null;
          return (
            <Circle
              key={`ud-${st._id}`}
              cx={st.x}
              cy={st.y}
              r={territoryDotR(st, g) / s0}
              fill={st.color ?? colorForDomain(st.domain)}
              opacity={terrBase(st.displayTier)}
            />
          );
        })}
      </Svg>
    );
  }, [sky, bucket, renderTiers, labelEpoch, selected?.conceptId, paintedIds, starById, scale, terrBase]);

  // Territory dots — computed straight into the SCREEN-SPACE delta layer
  // (snapshot + per-tier SVGs at screen coordinates). Culled to the visible
  // rect (+ margin) at each settle; radii use the CONTINUOUS attenAt damping.
  // Same triggers as before (mounted tiers + gesture settles).
  const territoryLayer = useMemo(() => {
    if (!sky) return null;
    // See `features`: this memo samples stable shared values at gesture settle.
    void labelEpoch;
    const s0 = scale.get();
    const tx0 = tx.get();
    const ty0 = ty.get();
    const mW = Math.round(width * LATTICE_MARGIN);
    const mH = Math.round(height * LATTICE_MARGIN);
    // Screen-size growth factor: s·attenAt(s), hard-capped (DOT_GROWTH_CAP).
    const dotGrowth = starGrowthAt(s0);
    const byTier: PositionedStar[][] = [[], [], [], []];
    for (const st of sky.stars) {
      if (isFeatureStar(st)) continue;
      if (!renderTiers.has(st.displayTier)) continue;
      const sxp = st.x * s0 + tx0;
      const syp = st.y * s0 + ty0;
      if (sxp < -mW || sxp > width + mW || syp < -mH || syp > height + mH) continue;
      byTier[st.displayTier].push(st);
    }
    const tiers = byTier
      .map((dots, tier) => {
        if (!dots.length) return null;
        return {
          tier,
          node: (
            <Svg
              width={width + 2 * mW}
              height={height + 2 * mH}
              style={StyleSheet.absoluteFill}
              pointerEvents="none"
            >
              {dots.map((st) => (
                <Circle
                  key={st._id}
                  cx={st.x * s0 + tx0 + mW}
                  cy={st.y * s0 + ty0 + mH}
                  r={territoryDotR(st, dotGrowth)}
                  fill={st.color ?? colorForDomain(st.domain)}
                />
              ))}
            </Svg>
          ),
        };
      })
      .filter((t): t is { tier: number; node: ReactElement } => t !== null);
    return { snapshot: { s0, tx0, ty0, mW, mH }, tiers };
  }, [sky, renderTiers, labelEpoch, width, height, scale, tx, ty]);

  // Delta transform for the territory layer (same math as latticeDelta).
  const terrSnapS0 = territoryLayer?.snapshot.s0 ?? 1;
  const terrSnapTx0 = territoryLayer?.snapshot.tx0 ?? 0;
  const terrSnapTy0 = territoryLayer?.snapshot.ty0 ?? 0;
  const terrSnapMW = territoryLayer?.snapshot.mW ?? 0;
  const terrSnapMH = territoryLayer?.snapshot.mH ?? 0;
  const territoryDelta = useAnimatedStyle(() => {
    const k = scale.get() / terrSnapS0;
    return {
      transform: [
        { translateX: tx.get() - k * terrSnapTx0 + (1 - k) * terrSnapMW },
        { translateY: ty.get() - k * terrSnapTy0 + (1 - k) * terrSnapMH },
        { scale: k },
      ],
    };
  }, [terrSnapS0, terrSnapTx0, terrSnapTy0, terrSnapMW, terrSnapMH, tx, ty, scale]);

  // Label set: tier-gated, capped (LABEL_CAP), collision-rejected in screen
  // space, priority-first (seeds > mastery > standards/refCount > territory).
  const labelIds = useMemo(() => {
    if (!sky) return new Set<string>();
    // See `features`: this memo samples stable shared values at gesture settle.
    void labelEpoch;
    const sc = scale.get();
    const ox = tx.get();
    const oy = ty.get();
    const cands: LabelCandidate[] = [];
    for (const s of labelableStars(sky.stars, {
      renderTiers,
      painted: paintedIds,
      bucket,
      nonSeedBucket: NON_SEED_LABEL_BUCKET,
    })) {
      const topic = s.topic ?? "";
      const singleW = topic.length * LABEL_FONT * 0.55;
      const lines = Math.max(1, Math.min(2, Math.ceil(singleW / LABEL_MAX_W)));
      cands.push({
        id: s._id,
        sx: s.x * sc + ox,
        sy: s.y * sc + oy,
        priority: starLabelPriority(s),
        width: Math.min(singleW, LABEL_MAX_W) + LABEL_PAD * 2,
        height: lines * LABEL_LINE_H + LABEL_PAD * 2,
        above: s.y < sky.cy,
      });
    }
    return new Set(selectLabels(cands, { width, height, margin: 48 }, LABEL_CAP));
  }, [sky, renderTiers, bucket, labelEpoch, width, height, paintedIds, scale, tx, ty]);
  const labelStars = useMemo(
    () => (sky ? sky.stars.filter((s) => labelIds.has(s._id)) : []),
    [sky, labelIds],
  );

  // Group the derived territory / feature sets by display tier so each tier can be
  // painted in its OWN opacity layer and cross-faded independently (Fix: no pop).


  const featuresByTier = useMemo(() => {
    const g: PositionedStar[][] = [[], [], [], []];
    for (const s of features) g[s.displayTier].push(s);
    return g;
  }, [features]);

  // Per-tier opacity styles for the cross-fade. Territory multiplies its reveal by
  // the tier's fully-revealed base (deep field dimmer); features glow at full when
  // revealed. Tier 0 (seeds) is static (always present) so it needs no style.
  const terr1Style = useAnimatedStyle(() => ({ opacity: reveal1.get() * terrBase1 }));
  const terr2Style = useAnimatedStyle(() => ({ opacity: reveal2.get() * terrBase2 }));
  const terr3Style = useAnimatedStyle(() => ({ opacity: reveal3.get() * terrBase3 }));
  const feat1Style = useAnimatedStyle(() => ({ opacity: reveal1.get() }));
  const feat2Style = useAnimatedStyle(() => ({ opacity: reveal2.get() }));
  const feat3Style = useAnimatedStyle(() => ({ opacity: reveal3.get() }));
  const terrTierStyle = [null, terr1Style, terr2Style, terr3Style];
  const featTierStyle = [null, feat1Style, feat2Style, feat3Style];
  const terrTierBase = [terrBase0, terrBase1, terrBase2, terrBase3];
  // The reveal value a label of a given tier should follow (tier 0 never fades).
  const labelRevealFor = (tier: number): SharedValue<number> =>
    tier <= 0 ? alwaysVisible : tier === 1 ? labelReveal1 : tier === 2 ? labelReveal2 : labelReveal3;

  // Prereq/thread lattice — lines + arrowheads drawn as a CRISP LAYER (crispSvg.ts,
  // the native port of the web atlasEngine RASTER trick, lib/atlasEngine.ts
  // ~232-238). A full-field SVG can't be drawn bigger (its backing store would be
  // content-size × res²), so instead — at each re-render (a settle: gesture end /
  // bucket / selection commit) — we lay the SVG out over just the VISIBLE content
  // rect (+ margin) at an oversample `res`, and counter-scale it 1/res. The layer
  // still lives INSIDE the camera canvas at content coords (wrapper positioned at
  // rect.x/rect.y), so pan + zoom remain the one continuous transform — no
  // screen-space reprojection / hand-off (hence no zoom-jump). Mid-gesture the
  // raster is GPU-stretched (slightly soft, like Maps mid-pinch); on settle it
  // re-renders crisp. Stroke width + arrowhead size are damped per bucket by the
  // SAME STAR_ATTEN the dots use (content space), with res multiplied ON TOP for
  // raster density.
  //
  // Memoized on sky/bucket/selection/labelEpoch: tx/ty/scale are read as a
  // SNAPSHOT at re-render time (same pattern as `territory`). labelEpoch is bumped
  // on any pan/fling settle, so the layer re-frames + re-culls for the new
  // viewport (bucket + selection already re-render it). Rendered as the FIRST
  // child of the camera canvas so it sits behind the territory dots + stars.
  // Prereq/thread lattice — a SCREEN-SPACE layer (like the labels + feature
  // stars): drawn at SCREEN coordinates from the settle-time camera snapshot,
  // so its raster is native screen resolution — crisp lines + arrowheads at any
  // zoom (inside the camera canvas it composited through a content-resolution
  // buffer no oversample could beat; measured 2026-07-06, see crispSvg.ts).
  // Between settles a single delta-transform worklet (below) rides the live
  // camera: identity at the moment of each re-render (camera at rest), a brief
  // GPU stretch mid-gesture — the iOS-Maps trade. Coordinates map through the
  // existing (ox, oy, res) contract with res = the snapshot scale, so a content
  // point v lands at v·s0 + t0 + margin in layer space.
  const latticeSvg = useMemo(() => {
    if (!sky) return null;
    if (sky.latticeEdges.length === 0 && sky.threads.length === 0) return null;
    // See `features`: this memo samples stable shared values at gesture settle.
    void labelEpoch;
    const sel = selected?.conceptId ?? null;
    const s0 = scale.get();
    // Continuous damping at the snapshot camera — matches what the stars show
    // at this zoom, and pre/post-settle stroke widths agree (no swap snap).
    const atten = attenAt(s0);
    const growth = starGrowthAt(s0);
    const tx0 = tx.get();
    const ty0 = ty.get();
    const mW = Math.round(width * LATTICE_MARGIN);
    const mH = Math.round(height * LATTICE_MARGIN);
    // Content-space cull rect = the on-screen window (+ margin) at the snapshot.
    const rect = {
      x: (-mW - tx0) / s0,
      y: (-mH - ty0) / s0,
      w: (width + 2 * mW) / s0,
      h: (height + 2 * mH) / s0,
      res: s0,
    };
    // Same endpoint gate as fieldUnderlay — apply it to BOTH layers or the
    // underlay leaks the very lines this removes.
    const drawn = (edge: PositionedEdge) => edgeIsDrawable(edge, paintedIds);
    const latticeOpen = bucket >= NON_SEED_LABEL_BUCKET;
    return {
      snapshot: { s0, tx0, ty0, mW, mH },
      node: (
        <Svg width={width + 2 * mW} height={height + 2 * mH} pointerEvents="none">
          {sky.threads.map((edge, i) =>
            drawn(edge) &&
            segmentIntersectsRect(edge.x1, edge.y1, edge.x2, edge.y2, rect) ? (
              <Line
                key={`thread-${edge.s}-${edge.t}-${i}`}
                x1={(edge.x1 - rect.x) * s0}
                y1={(edge.y1 - rect.y) * s0}
                x2={(edge.x2 - rect.x) * s0}
                y2={(edge.y2 - rect.y) * s0}
                stroke={LATTICE_COLOR}
                strokeWidth={0.5 * atten * s0}
                opacity={1}
              />
            ) : null,
          )}
          {sky.latticeEdges.map((edge, i) => {
            if (!segmentIntersectsRect(edge.x1, edge.y1, edge.x2, edge.y2, rect)) return null;
            const active = !!sel && (edge.s === sel || edge.t === sel);
            if (!active && !latticeOpen) return null;
            if (!drawn(edge)) return null;
            return (
              <LatticeArrow
                key={`lat-${edge.s}-${edge.t}-${i}`}
                edge={edge}
                active={active}
                color={active ? LATTICE_COLOR_ACTIVE : LATTICE_COLOR}
                atten={atten}
                tipGap={arrowTipGap(starScreenR(starById.get(edge.t), growth), s0)}
                ox={rect.x}
                oy={rect.y}
                res={s0}
              />
            );
          })}
        </Svg>
      ),
    };
  }, [sky, bucket, selected?.conceptId, labelEpoch, width, height, paintedIds, starById, scale, tx, ty]);

  // The delta transform riding the live camera between lattice re-renders:
  // displayed = t + (1−k)·M − k·t0 then scale k about the layer's top-left,
  // where k = live scale / snapshot scale. Exactly identity right after a
  // settle re-render (the camera is at rest when the memo recomputes), so the
  // swap can never jump.
  const latticeSnap = latticeSvg?.snapshot;
  const snapS0 = latticeSnap?.s0 ?? 1;
  const snapTx0 = latticeSnap?.tx0 ?? 0;
  const snapTy0 = latticeSnap?.ty0 ?? 0;
  const snapMW = latticeSnap?.mW ?? 0;
  const snapMH = latticeSnap?.mH ?? 0;
  // Explicit primitive deps — a new settle snapshot must rebuild this worklet
  // (see SkyLabel's follow worklet for the stale-closure class this guards).
  const latticeDelta = useAnimatedStyle(() => {
    const k = scale.get() / snapS0;
    return {
      transform: [
        { translateX: tx.get() - k * snapTx0 + (1 - k) * snapMW },
        { translateY: ty.get() - k * snapTy0 + (1 - k) * snapMH },
        { scale: k },
      ],
    };
  }, [snapS0, snapTx0, snapTy0, snapMW, snapMH, tx, ty, scale]);

  // Pinch-active flag: READ by the zoom-bucket reaction just below (to defer
  // commits mid-pinch) and SET by the pinch gesture further down. It MUST be
  // declared before that useAnimatedReaction — a Reanimated worklet captures its
  // referenced shared values into its closure at registration time, so a
  // value declared LATER is captured as `undefined` and crashes `isPinching.value`
  // on the UI thread the first time the bucket changes (regression fixed 2026-07-05).
  const isPinching = useSharedValue(false);

  // Recompute the visible sets when the zoom bucket crosses a threshold. Runs on
  // the UI thread; only hops to JS on an actual bucket change (not per frame).
  // MID-PINCH the commit is DEFERRED: a setBucket during a pinch re-renders +
  // re-derives hundreds of SVG nodes on every threshold crossing (the pinch
  // choppiness Andy hit). While a pinch is active this reaction does NOTHING; the
  // pinch's onFinalize commits the settled bucket once (the cross-fade covers the
  // just-zoomed framing until then; the lattice + dots already ride the canvas
  // transform continuously). A non-pinch zoom (buttons/fling) still commits live —
  // those cross at most a couple buckets, not per finger-frame.
  // UI-thread mirror of the committed bucket, so the hysteresis worklets can
  // compare against the COMMITTED value (not the raw previous derivation).
  const bucketSV = useSharedValue(0);
  useAnimatedReaction(
    () => scale.get(),
    (z) => {
      if (isPinching.get()) return; // defer — committed on pinch end (onFinalize)
      const next = hystBucket(z, bucketSV.get());
      if (next === bucketSV.get()) return;
      bucketSV.set(next);
      runOnJS(setBucket)(next);
    },
  );

  // Pan gesture state — isolated from pinch to prevent the two gestures fighting
  // over shared values when running Simultaneous.
  const panStartTx = useSharedValue(0);
  const panStartTy = useSharedValue(0);

  // Pinch gesture state.
  const pinchScaleAtStart = useSharedValue(1);
  // Content-space anchor point: the point under the initial focal, kept under
  // the LIVE focal throughout the gesture (matches the web's per-frame midpoint tracking).
  const pinchAnchorX = useSharedValue(0);
  const pinchAnchorY = useSharedValue(0);
  // NB: `isPinching` is declared ABOVE the zoom-bucket useAnimatedReaction that
  // reads it (see the comment there) — do not move it back down here.

  // Parallax: the dust plane sits infinitely far behind the constellation. It
  // pans at DUST_PARALLAX × the foreground and — this is the part that was
  // wrong — it does NOT move or grow on ZOOM.
  //
  // The old form was `tx * k + (1 − k) * center`, with the layer scaled by the
  // live camera. Two bugs fell out of that:
  //   1. `tx` carries the zoom-anchor compensation (tx = focal − anchor·scale),
  //      so `tx · k` re-injects a fraction of it. The `(1 − k)·center` term only
  //      cancels that when the focal IS the screen centre — true of a pinch you
  //      aim at the middle, false of every off-centre pinch and of every
  //      programmatic re-frame (recenter, the way-out → default open). Those
  //      slid the dust against the stars, then it appeared to "snap" when the
  //      settle re-render repainted the crisp layers (Andy, 2026-07-27).
  //   2. Scaling a viewport-space layer meant a 3px speck drew 24px at
  //      MAX_ZOOM — dust the size of a real star, streaming outward from the
  //      layer's top-left origin.
  //
  // Both go away by driving the dust from the camera's CONTENT-space centre
  // (cx = (W/2 − tx)/scale) instead of from `tx` directly: cx is invariant under
  // a pure zoom about any focal, so the dust holds still while the field zooms
  // through it, and a pan of Δcx content units drifts it k·Δcx px. Screen-space
  // radii stay constant because the layer no longer scales.
  const dustTx = useDerivedValue(
    () => width / 2 - (DUST_PARALLAX * (width / 2 - tx.get())) / Math.max(scale.get(), 0.0001),
  );
  const dustTy = useDerivedValue(
    () => height / 2 - (DUST_PARALLAX * (height / 2 - ty.get())) / Math.max(scale.get(), 0.0001),
  );

  const pan = Gesture.Pan()
    .minDistance(2)
    .onBegin(() => {
      // Stop any in-flight momentum before snapping to finger.
      cancelAnimation(tx);
      cancelAnimation(ty);
      panStartTx.set(tx.get());
      panStartTy.set(ty.get());
    })
    .onUpdate((e) => {
      // While a pinch is active it owns the full transform; skip pan updates to
      // avoid the two gestures clobbering each other in Simultaneous.
      if (isPinching.get()) return;
      tx.set(panStartTx.get() + e.translationX);
      ty.set(panStartTy.get() + e.translationY);
    })
    .onEnd((e) => {
      if (isPinching.get()) return;
      // Throw the map with the finger's release velocity — native inertia feel.
      // Velocity is capped so a hard fling doesn't launch stars off-screen.
      const vx = Math.max(-MAX_FLING_VELOCITY, Math.min(MAX_FLING_VELOCITY, e.velocityX));
      const vy = Math.max(-MAX_FLING_VELOCITY, Math.min(MAX_FLING_VELOCITY, e.velocityY));
      // Re-cull + re-place labels/lattice at release AND again when each decay
      // axis comes to rest — the crisp lattice layer is cropped to the visible
      // rect, so inertia past the release framing must trigger a re-cull or a
      // hard fling exposes uncovered gutters (cross-model review finding).
      // `finished` guards the cancel case (a new touch settles on its own).
      tx.set(withDecay({ velocity: vx }, (finished) => {
        if (finished) runOnJS(bumpLabels)();
      }));
      ty.set(withDecay({ velocity: vy }, (finished) => {
        if (finished) runOnJS(bumpLabels)();
      }));
      runOnJS(bumpLabels)();
    });

  // Pinch-to-zoom toward the live focal point (midpoint between fingers).
  // The anchor is the content-space point under the initial focal; it stays under
  // the current focal as both scale and position change — matching the web's
  // per-frame midpoint recalculation so the map feels "grabbed" from wherever
  // the fingers land and flows naturally with finger drift.
  const pinch = Gesture.Pinch()
    .onBegin((e) => {
      isPinching.set(true);
      cancelAnimation(tx);
      cancelAnimation(ty);
      pinchScaleAtStart.set(scale.get());
      // Compute the content-space anchor under the initial focal once.
      pinchAnchorX.set((e.focalX - tx.get()) / scale.get());
      pinchAnchorY.set((e.focalY - ty.get()) / scale.get());
    })
    .onUpdate((e) => {
      const raw = pinchScaleAtStart.get() * e.scale;
      // Per-frame zoom-velocity clamp: no legitimate gesture frame changes the
      // zoom >15% (a fast pinch still compounds far quicker than fingers move),
      // but a DEGENERATE first e.scale — the Simulator's synthesized ⌥-pinch
      // touches registering a beat apart, or a hardware touch glitch — could
      // teleport the camera for a frame, flashing the whole field ~2× before
      // snapping back (the lines/arrows flicker Andy repro'd, 2026-07-06).
      const cur = scale.get();
      const stepClamped = Math.max(cur / 1.15, Math.min(cur * 1.15, raw));
      const ns = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, stepClamped));
      // Keep the anchor content point under the LIVE focal (e.focalX/Y updates each
      // frame as fingers move). Finger drift translates the canvas for free.
      tx.set(e.focalX - pinchAnchorX.get() * ns);
      ty.set(e.focalY - pinchAnchorY.get() * ns);
      scale.set(ns);
    })
    .onEnd(() => {
      // A pinch that settled → recompute the capped label set for the new framing.
      runOnJS(bumpLabels)();
    })
    .onFinalize(() => {
      isPinching.set(false);
      // Re-sync pan baseline so the next single-finger pan starts cleanly.
      panStartTx.set(tx.get());
      panStartTy.set(ty.get());
      // Commit the zoom bucket the pinch settled into (deferred during the gesture
      // to keep the pinch jank-free — this is what triggers the tier cross-fade).
      // onFinalize ALWAYS runs (including a cancelled pinch), so the LOD can never
      // get stuck a bucket behind the settled camera. Same hysteresis as the
      // reaction, against the committed mirror.
      const settled = hystBucket(scale.get(), bucketSV.get());
      if (settled !== bucketSV.get()) {
        bucketSV.set(settled);
        runOnJS(setBucket)(settled);
      }
    });

  // Zoom-in entry: the field scales up + fades in on mount, so opening the map
  // reads as zooming *into* the home thumbnail rather than a horizontal push
  // (the screen's stack animation is "fade"; this adds the scale).
  const enter = useSharedValue(0);
  useEffect(() => {
    enter.set(withTiming(1, { duration: 320, easing: Easing.out(Easing.cubic) }));
  }, [enter]);
  const enterStyle = useAnimatedStyle(() => ({
    opacity: enter.get(),
    transform: [{ scale: 0.8 + enter.get() * 0.2 }],
  }));

  // Dust layer: translate only — no `scale`. It is a fixed-pixel backdrop, not a
  // layer of the field (see the dustTx derivation above).
  const dustLayerStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: dustTx.get() }, { translateY: dustTy.get() }],
  }));
  // Which star (if any) is currently under a finger / under the trackpad
  // pointer. Shared values, not React state, so a touch drives only the stars'
  // own UI-thread worklets — pushing this through setState would re-render
  // every star and the whole SVG field on every pointer move.
  const pressedStarId = useSharedValue<string | null>(null);
  const hoveredStarId = useSharedValue<string | null>(null);
  // Drawer animation is now handled inside <StarDrawer />.
  const openStar = useCallback(
    (s: PositionedStar) => {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
      setSelected(s);
    },
    [],
  );
  const closeStar = useCallback(() => {
    setSelected(null);
  }, []);

  // Canvas-level tap → hit-test the nearest star. Distances are measured in
  // SCREEN POINTS, not content units: `starHitRadius` owns the target size and
  // the camera is never applied to it. (It used to compare a CONTENT-space
  // distance against a fixed 48, so the target breathed with the zoom — ~29pt
  // wide at the minimum zoom and ~384pt at MAX_ZOOM, where one star covered a
  // third of the screen and ate its neighbours' taps.)
  //
  // Ranking is by distance NORMALISED to each star's own radius, so when two
  // targets overlap the one you're proportionally deeper inside wins rather
  // than whichever happens to be geometrically nearer.
  const hitTest = useCallback(
    (px: number, py: number): PositionedStar | null => {
      if (!sky) return null;
      const sc = scale.get();
      const ox = tx.get();
      const oy = ty.get();
      const growth = starGrowthAt(sc);
      let best: PositionedStar | null = null;
      let bestRatio = 1;
      for (const s of sky.stars) {
        // Highlighted/zoom-revealed invitations and the night-museum's mastery
        // + cold-start "starter" stars are interactive (each has a StarDrawer
        // body — mastery/starter carry no CTA). Plain standard/territory dots
        // (no server-attached meta) remain inert in the Sky lens. Mirrors web
        // ConceptAtlasView's `Object.keys(seedMeta)` gate exactly.
        if (viewMode === "sky" && !s.interactive) continue;
        if (viewMode === "sky" && !tierVisibleAtBucket(s.displayTier, bucket)) continue;
        const d = Math.hypot(s.x * sc + ox - px, s.y * sc + oy - py);
        const ratio = d / starHitRadius(s, growth);
        if (ratio < bestRatio) {
          bestRatio = ratio;
          best = s;
        }
      }
      return best;
    },
    [sky, tx, ty, scale, viewMode, bucket],
  );
  const tapStar = useCallback(
    (px: number, py: number) => {
      const best = hitTest(px, py);
      if (best) openStar(best);
    },
    [hitTest, openStar],
  );
  // NOTE: every write to pressedStarId/hoveredStarId goes through runOnJS —
  // including the CLEARS. `hitTest` closes over React state so the marks can
  // only run on the JS thread; if a finalizer cleared the shared value inline
  // on the UI thread it would land BEFORE an already-queued mark, and the stale
  // mark would re-light a star the finger has left (stuck glow). Same-queue
  // scheduling makes mark/clear strictly FIFO instead.
  const markPressed = useCallback(
    (px: number, py: number) => {
      pressedStarId.set(hitTest(px, py)?._id ?? null);
    },
    [hitTest, pressedStarId],
  );
  const clearPressed = useCallback(() => {
    pressedStarId.set(null);
  }, [pressedStarId]);
  const markHovered = useCallback(
    (px: number, py: number) => {
      hoveredStarId.set(hitTest(px, py)?._id ?? null);
    },
    [hitTest, hoveredStarId],
  );
  const clearHovered = useCallback(() => {
    hoveredStarId.set(null);
  }, [hoveredStarId]);
  const tap = Gesture.Tap()
    .maxDistance(16)
    .onBegin((e) => {
      // Press-in feedback: light up whatever the finger is actually over,
      // BEFORE the tap resolves. The id lives in a shared value so only the
      // stars' own UI-thread worklets react — no React re-render per touch.
      runOnJS(markPressed)(e.x, e.y);
    })
    .onEnd((e) => {
      runOnJS(tapStar)(e.x, e.y);
    })
    .onFinalize(() => {
      runOnJS(clearPressed)();
    });

  // iPadOS trackpad / mouse hover. Same hit test as the tap, so what lights up
  // under the pointer is exactly what a click would open — a star that looks
  // hoverable but isn't (or vice versa) is worse than no hover at all.
  const hover = Gesture.Hover()
    .onBegin((e) => {
      runOnJS(markHovered)(e.x, e.y);
    })
    .onChange((e) => {
      runOnJS(markHovered)(e.x, e.y);
    })
    .onFinalize(() => {
      runOnJS(clearHovered)();
    });
  // Hover must NOT be a competitor in the race. `Gesture.Race` grants no
  // simultaneity between its branches, and the iOS hover recognizer activates
  // on pointer ENTER — i.e. before the click that follows it — so putting hover
  // inside the pan/pinch branch let it win the race and cancel `tap`, killing
  // trackpad clicks outright. Hover observes; tap/pan/pinch race among
  // themselves.
  const gesture = Gesture.Simultaneous(
    Gesture.Race(tap, Gesture.Simultaneous(pan, pinch)),
    hover,
  );

  const beginQuest = useCallback(async () => {
    if (!selected?.seedId || selected.completed || starting) return;
    setStarting(true);
    try {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(
        () => {},
      );
      const res = await createFromSeed({ seedId: selected.seedId as Id<"seeds"> });
      closeStar();
      router.push({
        pathname: "/session/[id]",
        params: { id: res.id, title: selected.topic },
      });
    } catch (e) {
      console.warn("[beginQuest] failed", e);
    } finally {
      setStarting(false);
    }
  }, [selected, starting, createFromSeed, closeStar]);

  return (
    <View style={[styles.root, { backgroundColor: SPACE }]}>
      {/* Zoom-in wrapper — the star field scales up + fades in on entry. */}
      <Animated.View style={[StyleSheet.absoluteFill, enterStyle]}>
        {/* Canvas (pan / pinch-zoom) — two layers for parallax depth. */}
        <GestureDetector gesture={gesture}>
          {/* Outer View is the gesture hit area (fills the screen, untransformed). */}
          <View style={StyleSheet.absoluteFill}>
            {/* Background dust: a fixed-pixel backdrop that pans at
                DUST_PARALLAX speed and holds still through a zoom. */}
            <Animated.View
              style={[StyleSheet.absoluteFill, dustLayerStyle]}
              pointerEvents="none"
            >
              {dustLayer}
            </Animated.View>

            {/* Full-field underlay — camera-ridden continuity backdrop (see the
                fieldUnderlay memo). Above the dust, below the crisp layers. */}
            {fieldUnderlay && (
              <Animated.View
                style={[StyleSheet.absoluteFill, { transformOrigin: "0% 0%" }, underlayStyle]}
                pointerEvents="none"
              >
                {fieldUnderlay}
              </Animated.View>
            )}

            {/* Prereq/thread lattice — SCREEN-SPACE delta layer: drawn at
                screen resolution from the settle snapshot (crisp lines +
                arrowheads at any zoom), with latticeDelta riding the live
                camera between settles. Placed here — above the dust, BELOW the
                camera canvas — so territory dots keep painting over the lines,
                the same stacking as when the lattice lived inside the canvas.
                pointerEvents none: the gesture view still owns all touches. */}
            {latticeSvg && (
              <View
                pointerEvents="none"
                style={{
                  position: "absolute",
                  left: -latticeSvg.snapshot.mW,
                  top: -latticeSvg.snapshot.mH,
                  width: width + 2 * latticeSvg.snapshot.mW,
                  height: height + 2 * latticeSvg.snapshot.mH,
                }}
              >
                {/* key = the snapshot: a settle re-render MOUNTS A FRESH layer
                    whose delta worklet initializes at identity in the same
                    commit, instead of mutating the old native view — the new
                    SVG content can never compose a frame under the OLD delta
                    transform (the finger-up flicker, Andy 2026-07-06). */}
                <Animated.View
                  key={`lat-${latticeSvg.snapshot.s0.toFixed(4)}-${latticeSvg.snapshot.tx0.toFixed(1)}-${latticeSvg.snapshot.ty0.toFixed(1)}`}
                  style={[StyleSheet.absoluteFill, { transformOrigin: "0% 0%" }, latticeDelta]}
                >
                  {latticeSvg.node}
                </Animated.View>
              </View>
            )}

            {/* Territory dots — SCREEN-SPACE delta layer, exactly like the
                lattice: drawn at native screen resolution from the settle
                snapshot (no more blocky blue/green dots at zoom — the old
                in-canvas layer was capped at content resolution), delta-ridden
                between settles, per-tier reveal opacity preserved inside. */}
            {territoryLayer && (
              <View
                pointerEvents="none"
                style={{
                  position: "absolute",
                  left: -territoryLayer.snapshot.mW,
                  top: -territoryLayer.snapshot.mH,
                  width: width + 2 * territoryLayer.snapshot.mW,
                  height: height + 2 * territoryLayer.snapshot.mH,
                }}
              >
                <Animated.View
                  key={`terr-${territoryLayer.snapshot.s0.toFixed(4)}-${territoryLayer.snapshot.tx0.toFixed(1)}-${territoryLayer.snapshot.ty0.toFixed(1)}`}
                  style={[StyleSheet.absoluteFill, { transformOrigin: "0% 0%" }, territoryDelta]}
                >
                  {territoryLayer.tiers.map(({ tier, node }) =>
                    tier === 0 ? (
                      <View
                        key={`terr-${tier}`}
                        style={[StyleSheet.absoluteFill, { opacity: terrTierBase[tier] }]}
                        pointerEvents="none"
                      >
                        {node}
                      </View>
                    ) : (
                      <Animated.View
                        key={`terr-${tier}`}
                        style={[StyleSheet.absoluteFill, terrTierStyle[tier]!]}
                        pointerEvents="none"
                      >
                        {node}
                      </Animated.View>
                    ),
                  )}
                </Animated.View>
              </View>
            )}

          </View>
        </GestureDetector>

        {/* Hub + feature stars — SCREEN-SPACE overlays (like the labels below):
            drawn at bucket-top size and worklet-pinned to their screen positions,
            because anything inside the camera canvas composites through a
            content-resolution buffer that no oversample can beat (measured
            2026-07-06 — see BUCKET_TOP_SCALE). Order: above the canvas, below
            the labels. */}
        {sky && (
          <View style={StyleSheet.absoluteFill} pointerEvents="none">
            {sky.showHub && (
              <HubGlyph cx={sky.cx} cy={sky.cy} bucket={bucket} tx={tx} ty={ty} scale={scale} />
            )}
            {/* Reaction halo for tappable stars with no FeatureStar of their
                own — kept OUTSIDE the tier layers so it isn't dimmed by a
                tier's fade-in while the finger is on it. */}
            <TerritoryFocusHalo
              index={focusIndex}
              pressedStarId={pressedStarId}
              hoveredStarId={hoveredStarId}
              tx={tx}
              ty={ty}
              scale={scale}
            />
            {/* Feature stars — seeds + lit mastery only, capped (GLOW_CAP).
                The only glowing / twinkling components on screen. Grouped by
                tier into opacity layers so a newly-revealed mastery star fades
                in with its tier instead of popping (tier 0 = seeds, always
                present → static). */}
            {[0, 1, 2, 3].map((tier) => {
              const fs = featuresByTier[tier];
              if (!fs.length) return null;
              const stars = fs.map((s) => (
                <FeatureStar
                  key={s._id}
                  star={s}
                  bucket={bucket}
                  tx={tx}
                  ty={ty}
                  scale={scale}
                  pressedStarId={pressedStarId}
                  hoveredStarId={hoveredStarId}
                />
              ));
              return tier === 0 ? (
                <View key={`feat-${tier}`} style={StyleSheet.absoluteFill} pointerEvents="none">
                  {stars}
                </View>
              ) : (
                <Animated.View
                  key={`feat-${tier}`}
                  style={[StyleSheet.absoluteFill, featTierStyle[tier]!]}
                  pointerEvents="none"
                >
                  {stars}
                </Animated.View>
              );
            })}
          </View>
        )}

        {/* Label overlay — screen-space, constant ~11.5pt, capped + collision-
            free. Inside the enter wrapper so it shares the mount zoom, but NOT
            inside the camera canvas, so labels never scale with the zoom. */}
        {sky && labelStars.length > 0 && (
          <View style={StyleSheet.absoluteFill} pointerEvents="none">
            {labelStars.map((s) => (
              <SkyLabel
                key={s._id}
                star={s}
                above={s.y < sky.cy}
                tx={tx}
                ty={ty}
                scale={scale}
                reveal={labelRevealFor(s.displayTier)}
              />
            ))}
          </View>
        )}
      </Animated.View>

      {/* loading */}
      {(me === undefined || field === undefined) && (
        <View style={styles.center} pointerEvents="none">
          <ActivityIndicator size="large" color={palette.violet[300]} />
        </View>
      )}
      {field && field.nodes.length === 0 && (
        <View style={styles.center} pointerEvents="none">
          <Text style={styles.emptySky}>
            Your sky is still dark. Explore a quest to light a star.
          </Text>
        </View>
      )}

      {/* TREE mode = the fully-NATIVE knowledge Tree (TreeMapNative — same
          view-models as the web tree via the vendored shared/treeMapLayout, drawn
          vector-crisp per crispSvg.ts). Replaces the old /embed/map WebView, so
          gestures are native and nothing blurs under pinch. A sibling overlay
          OUTSIDE the sky GestureDetector so the tree owns its own pinch/pan; it
          starts below the native top bar so the bar + pill stay native. */}
      {viewMode === "tree" && (
        <View style={[styles.treeWebViewWrap, { top: insets.top + HEADER_H }]}>
          <TreeMapNative />
        </View>
      )}

      {/* top bar — just a Done affordance, top-left. The Sky/Tree lens toggle is
          gone: the Sky map and the Math Skills Tree are now separate surfaces
          reached from separate Home tabs (Quests → Sky, Math → the "View your
          frontier" card), so this screen renders the single lens it opened on. */}
      <View style={[styles.topBar, { paddingTop: insets.top, height: insets.top + HEADER_H }]}>
        <Pressable onPress={() => router.back()} hitSlop={12} style={styles.close}>
          <Text style={styles.closeText}>Done</Text>
        </Pressable>
        {viewMode === "tree" && (
          <Text
            style={[styles.topBarTitle, { top: insets.top, lineHeight: HEADER_H }]}
            pointerEvents="none"
          >
            Math Skills Tree
          </Text>
        )}
      </View>

      {/* Recenter — text label, bottom-right; pinch/pan handle zoom. Sky-only:
          the web tree (tree mode) owns its own camera. */}
      {viewMode === "sky" && (
        <ZoomControls
          tx={tx}
          ty={ty}
          scale={scale}
          home={sky?.initialCamera}
          onSettle={bumpLabels}
        />
      )}

      {/* Star drawer — Reanimated bottom sheet with mastery evidence */}
      <StarDrawer
        star={selected}
        onDismiss={closeStar}
        onBeginQuest={beginQuest}
        starting={starting}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  center: {
    ...ABSOLUTE_FILL,
    alignItems: "center",
    justifyContent: "center",
    padding: 40,
  },
  emptySky: {
    color: palette.navy[200],
    fontSize: 18,
    textAlign: "center",
    fontFamily: "HankenGrotesk_400Regular",
    marginTop: 150,
  },
  starAnchor: { position: "absolute", left: 0, top: 0, width: 0, height: 0 },
  labelAnchor: { position: "absolute", left: 0, top: 0, width: 0, height: 0 },
  starLabel: {
    position: "absolute",
    left: -LABEL_BOX_W / 2,
    width: LABEL_BOX_W,
    color: palette.navy[100],
    fontSize: LABEL_FONT,
    lineHeight: LABEL_LINE_H,
    textAlign: "center",
    fontFamily: "HankenGrotesk_500Medium",
    textShadowColor: "rgba(10,7,24,0.9)",
    textShadowOffset: { width: 0, height: 1 },
    textShadowRadius: 3,
  },
  completedStarLabel: {
    opacity: 0.55,
  },
  topBar: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 18,
    backgroundColor: SPACE,
  },
  close: { width: 56 },
  topBarTitle: {
    position: "absolute",
    left: 0,
    right: 0,
    textAlign: "center",
    color: "#eaf0ff",
    fontSize: 17,
    fontFamily: "HankenGrotesk_600SemiBold",
  },
  closeText: {
    color: palette.violet[300],
    fontSize: 17,
    fontFamily: "HankenGrotesk_600SemiBold",
  },
  treeWebViewWrap: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: SPACE,
  },
  // ── Recenter control ─────────────────────────────────────────────────────────
  recenterWrap: {
    position: "absolute",
  },
  recenterText: {
    color: palette.violet[300],
    fontSize: 17,
    fontFamily: "HankenGrotesk_600SemiBold",
  },
});
