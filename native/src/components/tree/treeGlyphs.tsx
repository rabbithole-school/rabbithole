/**
 * treeGlyphs — pure react-native-svg element builders for the native Tree map's
 * crisp layer (edges, dials) and the node sheet's dial.
 *
 * ⚠️ `components/map/MapTreeCanvas.tsx` (+ `components/KnowledgeNodeDial.tsx`) are
 * the SOURCE OF TRUTH for the tree's visual language. The colour + size constants
 * below are copied VERBATIM from there so the two surfaces read as one lens; the
 * edge-arc / dial-arc math lives in ./treeGeometry (kept pure + node-testable).
 */

import { type ReactElement } from "react";
import { StyleSheet, View } from "react-native";
import Svg, {
  Circle,
  Defs,
  Path,
  RadialGradient,
  Rect,
  Stop,
} from "react-native-svg";

import { STAR_RASTER } from "@/lib/crispSvg";
import type { MasteryState } from "../../../vendor/shared/treeMapLayout";
import {
  MASTERY_DOT_COLOR,
  dialHollowFill,
  masteryDotColor,
  type DialSurface,
} from "../../../vendor/shared/masteryDialPalette";
import { arcDashArray, arcPathD } from "./treeGeometry";

// ── Visual constants (VERBATIM from MapTreeCanvas.tsx / KnowledgeNodeDial.tsx) ──
/** at-rest edge colour (faint grey prereq/unlock lines). */
export const EDGE_REST = "#c7cdc2";
/** the "lit up" hover/select colour — one blue for a node's whole neighbourhood. */
export const EDGE_LIT = "#5663c6";
/** frontier boundary line colour. */
export const FRONTIER_GOLD = "#d99a00";
/** node label colours. */
export const LABEL_REST = "#3a4352";
export const LABEL_SELECTED = "#121a26";
/** node dials never render larger than this on screen. */
export const NODE_CAP_PX = 24;
/** node labels stay frontier-only until zoomed this many × past the fitted baseline. */
export const LABEL_REVEAL_RATIO = 2.5;
/** faint at-rest arrowheads drop until zoomed this many × past the baseline. */
export const ARROW_REVEAL_RATIO = 1.5;

/** frontier line weight per snapshot (VERBATIM FRONTIER_STYLE). */
export const FRONTIER_STYLE: Record<
  "current" | "yesterday" | "weekAgo",
  { opacity: number; width: number }
> = {
  current: { opacity: 0.95, width: 3 },
  yesterday: { opacity: 0.5, width: 2 },
  weekAgo: { opacity: 0.3, width: 1.75 },
};

const COLOR_AUTOMATICITY = "#43cf8e"; // mint — left arc (automaticity)
const COLOR_DEPTH = "#5663c6"; // indigo — right arc (depth)
/** frontier glow amber (the native stand-in for the web drop-shadow). */
const HALO_AMBER = MASTERY_DOT_COLOR.frontier;

/** the web's paper plane: radial-gradient(130% 130% at 50% 30%, #fff, #f2f4f1 82%). */
export const PAPER_TOP = "#ffffff";
export const PAPER_EDGE = "#f2f4f1";

// ── Dial element builder (used inside the crisp <Svg>, in RASTER coords) ───────

export type DialGlyphOpts = {
  keyId: string;
  /** raster-space centre + bounding-box size. */
  cx: number;
  cy: number;
  size: number;
  /** flank (arc) stroke width, raster px. */
  flank: number;
  mastery: MasteryState;
  /** 0..1 — already redacted upstream (0 → the flank shows no fill). */
  automaticity: number;
  depth: number;
  /** frontier → a soft gold halo behind the dial (raster radius). */
  halo?: { r: number };
  /** selected → two concentric blue rings just outside the dial (raster). */
  selection?: { r1: number; r2: number; stroke: number };
  /** which plane the dial sits on — `night` for dark cards. Default `paper`. */
  surface?: DialSurface;
};

/**
 * The three-reading dial (mint automaticity flank + indigo depth flank + mastery
 * dot), plus the optional frontier halo / selection rings, as react-native-svg
 * elements. Returns a flat element array so it drops straight into a crisp <Svg>.
 */
export function dialGlyph(o: DialGlyphOpts): ReactElement[] {
  const arcR = (o.size * 18) / 44;
  const dotR = (o.size * 11) / 44;
  const els: ReactElement[] = [];

  // Frontier halo — behind everything (soft amber → transparent radial).
  if (o.halo) {
    const gid = `halo-${o.keyId}`;
    els.push(
      <Defs key={`${gid}-def`}>
        <RadialGradient id={gid} cx="50%" cy="50%" r="50%">
          <Stop offset="0" stopColor={HALO_AMBER} stopOpacity={0.55} />
          <Stop offset="0.5" stopColor={HALO_AMBER} stopOpacity={0.28} />
          <Stop offset="1" stopColor={HALO_AMBER} stopOpacity={0} />
        </RadialGradient>
      </Defs>,
      <Circle
        key={`${gid}-c`}
        cx={o.cx}
        cy={o.cy}
        r={o.halo.r}
        fill={`url(#${gid})`}
      />,
    );
  }

  // Selection rings — the port of the web boxShadow (3px solid + 3px translucent).
  if (o.selection) {
    els.push(
      <Circle
        key={`sel1-${o.keyId}`}
        cx={o.cx}
        cy={o.cy}
        r={o.selection.r1}
        fill="none"
        stroke={EDGE_LIT}
        strokeWidth={o.selection.stroke}
      />,
      <Circle
        key={`sel2-${o.keyId}`}
        cx={o.cx}
        cy={o.cy}
        r={o.selection.r2}
        fill="none"
        stroke="rgba(86,99,198,0.25)"
        strokeWidth={o.selection.stroke}
      />,
    );
  }

  // Left flank — automaticity (mint).
  els.push(
    <Path
      key={`la-${o.keyId}`}
      d={arcPathD(o.cx, o.cy, arcR, "left")}
      fill="none"
      stroke={COLOR_AUTOMATICITY}
      strokeWidth={o.flank}
      strokeDasharray={arcDashArray(o.automaticity, arcR)}
      strokeLinecap="butt"
    />,
    // Right flank — depth (indigo).
    <Path
      key={`ra-${o.keyId}`}
      d={arcPathD(o.cx, o.cy, arcR, "right")}
      fill="none"
      stroke={COLOR_DEPTH}
      strokeWidth={o.flank}
      strokeDasharray={arcDashArray(o.depth, arcR)}
      strokeLinecap="butt"
    />,
    // Centre dot — mastery state. "placed" (provisional) draws HOLLOW: a green
    // ring on paper-white fill, so inferred credit reads as "at this level, not
    // yet proven" instead of the solid fluent green (mirrors the web dial).
    o.mastery === "placed" ? (
      <Circle
        key={`dot-${o.keyId}`}
        cx={o.cx}
        cy={o.cy}
        r={dotR - Math.max(1, dotR * 0.28) / 2}
        fill={dialHollowFill(o.surface)}
        stroke={masteryDotColor("placed", o.surface)}
        strokeWidth={Math.max(1, dotR * 0.28)}
      />
    ) : (
      <Circle
        key={`dot-${o.keyId}`}
        cx={o.cx}
        cy={o.cy}
        r={dotR}
        fill={masteryDotColor(o.mastery, o.surface)}
      />
    ),
  );
  return els;
}

// ── Standalone dial (the node sheet) — flavour-1 STAR_RASTER oversample ────────

export function TreeDial({
  size = 44,
  mastery,
  automaticity,
  depth,
  surface = "paper",
}: {
  size?: number;
  mastery: MasteryState;
  automaticity: number;
  depth: number;
  surface?: DialSurface;
}) {
  // Draw the SVG at STAR_RASTER× its display size and counter-scale by 1/RASTER,
  // so the backing raster has headroom before it blurs (crispSvg flavour 1).
  const R = STAR_RASTER;
  const D = size * R;
  return (
    <View style={{ width: size, height: size, overflow: "hidden" }}>
      <Svg
        width={D}
        height={D}
        style={{ transform: [{ scale: 1 / R }], transformOrigin: "0 0" }}
      >
        {dialGlyph({
          keyId: "sheet",
          cx: D / 2,
          cy: D / 2,
          size: D,
          flank: 1.5 * R,
          mastery,
          automaticity,
          depth,
          surface,
        })}
      </Svg>
    </View>
  );
}

// ── Static paper background (screen-space, full-bleed) ─────────────────────────

export function PaperBackground() {
  return (
    <Svg style={StyleSheet.absoluteFill} pointerEvents="none">
      <Defs>
        <RadialGradient id="tree-paper" cx="50%" cy="30%" r="90%">
          <Stop offset="0" stopColor={PAPER_TOP} />
          <Stop offset="0.82" stopColor={PAPER_EDGE} />
          <Stop offset="1" stopColor={PAPER_EDGE} />
        </RadialGradient>
      </Defs>
      <Rect x="0" y="0" width="100%" height="100%" fill="url(#tree-paper)" />
    </Svg>
  );
}

// Re-export the geometry so importers reach it through the one glyph seam.
export { arrowheadPoints, airlineArc, straightEdge, pointsAttr } from "./treeGeometry";
