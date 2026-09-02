"use client";

import { usePathname } from "next/navigation";
import { IconButton, Portal, Tooltip } from "@chakra-ui/react";
import { Robot } from "@phosphor-icons/react";
import { isTeacherChatPath } from "@/lib/teacherChat";
import { useAideDock } from "./AideDockProvider";

/**
 * The Robot — the ONE control that opens/closes the docked chat, rendered in
 * the right-hand chrome of every staff shell that hosts an <AideDockProvider>
 * (the teacher dashboard header and the school shell header). It lives here
 * rather than in each header so the two can't drift into different chat
 * affordances: chat is a tool you bring to the surface you're on, not a place
 * in the tab strip, so there is exactly one trigger and it looks the same
 * everywhere.
 *
 * On the full-screen chat route the docked copy is suppressed (that route IS
 * the maximized chat), so the Robot reads active and no-ops instead of opening
 * a second copy of the same thread.
 */
export function AideToggleButton() {
  const pathname = usePathname();
  const { open, toggle } = useAideDock();
  const onChatRoute = isTeacherChatPath(pathname);
  const active = open || onChatRoute;

  return (
    <Tooltip.Root openDelay={400} closeDelay={0}>
      <Tooltip.Trigger asChild>
        <IconButton
          aria-label="Chat"
          aria-pressed={active}
          data-testid="aide-toggle"
          size="sm"
          variant="ghost"
          color={active ? "violet.600" : "charcoal.400"}
          bg={active ? "violet.50" : undefined}
          _hover={{ color: "violet.600", bg: "violet.50" }}
          onClick={() => {
            if (onChatRoute) return;
            toggle();
          }}
        >
          <Robot size={17} weight="duotone" />
        </IconButton>
      </Tooltip.Trigger>
      <Portal>
        <Tooltip.Positioner>
          <Tooltip.Content fontFamily="heading" fontSize="xs">
            {onChatRoute
              ? "You're in all chats"
              : open
                ? "Hide chat"
                : "Open chat"}
          </Tooltip.Content>
        </Tooltip.Positioner>
      </Portal>
    </Tooltip.Root>
  );
}
