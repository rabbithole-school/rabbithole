"use client";

/**
 * StudioControlBar — the shared control-bar shell for the Math Skills studio's
 * two lenses (stage 2 skeleton convergence, mock 4). Both lenses render this
 * SAME strip directly under the studio header band, at the SAME
 * COLUMN_HEADER_HEIGHT geometry, so toggling Mastery ⟷ Content swaps the bar's
 * CONTENTS (mastery bands + filters ⟷ type/coverage chips) rather than the
 * whole page frame — the toggle stops feeling like a page swap.
 *
 * It owns only the frame (height, bottom rule, padding, flex); each lens passes
 * its own controls as children. Purely presentational — no lens state leaks in.
 */

import { Flex } from "@chakra-ui/react";
import type { ReactNode } from "react";
import { COLUMN_HEADER_HEIGHT } from "@/components/hierarchy";

export function StudioControlBar({
  children,
  testId,
}: {
  children: ReactNode;
  testId?: string;
}) {
  return (
    <Flex
      minH={COLUMN_HEADER_HEIGHT}
      px={{ base: 3, md: 4 }}
      py={2}
      align="center"
      gap={3}
      borderBottomWidth="1px"
      borderColor="gray.100"
      bg="white"
      flexShrink={0}
      data-testid={testId}
    >
      {children}
    </Flex>
  );
}
