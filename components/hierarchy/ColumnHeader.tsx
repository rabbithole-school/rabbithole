"use client";

/**
 * One slim column header row shared by Curriculum chrome. The row keeps
 * actions aligned without adding a heavy bordered header band.
 */
import React from "react";
import { Box, Flex, HStack, Text } from "@chakra-ui/react";

/** Shared height for Curriculum's slim chrome/header rows. */
export const COLUMN_HEADER_HEIGHT = "52px";

export interface ColumnHeaderProps {
  /** Uppercase column label, e.g. "Units". Ignored if `children` is set. */
  label?: string;
  /** Optional count badge after the label, e.g. Units · 33. */
  count?: number;
  /** Left-aligned slot before the label — e.g. a collapse/expand chevron. */
  leading?: React.ReactNode;
  /** Right-aligned slot — e.g. a Filter trigger. */
  action?: React.ReactNode;
  /** Fully custom header content (e.g. a tab strip). Replaces label/action,
   *  but still sits in the shared-height band. */
  children?: React.ReactNode;
  /** Header background. Defaults to white. */
  bg?: string;
  /** Remove horizontal padding (a tab strip manages its own). */
  flush?: boolean;
  /** Draw the old hard rule when a header needs to separate from content. */
  borderBottom?: boolean;
}

export function ColumnHeader({
  label,
  count,
  leading,
  action,
  children,
  bg = "white",
  flush = false,
  borderBottom = false,
}: ColumnHeaderProps) {
  return (
    <Flex
      h={COLUMN_HEADER_HEIGHT}
      minH={COLUMN_HEADER_HEIGHT}
      flexShrink={0}
      align="center"
      gap={1}
      px={flush ? 0 : 3}
      borderBottom={borderBottom ? "1px solid" : "0"}
      borderColor="gray.200"
      bg={bg}
      userSelect="none"
    >
      {children ?? (
        <>
          {leading}
          <HStack gap={2} minW={0} flex={1}>
            <Text
              fontSize="2xs"
              color="charcoal.300"
              fontFamily="heading"
              fontWeight="700"
              textTransform="uppercase"
              letterSpacing="0.07em"
              overflow="hidden"
              textOverflow="ellipsis"
              whiteSpace="nowrap"
            >
              {label}
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
          {action && <Box flexShrink={0}>{action}</Box>}
        </>
      )}
    </Flex>
  );
}
