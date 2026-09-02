/**
 * Scratchpad — the canonical native handwriting implementation. Rabbit Slides
 * currently mounts it through `GlobalScratchpad` for sketch insertion.
 *
 * The idea: give a scholar a place to *work through* a problem by hand while
 * the problem stays in view. The first cut got that by SUPERIMPOSITION — a
 * full-screen 50%-frosted sheet you wrote on top of everything — and Andy's
 * verdict on the device (2026-07-26) was "the cure is worse than the disease":
 * the stem got dimmer, ink landed on top of the digits, and the Check button was
 * visible but dead.
 *
 * So co-visibility now comes from ADJACENCY instead. This is a resizable
 * RIGHT-SIDE DRAWER (the iPadOS Split View idiom): the app content reflows into
 * the space left over (see `useScratchpadInset`), so the problem stays fully
 * opaque, fully legible and fully tappable while the pad is open. The divider
 * free-drags with a magnetic snap to ⅓ · ½ · ⅔, clamped to 25–90% of the width.
 * Why horizontal: the practice column is capped at 480pt of an 1180pt landscape
 * iPad, so a side pane costs the problem nothing until ~700pt — while the bottom
 * edge is already spoken for by the constant-height CTA lane.
 *
 * Chrome is glass (`GlassBar` → real iOS 26 Liquid Glass), the PAPER IS OPAQUE —
 * ink on glass is the exact legibility problem being fixed.
 *
 * ── The paper ────────────────────────────────────────────────────────────────
 * The sheet is a FIXED logical size (the widest the drawer can ever get) anchored
 * top-left, and the drawer is a *viewport* onto it. Resizing therefore never
 * rescales or reflows a stroke — growing reveals more paper, shrinking hides the
 * right of it. Ink never moves relative to ink.
 *
 * Kids here have no Apple Pencil, so it's finger-first, but it takes any pointer —
 * finger, Apple Pencil, or a trackpad/mouse cursor (all flow through
 * `Gesture.Pan`).
 *
 * It mounts through `GlobalScratchpad`, never directly from an individual
 * surface. The host owns the capture-provider connection to `scratchpadBus`.
 *
 * ── The pen ───────────────────────────────────────────────────────────────────
 * A finger reports NO real pressure on iPad (true force/tilt only comes from an
 * Apple Pencil), so "pressure" is SIMULATED FROM VELOCITY by `perfect-freehand`
 * (fast → thin, slow → thick). We render the outline with
 * `@shopify/react-native-skia` (GPU) — a blurred low-alpha copy under a
 * multiply-blended core gives the wet-ink feel. Feel is `PEN_DEFAULTS`, tuned by
 * Andy on the physical iPad; untouched by the drawer rework.
 *
 * Responsiveness: input points are DECIMATED (a point is added only once the
 * pointer has moved `MIN_STEP` px) and the ACTIVELY-DRAWN stroke renders crisp
 * (bleed only applies once a stroke is committed) — both keep the live stroke
 * snappy. Capture snapshots the INK'S BOUNDING BOX (not the whole sheet), so the
 * PNG the tutor and observer receive is a tight, opaque crop of the work.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Pressable,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import Animated, {
  Easing,
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
  withTiming,
} from "react-native-reanimated";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import {
  Canvas,
  Fill,
  Group,
  Path,
  BlendMode,
  BlurMask,
  BlurStyle,
  Skia,
  useCanvasRef,
  type SkPath,
  type SkRect,
} from "@shopify/react-native-skia";
import getStroke from "perfect-freehand";
import { SymbolView } from "expo-symbols";
import * as Haptics from "expo-haptics";
import {
  writeAsStringAsync,
  cacheDirectory,
  EncodingType,
} from "expo-file-system/legacy";

import { GlassBar } from "@/components/Glass";
import type { SilentCapture } from "@/lib/scratchpadBus";
import {
  CLOSE_MS,
  MAX_FRAC,
  RAIL_W,
  drawerMetrics,
  getPreferredFrac,
  inkCropRect as computeInkCropRect,
  outlineToSvgPath,
  projectFling,
  scratchpadWidth,
  setPreferredFrac,
  snapTarget,
} from "@/lib/scratchpadLayout";
import { fonts, useColors } from "@/theme";

type Point = [number, number];

/** The knobs that define the pen's feel. */
export type PenParams = {
  size: number; // base nib thickness (px)
  thinning: number; // velocity→width contrast; 0 = uniform pen, ~0.8 = very calligraphic
  smoothing: number; // outline curve smoothing
  streamline: number; // input smoothing; higher = smoother but laggier
  startTaper: number; // onset taper px; 0 = instant full-weight pen-down
  inkOpacity: number; // core ink alpha
  bleed: number; // wet-ink halo alpha (0 = off) — committed strokes only
  bleedBlur: number; // halo blur radius
  multiply: boolean; // multiply blend so overlaps pool/darken
};

// Andy-tuned on the physical iPad (2026-07-13): thin nib, instant onset, light
// wet-ink bleed, full-opacity ink, pooling on.
export const PEN_DEFAULTS: PenParams = {
  size: 6,
  thinning: 0.4,
  smoothing: 0.46,
  streamline: 0.34,
  startTaper: 0,
  inkOpacity: 1,
  bleed: 0.08,
  bleedBlur: 2.5,
  multiply: true,
};

// Only record a point once the pointer has moved this far — caps point count so
// getStroke stays cheap on long strokes.
const MIN_STEP = 1.6;

const INK = "#20233f";
// The paper is OPAQUE — the whole point of the drawer rework. A warm near-white
// so it reads as paper next to the app's bgSubtle, and so the captured PNG has a
// real background for the vision model instead of a transparent wash.
const PAPER = "#fdfcf8";

// The divider / grab rail down the drawer's left edge.
// RAIL_W, CROP_PAD and MIN_CROP live in shared/scratchpadGeometry.ts, where the
// merge gate's vitest can reach them.
/** Below this drawer width the title collapses so the controls keep their room. */
const TITLE_MIN_W = 430;
/** Same, when there's no send button and the controls are three small circles. */
const TITLE_MIN_W_BARE = 300;

const OPEN_SPRING = { damping: 26, stiffness: 260, mass: 0.85 };
const SNAP_SPRING = { damping: 24, stiffness: 300, mass: 0.7 };
// CLOSE_MS (the close duration, paired with Easing.out) lives in
// shared/scratchpadGeometry.ts. The unmount timer keys off it.

export type ScratchpadProps = {
  visible: boolean;
  onClose: () => void;
  onCapture: (uri: string, mime: string) => void | Promise<void>;
  /**
   * Copy for the send button, or null when the current surface has NOWHERE to
   * send a drawing right now — then the pad is pure scratch paper and shows no
   * send button at all. A button that stages a PNG somewhere invisible reads as
   * broken (it did on practice: it silently staged for a chat turn that hadn't
   * started, so tapping it appeared to do nothing).
   */
  primaryLabel?: string | null;
  /**
   * Change this to wipe the sheet when the global host is re-enabled, so ink
   * does not outlive the problem it belongs to.
   */
  sheetKey?: number;
  title?: string;
  /** Override pen feel (merged over PEN_DEFAULTS). */
  pen?: Partial<PenParams>;
  /**
   * Publish (or, with a null first argument, retract) this pad's silent-capture
   * function. The host wires it to `scratchpadBus`; the pad itself stays free of
   * the bus, exactly like `onCapture`.
   */
  registerCapture?: (fn: SilentCapture | null, prev?: SilentCapture) => void;
};

// `outlineToSvgPath` lives in shared/scratchpadGeometry.ts (and is tested
// there): perfect-freehand outline points → the `d` string Skia renders.

function pointsToSkPath(points: Point[], p: PenParams): SkPath | null {
  if (points.length === 0) return null;
  const outline = getStroke(points, {
    size: p.size,
    thinning: p.thinning,
    smoothing: p.smoothing,
    streamline: p.streamline,
    simulatePressure: true,
    easing: (t: number) => Math.sin((t * Math.PI) / 2),
    start: { taper: p.startTaper, cap: true },
    end: { taper: p.size * 1.5, cap: true },
  });
  const svg = outlineToSvgPath(outline);
  return svg ? Skia.Path.MakeFromSVGString(svg) : null;
}

/** A committed stroke: bleed halo (if on) under a core fill. */
function InkStroke({ path, p }: { path: SkPath; p: PenParams }) {
  return (
    <Group>
      {p.bleed > 0 ? (
        <Path path={path} color={INK} opacity={p.bleed}>
          <BlurMask blur={p.bleedBlur} style="normal" />
        </Path>
      ) : null}
      <Path
        path={path}
        color={INK}
        opacity={p.inkOpacity}
        blendMode={p.multiply ? "multiply" : "srcOver"}
      />
    </Group>
  );
}

/**
 * Render committed strokes to a PNG on an OFFSCREEN Skia surface — no on-screen
 * `<Canvas>` involved.
 *
 * This exists because the pad UNMOUNTS when it closes (`mounted` below), so the
 * `<Canvas>` — and with it `makeImageSnapshot()` — is simply not there whenever
 * the drawer isn't open. When the dormant host is re-enabled, the `paths`
 * themselves survive because that host renders this component continuously.
 * Capture therefore has to
 * be able to run off the path list alone, or the most valuable capture of all —
 * a scholar who worked it out, gave up, CLOSED the pad and then missed — would
 * be the one case that silently produced nothing.
 *
 * Mirrors `InkStroke` exactly (bleed halo then core, per stroke, in draw order)
 * so the PNG is the same picture the scholar was looking at. Raster-backed
 * (`Surface.Make`) rather than GPU (`MakeOffscreen`): this runs on the JS thread
 * at arbitrary moments, and a few hundred paths of a kid's handwriting is
 * nothing to rasterise.
 */
function renderInkToPng(paths: SkPath[], p: PenParams, crop: SkRect): string | null {
  const w = Math.max(1, Math.round(crop.width));
  const h = Math.max(1, Math.round(crop.height));
  const surface = Skia.Surface.Make(w, h);
  if (!surface) return null;

  const canvas = surface.getCanvas();
  canvas.drawColor(Skia.Color(PAPER));
  // Draw in SHEET coordinates and let the translate do the cropping, so stroke
  // geometry is never recomputed for a capture.
  canvas.translate(-crop.x, -crop.y);

  const bleed = p.bleed > 0 ? Skia.Paint() : null;
  if (bleed) {
    bleed.setAntiAlias(true);
    bleed.setColor(Skia.Color(INK));
    bleed.setAlphaf(p.bleed);
    bleed.setMaskFilter(Skia.MaskFilter.MakeBlur(BlurStyle.Normal, p.bleedBlur, true));
  }
  const core = Skia.Paint();
  core.setAntiAlias(true);
  core.setColor(Skia.Color(INK));
  core.setAlphaf(p.inkOpacity);
  core.setBlendMode(p.multiply ? BlendMode.Multiply : BlendMode.SrcOver);

  for (const path of paths) {
    if (bleed) canvas.drawPath(path, bleed);
    canvas.drawPath(path, core);
  }
  surface.flush();
  return surface.makeImageSnapshot().encodeToBase64();
}

export function Scratchpad({
  visible,
  onClose,
  onCapture,
  primaryLabel = null,
  sheetKey = 0,
  title = "Scratchpad",
  pen,
  registerCapture,
}: ScratchpadProps) {
  const colors = useColors();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const insets = useSafeAreaInsets();
  const params = useMemo<PenParams>(() => ({ ...PEN_DEFAULTS, ...pen }), [pen]);

  const canvasRef = useCanvasRef();
  const [paths, setPaths] = useState<SkPath[]>([]);
  const [livePath, setLivePath] = useState<SkPath | null>(null);
  const currentPoints = useRef<Point[]>([]);
  const [capturing, setCapturing] = useState(false);
  const [mounted, setMounted] = useState(visible);

  // Fresh paper when the host surface says the work has moved on (the `sheetKey`
  // prop — practice bumps it per item). React's documented "adjust state during
  // render" pattern rather than an effect: the wipe lands in the SAME render, so
  // a stale sheet is never painted and there's no cascading re-render. A `key`
  // remount would also reset it, but would restart the drawer's open animation.
  const [seenSheetKey, setSeenSheetKey] = useState(sheetKey);
  if (seenSheetKey !== sheetKey) {
    setSeenSheetKey(sheetKey);
    setPaths([]);
    setLivePath(null);
  }

  // ── Drawer geometry ────────────────────────────────────────────────────────
  // Opening IS a resize: the width animates 0 → the scholar's preferred detent.
  const { width: screenW, height: screenH } = useWindowDimensions();
  const maxW = screenW * MAX_FRAC;
  // The fixed logical sheet: as wide as the paper can ever be shown, so the
  // viewport is always fully covered and a stroke never has to move.
  const sheetW = Math.round(maxW - RAIL_W);
  const toolbarH = Math.max(insets.top, 10) + 52;
  const sheetH = Math.round(screenH - toolbarH);

  const dragFrom = useSharedValue(0);
  const drawerStyle = useAnimatedStyle(() => ({ width: scratchpadWidth.get() }));

  // The worklets below read function-scope bindings rather than the top-level
  // consts. That started as a workaround for a `ReferenceError: Property 'X'
  // doesn't exist` crash on TITLE_MIN_W, but the mechanism was never confirmed
  // and the same message is also what stale Fast Refresh looks like — so if you
  // hit it, COLD-RELAUNCH before restructuring anything. See `snapTarget` in
  // `../lib/scratchpadLayout.ts` and `/ios-sim` →
  // `references/driving-the-app.md` ("Stale Fast Refresh").
  const titleMinW = primaryLabel ? TITLE_MIN_W : TITLE_MIN_W_BARE;
  const snapSpring = SNAP_SPRING;
  const metrics = useMemo(() => drawerMetrics(screenW), [screenW]);
  const closeEasing = useMemo(() => Easing.out(Easing.cubic), []);

  // The title collapses when the drawer is too narrow to hold it next to the
  // controls — the pane is a scholar's paper first, a labelled panel second.
  const titleStyle = useAnimatedStyle(() => {
    const room = scratchpadWidth.get() >= titleMinW;
    return { opacity: room ? 1 : 0, maxWidth: room ? 240 : 0 };
  });

  useEffect(() => {
    if (visible) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- The scratchpad must mount before its opening spring can render.
      setMounted(true);
      scratchpadWidth.set(withSpring(screenW * getPreferredFrac(), OPEN_SPRING));
      return;
    }
    scratchpadWidth.set(withTiming(0, {
      duration: CLOSE_MS,
      easing: closeEasing,
    }));
    // Unmount AFTER the close animation, on a plain JS timer rather than a
    // `runOnJS` in withTiming's completion callback. That callback path aborts
    // the app (SIGABRT in worklets' `toOptimizedObject`) when the animation
    // targets a MODULE-level `makeMutable` — the completion marshals back to JS
    // at the same moment this component's animated styles are being torn down,
    // and the shared value may outlive them in a future root inset host.
    // (The pre-drawer Scratchpad used the runOnJS form safely; it animated a
    // component-local `useSharedValue`, which dies with the component.)
    const t = setTimeout(() => setMounted(false), CLOSE_MS + 40);
    return () => clearTimeout(t);
  }, [visible, screenW, closeEasing]);

  // ── The divider ────────────────────────────────────────────────────────────
  // Free drag with a MAGNETIC snap: land near ⅓ · ½ · ⅔ (or either clamp) and it
  // pulls onto it; land anywhere else and it stays exactly where you let go.
  // Dragging LEFT widens, so the delta is subtracted.
  //
  // Both release decisions are made against where the divider would COAST to,
  // never the raw position the finger stopped at — a throw and a slow placement
  // ending on the same pixel mean completely different things. See
  // `projectFling`. At zero velocity the projection is zero and this is exactly
  // the old position-only behaviour.
  const commitFrac = useCallback((frac: number) => {
    setPreferredFrac(frac);
    void Haptics.selectionAsync();
  }, []);

  const resize = useMemo(
    () =>
      Gesture.Pan()
        .onStart(() => {
          dragFrom.set(scratchpadWidth.get());
        })
        .onUpdate((e) => {
          const next = dragFrom.get() - e.translationX;
          scratchpadWidth.set(Math.min(metrics.maxW, Math.max(0, next)));
        })
        .onEnd((e) => {
          const raw = dragFrom.get() - e.translationX;
          // The width shrinks as the finger moves right, so the width's own
          // velocity is the negative of the finger's.
          const widthV = -e.velocityX;
          const projected = raw + projectFling(widthV);
          if (projected < metrics.closeW) {
            runOnJS(onClose)();
            return;
          }
          const target = snapTarget(projected, metrics);
          // Hand the release velocity to the spring so the divider carries its
          // momentum into the snap instead of stopping dead and restarting.
          scratchpadWidth.set(withSpring(target, {
            ...snapSpring,
            velocity: widthV,
          }));
          runOnJS(commitFrac)(target / screenW);
        }),
    [dragFrom, metrics, snapSpring, screenW, onClose, commitFrac],
  );

  const hasInk = paths.length > 0 || livePath !== null;

  // Which sheet the in-flight stroke started on. A fresh-paper request can land
  // mid-stroke — the scholar draws with one hand and taps the advance CTA with
  // the other — and without this the pre-wipe points would be committed onto the
  // new sheet, putting the last problem's ink into the next problem's crop.
  const strokeSheet = useRef(sheetKey);

  const commitStroke = useCallback(() => {
    if (strokeSheet.current !== sheetKey) {
      currentPoints.current = [];
      setLivePath(null);
      return;
    }
    const p = pointsToSkPath(currentPoints.current, params);
    if (p) setPaths((prev) => [...prev, p]);
    currentPoints.current = [];
    setLivePath(null);
  }, [params, sheetKey]);

  // runOnJS so we drive React state from the gesture. `Gesture.Pan` takes any
  // pointer — finger, Apple Pencil, OR a trackpad/mouse cursor — so mouse drawing
  // works with no extra code.
  const pan = useMemo(
    () =>
      Gesture.Pan()
        .runOnJS(true)
        .minDistance(0)
        .averageTouches(true)
        // eslint-disable-next-line react-hooks/refs -- Gesture.Pan invokes this deferred callback after assembly; it owns imperative stroke state.
        .onBegin((e) => {
          strokeSheet.current = sheetKey;
          currentPoints.current = [[e.x, e.y]];
          setLivePath(pointsToSkPath(currentPoints.current, params));
        })
        // eslint-disable-next-line react-hooks/refs -- Gesture.Pan invokes this deferred callback after assembly; it owns imperative stroke state.
        .onUpdate((e) => {
          // The sheet was wiped under this stroke — stop feeding the old points
          // back into the preview.
          if (strokeSheet.current !== sheetKey) return;
          const pts = currentPoints.current;
          const last = pts[pts.length - 1];
          if (last && Math.hypot(e.x - last[0], e.y - last[1]) < MIN_STEP) return;
          pts.push([e.x, e.y]);
          setLivePath(pointsToSkPath(pts, params));
        })
        // eslint-disable-next-line react-hooks/refs -- Gesture.Pan defers this callback until the stroke ends, when commitStroke reads its imperative state.
        .onEnd(commitStroke)
        // eslint-disable-next-line react-hooks/refs -- Gesture.Pan defers this callback until finalization, when commitStroke reads its imperative state.
        .onFinalize((_e, success) => {
          if (!success) commitStroke();
        }),
    [commitStroke, params, sheetKey],
  );

  const undo = useCallback(() => {
    Haptics.selectionAsync();
    setLivePath(null);
    currentPoints.current = [];
    setPaths((prev) => prev.slice(0, -1));
  }, []);

  const clear = useCallback(() => {
    Haptics.selectionAsync();
    setLivePath(null);
    currentPoints.current = [];
    setPaths([]);
  }, []);

  // The tight bounding box of everything drawn, padded and clamped to the sheet.
  // Cropping matters: the sheet is as wide as the drawer can ever get, so an
  // uncropped snapshot would hand the tutor (and, downstream, the observer's
  // vision pass) mostly blank paper. The padding/minimum-size maths lives in
  // shared/scratchpadGeometry.ts → `inkCropRect`; this only gathers the Skia
  // bounds. Returns null if the bounds look degenerate, in which case we fall
  // back to a full-sheet snapshot.
  const inkCropRect = useCallback((): SkRect | null => {
    if (paths.length === 0) return null;
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const p of paths) {
      const b = p.computeTightBounds();
      minX = Math.min(minX, b.x);
      minY = Math.min(minY, b.y);
      maxX = Math.max(maxX, b.x + b.width);
      maxY = Math.max(maxY, b.y + b.height);
    }
    const rect = computeInkCropRect({ minX, minY, maxX, maxY }, sheetW, sheetH);
    return rect ? Skia.XYWHRect(rect.x, rect.y, rect.width, rect.height) : null;
  }, [paths, sheetW, sheetH]);

  // The one way ink becomes a PNG on disk. Returns the file:// uri, or null when
  // there is nothing worth capturing.
  //
  // Offscreen-first, on purpose: the drawer's own `<Canvas>` only exists while
  // the drawer is open, and the most diagnostic capture there is (work it out →
  // give up → CLOSE the pad → miss) happens with the pad shut. The live-canvas
  // snapshot stays behind it as a fallback for the button path, where the canvas
  // is by definition mounted.
  const snapshotPng = useCallback(async (): Promise<string | null> => {
    if (paths.length === 0) return null;
    const crop = inkCropRect();
    if (!crop) return null;

    let base64: string | null = null;
    try {
      base64 = renderInkToPng(paths, params, crop);
    } catch (e) {
      console.warn("[scratchpad] offscreen render failed", e);
    }
    if (!base64) {
      const image =
        canvasRef.current?.makeImageSnapshot(crop) ?? canvasRef.current?.makeImageSnapshot();
      if (!image) return null;
      base64 = image.encodeToBase64(); // PNG
    }

    if (!cacheDirectory) throw new Error("no cache directory");
    const uri = `${cacheDirectory}scratchpad-${paths.length}-${Date.now() % 100000}.png`;
    await writeAsStringAsync(uri, base64, { encoding: EncodingType.Base64 });
    return uri;
  }, [paths, inkCropRect, canvasRef, params]);

  const capture = useCallback(async () => {
    if (capturing) return;
    if (!hasInk) {
      Alert.alert("Nothing to show yet", "Draw your work first, then tap again.");
      return;
    }
    setCapturing(true);
    try {
      const uri = await snapshotPng();
      if (!uri) throw new Error("snapshot failed");
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      await onCapture(uri, "image/png");
      onClose();
    } catch (e) {
      console.warn("[scratchpad] capture failed", e);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
      Alert.alert("Couldn't share your work", "Please try again.");
    } finally {
      setCapturing(false);
    }
  }, [capturing, hasInk, snapshotPng, onCapture, onClose]);

  // Serve silent captures — a capture nobody tapped for.
  //
  // A send button needs a live target; this provider does not because it is not
  // a send. It remains silent by design: no haptic, alert, or close.
  useEffect(() => {
    if (!registerCapture) return;
    const provider: SilentCapture = async () => {
      try {
        const uri = await snapshotPng();
        return uri ? { uri, mime: "image/png" } : null;
      } catch (e) {
        console.warn("[scratchpad] silent capture failed", e);
        return null;
      }
    };
    registerCapture(provider);
    return () => registerCapture(null, provider);
  }, [registerCapture, snapshotPng]);

  // NOTE: the old hidden auto-focused TextInput (Backspace = undo, Escape =
  // close) is deliberately gone. The pad is no longer modal — the practice
  // answer field is live right next to it — so a self-focusing key catcher would
  // steal the hardware keyboard from the thing the scholar is actually typing
  // into. Undo/close are the visible buttons.

  if (!mounted) return null;

  return (
    <Animated.View style={[styles.drawer, drawerStyle]}>
      <View style={styles.clip}>
        {/* The divider rail, down the drawer's LEFT edge. It owns its own column
            (the paper starts to its right) so a resize drag can never be
            confused for a pen stroke. */}
        <GestureDetector gesture={resize}>
          <View style={styles.rail}>
            <GlassBar edge="none" style={styles.railFill}>
              <View style={styles.railGrip} />
            </GlassBar>
          </View>
        </GestureDetector>

        {/* Opaque paper. The Canvas is the FIXED sheet (sheetW × sheetH); this
            view is the viewport that clips it, so resizing reveals/hides paper
            instead of rescaling ink. */}
        <View style={[styles.paperViewport, { top: toolbarH }]}>
          <GestureDetector gesture={pan}>
            <Canvas ref={canvasRef} style={{ width: sheetW, height: sheetH }}>
              <Fill color={PAPER} />
              {paths.map((p, i) => (
                <InkStroke key={i} path={p} p={params} />
              ))}
              {livePath ? (
                <Path
                  path={livePath}
                  color={INK}
                  opacity={params.inkOpacity}
                  blendMode={params.multiply ? "multiply" : "srcOver"}
                />
              ) : null}
            </Canvas>
          </GestureDetector>

          {!hasInk ? (
            <View style={styles.hintWrap} pointerEvents="none">
              <Text style={styles.hint}>Work it out here</Text>
            </View>
          ) : null}
        </View>

        {/* Glass chrome. All controls live in ONE bar: title left; undo · clear ·
            primary · close right. Safe-area padded; can't overflow. */}
        <GlassBar
          edge="bottom"
          style={StyleSheet.flatten([
            styles.chrome,
            { height: toolbarH, paddingTop: Math.max(insets.top, 10) },
          ])}
        >
          <View style={styles.topBar}>
            <Animated.View style={[styles.titleChip, titleStyle]}>
              <Text style={styles.eyebrow} numberOfLines={1}>
                WORK IT OUT
              </Text>
              <Text style={styles.title} numberOfLines={1}>
                {title}
              </Text>
            </Animated.View>

            <View style={styles.topControls}>
              <Pressable
                onPress={undo}
                disabled={!hasInk || capturing}
                accessibilityRole="button"
                accessibilityLabel="Undo last stroke"
                style={({ pressed }) => [
                  styles.toolBtn,
                  (!hasInk || capturing) && styles.toolBtnDisabled,
                  pressed && styles.pressed,
                ]}
              >
                <SymbolView
                  name="arrow.uturn.backward"
                  size={16}
                  tintColor={colors.charcoal}
                />
              </Pressable>
              <Pressable
                onPress={clear}
                disabled={!hasInk || capturing}
                accessibilityRole="button"
                accessibilityLabel="Clear the scratchpad"
                style={({ pressed }) => [
                  styles.toolBtn,
                  (!hasInk || capturing) && styles.toolBtnDisabled,
                  pressed && styles.pressed,
                ]}
              >
                <SymbolView name="trash" size={16} tintColor={colors.charcoal} />
              </Pressable>
              {primaryLabel ? (
                <Pressable
                  onPress={capture}
                  disabled={!hasInk || capturing}
                  accessibilityRole="button"
                  accessibilityLabel={primaryLabel}
                  style={({ pressed }) => [
                    styles.primaryBtn,
                    (!hasInk || capturing) && styles.primaryBtnDisabled,
                    pressed && styles.pressed,
                  ]}
                >
                  {capturing ? (
                    <ActivityIndicator color={colors.white} />
                  ) : (
                    <Text style={styles.primaryBtnText} numberOfLines={1}>
                      {primaryLabel}
                    </Text>
                  )}
                </Pressable>
              ) : null}
              <Pressable
                onPress={onClose}
                hitSlop={10}
                accessibilityRole="button"
                accessibilityLabel="Close the scratchpad"
                style={styles.closeBtn}
              >
                <SymbolView name="xmark" size={17} tintColor={colors.charcoal} />
              </Pressable>
            </View>
          </View>
        </GlassBar>
      </View>
    </Animated.View>
  );
}

function makeStyles(c: ReturnType<typeof useColors>) {
  return StyleSheet.create({
    // The drawer occupies the right column of the screen; `width` is animated.
    // A future root inset host keeps content beside this pane. The shadow lives
    // HERE (an opaque backgroundColor gives iOS a clean rect to cast from) and
    // clipping lives one level in — `overflow: hidden` sets masksToBounds, which
    // would eat the shadow.
    drawer: {
      position: "absolute",
      top: 0,
      right: 0,
      bottom: 0,
      zIndex: 60,
      backgroundColor: PAPER,
      shadowColor: "#000",
      shadowOpacity: 0.16,
      shadowRadius: 18,
      shadowOffset: { width: -4, height: 0 },
    },
    clip: { flex: 1, overflow: "hidden" },
    // Divider rail: glass, full height, with a centred grip pill.
    rail: {
      position: "absolute",
      left: 0,
      top: 0,
      bottom: 0,
      width: RAIL_W,
      zIndex: 3,
    },
    railFill: {
      flex: 1,
      alignItems: "center",
      justifyContent: "center",
      borderRightWidth: StyleSheet.hairlineWidth,
      borderRightColor: c.border,
    },
    railGrip: {
      width: 4,
      height: 44,
      borderRadius: 2,
      backgroundColor: c.gray300,
    },
    // Clips the fixed sheet. `top` is set inline (toolbar height).
    paperViewport: {
      position: "absolute",
      left: RAIL_W,
      right: 0,
      bottom: 0,
      overflow: "hidden",
      backgroundColor: PAPER,
    },
    chrome: {
      position: "absolute",
      top: 0,
      left: RAIL_W,
      right: 0,
      zIndex: 2,
      justifyContent: "center",
      paddingHorizontal: 14,
    },
    topBar: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      gap: 10,
    },
    topControls: { flexDirection: "row", alignItems: "center", gap: 8 },
    titleChip: { flexShrink: 1, overflow: "hidden" },
    eyebrow: {
      fontSize: 10,
      letterSpacing: 1.1,
      fontFamily: fonts.bold,
      color: c.violet,
      marginBottom: 1,
    },
    title: { fontSize: 16, fontFamily: fonts.bold, color: c.navy },
    closeBtn: {
      width: 40,
      height: 40,
      borderRadius: 20,
      alignItems: "center",
      justifyContent: "center",
      backgroundColor: c.bg,
      borderWidth: 1,
      borderColor: c.border,
    },
    hintWrap: {
      position: "absolute",
      top: 0,
      left: 0,
      right: 0,
      bottom: 0,
      alignItems: "center",
      justifyContent: "center",
    },
    hint: { fontSize: 15, fontFamily: fonts.medium, color: "#a9a394" },
    // Icon-only at drawer widths — the label lives in the accessibilityLabel.
    toolBtn: {
      alignItems: "center",
      justifyContent: "center",
      width: 40,
      height: 40,
      borderRadius: 12,
      backgroundColor: c.bg,
      borderWidth: 1,
      borderColor: c.border,
    },
    toolBtnDisabled: { opacity: 0.4 },
    primaryBtn: {
      height: 40,
      borderRadius: 12,
      alignItems: "center",
      justifyContent: "center",
      backgroundColor: c.violet,
      paddingHorizontal: 14,
      flexShrink: 1,
    },
    primaryBtnDisabled: { backgroundColor: c.gray300 },
    primaryBtnText: { fontSize: 14, fontFamily: fonts.bold, color: c.white },
    pressed: { opacity: 0.72 },
  });
}

export default Scratchpad;
