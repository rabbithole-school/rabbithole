"use client";

import { Box } from "@chakra-ui/react";

interface AppLogoProps {
  /** Kept for call-site compatibility. The mark is a full-colour image now, so
   *  it reads on either ground and the variant no longer changes anything. */
  variant?: "light" | "dark";
  /** Logo size in px (default 40) */
  size?: number;
}

/**
 * The Rabbithole mark: the astronaut-rabbit artwork, squircle-cropped.
 *
 * It used to be two emoji (🐇 + 🕳️) side by side, which rendered differently
 * on every platform and read as a placeholder next to real artwork. One image
 * here updates every surface that shows the mark.
 */
export function AppLogo({ size = 40 }: AppLogoProps) {
  return (
    <Box
      w={`${size}px`}
      h={`${size}px`}
      flexShrink={0}
      borderRadius="28%"
      overflow="hidden"
      backgroundImage="url('/rh-logo.png')"
      backgroundSize="cover"
      backgroundPosition="center"
      userSelect="none"
      role="img"
      aria-label="Rabbithole"
    />
  );
}
