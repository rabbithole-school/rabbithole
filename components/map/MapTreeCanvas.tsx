"use client";

/**
 * MapTreeCanvas — the tech-tree SKIN of the Map (roadmap §4).
 *
 * The pure presentation layer: given already-laid-out, already-REDACTED node
 * view-models + prerequisite edges, it renders the "cone" tech-tree on the
 * shared `createMapCamera` core:
 *   • X = DAG depth (left→right); the frontier glows.
 *   • white "paper" plane; each node is a <KnowledgeNodeDial/> (used as-is).
 *   • arrowed prerequisite edges drawn in a SCREEN-SPACE SVG overlay that
 *     parallax-tracks the tilted plane every frame (via camera.project) — the
 *     exact trick atlasEngine uses for the Sky's bridges.
 *   • a deliberate Tilt/Flatten toggle (never a two-finger spin) + Fit.
 *
 * a11y (roadmap §4): the visual plane is aria-hidden; a visually-hidden list of
 * <button>s (one per node) carries the semantics for AT + keyboard. Selection is
 * camera-tap hit-testing (mirrors the engine's screen-space picking), so there's
 * no drag-vs-click ambiguity and node DOM stays pointer-transparent.
 *
 * It knows NOTHING about audiences — every redaction decision (dial arcs zeroed,
 * flags present/absent) is already baked into the view-models by MapTreeView.
 */

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Box, Button, HStack, Text } from "@chakra-ui/react";
import { Crosshair } from "@phosphor-icons/react";
import { KnowledgeNodeDial, DOT_COLOR } from "@/components/KnowledgeNodeDial";
import { MisconceptionFlag } from "@/components/MisconceptionFlag";
import { createMapCamera, type MapCamera, type ContentBox } from "@/lib/mapCamera";
import { laneYPcts, railStrandsFit, STRAND_RAIL_ROW_CHROME_PX, STRAND_RAIL_ROW_TEXT_PX, smoothPath, type FrontierLine, type GradeRulerTick, type TreeEdgeVM, type TreeNodeVM } from "@/shared/treeMapLayout";
import { MASTERY_LABELS, STRUGGLING_LABEL } from "@/shared/masteryLexicon";
import { strandHeadline, strandHeadlineFor } from "@/shared/practiceDomainLabels";
import { MAP_LABEL } from "@/lib/mapLabelStyle";
import { domainFogLabel, type DomainFogState } from "@/shared/domainFog";
import { scopeAllowsStrand, type PracticeScope } from "@/shared/mathPlanScope";

export type { TreeEdgeVM, TreeNodeVM } from "@/shared/treeMapLayout";

/** Internal: a drawable edge (both endpoints present) with its cross-strand flag
 *  precomputed, so the per-frame loop can decide visibility without a strand
 *  lookup. */
type DrawEdge = TreeEdgeVM & { crossStrand: boolean };

export type MapTreeCanvasProps = {
  nodes: TreeNodeVM[];
  edges: TreeEdgeVM[];
  /** Frontier boundary lines (current + moved-since ghosts) drawn over the map. */
  frontierLines?: FrontierLine[];
  /** The top grade ruler (K · 1 · 2 · … ) — one muted tick per grade band present. */
  gradeRuler?: GradeRulerTick[];
  height?: number | string;
  /** Full-bleed: fill the parent (h="100%", no card border/radius) instead of a fixed px card. */
  fill?: boolean;
  selectedKey?: string | null;
  onSelect: (nodeKey: string | null) => void;
  /** teacher: render MisconceptionFlag on flagged nodes. */
  showFlags?: boolean;
  dialSize?: number;
  /**
   * Multiply the FIXED on-screen font size of the tree's text labels (concept
   * labels, domain-row rail, frontier chips). Default 1 = the web tree's normal
   * size; the native iPad embed passes >1 for legibility. Collision de-confliction
   * stays correct because the layout reads each label's ACTUAL rendered
   * offsetWidth/offsetHeight (see onFrame), which grows with the font size.
   */
  labelScale?: number;
  /**
   * Full-screen surfaces (e.g. /scholar/map) fit the WHOLE tree to the viewport
   * and re-fit as a full-bleed flex pane settles / the container resizes. Fixed-
   * height cards leave this off to keep the historical frontier-focused framing
   * and preserve the user's pan/zoom on resize (the camera re-measures either way).
   */
  fitToViewport?: boolean;
  /**
   * Fog-of-war (finish-the-check-in surfaces, PR2, Surface 3): per-domain map
   * status, keyed by domain slug (matches `n.domain`). A domain that is
   * grade-eligible but not yet mapped renders its band HAZY with a fog label;
   * a converged or ineligible domain (absent here, or `null`) renders exactly
   * as it does today — no new per-node vocabulary, ONE added band-level state.
   * Omit entirely for callers with no placement concept (e.g. teacher/parent
   * views that already skip the query).
   */
  domainFog?: Record<string, DomainFogState>;
  /** Scholar plan scope: retained mastery stays readable; unavailable territory
   * is recessed and slashed without inventing another checkpoint marker. */
  practiceScope?: PracticeScope;
};

// The frontier line's visual weight per snapshot — the current boundary is the
// boldest; older ghosts fade back so you read the movement. All solid; distinct
// by opacity + width, not dashes.
const FRONTIER_STYLE: Record<FrontierLine["key"], { opacity: number; width: number }> = {
  current: { opacity: 0.95, width: 3 },
  yesterday: { opacity: 0.5, width: 2 },
  weekAgo: { opacity: 0.3, width: 1.75 },
};
const FRONTIER_GOLD = "#d99a00";

// The "lit up" hover colour — a hovered/selected node's edges and its neighbours'
// labels all use this ONE blue (upstream vs downstream is read from the arrow's
// left/right direction, not colour — green was overloaded with mastery).
const EDGE_LIT = "#5663c6";
// The at-rest edge colour (faint grey prereq/unlock lines). Single source of
// truth so the arrowhead fill can never drift from its line's stroke.
const EDGE_REST = "#c7cdc2";
// Node-label colours: a muted default, and a near-black reserved for the label of
// the node currently being hovered (so the focus pops).
const LABEL_HOVER = "#121a26"; // gray.900

// Node dials never render larger than this on screen; zooming past it spreads
// spacing + reveals labels instead of growing the dials (a semantic zoom).
const NODE_CAP_PX = 24;

// …and a strand row never renders taller than this: past the matching zoom the
// vertical spacing freezes (the vertical analogue of NODE_CAP_PX). For the
// scholar map (~6 lanes) both caps top out at nearly the same zoom (~0.7×).
const ROW_CAP_PX = 110;

// Node labels stay frontier-only until the camera is zoomed this many × past the
// fitted baseline (deeper than the LOD bucket used to trip at, ~1.9×).
const LABEL_REVEAL_RATIO = 2.5;

// Faint at-rest arrowhead markers are the priciest SVG primitive here (and
// costliest in the native WKWebView embed). They read as noise when zoomed out,
// so drop them until the camera is zoomed in this many × past the fitted
// baseline. Lit hover/select edges keep their arrowheads at any zoom (the
// direction cue matters and there are only a few).
const ARROW_REVEAL_RATIO = 1.5;

// ── camera bounding boxes (0..100 plane coords), padded so a fit isn't edge-to-edge.
function boxOf(list: TreeNodeVM[], padX = 4, padY = 6): ContentBox | null {
  if (list.length === 0) return null;
  let minX = 100, minY = 100, maxX = 0, maxY = 0;
  for (const n of list) {
    minX = Math.min(minX, n.xPct); maxX = Math.max(maxX, n.xPct);
    minY = Math.min(minY, n.yPct); maxY = Math.max(maxY, n.yPct);
  }
  return { minX: minX - padX, minY: minY - padY, maxX: maxX + padX, maxY: maxY + padY };
}
function allBox(nodes: TreeNodeVM[]): ContentBox {
  return boxOf(nodes) ?? { minX: 0, minY: 0, maxX: 100, maxY: 100 };
}
function frontierBox(nodes: TreeNodeVM[]): ContentBox | null {
  // Pad generously so neighbouring lanes stay in view for context (Y) and the
  // fluent run leading into the frontier + a little locked-ahead show (X).
  return boxOf(nodes.filter((n) => n.frontier), 14, 24);
}

export function MapTreeCanvas({
  nodes,
  edges,
  frontierLines = [],
  gradeRuler = [],
  height = 560,
  fill = false,
  selectedKey = null,
  onSelect,
  showFlags = false,
  dialSize = 48,
  labelScale = 1,
  fitToViewport = false,
  domainFog,
  practiceScope,
}: MapTreeCanvasProps) {
  const vpRef = useRef<HTMLDivElement>(null);
  const sceneRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const cameraRef = useRef<MapCamera | null>(null);

  // Whether any node on this map is "struggling" (red). Naturally audience-safe:
  // the scholar's own VMs never carry it (server + buildTreeVMs redact missStreak),
  // so the red legend swatch only ever appears on a teacher/parent map — right
  // where the red dots do.
  const hasStruggling = useMemo(
    () => nodes.some((n) => n.mastery === "struggling"),
    [nodes],
  );

  // Latest projector + node list for tap hit-testing / per-frame edge tracking.
  const projectRef = useRef<((x: number, y: number, z: number) => { sx: number; sy: number }) | null>(null);
  const nodesRef = useRef<TreeNodeVM[]>(nodes);
  const zoomRef = useRef(1);
  const lineRefs = useRef<Map<string, SVGPathElement>>(new Map());
  const frontierPolyRefs = useRef<Map<string, SVGPathElement>>(new Map());
  const frontierLabelRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const frontierLinesRef = useRef<FrontierLine[]>(frontierLines);
  const gradeTickRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const gradeRulerRef = useRef<GradeRulerTick[]>(gradeRuler);
  const onSelectRef = useRef(onSelect);
  const drawEdgesRef = useRef<DrawEdge[]>([]);
  const nodeByKeyRef = useRef<Map<string, TreeNodeVM>>(new Map());

  useEffect(() => { onSelectRef.current = onSelect; }, [onSelect]);
  useEffect(() => {
    nodesRef.current = nodes;
    // New node set → re-establish the no-fade baseline for its first frames.
    labelAnimReadyRef.current = false;
    labelAnimFramesRef.current = 0;
    if (nodeLabelOverlayRef.current) nodeLabelOverlayRef.current.dataset.anim = "off";
  }, [nodes]);
  useEffect(() => { frontierLinesRef.current = frontierLines; }, [frontierLines]);
  useEffect(() => { gradeRulerRef.current = gradeRuler; }, [gradeRuler]);

  const [hoveredKey, setHoveredKey] = useState<string | null>(null);
  const [showRecenter, setShowRecenter] = useState(false);
  const showRecenterRef = useRef(false);
  // Whether the faint at-rest arrowheads render — off when zoomed out (see
  // ARROW_REVEAL_RATIO). A ref mirrors it so onFrame only calls setState at a
  // threshold crossing, never every frame.
  const [showArrows, setShowArrows] = useState(true);
  const showArrowsRef = useRef(true);
  const hoveredRef = useRef<string | null>(null);
  const selectedKeyRef = useRef(selectedKey);
  useEffect(() => { selectedKeyRef.current = selectedKey; }, [selectedKey]);

  // Touch has NO hover, so the currently open/selected node must be what drives
  // the prereq/unlock arrows (and label constellation) there. Hover is now a
  // MOUSE-ONLY affordance, enforced at the event source: the camera only relays
  // pointer moves to `onHover` when `pointerType === "mouse"` (see
  // `lib/mapCamera.ts`), and clears any stale hover on a non-mouse press. So on
  // a touch device `hoveredKey` stays null and the arrows follow `selectedKey`,
  // while desktop mouse hover is unchanged.

  // ── Screen-space node-label overlay ── constant pixel size (never scaled by
  // the camera), positioned BELOW each node in onFrame, hidden on collision.
  // Priority: hovered > lit connected neighbour > leading-frontier > rest.
  const nodeLabelRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const nodeLabelOverlayRef = useRef<HTMLDivElement>(null);
  // Cached rendered label metrics (offsetWidth/offsetHeight). Labels are drawn at
  // a CONSTANT on-screen size — their box only changes when the node set or
  // `labelScale` changes, never per frame — so we measure them once per such
  // change (batched, in a layout effect) instead of reading layout properties in
  // the rAF loop. Reading offsetWidth/offsetHeight interleaved with the loop's
  // transform writes forces O(nodes) synchronous reflows PER FRAME (layout
  // thrash); the cache removes that from the critical path.
  const nodeLabelSizeRef = useRef<Map<string, { w: number; h: number }>>(new Map());
  const frontierLabelSizeRef = useRef<Map<string, number>>(new Map());
  const neighboursRef = useRef<Map<string, Set<string>>>(new Map());
  // Fade gate: labels present on FIRST open (or after a node-set change) appear
  // instantly; the 200ms opacity transition is enabled only from the 2nd frame.
  const labelAnimReadyRef = useRef(false);
  const labelAnimFramesRef = useRef(0);

  // ── the left rail: TWO levels of hierarchy pinned to the left edge and
  //    vertically camera-tracked, using the SAME domain-gapped lane→yPct map as
  //    buildTreeVMs so positions are exact:
  //      • every lane → a Title-Case STRAND label centred on that lane's row
  //        (horizontally aligned with its row of node dots), indented so the
  //        strands read as nested under their domain;
  //      • unified (multiple domains) → an ALL-CAPS DOMAIN header sitting in the
  //        gap above each band's first strand (typography-led grouping — the
  //        tree analogue of the sky's per-domain regions).
  //    Lanes are keyed by lane INDEX (unique) — never by display strand, which
  //    collides across domains ("concept"/"operations" exist in several). ──
  const { railItems, laneCount } = useMemo(() => {
    const laneMeta = new Map<number, { strand: string; domain: string | null; domainLabel: string }>();
    for (const n of nodes) {
      if (!laneMeta.has(n.lane))
        laneMeta.set(n.lane, {
          strand: n.strand ?? "general",
          domain: n.domain,
          domainLabel: n.domainLabel ?? n.domain ?? "",
        });
    }
    const lanes = [...laneMeta.keys()].sort((a, b) => a - b);
    const lc = Math.max(1, lanes.length);
    // Same domain-gapped mapping as the nodes + frontier line (indexed by lane).
    const yByLane = laneYPcts(lanes.map((lane) => laneMeta.get(lane)!.domain));

    const domains = new Set<string>();
    for (const m of laneMeta.values()) if (m.domain) domains.add(m.domain);
    const multi = domains.size > 1;

    // First (top / min) lane of each domain band — where that band's header sits.
    const topLaneByDomain = new Map<string, number>();
    for (const lane of lanes) {
      const d = laneMeta.get(lane)!.domain;
      if (d && !topLaneByDomain.has(d)) topLaneByDomain.set(d, lane);
    }

    // One item per LANE (its strand row); on the unified map the band's top
    // lane also carries the domain header (floated into the gap above it).
    const items = lanes.map((lane, i) => {
      const meta = laneMeta.get(lane)!;
      const isBandTop = meta.domain != null && topLaneByDomain.get(meta.domain) === lane;
      const fog = meta.domain ? domainFog?.[meta.domain] ?? null : null;
      return {
        key: `${lane}`,
        label: meta.domain
          ? strandHeadlineFor(meta.domain, meta.strand)
          : strandHeadline(meta.strand),
        yPct: yByLane[i] ?? 50,
        domainHeader: multi && isBandTop ? (meta.domainLabel || meta.domain || "") : undefined,
        // Fog label only paints once per band (its top lane), matching where
        // the domain header itself sits — including on a single-domain map
        // (no `multi` gate here; a lone fogged domain still needs to say so).
        fogLabel: isBandTop ? domainFogLabel(fog) : null,
      };
    });
    return { railItems: items, laneCount: lc, multiDomain: multi };
  }, [nodes, domainFog]);
  const railItemsRef = useRef(railItems);
  useEffect(() => { railItemsRef.current = railItems; }, [railItems]);

  // Largest yPct gap between adjacent LANES — fed to the camera's row-height cap
  // so no lane row renders taller than ROW_CAP_PX regardless of zoom.
  const laneSpanYPct = useMemo(() => {
    if (laneCount <= 1) return 0;
    return 84 / (laneCount - 1);
  }, [laneCount]);
  // Map of rail-item key → label DOM element (updated by callback refs in JSX).
  const laneLabelRefs = useRef<Map<string, HTMLElement>>(new Map());
  // Map of rail-item key → domain-header DOM element, for the SAME rows that
  // carry a `domainHeader` — positioned adaptively in onFrame (see below),
  // never by a fixed CSS offset.
  const domainHeaderRefs = useRef<Map<string, HTMLElement>>(new Map());
  // Map of rail-item key → STRAND pill element. The strand tier is dropped
  // wholesale once the rows render closer together than a pill is tall (see
  // STRAND_ROW_MIN_PX in onFrame) — zoomed out they otherwise stack into an
  // unreadable smear and the DOMAIN headers are the only rail label that can
  // still be read (Andy, 2026-08-19, from the iPad twin of this rail).
  const strandLabelRefs = useRef<Map<string, HTMLElement>>(new Map());
  // Rail container ref — used to reveal the rail after first frame positioning.
  const railRef = useRef<HTMLDivElement>(null);

  // Only keep drawable edges (both endpoints present); precompute each edge's
  // cross-strand flag (drives at-rest visibility) so the per-frame loop and the
  // JSX both read it without a strand lookup.
  const nodeByKey = new Map(nodes.map((n) => [n.nodeKey, n]));
  const drawEdges: DrawEdge[] = [];
  for (const e of edges) {
    const from = nodeByKey.get(e.fromKey);
    const to = nodeByKey.get(e.toKey);
    if (!from || !to) continue;
    drawEdges.push({ fromKey: e.fromKey, toKey: e.toKey, crossStrand: from.strand !== to.strand });
  }
  useEffect(() => { drawEdgesRef.current = drawEdges; nodeByKeyRef.current = nodeByKey; });

  // Undirected adjacency for the hover "constellation" — the SAME edges the
  // highlight lights up (both same- and cross-strand). A hovered/selected node
  // promotes its neighbours' labels (priority tier 1) and lights them blue.
  const neighboursByKey = useMemo(() => {
    const keys = new Set(nodes.map((n) => n.nodeKey));
    const neigh = new Map<string, Set<string>>();
    const add = (k: string, v: string) => {
      let s = neigh.get(k); if (!s) { s = new Set(); neigh.set(k, s); } s.add(v);
    };
    for (const e of edges) {
      if (!keys.has(e.fromKey) || !keys.has(e.toKey)) continue;
      add(e.fromKey, e.toKey); add(e.toKey, e.fromKey);
    }
    return neigh;
  }, [edges, nodes]);
  useEffect(() => { neighboursRef.current = neighboursByKey; }, [neighboursByKey]);

  // ── Measure label boxes ONCE per node-set / labelScale change (not per frame).
  //    A layout effect runs after DOM commit, before paint, so the cache is fresh
  //    for the next rAF frame. All reads are batched together (no interleaved
  //    writes) → a single reflow, replacing the O(nodes) forced reflows the rAF
  //    loop used to trigger by reading offsetWidth/offsetHeight inline.
  useLayoutEffect(() => {
    const sizes = nodeLabelSizeRef.current;
    sizes.clear();
    for (const n of nodes) {
      const el = nodeLabelRefs.current.get(n.nodeKey);
      if (el) sizes.set(n.nodeKey, { w: el.offsetWidth, h: el.offsetHeight });
    }
  }, [nodes, labelScale]);
  useLayoutEffect(() => {
    const sizes = frontierLabelSizeRef.current;
    sizes.clear();
    for (const line of frontierLines) {
      const el = frontierLabelRefs.current.get(line.key);
      if (el) sizes.set(line.key, el.offsetWidth);
    }
  }, [frontierLines, labelScale]);

  // ── tap hit-testing (screen-space, mirrors the engine's picking) ──
  const handleTap = useCallback((lx: number, ly: number) => {
    const project = projectRef.current;
    if (!project) return;
    const hitR = Math.max(24, (dialSize / 2) * zoomRef.current + 6);
    let best: string | null = null;
    let bestD = hitR * hitR;
    for (const n of nodesRef.current) {
      const { sx, sy } = project(n.xPct, n.yPct, n.z);
      const dx = sx - lx, dy = sy - ly, d2 = dx * dx + dy * dy;
      if (d2 <= bestD) { bestD = d2; best = n.nodeKey; }
    }
    onSelectRef.current(best); // null on a background tap = deselect
  }, [dialSize]);

  // ── hover hit-testing → cursor + label reveal (the node plane is
  //    pointer-transparent, so the camera relays idle pointer moves here) ──
  const handleHover = useCallback((lx: number, ly: number) => {
    const project = projectRef.current;
    if (!project) return;
    // Hover is mouse-only: the camera never relays touch/pen moves here (see
    // `lib/mapCamera.ts`), so this only ever runs for a genuine mouse pointer.
    const hitR = Math.max(24, (dialSize / 2) * zoomRef.current + 6);
    let best: string | null = null;
    let bestD = hitR * hitR;
    for (const n of nodesRef.current) {
      const { sx, sy } = project(n.xPct, n.yPct, n.z);
      const dx = sx - lx, dy = sy - ly, d2 = dx * dx + dy * dy;
      if (d2 <= bestD) { bestD = d2; best = n.nodeKey; }
    }
    const vp = vpRef.current;
    if (vp) vp.style.cursor = best ? "pointer" : "grab";
    if (best !== hoveredRef.current) { hoveredRef.current = best; setHoveredKey(best); }
  }, [dialSize]);
  const handleHoverLeave = useCallback(() => {
    const vp = vpRef.current;
    if (vp) vp.style.cursor = "grab";
    if (hoveredRef.current !== null) { hoveredRef.current = null; setHoveredKey(null); }
  }, []);

  // ── instantiate the camera once ──
  useEffect(() => {
    const vp = vpRef.current, scene = sceneRef.current;
    if (!vp || !scene) return;
    const cam = createMapCamera(vp, {
      skin: "tree",
      scene,
      maxZoomFactor: 9, // allow ~2x deeper zoom (neighbours ~200px apart, not ~100px)
      onTap: handleTap,
      onHover: handleHover,
      onHoverLeave: handleHoverLeave,
      onFrame: (project, info) => {
        projectRef.current = project;
        zoomRef.current = info.zoom;
        // Cap the on-screen node size: the scene scales dials by `zoom`, so a
        // counter-scale of CAP/(dialSize*zoom) pins each dial at ≤ NODE_CAP_PX.
        // Past the cap, zooming spreads the SPACING (positions still scale) — and
        // the labels open up (bucket ≥ 2). One CSS var → every dial reacts.
        const nodeScale = Math.min(1, NODE_CAP_PX / (dialSize * info.zoom));
        scene.style.setProperty("--rh-node-scale", nodeScale.toFixed(3));
        // The scene is squished vertically by the row-height cap (info.vScaleY);
        // counter-scale each node's glyph by 1/vScaleY so the dials stay round.
        scene.style.setProperty("--rh-vsy-inv", (1 / (info.vScaleY || 1)).toFixed(4));
        // Viewport size — used by the edge / label / recenter culls below.
        const vpW = vpRef.current?.clientWidth ?? 1000;
        const vpH = vpRef.current?.clientHeight ?? 800;
        // Arrowhead LOD: drop the faint at-rest arrowheads when zoomed out
        // (ref-guarded so we only re-render on a threshold crossing, not/frame).
        const wantArrows = info.zoom / info.baseZoom >= ARROW_REVEAL_RATIO;
        if (wantArrows !== showArrowsRef.current) {
          showArrowsRef.current = wantArrows;
          setShowArrows(wantArrows);
        }
        // parallax-track the screen-space edge overlay. Two culls keep this off
        // the critical path as the tree grows: (1) skip edges that aren't drawn
        // right now — same-strand edges are opacity:0 at rest, so only
        // cross-strand edges or the hovered/selected node's own edges need
        // tracking; (2) skip edges whose whole segment is off-screen. A culled
        // edge just keeps its last `d` (invisible or off-screen either way) and
        // re-tracks the next frame it matters.
        const lines = lineRefs.current;
        const activeEdgeKey = hoveredRef.current ?? selectedKeyRef.current;
        const EDGE_MARGIN = 80;
        for (const e of drawEdgesRef.current) {
          const touches =
            activeEdgeKey != null && (e.fromKey === activeEdgeKey || e.toKey === activeEdgeKey);
          if (!touches && !e.crossStrand) continue; // invisible at rest → skip
          const path = lines.get(`${e.fromKey}__${e.toKey}`);
          if (!path) continue;
          const a = nodeByKeyRef.current.get(e.fromKey);
          const b = nodeByKeyRef.current.get(e.toKey);
          if (!a || !b) continue;
          const pa = project(a.xPct, a.yPct, a.z);
          const pb = project(b.xPct, b.yPct, b.z);
          // off-screen segment (both ends past the same edge) → skip arc + write
          if (
            (pa.sx < -EDGE_MARGIN && pb.sx < -EDGE_MARGIN) ||
            (pa.sx > vpW + EDGE_MARGIN && pb.sx > vpW + EDGE_MARGIN) ||
            (pa.sy < -EDGE_MARGIN && pb.sy < -EDGE_MARGIN) ||
            (pa.sy > vpH + EDGE_MARGIN && pb.sy > vpH + EDGE_MARGIN)
          ) continue;
          // stop the arrow short of the target dial so the head stays visible
          const vx = pb.sx - pa.sx, vy = pb.sy - pa.sy;
          const len = Math.hypot(vx, vy) || 1;
          // gap both ends by one on-screen dial radius so the arc sits symmetrically
          // just OUTSIDE both dials (was: flush at the source, gapped at the target).
          const rDot = Math.min(dialSize * zoomRef.current, NODE_CAP_PX) / 2;
          const back = Math.min(len * 0.5, rDot + 4);
          const sameStrand = a.strand != null && a.strand === b.strand;
          if (sameStrand) {
            // Airline-style arc: control = raised midpoint of the two DOT CENTRES,
            // so the end tangent aims at the target centre (not the chord).
            const mx = (pa.sx + pb.sx) / 2, my = (pa.sy + pb.sy) / 2;
            let nx = -vy / len, ny = vx / len;
            if (ny > 0) { nx = -nx; ny = -ny; } // bow up (screen −y)
            const arcH = Math.min(110, Math.max(20, len * 0.375));
            const cx = mx + nx * arcH, cy = my + ny * arcH;
            // Pull both ends back along their own tangents — start: centre→control,
            // end: control→centre — for a symmetric gap + a head aimed at centre.
            const s0x = cx - pa.sx, s0y = cy - pa.sy;
            const s0l = Math.hypot(s0x, s0y) || 1;
            const sx = pa.sx + (s0x / s0l) * back, sy = pa.sy + (s0y / s0l) * back;
            const tx = pb.sx - cx, ty = pb.sy - cy;
            const tl = Math.hypot(tx, ty) || 1;
            const ex = pb.sx - (tx / tl) * back, ey = pb.sy - (ty / tl) * back;
            path.setAttribute("d", `M${sx.toFixed(1)},${sy.toFixed(1)} Q${cx.toFixed(1)},${cy.toFixed(1)} ${ex.toFixed(1)},${ey.toFixed(1)}`);
          } else {
            const ux = vx / len, uy = vy / len;
            const sx = pa.sx + ux * back, sy = pa.sy + uy * back;
            const ex = pb.sx - ux * back, ey = pb.sy - uy * back;
            path.setAttribute("d", `M${sx.toFixed(1)},${sy.toFixed(1)} L${ex.toFixed(1)},${ey.toFixed(1)}`);
          }
        }
        // Lane label rail: track the vertical camera component only.
        // project(50, yPct, 0) — xPct=50 means cx0=0, so ry has no effect on
        // sy, and z=0 means rx's z→y crosstalk is also zero. The result is the
        // pure vertical transform of each lane's center row.
        //
        // Domain headers ALSO get their own adaptive Y here (not a fixed CSS
        // offset above their row): each floats at the MIDPOINT between its own
        // band-top row and the previous domain's last row (whatever that gap
        // actually renders as, at the current zoom) — so on a unified map with
        // many strands per domain the header can never land on top of the
        // previous domain's last strand label regardless of lane density
        // (FTUE M6). The very first domain (nothing above it) keeps a small
        // fixed clearance instead, since there's no collision to avoid.
        const rail = railRef.current;
        const labels = laneLabelRefs.current;
        const headerEls = domainHeaderRefs.current;
        const strandEls = strandLabelRefs.current;
        const FIRST_HEADER_OFFSET = 24 * labelScale;
        // Once the rows crowd closer than a strand pill is tall, the whole
        // strand TIER is hidden rather than allowed to overlap, leaving the
        // domain headers to carry the rail — and each header then drops onto
        // its own band's top row, since the gap it normally floats in no
        // longer holds anything. Only the pill's TEXT follows labelScale; its
        // padding and borders are fixed px, so scaling the whole allowance
        // would keep the tier hidden over rows that do have room for it.
        const railSys = railItemsRef.current.map(({ yPct }) => project(50, yPct, 0).sy);
        const showStrands = railStrandsFit(
          railSys,
          STRAND_RAIL_ROW_TEXT_PX * labelScale + STRAND_RAIL_ROW_CHROME_PX,
        );
        let prevSy: number | null = null;
        railItemsRef.current.forEach(({ key, domainHeader, fogLabel }, i) => {
          const sy = railSys[i];
          const el = labels.get(key);
          if (el) el.style.transform = `translateY(${sy.toFixed(1)}px) translateY(-50%)`;
          const strandEl = strandEls.get(key);
          if (strandEl) strandEl.style.display = showStrands ? "" : "none";
          if (domainHeader || fogLabel) {
            const headerEl = headerEls.get(key);
            if (headerEl) {
              // headerY is the header's DESIRED absolute screen Y (midpoint
              // between the two rows, or a fixed clearance above the very
              // first domain's row). The header element is nested inside THIS
              // row's wrapping div (already translated to `sy`), so its own
              // transform must be expressed relative to that — i.e. the
              // offset FROM sy, not the absolute target itself.
              const headerY = !showStrands
                ? sy
                : prevSy != null
                  ? (prevSy + sy) / 2
                  : sy - FIRST_HEADER_OFFSET;
              headerEl.style.transform = `translateY(${(headerY - sy).toFixed(1)}px) translateY(-50%)`;
            }
          }
          prevSy = sy;
        });
        // Frontier lines: full-bleed vertical guides that track the camera's X
        // (like the strand labels track Y + stay pinned left). Each snapshot's
        // per-lane boundary points are projected; the ends run OFF-SCREEN top +
        // bottom so the line reads as a full division. Labels are pinned to the
        // TOP of the window, x-tracking their line, anchored left/right (best
        // effort) so nearby tags don't overlap.
        const BLEED = 60;
        const labelTargets: { label: HTMLDivElement; topX: number; w: number }[] = [];
        for (const line of frontierLinesRef.current) {
          if (line.points.length === 0) continue;
          const pts = line.points.map((p) => project(p.xPct, p.yPct, 0));
          const poly = frontierPolyRefs.current.get(line.key);
          if (poly) {
            const top = { sx: pts[0].sx, sy: -BLEED };
            const bottom = { sx: pts[pts.length - 1].sx, sy: vpH + BLEED };
            poly.setAttribute("d", smoothPath([top, ...pts, bottom]));
          }
          const label = frontierLabelRefs.current.get(line.key);
          if (label) labelTargets.push({ label, topX: pts[0].sx, w: frontierLabelSizeRef.current.get(line.key) || 80 });
        }
        // Order-preserving placement: sweep left→right in line order and place
        // each tag just right of its line, pushing it further right only if it
        // would overlap the previous tag. Never reorders (a later/further-right
        // line's tag is ALWAYS right of an earlier one's) — correctness of the
        // ordering is non-negotiable; overlap crowding is the acceptable trade.
        labelTargets.sort((a, b) => a.topX - b.topX);
        let cursor = -Infinity;
        for (const t of labelTargets) {
          const left = Math.max(t.topX + 5, cursor + 6);
          // Sits BELOW the grade ruler row (see below) so the two never collide.
          t.label.style.transform = `translate(${left.toFixed(1)}px, 28px)`;
          t.label.style.visibility = "";
          cursor = left + t.w;
        }
        // Grade ruler: a quiet top-of-map strip (K · 1 · 2 · … ) — each tick
        // x-tracks its grade band's leading column, same trick as the rail's
        // pure-Y projection (project at a FIXED yPct so only the X component
        // reflects pan/zoom). Sits at the very top, above the frontier tags.
        const gradeTicks = gradeTickRefs.current;
        for (const tick of gradeRulerRef.current) {
          const el = gradeTicks.get(tick.grade);
          if (!el) continue;
          const { sx } = project(tick.xPct, 8, 0);
          el.style.transform = `translateX(${sx.toFixed(1)}px)`;
          el.style.visibility = "";
        }
        let anyVisible = false;
        for (const n of nodesRef.current) {
          const { sx, sy } = project(n.xPct, n.yPct, n.z);
          if (sx >= 0 && sx <= vpW && sy >= 0 && sy <= vpH) { anyVisible = true; break; }
        }
        const shouldShow = nodesRef.current.length > 0 && !anyVisible;
        if (shouldShow !== showRecenterRef.current) {
          showRecenterRef.current = shouldShow;
          setShowRecenter(shouldShow);
        }
        // ── Node labels: screen-space, constant size, BELOW the node so the dot
        //    is never covered. Greedy hide-on-collision by importance:
        //    hovered > lit connected neighbour > leading-frontier > rest. ──
        {
          const labelEls = nodeLabelRefs.current;
          const showAll = info.zoom / info.baseZoom >= LABEL_REVEAL_RATIO; // reveal all deeper in
          const active = hoveredRef.current ?? selectedKeyRef.current;
          const neigh = active ? neighboursRef.current.get(active) : undefined;
          const r = Math.min(dialSize * info.zoom, NODE_CAP_PX) / 2;
          const GAP = 3, PAD = 3;
          const cands: { n: TreeNodeVM; sx: number; sy: number; prio: number; el: HTMLDivElement; color: string }[] = [];
          for (const n of nodesRef.current) {
            const el = labelEls.get(n.nodeKey);
            if (!el) continue;
            const { sx, sy } = project(n.xPct, n.yPct, n.z);
            const onScreen = sx > -100 && sx < vpW + 260 && sy > -40 && sy < vpH + 40;
            const isActive = active != null && n.nodeKey === active;
            const isNeigh = !!neigh && neigh.has(n.nodeKey);
            if (!(onScreen && (isActive || isNeigh || n.isLeadingFrontier || showAll))) {
              el.style.opacity = "0";
              continue;
            }
            const prio = isActive ? 0 : isNeigh ? 1 : n.isLeadingFrontier ? 2 : 3;
            // Colour: the hovered node's own label pops near-black; any lit
            // neighbour (same- or cross-strand) is blue; "" reverts to the muted
            // default (gray.700) from the CSS class.
            const color = isActive ? LABEL_HOVER : isNeigh ? EDGE_LIT : "";
            cands.push({ n, sx, sy, prio, el, color });
          }
          cands.sort((a, b) => a.prio - b.prio || a.sy - b.sy || a.sx - b.sx);
          const placedL: { l: number; r: number; t: number; b: number }[] = [];
          for (const c of cands) {
            const size = nodeLabelSizeRef.current.get(c.n.nodeKey);
            const w = size?.w || c.n.label.length * 6.5;
            const h = size?.h || 15;                            // actual (1–3 line) height
            const x = c.sx;                                    // first glyph under the node
            let topY = c.sy + r + GAP;                         // just below the dot
            if (topY + h > vpH - 4) topY = c.sy - r - GAP - h; // near bottom → flip above
            let hit = false;
            for (const p of placedL) {
              if (x < p.r + PAD && x + w > p.l - PAD && topY < p.b + PAD && topY + h > p.t - PAD) { hit = true; break; }
            }
            if (hit) { c.el.style.opacity = "0"; continue; } // hidden (lower priority)
            placedL.push({ l: x, r: x + w, t: topY, b: topY + h });
            c.el.style.transform = `translate(${x.toFixed(1)}px, ${topY.toFixed(1)}px)`;
            c.el.style.color = c.color;                        // "" → default gray.700
            c.el.style.opacity = "1";
          }
          // Enable the fade only from the 2nd frame → first-open labels don't fade in.
          const overlay = nodeLabelOverlayRef.current;
          if (!labelAnimReadyRef.current && overlay) {
            labelAnimFramesRef.current += 1;
            if (labelAnimFramesRef.current >= 2) {
              overlay.dataset.anim = "on";
              labelAnimReadyRef.current = true;
            }
          }
        }
        // Reveal rail after the first frame positions everything correctly.
        if (rail && rail.style.visibility === "hidden") {
          rail.style.visibility = "";
        }
      },
    });
    cameraRef.current = cam;
    cam.setVerticalCap(laneSpanYPct > 0 ? { maxPx: ROW_CAP_PX, refSpanYPct: laneSpanYPct } : null);
    return () => { cam.destroy(); cameraRef.current = null; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [handleTap, handleHover, handleHoverLeave]);

  // Keep the row-height cap in sync when the strand layout changes.
  useEffect(() => {
    cameraRef.current?.setVerticalCap(
      laneSpanYPct > 0 ? { maxPx: ROW_CAP_PX, refSpanYPct: laneSpanYPct } : null,
    );
  }, [laneSpanYPct]);

  const fitContent = useCallback((animate = false) => {
    const cam = cameraRef.current;
    if (!cam || nodesRef.current.length === 0) return;
    cam.measure();
    // Full-screen surfaces fit the WHOLE tree to the viewport; fixed-height cards
    // keep the historical FRONTIER-focused framing (fall back to the whole tree
    // when the scholar has no frontier yet).
    const box = fitToViewport
      ? allBox(nodesRef.current)
      : frontierBox(nodesRef.current) ?? allBox(nodesRef.current);
    cam.fit(box, animate);
  }, [fitToViewport]);

  // ── default view. Fixed-height cards fit ONCE per node-set change: the camera's
  //    own ResizeObserver keeps the projection correct on container resize WITHOUT
  //    discarding the user's pan/zoom. Full-screen surfaces (fitToViewport) also
  //    re-fit after a full-bleed flex pane settles its real size (often a frame
  //    after the first effect) and on later container resizes, so the whole tree
  //    stays framed instead of stranded below the fold.
  useEffect(() => {
    if (nodes.length === 0) return;

    fitContent(false);
    if (!fitToViewport) return;

    let raf: number | null = requestAnimationFrame(() => {
      raf = null;
      fitContent(false);
    });
    const scheduleFit = () => {
      if (raf !== null) cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        raf = null;
        fitContent(false);
      });
    };

    const vp = vpRef.current;
    let ro: ResizeObserver | null = null;
    if (vp && typeof ResizeObserver !== "undefined") {
      ro = new ResizeObserver(scheduleFit);
      ro.observe(vp);
    } else {
      window.addEventListener("resize", scheduleFit);
    }

    return () => {
      if (raf !== null) cancelAnimationFrame(raf);
      ro?.disconnect();
      if (!ro) window.removeEventListener("resize", scheduleFit);
    };
  }, [fitContent, nodes, fitToViewport]);

  const recenter = () => {
    fitContent(true);
  };

  return (
    <Box position="relative" h={fill ? "100%" : height}
      borderRadius={fill ? undefined : "xl"} overflow="hidden"
      borderWidth={fill ? undefined : "1px"} borderColor={fill ? undefined : "gray.200"}
      css={{ background: "radial-gradient(130% 130% at 50% 30%, #ffffff, #f2f4f1 82%)" }}>

      {/* Recenter — shown ONLY when the user has panned/zoomed so no node is in
          view. Dead-centre, so it's where the eye is when lost. */}
      {showRecenter && (
        <Button
          position="absolute" top="50%" left="50%" zIndex={6}
          size="sm" variant="subtle" colorPalette="gray"
          css={{ transform: "translate(-50%, -50%)", background: "rgba(255,255,255,0.92)", backdropFilter: "blur(3px)" }}
          borderWidth="1px" borderColor="gray.200"
          onClick={recenter}
        >
          <Crosshair weight="bold" /> Recenter
        </Button>
      )}

      {/* screen-space edge overlay (parallax-tracked each frame) */}
      <svg ref={svgRef} aria-hidden="true"
        style={{ position: "absolute", inset: 0, width: "100%", height: "100%", pointerEvents: "none", zIndex: 2 }}>
        <defs>
          {/* Arrowheads: one marker per edge colour, each fill tied to the SAME
              colour constant its line's stroke uses (grey at rest, blue when a
              hover/select lights it). Per-colour markers rather than SVG2
              `context-stroke`, which WebKit/WKWebView renders as black. */}
          <marker id="mapArrowRest" viewBox="0 0 8 8" refX="6.5" refY="4" markerWidth="4.2" markerHeight="4.2" orient="auto-start-reverse">
            <path d="M0,0 L8,4 L0,8 Z" fill={EDGE_REST} />
          </marker>
          <marker id="mapArrowLit" viewBox="0 0 8 8" refX="6.5" refY="4" markerWidth="4.2" markerHeight="4.2" orient="auto-start-reverse">
            <path d="M0,0 L8,4 L0,8 Z" fill={EDGE_LIT} />
          </marker>
        </defs>
        {drawEdges.map((e) => {
          // Edges on demand: at rest show only CROSS-strand prerequisites faintly
          // (same-strand order is implied by the lane chain); on hover/select of a
          // node, reveal its neighbourhood — prerequisites (pointing in) and
          // unlocks (pointing out), both the SAME blue (direction reads from the
          // arrow's left/right, not colour).
          const activeKey = hoveredKey ?? selectedKey;
          const isPrereq = activeKey != null && e.toKey === activeKey;
          const isUnlock = activeKey != null && e.fromKey === activeKey;
          const touches = isPrereq || isUnlock;
          const crossStrand = e.crossStrand;
          const stroke = touches ? EDGE_LIT : EDGE_REST;
          const opacity = touches ? 0.9 : crossStrand ? 0.2 : 0;
          // Lit edges always keep their arrowhead (direction cue, few of them);
          // the faint at-rest arrowheads drop when zoomed out (showArrows).
          const markerEnd =
            opacity <= 0 ? undefined
              : touches ? "url(#mapArrowLit)"
              : showArrows ? "url(#mapArrowRest)"
              : undefined;
          return (
            <path key={`${e.fromKey}__${e.toKey}`} fill="none"
              ref={(el) => { const m = lineRefs.current; const k = `${e.fromKey}__${e.toKey}`; if (el) m.set(k, el); else m.delete(k); }}
              stroke={stroke} strokeWidth={touches ? 1.75 : 1} strokeOpacity={opacity}
              markerEnd={markerEnd} strokeLinecap="round" />
          );
        })}
        {/* Frontier lines — the "how far along am I" boundary drawn over time
            (current bold gold; yesterday / week-ago ghosts faded). Points are set
            per-frame in onFrame (parallax-tracked like the edges). */}
        {frontierLines.map((line) => {
          const s = FRONTIER_STYLE[line.key];
          return (
            <path key={line.key}
              ref={(el) => { const m = frontierPolyRefs.current; if (el) m.set(line.key, el); else m.delete(line.key); }}
              fill="none" stroke={FRONTIER_GOLD} strokeWidth={s.width} strokeOpacity={s.opacity}
              strokeLinecap="round" strokeLinejoin="round" />
          );
        })}
      </svg>

      {/* Grade ruler — a quiet top-of-map strip (K · 1 · 2 · … ) anchoring the
          x-axis to CONTENT (a grade band), never the scholar: it labels where
          content sits, not how far "behind" or "ahead" anyone is. Muted, small,
          x-tracked in onFrame (same trick as the frontier tags) — sits ABOVE
          them so the two rows never collide. */}
      {gradeRuler.length > 0 && (
        <Box position="absolute" inset={0} zIndex={5} pointerEvents="none" aria-hidden="true">
          {gradeRuler.map((tick) => (
            <Box
              key={tick.grade}
              ref={(el: HTMLDivElement | null) => { const m = gradeTickRefs.current; if (el) m.set(tick.grade, el); else m.delete(tick.grade); }}
              position="absolute" left={0} top="4px"
              px="4px" borderRadius="sm"
              fontSize={`${10 * labelScale}px`} fontWeight="600" color="charcoal.400"
              borderWidth="1px" borderColor="rgba(0,0,0,0.07)"
              css={{ background: "rgba(255,255,255,0.8)", backdropFilter: "blur(2px)", whiteSpace: "nowrap" }}
              style={{ visibility: "hidden", willChange: "transform" }}
            >
              {tick.grade}
            </Box>
          ))}
        </Box>
      )}

      {/* Frontier line labels — small pills (blur/border like the map chips),
          pinned to the top of each line + parallax-tracked in onFrame. The
          "current" line (the scholar's own boundary — "You are here") also
          carries a short inline key for the node dot colours right underneath,
          in the SAME parallax-tracked box, so a first-open Tree explains its
          own colours without a separate legend panel (FTUE M6). */}
      <Box position="absolute" inset={0} zIndex={5} pointerEvents="none">
        {frontierLines.map((line) => (
          <Box
            key={line.key}
            ref={(el: HTMLDivElement | null) => { const m = frontierLabelRefs.current; if (el) m.set(line.key, el); else m.delete(line.key); }}
            position="absolute" left={0} top={0}
            style={{ visibility: "hidden", willChange: "transform" }}
          >
            <Box
              px={2} py="1px" borderRadius="full"
              fontSize={`${10 * labelScale}px`} fontWeight={line.key === "current" ? "700" : "600"}
              color={FRONTIER_GOLD}
              borderWidth="1px" borderColor="rgba(217,154,0,0.4)"
              css={{ background: "rgba(255,255,255,0.85)", backdropFilter: "blur(3px)", whiteSpace: "nowrap" }}
              style={{ opacity: line.key === "current" ? 1 : line.key === "yesterday" ? 0.8 : 0.62 }}
            >
              {line.label}
            </Box>
            {line.key === "current" && (
              <HStack
                gap={2} mt="3px" px={2} py="1px" borderRadius="md"
                fontSize={`${9 * labelScale}px`} fontWeight="600" color="charcoal.500"
                borderWidth="1px" borderColor="rgba(0,0,0,0.07)"
                css={{ background: "rgba(255,255,255,0.85)", backdropFilter: "blur(3px)", whiteSpace: "nowrap" }}
              >
                <HStack gap="4px">
                  <Box w="7px" h="7px" borderRadius="full" flexShrink={0} css={{ background: DOT_COLOR.locked }} />
                  <Text as="span">{MASTERY_LABELS.not_started}</Text>
                </HStack>
                <HStack gap="4px">
                  <Box w="7px" h="7px" borderRadius="full" flexShrink={0} css={{ background: DOT_COLOR.frontier }} />
                  <Text as="span">{MASTERY_LABELS.practicing}</Text>
                </HStack>
                <HStack gap="4px">
                  {/* provisional (inferred credit) — HOLLOW green ring, matching
                      the node dot: on the map at this level, not yet proven. */}
                  <Box
                    w="7px" h="7px" borderRadius="full" flexShrink={0}
                    css={{ background: "#ffffff", boxShadow: `inset 0 0 0 1.5px ${DOT_COLOR.placed}` }}
                  />
                  <Text as="span">{MASTERY_LABELS.placed}</Text>
                </HStack>
                <HStack gap="4px">
                  <Box w="7px" h="7px" borderRadius="full" flexShrink={0} css={{ background: DOT_COLOR.fluent }} />
                  <Text as="span">{MASTERY_LABELS.fluent}</Text>
                </HStack>
                {hasStruggling && (
                  <HStack gap="4px">
                    <Box w="7px" h="7px" borderRadius="full" flexShrink={0} css={{ background: DOT_COLOR.struggling }} />
                    <Text as="span">{STRUGGLING_LABEL}</Text>
                  </HStack>
                )}
              </HStack>
            )}
          </Box>
        ))}
      </Box>

      {/* ── Node labels — screen-space overlay (constant pixel size, NOT scaled by
           the camera). Positioned BELOW each node in onFrame (first letter under
           the dot), hidden on collision, faded in/out over 200 ms. The overlay
           gains data-anim="on" after the first frame so first-open labels don't
           fade in. aria-hidden — the visually-hidden node list below is the AT
           surface. */}
      <Box
        ref={nodeLabelOverlayRef}
        data-anim="off"
        position="absolute" inset={0} zIndex={4} pointerEvents="none" aria-hidden="true"
        css={{ "&[data-anim='on'] .rh-nodelabel": { transition: "opacity 0.2s ease" } }}
      >
        {nodes.map((n) => (
          <Box
            key={n.nodeKey}
            className="rh-nodelabel"
            ref={(el: HTMLDivElement | null) => { const m = nodeLabelRefs.current; if (el) m.set(n.nodeKey, el); else m.delete(n.nodeKey); }}
            position="absolute" left={0} top={0}
            fontSize={`${MAP_LABEL.fontSizePx * labelScale}px`} fontWeight={n.frontier ? "800" : "600"}
            color="gray.700"
            css={{
              maxWidth: `${MAP_LABEL.maxWidthPx}px`, lineHeight: `${MAP_LABEL.lineHeight}`,
              // wrap to at most `lineClamp` lines (shared with the Sky via MAP_LABEL)
              display: "-webkit-box", WebkitBoxOrient: "vertical", WebkitLineClamp: MAP_LABEL.lineClamp,
              overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "normal",
              opacity: 0, willChange: "transform, opacity",
              textShadow: "0 1px 2px rgba(255,255,255,0.95), 0 0 2px rgba(255,255,255,0.9)",
              padding: "0 1px",
            }}
          >
            {n.label}
          </Box>
        ))}
      </Box>

      {/* the transformed plane — aria-hidden; the hidden list below is the a11y surface */}
      <Box ref={vpRef} position="absolute" inset={0} zIndex={3}>
        <Box ref={sceneRef} position="absolute" inset={0} aria-hidden="true"
          css={{ transformStyle: "preserve-3d" }}>
          {nodes.map((n) => {
            const selected = selectedKey === n.nodeKey;
            // Surface 3 fog-of-war: a domain that's grade-eligible but not yet
            // mapped renders its dials hazy — driven purely by the domain's
            // band status, never a per-node reading, so this never diverges
            // from the fog label painted on the band's header above.
            const fogged = n.domain ? Boolean(domainFog?.[n.domain]) : false;
            const outOfScope =
              !!practiceScope &&
              !scopeAllowsStrand(practiceScope, n.domain ?? "", n.strand);
            return (
              <Box key={n.nodeKey} position="absolute"
                left={`${n.xPct}%`} top={`${n.yPct}%`}
                css={{
                  transform: `translate(-50%,-50%) translateZ(${n.z}px)`,
                  pointerEvents: "none",
                  // Reduced opacity ONLY — native react-native-svg has no
                  // grayscale filter, and a scholar-facing parity fork (web
                  // desaturates, iPad doesn't) is a defect, not a nicety.
                  opacity: fogged || outOfScope ? 0.35 : 1,
                }}>
                {/* frontier glow / selection ring — counter-scale the row-cap
                    squish (--rh-vsy-inv) so the dial + glow stay round. */}
                <Box position="relative" display="flex" flexDirection="column" alignItems="center" gap={1}
                  css={{
                    transform: "scaleY(var(--rh-vsy-inv, 1))",
                    filter: n.frontier
                      ? "drop-shadow(0 0 10px rgba(224,184,78,0.8)) drop-shadow(0 0 3px rgba(224,184,78,0.9))"
                      : undefined,
                  }}>
                  <Box position="relative" borderRadius="full"
                    css={{
                      transform: "scale(var(--rh-node-scale, 1))",
                      transformOrigin: "center center",
                      ...(selected ? { boxShadow: "0 0 0 3px #5663c6, 0 0 0 6px rgba(86,99,198,0.25)" } : {}),
                    }}>
                    <KnowledgeNodeDial mastery={n.mastery} automaticity={n.automaticity} depth={n.depth} size={dialSize} flankWidth={1.5} />
                    {outOfScope && (
                      <Box
                        position="absolute"
                        left="-18%"
                        top="48%"
                        w="136%"
                        h="1px"
                        bg="gray.500"
                        opacity={0.72}
                        transform="rotate(-45deg)"
                        transformOrigin="center"
                        aria-hidden
                      />
                    )}
                    {showFlags && n.flagged && (
                      <Box position="absolute" top="-6px" right="-6px">
                        <MisconceptionFlag size={16} />
                      </Box>
                    )}
                  </Box>
                </Box>
              </Box>
            );
          })}
        </Box>
      </Box>

      {/* ── Left rail — horizontally pinned, vertically camera-tracked ──
           Every lane shows a Title-Case STRAND label centred on its node row
           and indented so it reads as nested under its domain. On the unified
           map each band's first strand also carries an ALL-CAPS DOMAIN header
           sitting in the gap above it — the tree analogue of the sky's
           per-domain region labels, so both levels of the hierarchy read at
           once. Hidden until the first rAF frame positions the labels so they
           don't flash at (0,0); each tracks the camera's vertical transform via
           project(50, yPct, 0) in onFrame above. */}
      {railItems.length > 0 && (
        <Box
          ref={railRef}
          position="absolute" left={0} top={0}
          pointerEvents="none" zIndex={4} aria-hidden="true"
          style={{ visibility: "hidden" }}
        >
          {railItems.map(({ key, label, domainHeader, fogLabel }) => (
            <Box
              key={key}
              ref={(el: HTMLElement | null) => {
                const m = laneLabelRefs.current;
                if (el) m.set(key, el as HTMLElement);
                else m.delete(key);
              }}
              position="absolute"
              left={0}
              top={0}
            >
              {/* on the unified map: the DOMAIN header for this band, floated
                  into the gap above its first strand (flush-left, so the
                  indented strands read as nested beneath it). The grouping is
                  carried by heading typography, not an edge stripe or a
                  decorative dot (see visual-design rules). A fogged band (not
                  yet mapped — Surface 3) appends its fog label here too, even
                  on a single-domain view where there's no domain name to show. */}
              {(domainHeader || fogLabel) && (
                <Box
                  ref={(el: HTMLElement | null) => {
                    const m = domainHeaderRefs.current;
                    if (el) m.set(key, el as HTMLElement);
                    else m.delete(key);
                  }}
                  position="absolute"
                  left={0}
                  top={0}
                  px="6px"
                  py="2px"
                  borderRightRadius="sm"
                  css={{
                    background: "rgba(255,255,255,0.86)",
                    backdropFilter: "blur(4px)",
                    border: "1px solid rgba(0,0,0,0.07)",
                    whiteSpace: "nowrap",
                  }}
                >
                  {domainHeader && (
                    <Text
                      fontSize={labelScale === 1 ? "xs" : `calc(0.75rem * ${labelScale})`}
                      fontWeight="700" color="charcoal.600"
                      letterSpacing="0.06em" textTransform="uppercase"
                      css={{ lineHeight: "1.4" }}
                    >
                      {domainHeader}
                    </Text>
                  )}
                  {/* the fog label (Surface 3) — lowercase, understated, never
                      shouting louder than the domain header it sits beside. */}
                  {fogLabel && (
                    <Text
                      fontSize={labelScale === 1 ? "10px" : `calc(0.625rem * ${labelScale})`}
                      fontWeight="500" color="gray.500" fontStyle="italic"
                      css={{ lineHeight: "1.3" }}
                    >
                      {fogLabel}
                    </Text>
                  )}
                </Box>
              )}
              {/* the STRAND label for this lane's row — indented ~8px to nest
                  under the domain header, and centred on the row (via onFrame)
                  so it lines up with its row of node dots. */}
              <Box
                ref={(el: HTMLElement | null) => {
                  const m = strandLabelRefs.current;
                  if (el) m.set(key, el as HTMLElement);
                  else m.delete(key);
                }}
                ml="8px"
                px="6px"
                py="2px"
                borderRightRadius="sm"
                css={{
                  background: "rgba(255,255,255,0.86)",
                  backdropFilter: "blur(4px)",
                  border: "1px solid rgba(0,0,0,0.07)",
                  whiteSpace: "nowrap",
                }}
              >
                <Text
                  fontSize={labelScale === 1 ? "2xs" : `calc(0.625rem * ${labelScale})`}
                  fontWeight="600" color="charcoal.500"
                  css={{ lineHeight: "1.4" }}
                >
                  {label}
                </Text>
              </Box>
            </Box>
          ))}
        </Box>
      )}

      {/* ── a11y: visually-hidden node list (the AT/keyboard surface) ── */}
      <Box as="ul" role="list" position="absolute" zIndex={5}
        css={{
          width: "1px", height: "1px", overflow: "hidden",
          clip: "rect(0 0 0 0)", clipPath: "inset(50%)", whiteSpace: "nowrap",
        }}>
        {nodes.map((n) => (
          <li key={n.nodeKey}>
            <button type="button" onClick={() => onSelect(n.nodeKey)}>
              {n.label}
              {" — "}
              {n.mastery === "overlearned" ? MASTERY_LABELS.overlearned
                : n.mastery === "fluent" ? MASTERY_LABELS.fluent
                : n.mastery === "placed" ? `${MASTERY_LABELS.placed} at this level`
                : n.mastery === "struggling" ? STRUGGLING_LABEL
                : n.mastery === "frontier" ? "on the frontier"
                : "not yet reachable"}
              {n.frontier ? ", frontier" : ""}
              {showFlags && n.flagged ? ", flagged for review" : ""}
              {practiceScope &&
              !scopeAllowsStrand(practiceScope, n.domain ?? "", n.strand)
                ? ", outside today’s available practice"
                : ""}
            </button>
          </li>
        ))}
      </Box>
    </Box>
  );
}
