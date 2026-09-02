"use client";

/**
 * Strand section header — "CORE", "CONNECTIONS", "PRACTICE",
 * "IDENTITY". Rendered identically in column view (between rows in
 * the Lessons column) and outline view (above each strand's lessons
 * in the design screen). The visual consistency is half of what
 * makes the two layouts feel like the same family.
 *
 * Optional inline "+ Lesson" action for the outline / browser
 * surfaces that own creation at this level.
 */
import React from "react";
import { Box, Flex, HStack, Text } from "@chakra-ui/react";
import { Plus } from "@phosphor-icons/react";

export interface StrandDividerProps {
  label: string;
  emoji?: string;
  count?: number;
  /** Optional "+ Lesson" affordance shown on the right. */
  onCreate?: () => void;
  createLabel?: string;
  /** Outline view indents the divider a touch to line up with the
   *  lesson rows beneath it. */
  indent?: number;
  testId?: string;
}

export function StrandDivider({
  label,
  emoji,
  count,
  onCreate,
  createLabel = "+ Lesson",
  indent = 0,
  testId,
}: StrandDividerProps) {
  return (
    <Flex
      align="center"
      justify="space-between"
      gap={2}
      pl={2 + indent * 3}
      pr={2}
      py={1.5}
      userSelect="none"
      data-testid={testId}
    >
      <HStack gap={1} minW={0}>
        {emoji && (
          <Box
            w="16px"
            flexShrink={0}
            display="flex"
            alignItems="center"
            justifyContent="center"
          >
            <Text fontSize="xs" lineHeight="1">
              {emoji}
            </Text>
          </Box>
        )}
        <Text
          fontSize="2xs"
          color="charcoal.300"
          fontFamily="heading"
          fontWeight="700"
          textTransform="uppercase"
          letterSpacing="0.11em"
          lineHeight="1.2"
        >
          {label}
        </Text>
        {count !== undefined && count > 0 && (
          <Text
            fontSize="2xs"
            color="gray.400"
            fontFamily="heading"
            fontWeight="700"
            lineHeight="1.2"
          >
            {count}
          </Text>
        )}
      </HStack>
      {onCreate && (
        <Box
          as="button"
          onClick={onCreate}
          fontSize="2xs"
          color="violet.500"
          fontFamily="heading"
          fontWeight="600"
          cursor="pointer"
          _hover={{ color: "violet.700" }}
          display="flex"
          alignItems="center"
          gap={1}
          flexShrink={0}
        >
          <Plus size={10} />
          {createLabel}
        </Box>
      )}
    </Flex>
  );
}
