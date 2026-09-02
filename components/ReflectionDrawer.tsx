"use client";

import { RemoteLink } from "./RemoteLink";
import { useMutation, useQuery } from "convex/react";
import {
  Box,
  Drawer,
  Flex,
  HStack,
  IconButton,
  Portal,
  Text,
} from "@chakra-ui/react";
import { api } from "@/convex/_generated/api";
import { Id } from "@/convex/_generated/dataModel";
import {
  Compass,
  House,
  ArrowsOut,
  ArrowClockwise,
  X,
} from "@phosphor-icons/react";
import { BigPictureContent } from "./BigPictureContent";

interface ReflectionDrawerProps {
  sessionId: Id<"sessions">;
  open: boolean;
  onClose: () => void;
  /** Current project title — used to seed the rename dialog. */
  sessionTitle: string;
  /** When provided, exposes a "Rename project" action inside the drawer. */
  onRename?: (next: string) => void;
  /** When provided, exposes a Mark complete / Mark not done action. */
  onToggleComplete?: () => void;
  /** Whether the current activity is already marked complete. */
  isCurrentDone?: boolean;
  /** Whether mark-complete applies to this project (online activity only). */
  canMarkComplete?: boolean;
}

/**
 * "Big picture" drawer — slides in from the left when the scholar
 * taps the compass button in the header. The body is the shared
 * `BigPictureContent` (variant="drawer"); the drawer adds the chrome
 * (home button, title, refresh, expand-to-full-screen, close).
 *
 * The same body renders on `/scholar/[sessionId]/progress` with
 * `variant="full"` — keeping content + interactions DRY between the
 * drawer surface and the dedicated full-screen route.
 */
export function ReflectionDrawer({
  sessionId,
  open,
  onClose,
  sessionTitle,
  onRename,
  onToggleComplete,
  isCurrentDone,
  canMarkComplete,
}: ReflectionDrawerProps) {
  // Lightweight subscription: only used by the header's
  // "Refresh" button (hidden until AI summary exists). The body's
  // own subscription lives inside BigPictureContent.
  const data = useQuery(
    api.sessions.getBigPicture,
    open ? { sessionId } : "skip",
  );
  const regenerate = useMutation(api.sessions.regenerateReflection);

  return (
    <Drawer.Root
      open={open}
      onOpenChange={(d) => !d.open && onClose()}
      placement="start"
      size="md"
    >
      <Portal>
        <Drawer.Backdrop />
        <Drawer.Positioner>
          {/* Portaled overlays are position:fixed, so the body's
              env(safe-area-inset-top) padding doesn't apply — pad the
              drawer itself so its header clears the iPad status bar.
              env() is 0 in desktop browsers, so this is a no-op on web. */}
          <Drawer.Content
            bg="white"
            pt="env(safe-area-inset-top)"
            pb="env(safe-area-inset-bottom)"
          >
            <Drawer.Header
              borderBottom="1px solid"
              borderColor="gray.100"
              px={5}
              py={4}
            >
              <Flex align="center" w="full" position="relative" minH="32px">
                <Box flex={1} display="flex" justifyContent="flex-start">
                  <RemoteLink
                    href="/scholar"
                    style={{ textDecoration: "none" }}
                    onClick={onClose}
                  >
                    <IconButton
                      aria-label="Go to all my sessions"
                      size="xs"
                      variant="ghost"
                      color="charcoal.400"
                      _hover={{ color: "navy.500", bg: "gray.100" }}
                    >
                      <House size={16} />
                    </IconButton>
                  </RemoteLink>
                </Box>
                <HStack
                  gap={2}
                  position="absolute"
                  left="50%"
                  top="50%"
                  transform="translate(-50%, -50%)"
                >
                  <Box color="violet.500">
                    <Compass size={18} />
                  </Box>
                  <Text
                    fontFamily="heading"
                    fontWeight="700"
                    fontSize="md"
                    color="navy.500"
                  >
                    Big picture
                  </Text>
                </HStack>
                <Flex flex={1} justify="flex-end" gap={1}>
                  {data?.reflection && (
                    <IconButton
                      aria-label="Refresh big-picture summary"
                      size="xs"
                      variant="ghost"
                      color="charcoal.300"
                      _hover={{ color: "violet.500", bg: "gray.100" }}
                      onClick={async () => {
                        await regenerate({ sessionId });
                      }}
                    >
                      <ArrowClockwise size={14} />
                    </IconButton>
                  )}
                  {/* Expand to full screen — prefer the canonical
                      entity URL when possible (/scholar/quest/<id>
                      or /scholar/unit/<id>) so the URL bar reflects
                      what the scholar is looking at, not which
                      project they happened to be on when they opened
                      the drawer. Falls back to the project-scoped
                      URL when there's no quest or unit context. */}
                  <RemoteLink
                    href={
                      data?.progress?.kind === "lesson"
                        ? `/scholar/unit/${data.progress.unitId}`
                        : `/scholar/${sessionId}/progress`
                    }
                    style={{ textDecoration: "none" }}
                    onClick={onClose}
                  >
                    <IconButton
                      aria-label="Expand to full screen"
                      size="xs"
                      variant="ghost"
                      color="charcoal.300"
                      _hover={{ color: "violet.500", bg: "gray.100" }}
                    >
                      <ArrowsOut size={14} />
                    </IconButton>
                  </RemoteLink>
                  <IconButton
                    aria-label="Close"
                    size="xs"
                    variant="ghost"
                    color="charcoal.300"
                    _hover={{ color: "charcoal.500", bg: "gray.100" }}
                    onClick={onClose}
                  >
                    <X size={16} />
                  </IconButton>
                </Flex>
              </Flex>
            </Drawer.Header>

            <Drawer.Body px={5} py={4}>
              <BigPictureContent
                sessionId={sessionId}
                sessionTitle={sessionTitle}
                onRename={onRename}
                onToggleComplete={onToggleComplete}
                isCurrentDone={isCurrentDone}
                canMarkComplete={canMarkComplete}
                variant="drawer"
                onAfterNavigate={onClose}
                active={open}
              />
            </Drawer.Body>
          </Drawer.Content>
        </Drawer.Positioner>
      </Portal>
    </Drawer.Root>
  );
}
