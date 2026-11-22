import { useEffect, useRef, useState } from "react";
import { Text, View, type GestureResponderEvent } from "react-native";
import Svg, { Circle, G, Line, Path } from "react-native-svg";

import type { FacingZone, HeadNow } from "@/lib/facingRoom";
import { fonts } from "@/theme";

type Props = {
  head: HeadNow | null;
  zone: FacingZone;
  onZoneChange: (zone: FacingZone) => void;
  ink: string;
  size: number;
};

/** A point in head-radius units: x right, y up, z toward the viewer. */
type P3 = { x: number; y: number; z: number };
type Pose = { yaw: number; pitch: number };

const RAD = Math.PI / 180;
// The head is small and the cap sits on a much larger sphere, so the zone
// reads as a window in front of the head with the nose pointing through it.
// The sizes are chosen so the cap at ±30° is wider than the head, and at the
// widest setting it still fits the square.
const HEAD = 0.14; // head radius, as a share of the component's size
const CAP = 3.3; // cap sphere radius, in head radii
const NOSE = 1.3;
const TURN_MIN = 5;
const TURN_MAX = 80;
const TILT_MIN = 5;
const TILT_MAX = 60;
// How far the zone's centre may be moved: a BunnyPad set well off to one side.
const CENTER_YAW_MAX = 70;
const CENTER_PITCH_MAX = 45;
// Drawn as in a mirror, like the camera picture beside it: a turn to the
// presenter's left (yaw +) moves left on screen.
const MIRROR = -1;
// A touch this close to a corner resizes; elsewhere inside the cap it moves.
const CORNER_GRAB = 0.25;
// Past this the cap's edge folds behind the sphere and the outline crosses itself.
const DRAW_MAX = 88;

const clamp = (value: number, lo: number, hi: number) =>
  Math.min(hi, Math.max(lo, value));

/** Where a heading points. Yaw + moves right on screen, pitch + moves down. */
function direction(yaw: number, pitch: number, r = 1): P3 {
  const a = yaw * RAD;
  const b = pitch * RAD;
  return {
    x: r * Math.cos(b) * Math.sin(a),
    y: -r * Math.sin(b),
    z: r * Math.cos(b) * Math.cos(a),
  };
}

/** Turns a point on the front-on head to the live pose: pitch first, then yaw. */
function rotate(p: P3, yaw: number, pitch: number): P3 {
  const a = yaw * RAD;
  const b = pitch * RAD;
  const y = p.y * Math.cos(b) - p.z * Math.sin(b);
  const z = p.y * Math.sin(b) + p.z * Math.cos(b);
  return {
    x: p.x * Math.cos(a) + z * Math.sin(a),
    y,
    z: -p.x * Math.sin(a) + z * Math.cos(a),
  };
}

/** Behind the head and inside its outline means the head covers it. The small
 *  tolerance keeps the ears from flickering when they sit exactly side-on. */
const isVisible = (p: P3) => p.z > -0.02 || Math.hypot(p.x, p.y) > 1;

/** The heading whose cap-sphere point lands at (x, y), in cap-radius units
 *  with y pointing down the screen. The exact inverse of `direction`. */
function headingAt(x: number, y: number): { yaw: number; pitch: number } {
  const b = Math.asin(clamp(y, -1, 1));
  const a = Math.asin(clamp(x / Math.max(Math.cos(b), 0.05), -1, 1));
  return { yaw: a / RAD, pitch: b / RAD };
}

/** A full circle of constant height on the head (lat 0 is the eye line). */
function latitude(lat: number): P3[] {
  const points: P3[] = [];
  for (let t = 0; t <= 360; t += 10) points.push(direction(t, -lat));
  return points;
}

/** A great circle through the crown; lon 0 runs down the nose, 90 through the ears. */
function meridian(lon: number): P3[] {
  const points: P3[] = [];
  const l = lon * RAD;
  for (let t = 0; t <= 360; t += 10) {
    const c = Math.cos(t * RAD);
    points.push({ x: Math.sin(l) * c, y: Math.sin(t * RAD), z: Math.cos(l) * c });
  }
  return points;
}

const WIRES: P3[][] = [latitude(-40), latitude(0), latitude(40), meridian(0), meridian(90)];
const NOSE_LINE: P3[] = [direction(0, -4), direction(0, 7, NOSE), direction(0, 17)];
const MOUTH: P3[] = [-14, -7, 0, 7, 14].map((yaw) => direction(yaw, 34));
const EYES: P3[] = [direction(-24, -12), direction(24, -12)];
const EARS: P3[][] = [-1, 1].map((side) => [
  direction(side * 90, -16),
  direction(side * 93, -10, 1.13),
  direction(side * 93, 10, 1.13),
  direction(side * 90, 18),
]);

/** How quickly the drawn head catches up with a new reading: a time constant, in ms. */
const GLIDE_MS = 70;

/**
 * The pose to draw: it glides toward each new reading at the screen's frame
 * rate, so the head moves smoothly between Vision's readings (about 15 a
 * second) instead of jumping to each one.
 */
function useGlidingPose(target: Pose | null): Pose | null {
  const [shown, setShown] = useState<Pose | null>(null);
  const shownRef = useRef<Pose | null>(null);
  const goalYaw = target?.yaw;
  const goalPitch = target?.pitch;
  useEffect(() => {
    if (goalYaw === undefined || goalPitch === undefined) return;
    let frame = 0;
    let before: number | null = null;
    const step = (now: number) => {
      const from = shownRef.current ?? { yaw: goalYaw, pitch: goalPitch };
      const k = 1 - Math.exp(-(before === null ? 16 : now - before) / GLIDE_MS);
      before = now;
      const next = {
        yaw: from.yaw + (goalYaw - from.yaw) * k,
        pitch: from.pitch + (goalPitch - from.pitch) * k,
      };
      const arrived = Math.abs(goalYaw - next.yaw) < 0.1 && Math.abs(goalPitch - next.pitch) < 0.1;
      shownRef.current = arrived ? { yaw: goalYaw, pitch: goalPitch } : next;
      setShown(shownRef.current);
      if (!arrived) frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
  }, [goalYaw, goalPitch]);
  return target ? (shown ?? target) : null;
}

export function HeadPyramid({ head, zone, onZoneChange, ink, size }: Props) {
  const reading = head && head.kind !== "none" ? head : null;
  const glide = useGlidingPose(reading ? { yaw: reading.yaw, pitch: reading.pitch } : null);
  // The drawing follows the gliding pose; whether it's facing follows the reading itself.
  const live = reading && glide ? { ...reading, yaw: glide.yaw, pitch: glide.pitch } : null;
  // The last pose seen, so a presenter who steps out of frame leaves a faded
  // head where they were. Kept in state because render has to read it.
  const [last, setLast] = useState<Pose | null>(null);
  if (live && (live.yaw !== last?.yaw || live.pitch !== last?.pitch)) setLast({ yaw: live.yaw, pitch: live.pitch });
  const pose: Pose = live ?? last ?? { yaw: 0, pitch: 0 };

  const [dragging, setDragging] = useState(false);
  // A drag either moves the zone (from its centre point) or resizes it (from a corner).
  const drag = useRef({ moving: false, pageX: 0, pageY: 0, fromX: 0, fromY: 0, sx: 1, sy: 1 });

  const cx = size / 2;
  const cy = size / 2;
  const R = size * HEAD;
  const px = (p: P3) => cx + MIRROR * R * p.x;
  const py = (p: P3) => cy - R * p.y;
  const at = (p: P3) => `${px(p).toFixed(1)} ${py(p).toFixed(1)}`;

  /** An SVG path through the points, lifting the pen over hidden stretches. */
  const pathOf = (points: P3[], hide = true) => {
    let d = "";
    let penDown = false;
    for (const p of points) {
      if (hide && !isVisible(p)) {
        penDown = false;
        continue;
      }
      d += `${penDown ? "L" : "M"}${at(p)} `;
      penDown = true;
    }
    return d;
  };
  const posed = (points: P3[]) => points.map((p) => rotate(p, pose.yaw, pose.pitch));

  // The zone's four sides in heading space, around its centre.
  const capDir = (yaw: number, pitch: number, r = CAP) =>
    direction(clamp(yaw, -DRAW_MAX, DRAW_MAX), clamp(pitch, -DRAW_MAX, DRAW_MAX), r);
  const left = zone.centerYaw - zone.turnDeg;
  const right = zone.centerYaw + zone.turnDeg;
  const top = zone.centerPitch - zone.tiltDeg;
  const bottom = zone.centerPitch + zone.tiltDeg;
  const STEPS = 8;
  const capEdge: P3[] = [];
  for (let i = 0; i < STEPS; i++) capEdge.push(capDir(left + ((right - left) * i) / STEPS, top));
  for (let i = 0; i < STEPS; i++) capEdge.push(capDir(right, top + ((bottom - top) * i) / STEPS));
  for (let i = 0; i < STEPS; i++) capEdge.push(capDir(right - ((right - left) * i) / STEPS, bottom));
  for (let i = 0; i < STEPS; i++) capEdge.push(capDir(left, bottom - ((bottom - top) * i) / STEPS));
  const corners: [number, number][] = [
    [left, top],
    [right, top],
    [right, bottom],
    [left, bottom],
  ];

  const facing = live?.kind === "facing";
  const noseTip = live ? direction(live.yaw, live.pitch, CAP) : null;
  const unit = size / 200; // stroke widths are tuned at 200pt
  const fontSize = Math.max(10, size * 0.06);
  // The labels sit outside the cap, and clear of the head when the cap is
  // smaller than it, so they never land on the face.
  const turnLabelY = Math.max(py(capDir(zone.centerYaw, bottom)), cy + R) + 5 * unit;
  // The side of the cap that's on the right of the screen, mirrored or not.
  const tiltLabel = capDir(zone.centerYaw + MIRROR * zone.turnDeg, zone.centerPitch);
  const tiltLabelX = Math.max(px(tiltLabel), cx + R * 1.15) + 6 * unit;
  const dashed = live !== null && !facing;

  const setZone = (changes: Partial<FacingZone>) => {
    const want = { ...zone, ...changes };
    const next = {
      centerYaw: Math.round(clamp(want.centerYaw, -CENTER_YAW_MAX, CENTER_YAW_MAX)),
      centerPitch: Math.round(clamp(want.centerPitch, -CENTER_PITCH_MAX, CENTER_PITCH_MAX)),
      turnDeg: Math.round(clamp(want.turnDeg, TURN_MIN, TURN_MAX)),
      tiltDeg: Math.round(clamp(want.tiltDeg, TILT_MIN, TILT_MAX)),
    };
    if (
      next.centerYaw !== zone.centerYaw ||
      next.centerPitch !== zone.centerPitch ||
      next.turnDeg !== zone.turnDeg ||
      next.tiltDeg !== zone.tiltDeg
    ) {
      onZoneChange(next);
    }
  };

  const onGrant = (event: GestureResponderEvent) => {
    const { locationX, locationY, pageX, pageY } = event.nativeEvent;
    const centre = capDir(zone.centerYaw, zone.centerPitch);
    // On screen, which corner is nearest the finger? Mirroring flips which
    // side of the zone (yaw + or -) that is.
    const sx = MIRROR * (locationX >= px(centre) ? 1 : -1);
    const sy = locationY >= py(centre) ? 1 : -1;
    const corner = capDir(zone.centerYaw + sx * zone.turnDeg, zone.centerPitch + sy * zone.tiltDeg);
    // Move from the middle of the cap; resize from near a corner or outside it.
    const toCorner = Math.hypot(locationX - px(corner), locationY - py(corner));
    const halfWidth = Math.abs(px(corner) - px(centre));
    const halfHeight = Math.abs(py(corner) - py(centre));
    const moving =
      toCorner > CORNER_GRAB * R * CAP &&
      Math.abs(locationX - px(centre)) < halfWidth &&
      Math.abs(locationY - py(centre)) < halfHeight;
    const from = moving ? centre : corner;
    drag.current = { moving, pageX, pageY, fromX: px(from), fromY: py(from), sx, sy };
    setDragging(true);
  };

  const onMove = (event: GestureResponderEvent) => {
    const start = drag.current;
    const x = start.fromX + event.nativeEvent.pageX - start.pageX;
    const y = start.fromY + event.nativeEvent.pageY - start.pageY;
    const heading = headingAt((MIRROR * (x - cx)) / (R * CAP), (y - cy) / (R * CAP));
    if (start.moving) {
      setZone({ centerYaw: heading.yaw, centerPitch: heading.pitch });
    } else {
      setZone({
        turnDeg: start.sx * (heading.yaw - zone.centerYaw),
        tiltDeg: start.sy * (heading.pitch - zone.centerPitch),
      });
    }
  };

  return (
    <View
      style={{ width: size, height: size }}
      onStartShouldSetResponder={() => true}
      onMoveShouldSetResponder={() => true}
      onResponderTerminationRequest={() => false}
      onResponderGrant={onGrant}
      onResponderMove={onMove}
      onResponderRelease={() => setDragging(false)}
      onResponderTerminate={() => setDragging(false)}
      accessibilityRole="adjustable"
      accessibilityLabel={`Facing the room: ${zone.turnDeg}° each side, ${zone.tiltDeg}° up or down`}
      accessibilityActions={[{ name: "increment" }, { name: "decrement" }]}
      onAccessibilityAction={(event) => {
        const step = event.nativeEvent.actionName === "increment" ? 1 : -1;
        setZone({ turnDeg: zone.turnDeg + step, tiltDeg: zone.tiltDeg + step });
      }}
    >
      {/* pointerEvents off, so touches land on the square itself and the
          grant point is measured from its corner. */}
      <Svg width={size} height={size} pointerEvents="none">
        <G opacity={live ? 1 : 0.35} stroke={ink} fill="none" strokeLinecap="round" strokeLinejoin="round">
          <Circle cx={cx} cy={cy} r={R} strokeWidth={2 * unit} />
          {WIRES.map((wire, i) => (
            <Path key={i} d={pathOf(posed(wire))} strokeWidth={unit} opacity={0.3} />
          ))}
          {EARS.map((ear, i) => (
            <Path key={i} d={pathOf(posed(ear))} strokeWidth={1.6 * unit} />
          ))}
          <Path d={pathOf(posed(MOUTH))} strokeWidth={1.4 * unit} opacity={0.7} />
          {posed(EYES).map((eye, i) =>
            eye.z > 0.1 ? (
              <Circle key={i} cx={px(eye)} cy={py(eye)} r={R * 0.07} fill={ink} stroke="none" />
            ) : null,
          )}
          <Path d={pathOf(posed(NOSE_LINE))} strokeWidth={1.8 * unit} />
        </G>

        {/* The beam: four edges leave the head's surface and end at the cap. */}
        <G stroke={ink}>
          {corners.map(([yaw, pitch], i) => (
            <Line
              key={i}
              x1={px(capDir(yaw, pitch, 1))}
              y1={py(capDir(yaw, pitch, 1))}
              x2={px(capDir(yaw, pitch))}
              y2={py(capDir(yaw, pitch))}
              strokeWidth={1.2 * unit}
              opacity={0.4}
            />
          ))}
          {/* A full, solid cap says the nose is inside it; a faint dashed one
              says it has left. The key remounts the path between the two,
              because react-native-svg keeps the old dashes when the prop is
              taken away. */}
          <Path
            key={dashed ? "dashed" : "solid"}
            d={`${pathOf(capEdge, false)}Z`}
            fill={ink}
            fillOpacity={facing ? 0.18 : 0.06}
            strokeWidth={(dragging ? 3.2 : facing ? 2.4 : 1.6) * unit}
            strokeDasharray={dashed ? [5 * unit, 5 * unit] : undefined}
            strokeLinejoin="round"
          />
          {corners.map(([yaw, pitch], i) => (
            <Circle
              key={i}
              cx={px(capDir(yaw, pitch))}
              cy={py(capDir(yaw, pitch))}
              r={(dragging ? 3.6 : 2.6) * unit}
              fill={ink}
              stroke="none"
            />
          ))}
          {noseTip && live && isVisible(noseTip) ? (
            <>
              <Line
                x1={px(direction(live.yaw, live.pitch, NOSE))}
                y1={py(direction(live.yaw, live.pitch, NOSE))}
                x2={px(noseTip)}
                y2={py(noseTip)}
                strokeWidth={1.6 * unit}
                opacity={0.7}
              />
              {/* The one bold mark: where the head points. A solid dot while
                  facing the room, a hollow ring once outside it. */}
              <Circle
                cx={px(noseTip)}
                cy={py(noseTip)}
                r={(facing ? 6 : 7) * unit}
                fill={facing ? ink : "none"}
                strokeWidth={facing ? 0 : 2.4 * unit}
              />
            </>
          ) : null}
        </G>
      </Svg>

      <Text
        pointerEvents="none"
        style={{
          position: "absolute",
          width: 60,
          textAlign: "center",
          left: clamp(px(capDir(zone.centerYaw, bottom)) - 30, 0, size - 60),
          top: Math.min(turnLabelY, size - fontSize * 1.3),
          fontFamily: fonts.medium,
          fontSize,
          color: ink,
          opacity: 0.85,
        }}
      >
        {`±${zone.turnDeg}°`}
      </Text>
      <Text
        pointerEvents="none"
        style={{
          position: "absolute",
          left: Math.min(tiltLabelX, size - fontSize * 2.6),
          top: py(tiltLabel) - fontSize * 0.65,
          fontFamily: fonts.medium,
          fontSize,
          color: ink,
          opacity: 0.85,
        }}
      >
        {`±${zone.tiltDeg}°`}
      </Text>
    </View>
  );
}
