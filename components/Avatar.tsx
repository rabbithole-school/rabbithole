"use client";

import { Box, Text } from "@chakra-ui/react";

interface AvatarProps {
  name?: string;
  src?: string;
  size?: "2xs" | "xs" | "sm" | "md" | "lg" | "xl";
  /**
   * Stable color-hash seed. Pass the AVATAR SUBJECT's userId (the Convex
   * `users._id`) so every surface renders the SAME color for a given user —
   * name/username seeds are NOT stable across call sites and must not be used.
   * Falls back to `name` only when an id is genuinely unavailable.
   */
  colorKey?: string;
}

const sizeMap = {
  "2xs": { container: 4.5, text: "2xs" },
  xs: { container: 6, text: "xs" },
  sm: { container: 8, text: "sm" },
  md: { container: 12, text: "lg" },
  lg: { container: 16, text: "xl" },
  xl: { container: 28, text: "4xl" },
};

export function Avatar({ name, src, size = "md", colorKey }: AvatarProps) {
  const dimensions = sizeMap[size];

  // Get initials from name
  const initials = name
    ? name
        .split(" ")
        .map((n) => n[0])
        .join("")
        .toUpperCase()
        .slice(0, 2)
    : "?";

  // Generate a consistent color based on name
  const colors = [
    "violet.500",
    "cyan.500",
    "orange.500",
    "green.500",
    "navy.500",
  ];
  const hashSource = colorKey || name;
  const colorIndex = hashSource
    ? hashSource.split("").reduce((acc, char) => acc + char.charCodeAt(0), 0) %
      colors.length
    : 0;

  if (src) {
    return (
      <Box
        w={dimensions.container}
        h={dimensions.container}
        borderRadius="full"
        overflow="hidden"
        flexShrink={0}
      >
        {/* eslint-disable-next-line @next/next/no-img-element -- remote/dynamic avatar src; next/image needs per-domain config */}
        <img
          src={src}
          alt={name || "Avatar"}
          style={{
            width: "100%",
            height: "100%",
            objectFit: "cover",
          }}
        />
      </Box>
    );
  }

  return (
    <Box
      w={dimensions.container}
      h={dimensions.container}
      borderRadius="full"
      bg={colors[colorIndex]}
      display="flex"
      alignItems="center"
      justifyContent="center"
      flexShrink={0}
    >
      <Text
        color="white"
        fontWeight="600"
        fontFamily="heading"
        fontSize={dimensions.text}
      >
        {initials}
      </Text>
    </Box>
  );
}
