/* This surface drives its camera (pan / pinch / decay) from Reanimated shared
   values inside gesture-handler worklets and the recenter callback — the pattern
   ported verbatim from native/src/app/sky.tsx.

   It used to carry a file-wide `eslint-disable react-hooks/immutability`.
   Shared values now use the compiler-compliant `.get()`/`.set()` API, the
   unrelated declaration-order finding was fixed, and full-repo lint is held at
   zero. Don't re-add the disable. */
import { type ReactElement, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "convex/react";
import {
  ActivityIndicator,
  type LayoutChangeEvent,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import Svg, { G, Path, Polygon } from "react-native-svg";
import * as Haptics from "expo-haptics";
import Animated, {
  cancelAnimation,
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withDecay,
  withSpring,
  type SharedValue,
} from "react-native-reanimated";

import { api } from "@/lib/convex";
import { palette } from "@/theme";
import { useNow } from "@/hooks/useNow";
import {
  crispLayerRect,
  segmentIntersectsRect,
} from "@/lib/crispSvg";
import { selectLabels, type LabelCandidate } from "@/lib/skyDisplay";
import {
  buildFrontierLines,
  buildTreeVMs,
  computeCheckpointMarkers,
  computeGradeRuler,
  laneYPcts,
  railStrandsFit,
  smoothPath,
  type CheckpointMarker,
  type FrontierLine,
  type GradeRulerTick,
  type TreeEdgeVM,
  type TreeNodeVM,
} from "../../../vendor/shared/treeMapLayout";
import { domainFogState, domainFogLabel, type DomainFogState } from "../../../vendor/shared/domainFog";
import {
  scopeAllowsStrand,
  type ScholarMathPlan,
} from "../../../vendor/shared/mathPlanScope";
import {
  airlineArc,
  ARROW_REVEAL_RATIO,
  arrowheadPoints,
  dialGlyph,
  EDGE_LIT,
  EDGE_REST,
  FRONTIER_GOLD,
  FRONTIER_STYLE,
  LABEL_REST,
  LABEL_REVEAL_RATIO,
  LABEL_SELECTED,
  NODE_CAP_PX,
  PaperBackground,
  pointsAttr,
  straightEdge,
} from "./treeGlyphs";
import { NodeSheet } from "./NodeSheet";
import {
  nodeAccessibilityHint,
  nodeAccessibilityLabel,
  type NodeNeighbourhood,
} from "./treeNeighbourhood";

// TreeMapNative — the fully-native iPad knowledge Tree, replacing the WebView
// embed of /embed/map. It renders the SAME visual language as the web tree
// (components/map/MapTreeCanvas.tsx — the source of truth) with react-native-svg:
// a light "paper" plane, mastery dials, faint prereq edges that light blue on
// select, gold frontier lines, and a left strand rail — crisp at every zoom via
// the crispSvg crisp-layer trick, on the sky.tsx camera/gesture architecture.

// Camera clamp. Initial camera is IDENTITY (the whole tree fits by construction —
// xPct spans 6–94). MAX_ZOOM mirrors the web tree's maxZoomFactor (9).
const MIN_ZOOM = 0.7;
// Vertical row spread: lane rows sit 1.4× further apart than the raw yPct map
// (Andy, 2026-07-06 — two-line node labels collided with the next row's dots).
// Content is therefore taller than the viewport; the HOME camera fits it by
// opening at 1/ROW_SPREAD zoom (centered horizontally).
const ROW_SPREAD = 1.4;
// Screen px of adjacent-row gap needed before passive labels appear (a capped
// dial + two label lines + breathing room).
const LABEL_ROOM_PX = 68;
const MAX_ZOOM = 9;
// Cap fling velocity so a hard swipe doesn't launch the map off-screen (as sky).
const MAX_FLING_VELOCITY = 2500;

// Base on-screen dial size at scale 1 (grows with zoom, capped at NODE_CAP_PX).
const DIAL_BASE_PX = 18;

// Label metrics — the embed enlarges the tree's labels ×1.6 for iPad legibility
// (app/embed/map/page.tsx TREE_LABEL_SCALE). 11.5 is the base label size; ×1.6.
// 1.25 (was the embed's 1.6) — 1.6 read chunky next to the app's 12.5-17px
// body text (Andy, 2026-07-06); ~14.4px matches the rest of the UI.
const LABEL_FONT = 11.5 * 1.25; // ≈ 14.4 — constant on-screen px (never camera-scaled).
const LABEL_LINE_H = 18;
const LABEL_MAX_W = 240;
const LABEL_BOX_W = LABEL_MAX_W + 8;
const LABEL_CAP = 30;
// Screen px reserved for the left rail — passive labels never start inside it.
const RAIL_GUTTER_PX = 150;
// This surface's strand-pill height for railStrandsFit: 13px text on an 18px
// line + 3px padding top and bottom + hairline borders ≈ 25px, plus air. Bigger
// than the shared web default because the native rail runs a larger type scale.
const STRAND_ROOM_PX = 30;

// Label priority (higher wins a slot first): selected node > its neighbours >
// the one leading-frontier node per strand > everything else (revealed on zoom).
const PRIO_SELECTED = 100;
const PRIO_NEIGHBOUR = 60;
const PRIO_LEADING = 40;
const PRIO_REST = 10;

// Off-layer bleed for the frontier lines (screen px beyond the crisp-layer rect).
const BLEED = 60;

const ZOOM_SPRING = { damping: 28, stiffness: 300, mass: 0.8 } as const;

/* CRASH NOTE — never call runOnJS from an animation COMPLETION CALLBACK here.
   `runOnJS(...)` inside a withTiming/withSpring/withDecay completion callback can
   hard-crash the iOS app (SIGABRT, no red box: `JSIWorkletsModuleProxy::toOptimizedObject`
   → `JSScheduler::scheduleOnJS`) once the React Compiler MEMOIZES the enclosing
   component. The compiler is enabled in this app, and #1928 cleared
   `TreeMapNative`'s last recorded bailout. The two legacy withDecay completion
   callbacks below are therefore an ARMED risk, not a dormant one. This exact
   sequence already bit sky.tsx's ZoomControls (PR #1847 removed its last
   violation → memoized → the dormant recenter went live; PR #1853 fixed it).

   The remedy, copied from native/src/app/sky.tsx + ui/Drawer.tsx: drive the JS
   follow-up off a plain setTimeout, which never crosses the UI-worklet→JS
   boundary. See RECENTER_SETTLE_MS below (spring case) and the decay-fling
   CRASH NOTE in the pan gesture (the two calls left unfixed, with reasoning). */

/* Recenter settle timer. A spring has no duration, so this can't mirror an
   animation length — it must outlast the spring's own termination. This
   file's ZOOM_SPRING is byte-identical to sky.tsx's (damping 28 / stiffness 300
   / mass 0.8), so sky's derivation transfers EXACTLY: Reanimated 4.5 stops the
   spring on relative energy x² + (m/k)·v² < 6e-9, which for this spring lands at
   ~601ms, and 700ms clears that with margin. Do NOT re-derive a different number
   or scale it by eye; re-derive from sky.tsx only if ZOOM_SPRING changes here. */
const RECENTER_SETTLE_MS = 700;

type Snapshot = { scale: number; tx: number; ty: number };

/** On-screen dial diameter at a given camera scale (capped, per NODE_CAP_PX). */
function dialScreenPx(scale: number): number {
  return Math.min(DIAL_BASE_PX * scale, NODE_CAP_PX);
}

/** Strand slug → Title-Case rail label (port of MapTreeCanvas.titleCaseStrand). */
function titleCaseStrand(slug: string): string {
  return slug.replace(/[-_]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

// ── screen-space overlay pieces (siblings of the camera canvas, live-tracked) ──

// A node label — constant on-screen size, pinned BELOW the node's screen
// position (like sky.tsx's SkyLabel). Which labels render is decided at settle;
// this only tracks the live pan/zoom transform.
function TreeLabel({
  label,
  frontier,
  x,
  y,
  offset,
  color,
  tx,
  ty,
  scale,
}: {
  label: string;
  frontier: boolean;
  /** content-space node position (px). */
  x: number;
  y: number;
  /** vertical offset below the node (screen px, from the settle snapshot). */
  offset: number;
  color: string;
  tx: SharedValue<number>;
  ty: SharedValue<number>;
  scale: SharedValue<number>;
}) {
  // Explicit primitive deps: a live tree update re-lays-out node positions;
  // the follower worklet must rebuild or the label strands at its old spot
  // (same class as the sky's Skip-counting bug, 2026-07-06).
  const follow = useAnimatedStyle(
    () => ({
      transform: [
        { translateX: x * scale.get() + tx.get() },
        { translateY: y * scale.get() + ty.get() },
      ],
    }),
    [x, y, tx, ty, scale],
  );
  return (
    <Animated.View style={[styles.labelAnchor, follow]} pointerEvents="none">
      <Text
        style={[
          styles.nodeLabel,
          {
            top: offset,
            color,
            fontFamily: frontier
              ? "HankenGrotesk_700Bold"
              : "HankenGrotesk_600SemiBold",
          },
        ]}
        numberOfLines={2}
      >
        {label}
      </Text>
    </Animated.View>
  );
}

// A strand rail item: left-pinned, vertically camera-tracked (translateY only).
function RailItem({
  strand,
  showStrand,
  domainHeader,
  fogLabel,
  rowY,
  ty,
  scale,
}: {
  strand: string;
  /** false once the rows are too close together for a strand pill — the domain
   *  header then takes the row slot and is the only rail label left. */
  showStrand: boolean;
  domainHeader?: string;
  /** Surface 3 fog-of-war label ("uncharted" / "mapping now…") — paints once
   *  per band (its top lane), even on a single-domain map with no domain
   *  header to sit beside. Mirrors MapTreeCanvas.tsx's railItems. */
  fogLabel?: string | null;
  /** content-space row centre (px). */
  rowY: number;
  ty: SharedValue<number>;
  scale: SharedValue<number>;
}) {
  // Explicit deps — see TreeLabel's follow worklet.
  const follow = useAnimatedStyle(
    () => ({
      transform: [{ translateY: rowY * scale.get() + ty.get() }],
    }),
    [rowY, ty, scale],
  );
  return (
    <Animated.View style={[styles.railItem, follow]} pointerEvents="none">
      {domainHeader || fogLabel ? (
        <View
          style={[
            styles.domainHeaderWrap,
            // With the strands hidden there is no row of pills to float above:
            // the header drops onto its band's own top row, where the strand
            // pill would have been, and labels the band directly.
            showStrand ? styles.domainHeaderAboveStrand : styles.domainHeaderOnRow,
          ]}
        >
          <View style={styles.pill}>
            {domainHeader ? (
              <Text style={styles.domainHeaderText} numberOfLines={1}>{domainHeader.toUpperCase()}</Text>
            ) : null}
            {fogLabel ? (
              <Text style={styles.fogLabelText} numberOfLines={1}>{fogLabel}</Text>
            ) : null}
          </View>
        </View>
      ) : null}
      {showStrand ? (
        <View style={styles.strandPillWrap}>
          <View style={styles.pill}>
            <Text style={styles.strandText}>{strand}</Text>
          </View>
        </View>
      ) : null}
    </Animated.View>
  );
}

// A frontier-line tag: a small gold pill pinned near the top, x-tracking its line.
function FrontierTag({
  line,
  firstX,
  tx,
  scale,
}: {
  line: FrontierLine;
  /** content-space x of the line's first point (px). */
  firstX: number;
  tx: SharedValue<number>;
  scale: SharedValue<number>;
}) {
  const opacity =
    line.key === "current" ? 1 : line.key === "yesterday" ? 0.8 : 0.62;
  // Explicit deps — see TreeLabel's follow worklet.
  const follow = useAnimatedStyle(
    () => ({
      // Sits BELOW the grade ruler row (see GradeTag) so the two never collide.
      transform: [{ translateX: firstX * scale.get() + tx.get() + 6 }, { translateY: 30 }],
    }),
    [firstX, tx, scale],
  );
  return (
    <Animated.View style={[styles.frontierTag, { opacity }, follow]} pointerEvents="none">
      <Text style={styles.frontierTagText}>{line.label}</Text>
    </Animated.View>
  );
}

// A grade-ruler tick (K · 1 · 2 · … ): a quiet, muted pill pinned to the very
// top of the map, x-tracking its grade band's leading column — labels CONTENT
// (a grade band), never the scholar. Web parity: MapTreeCanvas's gradeRuler row.
function GradeTag({
  grade,
  contentX,
  tx,
  scale,
}: {
  grade: string;
  /** content-space x of the tick (px). */
  contentX: number;
  tx: SharedValue<number>;
  scale: SharedValue<number>;
}) {
  // Explicit deps — see TreeLabel's follow worklet.
  const follow = useAnimatedStyle(
    () => ({
      transform: [{ translateX: contentX * scale.get() + tx.get() }, { translateY: 6 }],
    }),
    [contentX, tx, scale],
  );
  return (
    <Animated.View style={[styles.gradeTag, follow]} pointerEvents="none">
      <Text style={styles.gradeTagText}>{grade}</Text>
    </Animated.View>
  );
}

// A strand × grade checkpoint badge: a small milestone flag anchored just past
// the last node of a grade band, tracking BOTH axes (it sits mid-lane, unlike
// the top grade ruler). GOLD ✓ once the whole band is demonstrated-green
// (certified); a quiet solid/total tally while it's still filling in. Web
// parity: MapTreeCanvas's checkpoint overlay. Future (not_started) gates are
// filtered out by the caller — the map shows only reached / in-reach milestones.
function CheckpointTag({
  marker,
  contentX,
  contentY,
  tx,
  ty,
  scale,
}: {
  marker: CheckpointMarker;
  /** content-space x/y of the marker (px). */
  contentX: number;
  contentY: number;
  tx: SharedValue<number>;
  ty: SharedValue<number>;
  scale: SharedValue<number>;
}) {
  // Explicit deps — see TreeLabel's follow worklet.
  const follow = useAnimatedStyle(
    () => ({
      transform: [
        { translateX: contentX * scale.get() + tx.get() },
        { translateY: contentY * scale.get() + ty.get() },
      ],
    }),
    [contentX, contentY, tx, ty, scale],
  );
  const certified = marker.status === "certified";
  return (
    <Animated.View style={[styles.checkpointAnchor, follow]} pointerEvents="none">
      <Text
        style={[
          styles.checkpointTagText,
          certified ? styles.checkpointTagTextCertified : styles.checkpointTagTextProgress,
        ]}
      >
        {certified ? `✓ G${marker.grade}` : `${marker.solid}/${marker.total} · G${marker.grade}`}
      </Text>
    </Animated.View>
  );
}

export function TreeMapNative() {
  const insets = useSafeAreaInsets();

  const me = useQuery(api.users.currentUser, {});
  const scholarId = me?._id;
  const tree = useQuery(
    api.practiceSkills.treeForScholar,
    scholarId ? { scholarId, allDomains: true } : "skip",
  );
  const readings = useQuery(
    api.nodeDepth.nodeReadingsForScholar,
    scholarId ? { scholarId } : "skip",
  );
  // Fog-of-war (Surface 3): per-domain map status, so the tree can fog the
  // exact domains that aren't mapped yet — mirrors components/map/MapTreeView.tsx
  // verbatim (same query, same classification, so the two frontends never diverge).
  const domainStatus = useQuery(
    api.practiceSkills.domainMapForScholar,
    scholarId ? { scholarId } : "skip",
  );
  const mathPlan = useQuery(
    api.mathPlans.myPlan,
    scholarId ? {} : "skip",
  ) as ScholarMathPlan | undefined;
  const domainFog = useMemo(() => {
    if (!domainStatus) return undefined;
    const map: Record<string, DomainFogState> = {};
    for (const d of domainStatus) {
      const fog = domainFogState(d.status);
      if (fog) map[d.domain] = fog;
    }
    return map;
  }, [domainStatus]);

  // The component doesn't fill the whole window (it mounts where the WebView was),
  // so its own onLayout is the content-space viewport.
  const [dims, setDims] = useState({ w: 0, h: 0 });
  const onLayout = useCallback((e: LayoutChangeEvent) => {
    const { width, height } = e.nativeEvent.layout;
    setDims((d) => (d.w === width && d.h === height ? d : { w: width, h: height }));
  }, []);
  const contentW = dims.w;
  const contentH = dims.h;
  // Y positions map into a 1.4×-taller space (see ROW_SPREAD).
  const contentHY = dims.h * ROW_SPREAD;
  // The fitted HOME camera (also the recenter target): whole spread tree in view.
  const homeScale = 1 / ROW_SPREAD;
  const homeTx = (contentW * (1 - homeScale)) / 2;

  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const nowMs = useNow(60_000);

  // Scholar-redacted view-models + frontier poly-lines, from the vendored shared
  // core (the SAME math the web tree runs).
  const vms = useMemo<TreeNodeVM[] | null>(() => {
    if (!tree) return null;
    return buildTreeVMs(
      { nodes: tree.nodes, edges: tree.edges },
      readings?.readings ?? [],
      "scholar",
      tree.domains,
      tree.domainLabels,
    );
  }, [tree, readings]);
  const frontierLines = useMemo<FrontierLine[]>(() => {
    if (!tree) return [];
    return buildFrontierLines({ nodes: tree.nodes, edges: tree.edges }, nowMs, tree.domains);
  }, [nowMs, tree]);
  // The top grade ruler (K · 1 · 2 · … ) — mirrors MapTreeView's memo verbatim.
  const gradeRuler = useMemo<GradeRulerTick[]>(() => {
    if (!tree) return [];
    return computeGradeRuler({ nodes: tree.nodes, edges: tree.edges }, tree.domains);
  }, [tree]);
  // Strand × grade checkpoint milestones — mirrors MapTreeView's memo verbatim.
  const checkpoints = useMemo<CheckpointMarker[]>(() => {
    if (!tree) return [];
    return computeCheckpointMarkers({ nodes: tree.nodes, edges: tree.edges }, tree.domains);
  }, [tree]);
  const edges = useMemo<TreeEdgeVM[]>(() => tree?.edges ?? [], [tree]);

  // Undirected neighbour map (port of MapTreeCanvas.neighboursByKey) — a selected
  // node promotes its neighbours' labels + lights their edges blue.
  const neighboursByKey = useMemo(() => {
    const neigh = new Map<string, Set<string>>();
    if (!vms) return neigh;
    const keys = new Set(vms.map((n) => n.nodeKey));
    const add = (k: string, v: string) => {
      let s = neigh.get(k);
      if (!s) {
        s = new Set();
        neigh.set(k, s);
      }
      s.add(v);
    };
    for (const e of edges) {
      if (!keys.has(e.fromKey) || !keys.has(e.toKey)) continue;
      add(e.fromKey, e.toKey);
      add(e.toKey, e.fromKey);
    }
    return neigh;
  }, [edges, vms]);

  // ── Camera (shared values) — pan + pinch-anchor + capped decay fling + tap
  //    race, exactly like sky.tsx. ──
  const tx = useSharedValue(0);
  const ty = useSharedValue(0);
  const scale = useSharedValue(1);
  const [snapshot, setSnapshot] = useState<Snapshot>({ scale: 1, tx: 0, ty: 0 });

  // Open on the fitted HOME camera once the layout reports its size (dims start
  // 0×0 before onLayout). One-shot — never yanks the camera after that.
  const framedRef = useRef(false);
  useEffect(() => {
    if (framedRef.current || contentW === 0 || contentH === 0) return;
    framedRef.current = true;
    tx.set(homeTx);
    ty.set(0);
    scale.set(homeScale);
    setSnapshot({ scale: homeScale, tx: homeTx, ty: 0 });
  }, [contentW, contentH, homeScale, homeTx, tx, ty, scale]);
  // Declared BEFORE any worklet/reaction that reads it (the sky.tsx footgun: a
  // shared value referenced by a worklet must exist at closure-capture time).
  const isPinching = useSharedValue(false);
  const panStartTx = useSharedValue(0);
  const panStartTy = useSharedValue(0);
  const pinchScaleAtStart = useSharedValue(1);
  const pinchAnchorX = useSharedValue(0);
  const pinchAnchorY = useSharedValue(0);

  // Camera SNAPSHOT captured into React state at each settle. ALL crisp-layer
  // math reads the snapshot, never .value in render, so the crisp layer only
  // re-renders (crisp) at rest — mid-gesture it GPU-stretches with the camera.
  // A fresh object is written on EVERY settle (pan end / decay finish / pinch
  // finalize / recenter), so `snapshot`'s identity is itself the settle epoch
  // (the sky.tsx `bumpLabels`/`settle` counter, folded into the snapshot) — it
  // drives both the crisp-layer and label re-derivation below.
  const commitSettle = useCallback((s: number, x: number, y: number) => {
    setSnapshot({ scale: s, tx: x, ty: y });
  }, [setSnapshot]);

  // Pending re-snapshot for an in-flight recenter — driven off a JS timer, NOT a
  // spring completion callback (see the CRASH NOTE by RECENTER_SETTLE_MS).
  const settleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (settleTimer.current) clearTimeout(settleTimer.current);
    },
    [],
  );

  const selectNode = useCallback((key: string | null) => {
    if (key) Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
    setSelectedKey(key);
  }, []);

  // Tap hit-test: invert the camera, pick the nearest node within a screen-px
  // radius (max(28, dialScreenPx/2 + 8)); background tap deselects.
  const tapNode = useCallback(
    (px: number, py: number) => {
      if (!vms || contentW === 0 || contentH === 0) return;
      const s = scale.get();
      const cx = (px - tx.get()) / s;
      const cy = (py - ty.get()) / s;
      const hitR = Math.max(28, dialScreenPx(s) / 2 + 8);
      let best: string | null = null;
      let bestD = hitR;
      for (const n of vms) {
        const nx = (n.xPct / 100) * contentW;
        const ny = (n.yPct / 100) * contentHY;
        const dScreen = Math.hypot(nx - cx, ny - cy) * s;
        if (dScreen < bestD) {
          bestD = dScreen;
          best = n.nodeKey;
        }
      }
      selectNode(best);
    },
    [vms, contentW, contentH, contentHY, tx, ty, scale, selectNode],
  );

  const pan = Gesture.Pan()
    .minDistance(2)
    .onBegin(() => {
      cancelAnimation(tx);
      cancelAnimation(ty);
      panStartTx.set(tx.get());
      panStartTy.set(ty.get());
    })
    .onUpdate((e) => {
      if (isPinching.get()) return;
      tx.set(panStartTx.get() + e.translationX);
      ty.set(panStartTy.get() + e.translationY);
    })
    .onEnd((e) => {
      if (isPinching.get()) return;
      const vx = Math.max(-MAX_FLING_VELOCITY, Math.min(MAX_FLING_VELOCITY, e.velocityX));
      const vy = Math.max(-MAX_FLING_VELOCITY, Math.min(MAX_FLING_VELOCITY, e.velocityY));
      // Re-snapshot at the release framing now (labels re-place immediately) AND
      // again as the decay comes to rest. BOTH axes get a completion callback —
      // a mostly-vertical fling finishes tx first, and committing from tx alone
      // would freeze the crisp layer while ty is still moving (cross-model
      // review finding). A double commit is harmless: the snapshot is
      // idempotent and the later one lands at the truly settled camera.
      //
      // CRASH NOTE — these two `runOnJS(commitSettle)` calls are inside withDecay
      // COMPLETION CALLBACKS, the exact shape that hard-crashes the app once the
      // React Compiler memoizes this component (see the CRASH NOTE by
      // RECENTER_SETTLE_MS). They are LEFT UNFIXED, deliberately:
      //   • ARMED now — #1928 cleared `TreeMapNative`'s last recorded compiler
      //     bailout, so these callbacks no longer have incidental protection.
      //   • NO fixed JS timer can replace them. Unlike the recenter spring (whose
      //     ~601ms termination is derivable), a withDecay's duration is a function
      //     of release velocity — a timer right for a gentle flick is wrong for a
      //     hard one, so the Drawer/recenter remedy does not transfer.
      //   • The shipped reference (native/src/app/sky.tsx) makes the SAME choice:
      //     it fixed only its recenter spring and still runs `runOnJS(bumpLabels)`
      //     in its withDecay fling callbacks. SkyScreen currently bails on an
      //     upstream try/finally lowering gap; that incidental protection can
      //     disappear in a compiler upgrade.
      //   A future fix must track a velocity-dependent rest WITHOUT an
      //   animation-completion callback — e.g. a `useAnimatedReaction` that
      //   watches tx/ty for rest and fires `commitSettle` from there (a reaction
      //   is a different context; this file already runs `runOnJS` from reactions
      //   — see the grabX reaction — without crashing, but that a reaction is
      //   crash-SAFE here is inferred, not device-verified). Alternatively these
      //   commits may be droppable outright: line ~588 already commits
      //   unconditionally at release and pinch's onFinalize commits too — what is
      //   lost is the re-cull at the SETTLED framing after a fling (a hard fling
      //   would leave the crisp layer / labels culled to the release viewport,
      //   exposing uncovered gutters until the next gesture). That is a visible
      //   quality regression, not a correctness bug; do not delete on our own
      //   authority — tracked in TODO.html#runonjs-decay-completion-callbacks.
      tx.set(withDecay({ velocity: vx }, (finished) => {
        if (finished) runOnJS(commitSettle)(scale.get(), tx.get(), ty.get());
      }));
      ty.set(withDecay({ velocity: vy }, (finished) => {
        if (finished) runOnJS(commitSettle)(scale.get(), tx.get(), ty.get());
      }));
      runOnJS(commitSettle)(scale.get(), tx.get(), ty.get());
    });

  const pinch = Gesture.Pinch()
    .onBegin((e) => {
      isPinching.set(true);
      cancelAnimation(tx);
      cancelAnimation(ty);
      pinchScaleAtStart.set(scale.get());
      pinchAnchorX.set((e.focalX - tx.get()) / scale.get());
      pinchAnchorY.set((e.focalY - ty.get()) / scale.get());
    })
    .onUpdate((e) => {
      const ns = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, pinchScaleAtStart.get() * e.scale));
      tx.set(e.focalX - pinchAnchorX.get() * ns);
      ty.set(e.focalY - pinchAnchorY.get() * ns);
      scale.set(ns);
    })
    .onFinalize(() => {
      isPinching.set(false);
      panStartTx.set(tx.get());
      panStartTy.set(ty.get());
      // onFinalize ALWAYS runs (incl. a cancelled pinch) → the snapshot can never
      // get stuck behind the settled camera.
      runOnJS(commitSettle)(scale.get(), tx.get(), ty.get());
    });

  const tap = Gesture.Tap()
    .maxDistance(16)
    .onEnd((e) => {
      runOnJS(tapNode)(e.x, e.y);
    });
  const gesture = Gesture.Race(tap, Gesture.Simultaneous(pan, pinch));

  const canvasStyle = useAnimatedStyle(() => ({
    transform: [
      { translateX: tx.get() },
      { translateY: ty.get() },
      { scale: scale.get() },
    ],
  }));

  const recenter = useCallback(() => {
    tx.set(withSpring(homeTx, ZOOM_SPRING));
    ty.set(withSpring(0, ZOOM_SPRING));
    scale.set(withSpring(homeScale, ZOOM_SPRING));
    // The old completion callback re-snapshotted only when the spring finished.
    // Dropping that guard is safe: `commitSettle` reads the LIVE camera at fire
    // time (not the captured home framing), so an interrupted recenter re-culls
    // at wherever the camera actually is — idempotent with the interrupting
    // gesture's own settle. Correctness is unaffected; an interrupted recenter
    // costs at most one redundant re-cull.
    if (settleTimer.current) clearTimeout(settleTimer.current);
    settleTimer.current = setTimeout(() => {
      settleTimer.current = null;
      commitSettle(scale.get(), tx.get(), ty.get());
    }, RECENTER_SETTLE_MS);
  }, [tx, ty, scale, commitSettle, homeScale, homeTx]);

  // ── The ONE crisp layer: edges, frontier lines, and dials, drawn at content
  //    coords inside the camera canvas at the settle-snapshot oversample. ──
  const crisp = useMemo(() => {
    if (!vms || contentW === 0 || contentH === 0 || vms.length === 0) return null;
    const s = Math.max(snapshot.scale, 0.0001);
    const rect = crispLayerRect({
      scale: s,
      tx: snapshot.tx,
      ty: snapshot.ty,
      viewportW: contentW,
      viewportH: contentH,
      contentW,
      contentH: contentHY,
      margin: 0.6,
    });
    const res = rect.res;
    const RX = (x: number) => (x - rect.x) * res;
    const RY = (y: number) => (y - rect.y) * res;
    const pxR = res / s; // raster px per 1 screen px
    const invS = 1 / s; // content px per 1 screen px

    const pos = new Map<string, { x: number; y: number }>();
    const nodeByKey = new Map<string, TreeNodeVM>();
    for (const n of vms) {
      pos.set(n.nodeKey, { x: (n.xPct / 100) * contentW, y: (n.yPct / 100) * contentHY });
      nodeByKey.set(n.nodeKey, n);
    }

    const dScreen = dialScreenPx(s);
    const rDotScreen = dScreen / 2;
    // HOME-relative, like the web (info.zoom / info.baseZoom): the fitted home
    // camera is 1/ROW_SPREAD, so comparing the absolute scale revealed ~1.4×
    // too late (cross-model review finding, 2026-07-06).
    const showRestArrows = s / homeScale >= ARROW_REVEAL_RATIO;

    // (a) EDGES — cross-strand faint at rest; the selected node's whole
    // neighbourhood lit blue (same-strand as an airline arc, cross-strand straight).
    const edgeEls: ReactElement[] = [];
    for (const e of edges) {
      const a = pos.get(e.fromKey);
      const b = pos.get(e.toKey);
      const from = nodeByKey.get(e.fromKey);
      const to = nodeByKey.get(e.toKey);
      if (!a || !b || !from || !to) continue; // only drawable edges
      const crossStrand = from.strand !== to.strand;
      const touches =
        selectedKey != null && (e.fromKey === selectedKey || e.toKey === selectedKey);
      if (!touches && !crossStrand) continue; // same-strand at rest is hidden
      if (!segmentIntersectsRect(a.x, a.y, b.x, b.y, rect)) continue;

      const lit = touches;
      const color = lit ? EDGE_LIT : EDGE_REST;
      const opacity = lit ? 0.9 : 0.2;
      const strokeW = (lit ? 1.75 : 1) * pxR;

      const lenContent = Math.hypot(b.x - a.x, b.y - a.y) || 1;
      const lenScreen = lenContent * s;
      const back = Math.min(lenScreen * 0.5, rDotScreen + 4) * invS;
      const sameStrand = from.strand != null && from.strand === to.strand;

      let d: string;
      let ex: number;
      let ey: number;
      let tanX: number;
      let tanY: number;
      if (lit && sameStrand) {
        const arcH = Math.min(110, Math.max(20, lenScreen * 0.375)) * invS;
        const g = airlineArc(a.x, a.y, b.x, b.y, arcH, back);
        d = `M${RX(g.sx).toFixed(2)},${RY(g.sy).toFixed(2)} Q${RX(g.cx).toFixed(2)},${RY(g.cy).toFixed(2)} ${RX(g.ex).toFixed(2)},${RY(g.ey).toFixed(2)}`;
        ex = g.ex;
        ey = g.ey;
        tanX = g.tanX;
        tanY = g.tanY;
      } else {
        const g = straightEdge(a.x, a.y, b.x, b.y, back);
        d = `M${RX(g.sx).toFixed(2)},${RY(g.sy).toFixed(2)} L${RX(g.ex).toFixed(2)},${RY(g.ey).toFixed(2)}`;
        ex = g.ex;
        ey = g.ey;
        tanX = g.tanX;
        tanY = g.tanY;
      }
      const key = `${e.fromKey}__${e.toKey}`;
      edgeEls.push(
        <Path
          key={key}
          d={d}
          fill="none"
          stroke={color}
          strokeWidth={strokeW}
          strokeOpacity={opacity}
          strokeLinecap="round"
        />,
      );
      // Arrowhead — lit edges always; faint at-rest edges only when zoomed in.
      if (lit || showRestArrows) {
        const pts = arrowheadPoints(RX(ex), RY(ey), tanX, tanY, 6 * pxR);
        edgeEls.push(
          <Polygon key={`${key}-h`} points={pointsAttr(pts)} fill={color} opacity={opacity} />,
        );
      }
    }

    // (b) FRONTIER LINES — full-bleed gold guides through each lane's boundary.
    const frontierEls: ReactElement[] = [];
    for (const line of frontierLines) {
      if (line.points.length === 0) continue;
      const style = FRONTIER_STYLE[line.key];
      const cpts = line.points.map((p) => ({
        x: (p.xPct / 100) * contentW,
        y: (p.yPct / 100) * contentHY,
      }));
      const top = { x: cpts[0].x, y: rect.y - BLEED * invS };
      const bottom = { x: cpts[cpts.length - 1].x, y: rect.y + rect.h + BLEED * invS };
      const rpts = [top, ...cpts, bottom].map((p) => ({ sx: RX(p.x), sy: RY(p.y) }));
      frontierEls.push(
        <Path
          key={line.key}
          d={smoothPath(rpts)}
          fill="none"
          stroke={FRONTIER_GOLD}
          strokeWidth={style.width * pxR}
          strokeOpacity={style.opacity}
          strokeLinecap="round"
          strokeLinejoin="round"
        />,
      );
    }

    // (c) NODE DIALS — sized to the on-screen cap, drawn crisp at raster density.
    const sizeR = (dScreen * invS) * res; // content dial size × res
    const arcRr = (sizeR * 18) / 44;
    const flankR = 1.5 * pxR;
    const dialEls: ReactElement[] = [];
    for (const n of vms) {
      const p = pos.get(n.nodeKey)!;
      if (p.x < rect.x || p.x > rect.x + rect.w || p.y < rect.y || p.y > rect.y + rect.h) {
        continue; // outside the layer rect
      }
      const selected = n.nodeKey === selectedKey;
      // Surface 3 fog-of-war: a domain that's grade-eligible but not yet
      // mapped renders its dials hazy — driven purely by the domain's band
      // status (never a per-node reading), so it can't diverge from the fog
      // label painted on the band's rail header. Mirrors MapTreeCanvas.tsx.
      const fogged = n.domain ? Boolean(domainFog?.[n.domain]) : false;
      const outOfScope =
        !!mathPlan &&
        !scopeAllowsStrand(mathPlan.practiceScope, n.domain ?? "", n.strand);
      const glyph = dialGlyph({
        keyId: n.nodeKey,
        cx: RX(p.x),
        cy: RY(p.y),
        size: sizeR,
        flank: flankR,
        mastery: n.mastery,
        automaticity: n.automaticity,
        depth: n.depth,
        halo: n.frontier ? { r: arcRr * 2.2 } : undefined,
        selection: selected
          ? { r1: arcRr + 1.5 * pxR, r2: arcRr + 4.5 * pxR, stroke: 3 * pxR }
          : undefined,
      });
      dialEls.push(
        fogged || outOfScope ? (
          <G key={`fog-${n.nodeKey}`} opacity={0.35}>
            {glyph}
            {outOfScope ? (
              <Path
                d={`M${(RX(p.x) + sizeR * 0.45).toFixed(2)},${(RY(p.y) - sizeR * 0.45).toFixed(2)} L${(RX(p.x) - sizeR * 0.45).toFixed(2)},${(RY(p.y) + sizeR * 0.45).toFixed(2)}`}
                stroke="#6b7280"
                strokeWidth={pxR}
                strokeLinecap="round"
              />
            ) : null}
          </G>
        ) : (
          <G key={`plain-${n.nodeKey}`}>{glyph}</G>
        ),
      );
    }

    return (
      <View
        style={{ position: "absolute", left: rect.x, top: rect.y, width: rect.w, height: rect.h }}
        pointerEvents="none"
      >
        <Svg
          width={rect.w * res}
          height={rect.h * res}
          style={{ transform: [{ scale: 1 / res }], transformOrigin: "0% 0%" }}
        >
          {edgeEls}
          {frontierEls}
          {dialEls}
        </Svg>
      </View>
    );
    // scale/tx/ty are read from the SNAPSHOT, not .value; recompute only at settle.
  }, [vms, edges, frontierLines, snapshot, selectedKey, contentW, contentH, contentHY, homeScale, domainFog, mathPlan]);

  // Smallest vertical gap between adjacent lane rows (content px), straight
  // from the VMs. Labels are withheld until this gap AT the settle zoom leaves
  // room for a dial + a two-line label — the web reveals labels by zoom ratio;
  // on native the gap itself is the honest measure (Andy, 2026-07-06: labels
  // collided with the next row's dots when zoomed out).
  const minRowGap = useMemo(() => {
    if (!vms || vms.length === 0) return Number.MAX_SAFE_INTEGER;
    const laneYs = new Map<number, number>();
    for (const n of vms) if (!laneYs.has(n.lane)) laneYs.set(n.lane, (n.yPct / 100) * contentHY);
    const ys = [...laneYs.values()].sort((a, b) => a - b);
    let gap = Infinity;
    for (let i = 1; i < ys.length; i++) gap = Math.min(gap, ys[i] - ys[i - 1]);
    return Number.isFinite(gap) ? gap : Number.MAX_SAFE_INTEGER;
  }, [vms, contentHY]);

  // ── Screen-space label set — chosen at settle via selectLabels (snapshot). ──
  const labelKeys = useMemo(() => {
    if (!vms || contentW === 0 || contentH === 0) return new Set<string>();
    const s = snapshot.scale;
    const ox = snapshot.tx;
    const oy = snapshot.ty;
    const showRest = s / homeScale >= LABEL_REVEAL_RATIO; // home-relative (web parity)
    // Row headroom gate: no passive labels (leading-frontier included) until
    // adjacent rows are far enough apart on SCREEN for a dial + two label lines.
    const roomy = minRowGap * s >= LABEL_ROOM_PX;
    const neigh = selectedKey ? neighboursByKey.get(selectedKey) : undefined;
    const belowOffset = dialScreenPx(s) / 2 + 4;
    const cands: LabelCandidate[] = [];
    for (const n of vms) {
      const isSel = n.nodeKey === selectedKey;
      const isNeigh = !!neigh && neigh.has(n.nodeKey);
      const isRest = !isSel && !isNeigh && !n.isLeadingFrontier;
      if (isRest && !showRest) continue;
      if (!isSel && !isNeigh && !roomy) continue;
      // The left rail (strand pills + domain headers) owns a screen-space
      // gutter; a PASSIVE label placed under a far-left node garbles into the
      // pills (seen on the first sim pass). Selected/neighbour labels still
      // win the gutter — they're the interaction's payload — but leading-
      // frontier/rest labels wait until the camera brings the node clear.
      const sxScreen = ((n.xPct / 100) * contentW) * s + ox;
      const halfW = Math.min((n.label?.length ?? 0) * LABEL_FONT * 0.55, LABEL_MAX_W) / 2;
      if (!isSel && !isNeigh && sxScreen - halfW < RAIL_GUTTER_PX) continue;
      const priority = isSel
        ? PRIO_SELECTED
        : isNeigh
          ? PRIO_NEIGHBOUR
          : n.isLeadingFrontier
            ? PRIO_LEADING
            : PRIO_REST;
      const x = (n.xPct / 100) * contentW;
      const y = (n.yPct / 100) * contentHY;
      const singleW = (n.label?.length ?? 0) * LABEL_FONT * 0.55;
      const lines = Math.max(1, Math.min(2, Math.ceil(singleW / LABEL_MAX_W)));
      const boxW = Math.min(singleW, LABEL_MAX_W) + 8;
      cands.push({
        id: n.nodeKey,
        // Labels are LEFT-aligned at the node's x (web parity). selectLabels
        // centers its collision box on sx, so shift the anchor by half the
        // width to make the box span [nodeX, nodeX + boxW].
        sx: x * s + ox + boxW / 2,
        sy: y * s + oy + belowOffset,
        priority,
        width: boxW,
        height: lines * LABEL_LINE_H + 8,
        above: false,
      });
    }
    return new Set(selectLabels(cands, { width: contentW, height: contentH, margin: 48 }, LABEL_CAP));
  }, [vms, snapshot, selectedKey, neighboursByKey, contentW, contentH, contentHY, minRowGap, homeScale]);

  // ── Rail items (port of MapTreeCanvas's useMemo: laneMeta / topLaneByDomain /
  //    laneYPcts) — one pill per lane; a domain header above each band's top lane. ──
  const railItems = useMemo(() => {
    if (!vms) return [] as {
      key: string;
      strand: string;
      rowY: number;
      domainHeader?: string;
      fogLabel?: string | null;
    }[];
    const laneMeta = new Map<
      number,
      { strand: string; domain: string | null; domainLabel: string }
    >();
    for (const n of vms) {
      if (!laneMeta.has(n.lane)) {
        laneMeta.set(n.lane, {
          strand: n.strand ?? "general",
          domain: n.domain,
          domainLabel: n.domainLabel ?? n.domain ?? "",
        });
      }
    }
    const lanes = [...laneMeta.keys()].sort((a, b) => a - b);
    const yByLane = laneYPcts(lanes.map((lane) => laneMeta.get(lane)!.domain));
    const domains = new Set<string>();
    for (const m of laneMeta.values()) if (m.domain) domains.add(m.domain);
    const multi = domains.size > 1;
    const topLaneByDomain = new Map<string, number>();
    for (const lane of lanes) {
      const d = laneMeta.get(lane)!.domain;
      if (d && !topLaneByDomain.has(d)) topLaneByDomain.set(d, lane);
    }
    return lanes.map((lane, i) => {
      const meta = laneMeta.get(lane)!;
      const isBandTop = meta.domain != null && topLaneByDomain.get(meta.domain) === lane;
      const fog = meta.domain ? domainFog?.[meta.domain] ?? null : null;
      return {
        key: `${lane}`,
        strand: titleCaseStrand(meta.strand),
        rowY: ((yByLane[i] ?? 50) / 100) * contentHY,
        domainHeader: multi && isBandTop ? meta.domainLabel || meta.domain || "" : undefined,
        // Fog label only paints once per band (its top lane) — matches web,
        // including on a single-domain map (no `multi` gate here).
        fogLabel: isBandTop ? domainFogLabel(fog) : null,
      };
    });
  }, [vms, contentHY, domainFog]);

  // Is there room for the STRAND tier of the rail? Measured from the rail's own
  // row positions (laneYPcts inserts extra gaps between domain bands, so the
  // nodes' minRowGap is a different number) at the settle zoom — the same
  // honest "does it actually fit on screen" measure the node labels use.
  const showStrands = useMemo(
    () =>
      railStrandsFit(
        railItems.map((r) => r.rowY * snapshot.scale).sort((a, b) => a - b),
        STRAND_ROOM_PX,
      ),
    [railItems, snapshot.scale],
  );

  const selectedNode = useMemo(
    () => (vms && selectedKey ? vms.find((v) => v.nodeKey === selectedKey) ?? null : null),
    [vms, selectedKey],
  );

  // Does the selected node's domain still need placement? The unified all-domains
  // tree surfaces nodes for domains the scholar hasn't been pre-tested in yet —
  // and a domain's ROOT node is always `frontier` (no prereqs) even with zero
  // mastery rows, so its mastery band alone can't tell us it's un-placed. Ask the
  // server per selected domain; the NodeSheet uses this to avoid routing a
  // "Practice this" tap into a surprise placement check-in.
  const selectedNeedsPlacement = useQuery(
    api.practiceSkills.needsPlacement,
    scholarId && selectedNode
      ? { scholarId, ...(selectedNode.domain ? { domain: selectedNode.domain } : {}) }
      : "skip",
  );
  // The canonical NodeDrawer response contains dependency, bridge, and story
  // semantics unavailable from the map's lightweight edge list. Reuse it for the
  // sheet rather than inventing a native graph projection.
  const selectedNeighbourhood = useQuery(
    api.nodeNeighbourhood.neighbourhood,
    scholarId && selectedNode ? { scholarId, nodeKey: selectedNode.nodeKey } : "skip",
  ) as NodeNeighbourhood | undefined;

  const belowOffset = dialScreenPx(snapshot.scale) / 2 + 4;
  const ready = !!vms && vms.length > 0 && contentW > 0 && contentH > 0;

  return (
    <View style={styles.root} onLayout={onLayout} accessibilityLabel="Skills tree map">
      <PaperBackground />

      {ready && (
        <>
          <GestureDetector gesture={gesture}>
            <View style={StyleSheet.absoluteFill}>
              <Animated.View
                style={[StyleSheet.absoluteFill, { transformOrigin: "0% 0%" }, canvasStyle]}
              >
                {crisp}
              </Animated.View>
            </View>
          </GestureDetector>

          {/* The canvas is gesture-driven and has no DOM focus targets. Keep one
              equivalent native button per node for VoiceOver and hardware-keyboard
              navigation without competing with touch pan/pinch on the map. */}
          <View style={styles.accessibilityList}>
            {vms!.map((node) => {
              const outOfScope =
                !!mathPlan &&
                !scopeAllowsStrand(mathPlan.practiceScope, node.domain ?? "", node.strand);
              return (
                <Pressable
                key={node.nodeKey}
                onPress={() => selectNode(node.nodeKey)}
                style={styles.accessibilityNode}
                accessibilityRole="button"
                accessibilityLabel={`${nodeAccessibilityLabel(node)}${
                  outOfScope ? ", outside today’s available practice" : ""
                }`}
                accessibilityHint={nodeAccessibilityHint(node)}
              />
              );
            })}
          </View>

          {/* Screen-space overlays — NOT camera-transformed; each item tracks the
              live pan/zoom via its own worklet transform (bounded element count). */}
          <View style={StyleSheet.absoluteFill} pointerEvents="none">
            {gradeRuler.map((tick) => (
              <GradeTag
                key={tick.grade}
                grade={tick.grade}
                contentX={(tick.xPct / 100) * contentW}
                tx={tx}
                scale={scale}
              />
            ))}
            {checkpoints
              .filter((cp) => cp.status !== "not_started")
              .map((cp) => (
                <CheckpointTag
                  key={cp.id}
                  marker={cp}
                  contentX={(cp.xPct / 100) * contentW}
                  contentY={(cp.yPct / 100) * contentHY}
                  tx={tx}
                  ty={ty}
                  scale={scale}
                />
              ))}
            {railItems
              // With the strand tier dropped, a lane with no domain header has
              // nothing left to draw — don't mount an empty tracker for it.
              .filter((r) => showStrands || r.domainHeader || r.fogLabel)
              .map((r) => (
                <RailItem
                  key={r.key}
                  strand={r.strand}
                  showStrand={showStrands}
                  domainHeader={r.domainHeader}
                  fogLabel={r.fogLabel}
                  rowY={r.rowY}
                  ty={ty}
                  scale={scale}
                />
              ))}
            {frontierLines.map((line) =>
              line.points.length > 0 ? (
                <FrontierTag
                  key={line.key}
                  line={line}
                  firstX={(line.points[0].xPct / 100) * contentW}
                  tx={tx}
                  scale={scale}
                />
              ) : null,
            )}
            {vms!
              .filter((n) => labelKeys.has(n.nodeKey))
              .map((n) => {
                const color =
                  n.nodeKey === selectedKey
                    ? LABEL_SELECTED
                    : selectedKey && neighboursByKey.get(selectedKey)?.has(n.nodeKey)
                      ? EDGE_LIT
                      : LABEL_REST;
                return (
                  <TreeLabel
                    key={n.nodeKey}
                    label={n.label}
                    frontier={n.frontier}
                    x={(n.xPct / 100) * contentW}
                    y={(n.yPct / 100) * contentHY}
                    offset={belowOffset}
                    color={color}
                    tx={tx}
                    ty={ty}
                    scale={scale}
                  />
                );
              })}
          </View>

          {/* Recenter — bottom-right text Pressable (mirrors sky.tsx ZoomControls). */}
          <View
            style={[styles.recenterWrap, { right: insets.right + 18, bottom: insets.bottom + 18 }]}
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
        </>
      )}

      {/* Loading — centered violet spinner. */}
      {!vms && (
        <View style={styles.center} pointerEvents="none">
          <ActivityIndicator size="large" color={palette.violet[300]} />
        </View>
      )}

      {/* Empty — kid-facing note on the paper background. */}
      {vms && vms.length === 0 && (
        <View style={styles.center} pointerEvents="none">
          <Text style={styles.empty}>
            No skills placed yet — this map fills in as you practice.
          </Text>
        </View>
      )}

      <NodeSheet
        node={selectedNode}
        domainNeedsPlacement={selectedNeedsPlacement}
        neighbourhood={selectedNeighbourhood}
        onDismiss={() => setSelectedKey(null)}
        onNavigate={selectNode}
      />
    </View>
  );
}

const PILL_BG = "rgba(255,255,255,0.86)";
const PILL_BORDER = "rgba(0,0,0,0.07)";

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: palette.white },
  center: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    alignItems: "center",
    justifyContent: "center",
    padding: 40,
  },
  empty: {
    color: palette.charcoal[400],
    fontSize: 18,
    lineHeight: 26,
    textAlign: "center",
    fontFamily: "HankenGrotesk_500Medium",
  },
  labelAnchor: { position: "absolute", left: 0, top: 0, width: 0, height: 0 },
  // Web parity (MapTreeCanvas onFrame): the label's LEFT edge sits at the
  // node's x — "first glyph under the dot" — text left-aligned, not centered.
  nodeLabel: {
    position: "absolute",
    left: 0,
    // FIXED width, not maxWidth: inside the zero-size anchor RN Text gets no
    // definite width to wrap against, so maxWidth ellipsizes long labels on
    // one line instead of wrapping to two (web line-clamps at 2).
    width: LABEL_BOX_W,
    fontSize: LABEL_FONT,
    lineHeight: LABEL_LINE_H,
    textAlign: "left",
  },
  // Rail — left-pinned pills, vertically camera-tracked.
  // Web parity (MapTreeCanvas rail): the DOMAIN header sits flush-left and its
  // strands indent 8px beneath it (typography-led nesting — no stripes/dots).
  railItem: { position: "absolute", left: 0, top: 0 },
  strandPillWrap: { marginLeft: 8, transform: [{ translateY: -14 }] },
  // width must be explicit: the rail item's own width collapses to the strand
  // pill, and an absolutely-positioned child inherits that narrow box — the
  // header text then wraps every few characters through the pills below
  // (seen on the first sim pass). numberOfLines={1} + a generous width keep
  // the ALL-CAPS header on one line floated above its band.
  // Floated into the gap above the band's first strand row (web:
  // bottom = 100% + 6px + 0.5em): strand pill top ≈ −14, header height ≈ 26,
  // 6px gap ⇒ header top ≈ −46. Flush-left (the strands indent under it).
  domainHeaderWrap: { position: "absolute", left: 0, width: 420 },
  domainHeaderAboveStrand: { transform: [{ translateY: -46 }] },
  // Same vertical centring as strandPillWrap — the header IS the row label once
  // the strand tier is dropped, so it sits on the row, not in a gap above it.
  domainHeaderOnRow: { transform: [{ translateY: -14 }] },
  pill: {
    alignSelf: "flex-start",
    backgroundColor: PILL_BG,
    borderTopRightRadius: 6,
    borderBottomRightRadius: 6,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: PILL_BORDER,
    paddingHorizontal: 6,
    paddingVertical: 3,
  },
  strandText: {
    fontSize: 13,
    fontFamily: "HankenGrotesk_600SemiBold",
    color: palette.charcoal[500],
    lineHeight: 18,
  },
  domainHeaderText: {
    fontSize: 15,
    fontFamily: "HankenGrotesk_700Bold",
    color: palette.charcoal[600],
    letterSpacing: 1,
    lineHeight: 20,
  },
  // The fog label (Surface 3) — lowercase, understated, never shouting louder
  // than the domain header it sits beside (mirrors MapTreeCanvas.tsx).
  fogLabelText: {
    fontSize: 10.5,
    fontFamily: "HankenGrotesk_500Medium",
    fontStyle: "italic",
    color: palette.charcoal[300],
    lineHeight: 15,
  },
  // Frontier line tags — small gold pills near the top.
  frontierTag: {
    position: "absolute",
    left: 0,
    top: 0,
    backgroundColor: "rgba(255,255,255,0.85)",
    borderRadius: 999,
    borderWidth: 1,
    borderColor: "rgba(217,154,0,0.4)",
    paddingHorizontal: 8,
    paddingVertical: 1,
  },
  frontierTagText: {
    color: FRONTIER_GOLD,
    fontSize: 13,
    fontFamily: "HankenGrotesk_700Bold",
  },
  // Grade ruler ticks — quiet, muted pills at the very top (above the
  // frontier tags): labels CONTENT (a grade band), never the scholar.
  gradeTag: {
    position: "absolute",
    left: 0,
    top: 0,
    backgroundColor: PILL_BG,
    borderRadius: 6,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: PILL_BORDER,
    paddingHorizontal: 5,
    paddingVertical: 1,
  },
  gradeTagText: {
    color: palette.charcoal[400],
    fontSize: 12,
    fontFamily: "HankenGrotesk_600SemiBold",
  },
  // Strand × grade checkpoint badges — a milestone flag mid-lane at the grade
  // boundary. Certified = filled gold ✓; in-progress = quiet outlined tally.
  // The pill styling (background/border/radius/padding) lives directly on
  // the <Text>, matching nodeLabel/labelAnchor: a zero-size anchor wrapping a
  // <Text> directly, where the TEXT ITSELF also needs `position: "absolute"`.
  // Root cause of the original bug (an empty gold dot, no visible/accessible
  // text at all): the anchor's default `alignItems: "stretch"` stretches any
  // IN-FLOW child to the anchor's own explicit width — 0 — collapsing the
  // Text (and any intermediate <View> pill wrapping it) to nothing. Giving
  // the Text `position: "absolute"` takes it out of that flex flow (exactly
  // how nodeLabel avoids the same trap), so it sizes from its own content
  // instead of stretching to 0. RN's <Text> supports the same box-model
  // props as <View>, so the pill background/border/radius fold directly onto
  // it with no intermediate <View> needed.
  checkpointAnchor: {
    position: "absolute",
    left: 0,
    top: 0,
    width: 0,
    height: 0,
  },
  checkpointTagText: {
    position: "absolute",
    left: 0,
    top: -9,
    fontSize: 11,
    fontFamily: "HankenGrotesk_700Bold",
    borderRadius: 999,
    borderWidth: 1,
    paddingHorizontal: 6,
    paddingVertical: 1,
  },
  checkpointTagTextCertified: {
    color: "#ffffff",
    backgroundColor: FRONTIER_GOLD,
    borderColor: "rgba(217,154,0,0.9)",
  },
  checkpointTagTextProgress: {
    color: FRONTIER_GOLD,
    backgroundColor: "rgba(255,255,255,0.9)",
    borderColor: "rgba(217,154,0,0.45)",
  },
  recenterWrap: { position: "absolute" },
  accessibilityList: {
    position: "absolute",
    left: -10_000,
    top: 0,
  },
  accessibilityNode: { width: 1, height: 1 },
  recenterText: {
    color: palette.violet[300],
    fontSize: 17,
    fontFamily: "HankenGrotesk_600SemiBold",
  },
});
