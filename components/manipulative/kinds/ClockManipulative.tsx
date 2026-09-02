"use client";

/**
 * Clock — a geared analog dial. Drag the MINUTE hand and the hour hand creeps
 * with it, because both are read off ONE state value (`minutes` past 12), not
 * two independent fields. That is the whole model: at 3:45 the hour hand sits
 * nearly on the 4, and dragging the minute hand all the way round genuinely
 * advances the hour.
 *
 * BOTH hands are grabbable, and that is not a second degree of freedom. The
 * hour hand winds the same `minutes` at a 12:1 gear ratio, so it is the COARSE
 * control — reaching 4:30 from 12:00 is a sweep of the hour hand plus a nudge
 * of the minute hand, rather than four and a half revolutions of winding. The
 * hands therefore cannot contradict each other: an impossible face (hour hand
 * square on the 3 while the minute hand reads 45) stays unrepresentable, which
 * matters because that impossible face is the classic misconception 2.MD.C.7
 * and 3.MD.A.1 are trying to prevent.
 *
 * Drawn as raw SVG rather than Mafs — a dial is polar, and every element here
 * (hands, numerals, tick ring) is placed by angle, so the coordinate-plane
 * machinery would only be in the way. Pointer handling is captured by whichever
 * hand you grabbed: the hand follows the finger's ANGLE, and crossing the 12
 * forwards or backwards carries the hour with it (tracked as a signed wrap, so
 * 11:55 → 12:05 advances an hour instead of rewinding eleven).
 */
import { useCallback, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { Box, Text } from "@chakra-ui/react";
import type { KindProps } from "../Manipulative";
import type { ClockSpec } from "@/lib/manipulative/types";
import { C, wash } from "../colors";
import {
  CLOCK_DIAL_MINUTES,
  clockMinutesFromTurned,
  clockNormalize,
  clockSnapMinutes,
  clockSolved,
  formatClockTime,
  initialClock,
  liveReadoutPolicy,
} from "@/lib/manipulative/logic";

const SIZE = 260;
const CX = SIZE / 2;
const CY = SIZE / 2;
const FACE_R = 112;

/**
 * Clock angles run clockwise from 12 o'clock, unlike math angles.
 *
 * The result is ROUNDED, and that is load-bearing rather than tidiness:
 * `Math.cos`/`Math.sin` are not required to be bit-identical across JS engines,
 * so Node's server render and the browser's hydration pass disagreed in the
 * ~15th decimal place on every tick — enough for React to report a hydration
 * mismatch and refuse to patch the tree (one console error per clock, every
 * load). Three decimals is far finer than a pixel and makes both passes emit
 * the same string.
 */
function polar(fractionOfTurn: number, radius: number): { x: number; y: number } {
  const a = fractionOfTurn * Math.PI * 2 - Math.PI / 2;
  const round = (n: number) => Math.round(n * 1000) / 1000;
  return { x: round(CX + Math.cos(a) * radius), y: round(CY + Math.sin(a) * radius) };
}

export function ClockManipulative({ spec, onSolvedChange, onStateChange }: KindProps<ClockSpec>) {
  const snap = clockSnapMinutes(spec);
  const [minutes, setMinutes] = useState(() => initialClock(spec).minutes);
  const faceRef = useRef<SVGSVGElement | null>(null);
  /**
   * The live wind. `origin` is the reading the grab began at, `lastTurn` the
   * pointer's last angle and `turned` the rotation accumulated since, so the
   * hand answers to how far the finger has TURNED rather than to where it
   * happens to point. Because the grab starts ON the hand, those two agree —
   * the hand tracks the finger — while a coarse dial and multi-turn winding
   * still work (see `clockMinutesFromTurned`).
   *
   * `minutesPerTurn` is which hand is in the hand: 60 for the minute hand,
   * `CLOCK_DIAL_MINUTES` for the hour hand. Both wind the SAME `minutes`, so
   * the hour hand is a coarse control rather than a second degree of freedom.
   */
  const drag = useRef<{
    pointerId: number;
    origin: number;
    lastTurn: number;
    turned: number;
    minutesPerTurn: number;
  } | null>(null);
  // The live reading mirrored into a ref (as the native renderer does), so the
  // move handler can read the previous value WITHOUT a functional setState
  // updater. React may re-run an updater during render, and calling the
  // parent's onSolvedChange/onStateChange from inside one sets state on
  // `Manipulative` mid-render — React's "Cannot update a component while
  // rendering a different component" warning, and a real one.
  const minutesRef = useRef(minutes);

  /** The finger's angle as a fraction of a turn clockwise from 12 o'clock. */
  const pointerTurn = useCallback((clientX: number, clientY: number): number | null => {
    const svg = faceRef.current;
    if (!svg) return null;
    const rect = svg.getBoundingClientRect();
    const x = ((clientX - rect.left) / rect.width) * SIZE - CX;
    const y = ((clientY - rect.top) / rect.height) * SIZE - CY;
    return (Math.atan2(y, x) + Math.PI / 2) / (Math.PI * 2);
  }, []);

  const moveToPointer = useCallback(
    (e: ReactPointerEvent<SVGSVGElement>) => {
      const d = drag.current;
      if (!d || d.pointerId !== e.pointerId) return;
      e.preventDefault();
      const turn = pointerTurn(e.clientX, e.clientY);
      if (turn == null) return;
      // Unwrap to the shortest signed step since the last frame, so crossing 12
      // reads as a small continuous move rather than a whole turn back.
      let step = turn - d.lastTurn;
      while (step > 0.5) step -= 1;
      while (step < -0.5) step += 1;
      d.lastTurn = turn;
      d.turned += step;
      const next = clockMinutesFromTurned(d.origin, d.turned, snap, d.minutesPerTurn);
      if (next === minutesRef.current) return;
      minutesRef.current = next;
      setMinutes(next);
      onSolvedChange(clockSolved(spec, { minutes: next }));
      onStateChange?.({ minutes: next });
    },
    [onSolvedChange, onStateChange, pointerTurn, snap, spec],
  );

  const stopDrag = useCallback((e: ReactPointerEvent<SVGSVGElement>) => {
    if (drag.current?.pointerId !== e.pointerId) return;
    drag.current = null;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
  }, []);

  /**
   * Both hands grab identically; only the gear ratio differs, so the hour hand
   * is a COARSE control on the same reading rather than a second, independently
   * settable field. Sweeping the hour hand round to the 4 spins the minute hand
   * four times on the way — which is the gearing being taught, not a side
   * effect — and then the minute hand tunes the rest.
   */
  const startDrag = useCallback(
    (minutesPerTurn: number) => (e: ReactPointerEvent<SVGGElement>) => {
      // One hand at a time. A second finger landing on the other hand used to
      // seize `drag.current`, which silently stranded the first: it was still
      // down and still captured, but every one of its moves was then rejected
      // for the wrong pointer id, and lifting the intruder did not give it
      // back. A resting palm or a two-handed grab on an iPad is enough.
      if (drag.current) return;
      e.preventDefault();
      const turn = pointerTurn(e.clientX, e.clientY);
      if (turn == null) return;
      drag.current = {
        pointerId: e.pointerId,
        origin: minutesRef.current,
        lastTurn: turn,
        turned: 0,
        minutesPerTurn,
      };
      // Capture on the face, so a drag that leaves the dial keeps winding.
      // Guarded: a synthetic pointer id has nothing to capture and throws.
      try {
        faceRef.current?.setPointerCapture(e.pointerId);
      } catch {
        /* no live pointer to capture — the move handlers still track it */
      }
    },
    [pointerTurn],
  );

  const minuteTurn = (minutes % 60) / 60;
  const hourTurn = clockNormalize(minutes) / CLOCK_DIAL_MINUTES;
  const minuteTip = polar(minuteTurn, FACE_R - 18);
  const hourTip = polar(hourTurn, FACE_R - 48);
  const grabHandle = polar(minuteTurn, FACE_R - 18);
  const hourGrab = polar(hourTurn, FACE_R - 48);
  const showTime = liveReadoutPolicy(spec).showValue;

  return (
    <Box>
      <svg
        ref={faceRef}
        viewBox={`0 0 ${SIZE} ${SIZE}`}
        style={{
          width: "100%",
          maxWidth: `${SIZE}px`,
          margin: "0 auto",
          display: "block",
          touchAction: "none",
        }}
        role="application"
        aria-label={`Clock face reading ${formatClockTime(minutes)}. Drag the minute hand to set the time, or the hour hand to move through the hours quickly.`}
        onPointerMove={moveToPointer}
        onPointerUp={stopDrag}
        onPointerCancel={stopDrag}
        onLostPointerCapture={(e) => {
          if (drag.current?.pointerId === e.pointerId) drag.current = null;
        }}
      >
        <circle cx={CX} cy={CY} r={FACE_R} fill="white" stroke={C.navy} strokeWidth={3} />
        <circle cx={CX} cy={CY} r={FACE_R - 9} fill="none" stroke={C.line} strokeWidth={1.5} />

        {/* the minute ring: 60 ticks, every fifth one long — the scale a scholar
            counts by fives on */}
        {Array.from({ length: 60 }, (_, i) => {
          const major = i % 5 === 0;
          const outer = polar(i / 60, FACE_R - 11);
          const inner = polar(i / 60, FACE_R - (major ? 22 : 16));
          return (
            <line
              key={`tick-${i}`}
              x1={outer.x}
              y1={outer.y}
              x2={inner.x}
              y2={inner.y}
              stroke={major ? C.navy : C.charcoal}
              strokeWidth={major ? 2.6 : 1.1}
              opacity={major ? 1 : 0.55}
            />
          );
        })}

        {/* hour numerals */}
        {Array.from({ length: 12 }, (_, i) => {
          const hour = i === 0 ? 12 : i;
          const p = polar(i / 12, FACE_R - 40);
          return (
            <text
              key={`hour-${hour}`}
              x={p.x}
              y={p.y}
              textAnchor="middle"
              dominantBaseline="central"
              fontSize={22}
              fontWeight={800}
              fill={C.navy}
              fontFamily="system-ui, sans-serif"
            >
              {hour}
            </text>
          );
        })}

        {/* the optional minute numerals — the early-grades scaffold */}
        {spec.showMinuteNumerals &&
          Array.from({ length: 12 }, (_, i) => {
            const p = polar(i / 12, FACE_R - 68);
            return (
              <text
                key={`min-${i}`}
                x={p.x}
                y={p.y}
                textAnchor="middle"
                dominantBaseline="central"
                fontSize={11}
                fontWeight={700}
                fill={C.teal}
                fontFamily="system-ui, sans-serif"
              >
                {i * 5}
              </text>
            );
          })}

        {/* hour hand — short and thick, and it MOVES with the minutes */}
        <line x1={CX} y1={CY} x2={hourTip.x} y2={hourTip.y} stroke={C.navy} strokeWidth={8} strokeLinecap="round" />
        {/* minute hand — long, thin, and the one you grab */}
        <line x1={CX} y1={CY} x2={minuteTip.x} y2={minuteTip.y} stroke={C.violet} strokeWidth={5} strokeLinecap="round" />
        <circle cx={CX} cy={CY} r={7} fill={C.navy} />

        {/* The three grab layers are ordered by RADIUS, not by hand, because the
            hands overlap whenever they point the same way (12:00 being the worst
            case). Innermost paint wins in SVG, so: the minute shaft sits at the
            bottom, the hour grab covers the inner dial on top of it, and the
            minute handle caps the rim. The result matches what the eye expects —
            near the centre you catch the short hand, out at the rim the long
            one — instead of the top hand swallowing every touch. */}
        <g style={{ cursor: "grab" }} onPointerDown={startDrag(60)}>
          <line
            x1={CX}
            y1={CY}
            x2={minuteTip.x}
            y2={minuteTip.y}
            stroke="transparent"
            strokeWidth={28}
            strokeLinecap="round"
          />
        </g>
        <g style={{ cursor: "grab" }} onPointerDown={startDrag(CLOCK_DIAL_MINUTES)}>
          <line
            x1={CX}
            y1={CY}
            x2={hourTip.x}
            y2={hourTip.y}
            stroke="transparent"
            strokeWidth={26}
            strokeLinecap="round"
          />
          <circle cx={hourGrab.x} cy={hourGrab.y} r={11} fill={C.navy} stroke="white" strokeWidth={3} />
        </g>
        <g style={{ cursor: "grab" }} onPointerDown={startDrag(60)}>
          <circle cx={grabHandle.x} cy={grabHandle.y} r={13} fill={C.violet} stroke="white" strokeWidth={3} />
        </g>
      </svg>

      {/* The digital readout is withheld when the goal NAMES the time: a
          scholar would otherwise drag the hand until "4:30" appeared and never
          read the face. An `advanceBy` goal never names where you land, so its
          readout is visible state and stays — the scholar still has to work out
          when to stop. See `liveReadoutPolicy`. */}
      {showTime && (
        <Text
          textAlign="center"
          mt={2}
          fontSize="26px"
          fontWeight="800"
          color="brand.primary"
          fontVariantNumeric="tabular-nums"
          style={{ background: wash(C.violet, 0.1), borderRadius: 12, padding: "4px 0" }}
        >
          {formatClockTime(minutes)}
        </Text>
      )}
    </Box>
  );
}
