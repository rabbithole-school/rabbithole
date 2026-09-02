"use client";

/**
 * Placeholder for the leading-emoji slot in HierarchyRow when an
 * entity has no emoji set. Renders a small dashed rounded square
 * sized to match a 16px emoji glyph, so titles stay vertically
 * aligned across mixed-with/without-emoji rows. Keeps the visual
 * gridlines stable.
 */
import { Box } from "@chakra-ui/react";

export function EmojiPlaceholder() {
  return (
    <Box
      w="16px"
      h="16px"
      borderWidth="1px"
      borderStyle="dashed"
      borderColor="gray.300"
      borderRadius="sm"
      flexShrink={0}
    />
  );
}
