"use client";

/**
 * VibecodeHistoryPanel — the App designer's version History (Edit mode only,
 * review/teacher-build-flow.html state C). A drawer listing the session's code
 * revisions newest first: the render-check thumbnail, the request that produced
 * the revision (or a "Restored" label), the version number, and the time.
 * "Restore" fetches that revision's html on click and rolls it forward as a NEW
 * revision — it does not rewrite history. Revisions arrive as METADATA ONLY
 * (never html — F5); the parent fetches the list so the transcript can render
 * the same version numbers inline.
 */

import { Box, Button, Drawer, Flex, IconButton, Portal, Spinner, Text } from "@chakra-ui/react";
import { ClockCounterClockwise, X } from "@phosphor-icons/react";

import { formatClockTime } from "@/shared/workshopMode";

export type HistoryRevision = {
  id: string;
  revision: number;
  version: number;
  createdAt: number;
  requestText: string | null;
  snapshotUrl: string | null;
  restoredFromRevision: number | null;
  messageId: string | null;
};

function RevisionThumb({ url }: { url: string | null }) {
  return (
    <Box
      w="88px"
      h="56px"
      flexShrink={0}
      borderRadius="md"
      borderWidth="1px"
      borderColor="gray.200"
      bg="gray.100"
      overflow="hidden"
    >
      {url && (
        // eslint-disable-next-line @next/next/no-img-element -- dynamic Convex storage URL
        <img
          src={url}
          alt="App revision thumbnail"
          style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }}
        />
      )}
    </Box>
  );
}

export function VibecodeHistoryPanel({
  revisions,
  open,
  onClose,
  onRestore,
  restoring,
}: {
  revisions: HistoryRevision[] | undefined;
  open: boolean;
  onClose: () => void;
  onRestore: (revision: { id: string; version: number }) => void;
  restoring: boolean;
}) {
  return (
    <Drawer.Root open={open} onOpenChange={(e) => !e.open && onClose()} placement="end">
      <Portal>
        <Drawer.Backdrop />
        <Drawer.Positioner>
          <Drawer.Content bg="white" maxW="420px">
            <Flex
              align="center"
              px={4}
              py={3}
              borderBottom="1px solid"
              borderColor="gray.200"
              gap={2}
            >
              <ClockCounterClockwise weight="duotone" color="var(--chakra-colors-violet-500)" />
              <Text fontFamily="heading" fontWeight="600" color="navy.500" fontSize="sm" flex={1}>
                History
              </Text>
              <IconButton aria-label="Close history" variant="ghost" size="sm" onClick={onClose}>
                <X />
              </IconButton>
            </Flex>
            <Box flex={1} minH={0} overflowY="auto" px={4} py={3}>
              {revisions === undefined ? (
                <Flex justify="center" py={8}>
                  <Spinner color="violet.500" />
                </Flex>
              ) : revisions.length === 0 ? (
                <Text fontSize="sm" color="charcoal.400" fontFamily="heading">
                  No revisions yet — each designer turn is saved here.
                </Text>
              ) : (
                <Flex flexDir="column" gap={3}>
                  {revisions.map((rev, index) => {
                    const label =
                      rev.restoredFromRevision != null
                        ? `Restored v${rev.restoredFromRevision} version`
                        : (rev.requestText ?? "Revision");
                    return (
                      <Flex
                        key={rev.id}
                        gap={3}
                        align="center"
                        borderRadius="lg"
                        borderWidth="1px"
                        borderColor="gray.200"
                        p={2.5}
                      >
                        <RevisionThumb url={rev.snapshotUrl} />
                        <Box flex={1} minW={0}>
                          <Text
                            fontSize="sm"
                            fontFamily="heading"
                            color="charcoal.700"
                            lineClamp={2}
                          >
                            {label}
                          </Text>
                          <Text fontSize="xs" color="charcoal.400" mt={0.5}>
                            {`v${rev.version} · ${formatClockTime(rev.createdAt)}`}
                            {index === 0 ? " · current" : ""}
                          </Text>
                        </Box>
                        {index !== 0 && (
                          <Button
                            size="xs"
                            variant="outline"
                            colorPalette="violet"
                            fontFamily="heading"
                            flexShrink={0}
                            disabled={restoring}
                            onClick={() =>
                              onRestore({ id: rev.id, version: rev.version })
                            }
                          >
                            Restore
                          </Button>
                        )}
                      </Flex>
                    );
                  })}
                </Flex>
              )}
            </Box>
          </Drawer.Content>
        </Drawer.Positioner>
      </Portal>
    </Drawer.Root>
  );
}
