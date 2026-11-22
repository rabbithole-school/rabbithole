import { Canvas, Fill, Shader, Skia } from "@shopify/react-native-skia";
import { useEffect, useState, type JSX } from "react";
import { AccessibilityInfo, StyleSheet } from "react-native";
import {
  useDerivedValue,
  useFrameCallback,
  useSharedValue,
} from "react-native-reanimated";

/**
 * The "you've turned away" attention-getter for the head-direction half of the
 * decibel meter. Very wide white and black chevrons sweep across the half in
 * the direction the presenter's head has to turn to face the room again, so
 * the flicker they catch in the corner of their eye also says which way to go.
 */

// Photosensitivity: every pixel goes light-dark-light at most this many times
// a second. WCAG 2.3.1 allows three; we stay at half of that for a classroom
// with children. Turning the pattern spends from this same budget (see below).
const SWEEP_HZ = 1.5;
// Reduce Motion swaps the sweep for an edge glow that breathes once a second.
const GLOW_HZ = 1;
const FADE_S = 0.15;
// How quickly the pattern swings round to a new direction when it is free to.
const TURN_S = 0.2;
// One white-plus-black band pair, as a multiple of the half's short side. It is
// longer than the half is wide, so the edges are mostly white, then mostly
// black: narrower bands average out to gray in peripheral vision.
const WAVELENGTH = 1.1;
// How far the chevron arms sweep back. The point of the V leads, like an arrow.
const CHEVRON = 0.45;

// One shader draws the whole thing per pixel, on the UI thread.
const effect = Skia.RuntimeEffect.Make(`
uniform float2 size;
uniform float2 dir;
uniform float known;
uniform float phase;
uniform float gain;
uniform float still;
uniform float4 base;

half4 main(float2 xy) {
  float2 sz = max(size, float2(1.0));
  float2 p = (xy - 0.5 * sz) / min(sz.x, sz.y);
  float along = dot(p, dir);
  float across = dot(p, float2(-dir.y, dir.x));
  // Bands of equal s are V shapes whose point is furthest along dir.
  float s = along + ${CHEVRON.toFixed(2)} * abs(across);
  // Subtracting a growing phase moves each band toward larger s: along dir.
  // With no known direction the s term drops out and the edges blink together.
  float wave = sin(6.2831853 * (known * s / ${WAVELENGTH.toFixed(2)} - phase));
  // Nearly hard-edged, so each band is white or black with little gray between.
  float band = smoothstep(-0.25, 0.25, wave);

  // The head drawing, its angles line and the big word are white ink in a
  // column below the camera picture. Inside that column the bands only swing
  // between the base gray and black, so the ink always sits on a dark ground;
  // toward the edges they open up to full white.
  float2 q = abs(xy / sz - float2(0.5, 0.57)) / float2(0.30, 0.31);
  float rim = smoothstep(1.0, 1.3, pow(pow(q.x, 4.0) + pow(q.y, 4.0), 0.25));
  float3 moving = mix(base.rgb, mix(base.rgb, float3(1.0), rim) * band, gain);

  // Reduce Motion: a glow on the edge the presenter should turn toward, or on
  // every edge when the direction is unknown. Nothing travels.
  float side = mix(1.0, smoothstep(-0.1, 0.55, along), known);
  float glow = 0.5 - 0.5 * cos(6.2831853 * phase);
  float3 calm = mix(base.rgb, float3(1.0), rim * side * glow * 0.6 * gain);
  return half4(still > 0.5 ? calm : moving, 1.0);
}`);

export function AwayNudge(props: {
  /** Run while true; fade out over 150 ms and render nothing while false. */
  active: boolean;
  /** The half's steady background (dark gray). */
  baseColor: string;
  /**
   * Which way to nudge, as the presenter sees the screen: x + is right, y + is
   * down, length 1. Null when no face is in view and the way back is unknown.
   */
  toward: { x: number; y: number } | null;
}): JSX.Element | null {
  const { active, baseColor, toward } = props;
  const tx = toward ? toward.x : null;
  const ty = toward ? toward.y : null;

  // Stay mounted through the fade-out, then render nothing.
  const [shown, setShown] = useState(active);
  if (active && !shown) setShown(true);

  const size = useSharedValue({ width: 0, height: 0 });
  const target = useSharedValue<{ x: number; y: number } | null>(toward);
  const angle = useSharedValue(0); // eased direction of travel, radians
  const known = useSharedValue(0); // 0 = blink in unison, 1 = sweep along angle
  const phase = useSharedValue(0); // 0..1, one full light-dark cycle
  const gain = useSharedValue(0); // 0..1 fade in and out
  const on = useSharedValue(active);
  const still = useSharedValue(false);

  // A frame clock on the UI thread drives everything, so there is no animation
  // callback that would have to hop back to JS.
  const frame = useFrameCallback((info) => {
    "worklet";
    // Clamp the step so a dropped frame can't jump the pattern.
    const dt = Math.min((info.timeSincePreviousFrame ?? 16) / 1000, 0.1);
    const { width, height } = size.get();
    const t = target.get();
    const want = t ? 1 : 0;
    const wantAngle = t ? Math.atan2(t.y, t.x) : angle.get();

    // Turning the pattern, or blending between sweep and blink, slides bands
    // past the pixels far from the centre, which adds to their flicker rate.
    // `reach` converts a turn (radians) into the most cycles any pixel can
    // gain from it. Each frame may spend only as much turn as the sweep would
    // have used, and the sweep slows by what was spent, so no pixel ever
    // flickers faster than SWEEP_HZ. A full reversal takes about 1.5 seconds.
    const reach =
      ((0.5 * Math.hypot(width, height)) / (Math.min(width, height) || 1)) *
      (Math.sqrt(1 + CHEVRON * CHEVRON) / WAVELENGTH);
    let budget = (dt * SWEEP_HZ) / reach;

    if (gain.get() === 0) {
      // Invisible, so start in the right pose instead of easing into it.
      known.set(want);
      angle.set(wantAngle);
      budget = 0;
    } else if (known.get() < 0.001) {
      // The angle has no effect while the edges blink in unison.
      angle.set(wantAngle);
    }

    const dk = Math.max(-budget, Math.min(budget, want - known.get()));
    known.set(known.get() + dk);
    budget -= Math.abs(dk);

    // Turn the short way round, easing in as the gap closes.
    const gap = wantAngle - angle.get();
    const err = Math.atan2(Math.sin(gap), Math.cos(gap));
    const turn = Math.max(
      -budget,
      Math.min(budget, err * Math.min(1, dt / TURN_S)),
    );
    angle.set(angle.get() + turn);

    const spent = (Math.abs(dk) + Math.abs(turn)) * reach;
    const advance = still.get()
      ? dt * GLOW_HZ
      : Math.max(0, dt * SWEEP_HZ - spent);
    // Wrapping at 1 is seamless because the shader only uses whole cycles.
    phase.set((phase.get() + advance) % 1);

    const step = dt / FADE_S;
    gain.set(
      on.get() ? Math.min(1, gain.get() + step) : Math.max(0, gain.get() - step),
    );
  }, false);

  useEffect(() => {
    target.set(tx === null || ty === null ? null : { x: tx, y: ty });
  }, [target, tx, ty]);

  useEffect(() => {
    on.set(active);
    if (active) {
      frame.setActive(true);
      return;
    }
    // Let the fade finish, then stop the clock and unmount.
    const id = setTimeout(() => {
      frame.setActive(false);
      setShown(false);
    }, FADE_S * 1000 + 50);
    return () => clearTimeout(id);
  }, [active, frame, on]);

  useEffect(() => {
    let live = true;
    void AccessibilityInfo.isReduceMotionEnabled().then((v) => {
      if (live) still.set(v);
    });
    const sub = AccessibilityInfo.addEventListener("reduceMotionChanged", (v) =>
      still.set(v),
    );
    return () => {
      live = false;
      sub.remove();
    };
  }, [still]);

  const base = Array.from(Skia.Color(baseColor));
  const uniforms = useDerivedValue(() => ({
    size: [size.get().width, size.get().height],
    dir: [Math.cos(angle.get()), Math.sin(angle.get())],
    known: known.get(),
    phase: phase.get(),
    gain: gain.get(),
    still: still.get() ? 1 : 0,
    base,
  }));

  if (!shown || !effect) return null;
  return (
    <Canvas style={StyleSheet.absoluteFill} onSize={size} pointerEvents="none">
      <Fill>
        <Shader source={effect} uniforms={uniforms} />
      </Fill>
    </Canvas>
  );
}
