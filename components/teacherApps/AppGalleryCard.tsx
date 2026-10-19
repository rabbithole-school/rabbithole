"use client";

/**
 * One app card for the teacher Apps galleries — the Custom tab and the "Built
 * by scholars" page (review/teacher-apps-v2-sketch.html §2–3). The image is
 * the app's real screenshot when one was captured, otherwise a name-and-emoji
 * tile; archived cards go grey. The caller owns everything below the image.
 */

import type { ReactNode } from "react";
import { Box, Flex, Image, Stack, Text } from "@chakra-ui/react";
import { AppTileIcon } from "@/components/ui/AppTileIcon";

export function AppGalleryCard({
  name,
  screenshotUrl,
  iconUrl,
  iconEmoji,
  color,
  archived = false,
  overlay,
  children,
  actions,
}: {
  name: string;
  screenshotUrl?: string | null;
  iconUrl?: string | null;
  iconEmoji?: string | null;
  color?: string | null;
  archived?: boolean;
  /** Pinned to the image's top-left corner (the timed-access chip). */
  overlay?: ReactNode;
  children: ReactNode;
  actions: ReactNode;
}) {
  return (
    <Flex
      direction="column"
      bg="white"
      borderWidth="1px"
      borderColor="gray.200"
      borderRadius="xl"
      overflow="hidden"
    >
      <Box
        position="relative"
        h="128px"
        bg="gray.50"
        borderBottomWidth="1px"
        borderColor="gray.100"
      >
        <Flex
          h="full"
          align="center"
          justify="center"
          filter={archived ? "grayscale(0.85)" : undefined}
          opacity={archived ? 0.55 : 1}
        >
          {screenshotUrl ? (
            <Image
              src={screenshotUrl}
              alt=""
              w="full"
              h="full"
              objectFit="cover"
              objectPosition="top"
            />
          ) : (
            <AppTileIcon
              name={name}
              iconUrl={iconUrl}
              iconEmoji={iconEmoji}
              color={color}
              boxSize="64px"
              radius="16px"
              markFontSize="28px"
              imagePadding="10px"
              decorative
            />
          )}
        </Flex>
        {overlay && (
          <Box position="absolute" left={2} top={2}>
            {overlay}
          </Box>
        )}
      </Box>
      <Stack gap={1} px={3} pt={2.5} pb={3} flex={1}>
        <Text
          fontSize="sm"
          fontFamily="heading"
          fontWeight="700"
          color={archived ? "charcoal.400" : "charcoal.500"}
          lineClamp={1}
        >
          {name}
        </Text>
        {children}
        <Flex gap={1.5} mt="auto" pt={2} wrap="wrap">
          {actions}
        </Flex>
      </Stack>
    </Flex>
  );
}
