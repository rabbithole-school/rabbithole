"use client";

import { HStack, Text } from "@chakra-ui/react";

interface AppLogoProps {
  /** "light" for dark backgrounds (white text), "dark" for light backgrounds (navy text) */
  variant?: "light" | "dark";
  /** Logo image size in px (default 40) */
  size?: number;
}

export function AppLogo({ variant = "dark", size = 40 }: AppLogoProps) {
  const textColor = variant === "light" ? "gray.100" : "gray.800";

  return (
    <HStack gap={1} aria-label="Rabbithole" userSelect="none">
      <Text
        as="span"
        color={textColor}
        fontSize={`${size * 0.7}px`}
        lineHeight="1"
        display="inline-block"
        transform="scaleX(-1)"
      >
        🐇
      </Text>
      <Text
        as="span"
        color={textColor}
        fontSize={`${size * 0.7}px`}
        lineHeight="1"
      >
        🕳️
      </Text>
    </HStack>
  );
}
