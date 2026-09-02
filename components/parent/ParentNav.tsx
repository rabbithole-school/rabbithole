"use client";

import type { ReactNode } from "react";
import { Box, chakra, HStack, Text, VisuallyHidden } from "@chakra-ui/react";
import {
  CalendarBlank,
  ChatsCircle,
  Files,
  ImageSquare,
  TreeStructure,
} from "@phosphor-icons/react";
import type { Id } from "@/convex/_generated/dataModel";
import { Avatar } from "@/components/Avatar";
import {
  parentVisibleTabs,
  PARENT_TAB_LABELS,
  type ParentTab,
} from "@/components/parent/parentTabs";
import {
  TopNavTabs,
  type TopNavItem,
} from "@/components/ui/TopNavTabs";

export interface ParentChild {
  _id: Id<"users">;
  name: string;
  image: string | null;
  enrollmentStanding: "enrolled" | "program_guest";
}

const PARENT_TAB_ICONS: Record<
  "records" | "portfolio" | "math" | "calendar" | "messages",
  ReactNode
> = {
  records: <Files size={16} />,
  portfolio: <ImageSquare size={16} />,
  math: <TreeStructure size={16} />,
  calendar: <CalendarBlank size={16} />,
  messages: <ChatsCircle size={16} />,
};

export function ParentNavTabs({
  activeKey,
  messagesUnread,
  programGuest,
  childId,
  onNavigate,
  onHomeNavigate,
}: {
  activeKey: ParentTab;
  messagesUnread: boolean;
  programGuest: boolean;
  childId: Id<"users"> | null;
  onNavigate: (key: ParentTab) => void;
  onHomeNavigate: () => void;
}) {
  const items: TopNavItem<ParentTab>[] = parentVisibleTabs(programGuest).map(
    (key) => ({
      key,
      label: PARENT_TAB_LABELS[key] ?? `${key[0].toUpperCase()}${key.slice(1)}`,
      icon: PARENT_TAB_ICONS[key as keyof typeof PARENT_TAB_ICONS],
      indicator:
        key === "messages" && messagesUnread ? (
          <>
            <Box
              w={2}
              h={2}
              ml={1.5}
              borderRadius="full"
              bg="violet.500"
              aria-hidden="true"
            />
            <VisuallyHidden>Unread messages</VisuallyHidden>
          </>
        ) : undefined,
    }),
  );
  if (items.length === 0 || (items.length === 1 && !programGuest)) return null;

  const hrefForKey = (key: ParentTab) =>
    `/parent/${key}${childId ? `?child=${childId}` : ""}`;

  return (
    <TopNavTabs
      items={items}
      activeKey={activeKey}
      ariaLabel="Parent sections"
      hrefForKey={hrefForKey}
      onNavigate={onNavigate}
      homeHref="/parent"
      onHomeNavigate={onHomeNavigate}
    />
  );
}

export function ParentChildSwitcher({
  childOptions,
  activeChild,
  onSelect,
}: {
  childOptions: ParentChild[];
  activeChild: Id<"users"> | null;
  onSelect: (childId: Id<"users">) => void;
}) {
  if (childOptions.length <= 1) return null;

  return (
    <HStack
      role="group"
      aria-label="Choose child"
      gap={0.5}
      p={0.5}
      bg="gray.100"
      borderRadius="full"
      flexShrink={0}
    >
      {childOptions.map((child) => {
        const active = child._id === activeChild;
        return (
          <chakra.button
            key={child._id}
            type="button"
            aria-label={`View ${child.name}`}
            aria-pressed={active}
            onClick={() => onSelect(child._id)}
            display="inline-flex"
            alignItems="center"
            gap={1.5}
            minH={7}
            px={{ base: 1, lg: 2 }}
            py={0.5}
            borderRadius="full"
            bg={active ? "white" : "transparent"}
            shadow={active ? "xs" : "none"}
            color={active ? "violet.700" : "charcoal.500"}
            cursor="pointer"
            transition="background 0.12s"
            _hover={active ? undefined : { bg: "blackAlpha.50" }}
          >
            <Avatar
              name={child.name}
              src={child.image ?? undefined}
              size="2xs"
              colorKey={child._id}
            />
            <Text
              display={{ base: "none", lg: "block" }}
              fontFamily="heading"
              fontWeight={active ? "700" : "500"}
              fontSize="xs"
              whiteSpace="nowrap"
            >
              {child.name}
            </Text>
          </chakra.button>
        );
      })}
    </HStack>
  );
}
