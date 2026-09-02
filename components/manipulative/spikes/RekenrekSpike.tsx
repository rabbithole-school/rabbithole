"use client";

/*
 * Rekenrek (bead rack / arithmetic rack) — slide beads across the rod.
 *
 * The stage is one horizontal gray rail strung with `total` beads, all parked
 * at the RIGHT stop. The child puts a finger on a bead and drags LEFT: that
 * bead and every bead to its left travel together (beads can't pass through
 * each other), so grabbing the 4th bead from the left carries all 4. Release
 * and the moved beads settle flush against the left stop with a short eased
 * clunk; a flick carries the train the rest of the way on its own momentum.
 * Dragging back to the right returns them. `left` = beads now on the left.
 *
 * What it teaches that a slider cannot: the child handles the counted objects
 * themselves, and a push is a physical TRAIN with weight and consequence — you
 * feel 4 beads move, you don't nudge a divider.
 *
 * The 5-structure: beads are colored in fives — the first five one hue (cyan),
 * the next five the other (violet) — so a left group of six reads instantly as
 * "five and one" without counting. IMPORTANT / honest tension: the color
 * encodes a bead's POSITION-IN-FIVES, not which group it's in. A bead keeps its
 * hue as it slides. So the left/right split is NOT shown by recoloring — it is
 * carried only by the GAP that opens between the two clusters and by the small
 * count labels. That's the real design cost of honoring the five-structure, and
 * it's stated here rather than papered over.
 *
 * The rail carries real slack: it is ~2 bead widths longer than the beads
 * occupy, so a separated arrangement leaves an open span of bare rail (about
 * two bead widths) between the moved cluster and the parked one. The gap is a
 * consequence of the layout, not a decoration — the moved train settles flush
 * against the left stop and the untouched beads stay flush against the right
 * stop, so the bare rail between them IS the slack.
 *
 * Known rough edges:
 *  - Momentum is a cheap rAF decay on the grabbed bead's train; a hard flick
 *    can overshoot the intended count (self-corrects by dragging back — that's
 *    the reversibility, not a bug, but it isn't precisely tuned).
 *  - Single rod only. A second rod (two rows of `total`) was out of scope for
 *    the cost; one rod done well beat two done adequately.
 *  - The open span between two fully-separated groups is the rail's whole slack
 *    (~2 bead widths). It's the same width for every split, but now wide enough
 *    to read as two groups at a glance rather than "slightly less crowded".
 *  - Beads are 44px (the hit-target floor) so the longer rail fits the 560px
 *    host box; there is no room to make them larger without eating the slack.
 *  - No audio; the "clunk" is purely the overshoot easing.
 */

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { C, wash } from "@/components/manipulative/colors";

export interface SpikeProps {
  total: number;
  target: number;
  onChange?: (s: { left: number; right: number; solved: boolean }) => void;
}

export const SPIKE_META = {
  id: "rekenrek",
  title: "Rekenrek",
  metaphor: "Slide beads across the rod",
  blurb:
    "Put a finger on a bead and push a train of them across a bead rack; beads can't pass through each other, so you feel the whole group move and settle against the stop.",
  why: "The child handles the counted objects themselves, and the beads colored in fives make a group of six read as 'five and one' without counting one-by-one.",
} as const;

const STAGE_H = 150;
const RAIL_Y = 66;
const STOP_M = 14; // end-stop margin: bare rail reserved at each end
const clampN = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/** Bead hue by position-in-fives (fixed to the bead, travels with it). */
function hueFor(i: number): string {
  return Math.floor(i / 5) % 2 === 0 ? C.cyan : C.violet;
}

export function RekenrekSpike({ total, target, onChange }: SpikeProps) {
  const stageRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(560);

  const { D, railLeft, railRight } = useMemo(() => {
    // Rail interior holds the beads (total * D) plus ~2.5 bead widths of slack,
    // so a split leaves an open span of bare rail between the two clusters.
    // D is floored at 44 (finger hit target) even if that trims the slack.
    const interior = Math.max(width - 2 * STOP_M, total * 44);
    const d = clampN(Math.floor(interior / (total + 2.5)), 44, 56);
    return { D: d, railLeft: STOP_M + d / 2, railRight: width - STOP_M - d / 2 };
  }, [width, total]);

  const restPositions = useCallback(
    (left: number): number[] =>
      Array.from({ length: total }, (_, i) =>
        i < left ? railLeft + i * D : railRight - (total - 1 - i) * D,
      ),
    [total, D, railLeft, railRight],
  );

  const [positions, setPositions] = useState<number[]>(() => restPositions(0));
  const [leftCount, setLeftCount] = useState(0);
  const [settling, setSettling] = useState(false);

  const posRef = useRef(positions);
  const dragRef = useRef<{ grab: number; startX: number; base: number[]; lastX: number; lastT: number; vel: number } | null>(null);
  const rafRef = useRef<number | null>(null);
  const firedRef = useRef(-1);

  // Keep beads laid out to the current split when the rail is resized (idle only).
  useLayoutEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width;
      if (w && Math.abs(w - width) > 1) setWidth(w);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [width]);

  useEffect(() => {
    if (!dragRef.current && rafRef.current == null) {
      const next = restPositions(leftCount);
      setPositions(next);
      posRef.current = next;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [D, railLeft, railRight]);

  const classifyLeft = useCallback(
    (pos: number[]): number => {
      let bestGap = -1;
      let splitAt = 0;
      for (let i = 1; i < total; i++) {
        const g = pos[i] - pos[i - 1] - D;
        if (g > bestGap) {
          bestGap = g;
          splitAt = i;
        }
      }
      if (bestGap < D * 0.4) {
        return pos[0] - railLeft <= railRight - pos[total - 1] ? total : 0;
      }
      return splitAt;
    },
    [total, D, railLeft, railRight],
  );

  // Grabbed bead follows `desired`; it PUSHES the neighbors it collides with,
  // never pulls them. Then clamp the train inside the rail.
  const applyGrab = useCallback(
    (pos: number[], g: number, desired: number) => {
      pos[g] = clampN(desired, railLeft, railRight);
      for (let i = g - 1; i >= 0; i--) pos[i] = Math.min(pos[i], pos[i + 1] - D);
      for (let i = g + 1; i < total; i++) pos[i] = Math.max(pos[i], pos[i - 1] + D);
      if (pos[0] < railLeft) {
        pos[0] = railLeft;
        for (let i = 1; i < total; i++) pos[i] = Math.max(pos[i], pos[i - 1] + D);
      }
      if (pos[total - 1] > railRight) {
        pos[total - 1] = railRight;
        for (let i = total - 2; i >= 0; i--) pos[i] = Math.min(pos[i], pos[i + 1] - D);
      }
    },
    [total, D, railLeft, railRight],
  );

  const fire = useCallback(
    (left: number) => {
      if (left === firedRef.current) return;
      firedRef.current = left;
      onChange?.({ left, right: total - left, solved: left === target });
    },
    [onChange, total, target],
  );

  useEffect(() => {
    fire(0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const settle = useCallback(() => {
    const l = classifyLeft(posRef.current);
    const rest = restPositions(l);
    setSettling(true);
    setPositions(rest);
    posRef.current = rest;
    setLeftCount(l);
    fire(l);
    window.setTimeout(() => setSettling(false), 300);
  }, [classifyLeft, restPositions, fire]);

  const startMomentum = useCallback(
    (grab: number, vel0: number) => {
      let vel = vel0;
      const tick = () => {
        const cur = posRef.current.slice();
        const before = cur[grab];
        applyGrab(cur, grab, cur[grab] + vel * 16);
        posRef.current = cur;
        setPositions(cur);
        setLeftCount(classifyLeft(cur));
        const moved = Math.abs(cur[grab] - before);
        vel *= 0.9;
        if (Math.abs(vel) > 0.04 && moved > 0.2) {
          rafRef.current = requestAnimationFrame(tick);
        } else {
          rafRef.current = null;
          settle();
        }
      };
      rafRef.current = requestAnimationFrame(tick);
    },
    [applyGrab, classifyLeft, settle],
  );

  useEffect(() => () => {
    if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
  }, []);

  const onPointerDown = (i: number) => (e: React.PointerEvent) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    if (rafRef.current != null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    setSettling(false);
    dragRef.current = {
      grab: i,
      startX: e.clientX,
      base: posRef.current.slice(),
      lastX: e.clientX,
      lastT: e.timeStamp,
      vel: 0,
    };
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const d = dragRef.current;
    if (!d) return;
    const dx = e.clientX - d.startX;
    const cur = d.base.slice();
    applyGrab(cur, d.grab, d.base[d.grab] + dx);
    posRef.current = cur;
    setPositions(cur);
    setLeftCount(classifyLeft(cur));
    const dt = e.timeStamp - d.lastT;
    if (dt > 0) {
      d.vel = (e.clientX - d.lastX) / dt;
      d.lastX = e.clientX;
      d.lastT = e.timeStamp;
    }
  };

  const onPointerUp = () => {
    const d = dragRef.current;
    if (!d) return;
    dragRef.current = null;
    if (Math.abs(d.vel) > 0.35) startMomentum(d.grab, d.vel);
    else settle();
  };

  const right = total - leftCount;
  const solved = leftCount === target;
  const leftCenter = railLeft + ((leftCount - 1) * D) / 2;
  const rightCenter = railRight - ((right - 1) * D) / 2;
  const beadTransition = settling
    ? "transform 300ms cubic-bezier(0.22, 1.2, 0.36, 1)"
    : "none";

  return (
    <div
      ref={stageRef}
      style={{
        position: "relative",
        width: "100%",
        maxWidth: 560,
        height: STAGE_H,
        margin: "0 auto",
        touchAction: "none",
        userSelect: "none",
      }}
    >
      {/* rail + end stops (neutral gray scaffolding) */}
      <div
        style={{
          position: "absolute",
          left: 0,
          right: 0,
          top: RAIL_Y - 2,
          height: 4,
          borderRadius: 2,
          background: C.line,
        }}
      />
      {[0, 1].map((k) => (
        <div
          key={k}
          style={{
            position: "absolute",
            left: k === 0 ? STOP_M - 6 : width - STOP_M,
            top: RAIL_Y - 18,
            width: 6,
            height: 36,
            borderRadius: 3,
            background: wash(C.charcoal, 0.32),
          }}
        />
      ))}

      {positions.map((x, i) => (
        <div
          key={i}
          onPointerDown={onPointerDown(i)}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
          style={{
            position: "absolute",
            left: 0,
            top: 0,
            width: D,
            height: D,
            borderRadius: "50%",
            background: hueFor(i),
            border: `2px solid ${wash(C.navy, 0.22)}`,
            transform: `translate(${x - D / 2}px, ${RAIL_Y - D / 2}px)`,
            transition: beadTransition,
            touchAction: "none",
            cursor: "grab",
            willChange: "transform",
          }}
        />
      ))}

      {/* group count labels — carry the left/right split the color can't */}
      {leftCount > 0 && (
        <GroupLabel x={leftCenter} value={leftCount} />
      )}
      {right > 0 && <GroupLabel x={rightCenter} value={right} />}

      {solved && leftCount > 0 && right > 0 && (
        <div
          style={{
            position: "absolute",
            left: 0,
            right: 0,
            top: RAIL_Y + 54,
            textAlign: "center",
            fontSize: 15,
            fontWeight: 600,
            color: C.navy,
          }}
        >
          {leftCount} and {right} make {total}
        </div>
      )}
    </div>
  );
}

function GroupLabel({ x, value }: { x: number; value: number }) {
  return (
    <div
      style={{
        position: "absolute",
        left: x,
        top: RAIL_Y + 26,
        transform: "translateX(-50%)",
        fontSize: 20,
        fontWeight: 700,
        color: C.navy,
        pointerEvents: "none",
      }}
    >
      {value}
    </div>
  );
}
