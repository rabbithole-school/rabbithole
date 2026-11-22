"use client";

/**
 * The Workshop title for a tile session (convex/lib/tileSessions.ts): a menu
 * of the scholar's sessions of the same app, newest first, with ＋ New,
 * Rename… and Archived (n). It reuses the Workshop's app-switcher control (an
 * outline Menu trigger), so a scholar sees a different list in a control they
 * already know. Tile sessions never sit on Home, so this menu is also the one
 * place to archive one.
 */

import { useState } from "react";
import { useMutation, useQuery } from "convex/react";
import {
  Box,
  Button,
  Dialog,
  Flex,
  IconButton,
  Input,
  Menu,
  Portal,
  Text,
} from "@chakra-ui/react";
import {
  Archive,
  ArrowCounterClockwise,
  CaretDown,
  CaretRight,
  Check,
  PencilSimple,
  Plus,
  X,
} from "@phosphor-icons/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { StyledDialogContent } from "@/components/ui/StyledDialogContent";
import { formatRelative } from "@/lib/relativeTime";
import { toaster } from "@/lib/toaster";

type TileSessions = NonNullable<
  ReturnType<typeof useQuery<typeof api.vibecode.tileSessionsForSelf>>
>;

/** The switcher's read; null for anyone it does not apply to (a teacher
 *  reading the session, an app that opens no session). */
export function useTileSessions(
  externalAppId: Id<"externalApps"> | null | undefined,
): TileSessions | null | undefined {
  return useQuery(
    api.vibecode.tileSessionsForSelf,
    externalAppId ? { externalAppId } : "skip",
  );
}

export function TileSessionSwitcher({
  sessionId,
  externalAppId,
  title,
  sessions,
  onOpenSession,
  onHome,
}: {
  sessionId: Id<"sessions">;
  externalAppId: Id<"externalApps">;
  title: string;
  sessions: TileSessions;
  onOpenSession: (sessionId: Id<"sessions">) => void;
  onHome: () => void;
}) {
  const newSession = useMutation(api.vibecode.newTileSessionForSelf);
  const update = useMutation(api.sessions.update);
  const archive = useMutation(api.sessions.archive);
  const unarchive = useMutation(api.sessions.unarchive);
  const [renameOpen, setRenameOpen] = useState(false);
  const [renameDraft, setRenameDraft] = useState(title);
  const [creating, setCreating] = useState(false);

  const fail = (what: string) => (err: unknown) => {
    console.error(`Tile session ${what} failed:`, err);
    toaster.error({ title: `Couldn't ${what}. Try again.` });
  };

  const createNew = async () => {
    if (creating) return;
    setCreating(true);
    try {
      const res = await newSession({ externalAppId });
      onOpenSession(res.sessionId);
    } catch (err) {
      fail("start a new one")(err);
    } finally {
      setCreating(false);
    }
  };

  const archiveRow = async (id: Id<"sessions">) => {
    try {
      await archive({ id });
    } catch (err) {
      fail("archive it")(err);
      return;
    }
    if (id !== sessionId) return;
    // The open session went away: go to the next active one, or Home.
    const next = sessions.active.find((row) => row.sessionId !== id);
    if (next) onOpenSession(next.sessionId);
    else onHome();
  };

  const saveRename = () => {
    const next = renameDraft.trim();
    if (next && next !== title) {
      update({ id: sessionId, title: next }).catch(fail("rename it"));
    }
    setRenameOpen(false);
  };

  return (
    <>
      <Menu.Root positioning={{ placement: "bottom-start" }}>
        <Menu.Trigger asChild>
          <Button
            size="sm"
            variant="outline"
            colorPalette="gray"
            fontFamily="heading"
            aria-label={`Switch session: ${title}`}
            minW={0}
            maxW="260px"
            flexShrink={1}
          >
            <Text as="span" color="navy.500" fontWeight="600" truncate>
              {title}
            </Text>
            <CaretDown size={10} style={{ marginLeft: 3, flexShrink: 0 }} />
          </Button>
        </Menu.Trigger>
        <Portal>
          <Menu.Positioner>
            <Menu.Content minW="260px">
              {sessions.active.map((row) => {
                const current = row.sessionId === sessionId;
                return (
                  <Menu.Item
                    key={row.sessionId}
                    value={row.sessionId}
                    onSelect={() => {
                      if (!current) onOpenSession(row.sessionId);
                    }}
                  >
                    <Box w="14px" flexShrink={0}>
                      {current && <Check size={12} weight="bold" />}
                    </Box>
                    <Text flex={1} fontFamily="heading" fontSize="sm" truncate>
                      {row.title}
                    </Text>
                    <Text
                      fontFamily="heading"
                      fontSize="xs"
                      color="charcoal.400"
                      flexShrink={0}
                    >
                      {formatRelative(row.lastOpenedAt)}
                    </Text>
                    <IconButton
                      aria-label={`Archive ${row.title}`}
                      size="2xs"
                      variant="ghost"
                      color="charcoal.400"
                      _hover={{ bg: "gray.200", color: "charcoal.600" }}
                      onClick={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        void archiveRow(row.sessionId);
                      }}
                    >
                      <Archive />
                    </IconButton>
                  </Menu.Item>
                );
              })}
              <Menu.Separator />
              <Menu.Item
                value="new"
                fontFamily="heading"
                fontSize="sm"
                disabled={creating}
                onSelect={() => void createNew()}
              >
                <Plus />
                New
              </Menu.Item>
              <Menu.Item
                value="rename"
                fontFamily="heading"
                fontSize="sm"
                onSelect={() => {
                  setRenameDraft(title);
                  setRenameOpen(true);
                }}
              >
                <PencilSimple />
                Rename…
              </Menu.Item>
              {sessions.archived.length > 0 && (
                <Menu.Root positioning={{ placement: "right-start", gutter: 2 }}>
                  <Menu.TriggerItem fontFamily="heading" fontSize="sm">
                    <Archive />
                    <Text flex={1}>{`Archived (${sessions.archived.length})`}</Text>
                    <CaretRight size={10} />
                  </Menu.TriggerItem>
                  <Portal>
                    <Menu.Positioner>
                      <Menu.Content minW="240px">
                        {sessions.archived.map((row) => (
                          <Menu.Item
                            key={row.sessionId}
                            value={`unarchive-${row.sessionId}`}
                            onSelect={() => {
                              unarchive({ id: row.sessionId }).catch(
                                fail("unarchive it"),
                              );
                            }}
                          >
                            <Text
                              flex={1}
                              fontFamily="heading"
                              fontSize="sm"
                              truncate
                            >
                              {row.title}
                            </Text>
                            <Flex
                              align="center"
                              gap={1}
                              fontFamily="heading"
                              fontSize="xs"
                              color="violet.600"
                              flexShrink={0}
                            >
                              <ArrowCounterClockwise />
                              Unarchive
                            </Flex>
                          </Menu.Item>
                        ))}
                      </Menu.Content>
                    </Menu.Positioner>
                  </Portal>
                </Menu.Root>
              )}
            </Menu.Content>
          </Menu.Positioner>
        </Portal>
      </Menu.Root>

      <Dialog.Root
        open={renameOpen}
        onOpenChange={(d) => setRenameOpen(d.open)}
        placement="center"
        motionPreset="slide-in-bottom"
      >
        <Portal>
          <Dialog.Backdrop />
          <Dialog.Positioner>
            <StyledDialogContent maxW="md">
              <Dialog.Header px={6} pt={5} pb={2}>
                <Dialog.Title
                  fontFamily="heading"
                  fontWeight="700"
                  color="navy.500"
                  fontSize="lg"
                  flex={1}
                >
                  Rename session
                </Dialog.Title>
                <Dialog.CloseTrigger asChild>
                  <IconButton
                    aria-label="Close"
                    size="sm"
                    variant="ghost"
                    color="charcoal.400"
                    _hover={{ bg: "gray.100" }}
                  >
                    <X />
                  </IconButton>
                </Dialog.CloseTrigger>
              </Dialog.Header>
              <Dialog.Body px={6} py={3}>
                <Input
                  value={renameDraft}
                  onChange={(e) => setRenameDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") saveRename();
                    if (e.key === "Escape") setRenameOpen(false);
                  }}
                  autoFocus
                  fontFamily="heading"
                  fontSize="md"
                />
              </Dialog.Body>
              <Dialog.Footer px={6} pb={5} pt={3}>
                <Button
                  variant="ghost"
                  fontFamily="heading"
                  size="sm"
                  onClick={() => setRenameOpen(false)}
                >
                  Cancel
                </Button>
                <Button
                  bg="violet.500"
                  color="white"
                  _hover={{ bg: "violet.700" }}
                  fontFamily="heading"
                  size="sm"
                  onClick={saveRename}
                  disabled={!renameDraft.trim() || renameDraft.trim() === title}
                >
                  Save
                </Button>
              </Dialog.Footer>
            </StyledDialogContent>
          </Dialog.Positioner>
        </Portal>
      </Dialog.Root>
    </>
  );
}
