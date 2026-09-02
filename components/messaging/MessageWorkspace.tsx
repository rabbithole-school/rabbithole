"use client";

import type { ReactNode } from "react";
import NextLink from "next/link";
import {
  Box,
  HStack,
  Link,
  Splitter,
  Text,
  VisuallyHidden,
} from "@chakra-ui/react";
import type { Id } from "@/convex/_generated/dataModel";
import { MessageThread } from "@/components/messaging/MessageThread";

/**
 * The shared family-messaging workspace: conversation list on the left and the
 * active thread or compose surface on the right.
 */
export function MessageWorkspace({
  list,
  detail,
}: {
  list: ReactNode;
  detail: ReactNode;
}) {
  return (
    <Splitter.Root
      flex={1}
      minH={0}
      overflow="hidden"
      defaultSize={[28, 72]}
      panels={[
        { id: "list", minSize: 18 },
        { id: "detail", minSize: 50 },
      ]}
    >
      <Splitter.Panel
        id="list"
        h="full"
        overflowY="auto"
        borderRight="1px solid"
        borderColor="gray.200"
        bg="white"
      >
        {list}
      </Splitter.Panel>

      <Splitter.ResizeTrigger
        id="list:detail"
        css={{ "--splitter-border-size": "0.5px" }}
      />

      <Splitter.Panel id="detail" h="full" overflow="hidden" bg="white">
        {detail}
      </Splitter.Panel>
    </Splitter.Root>
  );
}

export function MessageThreadPane({
  threadId,
  surface,
}: {
  threadId: Id<"parentThreads">;
  surface: "staff" | "parent";
}) {
  return (
    <Box h="full" overflow="hidden">
      <MessageThread key={threadId} threadId={threadId} surface={surface} />
    </Box>
  );
}

export function MessageConversationRow({
  active,
  unread,
  leading,
  primary,
  secondary,
  preview,
  timestamp,
  href,
  onNavigate,
}: {
  active: boolean;
  unread: boolean;
  leading?: ReactNode;
  primary: string;
  secondary?: string | null;
  preview: string;
  timestamp: string;
  href: string;
  onNavigate?: () => void;
}) {
  return (
    <Link
      asChild
      w="full"
      display="block"
      textAlign="left"
      px={4}
      py={3}
      borderBottomWidth="1px"
      borderColor="gray.100"
      bg={active ? "violet.50" : "transparent"}
      _hover={{ bg: active ? "violet.50" : "gray.50" }}
      _focusVisible={{ outline: "2px solid", outlineColor: "violet.500", outlineOffset: "-2px" }}
      cursor="pointer"
      textDecoration="none"
      aria-current={active ? "page" : undefined}
    >
      <NextLink href={href} replace scroll={false} onNavigate={onNavigate}>
        <HStack justify="space-between" mb={0.5}>
          <HStack gap={2} minW={0}>
            {unread && (
              <>
                <Box
                  w={2}
                  h={2}
                  borderRadius="full"
                  bg="violet.500"
                  flexShrink={0}
                  aria-hidden="true"
                />
                <VisuallyHidden>Unread conversation</VisuallyHidden>
              </>
            )}
            {leading}
            <Text
              fontFamily="heading"
              fontWeight="700"
              color="navy.500"
              fontSize="sm"
              truncate
            >
              {primary}
            </Text>
          </HStack>
          <Text
            fontFamily="body"
            fontSize="2xs"
            color="charcoal.300"
            flexShrink={0}
          >
            {timestamp}
          </Text>
        </HStack>
        {secondary && (
          <Text fontFamily="body" fontSize="2xs" color="charcoal.300">
            {secondary}
          </Text>
        )}
        <Text fontFamily="body" fontSize="xs" color="charcoal.400" truncate>
          {preview}
        </Text>
      </NextLink>
    </Link>
  );
}
