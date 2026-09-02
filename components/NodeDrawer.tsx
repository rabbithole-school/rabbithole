"use client";

/**
 * NodeDrawer — the unified neighbourhood canvas built on the edge ontology
 * (relation / method / story; see review/edge-ontology.html).
 *
 * ONE canvas where a returned edge's `relation` field carries the distinction:
 *   • Solid blue directed lines (arrowheads) = dependency (buildsOn /
 *     buildsTowards / requires) — the tech-tree spine.
 *   • Faint dashed undirected (no arrowheads) = bridge (associative). Bridges
 *     drawn by a scholar (method "observed") wear a quiet badge.
 *
 * Below the canvas, the "Opens into the world" story family renders the focal
 * node's durable story-bearing bridges (co-fetched as `stories`) as cards.
 *
 * The header unpacks the KnowledgeNodeDial's three gauges into named readings
 * (mastery · automaticity · depth) so the drawer teaches the dial.
 *
 * RETIRES StandardMeat. FOLDS IN ConceptStarMap as an "Open map" affordance.
 */

import { useEffect, useMemo, useState } from "react";
import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { Box, Button, Flex, Text } from "@chakra-ui/react";
import { CaretDown, CaretRight, Compass, MapTrifold, Play, Target, Warning } from "@phosphor-icons/react";
import NextLink from "next/link";
import { NodeItemPool } from "@/components/practice/NodeItemPool";
import { DontKnowStripForNode, RecentMissesForNode } from "@/components/practice/RecentMisses";
import {
  InstructionExampleSheet,
  type InstructionExampleContent,
} from "@/components/practice/InstructionExampleSheet";
import {
  KnowledgeNodeDial,
  type MasteryState,
} from "@/components/KnowledgeNodeDial";
import { NodeStoryFamily, type StoryItem } from "@/components/NodeStoryFamily";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { isCurriculumRole, type Role } from "@/convex/lib/roles";
import { isSelfScholarReference } from "@/shared/instructionReferenceAudience";
import { MASTERY_LABELS, STRUGGLING_LABEL } from "@/shared/masteryLexicon";
import { MASTERY_DOT_COLOR } from "@/shared/masteryDialPalette";

// ── Typed neighbourhood payload ──────────────────────────────────────────────
// Mirrors the shape returned by convex/nodeNeighbourhood.ts so the component
// has clean types without relying on _generated (which doesn't exist yet).

type RetLabel = "fresh" | "due" | "none";

type NeighbourNode = {
  nodeKey: string;
  label: string;
  domain: string;
  source: string | null;
  standardCodes: { framework: string; code: string }[] | null;
};

type NeighbourhoodEdge = {
  fromKey: string;
  toKey: string;
  kind: string;
  relation: "dependency" | "bridge";
  method: string | null;
  weight: number | null;
};

type FocalReadings = {
  // MasteryState — the full five-band render state (placement/re-probe-derived
  // credit surfaces as "placed", never a bare-green "fluent" — see the
  // two-axis doctrine in .claude/rules/rabbithole-practice-engine.md).
  mastery: MasteryState;
  automaticity: number;
  depth: number;
  retentionLabel: RetLabel;
} | null;

type NeighbourhoodData = {
  node: {
    _id: string;
    nodeKey: string;
    label: string;
    domain: string;
    strand: string | null;
    standardCodes: { framework: string; code: string }[] | null;
    verifierKind: string | null;
    /** Server-computed: the engine can actually serve this node (template or
     *  stored non-stretch item) — the gate for the Practice CTA. */
    practiceServeable: boolean;
    rationale: string | null;
    source: string | null;
  };
  edges: NeighbourhoodEdge[];
  stories: StoryItem[];
  neighbours: NeighbourNode[];
  focalReadings: FocalReadings;
  neighbourMastery: Record<
    string,
    { mastery: MasteryState; automaticity: number; retentionLabel: RetLabel }
  >;
} | null;

// ── Colours ──────────────────────────────────────────────────────────────────

const DOT_COLOR = MASTERY_DOT_COLOR;

const CHIP_BG: Record<MasteryState, string> = {
  locked: "#f4f6f9",
  struggling: "#fdecec", // faint red tint — teacher/parent-only
  frontier: "#fdf6e0",
  placed: "#f1f8f4", // fainter than fluent's fill — reads as "not yet solid".
  fluent: "#e8f5ee",
  overlearned: "#d8eedf",
};

const CHIP_BORDER: Record<MasteryState, string> = {
  locked: "#dde1e8",
  struggling: "#f0a9a9",
  frontier: "#e3c07a",
  placed: "#a9d7bf",
  fluent: "#7fc9a0",
  overlearned: "#4d9e72",
};

const CHIP_TEXT: Record<MasteryState, string> = {
  locked: "#9aa3af",
  struggling: "#a12a2a",
  frontier: "#8a6d1c",
  placed: "#2f6f4f",
  fluent: "#1f7a52",
  overlearned: "#0f5530",
};

const MASTERY_LABEL: Record<MasteryState, string> = {
  // "locked" is a reachability fact (prereqs unmet), not a proficiency band —
  // it keeps its own word instead of borrowing the lexicon's not_started.
  locked: "not yet",
  // teacher/parent-only red state — non-deficit, review-oriented word.
  struggling: STRUGGLING_LABEL,
  frontier: MASTERY_LABELS.practicing,
  // provisional: access-proven but INFERRED — never the bare word "fluent".
  placed: MASTERY_LABELS.placed,
  fluent: MASTERY_LABELS.fluent,
  overlearned: MASTERY_LABELS.overlearned,
};

// ── SVG canvas constants ─────────────────────────────────────────────────────

const VW = 560;   // viewBox width
const VH = 220;   // viewBox height (tree only)
const VH_SKY = 262; // extended when sky row is visible

const CW = 116; // neighbour chip width
const CH = 28;  // neighbour chip height
const FW = 152; // focal chip width
const FH = 46;  // focal chip height
const FX = VW / 2;
const FY = 100;
const PREREQ_X = 68;
const UNLOCK_X = VW - 68;
const SKY_Y = 200;
const PREREQ_CAP = 4;
const UNLOCK_CAP = 4;
const BRIDGE_CAP = 5;

type OverflowFamily = "prereq" | "unlock" | "bridge";

function truncate(s: string, max = 14): string {
  return s.length <= max ? s : s.slice(0, max - 1) + "…";
}

// ── SVG node chip helpers ────────────────────────────────────────────────────

function NodeChipSvg({
  cx,
  cy,
  label,
  mastery,
  observed,
  onSelect,
}: {
  cx: number;
  cy: number;
  label: string;
  mastery: MasteryState;
  /** Bridge drawn by a scholar — gets a quiet badge + tooltip. */
  observed?: boolean;
  onSelect?: () => void;
}) {
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const bg = CHIP_BG[mastery];
  const border = CHIP_BORDER[mastery];
  const textCol = CHIP_TEXT[mastery];
  const dot = DOT_COLOR[mastery];
  const interactive = typeof onSelect === "function";
  const ring = interactive && (hovered || focused);
  return (
    <g
      transform={`translate(${cx},${cy})`}
      role={interactive ? "button" : undefined}
      tabIndex={interactive ? 0 : undefined}
      aria-label={interactive ? `Go to ${label}` : undefined}
      onClick={interactive ? onSelect : undefined}
      onKeyDown={
        interactive
          ? (event) => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                onSelect();
              }
            }
          : undefined
      }
      onMouseEnter={interactive ? () => setHovered(true) : undefined}
      onMouseLeave={interactive ? () => setHovered(false) : undefined}
      onFocus={interactive ? () => setFocused(true) : undefined}
      onBlur={interactive ? () => setFocused(false) : undefined}
      style={interactive ? { cursor: "pointer" } : undefined}
    >
      <rect
        x={-CW / 2}
        y={-CH / 2}
        width={CW}
        height={CH}
        rx={6}
        ry={6}
        fill={bg}
        stroke={border}
        strokeWidth={ring ? 2 : 1}
      />
      <circle
        cx={-CW / 2 + 10}
        cy={0}
        r={4}
        fill={mastery === "placed" ? "#ffffff" : dot}
        stroke={mastery === "placed" ? dot : "none"}
        strokeWidth={mastery === "placed" ? 1.5 : 0}
      />
      <text
        x={-CW / 2 + 18}
        y={4}
        fontSize={9.5}
        fontWeight={600}
        fill={textCol}
        fontFamily="system-ui, sans-serif"
      >
        {truncate(label)}
      </text>
      {observed && (
        <g transform={`translate(${CW / 2 - 8},${-CH / 2 + 8})`}>
          <circle r={4} fill="#8a6fc9" stroke="#ffffff" strokeWidth={1} />
          <title>a scholar drew this connection</title>
        </g>
      )}
    </g>
  );
}

function OverflowChipSvg({
  cx,
  cy,
  label,
  onSelect,
}: {
  cx: number;
  cy: number;
  label: string;
  onSelect: () => void;
}) {
  return (
    <g
      transform={`translate(${cx},${cy})`}
      role="button"
      tabIndex={0}
      aria-label={label}
      onClick={onSelect}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onSelect();
        }
      }}
      style={{ cursor: "pointer" }}
    >
      <rect
        x={-CW / 2}
        y={-CH / 2}
        width={CW}
        height={CH}
        rx={14}
        ry={14}
        fill="#ffffff"
        stroke="#9148a3"
        strokeWidth={1.5}
        strokeDasharray="3 2"
      />
      <text
        x={0}
        y={4}
        textAnchor="middle"
        fontSize={9.5}
        fontWeight={700}
        fill="#9148a3"
        fontFamily="system-ui, sans-serif"
      >
        {label}
      </text>
    </g>
  );
}

function FocalChipSvg({
  label,
  domain,
  mastery,
}: {
  label: string;
  domain: string;
  mastery: MasteryState;
}) {
  const bg = CHIP_BG[mastery];
  const border = CHIP_BORDER[mastery];
  const textCol = CHIP_TEXT[mastery];
  return (
    <g transform={`translate(${FX},${FY})`}>
      <rect
        x={-FW / 2}
        y={-FH / 2}
        width={FW}
        height={FH}
        rx={9}
        ry={9}
        fill={bg}
        stroke={border}
        strokeWidth={2}
      />
      <text
        x={0}
        y={-3}
        textAnchor="middle"
        fontSize={11.5}
        fontWeight={700}
        fill={textCol}
        fontFamily="system-ui, sans-serif"
      >
        {truncate(label, 18)}
      </text>
      <text
        x={0}
        y={12}
        textAnchor="middle"
        fontSize={8.5}
        fontWeight={600}
        fill={textCol}
        opacity={0.65}
        fontFamily="system-ui, sans-serif"
      >
        {domain.toUpperCase()}
      </text>
    </g>
  );
}

// ── Main component ───────────────────────────────────────────────────────────

export type NodeDrawerProps = {
  /** Canonical knowledgeNode key — preferred. */
  nodeKey?: string;
  /** Legacy: resolve via by_standard index when nodeKey is absent. */
  standardId?: string;
  /** When set, enriches the canvas with per-scholar mastery readings. */
  scholarId?: string;
  /** Open the ConceptStarMap (open-map sky) anchored on this concept. */
  onPivotToSky?: (concept: string, grounding?: string) => void;
  /** Launch practice set for this node (only shown when practiceServeable). */
  onPractice?: (nodeKey: string) => void;
  /** Pivot the same drawer to a related story endpoint. */
  onNavigate?: (nodeKey: string, label: string) => void;
  /** Redaction: teacher sees misconception detail; scholar/parent do not. */
  audience?: "scholar" | "teacher" | "parent";
};

export function NodeDrawer({
  nodeKey,
  standardId,
  scholarId,
  onPivotToSky,
  onPractice,
  onNavigate,
  audience,
}: NodeDrawerProps) {
  const { user } = useCurrentUser();
  const canEditStories = isCurriculumRole(
    (user?.role ?? undefined) as Role | undefined,
  );

  const rawData = useQuery(
    api.nodeNeighbourhood.neighbourhood,
    nodeKey || standardId
      ? {
          ...(nodeKey ? { nodeKey } : {}),
          ...(standardId
            ? { standardId: standardId as Id<"standards"> }
            : {}),
          ...(scholarId
            ? { scholarId: scholarId as Id<"users"> }
            : {}),
        }
      : "skip",
  ) as NeighbourhoodData | undefined;

  // Teacher-only: open misconception(s) that resolve onto this node. Redacted
  // from scholar/parent views (skipped, so the query never runs).
  const misconceptionData = useQuery(
    api.masteryObservations.openMisconceptionsForNode,
    audience === "teacher" && nodeKey && scholarId
      ? { scholarId: scholarId as Id<"users">, nodeKey }
      : "skip",
  );
  const openMisconceptions = misconceptionData?.misconceptions ?? [];

  // Teacher-only: recurring practice-error pattern(s) on this node (C3, §7 —
  // ≥3 of the same buggy-algorithm miss in 14d). Same redaction as the
  // misconception detail: skipped for scholar/parent, so the query never runs.
  const errorFlagData = useQuery(
    api.practiceSkills.practiceErrorFlagsForNode,
    audience === "teacher" && nodeKey && scholarId
      ? { scholarId: scholarId as Id<"users">, nodeKey }
      : "skip",
  );
  const openErrorPatterns = errorFlagData?.patterns ?? [];

  // Teacher-only: the prerequisite the engine has auto-queued for this node
  // (§5). Same teacher-only redaction as the error flags — scholars never see
  // it, so the query never runs for them.
  const autoRemediation = useQuery(
    api.practiceSkills.autoRemediationTargetForNode,
    audience === "teacher" && nodeKey && scholarId
      ? { scholarId: scholarId as Id<"users">, nodeKey }
      : "skip",
  );

  // On-demand REFERENCE placement (§4.3 "See the move"): a pure pull, no
  // governor, available whenever node-grain content exists (or its strand's,
  // node-first) is PASSED. Skipped without a scholar in view (nothing to
  // resolve retrieval logging against). The READ itself runs for any viewer
  // (teacher/parent may see the same content read-only) — only the WRITE
  // (the retrieval log) is gated below to the scholar's own open.
  const nodeReference = useQuery(
    api.instruction.instructionContentForNode,
    scholarId && nodeKey ? { scholarId: scholarId as Id<"users">, nodeKey } : "skip",
  ) as InstructionExampleContent | null | undefined;
  const [referenceOpen, setReferenceOpen] = useState(false);
  // Same doctrine as `resolveRunLaunchpad`'s `isSelf` guard: only the
  // scholar's OWN open may write telemetry. A teacher/parent viewing this
  // scholar's drawer (whether or not the caller bothered to pass `audience` —
  // see CellDetailView.tsx, which doesn't) must render read-only.
  const isSelfScholarRef = isSelfScholarReference({
    viewerId: user?._id ?? null,
    scholarId: scholarId ?? null,
    audience,
  });

  const [expandedOverflow, setExpandedOverflow] = useState<
    Record<OverflowFamily, boolean>
  >({
    prereq: false,
    unlock: false,
    bridge: false,
  });
  // Teacher-only: the node's practice ITEM POOL (what the engine serves here,
  // editable). Collapsed by default; NodeItemPool mounts — and its query
  // fires — only once opened, so the drawer stays cheap for pure inspection.
  const [poolOpen, setPoolOpen] = useState(false);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- a node identity change must collapse the drawer's transient overflow sections.
    setExpandedOverflow({
      prereq: false,
      unlock: false,
      bridge: false,
    });
  }, [nodeKey, standardId]);
  // ── Derive layout from data ───────────────────────────────────────────────
  const layout = useMemo(() => {
    if (!rawData) return null;
    const { node, edges, stories, neighbours, focalReadings, neighbourMastery } =
      rawData;

    const nodeByKey = new Map<string, NeighbourNode>(
      neighbours.map((n: NeighbourNode) => [n.nodeKey, n]),
    );

    // Dependency spine — classified by the edge.relation field.
    const prereqKeys: string[] = edges
      .filter(
        (e: NeighbourhoodEdge) =>
          e.relation === "dependency" && e.toKey === node.nodeKey,
      )
      .map((e: NeighbourhoodEdge) => e.fromKey);
    const unlockKeys: string[] = edges
      .filter(
        (e: NeighbourhoodEdge) =>
          e.relation === "dependency" && e.fromKey === node.nodeKey,
      )
      .map((e: NeighbourhoodEdge) => e.toKey);

    // Bridge row — dedupe by far-end key, rank observed-method first then by
    // descending weight, cap 5.
    const bridgeByKey = new Map<
      string,
      { key: string; observed: boolean; weight: number }
    >();
    for (const e of edges) {
      if (e.relation !== "bridge") continue;
      const key = e.fromKey === node.nodeKey ? e.toKey : e.fromKey;
      const observed = e.method === "observed";
      const weight = e.weight ?? 0;
      const prev = bridgeByKey.get(key);
      if (
        !prev ||
        (observed && !prev.observed) ||
        (observed === prev.observed && weight > prev.weight)
      ) {
        bridgeByKey.set(key, { key, observed, weight });
      }
    }
    const sortedBridges = [...bridgeByKey.values()]
      .sort((a, b) => {
        if (a.observed !== b.observed) return a.observed ? -1 : 1;
        return b.weight - a.weight;
      });

    const prereqOverflow =
      prereqKeys.length > PREREQ_CAP
        ? prereqKeys.length - (PREREQ_CAP - 1)
        : 0;
    const unlockOverflow =
      unlockKeys.length > UNLOCK_CAP
        ? unlockKeys.length - (UNLOCK_CAP - 1)
        : 0;
    const bridgeOverflow =
      sortedBridges.length > BRIDGE_CAP
        ? sortedBridges.length - (BRIDGE_CAP - 1)
        : 0;

    const visiblePrereqs =
      prereqOverflow > 0
        ? prereqKeys.slice(0, PREREQ_CAP - 1)
        : prereqKeys.slice(0, PREREQ_CAP);
    const visibleUnlocks =
      unlockOverflow > 0
        ? unlockKeys.slice(0, UNLOCK_CAP - 1)
        : unlockKeys.slice(0, UNLOCK_CAP);
    const visibleBridges =
      bridgeOverflow > 0
        ? sortedBridges.slice(0, BRIDGE_CAP - 1)
        : sortedBridges.slice(0, BRIDGE_CAP);

    const prereqSlots = prereqOverflow > 0
      ? [...visiblePrereqs, "__prereq_overflow__"]
      : visiblePrereqs;
    const unlockSlots = unlockOverflow > 0
      ? [...visibleUnlocks, "__unlock_overflow__"]
      : visibleUnlocks;
    const bridgeSlots = bridgeOverflow > 0
      ? [...visibleBridges, { key: "__bridge_overflow__", observed: false, weight: 0 }]
      : visibleBridges;

    const prereqPos = prereqSlots.map((key: string, i: number, arr: string[]) => ({
      key,
      x: PREREQ_X,
      y: arr.length === 1 ? FY : 45 + (i / (arr.length - 1)) * 110,
    }));

    const unlockPos = unlockSlots.map((key: string, i: number, arr: string[]) => ({
      key,
      x: UNLOCK_X,
      y: arr.length === 1 ? FY : 45 + (i / (arr.length - 1)) * 110,
    }));

    const skyPos = bridgeSlots.map((b, i: number, arr) => ({
      key: b.key,
      observed: b.observed,
      x: arr.length === 1 ? VW / 2 : 65 + (i / (arr.length - 1)) * 430,
      y: SKY_Y,
    }));

    const hasSkynodes = skyPos.length > 0;
    const viewH = hasSkynodes ? VH_SKY : VH;

    // aria-label for screen readers
    const labels = (pos: { key: string }[]) =>
      pos.map((p) => nodeByKey.get(p.key)?.label ?? p.key).join(", ");
    const ariaLabel = [
      `Neighbourhood of "${node.label}".`,
      prereqPos.length ? `Prerequisites: ${labels(prereqPos)}.` : "",
      unlockPos.length ? `Unlocks: ${labels(unlockPos)}.` : "",
      skyPos.length ? `Bridges: ${labels(skyPos)}.` : "",
      stories.some((story: StoryItem) => story.direction === "outgoing")
        ? `Opens into the world: ${stories
            .filter((story: StoryItem) => story.direction === "outgoing")
            .map((story: StoryItem) => story.toLabel)
            .join(", ")}.`
        : "",
      stories.some((story: StoryItem) => story.direction === "incoming")
        ? `Reached from: ${stories
            .filter((story: StoryItem) => story.direction === "incoming")
            .map((story: StoryItem) => story.fromLabel)
            .join(", ")}.`
        : "",
    ]
      .filter(Boolean)
      .join(" ");

    return {
      node,
      stories,
      focalReadings,
      neighbourMastery,
      prereqPos,
      unlockPos,
      skyPos,
      nodeByKey,
      viewH,
      ariaLabel,
      hasSkynodes,
      prereqOverflow,
      unlockOverflow,
      bridgeOverflow,
      prereqRemainder: prereqOverflow > 0 ? prereqKeys.slice(PREREQ_CAP - 1) : [],
      unlockRemainder: unlockOverflow > 0 ? unlockKeys.slice(UNLOCK_CAP - 1) : [],
      bridgeRemainder:
        bridgeOverflow > 0
          ? sortedBridges.slice(BRIDGE_CAP - 1).map((bridge) => bridge.key)
          : [],
    };
  }, [rawData]);

  // ── Null / loading states ─────────────────────────────────────────────────
  if (!nodeKey && !standardId) return null;

  if (rawData === undefined) {
    return (
      <Box>
        <Text fontSize="xs" color="charcoal.300">
          Loading neighbourhood…
        </Text>
      </Box>
    );
  }

  // rawData === null → no canonical node found for this standardId yet
  if (rawData === null || !layout) {
    return (
      <Box>
        <Text fontSize="xs" color="charcoal.400" lineHeight="1.5">
          No neighbourhood data — this node hasn&apos;t been mapped to the canonical
          graph yet.
        </Text>
      </Box>
    );
  }

  const {
    node,
    stories,
    focalReadings,
    neighbourMastery,
    prereqPos,
    unlockPos,
    skyPos,
    nodeByKey,
    viewH,
    ariaLabel,
    hasSkynodes,
    prereqOverflow,
    unlockOverflow,
    bridgeOverflow,
    prereqRemainder,
    unlockRemainder,
    bridgeRemainder,
  } = layout;

  const mastery: MasteryState = (focalReadings?.mastery ?? "locked") as MasteryState;
  const automaticity = focalReadings?.automaticity ?? 0;
  const depth = focalReadings?.depth ?? 0;
  const retLabel = focalReadings?.retentionLabel ?? "none";

  const autoText =
    retLabel === "none"
      ? "—"
      : `${Math.round(automaticity * 100)}% · ${retLabel}`;

  const depthText =
    depth > 0 ? `${Math.round(depth * 100)}%` : "—";

  const isEmpty =
    prereqPos.length === 0 &&
    unlockPos.length === 0 &&
    skyPos.length === 0 &&
    stories.length === 0;

  const toggleOverflow = (family: OverflowFamily) => {
    setExpandedOverflow((prev) => ({ ...prev, [family]: !prev[family] }));
  };

  return (
    <Box>
      {/* ── Teacher-only: open misconception(s) on this node ──────────────── */}
      {audience === "teacher" && openMisconceptions.length > 0 && (
        <Box mb={4} bg="#fbf1de" border="1px solid #e3c766" borderRadius="10px" p={3}>
          <Flex align="center" gap={1.5} mb={2} color="#8a6d16">
            <Warning weight="fill" size={16} />
            <Text fontSize="xs" fontWeight="700" textTransform="uppercase" letterSpacing="0.04em">
              Open misconception{openMisconceptions.length > 1 ? "s" : ""}
            </Text>
          </Flex>
          {openMisconceptions.map((m) => (
            <Box key={m._id} _notLast={{ mb: 3, pb: 3, borderBottom: "1px solid #ecdcae" }}>
              <Text fontSize="sm" fontWeight="600" color="#5a3e0f" lineHeight="1.4">
                {m.evidenceSummary}
              </Text>
              {m.misconceptionNote && (
                <Text fontSize="xs" color="#7a5f1c" mt={1.5} lineHeight="1.5">
                  {m.misconceptionNote}
                </Text>
              )}
              {m.transcriptExcerpt && (
                <Text fontSize="xs" color="#8a7a55" mt={1.5} fontStyle="italic" lineHeight="1.5">
                  {m.transcriptExcerpt}
                </Text>
              )}
            </Box>
          ))}
        </Box>
      )}

      {/* ── Teacher-only: recurring practice-error pattern(s) (C3, §7) ─────── */}
      {audience === "teacher" && openErrorPatterns.length > 0 && (
        <Box mb={4} bg="#fbf1de" border="1px solid #e3c766" borderRadius="10px" p={3}>
          <Flex align="center" gap={1.5} mb={2} color="#8a6d16">
            <Warning weight="fill" size={16} />
            <Text fontSize="xs" fontWeight="700" textTransform="uppercase" letterSpacing="0.04em">
              Practice pattern{openErrorPatterns.length > 1 ? "s" : ""}
            </Text>
          </Flex>
          {openErrorPatterns.map((p) => (
            <Box key={p.pattern} _notLast={{ mb: 3, pb: 3, borderBottom: "1px solid #ecdcae" }}>
              <Text fontSize="sm" fontWeight="600" color="#5a3e0f" lineHeight="1.4">
                {p.phrasing}
              </Text>
              <Text fontSize="xs" color="#7a5f1c" mt={1.5} lineHeight="1.5">
                Seen {p.count} times in practice over the last 14 days.
              </Text>
            </Box>
          ))}
          {autoRemediation && (
            <Flex align="center" gap={1.5} mb={2} color="#5a3e0f">
              <Target weight="bold" size={13} />
              <Text fontSize="xs" fontWeight="600" lineHeight="1.4">
                Auto-practice queued: {autoRemediation.label}
              </Text>
            </Flex>
          )}
        </Box>
      )}

      {/* ── Teacher-only: "I haven't learned this yet" vs a wrong answer ─────
          The don't-know strip sits beside the misses card: a cluster of honest
          "I don't know" taps means teach it (never taught), the opposite
          intervention from a cluster of misses (a misconception → diagnose it).
          One attempt renders in exactly one place — dontKnowsForNode counts the
          don't-knows, recentMissesForNode now excludes them. ── */}
      {audience === "teacher" && nodeKey && scholarId && (
        <DontKnowStripForNode scholarId={scholarId} nodeKey={nodeKey} />
      )}
      {audience === "teacher" && nodeKey && scholarId && (
        <RecentMissesForNode scholarId={scholarId} nodeKey={nodeKey} />
      )}

      {/* ── Section label ─────────────────────────────────────────────────── */}
      <Text
        fontSize="xs"
        fontWeight="700"
        color="violet.600"
        textTransform="uppercase"
        letterSpacing="0.04em"
        mb={3}
      >
        How this fits
      </Text>

      {/* ── Header: dial + unpacked three readings ────────────────────────── */}
      <Flex align="center" gap={4} mb={4} wrap="wrap">
        <KnowledgeNodeDial
          mastery={mastery}
          automaticity={automaticity}
          depth={depth}
          size={64}
          glyphs={audience === "teacher"}
        />

        <Flex gap={4} wrap="wrap" flex={1} minW={0}>
          {(
            [
              {
                key: "mastery",
                color: DOT_COLOR[mastery],
                label: "Mastery",
                value: MASTERY_LABEL[mastery],
                hint: "Has the scholar demonstrated fluency here?",
                hollow: mastery === "placed",
              },
              {
                key: "automaticity",
                color: "#43cf8e",
                label: "Automaticity",
                value: autoText,
                hint: "Spaced-repetition retention — how much remains without practice",
                hollow: false,
              },
              {
                key: "depth",
                color: "#5663c6",
                label: "Depth",
                value: depthText,
                hint: "Bloom conceptual depth observed by the tutor",
                hollow: false,
              },
            ] as const
          ).map(({ key, color, label, value, hint, hollow }) => (
            <Box key={key} title={hint} minW="76px">
              <Flex align="center" gap={1} mb={0.5}>
                <Box
                  w="8px"
                  h="8px"
                  borderRadius="full"
                  bg={hollow ? "#ffffff" : color}
                  css={hollow ? { boxShadow: `inset 0 0 0 1.5px ${color}` } : undefined}
                  flexShrink={0}
                />
                <Text
                  fontSize="2xs"
                  fontWeight="700"
                  textTransform="uppercase"
                  letterSpacing="0.04em"
                  color="charcoal.400"
                >
                  {label}
                </Text>
              </Flex>
              <Text fontSize="sm" fontWeight="600" color="charcoal.700">
                {value}
              </Text>
            </Box>
          ))}
        </Flex>
      </Flex>

      {/* ── Canvas legend ─────────────────────────────────────────────────── */}
      <Flex align="center" gap={3} mb={2} wrap="wrap">
        <Flex align="center" gap={1.5}>
          <Box w="16px" h="0" borderTopWidth="2px" borderColor="#5663c6" />
          <Text fontSize="2xs" color="charcoal.400" lineHeight="1.4">
            prerequisite / unlock
          </Text>
        </Flex>
        {hasSkynodes && (
          <Flex align="center" gap={1.5}>
            <Box
              w="16px"
              h="0"
              borderTopWidth="1px"
              borderStyle="dashed"
              borderColor="#9b8fd0"
            />
            <Text fontSize="2xs" color="charcoal.400" lineHeight="1.4">
              bridge
            </Text>
          </Flex>
        )}
      </Flex>

      {/* ── Neighbourhood canvas ──────────────────────────────────────────── */}
      {isEmpty ? (
        <Box
          borderWidth="1px"
          borderStyle="dashed"
          borderColor="gray.200"
          borderRadius="md"
          p={4}
          textAlign="center"
        >
          <Text fontSize="xs" color="charcoal.400">
            No connected nodes found.
          </Text>
        </Box>
      ) : (
        <svg
          viewBox={`0 0 ${VW} ${viewH}`}
          width="100%"
          height="auto"
          role="img"
          aria-label={ariaLabel}
          data-testid="node-neighbourhood-canvas"
          style={{ display: "block", overflow: "visible" }}
        >
          <defs>
            <marker
              id="nd-tree-arrow"
              viewBox="0 0 9 9"
              markerWidth={6}
              markerHeight={6}
              refX={8}
              refY={4.5}
              orient="auto"
            >
              <path d="M0,0 L0,9 L9,4.5 z" fill="#5663c6" />
            </marker>
          </defs>

          {/* Sky zone separator */}
          {hasSkynodes && (
            <>
              <line
                x1={20}
                y1={VH + 8}
                x2={VW - 20}
                y2={VH + 8}
                stroke="#9b8fd0"
                strokeWidth={0.75}
                strokeDasharray="4 3"
                opacity={0.35}
              />
              <text
                x={VW / 2}
                y={VH + 20}
                textAnchor="middle"
                fontSize={8}
                fontWeight={700}
                fill="#9b8fd0"
                fontFamily="system-ui, sans-serif"
                opacity={0.7}
              >
                bridges
              </text>
            </>
          )}

          {/* "Opens into the world" — short green stub dropping straight down
              from the focal node, no arrowhead (the stories live as cards below). */}
          {stories.length > 0 && (
            <>
              <line
                x1={FX}
                y1={FY + FH / 2 + 2}
                x2={FX}
                y2={FY + FH / 2 + 28}
                stroke={DOT_COLOR.fluent}
                strokeWidth={2}
                strokeLinecap="round"
                opacity={0.85}
              />
              <circle
                cx={FX}
                cy={FY + FH / 2 + 28}
                r={3}
                fill={DOT_COLOR.fluent}
                opacity={0.85}
              />
            </>
          )}

          {/* Dependency edges: prereq → focal */}
          {prereqPos.map((p) => (
            <line
              key={`pe-${p.key}`}
              x1={PREREQ_X + CW / 2 + 2}
              y1={p.y}
              x2={FX - FW / 2 - 6}
              y2={FY}
              stroke="#5663c6"
              strokeWidth={1.5}
              markerEnd="url(#nd-tree-arrow)"
            />
          ))}

          {/* Dependency edges: focal → unlock */}
          {unlockPos.map((p) => (
            <line
              key={`ue-${p.key}`}
              x1={FX + FW / 2 + 2}
              y1={FY}
              x2={UNLOCK_X - CW / 2 - 6}
              y2={p.y}
              stroke="#5663c6"
              strokeWidth={1.5}
              markerEnd="url(#nd-tree-arrow)"
            />
          ))}

          {/* Bridge edges: sky chip ↔ focal (faint dashed, undirected) */}
          {skyPos.map((p) => (
            <line
              key={`se-${p.key}`}
              x1={p.x}
              y1={p.y - CH / 2 - 2}
              x2={FX}
              y2={FY + FH / 2 + 2}
              stroke="#9b8fd0"
              strokeWidth={1}
              strokeDasharray="4 3"
              opacity={0.4}
            />
          ))}

          {/* Prereq chips */}
          {prereqPos.map((p) => {
            if (p.key === "__prereq_overflow__") {
              return (
                <OverflowChipSvg
                  key={p.key}
                  cx={p.x}
                  cy={p.y}
                  label={`+${prereqOverflow} more`}
                  onSelect={() => toggleOverflow("prereq")}
                />
              );
            }
            const nb = nodeByKey.get(p.key);
            const m: MasteryState =
              (neighbourMastery[p.key]?.mastery as MasteryState) ?? "locked";
            return (
              <NodeChipSvg
                key={p.key}
                cx={p.x}
                cy={p.y}
                label={nb?.label ?? p.key}
                mastery={m}
                onSelect={
                  onNavigate && nb
                    ? () => onNavigate(p.key, nb.label)
                    : undefined
                }
              />
            );
          })}

          {/* Focal chip */}
          <FocalChipSvg
            label={node.label}
            domain={node.domain}
            mastery={mastery}
          />

          {/* Unlock chips */}
          {unlockPos.map((p) => {
            if (p.key === "__unlock_overflow__") {
              return (
                <OverflowChipSvg
                  key={p.key}
                  cx={p.x}
                  cy={p.y}
                  label={`+${unlockOverflow} more`}
                  onSelect={() => toggleOverflow("unlock")}
                />
              );
            }
            const nb = nodeByKey.get(p.key);
            const m: MasteryState =
              (neighbourMastery[p.key]?.mastery as MasteryState) ?? "locked";
            return (
              <NodeChipSvg
                key={p.key}
                cx={p.x}
                cy={p.y}
                label={nb?.label ?? p.key}
                mastery={m}
                onSelect={
                  onNavigate && nb
                    ? () => onNavigate(p.key, nb.label)
                    : undefined
                }
              />
            );
          })}

          {/* Bridge chips */}
          {skyPos.map((p) => {
            if (p.key === "__bridge_overflow__") {
              return (
                <OverflowChipSvg
                  key={p.key}
                  cx={p.x}
                  cy={p.y}
                  label={`+${bridgeOverflow} more`}
                  onSelect={() => toggleOverflow("bridge")}
                />
              );
            }
            const nb = nodeByKey.get(p.key);
            const m: MasteryState =
              (neighbourMastery[p.key]?.mastery as MasteryState) ?? "locked";
            return (
              <NodeChipSvg
                key={p.key}
                cx={p.x}
                cy={p.y}
                label={nb?.label ?? p.key}
                mastery={m}
                observed={p.observed}
                onSelect={
                  onNavigate && nb
                    ? () => onNavigate(p.key, nb.label)
                    : undefined
                }
              />
            );
          })}
        </svg>
      )}

      {(expandedOverflow.prereq ||
        expandedOverflow.unlock ||
        expandedOverflow.bridge) && (
        <Flex direction="column" gap={2} mt={2}>
          {expandedOverflow.prereq && prereqRemainder.length > 0 && (
            <Flex
              align="center"
              gap={2}
              wrap="wrap"
              bg="#faf6fc"
              borderRadius="8px"
              px={2.5}
              py={2}
            >
              <Text fontSize="xs" color="charcoal.500">
                also builds on:
              </Text>
              {prereqRemainder.map((key) => {
                const node = nodeByKey.get(key);
                return (
                  <Button
                    key={`prereq-rem-${key}`}
                    size="xs"
                    variant="outline"
                    borderRadius="full"
                    colorPalette="violet"
                    onClick={() => node && onNavigate?.(key, node.label)}
                    disabled={!node || !onNavigate}
                  >
                    {node?.label ?? key}
                  </Button>
                );
              })}
            </Flex>
          )}
          {expandedOverflow.unlock && unlockRemainder.length > 0 && (
            <Flex
              align="center"
              gap={2}
              wrap="wrap"
              bg="#faf6fc"
              borderRadius="8px"
              px={2.5}
              py={2}
            >
              <Text fontSize="xs" color="charcoal.500">
                also unlocks:
              </Text>
              {unlockRemainder.map((key) => {
                const node = nodeByKey.get(key);
                return (
                  <Button
                    key={`unlock-rem-${key}`}
                    size="xs"
                    variant="outline"
                    borderRadius="full"
                    colorPalette="violet"
                    onClick={() => node && onNavigate?.(key, node.label)}
                    disabled={!node || !onNavigate}
                  >
                    {node?.label ?? key}
                  </Button>
                );
              })}
            </Flex>
          )}
          {expandedOverflow.bridge && bridgeRemainder.length > 0 && (
            <Flex
              align="center"
              gap={2}
              wrap="wrap"
              bg="#faf6fc"
              borderRadius="8px"
              px={2.5}
              py={2}
            >
              <Text fontSize="xs" color="charcoal.500">
                more bridges:
              </Text>
              {bridgeRemainder.map((key) => {
                const node = nodeByKey.get(key);
                return (
                  <Button
                    key={`bridge-rem-${key}`}
                    size="xs"
                    variant="outline"
                    borderRadius="full"
                    colorPalette="violet"
                    onClick={() => node && onNavigate?.(key, node.label)}
                    disabled={!node || !onNavigate}
                  >
                    {node?.label ?? key}
                  </Button>
                );
              })}
            </Flex>
          )}
        </Flex>
      )}

      {/* ── Green story family — outgoing + incoming story bridges ────────── */}
      <NodeStoryFamily
        focalKey={node.nodeKey}
        stories={stories}
        canEdit={canEditStories}
        onNavigate={onNavigate}
      />

      {/* ── Teacher-only: the practice ITEM POOL behind this node ──────────
          The same panel the /teacher/math-skills studio uses — view the
          template samples, edit/author/delete stored items, run the verified
          generator. Collapsed by default (lazy query). */}
      {audience === "teacher" && nodeKey && (
        <Box mt={4} borderWidth="1px" borderColor="gray.200" borderRadius="10px" p={3}>
          <Flex align="center" justify="space-between" gap={2}>
            <Button
              size="sm"
              variant="ghost"
              colorPalette="violet"
              onClick={() => setPoolOpen((v) => !v)}
              data-testid="node-drawer-item-pool-toggle"
              fontFamily="heading"
            >
              {poolOpen ? <CaretDown weight="bold" /> : <CaretRight weight="bold" />}
              <Text as="span" fontWeight="700" textTransform="uppercase" letterSpacing="0.04em" fontSize="sm">
                Practice item pool
              </Text>
            </Button>
            <NextLink href={`/teacher/math-skills?node=${encodeURIComponent(nodeKey)}`} prefetch={false}>
              <Text fontFamily="heading" fontSize="sm" color="violet.600" fontWeight="600" _hover={{ textDecoration: "underline" }}>
                Open in Skills Practice →
              </Text>
            </NextLink>
          </Flex>
          {poolOpen && (
            <Box mt={3}>
              <NodeItemPool nodeKey={nodeKey} />
            </Box>
          )}
        </Box>
      )}

      {/* ── Footer actions ────────────────────────────────────────────────── */}
      <Flex gap={2} mt={3} wrap="wrap" align="center">
        {node.practiceServeable && onPractice && (
          <Button
            size="sm"
            colorPalette="green"
            variant="solid"
            onClick={() => onPractice(node.nodeKey)}
            minH="44px"
            data-testid="node-drawer-practice"
            title={`Start a practice set for "${node.label}"`}
          >
            <Play weight="fill" />
            Practice ▸
          </Button>
        )}

        {scholarId && nodeReference && (
          <Button
            size="sm"
            colorPalette="teal"
            variant="outline"
            onClick={() => setReferenceOpen(true)}
            minH="44px"
            data-testid="node-drawer-reference"
            title={`See the move for "${node.label}"`}
          >
            <Compass weight="fill" />
            See the move
          </Button>
        )}

        {onPivotToSky && (
          <Button
            size="sm"
            colorPalette="violet"
            variant="subtle"
            onClick={() =>
              onPivotToSky(
                node.label,
                node.standardCodes?.[0]?.code,
              )
            }
            minH="44px"
            data-testid="node-drawer-open-map"
            title="Open the associative star map anchored on this concept"
          >
            <MapTrifold weight="duotone" />
            Open map
          </Button>
        )}

        {node.rationale && (
          <Text
            fontSize="xs"
            color="charcoal.400"
            flex={1}
            minW="160px"
            lineHeight="1.4"
          >
            {node.rationale}
          </Text>
        )}
      </Flex>

      {/* On-demand REFERENCE overlay (§4.3) — the same read-only Launchpad
          renderer the practice "See an example" shelf uses, contemplative
          only (never a CTA that starts practice; Practice ▸ above is that).
          `logRetrieval` is gated to the scholar's OWN open — a teacher/parent
          sees the identical content, but their open writes nothing. */}
      {scholarId && (
        <InstructionExampleSheet
          open={referenceOpen && !!nodeReference}
          onClose={() => setReferenceOpen(false)}
          scholarId={scholarId as Id<"users">}
          skillKey={nodeKey ?? ""}
          content={nodeReference ?? null}
          source="idea_shelf"
          logRetrieval={isSelfScholarRef}
        />
      )}
    </Box>
  );
}
