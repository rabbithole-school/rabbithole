"use client";

/**
 * FactHeatmap — the teacher-facing +/−/× fact-automaticity grid for ONE scholar
 * (the FastMath-analog picture). This is the diagnostic the per-fact substrate
 * BUYS: family-level mastery can't tell you that `7 × 8` specifically is still
 * effortful; this can.
 *
 * Doctrine (load-bearing): every cell is a SELF-RELATIVE automaticity rung
 * (`classifyFactState`, self-relative to the scholar's own latency baseline) —
 * never a clock, never a cross-scholar norm; there is no time number anywhere.
 * Colour + a colour-blind-safe KNOCKOUT MARK per rung carry the state (the same
 * `MasteryGlyphSvg` geometry PR #1373 put on this very surface), painted from the
 * canonical `masteryDialPalette` and worded from `masteryLexicon` — one palette,
 * one vocabulary. Reads `cohortPractice.factHeatmapForScholar`.
 */

import { useMemo, useState } from "react";
import { useQuery } from "convex/react";
import { Box, Flex, Text, Tooltip, chakra } from "@chakra-ui/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { FAST_MATH_NAME } from "@/shared/fastMathName";
import {
  factKeyFromOperands,
  factKeyLabel,
  factOpGlyph,
  type FactOp,
} from "@/shared/factKey";
import { factGridCellValid } from "@/components/practice/factHeatmapGrid";
import {
  type AutomaticityState,
  automaticityLabel,
} from "@/shared/masteryLexicon";
import { dialHollowFill, MASTERY_DOT_COLOR } from "@/shared/masteryDialPalette";
import type { MasteryState } from "@/shared/treeMapLayout";
import { MasteryGlyphSvg } from "@/components/MasteryGlyphSvg";

export type FastMathFactCell = {
  factKey: string;
  op: FactOp;
  a: number;
  b: number;
  label: string;
  state: AutomaticityState;
  seenCount?: number;
  correctCount?: number;
};

/**
 * How a rung is PAINTED. Colours come from the canonical mastery palette
 * (`masteryDialPalette`) — no bespoke greens — and every rung reads WITHOUT hue
 * via a second channel: a knockout glyph (reusing `MasteryGlyphSvg`), a hollow
 * ring, or a dashed empty cell.
 *
 * `glyphState` is a pure VISUAL PROJECTION onto a `MasteryState` used ONLY to
 * pick a canonical colour + glyph shape — automaticity stays its own vocabulary
 * (`AutomaticityState`); never read these as mastery states. The chosen shapes
 * form a legible ladder: effortful `•` (dot) → fluent `✓` (check) → automatic
 * `✦` (star); `practicing` borrows the `placed` HOLLOW ring ("reliably correct,
 * automaticity not yet proven"); `unseen` is an empty dashed cell.
 */
type RungStyle = {
  bg: string;
  ink: string;
  border?: string;
  dashed?: boolean;
  glyphState: MasteryState | null;
};

function rungStyle(state: AutomaticityState): RungStyle {
  switch (state) {
    case "automatic":
      return { bg: MASTERY_DOT_COLOR.overlearned, ink: "#ffffff", glyphState: "overlearned" };
    case "fluent":
      return { bg: MASTERY_DOT_COLOR.fluent, ink: "#ffffff", glyphState: "fluent" };
    case "practicing":
      return {
        bg: dialHollowFill(),
        ink: "#1f6a48",
        border: MASTERY_DOT_COLOR.fluent,
        glyphState: null,
      };
    case "effortful":
      return { bg: MASTERY_DOT_COLOR.frontier, ink: "#6f4a12", glyphState: "frontier" };
    case "unseen":
    default:
      return {
        bg: dialHollowFill(),
        ink: MASTERY_DOT_COLOR.locked,
        border: MASTERY_DOT_COLOR.locked,
        dashed: true,
        glyphState: null,
      };
  }
}

/** The cell's border rule: a dashed hairline for the empty `unseen` cell, a
 *  solid 2px ring for the hollow `practicing` cell, nothing for filled rungs. */
function rungBorder(s: RungStyle): string | undefined {
  if (s.dashed && s.border) return `1px dashed ${s.border}`;
  if (s.border) return `2px solid ${s.border}`;
  return undefined;
}

/** The redundant, colour-independent mark tucked in a cell corner — the shared
 *  `MasteryGlyphSvg` geometry drawn solid in the cell's ink. Compact enough for
 *  the dense grid; omitted for rungs whose shape is the cell itself (the hollow
 *  `practicing` ring, the dashed `unseen` cell). */
function RungGlyph({ style, size = 12 }: { style: RungStyle; size?: number }) {
  if (!style.glyphState) return null;
  const c = size / 2;
  return (
    <svg
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      aria-hidden
      style={{ position: "absolute", right: "2px", bottom: "1px" }}
    >
      <MasteryGlyphSvg cx={c} cy={c} r={c * 0.82} state={style.glyphState} color={style.ink} />
    </svg>
  );
}

const OP_ORDER: FactOp[] = ["mul", "add", "sub"];
const OP_LABEL: Record<FactOp, string> = {
  mul: "Multiplication",
  add: "Addition",
  sub: "Subtraction",
};

function LegendSwatch({ state, children }: { state: AutomaticityState; children: React.ReactNode }) {
  const s = rungStyle(state);
  return (
    <Flex align="center" gap="7px">
      <Box
        position="relative"
        w="18px"
        h="18px"
        borderRadius="5px"
        bg={s.bg}
        border={rungBorder(s)}
        flexShrink={0}
      >
        <RungGlyph style={s} size={11} />
      </Box>
      <Text as="span" fontSize="12.5px" color="charcoal.600">
        {children}
      </Text>
    </Flex>
  );
}

/**
 * Build the square operand grid for one operation. Commutative ops (add / mul)
 * fold their two operands onto one canonical cell; the renderer paints only the
 * LO≤HI triangle. Subtraction keeps order: rows are the minuends, columns the
 * subtrahends.
 */
function useGrid(cells: FastMathFactCell[], op: FactOp) {
  return useMemo(() => {
    const opCells = cells.filter((c) => c.op === op);
    const byKey = new Map(opCells.map((c) => [c.factKey, c]));
    const glyph = factOpGlyph(op);

    if (op === "sub") {
      const rows = [...new Set(opCells.map((c) => c.a))].sort((x, y) => x - y);
      const cols = [...new Set(opCells.map((c) => c.b))].sort((x, y) => x - y);
      return { rows, cols, byKey, glyph };
    }
    const operands = [...new Set(opCells.flatMap((c) => [c.a, c.b]))].sort((x, y) => x - y);
    return { rows: operands, cols: operands, byKey, glyph };
  }, [cells, op]);
}

function Grid({
  cells,
  op,
  compact,
}: {
  cells: FastMathFactCell[];
  op: FactOp;
  compact: boolean;
}) {
  const { rows, cols, byKey, glyph } = useGrid(cells, op);
  const cellSize = compact ? 16 : 36;
  const headerSize = compact ? 16 : 30;
  const gap = compact ? "2px" : "3px";

  if (rows.length === 0 || cols.length === 0) {
    return (
      <Text fontSize="sm" color="charcoal.400" py={4} textAlign="center">
        No {OP_LABEL[op].split(" ")[1].toLowerCase()} facts practiced yet.
      </Text>
    );
  }

  return (
    <Box overflowX="auto">
      <Box
        as="table"
        mx={compact ? 0 : "auto"}
        style={{ borderCollapse: "separate", borderSpacing: gap }}
      >
        <Box as="tbody">
          <Box as="tr">
            <Box
              as="th"
              w={`${headerSize}px`}
              h={`${headerSize}px`}
              fontSize={compact ? "9px" : "12px"}
              fontWeight="700"
              color="violet.500"
            >
              {glyph}
            </Box>
            {cols.map((c) => (
              <Box
                key={c}
                as="th"
                w={`${cellSize}px`}
                h={`${headerSize}px`}
                fontSize={compact ? "8px" : "12px"}
                fontWeight="700"
                color="charcoal.400"
                textAlign="center"
              >
                {c}
              </Box>
            ))}
          </Box>
          {rows.map((r) => (
            <Box as="tr" key={r}>
              <Box
                as="th"
                w={`${headerSize}px`}
                h={`${cellSize}px`}
                fontSize={compact ? "8px" : "12px"}
                fontWeight="700"
                color="charcoal.400"
                textAlign="center"
              >
                {r}
              </Box>
              {cols.map((c) => {
                const key = factKeyFromOperands(r, glyph, c);
                const cell = key ? byKey.get(key) : undefined;
                // The canonical map contains every servable fact. The triangle
                // rule prevents commutative facts from rendering twice.
                const valid = cell !== undefined && factGridCellValid(op, r, c);
                const state: AutomaticityState = cell?.state ?? "unseen";
                const s = rungStyle(state);
                const product = op === "mul" ? r * c : op === "add" ? r + c : r - c;
                if (!valid) {
                  return (
                    <Box
                      as="td"
                      key={c}
                      w={`${cellSize}px`}
                      h={`${cellSize}px`}
                    />
                  );
                }
                const tooltip = `${factKeyLabel(cell.factKey)} — ${automaticityLabel(cell.state)}${
                  (cell.seenCount ?? 0) > 0
                    ? ` · ${cell.correctCount ?? 0}/${cell.seenCount} correct`
                    : ""
                }`;
                return (
                  <Box
                    as="td"
                    key={c}
                    p={0}
                    w={`${cellSize}px`}
                    h={`${cellSize}px`}
                  >
                    <Tooltip.Root openDelay={200} closeDelay={0}>
                      <Tooltip.Trigger asChild>
                        <chakra.button
                          type="button"
                          aria-label={tooltip}
                          position="relative"
                          w={`${cellSize}px`}
                          h={`${cellSize}px`}
                          display="flex"
                          alignItems="center"
                          justifyContent="center"
                          borderRadius={compact ? "3px" : "8px"}
                          fontSize="13px"
                          fontWeight="700"
                          bg={s.bg}
                          color={s.ink}
                          border={rungBorder(s)}
                          cursor="default"
                          p={0}
                          _focusVisible={{
                            outline: "2px solid",
                            outlineColor: "violet.500",
                            outlineOffset: "1px",
                          }}
                        >
                          {!compact && product}
                          <RungGlyph style={s} size={compact ? 8 : 12} />
                        </chakra.button>
                      </Tooltip.Trigger>
                      <Tooltip.Positioner>
                        <Tooltip.Content fontSize="xs">{tooltip}</Tooltip.Content>
                      </Tooltip.Positioner>
                    </Tooltip.Root>
                  </Box>
                );
              })}
            </Box>
          ))}
        </Box>
      </Box>
    </Box>
  );
}

/**
 * One canonical per-fact grid, reused by the teacher report and the scholar's
 * compact card. Both variants read the same cells and automaticity vocabulary.
 */
export function FastMathFactGrid({
  cells,
  compact = false,
}: {
  cells: FastMathFactCell[];
  compact?: boolean;
}) {
  const { opsWithData, defaultOp } = useMemo(() => {
    const totalCounts = new Map<FactOp, number>();
    const touchedCounts = new Map<FactOp, number>();
    for (const cell of cells) {
      totalCounts.set(cell.op, (totalCounts.get(cell.op) ?? 0) + 1);
      if (cell.state !== "unseen") {
        touchedCounts.set(cell.op, (touchedCounts.get(cell.op) ?? 0) + 1);
      }
    }
    const availableOps = OP_ORDER.filter((op) => (totalCounts.get(op) ?? 0) > 0);
    const richestTouchedOp = availableOps.reduce(
      (best, candidate) =>
        (touchedCounts.get(candidate) ?? 0) > (touchedCounts.get(best) ?? 0)
          ? candidate
          : best,
      availableOps[0],
    );
    return { opsWithData: availableOps, defaultOp: richestTouchedOp };
  }, [cells]);

  const [op, setOp] = useState<FactOp | null>(null);
  const activeOp = op && opsWithData.includes(op) ? op : (defaultOp ?? null);
  if (activeOp === null) return null;

  return (
    <>
      {opsWithData.length > 1 && (
        <Flex
          role="group"
          gap="6px"
          mb={compact ? 2 : 3}
          justify={compact ? "flex-start" : "flex-end"}
          wrap="wrap"
          aria-label="Fast math operation"
        >
          {opsWithData.map((candidate) => {
            const selected = candidate === activeOp;
            return (
              <chakra.button
                type="button"
                key={candidate}
                onClick={() => setOp(candidate)}
                aria-pressed={selected}
                fontSize="sm"
                fontWeight="700"
                px={compact ? "8px" : "12px"}
                py={compact ? "3px" : "5px"}
                borderRadius="8px"
                borderWidth="1px"
                borderColor={selected ? "charcoal.800" : "gray.200"}
                bg={selected ? "charcoal.800" : "bg.subtle"}
                color={selected ? "white" : "charcoal.500"}
                _focusVisible={{
                  outline: "2px solid",
                  outlineColor: "violet.500",
                  outlineOffset: "1px",
                }}
              >
                {OP_LABEL[candidate]}
              </chakra.button>
            );
          })}
        </Flex>
      )}
      <Grid cells={cells} op={activeOp} compact={compact} />
    </>
  );
}

export function FactHeatmap({
  scholarId,
  domain,
  scholarName,
}: {
  scholarId: Id<"users">;
  domain: string;
  scholarName?: string;
}) {
  const data = useQuery(api.cohortPractice.factHeatmapForScholar, {
    scholarId,
    domain,
  });
  const cells = useMemo(() => data?.cells ?? [], [data]);

  if (data === undefined) return null;

  return (
    <Box mb={4}>
      <Flex align="center" gap={2} mb={1.5}>
        <Box as="span" fontSize="15px">
          ⚡
        </Box>
        <Text fontSize="sm" fontWeight="700" color="charcoal.700">
          {FAST_MATH_NAME}
          {scholarName ? ` · ${scholarName.split(" ")[0]}` : ""}
        </Text>
      </Flex>
      <Box bg="white" borderWidth="1px" borderColor="gray.200" borderRadius="xl" p={4}>
        <FastMathFactGrid cells={cells} />

        <Flex wrap="wrap" gap="14px" mt={4}>
          <LegendSwatch state="automatic">{automaticityLabel("automatic")}</LegendSwatch>
          <LegendSwatch state="fluent">{automaticityLabel("fluent")}</LegendSwatch>
          <LegendSwatch state="practicing">{automaticityLabel("practicing")}</LegendSwatch>
          <LegendSwatch state="effortful">
            {automaticityLabel("effortful")} — the sprint pulls from here
          </LegendSwatch>
          <LegendSwatch state="unseen">{automaticityLabel("unseen")}</LegendSwatch>
        </Flex>

        {data.baselineKnown === false && (
          <Text
            mt={3}
            pt={3}
            fontSize="12.5px"
            color="charcoal.400"
            borderTopWidth="1px"
            borderTopColor="gray.100"
            borderTopStyle="dashed"
          >
            Still calibrating this scholar&apos;s own pace — facts stay at{" "}
            <b>practicing</b> until there&apos;s enough to call one automatic (never a
            cross-scholar comparison).
          </Text>
        )}
      </Box>
    </Box>
  );
}
