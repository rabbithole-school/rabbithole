"use client";

/**
 * Function Machine — a hidden rule (out = m·in + b, a small closed set of
 * "rule shapes" — see `FunctionMachineRule`) turns inputs into outputs. The
 * scholar studies a few worked examples, then predicts the output for one
 * un-worked query input. Isolates: function/pattern inference — "find the
 * rule from examples," the seed of algebraic thinking.
 *
 * No draggable state here (there's nothing to manipulate — the examples are
 * fixed, worked facts): the self-check verdict flows entirely through the
 * shared typed-`answer` path in `Manipulative.tsx` (see `functionMachineSolved`
 * in `logic.ts` for the equivalent, directly-testable pure predicate). That
 * typed field lives in the FRAME, not here — so this component's only job
 * toward grading is to ECHO it into `onStateChange` as `{predicted}`, the
 * shape `functionMachineSolved` reads. Without this echo, practice mode's
 * `state` (what Done actually submits) stays `null` forever and Done can
 * never fire — a real bug fixed 2026-08-03 (review finding on wave-2 content
 * coverage): the frame already threads its live `typedAnswer` down for
 * exactly this reason.
 */
import { useEffect } from "react";
import { Box, Flex, Text } from "@chakra-ui/react";
import type { KindProps } from "../Manipulative";
import type { FunctionMachineSpec } from "@/lib/manipulative/types";
import { C, wash } from "../colors";
import { functionMachineStateFromTypedAnswer } from "@/lib/manipulative/logic";

const VBW = 520,
  VBH = 260;
const HOPPER_X = 70,
  MACHINE_X = 260,
  TRAY_X = 450,
  MID_Y = 130;

function Gear({ cx, cy, r, color, teeth = 8, spin = 1 }: { cx: number; cy: number; r: number; color: string; teeth?: number; spin?: number }) {
  const toothPoints = Array.from({ length: teeth }, (_, i) => {
    const a = (i / teeth) * 360;
    return (
      <rect
        key={i}
        x={cx - r * 0.22}
        y={cy - r * 1.28}
        width={r * 0.44}
        height={r * 0.32}
        rx={2}
        fill={color}
        transform={`rotate(${a} ${cx} ${cy})`}
      />
    );
  });
  return (
    <g>
      <animateTransform
        attributeName="transform"
        type="rotate"
        from={`0 ${cx} ${cy}`}
        to={`${360 * spin} ${cx} ${cy}`}
        dur="14s"
        repeatCount="indefinite"
      />
      {toothPoints}
      <circle cx={cx} cy={cy} r={r} fill={color} stroke={C.navy} strokeWidth={1.5} />
      <circle cx={cx} cy={cy} r={r * 0.36} fill={C.navy} opacity={0.18} />
    </g>
  );
}

function NumberChip({ x, y, value, color }: { x: number; y: number; value: number | string; color: string }) {
  return (
    <g>
      <rect x={x - 26} y={y - 18} width={52} height={36} rx={9} fill={wash(color, 0.9)} stroke={C.navy} strokeWidth={1.5} />
      <text x={x} y={y + 6} textAnchor="middle" fontSize="17" fontWeight="800" fill={C.navy}>
        {value}
      </text>
    </g>
  );
}

export function FunctionMachineManipulative({
  spec,
  onSolvedChange,
  onStateChange,
  typedAnswer,
}: KindProps<FunctionMachineSpec>) {
  // No manipulable state; the verdict is entirely the typed-answer path (see
  // file header). Report a stable, unused "false" so the frame's contract is
  // satisfied uniformly across kinds.
  useEffect(() => {
    onSolvedChange(false);
  }, [onSolvedChange]);

  // Echo the frame's live typed prediction into the shared `state` channel as
  // `{predicted}` — the ONLY thing practice mode's Done actually submits. An
  // empty/non-numeric typed value reports `null` (not `{predicted: null}`),
  // matching every other kind's "nothing to submit yet" contract and keeping
  // Done disabled until a real number is entered. Uses the same pure mapping
  // `functionMachineStateFromTypedAnswer` a test drives directly.
  useEffect(() => {
    onStateChange?.(functionMachineStateFromTypedAnswer(typedAnswer));
  }, [typedAnswer, onStateChange]);

  return (
    <Box>
      <svg viewBox={`0 0 ${VBW} ${VBH}`} role="img" aria-label={`${spec.prompt} machine`} style={{ width: "100%", height: "auto" }}>
        {/* conveyor lines */}
        <line x1={HOPPER_X + 34} y1={MID_Y} x2={MACHINE_X - 58} y2={MID_Y} stroke={C.line} strokeWidth={6} strokeLinecap="round" />
        <line x1={MACHINE_X + 58} y1={MID_Y} x2={TRAY_X - 34} y2={MID_Y} stroke={C.line} strokeWidth={6} strokeLinecap="round" />
        {/* arrowheads */}
        <path d={`M ${MACHINE_X - 66},${MID_Y - 8} L ${MACHINE_X - 52},${MID_Y} L ${MACHINE_X - 66},${MID_Y + 8}`} fill={C.charcoal} />
        <path d={`M ${TRAY_X - 42},${MID_Y - 8} L ${TRAY_X - 28},${MID_Y} L ${TRAY_X - 42},${MID_Y + 8}`} fill={C.charcoal} />

        {/* hopper (input) */}
        <path
          d={`M ${HOPPER_X - 44},${MID_Y - 60} L ${HOPPER_X + 44},${MID_Y - 60} L ${HOPPER_X + 20},${MID_Y} L ${HOPPER_X - 20},${MID_Y} Z`}
          fill={wash(C.cyan, 0.35)}
          stroke={C.navy}
          strokeWidth={2}
        />
        <NumberChip x={HOPPER_X} y={MID_Y - 74} value="in" color={C.cyan} />

        {/* machine box */}
        <rect x={MACHINE_X - 58} y={MID_Y - 56} width={116} height={112} rx={18} fill={wash(C.violet, 0.14)} stroke={C.navy} strokeWidth={2.5} />
        <Gear cx={MACHINE_X - 16} cy={MID_Y - 4} r={17} color={wash(C.orange, 0.9)} spin={1} />
        <Gear cx={MACHINE_X + 20} cy={MID_Y + 20} r={12} color={wash(C.violet, 0.85)} teeth={6} spin={-1.4} />
        <circle cx={MACHINE_X} cy={MID_Y - 40} r={13} fill={C.navy} />
        <text x={MACHINE_X} y={MID_Y - 35} textAnchor="middle" fontSize="15" fontWeight="800" fill="white">
          ?
        </text>

        {/* tray (output) */}
        <path
          d={`M ${TRAY_X - 20},${MID_Y} L ${TRAY_X + 20},${MID_Y} L ${TRAY_X + 40},${MID_Y + 44} L ${TRAY_X - 40},${MID_Y + 44} Z`}
          fill={wash(C.green, 0.3)}
          stroke={C.navy}
          strokeWidth={2}
        />
        <NumberChip x={TRAY_X} y={MID_Y - 74} value="out" color={C.green} />
      </svg>

      <Text mt={1} mb={2} fontSize="13px" fontWeight="700" color="fg.muted" textAlign="center">
        Study the examples. What does the machine always do?
      </Text>
      <Flex justify="center" wrap="wrap" gap={2} mb={3}>
        {spec.examples.map((ex, i) => (
          <Flex
            key={i}
            align="center"
            gap={2}
            px="12px"
            py="6px"
            borderRadius="12px"
            borderWidth="1px"
            borderColor="border.default"
            bg="white"
          >
            <Text fontSize="15px" fontWeight="800" color={C.charcoal}>
              {ex.in}
            </Text>
            <Text fontSize="14px" color="fg.subtle">
              →
            </Text>
            <Text fontSize="15px" fontWeight="800" color={C.teal}>
              {ex.out}
            </Text>
          </Flex>
        ))}
      </Flex>
      <Flex justify="center">
        <Flex
          align="center"
          gap={2}
          px="14px"
          py="7px"
          borderRadius="12px"
          borderWidth="2px"
          borderStyle="dashed"
          style={{ borderColor: wash(C.orange, 0.8), background: wash(C.yellow, 0.18) }}
        >
          <Text fontSize="15px" fontWeight="800" color={C.navy}>
            {spec.queryInput}
          </Text>
          <Text fontSize="14px" color="fg.subtle">
            →
          </Text>
          <Text fontSize="15px" fontWeight="800" color={C.navy}>
            ?
          </Text>
        </Flex>
      </Flex>
    </Box>
  );
}
