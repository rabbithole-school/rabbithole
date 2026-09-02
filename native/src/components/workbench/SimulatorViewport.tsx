/**
 * The tactile centerpiece (plan §12, §7.5) — the world viewport, CENTER-STAGE.
 * A react-native-svg scene under a reanimated camera driven entirely on the UI
 * thread, following the `sky.tsx` playbook (the memo mandates it):
 *
 *  · Camera = shared values (camScale/camX/camY); pan + pinch update them on the
 *    UI thread. Gesture composition is `Simultaneous(Race(tap, Simultaneous(pan,
 *    pinch)))` so tap-to-select never competes with pan/pinch (sky L1777).
 *  · JS-side hit-testing: a tap runs on the JS thread, INVERSE-PROJECTS the
 *    touch point through the shared isometric helper, finds the frontmost
 *    depth-sorted automaton whose cell center is within reach of that logical
 *    point, selects it, and fires a feather-light selection haptic (§7.5)
 *    before the InspectorSheet slides up.
 *  · Viewport culling + a motion budget (a hard cap on concurrently-animated
 *    automata) + a zoom-bucket (with hysteresis) label gate keep the calm floor.
 *
 * ISOMETRIC IS THE ONLY VIEW (2026-08-12 founder decision, DISPATCH2.md — LANE
 * ISO). There is no flat-grid mode and no toggle. This renderer, the web
 * renderer (`components/workbench/SimulatorViewport.tsx`), and the vendored
 * projection helper (`native/vendor/simulator/isometricProjection.ts`, mirroring
 * `lib/simulator/isometricProjection.ts`) share one projection: square-grid
 * (x, y) → isometric screen space, CHESS-CENTERED (a cell's sprite sits at its
 * tile CENTER, never a grid intersection).
 *
 * §7.5 feel bar: automata bob at a STABLE-IDENTITY phase offset in a NESTED layer
 * that composes OVER the recorded position without displacing it (the bob can
 * never move an automaton off its true `x/y`); they ease along their real recorded
 * path between ticks; a corpse settles dim and still (dignified death); an invalid
 * action reads as a small stall; water shimmers and algae sways faintly. All of it
 * is disabled under the OS reduce-motion setting (the accessibility floor).
 *
 * Replay honesty (review Finding 2): the viewport draws the live-head scene ONLY
 * when the caller says we ARE at the head; while a scrubbed frame loads or fails
 * it holds the last honest frame and labels the requested day — it never paints
 * the live head under a past-day label.
 *
 * A NOTE ON THREADS (read before touching camera math): reanimated worklets
 * (the `.onUpdate`/`.onBegin` gesture callbacks and `useAnimatedStyle`) run on
 * the UI thread and can only call functions that were themselves compiled as
 * worklets. The vendored `isometricProjection.ts` helper is plain, un-annotated
 * JS and is out of this file's scope to edit, so its functions cannot be
 * called directly from inside a UI-thread worklet. Every call to the vendored
 * projection/fit/inverse-projection helpers below therefore happens on the JS
 * thread (component body, effects, and `hitTest`, which is itself invoked via
 * `runOnJS`), and the results — plain pixel numbers and the `fit` object's
 * numeric fields — are captured by ordinary closure into the worklets that
 * need them each render (the same pattern this file already used for
 * `offsetX`/`offsetY`/`cell` before this change). The one exception is the
 * camera CLAMP, which must run continuously while a pan/pinch worklet is live
 * on the UI thread; `clampCam` below inlines the same two-axis formula as the
 * vendored `clampIsometricCamera`, reading `fit.contentBounds` as captured
 * plain numbers rather than calling the vendored function itself.
 */

import {
  useCallback,
  useEffect,
  useEffectEvent,
  useMemo,
  useReducer,
  useState,
} from "react";
import {
  LayoutChangeEvent,
  Pressable,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
} from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import Svg, {
  Circle,
  Ellipse,
  G,
  Image as SvgImage,
  Line,
  Path,
  Polygon,
  Text as SvgText,
} from "react-native-svg";
import Animated, {
  cancelAnimation,
  Easing,
  runOnJS,
  useAnimatedReaction,
  useAnimatedProps,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withDelay,
  withRepeat,
  withSequence,
  withTiming,
  type SharedValue,
} from "react-native-reanimated";
import * as Haptics from "expo-haptics";

import { fonts, useColors } from "@/theme";
import type { SimulatorSceneEntityV1, SimulatorSceneV1, SimulatorSpec } from "../../../vendor/simulator/contract";
import {
  projectEcosystemSense,
  type EcosystemInspectableSenseId,
} from "../../../vendor/simulator/ecosystemPerception";
import {
  ECOSYSTEM_SENSE_CONFIRMATION_HORIZON_TICKS,
  type EcosystemSenseEvidenceRequest,
} from "../../../vendor/simulator/scene";
import { getWorkbenchRendererFamily } from "../../../vendor/simulator/templates/registry";
import {
  DEFAULT_ISOMETRIC_GEOMETRY,
  fitIsometricCamera,
  fittedIsometricPoint,
  isometricCellCenter,
  isometricTileDiamond,
  MAX_ISO_ZOOM,
  MIN_ISO_ZOOM,
  sortIsometricDepth,
  unprojectIsometricScreen,
  type IsoFit,
} from "../../../vendor/simulator/isometricProjection";
import type { SceneFrame, SceneResult } from "./useWorkbenchScene";
import type { SimulatorRun } from "./useWorkbenchData";
import {
  AMBIENT_BOB_CYCLE_MS,
  AMBIENT_BOB_HALF_CYCLE_MS,
  AMBIENT_BOB_PX,
  formatMetric,
  isPoolEntityKind,
  isRoundTokenEntityKind,
  metricLabel,
  phaseFromId,
  runCriterionScore,
  tokenBadgeGlyph,
} from "./helpers";
import {
  ECOSYSTEM_LANDSCAPE_BANDS,
  ecosystemLandscapeVisualPaths,
  generateEcosystemLandscape,
} from "../../../vendor/simulator/ecosystemLandscape";
import {
  ecosystemBiome,
  ecosystemCurrentScreenVector,
  ecosystemPhysicsTerrainPositionSet,
  ecosystemTerrainKindHasPhysics,
  ecosystemTerrainSurfaceColor,
} from "../../../vendor/simulator/ecosystemTerrainTiles";
import { TickScrubber } from "./TickScrubber";
import { WorkbenchProofRenderer } from "./WorkbenchProofRenderer";
import { MetricStrip } from "./MetricStrip";

const AnimatedPath = Animated.createAnimatedComponent(Path);
const AnimatedPolygon = Animated.createAnimatedComponent(Polygon);

const CULL_MARGIN = 0.6; // fraction of the viewport padded around it (sky discipline)
const LABEL_ZOOM_ON = 2.2; // detail fades in past this bucket…
const LABEL_ZOOM_OFF = 1.9; // …and back out below this — a hysteresis band (sky).
const LABEL_CAP = 12; // max simultaneously-visible labels (sky's LABEL_CAP discipline)
const MOTION_BUDGET = 16; // max concurrently-BOBBING automata (the calm floor, §7.5)
const MOVE_MS = 400;
const MOVE_EASING = Easing.inOut(Easing.cubic);
const CORPSE_DIM = 0.4;
// Logical-grid-unit hit radius for tap resolution — scale-invariant because the
// pointer is inverse-projected into LOGICAL coordinates before the distance
// check, so it doesn't need a pixel floor the way the old flat radius did.
const HIT_RADIUS_LOGICAL = 0.6;

const GEOMETRY = DEFAULT_ISOMETRIC_GEOMETRY;

type SelectionRequest = { id: string; at: number };
type ContentInsets = { top: number; right: number; bottom: number; left: number };

// Reducer actions are serialized even when the simultaneous tap + long-press
// callbacks cross from the UI thread before React commits the first one.
function reduceSelectionRequest(
  previous: SelectionRequest | null,
  next: SelectionRequest,
): SelectionRequest | null {
  return previous?.id === next.id && next.at - previous.at < 500 ? previous : next;
}

// ── Algae as DISCRETE, kid-legible units (not a continuous green wash) ────────
// The ecosystemGrid template caps a cell's resource biomass at RESOURCE_CAPACITY
// (= 10) and the scene frame exposes it as `intensity = biomass / 10` (0…1). We
// bucket that into a discrete 0–3 so a child reads quantity by COUNTING charm
// sprites ("3 → 2 → 1 → none"), not by decoding a shade of green. Full cell = 3.
// Web ↔ native parity: identical thresholds + top-left corner cluster.
export const ALGAE_ICON_LABEL = "algae";
// Corner cluster (top-left, in cell fractions) — small enough to never occlude
// a character centered in the cell; one pip per level.
const ALGAE_PIP_OFFSETS = [
  { x: 0.18, y: 0.18 },
  { x: 0.4, y: 0.18 },
  { x: 0.18, y: 0.4 },
] as const;
function algaeLevel(intensity: number): number {
  const clamped = Math.min(1, Math.max(0, intensity));
  if (clamped <= 0) return 0;
  // (0, 1/3] → 1 · (1/3, 2/3] → 2 · (2/3, 1] → 3 (biomass 0–3.33 · 3.33–6.67 · 6.67–10)
  return Math.min(3, Math.ceil(clamped * 3));
}

/** Pixel base position (identity camera) for a cell's chess-style TILE CENTER —
 *  the single call site both AutomatonNode and the hit-tester use, so "center
 *  of the tile" is defined exactly once. */
function cellCenterPixel(x: number, y: number, fit: IsoFit): { x: number; y: number } {
  return fittedIsometricPoint(isometricCellCenter({ x, y }, GEOMETRY), fit);
}

function AutomatonNode({
  entity,
  fit,
  cellPixel,
  camX,
  camY,
  camScale,
  icon,
  selected,
  pressed,
  invalid,
  showLabel,
  animate,
  reduceMotion,
  onSelect,
}: {
  entity: SimulatorSceneEntityV1;
  fit: IsoFit;
  /** The tile's on-screen HEIGHT in pixels at the identity camera — the native
   *  analogue of the old flat grid's "cell" size, used only to size sprites
   *  (never to position them; position comes from the projection). */
  cellPixel: number;
  camX: SharedValue<number>;
  camY: SharedValue<number>;
  camScale: SharedValue<number>;
  icon: string | undefined;
  selected: boolean;
  pressed: boolean;
  invalid: boolean;
  showLabel: boolean;
  animate: boolean;
  reduceMotion: boolean;
  onSelect: () => void;
}) {
  const colors = useColors();
  const isAutomaton = entity.kind === "automaton";
  const isCorpse = entity.kind === "corpse";
  const isToken = isRoundTokenEntityKind(entity.kind);
  const isPool = isPoolEntityKind(entity.kind);
  const isUnknownKind = !isAutomaton && !isCorpse && !isToken && !isPool;

  // Eased real-path movement in PIXEL space (identity-camera projected + fitted
  // tile center — chess-style, never a grid intersection). The live camera
  // (camX/camY/camScale) is applied on top in `positioned` below, so panning
  // and zooming never re-trigger this tween. Under reduce-motion the position
  // snaps (no glide) but is still TRUE.
  const initial = cellCenterPixel(entity.x, entity.y, fit);
  const ex = useSharedValue(initial.x);
  const ey = useSharedValue(initial.y);
  useEffect(() => {
    const target = cellCenterPixel(entity.x, entity.y, fit);
    if (reduceMotion) {
      ex.set(target.x);
      ey.set(target.y);
    } else {
      ex.set(withTiming(target.x, { duration: MOVE_MS, easing: MOVE_EASING }));
      ey.set(withTiming(target.y, { duration: MOVE_MS, easing: MOVE_EASING }));
    }
  }, [entity.x, entity.y, fit, reduceMotion, ex, ey]);

  // Ambient bob — a NESTED inner layer (translateY only), so it composes OVER the
  // recorded position without ever displacing the true x/y (Finding 1 law). Phase
  // is derived from STABLE identity (not position), so the rhythm doesn't restart
  // when the automaton moves (Finding 4). Only the living bob, and only within the
  // motion budget; corpses and reduce-motion stay still.
  const bob = useSharedValue(0);
  useEffect(() => {
    if (!isAutomaton || !animate || reduceMotion) {
      cancelAnimation(bob);
      bob.set(0);
      return;
    }
    const delayMs = phaseFromId(entity.id) * AMBIENT_BOB_CYCLE_MS;
    bob.set(withDelay(
      delayMs,
      withRepeat(
        withSequence(
          withTiming(-AMBIENT_BOB_PX, { duration: AMBIENT_BOB_HALF_CYCLE_MS, easing: Easing.inOut(Easing.sin) }),
          withTiming(0, { duration: AMBIENT_BOB_HALF_CYCLE_MS, easing: Easing.inOut(Easing.sin) }),
        ),
        -1,
        false,
      ),
    ));
    return () => cancelAnimation(bob);
  }, [isAutomaton, animate, reduceMotion, entity.id, bob]);

  // Invalid action → a small visible stall: a quick, low-amplitude sideways shake
  // (encodes the "the automaton tried something the world refused" fact, §7.5).
  const stall = useSharedValue(0);
  useEffect(() => {
    if (!invalid || reduceMotion) {
      stall.set(0);
      return;
    }
    stall.set(withSequence(
      withTiming(-1.4, { duration: 90 }),
      withTiming(1.4, { duration: 90 }),
      withTiming(0, { duration: 90 }),
    ));
  }, [invalid, reduceMotion, stall]);

  // Birth unfurl (opacity + gentle scale pop); a corpse instead SETTLES: it fades
  // to a dim, smaller, still form — dignified, quick, never celebrated (§7.5).
  const life = useSharedValue(isCorpse ? 1 : 0);
  useEffect(() => {
    if (reduceMotion) {
      life.set(1);
    } else {
      life.set(withTiming(1, { duration: isCorpse ? 520 : 340, easing: Easing.out(Easing.cubic) }));
    }
  }, [isCorpse, reduceMotion, life]);

  // Touch-down feedback (nit 7a): a quick eased scale-up + faint opacity dip
  // while the finger rests on this automaton, resolved on the UI thread BEFORE
  // selection commits (the §7.5 "never instant" discipline). Snaps only under
  // reduce-motion.
  const press = useSharedValue(0);
  useEffect(() => {
    if (reduceMotion) {
      press.set(pressed ? 1 : 0);
      return;
    }
    press.set(withTiming(pressed ? 1 : 0, {
      duration: pressed ? 90 : 160,
      easing: Easing.out(Easing.quad),
    }));
  }, [pressed, reduceMotion, press]);

  const size = entity.size ?? 0.7;
  const r = (size * cellPixel) / 2;
  // The selection/invalid ring overflows the icon box; a padded overlay Svg
  // (below) gets this much room on every side so its stroke is never clipped.
  const ringPad = cellPixel * 0.24;

  // Heading rotates/flips the SPRITE only (never the selection/energy rings, and
  // never the recorded position) — mirrors the web renderer exactly.
  const heading = entity.heading ?? 0;
  const normalizedHeading = ((heading % 360) + 360) % 360;
  const flip = normalizedHeading > 90 && normalizedHeading < 270 ? -1 : 1;
  const iconCenter = cellPixel / 2;
  const iconTransform =
    `translate(${iconCenter} ${iconCenter}) rotate(${heading}) scale(${flip} 1) translate(${-iconCenter} ${-iconCenter})`;

  // Outer layer: camera + recorded (chess-centered) position + scale + opacity.
  // This is the TRUE placement; nothing here is decorative.
  const positioned = useAnimatedStyle(() => {
    const sx = camX.get() + camScale.get() * ex.get();
    const sy = camY.get() + camScale.get() * ey.get();
    const birthScale = isCorpse ? 1 - 0.25 * life.get() : 0.62 + 0.38 * life.get();
    const opacity = isCorpse
      ? 1 - (1 - CORPSE_DIM) * life.get()
      : (entity.hidden ? CORPSE_DIM : 1) * life.get();
    return {
      transform: [
        { translateX: sx - cellPixel / 2 },
        { translateY: sy - cellPixel / 2 },
        { scale: camScale.get() * birthScale },
      ],
      opacity,
    };
  });

  // Inner layer: additive ambient bob + invalid stall. Cannot move the automaton
  // off its recorded cell — it only rides ON TOP of `positioned`.
  const ambient = useAnimatedStyle(() => ({
    transform: [
      { translateY: bob.get() },
      { translateX: stall.get() },
      { scale: 1 + press.get() * 0.09 },
    ],
    opacity: 1 - press.get() * 0.12,
  }));

  const fill = entity.color ?? (isAutomaton ? colors.cyan : "#78716C");

  const isInspectable = isAutomaton || (isCorpse && entity.automatonId !== undefined);
  const a11yLabel = isCorpse
    ? `last decision at cell ${entity.x}, ${entity.y}`
    : `${entity.label ?? "automaton"} at ${entity.x}, ${entity.y}` +
      (entity.energy !== undefined ? `, energy ${formatMetric(entity.energy)}` : "") +
      (invalid ? ", invalid action this day" : "");

  return (
    <Animated.View
      pointerEvents="none"
      accessible={isInspectable}
      accessibilityRole={isInspectable ? "button" : "none"}
      accessibilityLabel={isInspectable ? a11yLabel : undefined}
      accessibilityState={isInspectable ? { selected } : undefined}
      onAccessibilityTap={isInspectable ? onSelect : undefined}
      style={[styles.anchor, { width: cellPixel, height: cellPixel }, positioned]}
    >
      <Animated.View style={ambient}>
        {/* Selection / invalid rings live in their OWN oversized, absolutely
            positioned Svg so the stroke is never clipped by the icon Svg's
            drawable bounds (nit 2: an edge automaton's ring was cut off). It's
            centered on the icon and painted UNDER it (document order), so the
            visual stacking is unchanged. */}
        {(selected || (invalid && isAutomaton)) && ringPad > 0 ? (
          <Svg
            pointerEvents="none"
            width={cellPixel + ringPad * 2}
            height={cellPixel + ringPad * 2}
            style={[styles.ringOverlay, { left: -ringPad, top: -ringPad }]}
          >
            {selected ? (
              <Circle
                cx={cellPixel / 2 + ringPad}
                cy={cellPixel / 2 + ringPad}
                r={r + cellPixel * 0.16}
                fill="none"
                stroke="#7C3AED"
                strokeWidth={cellPixel * 0.07}
              />
            ) : null}
            {invalid && isAutomaton ? (
              <Circle
                cx={cellPixel / 2 + ringPad}
                cy={cellPixel / 2 + ringPad}
                r={r + cellPixel * 0.1}
                fill="none"
                stroke="#C2410C"
                strokeWidth={cellPixel * 0.05}
                strokeOpacity={0.8}
              />
            ) : null}
          </Svg>
        ) : null}
        <Svg width={cellPixel} height={cellPixel}>
          <Ellipse
            cx={cellPixel / 2}
            cy={cellPixel / 2 + r * 0.55}
            rx={r * 0.72}
            ry={r * 0.24}
            fill="#032337"
            fillOpacity={0.32}
          />
          {/* Energy ring — drawn whenever the scene reports energy at all,
              never inferred; distinct color for depleted vs. positive. */}
          {entity.energy !== undefined ? (
            <Circle
              cx={cellPixel / 2}
              cy={cellPixel / 2}
              r={r + cellPixel * 0.09}
              fill="none"
              stroke={entity.energy > 0 ? "#FACC15" : "#94A3B8"}
              strokeWidth={cellPixel * 0.045}
              strokeOpacity={0.85}
            />
          ) : null}
          <G transform={iconTransform}>
            {icon && isAutomaton ? (
              <>
                <Circle cx={cellPixel / 2} cy={cellPixel / 2} r={r} fill={fill} fillOpacity={0.25} />
                <SvgImage
                  href={{ uri: icon }}
                  x={cellPixel / 2 - r}
                  y={cellPixel / 2 - r}
                  width={r * 2}
                  height={r * 2}
                  preserveAspectRatio="xMidYMid meet"
                />
              </>
            ) : isUnknownKind ? (
              // Unknown entity kind (a future template's own kind) — a small
              // neutral diamond marker rather than a crash or a blank cell.
              <Polygon
                points={`${cellPixel / 2},${cellPixel / 2 - r * 0.65} ${cellPixel / 2 + r * 0.65},${cellPixel / 2} ${cellPixel / 2},${cellPixel / 2 + r * 0.65} ${cellPixel / 2 - r * 0.65},${cellPixel / 2}`}
                fill={entity.color ?? "#64748B"}
                stroke="#E2E8F0"
                strokeWidth={cellPixel * 0.035}
              />
            ) : isToken || isPool ? null : (
              <Circle cx={cellPixel / 2} cy={cellPixel / 2} r={r} fill={fill} />
            )}
          </G>
          {/* Round-token badges (prisonersDilemma/matrixGame/publicGoods'
              "token:<actionId>" convention) — a small coin-like chip in the
              token's own semantic color, with its authored action label's
              first letter for at-a-glance legibility. Never rotated by
              heading (tokens don't set one). */}
          {isToken ? (
            <>
              <Circle
                cx={cellPixel / 2}
                cy={cellPixel / 2}
                r={r}
                fill={entity.color ?? "#64748B"}
                stroke="#F8FAFC"
                strokeWidth={cellPixel * 0.03}
              />
              <Circle
                cx={cellPixel / 2}
                cy={cellPixel / 2}
                r={r * 0.72}
                fill="none"
                stroke="#F8FAFC"
                strokeWidth={cellPixel * 0.02}
                strokeOpacity={0.55}
              />
              <SvgText
                x={cellPixel / 2}
                y={cellPixel / 2}
                textAnchor="middle"
                alignmentBaseline="middle"
                fontSize={r * 1.15}
                fontWeight="700"
                fill="#F8FAFC"
              >
                {tokenBadgeGlyph(entity.label)}
              </SvgText>
            </>
          ) : null}
          {/* publicGoods's shared pool entity — a real pot/pool graphic (not
              the generic unknown-kind diamond): a basin with a soft
              highlight and a warm glint standing in for the village's
              shared resource; `size` already tracks the round's normalized
              pool. */}
          {isPool ? (
            <>
              <Circle cx={cellPixel / 2} cy={cellPixel / 2} r={r} fill={entity.color ?? "#0369A1"} />
              <Circle
                cx={cellPixel / 2}
                cy={cellPixel / 2}
                r={r}
                fill="none"
                stroke="#082F49"
                strokeWidth={cellPixel * 0.05}
                strokeOpacity={0.6}
              />
              <Ellipse
                cx={cellPixel / 2 - r * 0.28}
                cy={cellPixel / 2 - r * 0.32}
                rx={r * 0.4}
                ry={r * 0.24}
                fill="#7DD3FC"
                fillOpacity={0.55}
              />
              <Circle cx={cellPixel / 2} cy={cellPixel / 2} r={r * 0.32} fill="#FDE68A" fillOpacity={0.9} />
            </>
          ) : null}
        </Svg>
        {showLabel && isAutomaton && entity.label ? (
          <Text numberOfLines={1} style={[styles.nodeLabel, { color: colors.fg }]}>
            {entity.label}
          </Text>
        ) : null}
      </Animated.View>
    </Animated.View>
  );
}

type EcosystemCertaintyCell = { x: number; y: number; opacity: number };

/** Each mark is replay-confirmed pre-action evidence, rather than a current-world guess. */
function ecosystemCertaintyCells(
  frame: SceneFrame | null,
  actorId: string | null,
  senseId: EcosystemInspectableSenseId | "world",
): EcosystemCertaintyCell[] {
  if (!frame || !actorId || senseId === "world") return [];
  const confirmations = (frame.ecosystemSenseConfirmations ?? []).filter(
    (confirmation) => confirmation.actorId === actorId && confirmation.senseId === senseId,
  );
  if (confirmations.length === 0) return [];
  const currentDecisionTick = Math.max(0, frame.tick - 1);
  const latestByCell = new Map<string, number>();
  for (const confirmation of confirmations) {
    for (const cell of confirmation.cells) {
      const key = `${cell.x}:${cell.y}`;
      latestByCell.set(key, Math.max(latestByCell.get(key) ?? -Infinity, confirmation.tick));
    }
  }
  return [...latestByCell].flatMap(([key, lastConfirmedTick]) => {
    const age = currentDecisionTick - lastConfirmedTick;
    if (age > ECOSYSTEM_SENSE_CONFIRMATION_HORIZON_TICKS) return [];
    const [x, y] = key.split(":").map(Number);
    return [{ x, y, opacity: 0.32 * 0.5 ** age }];
  });
}

type SimulatorViewportProps = {
  spec: SimulatorSpec;
  scene: SceneResult;
  frame: SceneFrame | null;
  liveScene: SimulatorSceneV1 | null;
  runId: string | null;
  run: SimulatorRun | null;
  tick: number;
  maxTick: number;
  moreComing: boolean;
  playing: boolean;
  onScrub: (tick: number) => void;
  onTogglePlay: () => void;
  onSelectAutomaton: (id: string) => void;
  selectedAutomatonId: string | null;
  speciesIcons: Record<string, string | undefined>;
  runLabel: string;
  personalDelta: string | null;
  showTransport?: boolean;
  contentInsets?: ContentInsets;
  onSenseEvidenceDemand?: (request: EcosystemSenseEvidenceRequest | undefined) => void;
};

function FieldViewport({
  spec,
  scene: sceneResult,
  frame,
  liveScene,
  runId,
  run,
  tick,
  maxTick,
  moreComing,
  playing,
  onScrub,
  onTogglePlay,
  onSelectAutomaton,
  selectedAutomatonId,
  speciesIcons,
  runLabel,
  personalDelta,
  showTransport = true,
  contentInsets,
  onSenseEvidenceDemand,
}: SimulatorViewportProps) {
  // The field renderer's body intentionally remains unchanged below. Match and
  // commons templates dispatch before this component, so game evidence never
  // enters the isometric camera, culling, or gesture stage.
  const colors = useColors();
  const reduceMotion = useReducedMotion();
  const { width: winW } = useWindowDimensions();
  const [requestedSense, setRequestedSense] = useState<
    "world" | EcosystemInspectableSenseId
  >("world");

  // ── Honest replay display (Finding 2) ────────────────────────────────────────
  // Keep the last honest frame FOR THIS RUN. When a scrubbed frame is loading or
  // failed we hold that, and never fall back to the live head under a past label.
  // This is COMMITTED state written from an effect, not a ref written during
  // render. `held` feeds `scene`, and `scene` feeds every derived value below
  // (grid extent, cell fit, centering, culling, algae, automata), so a ref read
  // here propagated a non-reactive value through the whole subtree: under the
  // React Compiler that output can be reused while the cache has moved on, and a
  // render React abandons could seed the cache with a frame the scholar never
  // saw — the exact dishonesty this block exists to prevent. Playback advances
  // one day per DAY_ADVANCE_MS (600ms), so the extra commit is not a hot path.
  const [lastGood, setLastGood] = useState<{ runId: string; scene: SimulatorSceneV1 } | null>(null);
  useEffect(() => {
    if (sceneResult.status === "ready" && frame) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- Retain only a committed ready frame so transient recomposition never blanks the viewport.
      setLastGood({ runId: runId ?? "", scene: frame.scene });
    }

  }, [sceneResult.status, frame, runId]);
  const held = lastGood && lastGood.runId === (runId ?? "") ? lastGood.scene : null;

  let scene: SimulatorSceneV1 | null;
  let staleNotice: string | null = null;
  if (sceneResult.status === "ready" && frame) {
    scene = frame.scene;
  } else if (sceneResult.status === "live") {
    scene = liveScene;
  } else {
    // loading / error while scrubbing — hold the last honest frame, label the day.
    scene = held;
    staleNotice =
      sceneResult.status === "error"
        ? `couldn't replay day ${sceneResult.tick}`
        : `loading day ${sceneResult.tick}…`;
  }

  const [layout, setLayout] = useState<Layout>({ w: winW, h: 0 });
  const onLayout = useCallback((e: LayoutChangeEvent) => {
    const { width, height } = e.nativeEvent.layout;
    setLayout((prev) => (prev.w === width && prev.h === height ? prev : { w: width, h: height }));
  }, []);

  // Only grid templates carry width/height in config; non-grid worlds
  // (prisoner's dilemma) rely on the scene's own viewport, falling back to a
  // unit square before frames arrive.
  const contentW =
    scene?.viewport.width ?? ("width" in spec.config ? spec.config.width : 1);
  const contentH =
    scene?.viewport.height ?? ("height" in spec.config ? spec.config.height : 1);

  // ── The isometric fit (memoized terrain/tile data lives downstream of this) ──
  // `fitIsometricCamera` is the SAME vendored fit/clamp helper the web renderer
  // uses; it maps the projected grid's world bounds into the measured pixel
  // region (padded so a selected automaton's ring never clips the stage edge —
  // the native analogue of the old flat grid's 30%-of-a-cell inset).
  const contentRect = useMemo(() => {
    const insets = contentInsets ?? { top: 0, right: 0, bottom: 0, left: 0 };
    return {
      x: Math.max(0, insets.left),
      y: Math.max(0, insets.top),
      width: Math.max(1, layout.w - Math.max(0, insets.left) - Math.max(0, insets.right)),
      height: Math.max(1, layout.h - Math.max(0, insets.top) - Math.max(0, insets.bottom)),
    };
  }, [contentInsets, layout.w, layout.h]);

  const fit = useMemo<IsoFit | null>(() => {
    if (layout.w <= 0 || layout.h <= 0 || contentW <= 0 || contentH <= 0) return null;
    const padding = Math.max(20, Math.min(contentRect.width, contentRect.height) * 0.1);
    const localFit = fitIsometricCamera(
      { width: contentW, height: contentH },
      { width: contentRect.width, height: contentRect.height },
      padding,
    );
    return {
      ...localFit,
      offsetX: localFit.offsetX + contentRect.x,
      offsetY: localFit.offsetY + contentRect.y,
      contentBounds: {
        ...localFit.contentBounds,
        minX: localFit.contentBounds.minX + contentRect.x,
        maxX: localFit.contentBounds.maxX + contentRect.x,
        minY: localFit.contentBounds.minY + contentRect.y,
        maxY: localFit.contentBounds.maxY + contentRect.y,
      },
    };
  }, [layout.w, layout.h, contentW, contentH, contentRect]);

  // The tile's on-screen HEIGHT in pixels at the identity camera — the native
  // sizing analogue of the old flat grid's "cell" (used only to size sprites;
  // position always comes from the projection, never this value).
  const cellPixel = fit ? GEOMETRY.tileHeight * fit.scale : 0;

  // Camera — UI-thread shared values.
  const camScale = useSharedValue(1);
  const camX = useSharedValue(0);
  const camY = useSharedValue(0);
  const startX = useSharedValue(0);
  const startY = useSharedValue(0);
  const startScale = useSharedValue(1);
  const anchorX = useSharedValue(0);
  const anchorY = useSharedValue(0);
  const isPinching = useSharedValue(false);
  const reliefShadowStrokeProps = useAnimatedProps(() => ({
    strokeWidth: 2.35 / Math.max(camScale.get(), 0.001),
  }));
  const markStrokeProps = useAnimatedProps(() => ({
    strokeWidth: 1.25 / Math.max(camScale.get(), 0.001),
  }));
  const ridgeMarkStrokeProps = useAnimatedProps(() => ({
    strokeWidth: 1.55 / Math.max(camScale.get(), 0.001),
  }));
  const physicsStrokeProps = useAnimatedProps(() => ({
    strokeWidth: 1.6 / Math.max(camScale.get(), 0.001),
  }));

  // A settle-time camera snapshot for JS-side culling + hit-testing (the camera
  // itself keeps moving on the UI thread; culling re-runs at rest, sky-style).
  const [camSnap, setCamSnap] = useState({ scale: 1, x: 0, y: 0 });
  const commitSnap = useCallback((scale: number, x: number, y: number) => {
    setCamSnap((prev) => (prev.scale === scale && prev.x === x && prev.y === y ? prev : { scale, x, y }));
  }, []);

  // The automaton currently under the finger (touch-down feedback, nit 7a).
  const [pressedId, setPressedId] = useState<string | null>(null);

  // Zoom-bucket label gate with a hysteresis band (no per-pixel flicker).
  const [showLabels, setShowLabels] = useState(false);
  const showLabelsSV = useSharedValue(false);
  useAnimatedReaction(
    () => camScale.get(),
    (s) => {
      const next = showLabelsSV.get() ? s > LABEL_ZOOM_OFF : s > LABEL_ZOOM_ON;
      if (next !== showLabelsSV.get()) {
        showLabelsSV.set(next);
        runOnJS(setShowLabels)(next);
      }
    },
  );

  const entities = useMemo(() => scene?.entities ?? [], [scene]);
  // The shared algae charm (warmed once by SpeciesIconResolvers under the
  // `world:ecosystemgrid:algae` key); undefined until it resolves → plain dot.
  const biome = ecosystemBiome(
    spec.templateId === "ecosystemGrid" ? spec.config.biome : undefined,
  );
  const landscapeConfig =
    spec.templateId === "ecosystemGrid" &&
    spec.config.width === contentW &&
    spec.config.height === contentH
      ? spec.config.landscape
      : undefined;
  const physicsTerrainConfig =
    spec.templateId === "ecosystemGrid" ? spec.config.terrain : undefined;
  const resourceIcon = biome.resource.iconLabel
    ? speciesIcons[biome.resource.iconLabel]
    : undefined;

  // Invalid-this-tick automaton ids, from the persisted tick record (frame).
  const invalidIds = useMemo(() => {
    const set = new Set<string>();
    for (const a of frame?.automata ?? []) if (a.invalid) set.add(a.id);
    return set;
  }, [frame]);

  // Cull to the padded viewport (in isometric-projected pixel space, at the last
  // settled camera) — the isometric remap of the old flat bounding-box test.
  const visible = useMemo(() => {
    if (!fit) return entities;
    const mL = layout.w * CULL_MARGIN;
    const mT = layout.h * CULL_MARGIN;
    return entities.filter((entity) => {
      const projected = fittedIsometricPoint(
        isometricCellCenter({ x: entity.x, y: entity.y }, GEOMETRY),
        fit,
      );
      const sx = camSnap.x + camSnap.scale * projected.x;
      const sy = camSnap.y + camSnap.scale * projected.y;
      return sx >= -mL && sx <= layout.w + mL && sy >= -mT && sy <= layout.h + mT;
    });
  }, [entities, fit, layout, camSnap]);

  // Painter's-order depth sort (the isometric equivalent of the old flat
  // grid's implicit "later in the array draws on top" — here it must be
  // EXPLICIT, since adjacent tiles genuinely overlap in projected space).
  const depthSortedVisible = useMemo(() => sortIsometricDepth(visible), [visible]);

  // Motion budget + label cap: only the first N visible AUTOMATA bob / carry a
  // label (stable by id so the chosen set doesn't churn each frame).
  const animateIds = useMemo(() => {
    const set = new Set<string>();
    let count = 0;
    for (const e of depthSortedVisible) {
      if (e.kind !== "automaton") continue;
      if (count < MOTION_BUDGET) set.add(e.id);
      count += 1;
    }
    return set;
  }, [depthSortedVisible]);
  const labelIds = useMemo(() => {
    const set = new Set<string>();
    let count = 0;
    for (const e of depthSortedVisible) {
      if (e.kind !== "automaton" || !e.label) continue;
      if (count < LABEL_CAP) set.add(e.id);
      count += 1;
    }
    return set;
  }, [depthSortedVisible]);

  // Depth-sorted (back-to-front) candidate list for hit-testing, over the FULL
  // entity set (matches the old flat behavior of testing every entity, not
  // just the currently-culled ones).
  const depthSortedEntities = useMemo(() => sortIsometricDepth(entities), [entities]);

  // JS-side hit test: INVERSE-PROJECT the tap into logical grid coordinates,
  // then walk the depth-sorted candidates FRONT-TO-BACK (i.e. the reverse of
  // the back-to-front sort) so the first automaton within reach is, by
  // construction, the FRONTMOST one on a tie — no separate tie-break needed.
  const hitTest = useCallback(
    (px: number, py: number): string | null => {
      if (!fit) return null;
      const camera = { scale: camScale.get(), x: camX.get(), y: camY.get() };
      const logical = unprojectIsometricScreen({ x: px, y: py }, fit, camera);
      for (let i = depthSortedEntities.length - 1; i >= 0; i -= 1) {
        const entity = depthSortedEntities[i];
        if (
          (entity.kind !== "automaton" && !(entity.kind === "corpse" && entity.automatonId)) ||
          entity.hidden
        ) continue;
        const dx = logical.x - (entity.x + 0.5);
        const dy = logical.y - (entity.y + 0.5);
        if (Math.hypot(dx, dy) <= HIT_RADIUS_LOGICAL) return entity.automatonId ?? entity.id;
      }
      return null;
    },
    [depthSortedEntities, fit, camScale, camX, camY],
  );

  // De-dupe: a medium-length press can satisfy BOTH the tap and the long-press
  // branch; only the first selection of a given id in a short window should
  // register (so a toggling parent handler can't flip twice on one gesture).
  // State keeps that latch in React's committed model instead of a ref captured
  // by the gesture worklets.
  const [selectionRequest, requestSelection] = useReducer(reduceSelectionRequest, null);
  const commitSelection = useEffectEvent((id: string) => {
    Haptics.selectionAsync().catch(() => {});
    onSelectAutomaton(id);
  });
  useEffect(() => {
    if (selectionRequest) commitSelection(selectionRequest.id);
  }, [selectionRequest]);
  const selectAt = useCallback(
    (px: number, py: number) => {
      const id = hitTest(px, py);
      if (!id) return;
      requestSelection({ id, at: Date.now() });
    },
    [hitTest],
  );

  // Touch-down feedback (nit 7a): mark the automaton under the finger the instant
  // it lands; cleared when the gesture finalizes (works for tap, hold, or drag).
  const pressAt = useCallback((px: number, py: number) => setPressedId(hitTest(px, py)), [hitTest]);
  const clearPress = useCallback(() => setPressedId(null), []);

  const settle = useCallback(() => {
    commitSnap(camScale.get(), camX.get(), camY.get());
  }, [commitSnap, camScale, camX, camY]);

  // Keep the camera on the isometric world: clamp the translation so the
  // viewport can never reveal empty space beyond the projected grid bounds.
  // This inlines the SAME two-axis formula as the vendored
  // `clampIsometricCamera` (see the file-top thread note for why it can't be
  // called directly from a UI-thread worklet); `fit.contentBounds` is a plain
  // captured value recomputed by the JS-thread `fit` memo above every render,
  // so this closure always sees the current world.
  const clampCam = (s: number) => {
    "worklet";
    if (!fit) return;
    const bounds = fit.contentBounds;
    // At rest, the world belongs in the unobscured content rect. As it zooms,
    // progressively release that reservation so a scholar can pan naturally to
    // the real viewport edge instead of hitting an early, invisible wall.
    const release = Math.min(1, Math.max(0, (s - MIN_ISO_ZOOM) / (MAX_ISO_ZOOM - MIN_ISO_ZOOM)));
    const minX = contentRect.x * (1 - release);
    const maxX = layout.w - (layout.w - (contentRect.x + contentRect.width)) * (1 - release);
    const minY = contentRect.y * (1 - release);
    const maxY = layout.h - (layout.h - (contentRect.y + contentRect.height)) * (1 - release);
    const lowerX = maxX - s * bounds.maxX;
    const upperX = minX - s * bounds.minX;
    camX.set((v) => (lowerX > upperX ? (lowerX + upperX) / 2 : Math.min(upperX, Math.max(lowerX, v))));
    const lowerY = maxY - s * bounds.maxY;
    const upperY = minY - s * bounds.minY;
    camY.set((v) => (lowerY > upperY ? (lowerY + upperY) / 2 : Math.min(upperY, Math.max(lowerY, v))));
  };

  // Re-clamp on the JS thread when a fresh run or resize changes the fit.
  useEffect(() => {
    if (!fit) return;
    const scale = camScale.get();
    const release = Math.min(1, Math.max(0, (scale - MIN_ISO_ZOOM) / (MAX_ISO_ZOOM - MIN_ISO_ZOOM)));
    const clampAxis = (translation: number, min: number, max: number, start: number, end: number) => {
      const lower = end - scale * max;
      const upper = start - scale * min;
      return lower > upper ? (lower + upper) / 2 : Math.min(upper, Math.max(lower, translation));
    };
    const clamped = {
      scale,
      x: clampAxis(
        camX.get(),
        fit.contentBounds.minX,
        fit.contentBounds.maxX,
        contentRect.x * (1 - release),
        layout.w - (layout.w - (contentRect.x + contentRect.width)) * (1 - release),
      ),
      y: clampAxis(
        camY.get(),
        fit.contentBounds.minY,
        fit.contentBounds.maxY,
        contentRect.y * (1 - release),
        layout.h - (layout.h - (contentRect.y + contentRect.height)) * (1 - release),
      ),
    };
    camScale.set(clamped.scale);
    camX.set(clamped.x);
    camY.set(clamped.y);
  }, [fit, contentRect, layout.w, layout.h, camScale, camX, camY]);

  const pan = Gesture.Pan()
    .minDistance(2)
    .onBegin((e) => {
      cancelAnimation(camX);
      cancelAnimation(camY);
      startX.set(camX.get());
      startY.set(camY.get());
      runOnJS(pressAt)(e.x, e.y);
    })
    .onUpdate((e) => {
      if (isPinching.get()) return;
      camX.set(startX.get() + e.translationX);
      camY.set(startY.get() + e.translationY);
      clampCam(camScale.get());
    })
    .onEnd(() => runOnJS(settle)())
    .onFinalize(() => runOnJS(clearPress)());

  const pinch = Gesture.Pinch()
    .onBegin((e) => {
      isPinching.set(true);
      cancelAnimation(camX);
      cancelAnimation(camY);
      startScale.set(camScale.get());
      anchorX.set((e.focalX - camX.get()) / camScale.get());
      anchorY.set((e.focalY - camY.get()) / camScale.get());
    })
    .onUpdate((e) => {
      const raw = startScale.get() * e.scale;
      const cur = camScale.get();
      // Per-frame zoom-velocity clamp (sky) — a degenerate first e.scale can't
      // teleport the camera and flash the field.
      const stepped = Math.max(cur / 1.15, Math.min(cur * 1.15, raw));
      const ns = Math.max(MIN_ISO_ZOOM, Math.min(MAX_ISO_ZOOM, stepped));
      camX.set(e.focalX - anchorX.get() * ns);
      camY.set(e.focalY - anchorY.get() * ns);
      camScale.set(ns);
      clampCam(ns); // never let a pinch pull the world edge inside the viewport
    })
    .onFinalize(() => {
      isPinching.set(false);
      startX.set(camX.get());
      startY.set(camY.get());
      runOnJS(settle)();
    });

  const tap = Gesture.Tap()
    .maxDistance(16)
    .onEnd((e) => runOnJS(selectAt)(e.x, e.y));

  // A held press-and-release must ALSO select (nit 7b): before this, a slow hold
  // fell through to Pan and never selected. LongPress is composed SIMULTANEOUSLY
  // with the whole tap/pan/pinch tree (never racing it), so it can fire a
  // selection without ever cancelling camera pan/pinch — a hold on empty grid is
  // a harmless no-op select while pan/pinch keep moving the world. Its overlap
  // with tap on a medium press is guarded by selectAt's de-dupe.
  const longPress = Gesture.LongPress()
    .minDuration(260)
    .maxDistance(24)
    .onStart((e) => runOnJS(selectAt)(e.x, e.y));

  // tap-to-select must NOT compete with pan/pinch (sky L1777).
  const gesture = Gesture.Simultaneous(
    Gesture.Race(tap, Gesture.Simultaneous(pan, pinch)),
    longPress,
  );

  const bgStyle = useAnimatedStyle(() => ({
    transform: [
      { translateX: camX.get() },
      { translateY: camY.get() },
      { scale: camScale.get() },
    ],
  }));

  // ── Ambient life on the terrain (§7.5): faint water shimmer + algae sway ──────
  const shimmer = useSharedValue(0);
  const sway = useSharedValue(0);
  useEffect(() => {
    if (reduceMotion) {
      shimmer.set(0);
      sway.set(0);
      return;
    }
    shimmer.set(withRepeat(
      withSequence(
        withTiming(1, { duration: 3800, easing: Easing.inOut(Easing.sin) }),
        withTiming(0, { duration: 3800, easing: Easing.inOut(Easing.sin) }),
      ),
      -1,
      false,
    ));
    sway.set(withRepeat(
      withSequence(
        withTiming(1, { duration: 2600, easing: Easing.inOut(Easing.sin) }),
        withTiming(0, { duration: 2600, easing: Easing.inOut(Easing.sin) }),
      ),
      -1,
      false,
    ));
    return () => {
      cancelAnimation(shimmer);
      cancelAnimation(sway);
    };
  }, [reduceMotion, shimmer, sway]);
  const shimmerStyle = useAnimatedStyle(() => ({ opacity: 0.02 + shimmer.get() * 0.05 }));
  const algaeStyle = useAnimatedStyle(() => ({ opacity: 0.85 + sway.get() * 0.15 }));

  // ── Memoized terrain: tile geometry (positions) is expensive and stable ──────
  // across ticks (grid dims + fit rarely change), so it is computed ONCE per
  // (contentW, contentH, fit) here; per-tick `kind`/`intensity` is looked up
  // cheaply from `cellByPosition` at render time so terrain color updates
  // don't force a geometry rebuild. Depth-sorted (painter's order) so the two
  // "wall" faces beneath a tile never paint over a nearer tile's top face.
  const tileFaces = useMemo(() => {
    if (!fit) return [];
    const depth = GEOMETRY.tileDepth * fit.scale;
    const tiles = sortIsometricDepth(
      Array.from({ length: Math.max(0, contentW * contentH) }, (_, index) => ({
        id: `tile-${index}`,
        x: index % contentW,
        y: Math.floor(index / contentW),
      })),
    );
    return tiles.map((tile) => {
      const [top, right, bottom, left] = isometricTileDiamond(tile, GEOMETRY).map((point) =>
        fittedIsometricPoint(point, fit),
      );
      return { id: tile.id, x: tile.x, y: tile.y, top, right, bottom, left, depth };
    });
  }, [fit, contentW, contentH]);

  // ── Continuous shared-edge terrain ─────────────────────────────────────────
  // The board is deterministic SVG geometry. Artwork belongs to discrete
  // overlays, never independently framed floor rasters that can introduce gaps.
  const isEcosystemGrid = scene?.templateId === "ecosystemGrid";

  const cellByPosition = useMemo(
    () => new Map((scene?.cells ?? []).map((cell) => [`${cell.x}:${cell.y}`, cell])),
    [scene],
  );
  const landscape = useMemo(
    () =>
      landscapeConfig
        ? generateEcosystemLandscape({
            width: contentW,
            height: contentH,
            config: landscapeConfig,
          })
        : undefined,
    [contentH, contentW, landscapeConfig],
  );
  const landscapeByPosition = useMemo(
    () =>
      new Map(
        (landscape?.cells ?? []).map((cell) => [`${cell.x}:${cell.y}`, cell]),
      ),
    [landscape],
  );
  const physicsTerrainPositions = useMemo(
    () => ecosystemPhysicsTerrainPositionSet(physicsTerrainConfig),
    [physicsTerrainConfig],
  );
  const visualPaths = useMemo(
    () =>
      isEcosystemGrid && landscape && landscapeConfig
        ? ecosystemLandscapeVisualPaths({
            landscape,
            seed: landscapeConfig.seed,
            biomeId: biome.id,
            faces: tileFaces,
            physicsTerrainPositions,
          })
        : null,
    [
      biome.id,
      isEcosystemGrid,
      landscape,
      landscapeConfig,
      physicsTerrainPositions,
      tileFaces,
    ],
  );

  const algaePips = useMemo(() => {
    if (!fit || !scene) return [];
    const pips: { key: string; x: number; y: number }[] = [];
    for (const cellData of scene.cells) {
      if (cellData.kind !== "resource") continue;
      const level = algaeLevel(cellData.intensity);
      for (let i = 0; i < level; i += 1) {
        const o = ALGAE_PIP_OFFSETS[i];
        const center = fittedIsometricPoint(
          isometricCellCenter({ x: cellData.x - 0.5 + o.x, y: cellData.y - 0.5 + o.y }, GEOMETRY),
          fit,
        );
        pips.push({ key: `c${cellData.x}-${cellData.y}-p${i}`, x: center.x, y: center.y });
      }
    }
    return pips;
  }, [fit, scene]);

  const pointString = (points: readonly { x: number; y: number }[]) =>
    points.map((p) => `${p.x},${p.y}`).join(" ");

  const score = run ? runCriterionScore(spec, run.criterionScores) : null;
  const scoreMetric =
    spec.criterion.kind === "measured" && score !== null
      ? metricLabel(spec.criterion.metricKey, score)
      : "";
  const selectedSceneEntity = scene?.entities.find(
    (entity) => entity.kind === "automaton" && entity.id === selectedAutomatonId,
  );
  const selectedSpeciesSlot =
    spec.templateId === "ecosystemGrid"
      ? spec.speciesSlots.find((slot) => slot.slotId === selectedSceneEntity?.slotId)
      : undefined;
  const hasSense = (senseId: EcosystemInspectableSenseId) =>
    selectedSpeciesSlot?.senses.some((sense) => sense.senseId === senseId) ?? false;
  const senseProjection = useMemo(
    () =>
      spec.templateId === "ecosystemGrid" &&
      scene &&
      selectedAutomatonId &&
      requestedSense !== "world"
        ? projectEcosystemSense({
            spec,
            scene,
            actorId: selectedAutomatonId,
            senseId: requestedSense,
          })
        : null,
    [requestedSense, scene, selectedAutomatonId, spec],
  );
  const activeSense = senseProjection ? requestedSense : "world";
  const certaintyCells = useMemo(
    () => ecosystemCertaintyCells(frame, selectedAutomatonId, activeSense),
    [activeSense, frame, selectedAutomatonId],
  );
  useEffect(() => {
    onSenseEvidenceDemand?.(
      activeSense === "world" || !selectedAutomatonId
        ? undefined
        : { actorId: selectedAutomatonId, senseId: activeSense },
    );
  }, [activeSense, onSenseEvidenceDemand, selectedAutomatonId]);

  return (
    <View style={styles.root}>
      {run ? (
        <View style={styles.runHeader}>
          <Text style={[styles.runLabel, { color: colors.fg }]} numberOfLines={1}>
            {runLabel}
            {score !== null ? ` · ${formatMetric(score)} ${scoreMetric}` : ""}
          </Text>
          {personalDelta ? (
            <Text style={[styles.delta, { color: colors.violet }]} numberOfLines={1}>
              {personalDelta}
            </Text>
          ) : null}
        </View>
      ) : null}

      {spec.templateId === "ecosystemGrid" ? (
        <View style={[styles.senseBar, { borderTopColor: colors.border }]}>
          <View style={styles.senseButtons}>
            {(
              [
                { id: "world", label: "World" },
                { id: "vision", label: "Sight" },
                { id: "smell", label: "Scent" },
              ] as const
            ).map((lens) => {
              const disabled =
                lens.id !== "world" &&
                (!selectedAutomatonId || !hasSense(lens.id));
              const selected = activeSense === lens.id;
              return (
                <Pressable
                  key={lens.id}
                  onPress={() => setRequestedSense(lens.id)}
                  disabled={disabled}
                  accessibilityRole="button"
                  accessibilityState={{ selected, disabled }}
                  style={[
                    styles.senseButton,
                    {
                      backgroundColor: selected ? colors.violetSolid : colors.white,
                      borderColor: selected ? colors.violetSolid : colors.border,
                      opacity: disabled ? 0.42 : 1,
                    },
                  ]}
                >
                  <Text style={[styles.senseButtonText, { color: selected ? colors.white : colors.fg }]}>
                    {lens.label}
                  </Text>
                </Pressable>
              );
            })}
          </View>
          {senseProjection ? (
            <View style={styles.senseEvidence}>
              <Text style={[styles.senseSummary, { color: colors.fgMuted }]}>
                {senseProjection.targets.length} sensed · range {senseProjection.range} · solid = pre-action decision tick
              </Text>
              <View style={styles.senseKey}>
                <View
                  style={[
                    styles.senseKeyRing,
                    {
                      borderColor:
                        senseProjection.senseId === "vision" ? "#0891B2" : "#D97706",
                    },
                  ]}
                />
                <Text style={[styles.senseSummary, { color: colors.fgMuted }]}>
                  {senseProjection.senseId === "vision" ? "In sight" : "Scented"}
                </Text>
                {senseProjection.senseId === "smell" ? (
                  <>
                    <Text style={styles.senseHiddenMark}>×</Text>
                    <Text style={[styles.senseSummary, { color: colors.fgMuted }]}>
                      Hidden from sight
                    </Text>
                  </>
                ) : null}
              </View>
            </View>
          ) : (
            <Text style={[styles.senseSummary, { color: colors.fgMuted }]}>
              {selectedAutomatonId
                ? "Choose one of this automaton’s senses"
                : "Select an automaton to inspect its senses"}
            </Text>
          )}
        </View>
      ) : null}

      <View style={[styles.stage, { backgroundColor: biome.rendering.stageColor }]} onLayout={onLayout}>
        {scene && fit && cellPixel > 0 ? (
          <>
            {biome.rendering.hasWaterShimmer ? (
              <Animated.View
                pointerEvents="none"
                style={[StyleSheet.absoluteFill, { backgroundColor: "#7DD3FC" }, shimmerStyle]}
              />
            ) : null}

            {/* Shared-edge terrain keeps generated relief in the existing top
                faces and batches every contour into one SVG Path. Physics-bearing
                scene cells override both channels. */}
            <Animated.View
              pointerEvents="none"
              style={[StyleSheet.absoluteFill, { transformOrigin: "0% 0%" }, bgStyle]}
            >
              <Svg width={layout.w} height={layout.h}>
                {tileFaces.map((tile) => {
                  const cellData = cellByPosition.get(`${tile.x}:${tile.y}`);
                  const landscapeCell = landscapeByPosition.get(`${tile.x}:${tile.y}`);
                  const physicsTerrain = ecosystemTerrainKindHasPhysics(cellData?.kind);
                  const surfaceColor = isEcosystemGrid
                    ? ecosystemTerrainSurfaceColor(
                        cellData?.kind,
                        biome.id,
                        landscapeCell?.band,
                      )
                    : undefined;
                  const currentVector = ecosystemCurrentScreenVector(cellData?.kind);
                  const unknown = isEcosystemGrid && cellData !== undefined && surfaceColor === undefined;
                  const checker = (tile.x + tile.y) % 2 ? "#167891" : "#1D88A0";
                  const wallColors =
                    landscapeCell && !physicsTerrain
                      ? biome.rendering.landscapeWalls[landscapeCell.band]
                      : {
                          left: biome.rendering.leftWallColor,
                          right: biome.rendering.rightWallColor,
                        };
                  return (
                    <G key={tile.id}>
                      <Polygon
                        points={pointString([
                          tile.left,
                          tile.bottom,
                          { x: tile.bottom.x, y: tile.bottom.y + tile.depth },
                          { x: tile.left.x, y: tile.left.y + tile.depth },
                        ])}
                        fill={wallColors.left}
                      />
                      <Polygon
                        points={pointString([
                          tile.bottom,
                          tile.right,
                          { x: tile.right.x, y: tile.right.y + tile.depth },
                          { x: tile.bottom.x, y: tile.bottom.y + tile.depth },
                        ])}
                        fill={wallColors.right}
                      />
                      {physicsTerrain ? (
                        <AnimatedPolygon
                          points={pointString([
                            tile.top,
                            tile.right,
                            tile.bottom,
                            tile.left,
                          ])}
                          fill={unknown ? "#64748B" : surfaceColor ?? checker}
                          fillOpacity={unknown ? 0.78 : 1}
                          stroke={biome.rendering.physicsOutlineColor}
                          animatedProps={physicsStrokeProps}
                        />
                      ) : (
                        <Polygon
                          points={pointString([
                            tile.top,
                            tile.right,
                            tile.bottom,
                            tile.left,
                          ])}
                          fill={unknown ? "#64748B" : surfaceColor ?? checker}
                          fillOpacity={unknown ? 0.78 : 1}
                          stroke={biome.rendering.outlineColor}
                          strokeWidth={Math.max(0.25, cellPixel * 0.004)}
                        />
                      )}
                      {currentVector ? (
                        <Line
                          x1={tile.top.x - currentVector.dx * cellPixel}
                          y1={tile.right.y - currentVector.dy * cellPixel}
                          x2={tile.top.x + currentVector.dx * cellPixel}
                          y2={tile.right.y + currentVector.dy * cellPixel}
                          stroke="#E0F7FA"
                          strokeLinecap="round"
                          strokeWidth={Math.max(1, cellPixel * 0.035)}
                        />
                      ) : null}
                    </G>
                  );
                })}
                {visualPaths?.sunkenFacet ? (
                  <Path
                    d={visualPaths.sunkenFacet}
                    fill={biome.rendering.landscapeSunkenFacetColor}
                    fillOpacity={0.2}
                  />
                ) : null}
                {visualPaths?.raisedFacet ? (
                  <Path
                    d={visualPaths.raisedFacet}
                    fill={biome.rendering.landscapeRaisedFacetColor}
                    fillOpacity={0.2}
                  />
                ) : null}
                {visualPaths?.reliefShadow ? (
                  <AnimatedPath
                    d={visualPaths.reliefShadow}
                    fill="none"
                    stroke={biome.rendering.landscapeReliefShadowColor}
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    opacity={0.64}
                    animatedProps={reliefShadowStrokeProps}
                  />
                ) : null}
                {visualPaths
                  ? ECOSYSTEM_LANDSCAPE_BANDS.map((band) =>
                      visualPaths.marks[band] ? (
                        <AnimatedPath
                          key={band}
                          d={visualPaths.marks[band]}
                          fill="none"
                          stroke={biome.rendering.landscapeMarks[band]}
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          opacity={0.88}
                          animatedProps={
                            band === "ridge" ? ridgeMarkStrokeProps : markStrokeProps
                          }
                        />
                      ) : null,
                    )
                  : null}
              </Svg>
            </Animated.View>

            {/* algae — DISCRETE charm units in each resource cell's top-left
                corner (1/2/3 pips = a cell's bucketed resource level), on its
                own camera-ridden layer so it can sway gently. The pip charm
                shares the SpeciesIcon pipeline and falls back to a plain green
                dot until its art warms. */}
            <Animated.View
              pointerEvents="none"
              style={[
                StyleSheet.absoluteFill,
                { transformOrigin: "0% 0%" },
                bgStyle,
                biome.rendering.hasWaterShimmer ? algaeStyle : null,
              ]}
            >
              <Svg width={layout.w} height={layout.h}>
                {algaePips.map((pip) => {
                  const pr = 0.09 * cellPixel;
                  return resourceIcon ? (
                    <SvgImage
                      key={pip.key}
                      href={{ uri: resourceIcon }}
                      x={pip.x - pr}
                      y={pip.y - pr}
                      width={pr * 2}
                      height={pr * 2}
                      preserveAspectRatio="xMidYMid meet"
                    />
                  ) : (
                    <Circle
                      key={pip.key}
                      cx={pip.x}
                      cy={pip.y}
                      r={pr}
                      fill={biome.resource.markerColor}
                    />
                  );
                })}
              </Svg>
            </Animated.View>

            {certaintyCells.length > 0 ? (
              <Animated.View
                pointerEvents="none"
                style={[StyleSheet.absoluteFill, { transformOrigin: "0% 0%" }, bgStyle]}
              >
                <Svg width={layout.w} height={layout.h}>
                  {certaintyCells.map((cell) => (
                    <Polygon
                      key={`${cell.x}:${cell.y}`}
                      points={pointString(
                        isometricTileDiamond(cell, GEOMETRY).map((point) =>
                          fittedIsometricPoint(point, fit),
                        ),
                      )}
                      fill={requestedSense === "vision" ? "#0891B2" : "#D97706"}
                      fillOpacity={cell.opacity}
                    />
                  ))}
                </Svg>
              </Animated.View>
            ) : null}

            {senseProjection ? (
              <Animated.View
                pointerEvents="none"
                style={[StyleSheet.absoluteFill, { transformOrigin: "0% 0%" }, bgStyle]}
              >
                <Svg width={layout.w} height={layout.h}>
                  {senseProjection.targets.map((target) => {
                    const color =
                      target.status === "hidden"
                        ? "#D92D20"
                        : senseProjection.senseId === "vision"
                          ? "#0891B2"
                          : "#D97706";
                    if (target.kind === "automaton" || target.kind === "corpse") {
                      const center = fittedIsometricPoint(
                        isometricCellCenter(target, GEOMETRY),
                        fit,
                      );
                      return (
                        <G key={target.key}>
                          <Circle
                            cx={center.x}
                            cy={center.y}
                            r={cellPixel * 0.47}
                            fill="none"
                            stroke={color}
                            strokeWidth={Math.max(2, cellPixel * 0.06)}
                            strokeDasharray={target.status === "hidden" ? "7 5" : undefined}
                          />
                          {target.status === "hidden" ? (
                            <>
                              <Line
                                x1={center.x - cellPixel * 0.18}
                                y1={center.y - cellPixel * 0.18}
                                x2={center.x + cellPixel * 0.18}
                                y2={center.y + cellPixel * 0.18}
                                stroke={color}
                                strokeWidth={Math.max(1.5, cellPixel * 0.04)}
                              />
                              <Line
                                x1={center.x + cellPixel * 0.18}
                                y1={center.y - cellPixel * 0.18}
                                x2={center.x - cellPixel * 0.18}
                                y2={center.y + cellPixel * 0.18}
                                stroke={color}
                                strokeWidth={Math.max(1.5, cellPixel * 0.04)}
                              />
                            </>
                          ) : null}
                        </G>
                      );
                    }
                    const points = isometricTileDiamond(target, GEOMETRY).map((point) =>
                      fittedIsometricPoint(point, fit),
                    );
                    return (
                      <Polygon
                        key={target.key}
                        points={pointString(points)}
                        fill={color}
                        fillOpacity={0.16}
                        stroke={color}
                        strokeWidth={Math.max(1, cellPixel * 0.035)}
                      />
                    );
                  })}
                </Svg>
              </Animated.View>
            ) : null}

            {depthSortedVisible.map((entity) => (
              <AutomatonNode
                key={entity.id}
                entity={entity}
                fit={fit}
                cellPixel={cellPixel}
                camX={camX}
                camY={camY}
                camScale={camScale}
                icon={entity.label ? speciesIcons[entity.label] : undefined}
                selected={entity.id === selectedAutomatonId || entity.automatonId === selectedAutomatonId}
                pressed={entity.id === pressedId || entity.automatonId === pressedId}
                invalid={invalidIds.has(entity.id)}
                showLabel={showLabels && labelIds.has(entity.id)}
                animate={animateIds.has(entity.id)}
                reduceMotion={reduceMotion}
                onSelect={() => onSelectAutomaton(entity.automatonId ?? entity.id)}
              />
            ))}

            {/* transparent gesture surface on top — kept out of the accessibility
                tree so VoiceOver reaches the automaton nodes beneath it */}
            <GestureDetector gesture={gesture}>
              <View style={StyleSheet.absoluteFill} importantForAccessibility="no" accessible={false} />
            </GestureDetector>

            {staleNotice ? (
              <View style={styles.staleChip} pointerEvents="none">
                <Text style={styles.staleText}>{staleNotice}</Text>
              </View>
            ) : null}
          </>
        ) : (
          <View style={styles.empty}>
            {run ? (
              <Text style={[styles.emptyText, { color: colors.fgMuted }]}>
                {sceneResult.status === "error"
                  ? `couldn't replay day ${tick}`
                  : "loading the world…"}
              </Text>
            ) : null}
          </View>
        )}
      </View>

      {showTransport && run ? (
        <>
          <MetricStrip
            run={run}
            spec={spec}
            selectedTick={tick}
            populationTraitEvidence={frame?.populationTraitEvidence}
          />
          <TickScrubber
            tick={tick}
            maxTick={maxTick}
            moreComing={moreComing}
            playing={playing}
            onScrub={onScrub}
            onTogglePlay={onTogglePlay}
            status={run.status}
            haltReason={run.haltReason}
            targetTicks={run.targetTicks}
            runKind={run.runKind}
            spec={spec}
          />
        </>
      ) : null}
    </View>
  );
}

export function SimulatorViewport(props: SimulatorViewportProps) {
  const rendererFamily = getWorkbenchRendererFamily(props.spec.templateId);
  if (rendererFamily === "match" || rendererFamily === "commons") {
    return (
      <View style={styles.root}>
        <WorkbenchProofRenderer
          spec={props.spec as Exclude<SimulatorSpec, Extract<SimulatorSpec, { templateId: "ecosystemGrid" }>>}
          frame={props.frame}
          scene={props.scene}
          onScrub={props.onScrub}
          onSelectActor={props.onSelectAutomaton}
          contentInsets={props.contentInsets}
          maxTick={props.maxTick}
          targetTicks={props.run?.targetTicks ?? props.maxTick}
        />
        {props.showTransport && props.run ? (
          <TickScrubber
            tick={props.tick}
            maxTick={props.maxTick}
            moreComing={props.moreComing}
            playing={props.playing}
            onScrub={props.onScrub}
            onTogglePlay={props.onTogglePlay}
            status={props.run.status}
            haltReason={props.run.haltReason}
            targetTicks={props.run.targetTicks}
            runKind={props.run.runKind}
            spec={props.spec}
          />
        ) : null}
      </View>
    );
  }
  return <FieldViewport {...props} />;
}

type Layout = { w: number; h: number };

const styles = StyleSheet.create({
  root: { flex: 1, minHeight: 0 },
  runHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 10,
    paddingHorizontal: 16,
    paddingVertical: 8,
  },
  runLabel: { fontFamily: fonts.semibold, fontSize: 12, flex: 1 },
  delta: { fontFamily: fonts.semibold, fontSize: 12 },
  senseBar: {
    borderTopWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 12,
    paddingVertical: 7,
    gap: 6,
  },
  senseButtons: { flexDirection: "row", gap: 7 },
  senseButton: {
    minHeight: 34,
    justifyContent: "center",
    paddingHorizontal: 12,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 8,
  },
  senseButtonText: { fontFamily: fonts.semibold, fontSize: 12 },
  senseSummary: { fontFamily: fonts.regular, fontSize: 10 },
  senseEvidence: { gap: 4 },
  senseKey: { flexDirection: "row", alignItems: "center", gap: 5, flexWrap: "wrap" },
  senseKeyRing: { width: 9, height: 9, borderRadius: 5, borderWidth: 2 },
  senseHiddenMark: { fontFamily: fonts.bold, fontSize: 13, color: "#D92D20" },
  stage: { flex: 1, minHeight: 0, overflow: "hidden" },
  anchor: { position: "absolute", left: 0, top: 0, alignItems: "center" },
  ringOverlay: { position: "absolute" },
  nodeLabel: { fontFamily: fonts.medium, fontSize: 9, marginTop: 1 },
  empty: { flex: 1, alignItems: "center", justifyContent: "center" },
  emptyText: { fontFamily: fonts.regular, fontSize: 14 },
  staleChip: {
    position: "absolute",
    top: 10,
    alignSelf: "center",
    backgroundColor: "rgba(17,20,45,0.72)",
    paddingHorizontal: 12,
    paddingVertical: 5,
    borderRadius: 999,
  },
  staleText: { fontFamily: fonts.medium, fontSize: 11, color: "#fff" },
});
