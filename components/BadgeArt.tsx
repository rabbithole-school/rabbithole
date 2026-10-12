"use client";

/**
 * BadgeArt — the shared renderer for a quest badge's generative artwork.
 *
 * Shows the stored image once it's ready. While the art is generating it
 * overlays a spinner + dims the image so a remix visibly "does something"
 * even though the previous image is still on screen (gen art is slow).
 * With no image yet it shows a spinner alone on a soft shimmering disc while
 * the first mint is in flight — never the emoji with a spinner on top of it —
 * and falls back to the badge emoji otherwise. Reused by the Trophy Case, the
 * scholar profile, and the celebration.
 *
 * A Calculator License badge (`kind`) is the exception: its image is the
 * license card itself, so it renders as a landscape ID card (LicenseCardArt
 * below), never as a square/round medallion.
 */

import { Box, Image, Spinner, Text } from "@chakra-ui/react";
import {
  isLicenseCardBadge,
  LICENSE_CARD_ASPECT,
  LICENSE_CARD_CORNER_RATIO,
} from "@/shared/calculatorLicense";

export type BadgeArtStatus = "generating" | "ready" | "failed";

export function BadgeArt({
  imageUrl,
  emoji,
  status = "ready",
  size = "80px",
  alt,
  rounded = "2xl",
  showGeneratingOverlay = true,
  kind,
}: {
  imageUrl?: string | null;
  emoji?: string | null;
  status?: BadgeArtStatus;
  /** The art's side — or, for a license card, its WIDTH (height follows). */
  size?: string | number;
  alt?: string;
  rounded?: string;
  /** Overlay a spinner when status is "generating" (set false for tiny
   *  thumbnails where the overlay would be noise). */
  showGeneratingOverlay?: boolean;
  /** The badge row's `kind`. A Calculator License badge's image is the
   *  license card, drawn at its own landscape aspect like a physical ID. */
  kind?: string | null;
}) {
  const generating = status === "generating";
  const sizeStr = typeof size === "number" ? `${size}px` : size;

  if (isLicenseCardBadge(kind)) {
    return (
      <LicenseCardArt
        imageUrl={imageUrl}
        emoji={emoji}
        generating={generating}
        width={sizeStr}
        alt={alt}
        showGeneratingOverlay={showGeneratingOverlay}
      />
    );
  }

  if (imageUrl) {
    return (
      <Box position="relative" boxSize={size} flexShrink={0}>
        <Image
          src={imageUrl}
          alt={alt ?? "Quest badge"}
          boxSize={size}
          rounded={rounded}
          objectFit="cover"
          opacity={generating ? 0.7 : 1}
          transition="opacity .2s"
        />
        {generating && showGeneratingOverlay && (
          <Box
            position="absolute"
            inset="0"
            rounded={rounded}
            bg="blackAlpha.500"
            display="flex"
            alignItems="center"
            justifyContent="center"
          >
            <Spinner color="#f4c44c" borderWidth="3px" size="md" />
          </Box>
        )}
      </Box>
    );
  }

  return (
    <Box
      position="relative"
      boxSize={size}
      rounded={rounded}
      flexShrink={0}
      display="flex"
      alignItems="center"
      justifyContent="center"
      bg="whiteAlpha.150"
      borderWidth="1px"
      borderColor="whiteAlpha.300"
      overflow="hidden"
      css={
        generating
          ? {
              background:
                "linear-gradient(110deg, rgba(255,255,255,.06) 30%, rgba(255,255,255,.18) 50%, rgba(255,255,255,.06) 70%)",
              backgroundSize: "200% 100%",
              animation: "badgeShimmer 1.4s ease-in-out infinite",
              "@keyframes badgeShimmer": {
                "0%": { backgroundPosition: "200% 0" },
                "100%": { backgroundPosition: "-200% 0" },
              },
            }
          : undefined
      }
    >
      {generating && showGeneratingOverlay ? (
        <Spinner
          color="#f4c44c"
          boxSize={`calc(${sizeStr} * 0.3)`}
          borderWidth={`clamp(2px, calc(${sizeStr} * 0.03), 6px)`}
        />
      ) : (
        <Text fontSize={`calc(${sizeStr} * 0.5)`} lineHeight="1">
          {emoji ?? "🏅"}
        </Text>
      )}
    </Box>
  );
}

/**
 * A Calculator License badge: the license card PNG at its own ID-1 aspect,
 * framed like a physical card (rounded corners matching the PNG's own, a soft
 * drop shadow) — never cropped into the square/circle a medallion gets.
 * Before the first render lands it holds the card's shape with a shimmer, so
 * the layout doesn't jump when the image arrives.
 */
function LicenseCardArt({
  imageUrl,
  emoji,
  generating,
  width,
  alt,
  showGeneratingOverlay,
}: {
  imageUrl?: string | null;
  emoji?: string | null;
  generating: boolean;
  width: string;
  alt?: string;
  showGeneratingOverlay: boolean;
}) {
  const radius = `calc(${width} * ${LICENSE_CARD_CORNER_RATIO})`;
  return (
    <Box
      position="relative"
      w={width}
      maxW="100%"
      aspectRatio={LICENSE_CARD_ASPECT}
      flexShrink={0}
      borderRadius={radius}
      boxShadow="0 1px 2px rgba(16, 27, 68, 0.2), 0 8px 20px rgba(16, 27, 68, 0.18)"
      display="flex"
      alignItems="center"
      justifyContent="center"
      bg={imageUrl ? undefined : "#faf7ed"}
      css={
        !imageUrl && generating
          ? {
              backgroundImage:
                "linear-gradient(110deg, rgba(16,27,68,.04) 30%, rgba(16,27,68,.12) 50%, rgba(16,27,68,.04) 70%)",
              backgroundSize: "200% 100%",
              animation: "licenseShimmer 1.4s ease-in-out infinite",
              "@keyframes licenseShimmer": {
                "0%": { backgroundPosition: "200% 0" },
                "100%": { backgroundPosition: "-200% 0" },
              },
            }
          : undefined
      }
    >
      {imageUrl ? (
        <Image
          src={imageUrl}
          alt={alt ?? "Calculator license"}
          w="100%"
          h="100%"
          objectFit="contain"
          borderRadius={radius}
          opacity={generating ? 0.7 : 1}
          transition="opacity .2s"
        />
      ) : generating && showGeneratingOverlay ? (
        <Spinner color="#c99a2e" borderWidth="3px" size="md" />
      ) : !generating ? (
        <Text fontSize={`calc(${width} * 0.2)`} lineHeight="1">
          {emoji ?? "🧮"}
        </Text>
      ) : null}
      {imageUrl && generating && showGeneratingOverlay && (
        <Box
          position="absolute"
          inset="0"
          borderRadius={radius}
          bg="blackAlpha.400"
          display="flex"
          alignItems="center"
          justifyContent="center"
        >
          <Spinner color="#f4c44c" borderWidth="3px" size="md" />
        </Box>
      )}
    </Box>
  );
}
