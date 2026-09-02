"use client";

/**
 * CohortTreeView — the aggregate cohort TREE lens of the Math Skills studio.
 *
 * The scholar Tree Map is a per-scholar 3D canvas; this is its cross-scholar
 * counterpart and RESTORES the multi-scholar tree capability the studio lost.
 * The node SET (skills + prerequisite edges + grade/strand) is scholar-agnostic,
 * so this reuses the EXACT layout engine the scholar tree uses
 * (`buildTreeVMs` / `computeGradeRuler` / `buildFrontierLines` from
 * shared/treeMapLayout) — positions, columns, lanes, and the grade ruler are
 * identical — and only the per-node READING is a cohort aggregate:
 *
 *   - single scholar = a solid mastery-band DISC (the canonical scholar mark;
 *                      `placed` stays hollow), coloured by the SACRED mastery
 *                      palette (`masteryDotColor`).
 *   - many scholars  = ALWAYS a distribution RING (a donut), never a disc, so
 *                      an aggregate map can never be misread as one scholar's
 *                      dots. A fully-agreed cohort is a one-colour ring; a
 *                      split cohort shows proportional band arcs. A hue-free
 *                      "Aggregate · N scholars" chip labels the mode.
 *   - frontier       = the reused frontier poly-line = the class's leading edge.
 *
 * Access locks are DELIBERATELY not drawn here — locks are the rail's / list's
 * canonical signal; the tree stays one mastery-progress rendering (no second
 * vocabulary). This is a lighter 2D SVG on purpose (the 3D MapTreeCanvas is a
 * single-scholar exploration surface); teacher legibility over immersion.
 */

import { useMemo } from "react";
import { useSmoothedQuery } from "@/hooks/useSmoothedQuery";
import { Box, Flex, Spinner, Text } from "@chakra-ui/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import {
  buildFrontierLines,
  buildTreeVMs,
  computeGradeRuler,
  smoothPath,
  type MasteryState,
  type TreeNode,
} from "@/shared/treeMapLayout";
import { masteryDotColor } from "@/shared/masteryDialPalette";
import { STRUGGLING_TITLE_LABEL } from "@/shared/masteryLexicon";
import { humanizeStrand } from "@/shared/practiceDomainLabels";
import { MasteryCenterDot } from "@/components/MasteryCenterDot";
import { EmptyState } from "@/components/ui/EmptyState";

const BAND_ORDER: MasteryState[] = [
  "locked",
  "struggling",
  "frontier",
  "placed",
  "fluent",
  "overlearned",
];
const BAND_LABEL: Record<MasteryState, string> = {
  locked: "Not started",
  struggling: STRUGGLING_TITLE_LABEL,
  frontier: "Practicing",
  placed: "Placed",
  fluent: "Fluent",
  overlearned: "Rock solid",
};

type CohortNode = TreeNode & {
  band: MasteryState;
  bands: Record<MasteryState, number>;
  frontierCount: number;
};

/** SVG arc segment on a circle (for the band-histogram spread ring). */
function arcPath(
  cx: number,
  cy: number,
  r: number,
  start: number,
  end: number,
): string {
  const a0 = (start - 90) * (Math.PI / 180);
  const a1 = (end - 90) * (Math.PI / 180);
  const x0 = cx + r * Math.cos(a0);
  const y0 = cy + r * Math.sin(a0);
  const x1 = cx + r * Math.cos(a1);
  const y1 = cy + r * Math.sin(a1);
  const large = end - start > 180 ? 1 : 0;
  return `M ${x0.toFixed(1)} ${y0.toFixed(1)} A ${r} ${r} 0 ${large} 1 ${x1.toFixed(1)} ${y1.toFixed(1)}`;
}

export function CohortTreeView({
  scholarIds,
  domain,
  selectedNode,
  onSelectNode,
  maxHeight = "70vh",
}: {
  scholarIds: Id<"users">[];
  domain: string;
  selectedNode: string | null;
  onSelectNode: (nodeKey: string) => void;
  /** Bounds the scroll container's vertical extent; the SVG itself still gets
   * its full intrinsic pixel height (see H below) so it never squashes. */
  maxHeight?: number | string;
}) {
  // Keep-previous so a domain switch doesn't blank the map to a spinner.
  const tree = useSmoothedQuery(
    api.cohortPractice.cohortTree,
    scholarIds.length === 0 ? "skip" : { scholarIds, domain },
  );

  const layout = useMemo(() => {
    if (!tree) return null;
    const nodes = tree.nodes as CohortNode[];
    const treeInput = {
      nodes: nodes as TreeNode[],
      edges: tree.edges,
    };
    const domainOrder = [domain];
    const domainLabels = { [domain]: tree.domainLabel };
    const vms = buildTreeVMs(treeInput, [], "teacher", domainOrder, domainLabels);
    const ruler = computeGradeRuler(treeInput, domainOrder);
    // `now` only drives the "moved-since" ghost frontiers, which need per-node
    // becameFluentAt/lastPracticedAt timestamps; aggregate cohort nodes carry
    // none, so only the "current" line is produced and `now` is irrelevant. Pass
    // a stable 0 to keep render pure (no Date.now() during render).
    const frontier = buildFrontierLines(treeInput, 0, domainOrder).find(
      (line) => line.key === "current",
    );
    const bandByKey = new Map(nodes.map((n) => [n.skillKey, n]));

    // Lane rows (strand bands) for the left labels — one per distinct lane.
    const laneRows = new Map<number, { yPct: number; strand: string | null }>();
    for (const vm of vms) {
      if (!laneRows.has(vm.lane)) {
        laneRows.set(vm.lane, { yPct: vm.yPct, strand: vm.strand });
      }
    }
    const lanes = [...laneRows.entries()]
      .map(([lane, row]) => ({ lane, ...row }))
      .sort((a, b) => a.yPct - b.yPct);

    return { vms, ruler, frontier, bandByKey, lanes, nodes };
  }, [tree, domain]);

  if (tree === undefined) {
    return (
      <Flex align="center" justify="center" gap={2} py={16}>
        <Spinner size="sm" color="violet.500" />
        <Text fontSize="sm" color="charcoal.400">
          Assembling the cohort tree…
        </Text>
      </Flex>
    );
  }
  if (!layout || layout.vms.length === 0) {
    return (
      <EmptyState
        title="No skills in this domain yet"
        hint="This domain has no knowledge graph to map."
      />
    );
  }

  // ── pixel canvas ──────────────────────────────────────────────────────────
  // xPct/yPct are 0..100; map to a pixel plane sized by column + lane density so
  // circles stay round (a 0..100 viewBox would distort them) and wide/tall
  // trees scroll in their container (see the both-axis scroll wrapper below)
  // instead of squashing nodes into overlapping "blob" smears. The scale
  // factors here (18px/pct horizontally, 96px/lane vertically) are deliberately
  // generous — a typical domain (~5 lanes, K–G8) should read as a spaced-out
  // graph, not stacked ovals; it's expected (and now supported) for the map to
  // exceed the viewport and scroll both ways.
  const laneCount = layout.lanes.length;
  const colSpan =
    layout.ruler.length > 0
      ? Math.max(...layout.vms.map((v) => v.xPct)) -
        Math.min(...layout.vms.map((v) => v.xPct))
      : 1;
  const W = Math.max(1100, Math.round(colSpan * 18));
  const H = Math.max(320, laneCount * 96 + 64);
  const padL = 148;
  const padT = 40;
  const padR = 32;
  const padB = 24;
  const innerW = W - padL - padR;
  const innerH = H - padT - padB;
  const X = (xPct: number) => padL + (xPct / 100) * innerW;
  const Y = (yPct: number) => padT + (yPct / 100) * innerH;
  // Aggregate (>1 scholar) nodes are drawn as distribution RINGS (a donut),
  // never a solid disc — so a many-scholar map can never be misread as one
  // scholar's dots, even when the whole cohort agrees (then it's a one-colour
  // ring). A single scholar keeps the canonical solid-disc mastery mark. The
  // ring gets a touch more radius than the solid dot so the hollow centre still
  // reads at the smallest zoom, and a heavier stroke so the band colours are
  // easy to see.
  const isAggregate = tree.scholarCount > 1;
  const R = isAggregate ? 11 : 9;
  const RING_STROKE = 6;

  const edgePath = (fromKey: string, toKey: string) => {
    const from = layout.vms.find((v) => v.nodeKey === fromKey);
    const to = layout.vms.find((v) => v.nodeKey === toKey);
    if (!from || !to) return null;
    return { x1: X(from.xPct), y1: Y(from.yPct), x2: X(to.xPct), y2: Y(to.yPct) };
  };

  return (
    <Box userSelect="none">
      {/* Map-specific caption. In aggregate mode (more than one scholar) a
          persistent, hue-free "Aggregate · N scholars" chip makes the mode
          self-evident even as the tree scrolls — the mastery palette is never
          touched for this cue (the chip's magenta is UI chrome only, and is
          deliberately not the studio's selection violet). */}
      <Flex align="center" gap={2} mb={3} wrap="wrap">
        {isAggregate ? (
          <>
            <Flex
              align="center"
              gap={1.5}
              px={2.5}
              py={1}
              borderRadius="full"
              bg="#f6eff8"
              borderWidth="1px"
              borderColor="#ded6f0"
              flexShrink={0}
            >
              <svg width="20" height="14" viewBox="0 0 20 14" aria-hidden="true">
                <circle
                  cx="7"
                  cy="7"
                  r="5"
                  fill="none"
                  stroke="#7a318f"
                  strokeWidth="1.6"
                />
                <circle
                  cx="13"
                  cy="7"
                  r="5"
                  fill="none"
                  stroke="#7a318f"
                  strokeWidth="1.6"
                />
              </svg>
              <Text
                fontSize="xs"
                fontWeight="700"
                color="#7a318f"
                whiteSpace="nowrap"
              >
                Aggregate · {tree.scholarCount} scholars
              </Text>
            </Flex>
            <Text fontSize="xs" color="charcoal.500" minW={0}>
              {tree.domainLabel} · each node is a ring of the cohort&apos;s spread; a
              one-colour ring means the class agrees. The dashed line marks
              where at least one of {tree.scholarCount} scholars is working —
              hover a node to see how many.
            </Text>
          </>
        ) : (
          <Text fontSize="xs" color="charcoal.500">
            {tree.domainLabel} · each dot is this scholar&apos;s current mastery band.
          </Text>
        )}
      </Flex>

      <Box
        overflow="auto"
        maxH={maxHeight}
        borderWidth="1px"
        borderColor="gray.100"
        borderRadius="lg"
        bg="white"
      >
        <svg
          width={W}
          height={H}
          viewBox={`0 0 ${W} ${H}`}
          role="img"
          aria-label={`Cohort mastery tree for ${tree.domainLabel}`}
          style={{ display: "block", minWidth: W, minHeight: H }}
        >
          {/* grade ruler — content bands, never a scholar */}
          {layout.ruler.map((tick) => (
            <g key={tick.grade}>
              <line
                x1={X(tick.xPct)}
                y1={padT - 8}
                x2={X(tick.xPct)}
                y2={H - padB}
                stroke="#eef0ee"
                strokeWidth={1}
              />
              <text
                x={X(tick.xPct)}
                y={padT - 14}
                fontSize={10}
                fill="#9aa0a6"
                textAnchor="middle"
                fontWeight={700}
              >
                {tick.grade === "K" ? "K" : `G${tick.grade}`}
              </text>
            </g>
          ))}

          {/* strand lane labels (left) */}
          {layout.lanes.map((lane) => (
            <text
              key={lane.lane}
              x={padL - 12}
              y={Y(lane.yPct) + 3}
              fontSize={10}
              fill="#6b7280"
              textAnchor="end"
            >
              {humanizeStrand(lane.strand ?? "other")}
            </text>
          ))}

          {/* prerequisite edges (faint) */}
          {tree.edges.map((edge, i) => {
            const seg = edgePath(edge.fromKey, edge.toKey);
            if (!seg) return null;
            return (
              <line
                key={`e${i}`}
                x1={seg.x1}
                y1={seg.y1}
                x2={seg.x2}
                y2={seg.y2}
                stroke="#e3e6e3"
                strokeWidth={1.25}
              />
            );
          })}

          {/* cohort frontier line — the class's leading edge (reused helper) */}
          {layout.frontier && layout.frontier.points.length > 1 && (
            <path
              d={smoothPath(
                layout.frontier.points.map((p) => ({
                  sx: X(p.xPct),
                  sy: Y(p.yPct),
                })),
              )}
              fill="none"
              stroke="#d99a00"
              strokeWidth={1.5}
              strokeDasharray="4 3"
              opacity={0.55}
            />
          )}

          {/* white backing discs: painted above the connecting lines but below
              every node, so the prerequisite edges stop ~2px short of each dot
              and never show through the transparent knockout cutouts. A separate
              pass (not per-node) so one node's halo can't bite into an adjacent
              node's dot. */}
          {layout.vms.map((vm) =>
            layout.bandByKey.get(vm.nodeKey) ? (
              <circle
                key={`bg-${vm.nodeKey}`}
                cx={X(vm.xPct)}
                cy={Y(vm.yPct)}
                r={R + 2}
                fill="#ffffff"
                pointerEvents="none"
              />
            ) : null,
          )}

          {/* nodes: a single scholar keeps the solid median dot; an aggregate
              is ALWAYS a distribution ring (proportional band arcs), so it can
              never be misread as one scholar's dots — even a fully-agreed
              cohort stays a one-colour ring. */}
          {layout.vms.map((vm) => {
            const agg = layout.bandByKey.get(vm.nodeKey);
            if (!agg) return null;
            const cx = X(vm.xPct);
            const cy = Y(vm.yPct);
            const band = agg.band;
            const selected = vm.nodeKey === selectedNode;
            const total = BAND_ORDER.reduce((s, b) => s + agg.bands[b], 0);
            const present = BAND_ORDER.filter((b) => agg.bands[b] > 0);
            // The frontier polyline draws through this node once ANY scholar
            // is working here (frontierCount > 0) — surface the count against
            // the cohort denominator so the line reads as "how many," never an
            // implied class-wide claim from a single scholar.
            const frontierNote =
              isAggregate && agg.frontierCount > 0
                ? ` · ${agg.frontierCount} of ${tree.scholarCount} at the frontier`
                : "";

            // Proportional band arcs around the full circle (aggregate only).
            let angle = 0;
            const segs =
              total > 0
                ? present.map((b) => {
                    const frac = agg.bands[b] / total;
                    const start = angle * 360;
                    angle += frac;
                    const end = angle * 360;
                    return { b, start, end };
                  })
                : [];

            return (
              <g
                key={vm.nodeKey}
                onClick={() => onSelectNode(vm.nodeKey)}
                style={{ cursor: "pointer" }}
                role="button"
                tabIndex={0}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    onSelectNode(vm.nodeKey);
                  }
                }}
                aria-label={
                  isAggregate
                    ? `${vm.label}: cohort spread, median ${BAND_LABEL[band]}${frontierNote}`
                    : `${vm.label}: ${BAND_LABEL[band]}`
                }
              >
                {selected && (
                  <circle
                    cx={cx}
                    cy={cy}
                    r={R + 6}
                    fill="none"
                    stroke="#7c6cf0"
                    strokeWidth={2}
                  />
                )}
                {isAggregate ? (
                  <>
                    {/* hollow centre so the ring reads as a distribution, not a
                        dot — the ring shape is the "this is an aggregate" cue */}
                    <circle cx={cx} cy={cy} r={R} fill="#ffffff" />
                    {segs.length === 1 ? (
                      // whole cohort agrees → a uniform one-colour ring
                      <circle
                        cx={cx}
                        cy={cy}
                        r={R}
                        fill="none"
                        stroke={masteryDotColor(present[0]!)}
                        strokeWidth={RING_STROKE}
                      />
                    ) : (
                      segs.map((seg, i) => (
                        <path
                          key={i}
                          d={arcPath(cx, cy, R, seg.start, seg.end)}
                          fill="none"
                          stroke={masteryDotColor(seg.b)}
                          strokeWidth={RING_STROKE}
                        />
                      ))
                    )}
                  </>
                ) : (
                  /* single scholar: the median band as a solid disc with its
                     redundant, colour-blind-safe shape punched THROUGH it as a
                     transparent knockout; `placed` stays a hollow ring. The shared
                     renderer keeps it identical to the dial + swatches, and the
                     white backing disc behind fills the cutout so lines can't
                     show through it. */
                  <MasteryCenterDot cx={cx} cy={cy} r={R} state={band} />
                )}
                <title>
                  {vm.label} — {present
                    .map((b) => `${agg.bands[b]} ${BAND_LABEL[b].toLowerCase()}`)
                    .join(", ")}
                  {frontierNote}
                </title>
              </g>
            );
          })}
        </svg>
      </Box>
    </Box>
  );
}
