import type { ReactElement } from "react";
import Svg, { Circle, Line, Path, Rect } from "react-native-svg";

/**
 * Restrained, monochrome line glyphs for the native "Today's Math Playlists"
 * tile carousel — the twins of the web tile row's Phosphor icons
 * (components/practice/PlaylistCard.tsx's `TILE_ICONS`, resolved from the
 * SAME shared name map, shared/practiceChoiceSelection.ts's
 * `playlistTileIconName`). Drawn with react-native-svg in the same ink style
 * as native/src/components/PrepIcons.tsx (single stroke, round joins) so the
 * two frontends read identically — native has no Phosphor package (see that
 * file's header comment for the same convention), so every icon name the
 * shared map can return needs its own hand-drawn twin here.
 *
 * One component per icon NAME (matching the exact strings
 * `playlistTileIconName` returns) — `PLAYLIST_TILE_ICONS` below is the
 * name → component lookup PracticePlaylistCard renders through (a direct
 * object index, not a wrapping function, so the compiler can see the
 * reference is stable across renders — see `TileIcon` there), so a missing
 * twin fails loudly in dev rather than silently drawing nothing.
 *
 *   Shuffle      = "Today's blend" (two crossing arrows)
 *   Calculator   = whole-number arithmetic
 *   ChartPieSlice = fractions (a pie with one wedge marked)
 *   DiceFive     = probability (a die showing five)
 *   Ruler        = geometry & measurement
 *   Percent      = ratios, rates & percent
 *   GridFour     = integers & the coordinate plane (four quadrants)
 *   Function     = early algebra (a function "f")
 *   BracketsCurly = Algebra 1 (symbolic structure)
 */

type IconProps = { size?: number; color: string };

const STROKE = 1.8;

/** Two crossing arrows — the blend/mix glyph for "Today's blend". */
export function ShuffleIcon({ size = 24, color }: IconProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Path
        d="M4 7h3.2a4 4 0 0 1 3.2 1.6l3.2 4.8A4 4 0 0 0 16.8 15H19"
        stroke={color}
        strokeWidth={STROKE}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <Path
        d="M4 15h3.2a4 4 0 0 0 3.2-1.6"
        stroke={color}
        strokeWidth={STROKE}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <Path
        d="M14 9a4 4 0 0 1 2.8-1H19"
        stroke={color}
        strokeWidth={STROKE}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <Path d="M16.5 4.5 19 7l-2.5 2.5" stroke={color} strokeWidth={STROKE} strokeLinecap="round" strokeLinejoin="round" />
      <Path d="M16.5 12.5 19 15l-2.5 2.5" stroke={color} strokeWidth={STROKE} strokeLinecap="round" strokeLinejoin="round" />
    </Svg>
  );
}

/** A calculator — whole-number arithmetic. */
export function CalculatorIcon({ size = 24, color }: IconProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Rect x="5" y="3" width="14" height="18" rx="2" stroke={color} strokeWidth={STROKE} />
      <Rect x="7.3" y="5.5" width="9.4" height="3.6" rx="0.6" stroke={color} strokeWidth={STROKE} />
      <Circle cx="8.4" cy="12.6" r="1" fill={color} />
      <Circle cx="12" cy="12.6" r="1" fill={color} />
      <Circle cx="15.6" cy="12.6" r="1" fill={color} />
      <Circle cx="8.4" cy="16.4" r="1" fill={color} />
      <Circle cx="12" cy="16.4" r="1" fill={color} />
      <Circle cx="15.6" cy="16.4" r="1" fill={color} />
    </Svg>
  );
}

/** A pie chart with one wedge marked — fractions (a "part of a whole"). */
export function ChartPieSliceIcon({ size = 24, color }: IconProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Circle cx="12" cy="12" r="8" stroke={color} strokeWidth={STROKE} />
      <Path d="M12 12 12 4" stroke={color} strokeWidth={STROKE} strokeLinecap="round" />
      <Path d="M12 12 18.9 15.6" stroke={color} strokeWidth={STROKE} strokeLinecap="round" strokeLinejoin="round" />
    </Svg>
  );
}

/** A die showing five — probability (chance & likelihood). */
export function DiceFiveIcon({ size = 24, color }: IconProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Rect x="4" y="4" width="16" height="16" rx="3" stroke={color} strokeWidth={STROKE} />
      <Circle cx="8" cy="8" r="1.3" fill={color} />
      <Circle cx="16" cy="8" r="1.3" fill={color} />
      <Circle cx="12" cy="12" r="1.3" fill={color} />
      <Circle cx="8" cy="16" r="1.3" fill={color} />
      <Circle cx="16" cy="16" r="1.3" fill={color} />
    </Svg>
  );
}

/** A ruler with tick marks — geometry & measurement. */
export function RulerIcon({ size = 24, color }: IconProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Rect x="3" y="8.5" width="18" height="7" rx="1.2" stroke={color} strokeWidth={STROKE} />
      <Line x1="7" y1="8.5" x2="7" y2="11.5" stroke={color} strokeWidth={STROKE} strokeLinecap="round" />
      <Line x1="11" y1="8.5" x2="11" y2="12.8" stroke={color} strokeWidth={STROKE} strokeLinecap="round" />
      <Line x1="15" y1="8.5" x2="15" y2="11.5" stroke={color} strokeWidth={STROKE} strokeLinecap="round" />
      <Line x1="19" y1="8.5" x2="19" y2="12.8" stroke={color} strokeWidth={STROKE} strokeLinecap="round" />
    </Svg>
  );
}

/** The percent symbol — ratios, rates & percent. */
export function PercentIcon({ size = 24, color }: IconProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Line x1="5.5" y1="18.5" x2="18.5" y2="5.5" stroke={color} strokeWidth={STROKE} strokeLinecap="round" />
      <Circle cx="7.3" cy="7.3" r="2.3" stroke={color} strokeWidth={STROKE} />
      <Circle cx="16.7" cy="16.7" r="2.3" stroke={color} strokeWidth={STROKE} />
    </Svg>
  );
}

/** A four-quadrant grid — integers & the coordinate plane. */
export function GridFourIcon({ size = 24, color }: IconProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Rect x="4" y="4" width="7.2" height="7.2" rx="1" stroke={color} strokeWidth={STROKE} />
      <Rect x="12.8" y="4" width="7.2" height="7.2" rx="1" stroke={color} strokeWidth={STROKE} />
      <Rect x="4" y="12.8" width="7.2" height="7.2" rx="1" stroke={color} strokeWidth={STROKE} />
      <Rect x="12.8" y="12.8" width="7.2" height="7.2" rx="1" stroke={color} strokeWidth={STROKE} />
    </Svg>
  );
}

/** A stylized "f" — early algebra (expressions, equations, functions). */
export function FunctionIcon({ size = 24, color }: IconProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Path
        d="M15 4.6c-1 -0.5 -3.4 -0.7 -4 1.6L9 20"
        stroke={color}
        strokeWidth={STROKE}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <Line x1="6.6" y1="11" x2="13.4" y2="11" stroke={color} strokeWidth={STROKE} strokeLinecap="round" />
    </Svg>
  );
}

/** Curly braces — Algebra 1's symbolic structure and formula manipulation. */
export function BracketsCurlyIcon({ size = 24, color }: IconProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Path
        d="M9 4H8c-1.7 0-2.5.8-2.5 2.5V9c0 1.7-.8 2.5-2.5 2.5 1.7 0 2.5.8 2.5 2.5v3.5C5.5 19.2 6.3 20 8 20h1"
        stroke={color}
        strokeWidth={STROKE}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <Path
        d="M15 4h1c1.7 0 2.5.8 2.5 2.5V9c0 1.7.8 2.5 2.5 2.5-1.7 0-2.5.8-2.5 2.5v3.5c0 1.7-.8 2.5-2.5 2.5h-1"
        stroke={color}
        strokeWidth={STROKE}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </Svg>
  );
}

/** An arrow pointing up through a horizontal line — the Stretch tile ("a step
 *  past your usual set", the challenge lane's standing home). Matches the
 *  Phosphor ArrowLineUp shape: a line across the bottom, an arrow rising from
 *  it — directional (going further) without being a trophy or score. */
export function ArrowLineUpIcon({ size = 24, color }: IconProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Line x1="4" y1="20" x2="20" y2="20" stroke={color} strokeWidth={STROKE} strokeLinecap="round" />
      <Path
        d="M12 4 12 16"
        stroke={color}
        strokeWidth={STROKE}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <Path
        d="M7 9 12 4 17 9"
        stroke={color}
        strokeWidth={STROKE}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </Svg>
  );
}

/** A checkered flag — the "working toward" checkpoint glyph. Deliberately NOT
 *  in the tile registry below: it's a banner glyph (the scholar's goal marker),
 *  not a selectable playlist tile. Kept in ONE vocabulary with the teacher
 *  studio's checkpoint flag so the same signal reads the same everywhere. */
export function CheckpointFlagIcon({ size = 24, color }: IconProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      {/* pole */}
      <Line x1="6" y1="3" x2="6" y2="21" stroke={color} strokeWidth={STROKE} strokeLinecap="round" />
      {/* flag outline */}
      <Rect x="6" y="4" width="12" height="10" rx="0.5" stroke={color} strokeWidth={STROKE} />
      {/* checker cells (checkerboard: fill where col+row is even) */}
      <Rect x="6" y="4" width="4" height="5" fill={color} />
      <Rect x="14" y="4" width="4" height="5" fill={color} />
      <Rect x="10" y="9" width="4" height="5" fill={color} />
    </Svg>
  );
}

/** Name → component. This map is intentionally a superset of the exact strings
 *  shared/practiceChoiceSelection.ts's `playlistTileIconName` returns: every
 *  name that function can produce is covered (asserted by its icon-map
 *  completeness test), while Mountains and Anchor are preserved for the
 *  direct, mode-keyed blend tiles. */
/** Phosphor "Mountains" (regular, 256 viewBox, fill) — the mode-keyed blend
 *  tile in "Working toward checkpoint": the climb toward the band. */
export function MountainsIcon({ size = 24, color }: IconProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 256 256" fill="none">
      <Path
        d="M164,80a28,28,0,1,0-28-28A28,28,0,0,0,164,80Zm0-40a12,12,0,1,1-12,12A12,12,0,0,1,164,40Zm90.88,155.92-54.56-92.08A15.87,15.87,0,0,0,186.55,96h0a15.85,15.85,0,0,0-13.76,7.84L146.63,148l-44.84-76.1a16,16,0,0,0-27.58,0L1.11,195.94A8,8,0,0,0,8,208H248a8,8,0,0,0,6.88-12.08ZM88,80l23.57,40H64.43ZM22,192l33-56h66l18.74,31.8,0,0L154,192Zm150.57,0-16.66-28.28L186.55,112,234,192Z"
        fill={color}
      />
    </Svg>
  );
}

/** Phosphor "Anchor" (regular, 256 viewBox, fill) — the mode-keyed blend tile
 *  in "Going deeper": depth on the same ideas. */
export function AnchorIcon({ size = 24, color }: IconProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 256 256" fill="none">
      <Path
        d="M216,136a8,8,0,0,0-8,8c0,24.69-13.77,29.64-38.1,36.28-11.36,3.1-24.12,6.6-33.9,14.34V128h32a8,8,0,0,0,0-16H136V87a32,32,0,1,0-16,0v25H88a8,8,0,0,0,0,16h32v66.62c-9.78-7.74-22.54-11.24-33.9-14.34C61.77,173.64,48,168.69,48,144a8,8,0,0,0-16,0c0,38.11,27.67,45.66,49.9,51.72C106.23,202.36,120,207.31,120,232a8,8,0,0,0,16,0c0-24.69,13.77-29.64,38.1-36.28C196.33,189.66,224,182.11,224,144A8,8,0,0,0,216,136ZM112,56a16,16,0,1,1,16,16A16,16,0,0,1,112,56Z"
        fill={color}
      />
    </Svg>
  );
}

export const PLAYLIST_TILE_ICONS: Record<string, (props: IconProps) => ReactElement> = {
  ArrowLineUp: ArrowLineUpIcon,
  Shuffle: ShuffleIcon,
  Mountains: MountainsIcon,
  Anchor: AnchorIcon,
  Calculator: CalculatorIcon,
  ChartPieSlice: ChartPieSliceIcon,
  DiceFive: DiceFiveIcon,
  Ruler: RulerIcon,
  Percent: PercentIcon,
  GridFour: GridFourIcon,
  Function: FunctionIcon,
  BracketsCurly: BracketsCurlyIcon,
  // MathOperations is the shared map's generic fallback for an unregistered
  // domain — reuse the pie-slice glyph rather than drawing a 10th icon for a
  // case that should never occur with today's registered domains (the shared
  // module's test pins the 7 registered domains never hit this fallback).
  MathOperations: ChartPieSliceIcon,
};
