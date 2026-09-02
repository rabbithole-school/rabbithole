"use client";

/**
 * The one App Launcher tile mark on the web. Every surface that renders an
 * External App's squircle — the scholar's home launcher, the Apps catalog, a
 * scholar's app panel, the group dialog, the web-activity editor preview —
 * renders it through here, so the icon → emoji → initial chain and the tile
 * tint are defined once (`shared/appTileMark.ts`) instead of being restated
 * per surface. Same reasoning as `components/InstitutionMark.tsx`, and the
 * native launcher resolves through the same shared module.
 *
 * A remote logo that 404s, is blocked, or is simply unreachable would otherwise
 * end the chain at a blank white square, so the `<img>`'s `onError` is reported
 * back into the shared resolver and the tile continues to the emoji/initial —
 * the runtime rung of the same chain, not a second one. The failure is keyed on
 * the src, so pointing the tile at another image (or reusing this component for
 * another app) drops it automatically.
 *
 * Sizing is the caller's: pass `boxSize` (and `maxBoxSize` for the launcher's
 * fluid grid cell) plus a `markFontSize` in CSS length units. An emoji is
 * drawn 1.35x that, because a glyph fills its em box where a capital letter
 * only reaches cap height.
 *
 * So is the ANNOUNCEMENT, in one prop, exactly as on native
 * (`native/src/components/AppTileMark.tsx`). Standing alone the squircle is a
 * single image labeled "<app> icon" on every rung, so a mark is never a silent
 * letter or an unlabeled graphic. Every current call site sits inside something
 * that already names the app — the launcher's labeled button, a row or preview
 * with the name beside it — so each passes `decorative` rather than letting a
 * nested label repeat the identity next to it.
 */

import { Box, Image, Text, type BoxProps } from "@chakra-ui/react";
import { useState, type ReactNode } from "react";

import { appTileTint, resolveAppTileMark } from "@/shared/appTileMark";

export interface AppTileIconProps {
  name: string;
  iconUrl?: string | null;
  iconEmoji?: string | null;
  color?: string | null;
  /** Tile width/height. Defaults to filling the caller's cell. */
  boxSize?: BoxProps["w"];
  /** Optional cap for a fluid tile (the launcher grid). */
  maxBoxSize?: BoxProps["maxW"];
  /** Squircle rounding. */
  radius?: BoxProps["borderRadius"];
  boxShadow?: BoxProps["boxShadow"];
  /** CSS length driving the initial; an emoji renders at 1.35x this. */
  markFontSize?: string;
  /** Inset around an image mark, so a logo doesn't touch the tile edge. */
  imagePadding?: string;
  /** Overlay content drawn on top of the tile (e.g. a launching spinner). */
  children?: ReactNode;
  /** Apply the press-down scale when an ancestor `role="group"` is active. */
  interactive?: boolean;
  /**
   * Set when the element AROUND the mark already announces this app — the
   * launcher's labeled button, a catalog row whose name sits beside it, the
   * editor's live preview. The mark is then hidden from assistive tech,
   * because a labeled graphic inside an already-identified control either
   * repeats the app name or competes with the label that names it.
   */
  decorative?: boolean;
}

export function AppTileIcon({
  name,
  iconUrl,
  iconEmoji,
  color,
  boxSize = "100%",
  maxBoxSize,
  radius = "24%",
  boxShadow = "0 2px 5px rgba(20,24,50,0.12)",
  markFontSize = "1rem",
  imagePadding = "12%",
  children,
  interactive = false,
  decorative = false,
}: AppTileIconProps) {
  const [unusableImageSrc, setUnusableImageSrc] = useState<string | null>(null);
  const mark = resolveAppTileMark({
    iconUrl,
    emoji: iconEmoji,
    name,
    unusableImageSrc,
  });
  // A real logo gets a white tile to sit on (most are drawn for white); an
  // emoji or initial gets the app's tint, which is what makes a launcher of
  // un-iconed apps read as distinct tiles.
  const background = mark.kind === "image" ? "white" : appTileTint({ color, name });

  // The whole squircle is ONE image, whichever rung the chain landed on: a
  // logo, the emoji, and the initial all mean "this is <app>", so they are
  // announced identically instead of the emoji claiming its own image role and
  // the initial being read as a stray letter. Either way the marks inside stay
  // silent — the tile is what assistive tech sees, or nothing is.
  const accessibility = decorative
    ? ({ "aria-hidden": true } as const)
    : ({ role: "img", "aria-label": `${name} icon` } as const);

  return (
    <Box
      position="relative"
      w={boxSize}
      h={maxBoxSize ? undefined : boxSize}
      maxW={maxBoxSize}
      aspectRatio={maxBoxSize ? 1 : undefined}
      flexShrink={0}
      borderRadius={radius}
      overflow="hidden"
      bg={background}
      boxShadow={boxShadow}
      transition={interactive ? "transform 0.08s ease" : undefined}
      _groupActive={interactive ? { transform: "scale(0.94)" } : undefined}
      display="flex"
      alignItems="center"
      justifyContent="center"
      {...accessibility}
    >
      {mark.kind === "image" ? (
        <Image
          key={mark.src}
          src={mark.src}
          alt=""
          aria-hidden
          w="100%"
          h="100%"
          objectFit="contain"
          p={imagePadding}
          onError={() => setUnusableImageSrc(mark.src)}
        />
      ) : mark.kind === "emoji" ? (
        <Text
          as="span"
          aria-hidden
          lineHeight="1"
          fontSize={`calc(${markFontSize} * 1.35)`}
        >
          {mark.glyph}
        </Text>
      ) : (
        <Text
          fontFamily="heading"
          fontWeight="800"
          color="white"
          lineHeight="1"
          fontSize={markFontSize}
          aria-hidden
        >
          {mark.text}
        </Text>
      )}
      {children}
    </Box>
  );
}
