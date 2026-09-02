"use client";

/**
 * PageHeader — the canonical "what am I looking at" header at the top
 * of a tab/panel. Replaces the six different `<Heading>` /
 * `<Text fontFamily="heading">` treatments documented in
 * review/visual-harmonization.md §B1/B3.
 *
 * Title is always `<Text fontFamily="heading" fontWeight="700"
 * fontSize="xl" color="navy.500">` so size is literal and grep-able.
 *
 *   <PageHeader title="Independent study" />
 *   <PageHeader eyebrow="New IS Unit for Kai" title="What's it about?" />
 *   <PageHeader title="Multiplication Models" subtitle="9 lessons · 24 activities"
 *               rightSlot={<Button>Edit</Button>} />
 */
import { Box, Flex, HStack, Stack, Text } from "@chakra-ui/react";
import { SectionEyebrow } from "./SectionEyebrow";

export interface PageHeaderProps {
  title: React.ReactNode;
  /** Smallcaps label sitting above the title. */
  eyebrow?: string;
  /** Subtitle / metadata row sitting below the title (description,
   *  stats strip, etc.). Pass a string or a React node. */
  subtitle?: React.ReactNode;
  /** Optional emoji or icon rendered to the left of the title block. */
  leading?: React.ReactNode;
  /** Right-aligned area, typically a CTA button. */
  rightSlot?: React.ReactNode;
}

export function PageHeader({
  title,
  eyebrow,
  subtitle,
  leading,
  rightSlot,
}: PageHeaderProps) {
  return (
    <Flex justify="space-between" align="flex-start" gap={4} userSelect="none">
      <HStack gap={3} align="flex-start" flex={1} minW={0}>
        {leading && (
          <Box flexShrink={0} fontSize="2xl" lineHeight="1">
            {leading}
          </Box>
        )}
        <Stack gap={1} minW={0}>
          {eyebrow && <SectionEyebrow>{eyebrow}</SectionEyebrow>}
          <Text
            fontFamily="heading"
            fontWeight="700"
            fontSize="xl"
            color="navy.500"
            lineHeight="1.2"
          >
            {title}
          </Text>
          {subtitle &&
            (typeof subtitle === "string" ? (
              <Text fontSize="sm" color="charcoal.500" fontFamily="body">
                {subtitle}
              </Text>
            ) : (
              subtitle
            ))}
        </Stack>
      </HStack>
      {rightSlot && <Box flexShrink={0}>{rightSlot}</Box>}
    </Flex>
  );
}
