"use client";

/*
 * Rekenrek (bead rack / arithmetic rack) — push beads across the rods.
 *
 * Ported from the approved spike (components/manipulative/spikes/RekenrekSpike.tsx),
 * promoted to a real manipulative kind and widened from one rod to the standard
 * TWO rods of ten so it can hold make-ten items within 20 (total 1..20). The
 * frame (Manipulative.tsx) supplies the concept eyebrow, prompt, mode badge,
 * self-check chip, and reset; this file is the stage only — no in-stage
 * equation line, just the material and its per-cluster count labels.
 *
 * The interaction, per rod, is the spike's verbatim: put a finger on a bead and
 * drag toward a stop — that bead and every bead between it and the stop travel
 * together (beads can't pass through each other), so grabbing the 4th bead from
 * the left carries all 4. Release and the moved beads settle flush against the
 * stop; a flick carries the train on its own momentum. `left` = beads pushed
 * left, summed across both rods.
 *
 * Two rods, ten beads each. Beads fill rod 1 up to ten, then overflow onto rod
 * 2 (total 6 → one rod of 6; total 15 → a full rod of ten above a rod of five).
 * The rods do NOT interact — each is independently draggable with its own train
 * collision. Pushing 3 on the top rod and 4 on the bottom is a legitimate way to
 * show 7; the make-ten reading (a full top rod = ten) is something the structure
 * affords, never something it enforces.
 *
 * The 5-structure: within each rod, beads are colored in fives — the first five
 * one hue (cyan), the next five the other (violet) — so a group of six reads as
 * "five and one" without counting. IMPORTANT / honest tension: the color encodes
 * a bead's POSITION-IN-FIVES, not which group it's in. A bead keeps its hue as
 * it slides, so the left/right split is carried NOT by recoloring but only by
 * the GAP that opens between the two clusters and by the small count labels.
 * That is the real cost of honoring the five-structure; it is stated here rather
 * than papered over.
 *
 * Each rod's rail carries ~2.5 bead widths of slack, so a separated arrangement
 * leaves an open span of bare rail between the moved cluster and the parked one
 * — wide enough to read as two groups at a glance. That slack, and the bead size
 * that falls out of it, come from the shared `rekenrekGeometry` (native sizes off
 * the same helper); the rack is sized to FIT the measured stage, so a narrow
 * column shrinks the bead rather than pushing beads off the edge.
 */

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { KindProps } from "../Manipulative";
import type { RekenrekSpec } from "@/lib/manipulative/types";
import {
  REKENREK_STOP_M as STOP_M,
  rekenrekGeometry,
  rekenrekSolved,
} from "@/lib/manipulative/logic";
import { C, wash } from "../colors";

const ROD_H = 100; // per-rod block height (rail + beads + count labels)
const RAIL_Y = 40; // rail centerline within a rod block
const ROD_CAP = 10; // beads per rod
const MAX_W = 560; // stage cap — the rack never needs to be wider than this

const clampN = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

function synchronizePositions(current: number[], next: number[]): number[] {
  return current.length === next.length && current.every((position, index) => position === next[index])
    ? current
    : next;
}

/** Bead hue by position-in-fives within its rod (fixed to the bead, travels with it). */
function hueFor(i: number): string {
  return Math.floor(i / 5) % 2 === 0 ? C.cyan : C.violet;
}

/** Split a total into per-rod bead counts: rod 1 fills to ten, then rod 2. */
function rodCounts(total: number): number[] {
  const t = clampN(Math.round(total), 0, 2 * ROD_CAP);
  const r0 = Math.min(t, ROD_CAP);
  const r1 = Math.max(0, t - ROD_CAP);
  return r1 > 0 ? [r0, r1] : [r0];
}

/** Distribute a starting `left` across the rods (rod 1 first). */
function splitLeft(left: number, counts: number[]): number[] {
  const l0 = clampN(left, 0, counts[0]);
  const rest = counts.length > 1 ? clampN(left - counts[0], 0, counts[1]) : 0;
  return counts.length > 1 ? [l0, rest] : [l0];
}

export function RekenrekManipulative({
  spec,
  onSolvedChange,
  onStateChange,
}: KindProps<RekenrekSpec>) {
  const stageRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(MAX_W);

  const counts = useMemo(() => rodCounts(spec.total), [spec.total]);
  const startLefts = useMemo(
    () => splitLeft(clampN(Math.round(spec.startLeft ?? 0), 0, spec.total), counts),
    [spec.startLeft, spec.total, counts],
  );

  // Bead size + rail geometry are SHARED across rods so beads are uniform, and
  // the whole rack always fits the measured stage — see `rekenrekGeometry`,
  // which native's renderer sizes off too.
  const { D, railLeft, railRight } = useMemo(
    () => rekenrekGeometry(width, counts[0]),
    [width, counts],
  );

  useLayoutEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const measure = (w: number | undefined) => {
      if (w && Math.abs(w - width) > 1) setWidth(w);
    };
    // Measure synchronously before the first paint: the initial `MAX_W` guess is
    // wider than the practice column, and laying the beads out to it for even one
    // frame flashes a cropped rack.
    measure(el.getBoundingClientRect().width);
    const ro = new ResizeObserver((entries) => measure(entries[0]?.contentRect.width));
    ro.observe(el);
    return () => ro.disconnect();
  }, [width]);

  // Live left-count per rod; summed for the reported state.
  //
  // Stamped with the puzzle it belongs to and DERIVED, rather than re-seeded by
  // an effect. The effect ran after the paint, so a new puzzle rendered one
  // frame of the previous puzzle's counts; it also could not shrink the array
  // when the rod count dropped. Falling back to `startLefts` whenever the stamp
  // does not match handles both, and unlike remounting the component it leaves
  // the measured `width` (and so the bead geometry) alone.
  const puzzleKey = `${spec.id}:${spec.total}:${spec.startLeft ?? 0}:${
    spec.goal ? `${spec.goal.type}:${spec.goal.value}` : "none"
  }`;
  const [tracked, setTracked] = useState<{ key: string; lefts: number[] }>({
    key: puzzleKey,
    lefts: startLefts,
  });
  const lefts = tracked.key === puzzleKey ? tracked.lefts : startLefts;

  const reportLeft = useCallback(
    (rod: number, value: number) => {
      setTracked((prev) => {
        const base = prev.key === puzzleKey ? prev.lefts : startLefts;
        if (base[rod] === value) {
          return prev.key === puzzleKey ? prev : { key: puzzleKey, lefts: base };
        }
        const next = base.slice();
        next[rod] = value;
        return { key: puzzleKey, lefts: next };
      });
    },
    [puzzleKey, startLefts],
  );

  const totalLeft = lefts.reduce((a, b) => a + b, 0);
  useEffect(() => {
    onSolvedChange(rekenrekSolved(spec, { left: totalLeft }));
    onStateChange?.({ left: totalLeft });
  }, [spec, totalLeft, onSolvedChange, onStateChange]);

  return (
    <div
      ref={stageRef}
      style={{
        position: "relative",
        width: "100%",
        maxWidth: MAX_W,
        margin: "0 auto",
        touchAction: "none",
        userSelect: "none",
      }}
    >
      {/* Keyed by the WHOLE PUZZLE, not by this rod's own (count, startLeft):
          a rod's pair can be invariant across a puzzle change — "show 14" and
          "show 17" both leave the top rod a full ten from 0 — and a rod keyed
          only on its own pair would keep a dragged bead layout while the parent
          resets the summed count, showing one split and reporting another. The
          puzzle stamp remounts every rod, so each re-derives
          positions/leftCount/settling and the mount effect reports its split.
          `width`/`D`/`rail*` stay OUT of the key so a resize still lays out in
          place rather than remounting. */}
      {counts.map((count, rod) => (
        <Rod
          key={`${puzzleKey}:${rod}`}
          count={count}
          initialLeft={startLefts[rod] ?? 0}
          width={width}
          D={D}
          railLeft={railLeft}
          railRight={railRight}
          onLeftChange={(v) => reportLeft(rod, v)}
        />
      ))}
    </div>
  );
}

interface RodProps {
  count: number;
  initialLeft: number;
  width: number;
  D: number;
  railLeft: number;
  railRight: number;
  onLeftChange: (left: number) => void;
}

/** One rod of the rack — the spike's single-rail interaction, isolated. */
function Rod({ count, initialLeft, width, D, railLeft, railRight, onLeftChange }: RodProps) {
  const restPositions = useCallback(
    (left: number): number[] =>
      Array.from({ length: count }, (_, i) =>
        i < left ? railLeft + i * D : railRight - (count - 1 - i) * D,
      ),
    [count, D, railLeft, railRight],
  );

  const [positions, setPositions] = useState<number[]>(() => restPositions(initialLeft));
  const [leftCount, setLeftCount] = useState(initialLeft);
  const [settling, setSettling] = useState(false);

  const posRef = useRef(positions);
  const dragRef = useRef<{
    grab: number;
    startX: number;
    base: number[];
    lastX: number;
    lastT: number;
    vel: number;
  } | null>(null);
  const rafRef = useRef<number | null>(null);
  const firedRef = useRef(-1);

  const fire = useCallback(
    (left: number) => {
      if (left === firedRef.current) return;
      firedRef.current = left;
      onLeftChange(left);
    },
    [onLeftChange],
  );

  // Report the initial split up on mount.
  useEffect(() => {
    fire(initialLeft);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // No re-seed effect: the caller keys each Rod by `${rod}:${count}:${left}`,
  // so a changed bead count or starting split remounts this component and every
  // initializer above re-derives from the new props — including `firedRef`,
  // which the mount effect then reports up.

  // Keep beads laid out to the current split when the rail is resized (idle only).
  useEffect(() => {
    if (!dragRef.current && rafRef.current == null) {
      const next = restPositions(leftCount);
      const synchronized = synchronizePositions(posRef.current, next);
      if (synchronized !== posRef.current) {
        posRef.current = synchronized;
        setPositions(synchronized);
      }
    }
  }, [leftCount, restPositions]);

  const classifyLeft = useCallback(
    (pos: number[]): number => {
      let bestGap = -1;
      let splitAt = 0;
      for (let i = 1; i < count; i++) {
        const g = pos[i] - pos[i - 1] - D;
        if (g > bestGap) {
          bestGap = g;
          splitAt = i;
        }
      }
      if (bestGap < D * 0.4) {
        return pos[0] - railLeft <= railRight - pos[count - 1] ? count : 0;
      }
      return splitAt;
    },
    [count, D, railLeft, railRight],
  );

  // Grabbed bead follows `desired`; it PUSHES the neighbors it collides with,
  // never pulls them. Then clamp the train inside the rail.
  const applyGrab = useCallback(
    (pos: number[], g: number, desired: number) => {
      pos[g] = clampN(desired, railLeft, railRight);
      for (let i = g - 1; i >= 0; i--) pos[i] = Math.min(pos[i], pos[i + 1] - D);
      for (let i = g + 1; i < count; i++) pos[i] = Math.max(pos[i], pos[i - 1] + D);
      if (pos[0] < railLeft) {
        pos[0] = railLeft;
        for (let i = 1; i < count; i++) pos[i] = Math.max(pos[i], pos[i - 1] + D);
      }
      if (pos[count - 1] > railRight) {
        pos[count - 1] = railRight;
        for (let i = count - 2; i >= 0; i--) pos[i] = Math.min(pos[i], pos[i + 1] - D);
      }
    },
    [count, D, railLeft, railRight],
  );

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

  useEffect(
    () => () => {
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
    },
    [],
  );

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

  const right = count - leftCount;
  const leftCenter = railLeft + ((leftCount - 1) * D) / 2;
  const rightCenter = railRight - ((right - 1) * D) / 2;
  const beadTransition = settling
    ? "transform 300ms cubic-bezier(0.22, 1.2, 0.36, 1)"
    : "none";

  return (
    <div style={{ position: "relative", width: "100%", height: ROD_H }}>
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

      {/* per-cluster count labels — carry the left/right split the color can't */}
      {leftCount > 0 && <GroupLabel x={leftCenter} value={leftCount} />}
      {right > 0 && <GroupLabel x={rightCenter} value={right} />}
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
