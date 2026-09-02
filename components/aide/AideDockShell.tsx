"use client";

import { Flex } from "@chakra-ui/react";

/**
 * The shared aide-dock frame — the docked right chat panel's geometry (width,
 * border, background), rendered as a flex SIBLING of the page body so opening
 * it PUSHES the content rather than covering it. One shell for every portal
 * that docks the aide (the teacher <AideDock>, the parent <ParentAideDock>),
 * so the panel can't drift between them.
 *
 * On phones (below `sm`) the dock takes the full row width — the body
 * squeezes away and the chat becomes the screen; the app header stays
 * reachable to toggle it shut, and the dock header carries its own close.
 */
export function AideDockShell({ children }: { children: React.ReactNode }) {
  return (
    <Flex
      data-testid="aide-dock"
      direction="column"
      w={{ base: "full", sm: "360px", xl: "400px" }}
      flexShrink={0}
      h="full"
      overflow="hidden"
      borderLeft="1px solid"
      borderColor="gray.200"
      bg="white"
    >
      {children}
    </Flex>
  );
}
