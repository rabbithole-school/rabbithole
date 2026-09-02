"use client";

/**
 * The two Math plan marks, and nothing else. Two authored controls, two marks
 * (see `mathPlanProjection.ts` for the projection rules and the words).
 *
 * Colour discipline: the slash is a NEUTRAL gray hairline that carries no band
 * meaning, and the corner reuses the checkpoint's two existing mode hues (the
 * frontier gold and the depth indigo already used by the mode pill), so the
 * matrix gains no new hue vocabulary. Neither mark may take the mastery,
 * mapping, access, or selection palettes.
 *
 * ONE checkpoint mark, two placements. `CheckpointCorner` is it against the
 * top-left of anything a cell-shaped — a matrix cell, the band chip, and the
 * scholar COLUMN HEADING that sits above a column of those cells; `CheckpointMark`
 * is the same tile standing on its own, for every checkpoint surface that is not
 * cell-shaped (the count legend, the grade pill, the group action, a compact
 * label). No checkpoint surface may draw a bare flag glyph, an outline flag, a
 * unicode flag character, or a circular badge instead — that is how the
 * vocabulary drifted in the first place.
 */

import { useId } from "react";
import { Box, Text } from "@chakra-ui/react";
import { FlagCheckered } from "@phosphor-icons/react";

import {
  CHECKPOINT_MODE_LABEL,
  type CheckpointCornerState,
  type CheckpointMode,
} from "@/components/practice/mathPlanProjection";

/** Hairline weight, neutral ink, corner to corner, top-right → bottom-left. */
export const OUT_OF_SCOPE_INK = "#5b6472";
/** The dial's 34px footprint plus 4px — the slash is clipped to this so it can
 *  never be misread as a third mastery arc. */
export const SLASH_KEEP_OUT_D = 38;

export const CHECKPOINT_CORNER_STYLE: Record<
  CheckpointCornerState,
  { bg: string; color: string }
> = {
  toward: { bg: "#fbe7a2", color: "#7a5b12" },
  deeper: { bg: "#dfe3fa", color: "#4550b0" },
  // A suspended checkpoint has no meaningful mode, so the corner drops the
  // mode hue rather than picking one of the two and implying a reading.
  conflict: { bg: "#fbdcdc", color: "#9b2c2c" },
};

/** The inward round the corner takes against the cell, and the one the
 *  standalone mark repeats — the mini mark is the SAME tile at another size,
 *  never a second shape. */
const CHECKPOINT_TILE_ROUND = "6px";
/** The flag's share of the tile. One ratio, so a 10px legend swatch and a 15px
 *  cell corner carry the same glyph at the same weight. */
const CHECKPOINT_GLYPH_RATIO = 0.62;

/**
 * OutOfScopeSlash — a 0.5px diagonal drawn OVER the cell's existing content,
 * never behind a wash and never replacing it. `keepOutD` masks a centred disc
 * so the hairline cannot be read as an extra arc on a mastery dial; a cell with
 * no reading passes 0 and the line runs unbroken.
 */
export function OutOfScopeSlash({
  keepOutD = 0,
}: {
  /** Diameter of the centred mask, in px. 0 ⇒ an unbroken corner-to-corner run. */
  keepOutD?: number;
}) {
  const maskId = useId();
  return (
    <Box
      aria-hidden
      position="absolute"
      inset={0}
      pointerEvents="none"
      data-testid="math-plan-slash"
    >
      <svg width="100%" height="100%" style={{ display: "block" }}>
        {keepOutD > 0 && (
          <defs>
            <mask id={maskId}>
              <rect x="0" y="0" width="100%" height="100%" fill="white" />
              <circle cx="50%" cy="50%" r={keepOutD / 2} fill="black" />
            </mask>
          </defs>
        )}
        <line
          x1="100%"
          y1="0"
          x2="0"
          y2="100%"
          stroke={OUT_OF_SCOPE_INK}
          strokeWidth="0.5"
          {...(keepOutD > 0 ? { mask: `url(#${maskId})` } : {})}
        />
      </svg>
    </Box>
  );
}

/**
 * CheckpointCorner — a filled corner square against the outer top-left of a
 * cell-shaped surface, rounded inward (`borderTopLeftRadius="inherit"`, so it
 * follows whatever round its host carries — square against a flush matrix cell,
 * rounded against a rounded column heading), carrying the one checkered flag.
 * It sits in the dead space above and left of the centred reading, so mastery
 * stays primary and nothing in the flow moves to make room for it. The
 * enclosing surface supplies the accessible name (see `cellReadoutWithMarks`).
 */
export function CheckpointCorner({
  state,
  size = 15,
}: {
  state: CheckpointCornerState;
  size?: number;
}) {
  const style = CHECKPOINT_CORNER_STYLE[state];
  return (
    <Box
      aria-hidden
      position="absolute"
      top={0}
      left={0}
      display="flex"
      alignItems="center"
      justifyContent="center"
      w={`${size}px`}
      h={`${size}px`}
      borderTopLeftRadius="inherit"
      borderBottomRightRadius={CHECKPOINT_TILE_ROUND}
      bg={style.bg}
      color={style.color}
      pointerEvents="none"
      data-testid={`math-plan-corner-${state}`}
    >
      <FlagCheckered
        size={Math.round(size * CHECKPOINT_GLYPH_RATIO)}
        weight="fill"
      />
    </Box>
  );
}

/**
 * CheckpointMark — the ONE checkpoint mark away from a cell: `CheckpointCorner`
 * lifted off the matrix, same tile, same fill, same flag, same inward round.
 * Every checkpoint surface that is not itself a cell — the count legend, the
 * grade pill, the group action, a compact "this is the checkpoint" label —
 * renders THIS rather than a bare flag glyph, so the teacher only ever learns
 * one mark. It never grows a badge, a wash, or a ring: the canonical yellow is
 * a small signal, not a highlight.
 *
 * `state` exists only for the two surfaces that genuinely display a resolved
 * mode (`CheckpointModePill`/`Chip`) or a resolved-mode legend. Generic
 * authoring controls use the default `toward` yellow; resolved modes pass their
 * state so the mark matches the corresponding cell corner.
 */
export function CheckpointMark({
  state = "toward",
  size = 13,
  label,
}: {
  state?: CheckpointCornerState;
  size?: number;
  /** Accessible name. Omit when visible text already names the checkpoint —
   *  the mark is decorative then, and a label would double the announcement. */
  label?: string;
}) {
  const style = CHECKPOINT_CORNER_STYLE[state];
  return (
    <Box
      as="span"
      {...(label
        ? { role: "img", "aria-label": label }
        : { "aria-hidden": true })}
      display="inline-flex"
      alignItems="center"
      justifyContent="center"
      flex="0 0 auto"
      w={`${size}px`}
      h={`${size}px`}
      borderTopLeftRadius="2px"
      borderBottomRightRadius={CHECKPOINT_TILE_ROUND}
      bg={style.bg}
      color={style.color}
      lineHeight="1"
      verticalAlign="-0.2em"
      data-testid={`checkpoint-mark-${state}`}
    >
      <FlagCheckered
        aria-hidden
        size={Math.round(size * CHECKPOINT_GLYPH_RATIO)}
        weight="fill"
      />
    </Box>
  );
}

/**
 * The two densities the band chip is drawn at. `cell` is the matrix cell's own
 * 44×34 footprint (the panel control, where the chip has to read as "this is
 * that mark"); `grid` is the modal picker's column pitch. Both keep the corner
 * proportional to the chip so the flag never grows a second geometry.
 */
export const CHECKPOINT_BAND_CHIP_SIZE = {
  cell: { w: 44, h: 34, corner: 15, fontSize: "xs" },
  grid: { w: 52, h: 30, corner: 13, fontSize: "2xs" },
} as const;

export type CheckpointBandChipSize = keyof typeof CHECKPOINT_BAND_CHIP_SIZE;

/**
 * CheckpointBandChip — the matrix cell at chip scale: a white rounded
 * rectangle wearing the SAME two marks (`CheckpointCorner`, `OutOfScopeSlash`)
 * over a centred grade label. Purely presentational and always decorative —
 * every consumer wraps or labels it, so the chip itself never carries the
 * accessible name and never gains a selected ring of its own (the corner flag
 * IS the "this one" mark).
 */
export function CheckpointBandChip({
  size = "cell",
  corner = null,
  outOfScope = false,
  label,
}: {
  size?: CheckpointBandChipSize;
  /** The checkpoint's derived mode when this band holds it, else null. */
  corner?: CheckpointCornerState | null;
  outOfScope?: boolean;
  /** The grade this band names, e.g. "G7". */
  label: string;
}) {
  const dims = CHECKPOINT_BAND_CHIP_SIZE[size];
  return (
    <Box
      aria-hidden
      position="relative"
      display="flex"
      alignItems="center"
      justifyContent="center"
      w={`${dims.w}px`}
      h={`${dims.h}px`}
      flex="0 0 auto"
      borderRadius="md"
      borderWidth="1px"
      borderColor="gray.300"
      bg="white"
      data-testid="checkpoint-band-chip"
    >
      <Text
        as="span"
        fontSize={dims.fontSize}
        fontWeight="700"
        color="charcoal.600"
        lineHeight="1"
      >
        {label}
      </Text>
      {outOfScope && <OutOfScopeSlash />}
      {corner && <CheckpointCorner state={corner} size={dims.corner} />}
    </Box>
  );
}

/**
 * CheckpointModePill — the same flag, beside the mode's own words, in the same
 * fill as the corner. The flag supplements the label and never carries the
 * meaning alone, so it is aria-hidden.
 *
 * This one does NOT nest `CheckpointMark`: the pill's whole body already IS the
 * tile's fill, so a tile inside it would be a fill on its own fill. It is the
 * same mark drawn at pill scale, not a second vocabulary.
 */
export function CheckpointModePill({
  mode,
  suspended = false,
}: {
  mode: CheckpointMode;
  /** A conflicted plan has no meaningful mode — say so instead of showing one. */
  suspended?: boolean;
}) {
  const state: CheckpointCornerState = suspended ? "conflict" : mode;
  const style = CHECKPOINT_CORNER_STYLE[state];
  return (
    <Box
      as="span"
      display="inline-flex"
      alignItems="center"
      gap={1}
      px={1.5}
      py="1px"
      borderRadius="full"
      bg={style.bg}
      color={style.color}
      fontSize="2xs"
      fontWeight="700"
      flexShrink={0}
      data-testid="checkpoint-mode-pill"
    >
      <FlagCheckered aria-hidden size={11} weight="fill" />
      {suspended ? "Suspended" : CHECKPOINT_MODE_LABEL[mode]}
    </Box>
  );
}

/**
 * The persistent Math plan key, folded into the matrix's existing legend strip
 * rather than added as a second legend: policy should not require a hover.
 */
export function MathPlanLegendItems() {
  return (
    <>
      <LegendItem label="Out of practice scope">
        <Box position="relative" w="22px" h="16px" borderWidth="1px" borderColor="gray.200">
          <OutOfScopeSlash />
        </Box>
      </LegendItem>
      <LegendItem label="Checkpoint · working toward">
        <LegendCorner state="toward" />
      </LegendItem>
      <LegendItem label="Checkpoint · going deeper">
        <LegendCorner state="deeper" />
      </LegendItem>
      <LegendItem label="Needs attention">
        <LegendCorner state="conflict" slashed />
      </LegendItem>
    </>
  );
}

function LegendCorner({
  state,
  slashed = false,
}: {
  state: CheckpointCornerState;
  slashed?: boolean;
}) {
  return (
    <Box
      position="relative"
      w="22px"
      h="16px"
      borderWidth="1px"
      borderColor="gray.200"
    >
      {slashed && <OutOfScopeSlash />}
      <CheckpointCorner state={state} size={10} />
    </Box>
  );
}

function LegendItem({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <Box as="span" display="inline-flex" alignItems="center" gap={1.5}>
      {children}
      <Text as="span">{label}</Text>
    </Box>
  );
}
