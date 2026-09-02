"use client";

/**
 * Balance — a pan balance that tilts by (left − right). Isolates: equality and
 * "do the same to both sides". With a hidden mystery block on the right, it
 * becomes solve-for-x: add units to the left until it's level and you've found
 * the block's value — without ever being told it (control of error).
 */
import { useEffect, useState } from "react";
import { Box, Flex } from "@chakra-ui/react";
import type { KindProps } from "../Manipulative";
import type { BalanceSpec } from "@/lib/manipulative/types";
import { C, wash } from "../colors";
import { balanceSolved, balanceTilt, initialBalance, type BalanceState } from "@/lib/manipulative/logic";
import { Stepper } from "../Stepper";
import { useThemeIcon } from "@/hooks/useThemeIcon";

const VBW = 520, VBH = 300, PX = 260, PY = 92, L = 150;

function rot(dx: number, dy: number, deg: number) {
  const a = (deg * Math.PI) / 180;
  return [PX + dx * Math.cos(a) - dy * Math.sin(a), PY + dx * Math.sin(a) + dy * Math.cos(a)];
}

function Pan({ x, y, units, mystery, color, mysteryIconHref }: { x: number; y: number; units: number; mystery?: number; color: string; mysteryIconHref?: string }) {
  const blocks = [];
  const per = 5;
  for (let i = 0; i < units; i++) {
    const col = i % per;
    const row = Math.floor(i / per);
    blocks.push(
      <rect key={i} x={x - 40 + col * 17} y={y - 16 - row * 17} width={14} height={14} rx={3} fill={wash(color, 0.85)} stroke={C.navy} strokeWidth={1.5} />,
    );
  }
  return (
    <g>
      <line x1={x} y1={y - 62} x2={x} y2={y} stroke={C.charcoal} strokeWidth={2} />
      <path d={`M ${x - 46},${y} Q ${x},${y + 26} ${x + 46},${y}`} fill="none" stroke={C.navy} strokeWidth={3} strokeLinecap="round" />
      {blocks}
      {mystery ? (() => {
        // Place the mystery box in the NEXT free slot after the weights (same
        // grid flow), so it can never overlap a weight however many are on the
        // pan. Slightly larger than a unit so it reads as special.
        const col = units % per;
        const row = Math.floor(units / per);
        const mx = x - 41 + col * 17;
        const my = y - 17 - row * 17;
        const cx = mx + 8, cy = my + 8;
        if (mysteryIconHref) {
          // Bubbling Cauldrons: the cauldron IS the mystery weight — a themed
          // charm icon (still a 1:1 visual stand-in, never a second source of
          // truth for the value) in place of the plain "?" box. A small "?"
          // badge stays on top so it still reads as a hidden number, not just
          // decoration.
          const size = 32;
          return (
            <g>
              <image href={mysteryIconHref} x={cx - size / 2} y={cy - size / 2} width={size} height={size} preserveAspectRatio="xMidYMid meet" />
              <circle cx={cx + size / 2 - 6} cy={cy - size / 2 + 6} r={8} fill={wash(C.orange, 0.95)} stroke={C.navy} strokeWidth={1.25} />
              <text x={cx + size / 2 - 6} y={cy - size / 2 + 9.5} textAnchor="middle" fontSize="11" fontWeight="800" fill={C.navy}>?</text>
            </g>
          );
        }
        return (
          <g>
            <rect x={mx} y={my} width={16} height={16} rx={3} fill={wash(C.orange, 0.9)} stroke={C.navy} strokeWidth={1.5} />
            <text x={cx} y={my + 12} textAnchor="middle" fontSize="13" fontWeight="800" fill={C.navy}>?</text>
          </g>
        );
      })() : null}
    </g>
  );
}

export function BalanceManipulative({ spec, onSolvedChange, onStateChange }: KindProps<BalanceSpec>) {
  const [state, setState] = useState<BalanceState>(() => initialBalance(spec));
  const maxUnits = spec.maxUnits ?? 12;

  useEffect(() => {
    onSolvedChange(balanceSolved(spec, state));
    onStateChange?.(state);
  }, [spec, state, onSolvedChange, onStateChange]);

  const tilt = balanceTilt(spec, state);
  const angle = Math.max(-15, Math.min(15, -tilt * 4)); // left-heavy => left dips
  const [lx, ly] = rot(-L, 0, angle);
  const [rx, ry] = rot(L, 0, angle);
  // The mystery weight's value is still exactly `spec.mysteryRight`, computed
  // the same way as the undecorated variant — the icon is a 1:1 visual
  // stand-in, never a second source of truth (see AreaPerimeter/Array).
  const mysteryIconHref = useThemeIcon(spec.theme);

  return (
    <Box>
      <svg viewBox={`0 0 ${VBW} ${VBH}`} role="group" aria-label={spec.prompt} style={{ width: "100%", height: "auto" }}>
        {/* stand */}
        <path d={`M ${PX - 40},${VBH - 20} L ${PX + 40},${VBH - 20} L ${PX + 12},${PY + 6} L ${PX - 12},${PY + 6} Z`} fill={wash(C.navy, 0.12)} stroke={C.navy} strokeWidth={2} />
        {/* beam */}
        <line x1={lx} y1={ly} x2={rx} y2={ry} stroke={C.navy} strokeWidth={7} strokeLinecap="round" />
        <circle cx={PX} cy={PY} r={9} fill={C.violet} stroke={C.navy} strokeWidth={2} />
        <Pan x={lx} y={ly + 60} units={state.left} color={C.cyan} />
        <Pan x={rx} y={ry + 60} units={state.right} mystery={spec.mysteryRight} mysteryIconHref={mysteryIconHref} color={C.green} />
      </svg>
      <Flex justify="space-around" mt={1} flexWrap="wrap" gap={3}>
        {spec.adjustable.includes("left") && (
          <Stepper value={state.left} min={0} max={maxUnits} label="left" onChange={(v) => setState((s) => ({ ...s, left: v }))} />
        )}
        {spec.adjustable.includes("right") && (
          <Stepper value={state.right} min={0} max={maxUnits} label="right" onChange={(v) => setState((s) => ({ ...s, right: v }))} />
        )}
      </Flex>
    </Box>
  );
}
