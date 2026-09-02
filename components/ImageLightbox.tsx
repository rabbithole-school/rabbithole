"use client";

import { Box, IconButton } from "@chakra-ui/react";
import { ShareNetwork, X } from "@phosphor-icons/react";

/**
 * Tap-to-zoom for chat images. Global pinch-zoom is disabled by design
 * (viewport user-scalable=no keeps the app layout rigid on touch), so
 * fullscreen IS the zoom: chat images render ~400px wide; this shows them
 * edge-to-edge. Tap anywhere to dismiss.
 */
export function ImageLightbox({
  src,
  alt,
  onClose,
}: {
  src: string;
  alt: string;
  onClose: () => void;
}) {
  return (
    <Box
      position="fixed"
      inset={0}
      zIndex={20000}
      bg="blackAlpha.900"
      display="flex"
      alignItems="center"
      justifyContent="center"
      onClick={onClose}
      cursor="zoom-out"
    >
      {/* eslint-disable-next-line @next/next/no-img-element -- dynamic remote image */}
      <img
        src={src}
        alt={alt}
        style={{ maxWidth: "100%", maxHeight: "100%", objectFit: "contain" }}
      />
      {/* Native share sheet (AirDrop / Save to Photos) where the Web Share
          API exists — WKWebView and mobile Safari have it; desktop hides. */}
      {typeof navigator !== "undefined" && "share" in navigator && (
        <IconButton
          aria-label="Share image"
          position="absolute"
          top={4}
          right={16}
          size="md"
          borderRadius="full"
          bg="whiteAlpha.300"
          color="white"
          _hover={{ bg: "whiteAlpha.500" }}
          onClick={async (e) => {
            e.stopPropagation();
            try {
              const blob = await (await fetch(src)).blob();
              const file = new File([blob], "rabbithole-image.png", { type: blob.type || "image/png" });
              await navigator.share({ files: [file] });
            } catch {
              // user cancelled or files unsupported — try a bare URL share
              try {
                await navigator.share({ url: src });
              } catch {
                /* cancelled */
              }
            }
          }}
        >
          <ShareNetwork size={20} />
        </IconButton>
      )}
      <IconButton
        aria-label="Close image"
        position="absolute"
        top={4}
        right={4}
        size="md"
        borderRadius="full"
        bg="whiteAlpha.300"
        color="white"
        _hover={{ bg: "whiteAlpha.500" }}
        onClick={onClose}
      >
        <X size={20} />
      </IconButton>
    </Box>
  );
}
