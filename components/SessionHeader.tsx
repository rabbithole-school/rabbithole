"use client";

import {
  Box,
  Button,
  Flex,
  HStack,
  Text,
  IconButton,
  Tooltip,
  Portal,
} from "@chakra-ui/react";
import { Compass, House, List, ListBullets, Paperclip, CloudCheck, CloudSlash, SidebarSimple } from "@phosphor-icons/react";
import { useConvex } from "convex/react";
import { useEffect, useState } from "react";
import { BotIconButton } from "./BotIconButton";
import { AccountMenu } from "./AccountMenu";
import { AppHeader } from "./AppHeader";
import { RemoteLink } from "./RemoteLink";

interface UnitInfo {
  id: string;
  title: string;
  emoji?: string | null;
}

interface ProjectHeaderProps {
  sessionTitle: string;
  unitId: string | null;
  unitOptions: UnitInfo[];
  onMenuClick?: () => void;
  isSynced?: boolean;
  isTestMode?: boolean;
  onSignOut?: () => void;
  showRightPanel?: boolean;
  onToggleRightPanel?: () => void;
  mobileAttachmentCount?: number;
  onMobileAttachmentClick?: () => void;
  isMobile?: boolean;
  isRemoteMode?: boolean;
  // scholarName / scholarImage / remoteUserId props were consumed by
  // the old remote-mode breadcrumb (removed). The remote-mode signal
  // now lives entirely in <AccountMenu>'s dual-avatar chip. Don't
  // re-add them here; route through AccountMenu instead.
  remoteUserId?: string | null;
  /** Optional eyebrow rendered above the project title (e.g. unit › lesson › activity).
   *  When provided, replaces the inline subtitle below the title. */
  eyebrow?: React.ReactNode;
  /** Optional element rendered just before the right-panel toggle —
   *  used for the activity Mark Complete / Done toggle. */
  rightSlot?: React.ReactNode;
  /** When provided, renders the unit emoji+title as a clickable chip just left
   *  of the right-panel toggle (and suppresses the legacy subtitle below the
   *  title). Click fires this handler — typically opens the activity nav modal. */
  onUnitChipClick?: () => void;
  /** When provided, replaces the default project title rendering. Used to
   *  render the title as a menu trigger (with a down-caret) for Rename /
   *  Mark Complete actions. Must include the title text. */
  titleSlot?: React.ReactNode;
  /** When provided, renders a small "Curriculum Bot" icon button in the
   *  header (between the unit chip and the right-panel toggle). Used in
   *  remote-mode to give the teacher a quick way to ask Curriculum Bot to
   *  iterate on the activity without leaving the scholar view. Test-drive
   *  mode renders its own bot button in the cyan banner above this header
   *  (so the test-drive surface owns its controls); leave this prop
   *  undefined there to avoid double-trigger. */
  onOpenBot?: () => void;
  /** Opens the "Big picture" reflection drawer. When set, REPLACES
   *  the hamburger in the upper-left corner with a compass button
   *  + "Big picture" label. The drawer handles "where am I in this
   *  unit" + "go home" + arc-so-far + what's-next in one place. */
  onOpenReflection?: () => void;
  /** Optional small uppercase line above the project title inside
   *  the compass button. Used to signal quest membership without a
   *  separate full-width banner. e.g. "Quest · Airplanes (jigsaw)". */
  compassEyebrow?: string | null;
}

export function SessionHeader({
  sessionTitle,
  onMenuClick,
  isSynced,
  isTestMode,
  onSignOut,
  showRightPanel,
  onToggleRightPanel,
  mobileAttachmentCount,
  onMobileAttachmentClick,
  isMobile,
  isRemoteMode,
  eyebrow,
  rightSlot,
  titleSlot,
  onUnitChipClick,
  onOpenBot,
  onOpenReflection,
  compassEyebrow,
}: ProjectHeaderProps) {
  // Convex connection state: the saved-state cloud doubles as a
  // "reconnecting" indicator when the websocket drops (school wi-fi).
  const convexClient = useConvex();
  const [isConnected, setIsConnected] = useState(true);
  useEffect(() => {
    const t = setInterval(() => {
      setIsConnected(convexClient.connectionState().isWebSocketConnected);
    }, 2000);
    return () => clearInterval(t);
  }, [convexClient]);

  // The unit-outline navigator opener. The unit chip that used to open
  // the activity-nav modal (jump to / launch any activity in the unit,
  // including web activities) was dropped when the compass/Big-picture
  // button took over the unit name — leaving onUnitChipClick wired but
  // unrendered, so web activities became unreachable in-session. Re-surface
  // it as a compact outline button (no unit-name duplication; the compass
  // already carries that). Null when there's no unit context.
  const unitNavButton = onUnitChipClick ? (
    <IconButton
      aria-label="Browse this unit's activities"
      title="Browse this unit's activities"
      size="sm"
      variant="ghost"
      color="charcoal.400"
      _hover={{ bg: "gray.100", color: "navy.500" }}
      onClick={onUnitChipClick}
      flexShrink={0}
    >
      <ListBullets size={16} />
    </IconButton>
  ) : null;

  return (
    <AppHeader>
      <Flex flex={1} align="center" gap={3}>
        {/* Remote mode used to render a 4-level breadcrumb here, which
            (a) read as a different page from the scholar's own view
            and (b) had links that didn't navigate where teachers
            expected. The dual-avatar chip in <AccountMenu> already
            communicates "you're viewing as X" — render the same
            left zone the scholar sees so the page feels continuous. */}
        {(
          <>
            {/* Header left-zone — Option 3 hybrid: three visually
                distinct buttons in a row, deliberately NOT styled as
                a breadcrumb (no chevron separators) so users don't
                expect conventional crumb-nav semantics. Each is
                what it looks like:
                  • Home icon — a real link to /scholar
                  • Compass chip with unit name — a button that
                    opens the reflection drawer (carries the unit
                    name as its LABEL, not as a destination)
                  • Project title — identity + rename/complete
                    actions via the existing titleSlot menu */}
            {onOpenReflection && (
              <RemoteLink href="/scholar" style={{ flexShrink: 0 }}>
                <IconButton
                  aria-label="All my sessions"
                  size="sm"
                  variant="ghost"
                  color="charcoal.400"
                  _hover={{ bg: "gray.100", color: "navy.500" }}
                >
                  <House size={16} />
                </IconButton>
              </RemoteLink>
            )}
            {onOpenReflection && (
              <Button
                aria-label={
                  compassEyebrow
                    ? `Big picture: ${compassEyebrow} — ${sessionTitle}`
                    : `Big picture: ${sessionTitle}`
                }
                size="sm"
                variant="ghost"
                color="navy.500"
                bg="transparent"
                _hover={{ bg: "gray.100", color: "violet.600" }}
                onClick={onOpenReflection}
                fontFamily="heading"
                fontWeight="600"
                fontSize="sm"
                px={2}
                py={compassEyebrow ? 1 : undefined}
                gap={1.5}
                flexShrink={1}
                minW={0}
                maxW="420px"
                h="auto"
                minH="32px"
                justifyContent="flex-start"
                overflow="hidden"
              >
                <Box color="violet.500" flexShrink={0} display="inline-flex">
                  <Compass size={14} />
                </Box>
                {compassEyebrow ? (
                  /* Two-line stack: tiny "QUEST · TITLE" eyebrow above
                     the project title so the scholar's ambient context
                     is "I'm inside the X quest" without a full-width
                     purple banner. */
                  <Box minW={0} textAlign="left" overflow="hidden">
                    <Text
                      as="span"
                      display="block"
                      fontSize="2xs"
                      fontFamily="heading"
                      fontWeight="500"
                      color="charcoal.400"
                      lineHeight="1.1"
                      overflow="hidden"
                      textOverflow="ellipsis"
                      whiteSpace="nowrap"
                    >
                      {compassEyebrow}
                    </Text>
                    <Text
                      as="span"
                      display="block"
                      fontSize="sm"
                      overflow="hidden"
                      textOverflow="ellipsis"
                      whiteSpace="nowrap"
                      lineHeight="1.2"
                      mt={0.5}
                    >
                      {sessionTitle}
                    </Text>
                  </Box>
                ) : (
                  <Text
                    as="span"
                    overflow="hidden"
                    textOverflow="ellipsis"
                    whiteSpace="nowrap"
                    textAlign="left"
                  >
                    {sessionTitle}
                  </Text>
                )}
              </Button>
            )}
            {/* Unit-outline navigator opener — sits just right of the
                compass button so "reflect on this unit" (compass) and
                "jump to / launch an activity in this unit" (outline) are
                grouped. Gated on onOpenReflection so it rides the scholar/
                remote layout; the fallback layout renders its own copy. */}
            {onOpenReflection && unitNavButton}
            {/* Spacer — soaks up the empty space between the compass
                button and the right-side controls so the button hugs
                its content instead of stretching. */}
            {onOpenReflection && <Box flex={1} />}
            {/* Fallback: when onOpenReflection isn't wired (teacher
                view paths), show the legacy hamburger + plain title. */}
            {!onOpenReflection && (
              <>
                {onMenuClick && (
                  <IconButton
                    aria-label="Open sidebar"
                    size="sm"
                    variant="ghost"
                    color="charcoal.400"
                    _hover={{ bg: "gray.100" }}
                    onClick={onMenuClick}
                  >
                    <List />
                  </IconButton>
                )}
                {unitNavButton}
                <Box flex={1} minW={0}>
                  {eyebrow ? <Box mb={0.5}>{eyebrow}</Box> : null}
                  {titleSlot ?? (
                    <Text
                      fontWeight="600"
                      fontFamily="heading"
                      color="navy.500"
                      fontSize="sm"
                      overflow="hidden"
                      textOverflow="ellipsis"
                      whiteSpace="nowrap"
                    >
                      {sessionTitle}
                    </Text>
                  )}
                </Box>
              </>
            )}
          </>
        )}

        {/* Spacer to push right-side controls to edge */}
        {isRemoteMode && <Box flex={1} />}

        {(isSynced !== undefined || !isConnected) && (
          <Tooltip.Root openDelay={400} closeDelay={0}>
            <Tooltip.Trigger asChild>
              <Box flexShrink={0} cursor="default">
                {!isConnected ? (
                  <CloudSlash
                    size={18}
                    weight="bold"
                    color="var(--chakra-colors-orange-500)"
                  />
                ) : !isMobile && isSynced !== undefined ? (
                  <CloudCheck
                    size={18}
                    weight="regular"
                    color="var(--chakra-colors-charcoal-400)"
                  />
                ) : null}
              </Box>
            </Tooltip.Trigger>
            <Portal>
              <Tooltip.Positioner>
                <Tooltip.Content>
                  {!isConnected
                    ? "Reconnecting — check wi-fi if this persists"
                    : isSynced
                      ? "All changes saved"
                      : "Saving..."}
                </Tooltip.Content>
              </Tooltip.Positioner>
            </Portal>
          </Tooltip.Root>
        )}

        {isTestMode && !isRemoteMode && (
          <a href="/teacher" style={{ textDecoration: "none", flexShrink: 0 }}>
            <HStack
              gap={1.5}
              color="charcoal.400"
              fontFamily="heading"
              fontSize="xs"
              fontWeight="500"
              px={2}
              py={1}
              borderRadius="md"
              _hover={{ bg: "gray.100", color: "navy.500" }}
              cursor="pointer"
            >
              <Text>Dashboard</Text>
            </HStack>
          </a>
        )}

        {/* The right-side unit chip used to live here — it's gone
            because the unit name now wears the compass button on the
            left side of the header. No duplication. */}

        {onMobileAttachmentClick && mobileAttachmentCount != null && mobileAttachmentCount > 0 && (
          <Box position="relative" flexShrink={0}>
            <IconButton
              aria-label="Attachments"
              size="xs"
              variant="ghost"
              color="charcoal.400"
              _hover={{ bg: "gray.100" }}
              onClick={onMobileAttachmentClick}
            >
              <Paperclip size={16} />
            </IconButton>
            <Box
              position="absolute"
              top="-2px"
              right="-2px"
              bg="violet.500"
              color="white"
              fontSize="2xs"
              fontFamily="heading"
              fontWeight="700"
              borderRadius="full"
              minW="16px"
              h="16px"
              display="flex"
              alignItems="center"
              justifyContent="center"
              px={1}
              lineHeight={1}
            >
              {mobileAttachmentCount}
            </Box>
          </Box>
        )}

        {onOpenBot && (
          <BotIconButton
            onClick={onOpenBot}
            tooltipText="Ask Curriculum Bot about this activity"
          />
        )}

        {rightSlot}

        {onToggleRightPanel && (
          <IconButton
            aria-label={showRightPanel ? "Hide side panel" : "Show side panel"}
            size="xs"
            variant="ghost"
            color={showRightPanel ? "violet.500" : "charcoal.400"}
            _hover={{ bg: "gray.100" }}
            onClick={onToggleRightPanel}
            flexShrink={0}
          >
            {/* Phosphor's SidebarSimple has the panel on the LEFT
                by default. Flip horizontally so it reads as
                "show/hide the panel on the right." */}
            <Box transform="scaleX(-1)" display="inline-flex">
              <SidebarSimple size={16} weight={showRightPanel ? "fill" : "regular"} />
            </Box>
          </IconButton>
        )}

        {onSignOut && (
          <AccountMenu
            onSignOut={onSignOut}
          />
        )}
      </Flex>
    </AppHeader>
  );
}
