/**
 * A kid's own Sky on the BunnyPad (TRA-699; review/quests-rebuilt-proposal.html,
 * figures 9 and 9b), the twin of web's components/sky/YourSky.tsx. The Quests
 * tab's pull-down opens it (app/sky.tsx). Every star is something the kid did:
 * a small star for each wonder, labelled with their question, and one bright
 * star for each Quest they showed, with a trail back to the wonder it grew
 * from. A faint line joins stars that sit near each other. Nothing on it is a
 * suggestion, and no number appears on it.
 *
 * Tapping a star opens its drawer (figure 9b). Every action there returns the
 * kid to something they made: "Keep going" reopens the wonder's chat, "Open
 * it" opens the Quest, and a nearby star or "Started from" moves the sky to
 * that star.
 *
 * Drawing: the camera lives in three shared values, so a drag or pinch moves
 * the sky on the UI thread with no React render. Lines and stars are a few SVG
 * paths built from the camera each frame; labels are a handful of views. Which
 * labels show is decided in JS (shared/yourSkyModel.ts) when the camera settles.
 * Reduced motion turns off the glow's pulse and makes every camera move a cut.
 */

import { type ReactNode, useCallback, useEffect, useMemo, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { useRouter } from "expo-router";
import * as Haptics from "expo-haptics";
import {
  ActivityIndicator,
  Alert,
  Image,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
  type LayoutChangeEvent,
} from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import Svg, { Circle, Path } from "react-native-svg";
import Animated, {
  cancelAnimation,
  Easing,
  runOnJS,
  useAnimatedProps,
  useAnimatedReaction,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withDecay,
  withRepeat,
  withSequence,
  withTiming,
  type SharedValue,
} from "react-native-reanimated";

import { Drawer } from "@/components/ui/Drawer";
import { useContainedQuery } from "@/hooks/useContainedQuery";
import { useNow } from "@/hooks/useNow";
import { api, type Id } from "@/lib/convex";
import {
  LABEL_FONT_PX,
  YOUR_SKY_COLORS as C,
  cameraOnStar,
  fitSkyCamera,
  labelCap,
  labelsToShow,
  nearbyPairs,
  questShownLine,
  toScreen,
  trailPairs,
  wonderAskedLine,
  zoomAt,
  zoomLimits,
  type SkyCamera,
  type SkyStarLike,
  type SkyViewport,
} from "../../../vendor/shared/yourSkyModel";
import { fonts, useColors, type Colors } from "@/theme";
import { starAtPoint } from "@/lib/skyTap";
import { SKY_LABEL, skyLabelBox } from "../../../vendor/shared/skyLabelBox";
import { serverErrorMessage } from "../../../vendor/shared/serverErrorMessage";

type SkyStar = FunctionReturnType<typeof api.skyStars.forSelf>[number];

/** Smallest tap target, in points. */
const TOUCH = 44;
/** Clear space kept around the stars when the view fits them, in points. */
const FIT_PAD_PT = 32;
/** A camera move to a star, in ms (a cut under reduced motion). */
const GLIDE_MS = 420;
/** A fling is capped so a hard swipe doesn't throw the sky off screen. */
const MAX_FLING = 2500;
/** Labels fade while a pinch takes the sky this far below where they were
 *  placed (they would start to overlap), and come back when it settles. */
const LABEL_HIDE_BELOW = 0.8;
/** The right drawer's width (components/ui/Drawer: 42% of the screen, clamped
 *  to 320–460), so a star the sky moves to sits beside it. */
function drawerWidth(screenW: number): number {
  return Math.round(Math.min(460, Math.max(320, screenW * 0.42)));
}

function toLike(s: SkyStar): SkyStarLike {
  return {
    ...s,
    id: String(s.id),
    trailFromStarId: s.trailFromStarId ? String(s.trailFromStarId) : null,
    nearby: s.nearby.map(String),
  };
}

export function YourSky({ topInset }: { topInset: number }) {
  const stars = useQuery(api.skyStars.forSelf, {});
  return (
    <View style={[StyleSheet.absoluteFill, { backgroundColor: C.space }]}>
      <Dust />
      {stars === undefined ? (
        <View style={[styles.center, { paddingTop: topInset }]} pointerEvents="none">
          <ActivityIndicator color={C.label} />
        </View>
      ) : stars.length === 0 ? (
        <View style={[styles.center, { paddingTop: topInset }]} pointerEvents="none">
          <Text style={styles.empty}>
            A question you ask in the “I wonder…” box becomes a star here.
          </Text>
        </View>
      ) : (
        <SkyCanvas stars={stars} topInset={topInset} />
      )}
    </View>
  );
}

/** Faint background dust, fixed to the screen, the same on every render. */
const DUST = Array.from({ length: 90 }, (_, i) => {
  const h = (n: number) => {
    const x = Math.sin(i * 12.9898 + n * 78.233) * 43758.5453;
    return x - Math.floor(x);
  };
  return { x: h(1) * 100, y: h(2) * 100, r: 0.6 + h(3) * 0.8, o: 0.25 + h(4) * 0.45 };
});

function Dust() {
  return (
    <Svg width="100%" height="100%" style={StyleSheet.absoluteFill} pointerEvents="none">
      {DUST.map((d, i) => (
        <Circle key={i} cx={`${d.x}%`} cy={`${d.y}%`} r={d.r} fill={C.dust} opacity={d.o} />
      ))}
    </Svg>
  );
}

// ─── Paths, built on the UI thread from the camera ───────────────────

const AnimatedPath = Animated.createAnimatedComponent(Path);
const AnimatedCircle = Animated.createAnimatedComponent(Circle);

/** Circles at the world points `xy` ([x0, y0, x1, y1, …]), radius `r[i]`. */
function circlesPath(xy: readonly number[], r: readonly number[], k: number, tx: number, ty: number): string {
  "worklet";
  let d = "";
  for (let i = 0; i < r.length; i++) {
    const cx = xy[2 * i] * k + tx;
    const cy = xy[2 * i + 1] * k + ty;
    const ri = r[i];
    d += `M${cx - ri} ${cy}a${ri} ${ri} 0 1 0 ${2 * ri} 0a${ri} ${ri} 0 1 0 ${-2 * ri} 0Z`;
  }
  return d;
}

/** Four-point stars at the world points `xy`, `r` from center to tip (the
 *  shape of shared/yourSkyModel.ts `sparklePath`). */
function sparklesPath(xy: readonly number[], r: number, k: number, tx: number, ty: number): string {
  "worklet";
  const w = r * 0.3;
  let d = "";
  for (let i = 0; i < xy.length; i += 2) {
    const cx = xy[i] * k + tx;
    const cy = xy[i + 1] * k + ty;
    d +=
      `M${cx} ${cy - r}L${cx + w} ${cy - w}L${cx + r} ${cy}L${cx + w} ${cy + w}` +
      `L${cx} ${cy + r}L${cx - w} ${cy + w}L${cx - r} ${cy}L${cx - w} ${cy - w}Z`;
  }
  return d;
}

/** Straight segments ([ax, ay, bx, by, …]). */
function segmentsPath(seg: readonly number[], k: number, tx: number, ty: number): string {
  "worklet";
  let d = "";
  for (let i = 0; i < seg.length; i += 4) {
    d += `M${seg[i] * k + tx} ${seg[i + 1] * k + ty}L${seg[i + 2] * k + tx} ${seg[i + 3] * k + ty}`;
  }
  return d;
}

/** Trails as gentle arcs, bowing to one side so a trail reads as a path. */
function arcsPath(seg: readonly number[], k: number, tx: number, ty: number): string {
  "worklet";
  let d = "";
  for (let i = 0; i < seg.length; i += 4) {
    const ax = seg[i] * k + tx;
    const ay = seg[i + 1] * k + ty;
    const bx = seg[i + 2] * k + tx;
    const by = seg[i + 3] * k + ty;
    const mx = (ax + bx) / 2 - (by - ay) * 0.15;
    const my = (ay + by) / 2 + (bx - ax) * 0.15;
    d += `M${ax} ${ay}Q${mx} ${my} ${bx} ${by}`;
  }
  return d;
}

// ─── The sky ─────────────────────────────────────────────────────────

function SkyCanvas({ stars, topInset }: { stars: SkyStar[]; topInset: number }) {
  const { width: screenW } = useWindowDimensions();
  const reduceMotion = useReducedMotion();
  const [size, setSize] = useState<{ w: number; h: number } | null>(null);
  const onLayout = (e: LayoutChangeEvent) => {
    const { width: w, height: h } = e.nativeEvent.layout;
    setSize((prev) => (prev && prev.w === w && prev.h === h ? prev : { w, h }));
  };
  const vp = useMemo<SkyViewport | null>(
    () => (size ? { w: size.w, h: size.h, top: topInset } : null),
    [size, topInset],
  );

  const likes = useMemo(() => stars.map(toLike), [stars]);
  const byId = useMemo(() => new Map(stars.map((s) => [String(s.id), s])), [stars]);
  const fit = useMemo(() => (vp ? fitSkyCamera(likes, vp, FIT_PAD_PT) : null), [likes, vp]);
  const limits = useMemo(() => zoomLimits(fit?.k ?? LABEL_FONT_PX), [fit]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const drawerInset = drawerWidth(screenW);

  // The camera: `screen = world * k + t` (shared/yourSkyModel.ts).
  const k = useSharedValue(LABEL_FONT_PX);
  const tx = useSharedValue(0);
  const ty = useSharedValue(0);
  const minK = useSharedValue(limits.min);
  const maxK = useSharedValue(limits.max);
  useEffect(() => {
    minK.set(limits.min);
    maxK.set(limits.max);
  }, [limits, minK, maxK]);

  // Where the camera came to rest: what the labels are placed for, and what
  // a tap, a zoom button or a move to a star starts from. It is always passed
  // in (from the gesture's worklet, or the target just set): a shared value
  // read on the JS thread right after a write can still hold the old value.
  const [settled, setSettled] = useState<SkyCamera | null>(null);
  const settledK = useSharedValue(LABEL_FONT_PX);
  const settleAt = useCallback(
    (nk: number, ntx: number, nty: number) => {
      settledK.set(nk);
      setSettled({ k: nk, tx: ntx, ty: nty });
    },
    [settledK],
  );

  // The fitted view, until the kid moves the sky (then theirs stays put as
  // new stars arrive).
  const moved = useSharedValue(false);
  useEffect(() => {
    if (!fit || moved.get()) return;
    k.set(fit.k);
    tx.set(fit.tx);
    ty.set(fit.ty);
    // eslint-disable-next-line react-hooks/set-state-in-effect -- the fit is written to the camera's shared values first, and nothing draws until `settled` is set, so the sky never paints a frame at the default camera.
    settleAt(fit.k, fit.tx, fit.ty);
  }, [fit, k, tx, ty, moved, settleAt]);

  // Each move to a target gets a number; a drag or pinch takes a new one, so
  // a move it interrupted doesn't place the labels when its time is up.
  const glideGen = useSharedValue(0);
  const glideTo = useCallback(
    (target: SkyCamera) => {
      moved.set(true);
      cancelAnimation(k);
      cancelAnimation(tx);
      cancelAnimation(ty);
      const gen = glideGen.get() + 1;
      glideGen.set(gen);
      if (reduceMotion) {
        k.set(target.k);
        tx.set(target.tx);
        ty.set(target.ty);
        settleAt(target.k, target.tx, target.ty);
        return;
      }
      const timing = { duration: GLIDE_MS, easing: Easing.out(Easing.cubic) };
      k.set(withTiming(target.k, timing));
      tx.set(withTiming(target.tx, timing));
      ty.set(withTiming(target.ty, timing));
      // Labels are placed once the move lands. A JS timer, not a withTiming
      // callback (see components/ui/Drawer.tsx, CRASH NOTE).
      setTimeout(() => {
        if (glideGen.get() === gen) settleAt(target.k, target.tx, target.ty);
      }, GLIDE_MS + 20);
    },
    [k, tx, ty, moved, glideGen, reduceMotion, settleAt],
  );

  /** Move the sky to a star; `always` even when it is already in view. */
  const moveTo = useCallback(
    (id: string, always: boolean) => {
      const star = byId.get(id);
      const current = settled;
      if (!star || !vp || !current) return;
      if (!always) {
        const at = toScreen(star, current);
        const inView =
          at.x > TOUCH &&
          at.x < vp.w - drawerInset - TOUCH &&
          at.y > topInset + TOUCH &&
          at.y < vp.h - TOUCH * 2;
        if (inView) return;
      }
      glideTo(cameraOnStar(star, current, vp, drawerInset));
    },
    [byId, vp, settled, drawerInset, topInset, glideTo],
  );

  const select = useCallback(
    (id: string, always: boolean) => {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
      setSelectedId(id);
      moveTo(id, always);
    },
    [moveTo],
  );

  // ── Which labels show ──
  const shownLabels = useMemo(
    () =>
      settled && vp && fit
        ? labelsToShow(likes, settled, vp, { cap: labelCap(settled.k, fit.k), selectedId })
        : new Set<string>(),
    [likes, settled, vp, fit, selectedId],
  );
  const tapAt = useCallback(
    (x: number, y: number, nk: number, ntx: number, nty: number) => {
      const hit = starAtPoint(likes, { k: nk, tx: ntx, ty: nty }, x, y, shownLabels);
      if (hit) select(hit.id, false);
    },
    [likes, shownLabels, select],
  );

  // ── Gestures: drag, fling, pinch, tap ──
  const panStartX = useSharedValue(0);
  const panStartY = useSharedValue(0);
  const pinchStartK = useSharedValue(1);
  const anchorX = useSharedValue(0);
  const anchorY = useSharedValue(0);
  const isPinching = useSharedValue(false);
  const flingNonce = useSharedValue(0);
  useAnimatedReaction(
    () => flingNonce.get(),
    (nonce, prev) => {
      if (prev !== null && nonce !== prev) runOnJS(settleAt)(k.get(), tx.get(), ty.get());
    },
  );

  const pan = Gesture.Pan()
    .minDistance(4)
    .onBegin(() => {
      glideGen.set(glideGen.get() + 1);
      cancelAnimation(k);
      cancelAnimation(tx);
      cancelAnimation(ty);
      panStartX.set(tx.get());
      panStartY.set(ty.get());
    })
    .onUpdate((e) => {
      if (isPinching.get()) return;
      tx.set(panStartX.get() + e.translationX);
      ty.set(panStartY.get() + e.translationY);
    })
    .onEnd((e) => {
      moved.set(true);
      if (isPinching.get()) return;
      if (reduceMotion) {
        runOnJS(settleAt)(k.get(), tx.get(), ty.get());
        return;
      }
      const vx = Math.max(-MAX_FLING, Math.min(MAX_FLING, e.velocityX));
      const vy = Math.max(-MAX_FLING, Math.min(MAX_FLING, e.velocityY));
      // Each axis bumps the nonce when it comes to rest; the reaction above
      // makes the JS hop (UI-thread-only callbacks, as the Drawer's note asks).
      tx.set(
        withDecay({ velocity: vx }, (finished) => {
          if (finished) flingNonce.set(flingNonce.get() + 1);
        }),
      );
      ty.set(
        withDecay({ velocity: vy }, (finished) => {
          if (finished) flingNonce.set(flingNonce.get() + 1);
        }),
      );
      runOnJS(settleAt)(k.get(), tx.get(), ty.get());
    });

  // Zoom toward the point between the fingers, which stays under them.
  const pinch = Gesture.Pinch()
    .onBegin((e) => {
      isPinching.set(true);
      glideGen.set(glideGen.get() + 1);
      cancelAnimation(k);
      cancelAnimation(tx);
      cancelAnimation(ty);
      pinchStartK.set(k.get());
      anchorX.set((e.focalX - tx.get()) / k.get());
      anchorY.set((e.focalY - ty.get()) / k.get());
    })
    .onUpdate((e) => {
      const next = Math.max(minK.get(), Math.min(maxK.get(), pinchStartK.get() * e.scale));
      tx.set(e.focalX - anchorX.get() * next);
      ty.set(e.focalY - anchorY.get() * next);
      k.set(next);
    })
    .onEnd(() => {
      moved.set(true);
      runOnJS(settleAt)(k.get(), tx.get(), ty.get());
    })
    .onFinalize(() => {
      isPinching.set(false);
      panStartX.set(tx.get());
      panStartY.set(ty.get());
    });

  const tap = Gesture.Tap()
    .maxDistance(12)
    .onEnd((e) => {
      runOnJS(tapAt)(e.x, e.y, k.get(), tx.get(), ty.get());
    });

  const gesture = Gesture.Race(tap, Gesture.Simultaneous(pan, pinch));

  const zoomBy = useCallback(
    (factor: number) => {
      const current = settled;
      if (!vp || !current) return;
      const cx = vp.w / 2;
      const cy = topInset + (vp.h - topInset) / 2;
      glideTo(zoomAt(current, factor, cx, cy, limits));
    },
    [vp, settled, topInset, limits, glideTo],
  );

  // ── What is drawn ──
  const geometry = useMemo(() => {
    const wonderXY: number[] = [];
    const wonderGlowR: number[] = [];
    const questBrightXY: number[] = [];
    const questDimXY: number[] = [];
    const questGlowXY: number[] = [];
    const questGlowR: number[] = [];
    for (const s of stars) {
      if (s.kind === "quest") {
        (s.bright ? questBrightXY : questDimXY).push(s.x, s.y);
        questGlowXY.push(s.x, s.y);
        questGlowR.push(s.bright ? 16 : 9);
      } else {
        wonderXY.push(s.x, s.y);
        wonderGlowR.push(9);
      }
    }
    const segs = (pairs: [string, string][]) => {
      const out: number[] = [];
      for (const [a, b] of pairs) {
        const p = byId.get(a);
        const q = byId.get(b);
        if (p && q) out.push(p.x, p.y, q.x, q.y);
      }
      return out;
    };
    return {
      wonderXY,
      wonderGlowR,
      wonderCoreR: wonderGlowR.map(() => 3.4),
      questBrightXY,
      questDimXY,
      questGlowXY,
      questGlowR,
      near: segs(nearbyPairs(likes)),
      trails: segs(trailPairs(likes)),
    };
  }, [stars, likes, byId]);

  const selected = selectedId ? (byId.get(selectedId) ?? null) : null;

  return (
    <View style={StyleSheet.absoluteFill} onLayout={onLayout}>
      <GestureDetector gesture={gesture}>
        <View style={StyleSheet.absoluteFill} collapsable={false}>
          {vp && settled && (
            <>
              <SkyPaths
                geometry={geometry}
                selected={selected}
                k={k}
                tx={tx}
                ty={ty}
                reduceMotion={reduceMotion}
              />
              {stars.map((s) =>
                shownLabels.has(String(s.id)) ? (
                  <SkyLabel
                    key={s.id}
                    star={s}
                    k={k}
                    tx={tx}
                    ty={ty}
                    settledK={settledK}
                    onPress={() => select(String(s.id), false)}
                  />
                ) : null,
              )}
            </>
          )}
        </View>
      </GestureDetector>

      <View style={styles.zoom}>
        <Pressable
          onPress={() => zoomBy(1.5)}
          accessibilityRole="button"
          accessibilityLabel="Zoom in"
          style={({ pressed }) => [styles.zoomButton, pressed && styles.pressed]}
        >
          <Text style={styles.zoomText}>+</Text>
        </Pressable>
        <Pressable
          onPress={() => zoomBy(1 / 1.5)}
          accessibilityRole="button"
          accessibilityLabel="Zoom out"
          style={({ pressed }) => [styles.zoomButton, pressed && styles.pressed]}
        >
          <Text style={styles.zoomText}>−</Text>
        </Pressable>
      </View>

      <StarDrawer
        star={selected}
        byId={byId}
        onClose={() => setSelectedId(null)}
        goTo={(id) => select(id, true)}
      />
    </View>
  );
}

type Geometry = {
  wonderXY: number[];
  wonderGlowR: number[];
  wonderCoreR: number[];
  questBrightXY: number[];
  questDimXY: number[];
  questGlowXY: number[];
  questGlowR: number[];
  near: number[];
  trails: number[];
};

function SkyPaths({
  geometry: g,
  selected,
  k,
  tx,
  ty,
  reduceMotion,
}: {
  geometry: Geometry;
  selected: SkyStar | null;
  k: SharedValue<number>;
  tx: SharedValue<number>;
  ty: SharedValue<number>;
  reduceMotion: boolean;
}) {
  // The soft glow breathes, unless the kid's device asks for less motion.
  const glow = useSharedValue(0.17);
  useEffect(() => {
    if (reduceMotion) {
      cancelAnimation(glow);
      glow.set(0.17);
      return;
    }
    glow.set(
      withRepeat(
        withSequence(
          withTiming(0.24, { duration: 2100, easing: Easing.inOut(Easing.ease) }),
          withTiming(0.1, { duration: 2100, easing: Easing.inOut(Easing.ease) }),
        ),
        -1,
      ),
    );
    return () => cancelAnimation(glow);
  }, [glow, reduceMotion]);

  const nearProps = useAnimatedProps(() => ({
    d: segmentsPath(g.near, k.get(), tx.get(), ty.get()),
  }));
  const trailProps = useAnimatedProps(() => ({
    d: arcsPath(g.trails, k.get(), tx.get(), ty.get()),
  }));
  const wonderGlowProps = useAnimatedProps(() => ({
    d: circlesPath(g.wonderXY, g.wonderGlowR, k.get(), tx.get(), ty.get()),
    fillOpacity: glow.get(),
  }));
  const wonderCoreProps = useAnimatedProps(() => ({
    d: circlesPath(g.wonderXY, g.wonderCoreR, k.get(), tx.get(), ty.get()),
  }));
  const questGlowProps = useAnimatedProps(() => ({
    d: circlesPath(g.questGlowXY, g.questGlowR, k.get(), tx.get(), ty.get()),
    fillOpacity: glow.get(),
  }));
  const questBrightProps = useAnimatedProps(() => ({
    d: sparklesPath(g.questBrightXY, 12, k.get(), tx.get(), ty.get()),
  }));
  const questDimProps = useAnimatedProps(() => ({
    d: sparklesPath(g.questDimXY, 6.5, k.get(), tx.get(), ty.get()),
  }));
  const selX = selected?.x ?? 0;
  const selY = selected?.y ?? 0;
  const ringProps = useAnimatedProps(() => ({
    cx: selX * k.get() + tx.get(),
    cy: selY * k.get() + ty.get(),
  }));

  return (
    <Svg width="100%" height="100%" style={StyleSheet.absoluteFill} pointerEvents="none">
      <AnimatedPath
        animatedProps={nearProps}
        stroke={C.nearby}
        strokeWidth={1.2}
        strokeDasharray={[3, 5]}
        strokeOpacity={0.45}
        fill="none"
      />
      <AnimatedPath
        animatedProps={trailProps}
        stroke={C.trail}
        strokeWidth={2}
        strokeLinecap="round"
        strokeOpacity={0.9}
        fill="none"
      />
      <AnimatedPath animatedProps={wonderGlowProps} fill={C.wonder} />
      <AnimatedPath animatedProps={wonderCoreProps} fill={C.wonder} />
      <AnimatedPath animatedProps={questGlowProps} fill={C.quest} />
      <AnimatedPath animatedProps={questDimProps} fill={C.quest} fillOpacity={0.75} />
      <AnimatedPath animatedProps={questBrightProps} fill={C.quest} />
      {selected && (
        <AnimatedCircle
          animatedProps={ringProps}
          r={selected.bright ? 19 : 12}
          fill="none"
          stroke={C.label}
          strokeOpacity={0.7}
          strokeWidth={1.5}
        />
      )}
    </Svg>
  );
}

/** One star's label, centered under its dot at a fixed size. It is also the
 *  star's button for VoiceOver. */
function SkyLabel({
  star,
  k,
  tx,
  ty,
  settledK,
  onPress,
}: {
  star: SkyStar;
  k: SharedValue<number>;
  tx: SharedValue<number>;
  ty: SharedValue<number>;
  settledK: SharedValue<number>;
  onPress: () => void;
}) {
  const box = skyLabelBox({ x: 0, y: 0 }, star.label);
  const w = (box.right - box.left) * LABEL_FONT_PX + 12;
  const x = star.x;
  const y = star.y;
  const drop = (SKY_LABEL.dotEm / 2) * LABEL_FONT_PX;
  const style = useAnimatedStyle(() => ({
    transform: [
      { translateX: x * k.get() + tx.get() - w / 2 },
      { translateY: y * k.get() + ty.get() + drop },
    ],
    opacity: k.get() < settledK.get() * LABEL_HIDE_BELOW ? 0 : 1,
  }));
  const isQuest = star.kind === "quest";
  return (
    <Animated.View
      style={[styles.labelBox, { width: w }, style]}
      accessible
      accessibilityRole="button"
      accessibilityLabel={isQuest ? `Quest: ${star.label}` : star.label}
      onAccessibilityTap={onPress}
    >
      <Text
        numberOfLines={SKY_LABEL.maxLines}
        style={[
          styles.label,
          isQuest && { color: C.quest, fontFamily: fonts.bold },
        ]}
      >
        {star.label}
      </Text>
    </Animated.View>
  );
}

// ─── The drawer (figure 9b) ──────────────────────────────────────────

function StarDrawer({
  star,
  byId,
  onClose,
  goTo,
}: {
  star: SkyStar | null;
  byId: Map<string, SkyStar>;
  onClose: () => void;
  goTo: (id: string) => void;
}) {
  const colors = useColors();
  const s = useMemo(() => makeDrawerStyles(colors), [colors]);
  const router = useRouter();
  const serverDay = useQuery(api.institutions.currentDayForScholar, {});
  const timeZone = serverDay?.timeZone;
  const nowMs = useNow(60 * 60_000);
  const openQuest = useOpenQuest();

  // The drawer keeps its words while it slides closed.
  const [last, setLast] = useState<SkyStar | null>(star);
  if (star && star !== last) setLast(star);
  const shown = star ?? last;

  let eyebrow = "";
  let body: ReactNode = null;
  let action: { label: string; onPress: () => void; busy?: boolean } | null = null;

  if (shown?.kind === "wonder" && shown.wonder) {
    const w = shown.wonder;
    eyebrow = wonderAskedLine(w.askedOn, w.askedAt, nowMs, timeZone);
    const near = shown.nearby
      .map((id) => byId.get(String(id)))
      .filter((n): n is SkyStar => !!n);
    body = (
      <>
        {w.replyExcerpt ? (
          <Text style={s.reply}>
            <Text style={s.replyWho}>Rabbithole:</Text> {w.replyExcerpt}
          </Text>
        ) : null}
        {near.length > 0 ? (
          <View style={s.section}>
            <Text style={s.sectionEyebrow}>Near this in your sky</Text>
            <View style={s.chips}>
              {near.map((n, i) => (
                <StarChip
                  key={n.id}
                  label={n.label}
                  onPress={() => goTo(String(n.id))}
                  s={s}
                  testID={`sky-near-${i}`}
                />
              ))}
            </View>
          </View>
        ) : null}
      </>
    );
    const sessionId = shown.sessionId;
    if (sessionId) {
      action = {
        label: "Keep going",
        onPress: () => {
          Haptics.selectionAsync().catch(() => {});
          router.push({ pathname: "/session/[id]", params: { id: sessionId, title: shown.label } });
        },
      };
    }
  } else if (shown?.kind === "quest" && shown.quest) {
    const q = shown.quest;
    eyebrow = questShownLine(q.kind, q.shownAt, nowMs, timeZone);
    const from = shown.trailFromStarId ? byId.get(String(shown.trailFromStarId)) : undefined;
    const icon = q.badge?.icon ?? q.emoji;
    body = (
      <>
        {q.badge?.imageUrl || icon ? (
          <View style={s.badge}>
            {q.badge?.imageUrl ? (
              <Image
                source={{ uri: q.badge.imageUrl }}
                style={s.badgeImage}
                alt=""
                accessibilityIgnoresInvertColors
              />
            ) : (
              <Text style={s.badgeEmoji}>{icon}</Text>
            )}
          </View>
        ) : null}
        {q.mission ? <Fact label="Mission" value={q.mission} s={s} /> : null}
        {q.advisorName ? <Fact label="Advisor" value={q.advisorName} s={s} /> : null}
        {from ? (
          <View style={s.startedFrom}>
            <Text style={s.startedFromText}>Started from</Text>
            <StarChip
              label={from.label}
              onPress={() => goTo(String(from.id))}
              s={s}
              testID="sky-started-from"
            />
          </View>
        ) : null}
      </>
    );
    const unitId = shown.unitId;
    if (unitId) action = openQuest(unitId, shown.label);
  }

  return (
    <Drawer open={!!star} onClose={onClose} side="right" title={shown?.label ?? ""} eyebrow={eyebrow}>
      <ScrollView style={s.scroll} contentContainerStyle={s.scrollContent}>
        {body}
      </ScrollView>
      {action ? (
        <Pressable
          onPress={action.onPress}
          disabled={action.busy}
          accessibilityRole="button"
          style={({ pressed }) => [
            shown?.kind === "wonder" ? s.primary : s.secondary,
            pressed && styles.pressed,
          ]}
        >
          {action.busy ? (
            <ActivityIndicator color={shown?.kind === "wonder" ? "#fff" : colors.violet} />
          ) : (
            <Text style={shown?.kind === "wonder" ? s.primaryText : s.secondaryText}>
              {action.label}
            </Text>
          )}
        </Pressable>
      ) : null}
    </Drawer>
  );
}

/**
 * "Open it" opens a Quest the way the Quests tab's row for it does
 * (components/QuestProposalRows.tsx): an approved Quest opens its maker
 * activity's session (`sessions.create` returns the one already begun). An
 * older Quest, made before proposals, has no maker activity and opens its
 * unit page. The approved list is `questProposals.forSelf`, the read the
 * Quests tab holds; contained, so an error falls back to the unit page.
 */
function useOpenQuest() {
  const router = useRouter();
  const { data: proposals } = useContainedQuery(api.questProposals.forSelf, {});
  const createSession = useMutation(api.sessions.create);
  const [opening, setOpening] = useState<string | null>(null);
  return (unitId: Id<"units">, title: string) => {
    const approved = proposals?.approved.find((q) => q.unitId === unitId);
    return {
      label: "Open it",
      busy: opening === String(unitId),
      onPress: () => {
        Haptics.selectionAsync().catch(() => {});
        if (!approved) {
          router.push({ pathname: "/unit-progress" as never, params: { unitId, title } });
          return;
        }
        if (opening) return;
        setOpening(String(unitId));
        createSession({ activityId: approved.activityId })
          .then(
            (result) => {
              if (result?.id) {
                router.push({ pathname: "/session/[id]", params: { id: result.id, title } });
              }
            },
            (error: unknown) => {
              console.warn("[sky] couldn't open the Quest", error);
              Alert.alert(serverErrorMessage(error, "Couldn't open that Quest"), "Please try again.");
            },
          )
          .finally(() => setOpening(null));
      },
    };
  };
}

function StarChip({
  label,
  onPress,
  s,
  testID,
}: {
  label: string;
  onPress: () => void;
  s: DrawerStyles;
  /** Tells a chip apart from the sky's own label with the same words. */
  testID: string;
}) {
  return (
    <Pressable
      onPress={onPress}
      testID={testID}
      accessibilityLabel={label}
      accessibilityRole="button"
      accessibilityHint="Moves the sky to this star"
      style={({ pressed }) => [s.chip, pressed && styles.pressed]}
    >
      <Text style={s.chipText}>{label}</Text>
    </Pressable>
  );
}

function Fact({ label, value, s }: { label: string; value: string; s: DrawerStyles }) {
  return (
    <View style={s.fact}>
      <Text style={s.factLabel}>{label}</Text>
      <Text style={s.factValue}>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  center: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 40,
  },
  empty: {
    color: C.label,
    fontSize: 18,
    lineHeight: 27,
    textAlign: "center",
    fontFamily: fonts.medium,
    maxWidth: 420,
  },
  labelBox: { position: "absolute", left: 0, top: 0, alignItems: "center" },
  label: {
    color: C.label,
    fontSize: LABEL_FONT_PX,
    lineHeight: LABEL_FONT_PX * SKY_LABEL.lineEm,
    textAlign: "center",
    fontFamily: fonts.semibold,
    textShadowColor: "rgba(0,0,0,0.9)",
    textShadowOffset: { width: 0, height: 1 },
    textShadowRadius: 4,
  },
  zoom: { position: "absolute", right: 18, bottom: 24, gap: 10 },
  zoomButton: {
    width: TOUCH,
    height: TOUCH,
    borderRadius: TOUCH / 2,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(0,0,0,0.45)",
  },
  zoomText: { color: C.label, fontSize: 24, lineHeight: 28, fontFamily: fonts.medium },
  pressed: { opacity: 0.6 },
});

function makeDrawerStyles(colors: Colors) {
  return StyleSheet.create({
    scroll: { flex: 1 },
    scrollContent: { paddingTop: 14, paddingBottom: 18, gap: 16 },
    reply: { color: colors.fg, fontSize: 15, lineHeight: 23, fontFamily: fonts.regular },
    replyWho: { fontFamily: fonts.bold, color: colors.navy },
    section: { gap: 10 },
    sectionEyebrow: {
      color: colors.fgMuted,
      fontSize: 11,
      letterSpacing: 0.9,
      textTransform: "uppercase",
      fontFamily: fonts.bold,
    },
    chips: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
    chip: {
      minHeight: TOUCH,
      justifyContent: "center",
      paddingHorizontal: 14,
      borderRadius: TOUCH / 2,
      backgroundColor: colors.violetSubtle,
    },
    chipText: { color: colors.navy, fontSize: 14, fontFamily: fonts.semibold },
    badge: {
      width: 56,
      height: 56,
      borderRadius: 14,
      overflow: "hidden",
      alignItems: "center",
      justifyContent: "center",
      backgroundColor: colors.bgSubtle,
    },
    badgeImage: { width: 56, height: 56 },
    badgeEmoji: { fontSize: 32 },
    fact: { gap: 2 },
    factLabel: {
      color: colors.fgMuted,
      fontSize: 11,
      letterSpacing: 0.9,
      textTransform: "uppercase",
      fontFamily: fonts.bold,
    },
    factValue: { color: colors.fg, fontSize: 15, lineHeight: 21, fontFamily: fonts.semibold },
    startedFrom: { flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: 10 },
    startedFromText: { color: colors.fgMuted, fontSize: 14, fontFamily: fonts.medium },
    primary: {
      minHeight: 50,
      marginBottom: 16,
      borderRadius: 12,
      alignItems: "center",
      justifyContent: "center",
      backgroundColor: colors.violetSolid,
    },
    primaryText: { color: "#fff", fontSize: 16, fontFamily: fonts.bold },
    secondary: {
      minHeight: 50,
      marginBottom: 16,
      borderRadius: 12,
      alignItems: "center",
      justifyContent: "center",
      borderWidth: 1,
      borderColor: colors.border,
    },
    secondaryText: { color: colors.fg, fontSize: 16, fontFamily: fonts.semibold },
  });
}
type DrawerStyles = ReturnType<typeof makeDrawerStyles>;
