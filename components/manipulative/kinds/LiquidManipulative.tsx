"use client";

/**
 * Liquid — pour into graduated jars by dragging the surface of the liquid,
 * which snaps to the marks printed on the jar. The capacity sibling of the
 * ruler: an amount you read off a scale, not a count of objects.
 *
 * The jars share ONE vertical scale (every jar is drawn at the same px-per-unit
 * and only its HEIGHT differs), so a 4-cup jar is visibly twice a 2-cup jar and
 * "which jar holds more" is answerable by looking. Drawing each jar to a
 * uniform box would make the levels incomparable and quietly destroy the
 * measurement idea.
 *
 * Raw SVG per jar, with a pointer drag on the jar body — the interaction is a
 * vertical fill, so a coordinate-plane library buys nothing here.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { Box, Flex, Text } from "@chakra-ui/react";
import type { KindProps } from "../Manipulative";
import type { LiquidSpec } from "@/lib/manipulative/types";
import { C, wash } from "../colors";
import {
  initialLiquid,
  liquidPxPerUnit,
  liquidSnapLevel,
  liquidSolved,
  liquidStep,
  liquidTotal,
  liquidUnitLabel,
  liveReadoutPolicy,
} from "@/lib/manipulative/logic";

/** Jar drawing box. Heights come from the SHARED per-spec scale
 *  (`liquidPxPerUnit`), never a per-jar clamp — see its doc comment. */
const JAR_WIDTH = 96;
const RIM = 14; // headroom above the "full" line, so a full jar isn't clipped

export function LiquidManipulative({ spec, onSolvedChange, onStateChange }: KindProps<LiquidSpec>) {
  const step = liquidStep(spec);
  // Every jar in the spec shares ONE px-per-unit, so a 4-cup jar draws exactly
  // twice a 2-cup jar (see `liquidPxPerUnit`).
  const pxPerUnit = liquidPxPerUnit(spec);
  const jarBodyHeight = useCallback((capacity: number) => capacity * pxPerUnit, [pxPerUnit]);
  const jarBoxHeight = useCallback((capacity: number) => capacity * pxPerUnit + RIM, [pxPerUnit]);
  const [levels, setLevels] = useState<number[]>(() => initialLiquid(spec).levels);
  const dragging = useRef<number | null>(null);
  const jarRefs = useRef<Array<SVGSVGElement | null>>([]);
  // The live levels mirrored into a ref so the move handler can read them
  // WITHOUT a functional setState updater. React may re-run an updater during
  // render, and calling the parent's onSolvedChange/onStateChange from inside
  // one sets state on `Manipulative` mid-render (React's "Cannot update a
  // component while rendering a different component" warning).
  const levelsRef = useRef(levels);

  const commit = useCallback(
    (next: number[]) => {
      levelsRef.current = next;
      setLevels(next);
      onSolvedChange(liquidSolved(spec, { levels: next }));
      onStateChange?.({ levels: next });
    },
    [spec, onSolvedChange, onStateChange],
  );

  /** Map a pointer y inside jar `i` to a snapped level in that jar. */
  const levelFromPointer = useCallback(
    (i: number, clientY: number): number => {
      const svg = jarRefs.current[i];
      const capacity = spec.vessels[i]?.capacity ?? 0;
      if (!svg) return 0;
      const rect = svg.getBoundingClientRect();
      const bodyHeight = jarBodyHeight(capacity);
      const boxHeight = jarBoxHeight(capacity);
      // The pointer's y in the jar's own viewBox units, measured up from the base.
      const yInBox = ((clientY - rect.top) / rect.height) * boxHeight;
      const fromBase = boxHeight - yInBox;
      return liquidSnapLevel(spec, i, (fromBase / bodyHeight) * capacity);
    },
    [spec, jarBodyHeight, jarBoxHeight],
  );

  useEffect(() => {
    if (typeof window === "undefined") return;
    const onMove = (e: PointerEvent) => {
      const i = dragging.current;
      if (i == null) return;
      e.preventDefault();
      const level = levelFromPointer(i, e.clientY);
      const prev = levelsRef.current;
      if (Math.abs((prev[i] ?? 0) - level) < 1e-9) return;
      commit(prev.map((l, j) => (j === i ? level : l)));
    };
    const onUp = () => {
      dragging.current = null;
    };
    window.addEventListener("pointermove", onMove, { passive: false });
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
    };
  }, [levelFromPointer, commit]);

  const total = liquidTotal(spec, { levels });
  // Both liquid goals NAME their amount, so the live level/total is withheld
  // under a challenge — otherwise a scholar pours until the number matches the
  // prompt instead of reading the jar's printed marks, which is the skill.
  // The gradations stay drawn; they are the scale, not the answer.
  const showAmounts = liveReadoutPolicy(spec).showValue;
  const showTotal = spec.vessels.length > 1 && showAmounts;

  return (
    <Box>
      <Flex justify="center" align="flex-end" gap={{ base: 3, md: 5 }} wrap="nowrap">
        {spec.vessels.map((vessel, i) => {
          const level = levels[i] ?? 0;
          const boxHeight = jarBoxHeight(vessel.capacity);
          const bodyHeight = jarBodyHeight(vessel.capacity);
          const fillHeight = (level / vessel.capacity) * bodyHeight;
          const marks: number[] = [];
          for (let v = step; v < vessel.capacity - 1e-9; v += step) marks.push(Math.round(v / step) * step);

          return (
            <Flex key={i} direction="column" align="center" gap={2} minW={0}>
              <svg
                ref={(el) => {
                  jarRefs.current[i] = el;
                }}
                viewBox={`0 0 ${JAR_WIDTH} ${boxHeight}`}
                width={JAR_WIDTH}
                height={boxHeight}
                style={{ display: "block", touchAction: "none", cursor: "ns-resize", overflow: "visible" }}
                role="slider"
                aria-label={`${vessel.label ?? `Jar ${i + 1}`}, holds ${vessel.capacity} ${spec.unit}`}
                aria-valuemin={0}
                aria-valuemax={vessel.capacity}
                aria-valuenow={level}
                onPointerDown={(e) => {
                  dragging.current = i;
                  // Read the ref, not the render's `levels`: two pours landing
                  // in one React batch would both build from the same stale
                  // array and the first jar's level would be thrown away.
                  const current = levelsRef.current;
                  commit(current.map((l, j) => (j === i ? levelFromPointer(i, e.clientY) : l)));
                }}
              >
                {/* the liquid, drawn first so the glass and its marks sit over it */}
                <rect
                  x={4}
                  y={boxHeight - fillHeight}
                  width={JAR_WIDTH - 8}
                  height={fillHeight}
                  fill={wash(C.cyan, 0.55)}
                />
                {fillHeight > 0 && (
                  <>
                    {/* the meniscus — the surface you actually grab */}
                    <line
                      x1={4}
                      y1={boxHeight - fillHeight}
                      x2={JAR_WIDTH - 4}
                      y2={boxHeight - fillHeight}
                      stroke={C.teal}
                      strokeWidth={3}
                    />
                    <circle cx={JAR_WIDTH - 4} cy={boxHeight - fillHeight} r={9} fill={C.teal} stroke="white" strokeWidth={3} />
                  </>
                )}

                {/* the glass */}
                <path
                  d={`M2 ${RIM * 0.4} L2 ${boxHeight - 2} L${JAR_WIDTH - 2} ${boxHeight - 2} L${JAR_WIDTH - 2} ${RIM * 0.4}`}
                  fill="none"
                  stroke={C.navy}
                  strokeWidth={2.5}
                  strokeLinejoin="round"
                />
                {/* gradations: every mark short, whole units long + labelled */}
                {marks.map((v) => {
                  const y = boxHeight - (v / vessel.capacity) * bodyHeight;
                  const whole = Math.abs(v - Math.round(v)) < 1e-9;
                  return (
                    <g key={`mark-${v}`}>
                      <line x1={2} y1={y} x2={2 + (whole ? 22 : 12)} y2={y} stroke={C.charcoal} strokeWidth={whole ? 2 : 1.2} opacity={0.8} />
                      {whole && (
                        <text x={28} y={y} dominantBaseline="central" fontSize={12} fontWeight={700} fill={C.charcoal} fontFamily="system-ui, sans-serif">
                          {v}
                        </text>
                      )}
                    </g>
                  );
                })}
                {/* the FULL line, named so capacity reads as a fact of the jar */}
                <line x1={2} y1={boxHeight - bodyHeight} x2={JAR_WIDTH - 2} y2={boxHeight - bodyHeight} stroke={C.navy} strokeWidth={2} strokeDasharray="5 4" opacity={0.65} />
                <text
                  x={JAR_WIDTH - 4}
                  y={boxHeight - bodyHeight - 6}
                  textAnchor="end"
                  fontSize={11}
                  fontWeight={700}
                  fill={C.navy}
                  fontFamily="system-ui, sans-serif"
                >
                  {vessel.capacity}
                </text>
              </svg>
              <Text fontSize="13px" fontWeight="700" color="fg.muted" textAlign="center">
                {vessel.label ?? `Jar ${i + 1}`}
              </Text>
              {showAmounts && (
                <Text fontSize="18px" fontWeight="800" color="brand.primary" lineHeight="1">
                  {formatLevel(level)}
                </Text>
              )}
            </Flex>
          );
        })}
      </Flex>

      {showTotal && (
        <Text textAlign="center" mt={3} fontSize="16px" fontWeight="800" color="brand.primary">
          {formatLevel(total)} {liquidUnitLabel(spec.unit, total)} altogether
        </Text>
      )}
    </Box>
  );
}



/** Trim float dust off a gradation level. */
function formatLevel(v: number): string {
  return String(Math.round(v * 1000) / 1000);
}
