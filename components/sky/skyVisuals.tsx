"use client";

/**
 * skyVisuals — the shared visual language for every "star chart" surface.
 *
 * One source of truth for the look the Class Galaxy nailed (gentle colored
 * stars, soft glow, a quiet twinkle, labels that sit *just* under the dot) so
 * every surface that draws these primitives reads as the same sky. Its
 * importer today is `components/ConceptStarMap.tsx`. The big interactive maps —
 * the Concept Atlas and the entryway galaxy wall — are canvas-rendered by
 * `lib/atlasEngine.ts` instead and do NOT use this file. Keep layout /
 * interaction in the callers; this file owns only the pixels of a star, a hub,
 * the connecting lines, the palette, and the twinkle keyframes.
 */

import { Box, Image, Text } from "@chakra-ui/react";
import { useSkyZoom } from "./skyZoomContext";

// ── Palette ───────────────────────────────────────────────────────────
// Soft, slightly-varied star colors. The Galaxy uses one per scholar; a
// single scholar's sky uses one per domain so each region keeps its own hue.
export const SKY_PALETTE = [
  "#8b9cff", "#ffd479", "#7ee0c0", "#ff9ecb",
  "#c4a3ff", "#9be7ff", "#ffb38a", "#b6ff8a",
];

export const SKY_STAR_DEFAULT = "#e9e6ff";

/** Deterministic [0,1) hash so layout + twinkle timing are stable per render. */
export function hash01(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return ((h >>> 0) % 1000) / 1000;
}

/** Stable color from the palette for any key (a domain name, a scholarId…). */
export function colorForKey(key: string): string {
  return SKY_PALETTE[Math.floor(hash01("c" + key) * SKY_PALETTE.length) % SKY_PALETTE.length];
}

// ── Backgrounds ───────────────────────────────────────────────────────
export const SKY_BG =
  "radial-gradient(140% 120% at 25% 15%, #241c46 0%, #14102e 55%, #0a0818 100%)";

// ── Raster oversample factor ──────────────────────────────────────────
// A SkyZoomContext provider can scale this scene well past 1× (a pinch-zoom
// star map goes to MAX_SCALE 4×).
// A star dot / hub carries an infinite CSS animation + will-change, so the
// browser caches its compositor raster at layout size and never re-rasterizes
// at the new scale — magnified dots smear into mushy squares. Fix (ported from
// the atlas engine, lib/atlasEngine.ts ~L232): SUPERSAMPLE — render each dot
// RASTER× larger inside a wrapper counter-scaled by 1/RASTER (origin center),
// so the backing raster has RASTER× headroom before it blurs. RASTER matches
// MAX_SCALE, and 1/RASTER counter-scale makes the result pixel-identical at
// zoom 1.
const RASTER = 4;

// ── Twinkle / hub-glow keyframes ──────────────────────────────────────
// The hub glow is a box-shadow animation, so its blur/spread radii are
// pre-multiplied by RASTER (the hub renders RASTER× large + counter-scaled).
export const SKY_KEYFRAMES = `
@keyframes rhTwinkle {
  0%, 100% { opacity: .72; transform: scale(0.9); }
  50%      { opacity: 1;   transform: scale(1.18); }
}
@keyframes rhHubGlow {
  0%, 100% { box-shadow: 0 0 ${12 * RASTER}px ${2 * RASTER}px #fff6cf; }
  50%      { box-shadow: 0 0 ${20 * RASTER}px ${5 * RASTER}px #fff1b8; }
}
@media (prefers-reduced-motion: reduce) {
  .rh-star-dot, .rh-hub { animation: none !important; }
}
`;

/** Drop once near the top of any sky surface to register the keyframes. */
export function SkyKeyframes() {
  return <style dangerouslySetInnerHTML={{ __html: SKY_KEYFRAMES }} />;
}

// ── A single star (dot + soft glow + twinkle + label-under-the-dot) ───
// The dot is anchored *exactly* on (xPct,yPct); the label is absolutely
// placed beneath it, so a constellation line drawn to (xPct,yPct) meets the
// dot's center with no gap.
//
// LEVEL OF DETAIL: reads the live zoom from SkyZoomContext. `labelMinScale`
// gates the primary label (default 0 = always shown) and `detailMinScale`
// gates the scholar avatar + name tier (default ∞ = never) so detail only
// appears once you've zoomed in — like a map. With no SkyZoomContext provider
// — the case for every surface that renders these today — scale is 1, so base
// labels show and the detail tier stays hidden.
export function SkyStar({
  xPct,
  yPct,
  color = SKY_STAR_DEFAULT,
  size = 11,
  label,
  sublabel,
  dim = false,
  labelMaxW = 132,
  twinkleKey = "",
  zIndex = 4,
  hitPad = 0,
  faded = false,
  labelMinScale = 0,
  detailMinScale = Infinity,
  scholarName,
  avatarUrl,
  lit = false,
  detailNote,
  onClick,
  href,
  title,
  ariaLabel,
}: {
  xPct: number;
  yPct: number;
  color?: string;
  size?: number;
  label?: string;
  sublabel?: string;
  dim?: boolean;
  labelMaxW?: number;
  twinkleKey?: string;
  zIndex?: number;
  hitPad?: number;
  faded?: boolean;
  labelMinScale?: number;
  detailMinScale?: number;
  scholarName?: string;
  avatarUrl?: string | null;
  /** A "remembered" star the scholar has already explored — render it steady
   *  and warm-haloed (vs a twinkling frontier suggestion). */
  lit?: boolean;
  /** Small note revealed in the zoom detail tier (e.g. "✦ explored · 2d ago"). */
  detailNote?: string;
  onClick?: (e: React.MouseEvent) => void;
  href?: string;
  title?: string;
  ariaLabel?: string;
}) {
  const { scale, didMove } = useSkyZoom();
  const delay = (hash01("d" + twinkleKey) * 3).toFixed(2);
  // Lit (remembered) stars breathe slowly + steadily; frontier stars twinkle.
  const dur = (lit ? 4.4 + hash01("u" + twinkleKey) * 2 : 2.6 + hash01("u" + twinkleKey) * 2).toFixed(2);
  const interactive = !!(onClick || href);

  const showLabel = !!label && scale >= labelMinScale;
  const showDetail = (!!scholarName || !!detailNote) && scale >= detailMinScale;

  const dot = (
    <Box position="relative" w={`${size}px`} h={`${size}px`} mx="auto">
      {/* Raster-oversample wrapper: the dot visuals are laid out RASTER× larger
          and counter-scaled back down here (origin center), so the animated
          inner element's compositor raster has RASTER× headroom and stays crisp
          under deep pinch-zoom. Pixel-identical at zoom 1. */}
      <Box
        position="absolute"
        top="50%"
        left="50%"
        w={`${size * RASTER}px`}
        h={`${size * RASTER}px`}
        css={{
          transform: `translate(-50%, -50%) scale(${1 / RASTER})`,
          transformOrigin: "center",
        }}
      >
        {lit && (
          <Box
            position="absolute"
            inset={`${-7 * RASTER}px`}
            borderRadius="full"
            pointerEvents="none"
            css={{
              background: `radial-gradient(circle, ${color}33 0%, transparent 70%)`,
              boxShadow: `inset 0 0 0 ${1 * RASTER}px ${color}66`,
            }}
          />
        )}
        <Box
          className="rh-star-dot"
          position="absolute"
          inset={0}
          borderRadius="full"
          bg={lit ? "#fff" : color}
          opacity={dim ? 0.5 : 1}
          css={{
            boxShadow: dim
              ? `0 0 ${5 * RASTER}px ${color}`
              : lit
              ? `0 0 ${12 * RASTER}px ${2 * RASTER}px ${color}, 0 0 ${4 * RASTER}px ${1 * RASTER}px #fff`
              : `0 0 ${9 * RASTER}px ${1 * RASTER}px ${color}`,
            animation: `rhTwinkle ${dur}s ease-in-out ${delay}s infinite`,
            willChange: "transform, opacity",
          }}
        />
      </Box>
      {(showLabel || showDetail) && (
        <Box
          position="absolute"
          top="100%"
          left="50%"
          mt="5px"
          w={`${labelMaxW}px`}
          textAlign="center"
          pointerEvents="none"
          // Counter-scale by 1/zoom so the label keeps a FIXED screen size as
          // the map zooms (the dot + positions still scale). Anchored at its
          // top-center, just under the dot, so it tracks the star.
          style={{
            transform: `translateX(-50%) scale(${1 / scale})`,
            transformOrigin: "top center",
          }}
        >
          {showLabel && (
            <Text
              fontSize="11px"
              fontFamily="heading"
              color="#e7e2ff"
              lineHeight="1.2"
              lineClamp={2}
              css={{ textShadow: "0 1px 4px #000, 0 0 8px #000" }}
            >
              {label}
            </Text>
          )}
          {sublabel && showLabel && (
            <Text fontSize="9px" color="purple.200" mt="1px" fontWeight="600">
              {sublabel}
            </Text>
          )}
          {showDetail && scholarName && (
            <Box
              display="inline-flex"
              alignItems="center"
              gap="4px"
              mt="3px"
              bg="#0008"
              borderRadius="full"
              px="6px"
              py="2px"
            >
              {avatarUrl ? (
                <Image
                  src={avatarUrl}
                  alt={scholarName}
                  boxSize="14px"
                  borderRadius="full"
                  objectFit="cover"
                />
              ) : (
                <Box
                  boxSize="14px"
                  borderRadius="full"
                  bg={color}
                  display="flex"
                  alignItems="center"
                  justifyContent="center"
                  fontSize="8px"
                  fontWeight="700"
                  color="#1a1430"
                >
                  {(scholarName?.trim()[0] ?? "?").toUpperCase()}
                </Box>
              )}
              <Text fontSize="9px" color="#d9d2ff" fontWeight="600" whiteSpace="nowrap">
                {scholarName}
              </Text>
            </Box>
          )}
          {showDetail && detailNote && (
            <Box
              display="inline-block"
              mt="3px"
              bg="#0008"
              borderRadius="full"
              px="7px"
              py="2px"
            >
              <Text fontSize="9px" color="#ffe9b0" fontWeight="700" whiteSpace="nowrap">
                {detailNote}
              </Text>
            </Box>
          )}
        </Box>
      )}
    </Box>
  );

  const common = {
    position: "absolute" as const,
    left: `${xPct}%`,
    top: `${yPct}%`,
    transform: "translate(-50%,-50%)",
    zIndex,
    title,
    opacity: faded ? 0.4 : 1,
    transition: "opacity 0.15s",
  };

  if (!interactive) {
    return (
      <Box {...common} pointerEvents="none">
        {dot}
      </Box>
    );
  }

  // A pan/pinch that happens to end on a star must NOT count as a tap — guard
  // both onClick handlers and href navigation with the viewport's didMove().
  const guardedClick = (e: React.MouseEvent) => {
    if (didMove()) {
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    onClick?.(e);
  };

  return (
    <Box
      {...common}
      as={href ? "a" : "button"}
      {...(href ? { href } : {})}
      onClick={guardedClick}
      aria-label={ariaLabel ?? label}
      p={`${hitPad}px`}
      cursor="pointer"
      display="block"
      bg="transparent"
      borderWidth={0}
      css={{ touchAction: "manipulation", WebkitTapHighlightColor: "transparent" }}
    >
      {dot}
    </Box>
  );
}

// ── The bright central / convergence hub ──────────────────────────────
export function SkyHub({
  xPct,
  yPct,
  size = 16,
  label,
  sublabel,
  zIndex = 2,
}: {
  xPct: number;
  yPct: number;
  size?: number;
  label?: string;
  sublabel?: string;
  zIndex?: number;
}) {
  const { scale } = useSkyZoom();
  return (
    <>
      {/* Raster-oversample wrapper (see SkyStar): the hub + its always-animating
          glow render RASTER× large and counter-scale down (origin center), so
          the glow's compositor raster stays crisp under pinch-zoom.
          Pixel-identical at zoom 1. */}
      <Box
        position="absolute"
        left={`${xPct}%`}
        top={`${yPct}%`}
        w={`${size * RASTER}px`}
        h={`${size * RASTER}px`}
        css={{
          transform: `translate(-50%, -50%) scale(${1 / RASTER})`,
          transformOrigin: "center",
          pointerEvents: "none",
        }}
        zIndex={zIndex}
      >
        <Box
          position="absolute"
          inset={0}
          borderRadius="full"
          bg="#fff7d6"
          className="rh-hub"
          css={{
            boxShadow: `0 0 ${14 * RASTER}px ${3 * RASTER}px #fff6cf`,
            animation: "rhHubGlow 3.2s ease-in-out infinite",
          }}
        />
      </Box>
      {label && (
        <Box
          position="absolute"
          left={`${xPct}%`}
          top={`calc(${yPct}% + ${size / 2 + 8}px)`}
          maxW="200px"
          textAlign="center"
          zIndex={zIndex + 1}
          pointerEvents="none"
          style={{
            transform: `translateX(-50%) scale(${1 / scale})`,
            transformOrigin: "top center",
          }}
        >
          <Text
            fontSize="12px"
            fontFamily="heading"
            fontWeight="700"
            color="#efeaff"
            lineHeight="1.2"
            css={{ textShadow: "0 1px 6px #000, 0 0 10px #000" }}
          >
            {label}
          </Text>
          {sublabel && (
            <Text fontSize="10px" color="purple.200" mt="2px" fontWeight="600">
              {sublabel}
            </Text>
          )}
        </Box>
      )}
    </>
  );
}

// ── Constellation lines (SVG in a 0..100 viewBox, stretched to the box) ──
// A line may be flagged `lit` (a path the scholar has actually walked) — it
// renders warmer + brighter than a faint frontier suggestion line.
export function ConstellationLines({
  lines,
  stroke = "#9a86d6",
  width = 0.2,
  opacity = 0.5,
  litStroke = "#ffe3a8",
}: {
  lines: { key: string; x1: number; y1: number; x2: number; y2: number; lit?: boolean }[];
  stroke?: string;
  width?: number;
  opacity?: number;
  litStroke?: string;
}) {
  return (
    <Box
      as="svg"
      position="absolute"
      inset={0}
      width="100%"
      height="100%"
      // @ts-expect-error chakra svg passthrough
      viewBox="0 0 100 100"
      preserveAspectRatio="none"
      style={{ pointerEvents: "none" }}
    >
      {lines.map((l) => (
        <line
          key={l.key}
          x1={l.x1}
          y1={l.y1}
          x2={l.x2}
          y2={l.y2}
          stroke={l.lit ? litStroke : stroke}
          strokeWidth={l.lit ? width * 1.6 : width}
          opacity={l.lit ? Math.min(1, opacity + 0.3) : opacity}
        />
      ))}
    </Box>
  );
}

