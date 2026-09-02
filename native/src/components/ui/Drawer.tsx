/**
 * Drawer — the app's ONE canonical sheet/drawer primitive.
 *
 * Slides in from an EDGE and can be flung back off it. One mechanism, two
 * anchors (plan §12: sheets on native):
 *
 *   • side="bottom" (default) — a full-width sheet anchored to the bottom edge,
 *     sliding on `translateY`. This is the sky map (StarDrawer) / tree map
 *     (NodeSheet) geometry. Grabber is a horizontal bar at top-center; the
 *     dismiss gesture is a downward drag on the HEADER (so a scrolling body
 *     underneath keeps its own vertical scroll — no gesture contention).
 *   • side="right" — a tall drawer anchored to the right edge, sliding on
 *     `translateX`. Grabber is a vertical bar at the left-center seam; the
 *     dismiss gesture is a rightward drag anywhere on the panel (horizontal, so
 *     a vertically-scrolling body never fights it — `failOffsetY` yields to the
 *     scroll, `activeOffsetX` claims the rightward fling).
 *
 * Shared mechanics, both sides:
 *   • The panel slides on ONE `pos` shared value: spring-IN on open,
 *     ease/timing-OUT on close.
 *   • The BACKDROP fades IN PLACE on a SEPARATE `backdropOpacity` value — it
 *     NEVER slides, so its edge never sweeps the screen (the seam a sliding
 *     scrim reintroduces). During a dismiss drag it dims proportionally to how
 *     far the panel has been pulled toward the edge.
 *   • Tap the backdrop to dismiss; an inner Pressable swallows taps inside.
 *   • Children stay MOUNTED through the close animation (a `rendered` latch) so
 *     the panel never blanks mid-slide.
 *   • Safe-area insets; a grabber; reduce-motion snaps instead of animating.
 *
 * The dim is the same calm neutral scrim as StarDrawer/NodeSheet
 * (rgba(0,0,0,0.38)) — never a heavy black scrim (§7.5: calm, never overstimulating).
 *
 * CRASH NOTE (2026-07-28): the close unmount is scheduled on a plain JS
 * setTimeout, NOT a withTiming completion callback. That callback runs as a UI
 * worklet, and `runOnJS(setRendered)(false)` from there marshals across the
 * UI→JS boundary; with React Compiler enabled that path aborts natively inside
 * react-native-worklets (SIGABRT). A timer stays on the JS thread and is
 * behaviourally identical (the close animation is a fixed duration). The
 * gesture's own `runOnJS(onClose)()` is the DIFFERENT, safe idiom — a zero-arg
 * call from `Gesture.Pan().onEnd`, exactly as Sky does (the Scratchpad host is
 * currently dormant).
 *
 * FOLLOW-UP (out of scope): StarDrawer + NodeSheet are the two sheets this was
 * distilled from and the obvious candidates to migrate onto it.
 */

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  Pressable,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import { SymbolView } from "expo-symbols";
import Animated, {
  clamp,
  Easing,
  runOnJS,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withSpring,
  withTiming,
} from "react-native-reanimated";

import { fonts, useColors } from "@/theme";

type Props = {
  open: boolean;
  onClose: () => void;
  title: string;
  eyebrow?: string;
  children: ReactNode;
  /** Which edge the drawer is anchored to. Default "bottom". */
  side?: "bottom" | "right";
  /** side="bottom": height as a fraction of the screen height. */
  heightFraction?: number;
  /** side="right": width as a fraction of the screen width (clamped 320–460). */
  widthFraction?: number;
};

const OPEN_SPRING = { damping: 32, stiffness: 380, mass: 0.85 };
const CLOSE_MS = 190;

export function Drawer({
  open,
  onClose,
  title,
  eyebrow,
  children,
  side = "bottom",
  heightFraction = 0.7,
  widthFraction = 0.42,
}: Props) {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const { width: screenW, height: screenH } = useWindowDimensions();
  const reduceMotion = useReducedMotion();
  const isRight = side === "right";

  // The travel axis' extent (height for bottom, width for right) and how far
  // off-screen the panel parks when closed.
  const extent = isRight
    ? Math.round(clampJS(screenW * widthFraction, 320, 460))
    : Math.round(screenH * heightFraction);
  const offscreen = extent + (isRight ? insets.right : insets.bottom) + 48;

  const pos = useSharedValue(offscreen);
  const backdropOpacity = useSharedValue(0);

  // Keep the panel mounted through the close animation so its content doesn't
  // blank mid-slide. Latched on when opening; dropped only after the slide-out
  // settles (or immediately, under reduce-motion). Unmount via a JS timer — see
  // the CRASH NOTE at the top of the file.
  const [rendered, setRendered] = useState(open);
  const prevOpen = useRef(open);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clearCloseTimer = () => {
    if (closeTimer.current) {
      clearTimeout(closeTimer.current);
      closeTimer.current = null;
    }
  };

  useEffect(() => {
    if (open === prevOpen.current) return;
    prevOpen.current = open;

    if (open) {
      clearCloseTimer();
      // eslint-disable-next-line react-hooks/set-state-in-effect -- The drawer must render before its open transition can start.
      setRendered(true);
      if (reduceMotion) {
        backdropOpacity.set(1);
        pos.set(0);
      } else {
        backdropOpacity.set(withTiming(1, { duration: 220 }));
        pos.set(withSpring(0, OPEN_SPRING));
      }
    } else if (reduceMotion) {
      backdropOpacity.set(0);
      pos.set(offscreen);
      setRendered(false);
    } else {
      backdropOpacity.set(withTiming(0, { duration: CLOSE_MS }));
      pos.set(withTiming(offscreen, {
        duration: CLOSE_MS,
        easing: Easing.in(Easing.cubic),
      }));
      clearCloseTimer();
      closeTimer.current = setTimeout(() => setRendered(false), CLOSE_MS + 20);
    }
  }, [open, reduceMotion, offscreen, pos, backdropOpacity]);

  // Clear a pending unmount timer if the component itself unmounts first.
  useEffect(() => clearCloseTimer, []);

  // Swipe-to-dismiss. Drag the panel toward its edge; release past a distance
  // OR flick fast enough and it closes (React's `open` prop then drives the
  // rest of the slide-out via the effect above). Otherwise it springs home.
  const dismiss = useMemo(() => {
    const DIST = extent * (isRight ? 0.32 : 0.28);
    const VEL = isRight ? 700 : 800;
    let pan = Gesture.Pan();
    if (isRight) {
      // Horizontal fling; yield to a vertical scroll underneath.
      pan = pan.activeOffsetX(20).failOffsetY([-16, 16]);
    } else {
      pan = pan.activeOffsetY(10);
    }
    return pan
      .onUpdate((e) => {
        const d = Math.max(0, isRight ? e.translationX : e.translationY);
        pos.set(d);
        backdropOpacity.set(clamp(1 - d / extent, 0, 1));
      })
      .onEnd((e) => {
        const d = Math.max(0, isRight ? e.translationX : e.translationY);
        const v = isRight ? e.velocityX : e.velocityY;
        if (d > DIST || v > VEL) {
          runOnJS(onClose)();
        } else {
          pos.set(withSpring(0, OPEN_SPRING));
          backdropOpacity.set(withTiming(1, { duration: 160 }));
        }
      });
  }, [isRight, extent, onClose, pos, backdropOpacity]);

  const backdropStyle = useAnimatedStyle(() => ({ opacity: backdropOpacity.get() }));
  const panelStyle = useAnimatedStyle(() =>
    isRight
      ? { transform: [{ translateX: pos.get() }] }
      : { transform: [{ translateY: pos.get() }] },
  );

  if (!rendered) return null;

  const header = (
    <View style={styles.header}>
      <View style={styles.headerText}>
        {eyebrow ? (
          <Text style={[styles.eyebrow, { color: colors.fgMuted }]}>{eyebrow}</Text>
        ) : null}
        <Text style={[styles.title, { color: colors.fg }]}>{title}</Text>
      </View>
      <Pressable
        onPress={onClose}
        hitSlop={12}
        accessibilityRole="button"
        accessibilityLabel="Close"
      >
        <SymbolView name="xmark.circle.fill" tintColor={colors.gray300} size={26} />
      </Pressable>
    </View>
  );

  const body = <View style={styles.body}>{children}</View>;

  // On the RIGHT drawer the whole panel is swipeable (horizontal drag won't
  // fight a vertical scroll), so the detector wraps everything. On the BOTTOM
  // sheet only the header is a drag handle, so a scrolling body keeps its
  // vertical scroll — the detector wraps just the grabber + header.
  const panel = isRight ? (
    <GestureDetector gesture={dismiss}>
      <Pressable style={styles.inner} onPress={() => {}} accessible={false}>
        <View style={[styles.grabberRight, { backgroundColor: colors.gray300 }]} />
        {header}
        {body}
      </Pressable>
    </GestureDetector>
  ) : (
    <Pressable style={styles.inner} onPress={() => {}} accessible={false}>
      <GestureDetector gesture={dismiss}>
        <View>
          <View style={[styles.grabber, { backgroundColor: colors.gray300 }]} />
          {header}
        </View>
      </GestureDetector>
      {body}
    </Pressable>
  );

  return (
    <>
      {/* Backdrop — fades IN PLACE (never slides); tap to dismiss. */}
      <Animated.View style={[StyleSheet.absoluteFill, styles.backdrop, backdropStyle]}>
        <Pressable style={StyleSheet.absoluteFill} onPress={onClose} accessibilityLabel="Dismiss" />
      </Animated.View>

      <Animated.View
        style={[
          isRight
            ? {
                ...styles.panelRight,
                width: extent,
                paddingTop: insets.top + 10,
                paddingBottom: insets.bottom,
                paddingRight: insets.right,
              }
            : {
                ...styles.panelBottom,
                height: extent,
                paddingBottom: insets.bottom,
              },
          { backgroundColor: colors.bg },
          panelStyle,
        ]}
      >
        {panel}
      </Animated.View>
    </>
  );
}

// A plain-JS clamp for layout math (reanimated's `clamp` is a worklet helper).
function clampJS(n: number, lo: number, hi: number) {
  return Math.min(hi, Math.max(lo, n));
}

const styles = StyleSheet.create({
  backdrop: { backgroundColor: "rgba(0,0,0,0.38)" },
  panelBottom: {
    position: "absolute",
    bottom: 0,
    left: 0,
    right: 0,
    borderTopLeftRadius: 28,
    borderTopRightRadius: 28,
    paddingTop: 10,
  },
  panelRight: {
    position: "absolute",
    top: 0,
    bottom: 0,
    right: 0,
    borderTopLeftRadius: 24,
    borderBottomLeftRadius: 24,
    paddingLeft: 8,
  },
  inner: { flex: 1 },
  grabber: {
    alignSelf: "center",
    width: 40,
    height: 5,
    borderRadius: 3,
    marginBottom: 12,
  },
  grabberRight: {
    position: "absolute",
    left: 2,
    top: "50%",
    marginTop: -22,
    width: 5,
    height: 44,
    borderRadius: 3,
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingHorizontal: 18,
    paddingBottom: 10,
  },
  headerText: { flex: 1 },
  eyebrow: {
    fontFamily: fonts.semibold,
    fontSize: 11,
    letterSpacing: 0.6,
    textTransform: "uppercase",
    marginBottom: 2,
  },
  title: { fontFamily: fonts.bold, fontSize: 18 },
  body: { flex: 1, paddingHorizontal: 18 },
});
