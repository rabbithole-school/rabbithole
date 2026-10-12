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
import {
  MessageThread,
  ScholarMessageThread,
} from "@/components/messaging/MessageThread";

/**
 * The shared messaging workspace (families, mentors, Workshop): conversation
 * list on the left and the active thread or compose surface on the right.
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
        overflow="hidden"
        borderRight="1px solid"
        borderColor="gray.200"
        bg="white"
      >
        {/* Splitter panels clip overflow (an inline `overflow: hidden`), so
            the child owns vertical scrolling. `relative` keeps absolutely
            positioned bits inside it — a row's visually hidden "Unread"
            label — which would otherwise hang off <body> below the fold and
            give the whole page scrollable overflow. */}
        <Box h="full" overflowY="auto" position="relative">
          {list}
        </Box>
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

/** `family` threads act as the explicit `surface`; `scholar` (mentor /
 *  Workshop) threads derive the viewer server-side. */
export function MessageThreadPane(
  props:
    | { threadId: Id<"parentThreads">; surface: "staff" | "parent" }
    | { threadId: Id<"parentThreads">; conversation: "scholar" },
) {
  return (
    <Box h="full" overflow="hidden">
      {"conversation" in props ? (
        <ScholarMessageThread key={props.threadId} threadId={props.threadId} />
      ) : (
        <MessageThread
          key={props.threadId}
          threadId={props.threadId}
          surface={props.surface}
        />
      )}
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

/** Every conversation list row's preview line (family, mentor, Workshop): the
 *  latest message, prefixed with whoever wrote it ("You: …" / "Chris: …") so
 *  it's clear whose turn it is. The server names the author per viewer —
 *  "You" only for the viewer's own words. */
export function threadPreview(
  preview: string,
  authorName: string | null,
): string {
  if (!preview) return "No messages yet";
  return authorName ? `${authorName}: ${preview}` : preview;
}
