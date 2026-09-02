"use client";

/**
 * One Finder column. Header label at top + scrollable body below.
 * Each column owns its own vertical scroll — horizontally distinct
 * from siblings, so the mouse-wheel target is unambiguous (the way
 * Finder always handled it).
 */
import React from "react";
import { Box, Flex, HStack, Text } from "@chakra-ui/react";

export interface HierarchyColumnProps {
  header: string;
  /** Optional count badge in the header, e.g. "Units · 33". */
  count?: number;
  width?: string;
  /** Optional right-aligned content in the header (e.g. an Archive
   *  toggle, a sort button). */
  headerAction?: React.ReactNode;
  children: React.ReactNode;
  /** When true, skip rendering the column's own header strip — used
   *  when a wider, container-level header has absorbed the column's
   *  label + action (see CurriculumUnitsBrowser). */
  hideHeader?: boolean;
  /** Optional data-testid for Playwright hooks. */
  testId?: string;
  /** Let the body grow naturally instead of becoming its own scroll region. */
  fitContent?: boolean;
}

export function HierarchyColumn({
  header,
  count,
  width = "240px",
  headerAction,
  hideHeader = false,
  children,
  testId,
  fitContent = false,
}: HierarchyColumnProps) {
  return (
    <Flex
      direction="column"
      w={width}
      h={fitContent ? "auto" : "full"}
      minH={0}
      flexShrink={0}
      borderRight="1px solid"
      borderRightColor="gray.200"
      bg="white"
      data-testid={testId}
    >
      {!hideHeader && (
        <Flex
          px={3}
          py={2}
          borderBottom="1px solid"
          borderBottomColor="gray.100"
          bg="gray.50"
          align="center"
          justify="space-between"
          gap={2}
          flexShrink={0}
        >
          <HStack gap={2} minW={0}>
            <Text
              fontSize="2xs"
              color="charcoal.400"
              fontFamily="heading"
              fontWeight="700"
              textTransform="uppercase"
              letterSpacing="0.05em"
              overflow="hidden"
              textOverflow="ellipsis"
              whiteSpace="nowrap"
            >
              {header}
            </Text>
            {count !== undefined && (
              <Text
                fontSize="2xs"
                color="charcoal.300"
                fontFamily="heading"
                fontWeight="600"
              >
                {count}
              </Text>
            )}
          </HStack>
          {headerAction && <Box flexShrink={0}>{headerAction}</Box>}
        </Flex>
      )}
      <Box
        flex={fitContent ? "none" : 1}
        minH={0}
        overflowY={fitContent ? "visible" : "auto"}
        p={1.5}
      >
        {children}
      </Box>
    </Flex>
  );
}
