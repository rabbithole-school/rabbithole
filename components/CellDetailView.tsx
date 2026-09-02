"use client";

/**
 * CellDetailView — the number→standard zoom, in a Chakra Drawer. Clicking a
 * coarse (strand, grade) Knowledge-Tree cell slides this in: the band's real
 * CCSS/NGSS standards, clustered by domain, each colored by the scholar's
 * mastery, flowing left → right so the frontier INSIDE the band is visible.
 * Nodes render as plain-language understandings with the code as a tag.
 *
 * A drawer (not an inline panel) so the detail is always on-screen regardless
 * of scroll. From a node, "View in star map" pivots to the Sky tab anchored on
 * that concept (onPivotToSky) — the grounded tree and the open map are separate
 * graphs sharing one anchor. Reads acceleration.cellDetail.
 */

import { Box, Drawer, Flex, Portal, Spinner, Stack, Text } from "@chakra-ui/react";
import { ArrowUpRight, CaretLeft, Check, Checks, X, type Icon } from "@phosphor-icons/react";
import { useCallback, useMemo, useState } from "react";
import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { bloomLabel, bloomLevelFromPct } from "@/lib/bloom";
import { ConceptDetail } from "@/components/MasteryTab";
import { NodeDrawer } from "@/components/NodeDrawer";
import { Automaticity } from "@/components/Automaticity";
import { BloomLadder } from "@/components/BloomLadder";

type Stop = "notyet" | "approaching" | "met" | "beyond";
// Option C — the four-stop "Beyond" scale (same palette as the grid): a node's
// colour says where the scholar lands vs the standard's OWN expected rigor.
const STOP: Record<Stop, { bg: string; border: string; color: string }> = {
  notyet: { bg: "#f1f3f6", border: "#dfe4ea", color: "#9aa3af" },
  approaching: { bg: "#fbf4dd", border: "#e3c07a", color: "#8a6d1c" },
  met: { bg: "#d8efe1", border: "#7cc49b", color: "#1f7a52" },
  beyond: { bg: "#dff1f0", border: "#5fb6b0", color: "#16707e" },
};
const STOP_LABEL: Record<Stop, string> = {
  notyet: "not yet",
  approaching: "approaching",
  met: "met",
  beyond: "beyond",
};
// One legend, shared by the grid and the drawer: met = a single check, beyond
// = a double check (the same Phosphor glyphs the marker uses), so "met" and
// "beyond" read identically everywhere. No sparkle (it collided with the
// automaticity diamonds).
const STOP_LEGEND: Array<{ stop: Stop; Icon: Icon | null }> = [
  { stop: "notyet", Icon: null },
  { stop: "approaching", Icon: null },
  { stop: "met", Icon: Check },
  { stop: "beyond", Icon: Checks },
];
const STOP_ORDER: Stop[] = ["notyet", "approaching", "met", "beyond"];

const GRADE_LABEL = (g: string) => (g === "K" ? "Kindergarten" : `Grade ${g}`);

// Segmented distribution ring (the band's four-stop spread) — r=26, C≈163.4.
// The centre headline is the SHARED coverage % (met-or-beyond over ALL the
// band's standards), passed in from the server's summarizeBand so it's the SAME
// number the grid cell shows. The arc segments visualise the full spread.
function DistributionRing({ dist, atBarPct }: { dist: { notyet: number; approaching: number; met: number; beyond: number }; atBarPct: number }) {
  const total = dist.notyet + dist.approaching + dist.met + dist.beyond || 1;
  const r = 26;
  const C = 2 * Math.PI * r;
  const segs = useMemo(
    () =>
      STOP_ORDER.reduce<{
        segments: Array<{ stop: Stop; len: number; gap: number; offset: number }>;
        cumulative: number;
      }>(
        ({ segments, cumulative }, stop) => {
          const frac = dist[stop] / total;
          const len = frac * C;
          return {
            segments: [
              ...segments,
              { stop, len, gap: C - len, offset: -cumulative * C },
            ],
            cumulative: cumulative + frac,
          };
        },
        { segments: [], cumulative: 0 },
      ).segments,
    [C, dist, total],
  );
  return (
    <svg width="72" height="72" viewBox="0 0 72 72" role="img" aria-label={`${atBarPct}% of the band's standards met or beyond the bar`} data-testid="band-ring" data-atbar-pct={atBarPct}>
      <g transform="translate(36,36) rotate(-90)" fill="none" strokeWidth="9">
        {segs.map((s) => (
          <circle key={s.stop} r={r} stroke={STOP[s.stop].border} strokeDasharray={`${s.len.toFixed(1)} ${s.gap.toFixed(1)}`} strokeDashoffset={s.offset.toFixed(1)} strokeLinecap="butt" />
        ))}
      </g>
      <text x="36" y="35" textAnchor="middle" fontSize="14" fontWeight="800" fill="#16707e">{atBarPct}%</text>
      <text x="36" y="45" textAnchor="middle" fontSize="6.5" fill="#5a6472">met+</text>
    </svg>
  );
}

export type DetailCell = { strandKey: string; strandLabel: string; grade: string };

type SelectedNode = { standardId: string; title: string; notation?: string };

export function CellDetailView({
  scholarId,
  cell,
  onClose,
  onPivotToSky,
}: {
  scholarId: string;
  /** The clicked cell, or null when the drawer is closed. */
  cell: DetailCell | null;
  onClose: () => void;
  /** Pivot a concept into the Sky (open-map) tab, anchored on it. */
  onPivotToSky?: (concept: string, grounding?: string) => void;
}) {
  const data = useQuery(
    api.acceleration.cellDetail,
    cell
      ? { scholarId: scholarId as Id<"users">, strandKey: cell.strandKey, grade: cell.grade }
      : "skip",
  );

  // The node whose full evidence record (Bloom · confidence · override ·
  // history · misconception) is open — Tree ⊃ Mastery: the node is the entry
  // point to the same per-concept record the Mastery tab shows.
  //
  // Stamped with the cell it belongs to and DERIVED, rather than cleared by an
  // effect: the effect ran after the paint, so switching bands with the
  // evidence pane open showed the OLD standard under the NEW band's header for
  // a frame. Deliberately NOT a `key` on this component — its root is a
  // `Drawer.Root`, and remounting an Ark overlay scope while `open` leaks the
  // body lock (`pointer-events: none` page-wide; see
  // `.claude/rules/engineering-principles.md`). Deriving avoids the remount.
  const cellKey = cell ? `${cell.strandKey}:${cell.grade}` : null;
  const [selectedFor, setSelectedFor] = useState<{
    cellKey: string | null;
    node: SelectedNode | null;
  }>({ cellKey, node: null });
  const selected = selectedFor.cellKey === cellKey ? selectedFor.node : null;
  const setSelected = useCallback(
    (node: SelectedNode | null) => setSelectedFor({ cellKey, node }),
    [cellKey],
  );

  return (
    <Drawer.Root
      open={!!cell}
      onOpenChange={(d) => !d.open && onClose()}
      placement="end"
      size={{ base: "full", md: "xl" }}
    >
      <Portal>
        <Drawer.Backdrop bg="blackAlpha.300" zIndex={1600} />
        <Drawer.Positioner zIndex={1600}>
          <Drawer.Content data-testid="cell-detail" data-strand={cell?.strandKey} data-grade={cell?.grade}>
            <Drawer.Header borderBottom="1px solid" borderColor="gray.100" px={6} py={4}>
              <Flex justify="space-between" align="center" w="full">
                <Drawer.Title fontFamily="heading" fontWeight="700" fontSize="md" color="navy.600">
                  🔍 {cell ? `${cell.strandLabel} · ${GRADE_LABEL(cell.grade)}` : ""}
                </Drawer.Title>
                <Drawer.CloseTrigger asChild>
                  <Box
                    as="button"
                    data-testid="cell-detail-close"
                    color="charcoal.400"
                    _hover={{ color: "charcoal.600" }}
                    aria-label="Close"
                  >
                    <X size={18} weight="bold" />
                  </Box>
                </Drawer.CloseTrigger>
              </Flex>
            </Drawer.Header>

            <Drawer.Body px={6} py={5}>
              {selected ? (
                <Box>
                  <Box
                    as="button"
                    data-testid="evidence-back"
                    onClick={() => setSelected(null)}
                    display="inline-flex"
                    alignItems="center"
                    gap={1}
                    mb={3}
                    cursor="pointer"
                    fontSize="xs"
                    fontWeight="700"
                    color="violet.600"
                    _hover={{ color: "violet.700" }}
                  >
                    <CaretLeft size={12} weight="bold" /> Back to {cell?.strandLabel} ·{" "}
                    {GRADE_LABEL(cell?.grade ?? "")}
                  </Box>
                  <Box data-testid="node-evidence">
                    <ConceptDetail
                      scholarId={scholarId}
                      standardId={selected.standardId}
                      title={selected.title}
                      onClose={() => setSelected(null)}
                    />
                  </Box>
                  {/* NodeDrawer replaces StandardMeat — one unified neighbourhood
                      canvas (tech-tree + sky), with the "Open map" affordance
                      folded in (no separate View-in-star-map button needed). */}
                  <NodeDrawer
                    standardId={selected.standardId}
                    scholarId={scholarId}
                    onPivotToSky={onPivotToSky}
                  />
                </Box>
              ) : !cell ? null : data === undefined ? (
                <Flex h="160px" align="center" justify="center">
                  <Spinner color="violet.400" />
                </Flex>
              ) : data.totalNodes === 0 ? (
                <Text fontSize="sm" color="charcoal.400">
                  No standards found for this band.
                </Text>
              ) : (
                <>
                  <Flex gap={4} align="center" mb={4}>
                    <DistributionRing dist={data.dist} atBarPct={data.coveragePct} />
                    <Box flex={1}>
                      <Text fontSize="xs" color="charcoal.400">
                        The fine sub-topic graph behind this cell — {data.totalNodes} standards,
                        {" "}{data.evidenced} with evidence
                        {data.understood > 0 ? `, ${data.understood} as plain-language understandings (code kept as a tag)` : ""}.
                        The ring (and the cell&apos;s number) is the share met or beyond the bar; each node is coloured by where the scholar lands vs that standard&apos;s own bar.
                        Click an evidenced node for its full record; tap ↗ to view it in the Sky.
                      </Text>
                      <Flex gap={3} wrap="wrap" mt={2} fontSize="10px" color="charcoal.500" fontWeight="600" align="center" userSelect="none">
                        {STOP_LEGEND.map(({ stop, Icon }) => (
                          <Flex key={stop} align="center" gap={1}>
                            <Flex
                              w="15px"
                              h="15px"
                              borderRadius="4px"
                              borderWidth="1px"
                              align="center"
                              justify="center"
                              bg={STOP[stop].bg}
                              borderColor={STOP[stop].border}
                            >
                              {Icon ? <Icon size={9} weight="bold" color={STOP[stop].color} /> : null}
                            </Flex>
                            {STOP_LABEL[stop]} {data.dist[stop]}
                          </Flex>
                        ))}
                      </Flex>
                    </Box>
                  </Flex>
                  <Stack gap={4}>
                    {data.domains.map((domain) => (
                      <Box key={domain.key}>
                        <Text
                          fontSize="11px"
                          fontWeight="700"
                          color="charcoal.500"
                          textTransform="uppercase"
                          letterSpacing="0.04em"
                          mb={1.5}
                        >
                          {domain.label}
                        </Text>
                        <Flex gap={2} wrap="wrap" align="stretch">
                          {domain.nodes.map((node) => {
                            const s = STOP[node.stop as Stop];
                            const hasU = !!node.understanding;
                            const concept = node.understanding ?? node.description;
                            // Depth (Bloom) the coarse node colour can't carry:
                            // recover the 0–5 level from the node's mastery %.
                            const bloom =
                              node.pct !== null
                                ? bloomLabel(bloomLevelFromPct(node.pct))
                                : null;
                            const evidenced = node.pct !== null;
                            return (
                              <Box
                                key={node.id}
                                data-testid={`detail-node-${node.notation ?? node.id}`}
                                data-status={node.status}
                                data-stop={node.stop}
                                data-has-understanding={hasU ? "true" : "false"}
                                data-bloom={bloom ?? ""}
                                onClick={
                                  evidenced
                                    ? () => setSelected({ standardId: node.id, title: concept, notation: node.notation ?? undefined })
                                    : undefined
                                }
                                position="relative"
                                bg={s.bg}
                                borderWidth="1.5px"
                                borderColor={s.border}
                                borderRadius="md"
                                px={2.5}
                                py={1.5}
                                w="150px"
                                cursor={evidenced ? "pointer" : "default"}
                                _hover={evidenced ? { borderColor: s.color } : undefined}
                                title={
                                  evidenced
                                    ? `${node.notation ? node.notation + ": " : ""}${node.description} — ${node.pct}% · click for the evidence record`
                                    : `${node.notation ? node.notation + ": " : ""}${node.description} — not yet probed`
                                }
                                css={{ "&:hover [data-pivot]": { opacity: 1 } }}
                              >
                                <Box
                                  as="button"
                                  data-pivot
                                  data-testid={`node-pivot-${node.notation ?? node.id}`}
                                  onClick={(e: React.MouseEvent) => {
                                    e.stopPropagation();
                                    onPivotToSky?.(concept, node.notation);
                                  }}
                                  position="absolute"
                                  top="3px"
                                  right="3px"
                                  opacity={0}
                                  transition="opacity 0.1s"
                                  color={s.color}
                                  bg="whiteAlpha.800"
                                  borderRadius="sm"
                                  p="1px"
                                  title="View in star map (the open-map Sky view, anchored on this concept)"
                                  aria-label="View in star map"
                                >
                                  <ArrowUpRight size={11} weight="bold" />
                                </Box>
                                <Text fontSize="11px" fontWeight="600" color={s.color} lineClamp={2} lineHeight="1.25" pr={3}>
                                  {concept}
                                </Text>
                                <Flex mt={1} gap={1.5} align="center" wrap="wrap">
                                  {/* Depth: a neutral Bloom ladder + the named
                                      level. Colour is reserved for the four-stop
                                      mastery scale, so depth reads in monochrome
                                      and never competes with met/beyond. Only on
                                      evidenced nodes (a not-yet-probed node has
                                      no depth to name). */}
                                  {bloom && (
                                    <Flex
                                      align="center"
                                      gap={1}
                                      data-testid={`node-bloom-${node.notation ?? node.id}`}
                                      title={`Depth: ${bloom}`}
                                    >
                                      <BloomLadder level={node.pct !== null ? bloomLevelFromPct(node.pct) : null} size={9} title={`Depth: ${bloom}`} />
                                      <Text
                                        display="inline-block"
                                        fontSize="8px"
                                        fontWeight="700"
                                        textTransform="lowercase"
                                        letterSpacing="0.02em"
                                        color="charcoal.500"
                                      >
                                        {bloom}
                                      </Text>
                                    </Flex>
                                  )}
                                  {node.notation && (
                                    <Text
                                      display="inline-block"
                                      fontSize="8px"
                                      fontWeight="700"
                                      fontFamily="mono"
                                      color={s.color}
                                      opacity={0.7}
                                      bg="whiteAlpha.700"
                                      borderRadius="sm"
                                      px={1}
                                    >
                                      {node.notation}
                                    </Text>
                                  )}
                                  {/* Automaticity (lightning = speed) —
                                      honesty-gated: only where a real fluency
                                      signal exists. */}
                                  <Automaticity
                                    level={node.fluencyLevel}
                                    source={node.fluencySource}
                                    size={10}
                                  />
                                </Flex>
                              </Box>
                            );
                          })}
                        </Flex>
                      </Box>
                    ))}
                  </Stack>
                </>
              )}
            </Drawer.Body>

            {/* Citation footer — attributes the standard codes (e.g. A.2.5e) to
                their source framework(s), so the drawer never shows bare codes
                with no provenance. Kept visible across the band + concept
                sub-views since both draw from the same band's standards. */}
            {data && data.sources.length > 0 && (
              <Drawer.Footer
                borderTop="1px solid"
                borderColor="gray.100"
                px={6}
                py={3}
                flexDirection="column"
                alignItems="flex-start"
                gap={0.5}
              >
                <Text
                  fontSize="10px"
                  fontWeight="700"
                  color="charcoal.400"
                  textTransform="uppercase"
                  letterSpacing="0.04em"
                >
                  Standards source
                </Text>
                <Box data-testid="cell-detail-sources">
                  {data.sources.map((src) => (
                    <Text key={src.title} fontSize="11px" color="charcoal.500" lineHeight="1.4">
                      {src.title}{" "}
                      <Text as="span" color="charcoal.400">
                        ({src.jurisdiction})
                      </Text>
                    </Text>
                  ))}
                </Box>
              </Drawer.Footer>
            )}
          </Drawer.Content>
        </Drawer.Positioner>
      </Portal>
    </Drawer.Root>
  );
}
