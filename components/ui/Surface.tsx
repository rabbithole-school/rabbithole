"use client";

/**
 * Surface — the standard "white card on gray.50 shoulder" panel.
 *
 *   <Surface>                          // default: gray.200 border
 *   <Surface variant="emphasis">       // violet.500 border (active focus)
 *
 * Encapsulates: bg="white" borderWidth="1px" borderRadius="lg"
 * shadow="xs". Replaces the manual Box mixes documented in
 * review/visual-harmonization.md §A2/A3.
 *
 * Forwards any extra Box props (p, gap, etc.) — wrapper is thin.
 */
import { Box, type BoxProps } from "@chakra-ui/react";

export interface SurfaceProps extends Omit<BoxProps, "bg" | "borderColor" | "borderWidth" | "borderRadius" | "shadow"> {
  variant?: "default" | "emphasis";
}

export function Surface({
  variant = "default",
  children,
  ...rest
}: SurfaceProps) {
  const borderColor = variant === "emphasis" ? "violet.500" : "gray.200";
  return (
    <Box
      bg="white"
      borderWidth="1px"
      borderColor={borderColor}
      borderRadius="lg"
      shadow="xs"
      {...rest}
    >
      {children}
    </Box>
  );
}
