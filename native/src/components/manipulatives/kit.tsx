/**
 * A tiny "mini-Mafs for React Native" — just enough of Mafs's coordinate-plane
 * + movable-point idea to port a spec-driven manipulative to the native iPad app
 * WITHOUT the DOM-only Mafs library. Two pieces:
 *
 *   • CoordinatePlane — maps spec/math coordinates onto pixels for a given
 *     viewBox {x:[min,max], y:[min,max]} and pixel size (the same mental model as
 *     Mafs's `viewBox`). SVG's y grows downward, so `y()` inverts.
 *
 *   • useMovableHandle — the RN analogue of Mafs's `useMovablePoint`. It owns a
 *     handle position in MATH coordinates, runs a `constrain` worklet (clamp +
 *     snap in math space, exactly like Mafs's `constrain`) on the UI thread, and
 *     drives the handle via reanimated shared values so the finger-follow never
 *     round-trips through JS mid-drag. It carries the shared tactility feel: the
 *     knob GROWS (squishing under the finger) and holds enlarged for the whole
 *     drag on grab, SHRINKS back on release (plus a light impact), fires a
 *     clearly-felt MEDIUM impact on grab and a rate-limited selection tick on
 *     each discrete snap crossing (haptics only — no per-step size change) — see
 *     the tactility kit below — and reports the settled/live value back to JS
 *     (via runOnJS) so the pure `*Solved` predicates can run there.
 *
 * NOTE ON HAPTICS HARDWARE: no iPad has a Taptic engine, so on the iPad target
 * EVERY expo-haptics call here is a silent hardware no-op (the API exists and
 * won't throw, but nothing is felt — confirmed Apple behaviour). On iPad the
 * felt tactility therefore comes from the VISUAL squish/pop below PLUS a subtle
 * AUDIO tick (see ./kitAudio): the same kit helpers that fire haptics also play
 * a tiny, quiet UI sound, so every place a haptic would fire gets a felt-ish
 * cue on hardware that can't buzz. The haptics are kept because they cost
 * nothing on iPad and are correct where hardware supports it (an iPhone); the
 * audio ticks RESPECT the iOS mute switch, so a classroom can silence them.
 *
 * gesture-handler here is v2.31 (NOT v3), so there is no per-SVG-element
 * GestureDetector. The movable handle is therefore a real RN <Animated.View>
 * with a generous (>= 44px radius) transparent hit target, wrapped in its own
 * container-level <GestureDetector> — SVG draws only the static, non-interactive
 * linework beneath it.
 */

import * as Haptics from "expo-haptics";
import * as manipAudio from "./kitAudio";
import { createContext, useCallback, useContext, type RefObject } from "react";
import {
  StyleSheet,
  View,
  type AccessibilityValue,
  type StyleProp,
  type ViewStyle,
} from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import Animated, {
  Easing,
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withSequence,
  withTiming,
  type SharedValue,
} from "react-native-reanimated";
import { snapIndex } from "./snap";

export type Vec2 = { x: number; y: number };
export type ViewBox = { x: [number, number]; y: [number, number] };

/** The framework-agnostic renderer contract, matching the web `KindProps`. */
export interface KindProps<Spec, State> {
  spec: Spec;
  onSolvedChange: (solved: boolean) => void;
  onStateChange?: (state: State) => void;
}

/** Generous transparent touch radius — bigger than the 44pt HIG minimum. */
const HIT_RADIUS = 46;

/** Width (px) of the knob's white contrast ring. */
const KNOB_RING_WIDTH = 3;

/**
 * Gesture arbitration with an enclosing scroll surface. On Fabric + RNGH v2 an
 * enclosing ScrollView WINS over a child `Gesture.Pan()` (even a purely
 * horizontal drag scrolls the page instead of moving the handle — verified in
 * the spike). The fix is "the handle owns any touch that starts on it": the
 * screen provides its scrollable's ref via this context, and every handle pan
 * `blocksExternalGesture(scrollRef)` so the scroll waits for the pan to fail.
 * The scrollable must be the react-native-gesture-handler ScrollView so RNGH
 * can arbitrate. Scrolling anywhere OUTSIDE a handle is unaffected.
 */
export const ManipulativeScrollContext =
  createContext<RefObject<unknown> | null>(null);

/**
 * Maps math coordinates to pixels for a fixed viewBox + pixel size (like Mafs's
 * `viewBox`). Pure data + math — never touched inside a worklet (worklets read
 * the flattened primitives below instead of calling these methods).
 */
export class CoordinatePlane {
  readonly minX: number;
  readonly maxX: number;
  readonly minY: number;
  readonly maxY: number;
  readonly width: number;
  readonly height: number;
  /** Pixels per one math unit along each axis. */
  readonly pxPerX: number;
  readonly pxPerY: number;

  constructor(viewBox: ViewBox, size: { width: number; height: number }) {
    this.minX = viewBox.x[0];
    this.maxX = viewBox.x[1];
    this.minY = viewBox.y[0];
    this.maxY = viewBox.y[1];
    this.width = size.width;
    this.height = size.height;
    this.pxPerX = size.width / (this.maxX - this.minX);
    this.pxPerY = size.height / (this.maxY - this.minY);
  }

  /** Math x → pixel x. */
  x(mx: number): number {
    return (mx - this.minX) * this.pxPerX;
  }
  /** Math y → pixel y (inverted: math-up becomes pixel-down). */
  y(my: number): number {
    return this.height - (my - this.minY) * this.pxPerY;
  }
}

// ── shared tactility kit ─────────────────────────────────────────────────────
// One feel for all 9 kinds — never per-kind bespoke haptics. The events:
//   • grab of a dragged handle      → MEDIUM impact (clearly felt) + the knob
//     GROWS and HOLDS enlarged (squishes under the finger) for the whole drag
//   • crossing a DISCRETE step      → selection tick ONLY (one per cell:
//     number-line ticks, grid cells, array rows/cols, split columns, stepper
//     increments) — NO size change per step
//   • release of a dragged handle   → the knob SHRINKS back to rest + a light impact
//   • tap / press of a tappable piece → selection tick + a scale POP (usePressPop)
//   • Done graded                    → success (correct) / warning (incorrect) notification
// All are fire-and-forget: `fireHaptic` swallows BOTH a synchronous throw (the
// native module isn't in this build) and a rejected promise (no Taptic engine),
// so a call is always a safe no-op where haptics are unsupported.
//
// ⚠️ iPad has NO Taptic engine, so on the iPad target every haptic helper below
// is a silent HARDWARE no-op — nothing is felt no matter how correct the call
// is. The felt tactility on iPad is the VISUAL squish/pop PLUS a subtle AUDIO
// tick (./kitAudio), wired into these SAME helpers so it fires everywhere a
// haptic would; the haptics still fire on haptic-capable hardware (an iPhone).

/**
 * Master kill-switch for the manipulatives' AUDIO ticks (the iPad haptics
 * substitute — see ./kitAudio). Flip to `false` to silence ALL manipulative
 * sounds in one line; the haptics + visuals are unaffected. The audio also
 * respects the iOS mute switch, so this is only for turning the feature off
 * wholesale.
 */
export const MANIP_AUDIO_ENABLED = true;

/**
 * Fire a haptic without ever throwing. Guards two independent failure modes:
 *   • the Expo native module is missing from the installed binary (older build)
 *     → the call throws synchronously,
 *   • the device has no Taptic engine (every iPad; a silenced iPhone)
 *     → the returned promise rejects.
 * Both are swallowed so haptics are strictly best-effort feedback.
 */
function fireHaptic(run: () => Promise<unknown> | void): void {
  try {
    const result = run();
    if (result && typeof (result as Promise<unknown>).catch === "function") {
      (result as Promise<unknown>).catch(() => {});
    }
  } catch {
    /* no native module / no haptic hardware — ignore */
  }
}

/** A light selection haptic — the "you moved one notch" tick (snap crossing). */
export function selectionTick(): void {
  fireHaptic(() => Haptics.selectionAsync());
  if (MANIP_AUDIO_ENABLED) manipAudio.playSnapTick();
}

/** A MEDIUM impact — the clearly-felt "you grabbed the handle" thunk (grab). */
export function mediumImpact(): void {
  fireHaptic(() => Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium));
  if (MANIP_AUDIO_ENABLED) manipAudio.playGrabTick();
}

/** A light impact — the "a piece landed / committed" thud (drop / release). */
export function lightImpact(): void {
  fireHaptic(() => Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light));
  if (MANIP_AUDIO_ENABLED) manipAudio.playPlacedThock();
}

/** A success notification — a correctly-graded answer. */
export function successNotify(): void {
  fireHaptic(() =>
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success),
  );
  if (MANIP_AUDIO_ENABLED) manipAudio.playSuccess();
}

/** A warning notification — an incorrectly-graded answer. */
export function warningNotify(): void {
  fireHaptic(() =>
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning),
  );
  if (MANIP_AUDIO_ENABLED) manipAudio.playTryAgain();
}

/** The tap pop: scale up ~12% then straight back, ~120ms total, NO bounce. */
export const POP_MS = 120;
export const POP_SCALE = 1.12;
/**
 * The dragged-handle "squish": on grab the knob GROWS to GRAB_SCALE and HOLDS
 * there for the whole drag; on release it SHRINKS back to rest. A quick,
 * bounce-free ease so it reads as squishing down under the finger, not a pulse.
 */
export const GRAB_SCALE = 1.12;
export const GRAB_MS = 120;
/**
 * Min gap between a DRAGGED handle's selection ticks. A fast drag can cross many
 * discrete cells in a few frames; without this it would fire a haptic per cell
 * and machine-gun the Taptic engine. At normal drag speed cells are far enough
 * apart that every crossing still ticks — this only thins out the extremes.
 * (Deliberate taps use `usePressPop`, which is NOT throttled.)
 */
export const POP_MIN_GAP_MS = 45;

/** The Reanimated scale pulse behind a TAP pop (usePressPop only). */
function popSequence() {
  return withSequence(
    withTiming(POP_SCALE, { duration: POP_MS / 2, easing: Easing.out(Easing.quad) }),
    withTiming(1, { duration: POP_MS / 2, easing: Easing.in(Easing.quad) }),
  );
}

export interface PressPop {
  /** Spread onto the Animated.View you want to pop. */
  style: ReturnType<typeof useAnimatedStyle>;
  /** Fire on grab/press: selection haptic + the scale pop. Safe from JS or runOnJS. */
  pop: () => void;
  /** The raw scale shared value, for callers that compose their own animated style. */
  scale: SharedValue<number>;
}

/**
 * The shared "press pop" for any tappable manipulative element (a Factor Game
 * cell, a wedge) — a selection haptic paired with a quick scale pulse, so every
 * tap target across kinds feels the same. This is a TAP feel; a dragged handle
 * instead grows-and-holds under the finger (see `useMovableHandle`).
 */
export function usePressPop(): PressPop {
  const scale = useSharedValue(1);
  const pop = useCallback(() => {
    selectionTick();
    scale.set(popSequence());
  }, [scale]);
  const style = useAnimatedStyle(() => ({ transform: [{ scale: scale.get() }] }));
  return { style, pop, scale };
}

export interface MovableHandleConfig {
  plane: CoordinatePlane;
  /** Starting position, in MATH coordinates. */
  initial: Vec2;
  /**
   * A WORKLET (must carry the `'worklet'` directive) mapping a raw math point to
   * a legal one — clamp + optional snap, exactly like Mafs's `useMovablePoint`
   * `constrain`. Runs on the UI thread every frame so snapping is jank-free.
   */
  constrain: (p: Vec2) => Vec2;
  /**
   * Snap increment (math units) along `snapAxis`. When set, a haptic
   * `selectionAsync` fires ONLY as the handle crosses into a new increment.
   */
  snapIncrement?: number;
  snapAxis?: "x" | "y";
  /**
   * Touch-target radius in px. Defaults to `HIT_RADIUS` (46 → a 92px target),
   * which is the right answer for a lone handle. Shrink it only when two
   * handles must coexist close together and the big default would let one
   * swallow the other — the Clock's two concentric hands are the case this
   * exists for. Keep it >= 22 (Apple's 44pt minimum is a DIAMETER, not a radius).
   */
  hitRadius?: number;
  /** Live position report (runOnJS) — throttled to snap crossings when snapping. */
  onChange?: (p: Vec2) => void;
  /** Settled position report on release (runOnJS). */
  onSettled?: (p: Vec2) => void;
}

export interface MovableHandle {
  gesture: ReturnType<typeof Gesture.Pan>;
  /** Animated style that centers the hit target on the handle's pixel position. */
  style: ReturnType<typeof useAnimatedStyle>;
  mx: SharedValue<number>;
  my: SharedValue<number>;
  /**
   * Fire the discrete-snap selection haptic (rate-limited; NO size change).
   * Fired automatically on every single-axis snap crossing; exposed so a 2D
   * kind (e.g. Array, which snaps on BOTH axes via its own reaction) can fire
   * the SAME tick.
   */
  snapTick: () => void;
  /** The touch-target radius this handle was built with (px). */
  hitRadius: number;
}

/**
 * The RN analogue of Mafs's `useMovablePoint`. Returns a Pan `gesture` (wrap the
 * handle view in a `<GestureDetector>`), an animated `style` positioning it, and
 * the live math-space shared values.
 */
export function useMovableHandle(cfg: MovableHandleConfig): MovableHandle {
  const {
    plane,
    initial,
    constrain,
    snapIncrement,
    snapAxis = "x",
    onChange,
    onSettled,
    hitRadius = HIT_RADIUS,
  } = cfg;

  // Flatten every plane value the worklets need into primitives — a worklet
  // can't call the class's methods, but it can capture plain numbers.
  const { minX, minY, height, pxPerX, pxPerY } = plane;
  const reportEpsilon = (plane.maxX - plane.minX) / 500;

  const mx = useSharedValue(initial.x);
  const my = useSharedValue(initial.y);
  const startX = useSharedValue(0);
  const startY = useSharedValue(0);
  // Seed the snap index from the handle's START position (JS thread, via the
  // pure `snapIndex`) so the first drag frame only ticks if it genuinely
  // crosses a boundary — never a spurious tick stacked on top of the grab pop.
  const lastSnapIndex = useSharedValue(
    snapIndex(snapAxis === "y" ? initial.y : initial.x, snapIncrement ?? 0),
  );
  const lastReportedX = useSharedValue(Number.NaN);

  // The knob's grab "squish": grows to GRAB_SCALE on grab and HOLDS there for
  // the whole drag, then shrinks back on release (driven in the gesture worklets
  // below). Rest = 1.
  const grabScale = useSharedValue(1);
  // The discrete-snap selection haptic — a rate-limited (POP_MIN_GAP_MS) tick on
  // grab and on every discrete snap crossing. Haptics ONLY, no size change.
  const lastTickMs = useSharedValue(0);
  const snapTick = useCallback(() => {
    const now = Date.now();
    if (now - lastTickMs.get() < POP_MIN_GAP_MS) return;
    lastTickMs.set(now);
    selectionTick();
  }, [lastTickMs]);

  const scrollRef = useContext(ManipulativeScrollContext);

  // Built directly in the hook body (not memoised) so the Reanimated worklet
  // plugin recognises the gesture callbacks as worklets — matching the app's
  // sky.tsx idiom. GestureDetector diffs the gesture object for us.
  let gesture = Gesture.Pan()
    .minDistance(0)
    .onBegin(() => {
      startX.set(mx.get());
      startY.set(my.get());
      // Re-seed the snap index to where the grab starts, so a crossing is
      // measured from here (not a stale index from the previous drag).
      if (snapIncrement && snapIncrement > 0) {
        lastSnapIndex.set(Math.round(
          (snapAxis === "y" ? my.get() : mx.get()) / snapIncrement,
        ));
      }
      // Grab: grow the knob and HOLD (squish under the finger) — quick ease-out,
      // no overshoot — plus a clearly-felt MEDIUM impact (was a subtle selection
      // tick; grab is the moment a firm buzz reads best on haptic hardware).
      grabScale.set(withTiming(GRAB_SCALE, {
        duration: GRAB_MS,
        easing: Easing.out(Easing.quad),
      }));
      runOnJS(mediumImpact)();
    })
    .onUpdate((e) => {
      // Pixel translation → math delta (y inverted), then constrain in math
      // space on the UI thread. The visual follows the finger with zero JS
      // round-trip; only the value report crosses to JS.
      const rawX = startX.get() + e.translationX / pxPerX;
      const rawY = startY.get() - e.translationY / pxPerY;
      const c = constrain({ x: rawX, y: rawY });
      mx.set(c.x);
      my.set(c.y);

      if (snapIncrement && snapIncrement > 0) {
        const idx = Math.round((snapAxis === "y" ? c.y : c.x) / snapIncrement);
        if (idx !== lastSnapIndex.get()) {
          lastSnapIndex.set(idx);
          runOnJS(snapTick)(); // one selection tick per discrete cell crossed (no size change)
          if (onChange) runOnJS(onChange)(c);
        }
      } else if (onChange) {
        const axisVal = snapAxis === "y" ? c.y : c.x;
        if (
          Number.isNaN(lastReportedX.get()) ||
          Math.abs(axisVal - lastReportedX.get()) > reportEpsilon
        ) {
          lastReportedX.set(axisVal);
          runOnJS(onChange)(c);
        }
      }
    })
    .onFinalize(() => {
      // Release: shrink the knob back to rest (quick ease) + the light "landed" impact.
      grabScale.set(withTiming(1, {
        duration: GRAB_MS,
        easing: Easing.out(Easing.quad),
      }));
      runOnJS(lightImpact)(); // the dragged piece dropped / committed
      if (onSettled) runOnJS(onSettled)({ x: mx.get(), y: my.get() });
    });
  if (scrollRef) {
    gesture = gesture.blocksExternalGesture(
      scrollRef as Parameters<typeof gesture.blocksExternalGesture>[0],
    );
  }

  const style = useAnimatedStyle(() => {
    const px = (mx.get() - minX) * pxPerX;
    const py = height - (my.get() - minY) * pxPerY;
    return {
      transform: [
        { translateX: px - hitRadius },
        { translateY: py - hitRadius },
        { scale: grabScale.get() },
      ],
    };
  });

  return { gesture, style, mx, my, snapTick, hitRadius };
}

export interface MovableHandleViewProps {
  handle: MovableHandle;
  /** Fill color of the visible knob. */
  color: string;
  /** Even ring color around the knob (affordance; no glow/shadow). */
  ringColor: string;
  /** Visible knob radius in px (the touch target stays >= 44px regardless). */
  radius?: number;
  /**
   * Optional STABLE a11y id so an agent (or VoiceOver) can locate/grab this
   * specific handle — e.g. "number line thumb", "array corner handle". Purely
   * an accessibility label: with VoiceOver OFF (the puppeting default) it has
   * no effect on the pan gesture, touch, sizing, or haptics.
   */
  accessibilityLabel?: string;
  /** Current numeric position for adjustable handles such as a number line. */
  accessibilityValue?: AccessibilityValue;
  /** VoiceOver increment/decrement behavior for an adjustable handle. */
  onAccessibilityAdjust?: (direction: "increment" | "decrement") => void;
}

/**
 * The visible knob + its oversized transparent hit target, wired to the Pan
 * gesture. The hit target is HIT_RADIUS (>= 44px), the drawn knob much smaller —
 * so the whole thing reads as a small dot but is easy to grab.
 */
export function MovableHandleView({
  handle,
  color,
  ringColor,
  radius = 13,
  accessibilityLabel,
  accessibilityValue,
  onAccessibilityAdjust,
}: MovableHandleViewProps) {
  return (
    <GestureDetector gesture={handle.gesture}>
      <Animated.View
        style={[
          styles.hit,
          { width: handle.hitRadius * 2, height: handle.hitRadius * 2 },
          handle.style as StyleProp<ViewStyle>,
        ]}
        accessible={accessibilityLabel ? true : undefined}
        accessibilityLabel={accessibilityLabel}
        accessibilityRole={onAccessibilityAdjust ? "adjustable" : undefined}
        accessibilityValue={accessibilityValue}
        accessibilityActions={
          onAccessibilityAdjust
            ? [{ name: "increment" }, { name: "decrement" }]
            : undefined
        }
        onAccessibilityAction={
          onAccessibilityAdjust
            ? (event) => {
                const action = event.nativeEvent.actionName;
                if (action === "increment" || action === "decrement") {
                  onAccessibilityAdjust(action);
                }
              }
            : undefined
        }
      >
        {/* Two stacked OPAQUE discs, not one bordered fill. The old single View
            (backgroundColor: color + borderWidth/borderColor) tripped a
            well-known iOS artifact: the rounded background layer is composited a
            hair beyond the border's anti-aliased outer edge, leaking a jagged
            colored fringe (the "purple outline") OUTSIDE the white ring. Here
            the OUTERMOST painted layer IS the white ring disc, so its edge
            anti-aliases cleanly against transparency, and the colored fill —
            fully contained inside it — can never bleed past it. Same look as
            before (color to r−ring, white ring to r), minus the fringe. */}
        <View
          style={{
            width: radius * 2,
            height: radius * 2,
            borderRadius: radius,
            backgroundColor: ringColor,
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <View
            style={{
              width: (radius - KNOB_RING_WIDTH) * 2,
              height: (radius - KNOB_RING_WIDTH) * 2,
              borderRadius: radius - KNOB_RING_WIDTH,
              backgroundColor: color,
            }}
          />
        </View>
      </Animated.View>
    </GestureDetector>
  );
}

const styles = StyleSheet.create({
  hit: {
    position: "absolute",
    left: 0,
    top: 0,
    width: HIT_RADIUS * 2,
    height: HIT_RADIUS * 2,
    alignItems: "center",
    justifyContent: "center",
  },
});
