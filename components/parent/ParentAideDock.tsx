"use client";

import { Box, Flex, IconButton, Text } from "@chakra-ui/react";
import { X } from "@phosphor-icons/react";
import { AideDockShell } from "@/components/aide/AideDockShell";
import { useAideDock } from "@/components/aide/AideDockProvider";
import { ParentChat } from "@/components/ParentChat";

/**
 * The parent portal's docked aide — the SAME placement + frame as the teacher
 * dashboard's <AideDock> (shared <AideDockShell>, shared AideDockProvider
 * open/composer-seed state); only the body differs: the one guardianship-
 * scoped parent thread (<ParentChat>). No scope machinery — a parent's aide
 * is always about their own children. Closed → renders nothing (the portal
 * body takes the full width).
 */
export function ParentAideDock() {
  const { open, setOpen, pendingComposerSeed, consumeComposerSeed } =
    useAideDock();
  if (!open) return null;

  return (
    <AideDockShell>
      {/* Slim header, mirroring the teacher dock's bar: title + close. */}
      <Flex
        px={3}
        py={2}
        align="center"
        gap={2}
        borderBottom="1px solid"
        borderColor="gray.200"
        bg="white"
      >
        <Text
          flex={1}
          minW={0}
          fontFamily="heading"
          fontWeight="600"
          fontSize="sm"
          color="navy.500"
          overflow="hidden"
          style={{ whiteSpace: "nowrap", textOverflow: "ellipsis" }}
        >
          Ask about your child&apos;s learning
        </Text>
        <IconButton
          aria-label="Close chat"
          title="Close"
          size="xs"
          variant="ghost"
          color="charcoal.400"
          _hover={{ bg: "gray.100" }}
          onClick={() => setOpen(false)}
        >
          <X size={15} />
        </IconButton>
      </Flex>
      <Box flex={1} minH={0} display="flex" flexDirection="column" overflow="hidden">
        <ParentChat
          seed={pendingComposerSeed}
          onSeedConsumed={consumeComposerSeed}
        />
      </Box>
    </AideDockShell>
  );
}
