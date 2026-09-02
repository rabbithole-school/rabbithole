"use client";

/**
 * Metaphor: aim a bright firing line, then blast one herd into two.
 * The child drags the beam through the dots, releases to fire, and can drag either resulting cluster back into the other.
 * The moving, settling dots make decomposition physical and reversible in a way a recoloring slider cannot.
 * Rough edge: cluster merging uses a generous center-distance threshold rather than dot-to-dot collisions.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { C, wash } from "@/components/manipulative/colors";

export interface SpikeProps {
  /** The whole. Assume 10 for the demo, but do not hardcode it. */
  total: number;
  /** The required size of the FIRST/left group (e.g. 6 in "6 + 4 = 10"). */
  target: number;
  /** Fires on every change of the scholar's arrangement. */
  onChange?: (s: { left: number; right: number; solved: boolean }) => void;
}

export const SPIKE_META = {
  id: "real-blaster",
  title: "Real blaster",
  metaphor: "Aim, fire, split the herd",
  blurb: "Drag the firing line through the herd and let go. Pull either cluster back into the other to reform the whole and blast it again.",
  why: "The dots carry the consequence: they accelerate, rebound, and settle into readable groups of five. Recombining them makes every decomposition reversible.",
} as const;

type Side = "left" | "right";
type Phase = "herd" | "firing" | "split" | "dragging" | "reforming";
type Dot = { id: number; x: number; y: number; vx: number; vy: number; side?: Side; tx: number; ty: number };

const W = 480;
const H = 300;
const DOT_R = 13;

function herdPositions(total: number) {
  const columns = Math.max(1, Math.ceil(Math.sqrt(total * 1.35)));
  const rows = Math.ceil(total / columns);
  const xGap = Math.min(48, 180 / Math.max(1, columns - 1));
  const yGap = Math.min(46, 115 / Math.max(1, rows - 1));
  return Array.from({ length: total }, (_, i) => {
    const row = Math.floor(i / columns);
    const col = i % columns;
    const rowSize = Math.min(columns, total - row * columns);
    const jitterX = Math.sin((i + 1) * 12.9898) * 7;
    const jitterY = Math.sin((i + 1) * 41.713) * 7;
    return {
      x: W / 2 + (col - (rowSize - 1) / 2) * xGap + (row % 2 ? 8 : -5) + jitterX,
      y: 138 + (row - (rows - 1) / 2) * yGap + jitterY,
    };
  });
}

function groupedPositions(count: number, side: Side) {
  const rows = Math.ceil(count / 5);
  const centerX = side === "left" ? 126 : 354;
  return Array.from({ length: count }, (_, i) => {
    const row = Math.floor(i / 5);
    const col = i % 5;
    const rowSize = Math.min(5, count - row * 5);
    return {
      x: centerX + (col - (rowSize - 1) / 2) * 33,
      y: 140 + (row - (rows - 1) / 2) * 39,
    };
  });
}

function freshDots(total: number): Dot[] {
  return herdPositions(total).map((point, id) => ({ id, ...point, vx: 0, vy: 0, tx: point.x, ty: point.y }));
}

export function RealBlasterSpike({ total, target, onChange }: SpikeProps) {
  const [dots, setDots] = useState<Dot[]>(() => freshDots(total));
  const [phase, setPhase] = useState<Phase>("herd");
  const [aimX, setAimX] = useState(W / 2);
  const [aiming, setAiming] = useState(false);
  const [beamVisible, setBeamVisible] = useState(true);
  const [reducedMotion, setReducedMotion] = useState(false);
  const dotsRef = useRef(dots);
  const phaseRef = useRef(phase);
  const frameRef = useRef<number | null>(null);
  const flashTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const dragRef = useRef<{ side: Side; x: number; y: number } | null>(null);
  const arrangementLeft = dots.filter((dot) => dot.side === "left").length;

  const commitDots = useCallback((next: Dot[]) => {
    dotsRef.current = next;
    setDots(next);
  }, []);

  const commitPhase = useCallback((next: Phase) => {
    phaseRef.current = next;
    setPhase(next);
  }, []);

  const stopAnimation = useCallback(() => {
    if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
    frameRef.current = null;
  }, []);

  useEffect(() => {
    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    const sync = () => setReducedMotion(media.matches);
    sync();
    media.addEventListener("change", sync);
    return () => media.removeEventListener("change", sync);
  }, []);

  useEffect(() => {
    stopAnimation();
    // eslint-disable-next-line react-hooks/set-state-in-effect -- A changed total begins a fresh Blaster phase after cancelling its prior animation.
    commitDots(freshDots(total));
    commitPhase("herd");
    setAimX(W / 2);
    setBeamVisible(true);
  }, [total, commitDots, commitPhase, stopAnimation]);

  useEffect(() => {
    const left = phase === "herd" || phase === "reforming" ? 0 : arrangementLeft;
    onChange?.({ left, right: total - left, solved: phase === "split" && left === target });
  }, [arrangementLeft, onChange, phase, target, total]);

  useEffect(
    () => () => {
      stopAnimation();
      if (flashTimerRef.current) clearTimeout(flashTimerRef.current);
    },
    [stopAnimation],
  );

  const animate = useCallback(
    (finish: "split" | "herd", minimumMs: number) => {
      stopAnimation();
      let previous = performance.now();
      const started = previous;
      const tick = (now: number) => {
        const dt = Math.min(2, (now - previous) / 16.67);
        previous = now;
        const spring = reducedMotion ? 0.14 : 0.052;
        const damping = reducedMotion ? 0.68 : 0.9;
        let moving = false;
        const next = dotsRef.current.map((dot) => {
          let vx = (dot.vx + (dot.tx - dot.x) * spring * dt) * damping ** dt;
          let vy = (dot.vy + (dot.ty - dot.y) * spring * dt) * damping ** dt;
          let x = dot.x + vx * dt;
          let y = dot.y + vy * dt;
          if (Math.hypot(dot.tx - x, dot.ty - y) > 0.65 || Math.hypot(vx, vy) > 0.16) moving = true;
          if (now - started > (reducedMotion ? 300 : 2100)) {
            x = dot.tx;
            y = dot.ty;
            vx = 0;
            vy = 0;
            moving = false;
          }
          return { ...dot, x, y, vx, vy };
        });
        commitDots(next);
        if (moving || now - started < minimumMs) {
          frameRef.current = requestAnimationFrame(tick);
        } else {
          const settled = next.map((dot) => ({
            ...dot, x: dot.tx, y: dot.ty, vx: 0, vy: 0, side: finish === "herd" ? undefined : dot.side,
          }));
          commitDots(settled);
          commitPhase(finish);
          setBeamVisible(finish === "herd");
          frameRef.current = null;
        }
      };
      frameRef.current = requestAnimationFrame(tick);
    },
    [commitDots, commitPhase, reducedMotion, stopAnimation],
  );

  const fire = useCallback(() => {
    const leftDots = dotsRef.current.filter((dot) => dot.x < aimX).sort((a, b) => a.y - b.y || a.x - b.x);
    const leftIds = new Set(leftDots.map((dot) => dot.id));
    const rightDots = dotsRef.current.filter((dot) => !leftIds.has(dot.id)).sort((a, b) => a.y - b.y || a.x - b.x);
    const leftTargets = groupedPositions(leftDots.length, "left");
    const rightTargets = groupedPositions(rightDots.length, "right");
    let li = 0;
    let ri = 0;
    commitDots(
      dotsRef.current.map((dot) => {
        const side: Side = leftIds.has(dot.id) ? "left" : "right";
        const destination = side === "left" ? leftTargets[li++] : rightTargets[ri++];
        const impulse = reducedMotion ? 1.1 : 6.2;
        return { ...dot, side, tx: destination.x, ty: destination.y, vx: side === "left" ? -impulse : impulse, vy: (dot.y - 138) * 0.035 };
      }),
    );
    commitPhase("firing");
    setAiming(false);
    setBeamVisible(true);
    if (flashTimerRef.current) clearTimeout(flashTimerRef.current);
    flashTimerRef.current = setTimeout(() => setBeamVisible(false), reducedMotion ? 80 : 150);
    animate("split", reducedMotion ? 110 : 620);
  }, [aimX, animate, commitDots, commitPhase, reducedMotion]);

  const reform = useCallback(() => {
    const homes = herdPositions(total);
    commitDots(dotsRef.current.map((dot) => ({ ...dot, tx: homes[dot.id].x, ty: homes[dot.id].y, vx: 0, vy: 0 })));
    commitPhase("reforming");
    animate("herd", reducedMotion ? 90 : 420);
  }, [animate, commitDots, commitPhase, reducedMotion, total]);

  const stageX = (event: React.PointerEvent<SVGSVGElement | SVGCircleElement>) => {
    const rect = event.currentTarget.ownerSVGElement?.getBoundingClientRect() ?? event.currentTarget.getBoundingClientRect();
    return ((event.clientX - rect.left) / rect.width) * W;
  };

  const onStageDown = (event: React.PointerEvent<SVGSVGElement>) => {
    if (phaseRef.current !== "herd") return;
    event.currentTarget.setPointerCapture(event.pointerId);
    setAiming(true);
    setAimX(Math.max(28, Math.min(W - 28, stageX(event))));
  };

  const onStageMove = (event: React.PointerEvent<SVGSVGElement>) => {
    if (aiming) setAimX(Math.max(28, Math.min(W - 28, stageX(event))));
  };

  const onDotDown = (event: React.PointerEvent<SVGCircleElement>, side?: Side) => {
    if (phaseRef.current !== "split" || !side) return;
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = { side, x: event.clientX, y: event.clientY };
    commitPhase("dragging");
  };

  const onDotMove = (event: React.PointerEvent<SVGCircleElement>) => {
    const drag = dragRef.current;
    if (!drag) return;
    const svg = event.currentTarget.ownerSVGElement;
    if (!svg) return;
    const scale = W / svg.getBoundingClientRect().width;
    const dx = (event.clientX - drag.x) * scale;
    const dy = (event.clientY - drag.y) * scale;
    dragRef.current = { ...drag, x: event.clientX, y: event.clientY };
    commitDots(dotsRef.current.map((dot) => (dot.side === drag.side ? { ...dot, x: dot.x + dx, y: dot.y + dy } : dot)));
  };

  const onDotUp = (event: React.PointerEvent<SVGCircleElement>) => {
    const drag = dragRef.current;
    if (!drag) return;
    event.currentTarget.releasePointerCapture(event.pointerId);
    dragRef.current = null;
    const center = (side: Side) => {
      const group = dotsRef.current.filter((dot) => dot.side === side);
      return group.reduce((sum, dot) => sum + dot.x, 0) / Math.max(1, group.length);
    };
    if (Math.abs(center("left") - center("right")) < 92) reform();
    else {
      commitPhase("firing");
      animate("split", reducedMotion ? 80 : 260);
    }
  };

  const left = arrangementLeft;
  const right = total - left;
  const previewDots = dots.map((dot) => {
    if (!aiming || phase !== "herd") return dot;
    const distance = Math.abs(dot.x - aimX);
    const lean = Math.max(0, 8 - distance * 0.09);
    return { ...dot, x: dot.x + (dot.x < aimX ? -lean : lean) };
  });

  return (
    <div style={{ position: "relative", width: "100%", maxWidth: W, height: 340, margin: "0 auto", background: C.cream, border: `1px solid ${C.line}`, borderRadius: 20, overflow: "hidden" }}>
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" height="300" role="application"
        aria-label={phase === "herd" ? "Aim the firing line through the dot herd" : `${left} dots and ${right} dots`}
        style={{ display: "block", touchAction: "none", userSelect: "none" }}
        onPointerDown={onStageDown} onPointerMove={onStageMove} onPointerUp={() => aiming && fire()}>
        {beamVisible && (
          <line x1={aimX} x2={aimX} y1={22} y2={H - 22} stroke={C.orange}
            strokeWidth={phase === "firing" ? 8 : aiming ? 3 : 2} strokeLinecap="round"
            opacity={phase === "firing" ? 1 : 0.9} />
        )}
        {previewDots.map((dot) => (
          <g key={dot.id}>
            <circle cx={dot.x} cy={dot.y} r={DOT_R}
              fill={dot.side === "left" ? C.cyan : dot.side === "right" ? C.violet : C.charcoal}
              stroke={C.navy} strokeWidth={1.5} />
            {phase === "split" || phase === "dragging" ? (
              <circle cx={dot.x} cy={dot.y} r={24} fill="transparent"
                style={{ touchAction: "none", cursor: "grab" }}
                onPointerDown={(event) => onDotDown(event, dot.side)}
                onPointerMove={onDotMove} onPointerUp={onDotUp} />
            ) : null}
          </g>
        ))}
        {(phase === "split" || phase === "dragging") && (
          <>
            <text x={126} y={224} textAnchor="middle" fill={C.navy} fontSize={24} fontWeight={700}>{left}</text>
            <text x={354} y={224} textAnchor="middle" fill={C.navy} fontSize={24} fontWeight={700}>{right}</text>
          </>
        )}
      </svg>
      <button type="button" aria-label="Reform the herd"
        onPointerDown={(event) => event.currentTarget.setPointerCapture(event.pointerId)}
        onPointerUp={reform} disabled={phase === "herd" || phase === "reforming"}
        style={{
          position: "absolute", right: 12, bottom: 8, minWidth: 88, minHeight: 44,
          border: `1px solid ${C.line}`, borderRadius: 12,
          background: phase === "herd" || phase === "reforming" ? C.cream : wash(C.navy, 0.08),
          color: C.navy, font: "600 15px system-ui, sans-serif",
          opacity: phase === "herd" || phase === "reforming" ? 0.45 : 1,
          touchAction: "none",
        }}>
        Reset
      </button>
    </div>
  );
}
