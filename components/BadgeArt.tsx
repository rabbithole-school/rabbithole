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
 */

import { Box, Image, Spinner, Text } from "@chakra-ui/react";

export type BadgeArtStatus = "generating" | "ready" | "failed";

export function BadgeArt({
  imageUrl,
  emoji,
  status = "ready",
  size = "80px",
  alt,
  rounded = "2xl",
  showGeneratingOverlay = true,
}: {
  imageUrl?: string | null;
  emoji?: string | null;
  status?: BadgeArtStatus;
  size?: string | number;
  alt?: string;
  rounded?: string;
  /** Overlay a spinner when status is "generating" (set false for tiny
   *  thumbnails where the overlay would be noise). */
  showGeneratingOverlay?: boolean;
}) {
  const generating = status === "generating";
  const sizeStr = typeof size === "number" ? `${size}px` : size;

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
