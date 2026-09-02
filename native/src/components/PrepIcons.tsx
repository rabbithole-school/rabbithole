import Svg, { Circle, Line, Path, Rect } from "react-native-svg";

/**
 * Restrained, monochrome line glyphs for the native Scholar's-Prep chooser —
 * the twins of the web plate-family Phosphor icons (lib/activityMode.tsx). Drawn
 * with react-native-svg in the same ink style (single stroke, round joins) so
 * the two frontends read identically. Paths mirror review/prep-time-chooser.html.
 *
 *   reflection = a sun over the horizon (sunset — "the day winding down")
 *   Workshop   = a toolbox
 *   teacher    = the plate's OWN mode glyph: Target (class focus) / House (homework)
 */

type IconProps = { size?: number; color: string };

const STROKE = 1.8;

/** Sunset — the reflection glyph (SunHorizon). */
export function SunHorizonIcon({ size = 24, color }: IconProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Line x1="3" y1="18" x2="21" y2="18" stroke={color} strokeWidth={STROKE} strokeLinecap="round" />
      <Path d="M7.5 18a4.5 4.5 0 0 1 9 0" stroke={color} strokeWidth={STROKE} strokeLinecap="round" strokeLinejoin="round" />
      <Line x1="12" y1="5.5" x2="12" y2="8" stroke={color} strokeWidth={STROKE} strokeLinecap="round" />
      <Line x1="4.8" y1="8.8" x2="6.5" y2="10.5" stroke={color} strokeWidth={STROKE} strokeLinecap="round" />
      <Line x1="19.2" y1="8.8" x2="17.5" y2="10.5" stroke={color} strokeWidth={STROKE} strokeLinecap="round" />
    </Svg>
  );
}

/** Toolbox — the Workshop glyph. */
export function ToolboxIcon({ size = 24, color }: IconProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Rect x="3" y="8" width="18" height="11" rx="2" stroke={color} strokeWidth={STROKE} strokeLinejoin="round" />
      <Path
        d="M8.5 8V6.2A2.2 2.2 0 0 1 10.7 4h2.6A2.2 2.2 0 0 1 15.5 6.2V8"
        stroke={color}
        strokeWidth={STROKE}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <Line x1="3" y1="13" x2="21" y2="13" stroke={color} strokeWidth={STROKE} />
      <Rect x="10" y="10.8" width="4" height="4.4" rx="1" stroke={color} strokeWidth={STROKE} strokeLinejoin="round" />
    </Svg>
  );
}

/** Target — the class-focus mode glyph (matches the plate's ActivityModeIcon). */
export function TargetIcon({ size = 24, color }: IconProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Circle cx="12" cy="12" r="8.5" stroke={color} strokeWidth={STROKE} />
      <Circle cx="12" cy="12" r="4.4" stroke={color} strokeWidth={STROKE} />
      <Circle cx="12" cy="12" r="1.4" fill={color} />
    </Svg>
  );
}

/** House — the homework mode glyph. */
export function HouseIcon({ size = 24, color }: IconProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Path
        d="M4 10.8 12 4l8 6.8"
        stroke={color}
        strokeWidth={STROKE}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <Path
        d="M5.8 9.7V19a1 1 0 0 0 1 1h10.4a1 1 0 0 0 1-1V9.7"
        stroke={color}
        strokeWidth={STROKE}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <Path d="M10 20v-5h4v5" stroke={color} strokeWidth={STROKE} strokeLinecap="round" strokeLinejoin="round" />
    </Svg>
  );
}

/** Crescent moon — the Scholar's-Prep strip glyph (the block's identity slot,
 *  "the day winding down"). Filled, so it reads as a coloured slot like the
 *  Playlist's ∴ glyph. Twin of the web strip's Phosphor Moon (weight="fill"). */
export function MoonIcon({ size = 18, color }: IconProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" fill={color} />
    </Svg>
  );
}
