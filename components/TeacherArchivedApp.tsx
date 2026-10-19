"use client";

// Teacher archive for scholar-built apps (review/teacher-archive-scholar-apps.html).
// The web pieces shared by the session page, the builder and the chat view:
//
// - `ScholarArchivedAppPane` — the calm full-pane state a scholar sees in
//   place of the builder/chat when a teacher put the app away (§5). No app
//   frame, no composer, no Present, and nothing mounts that could fire a
//   tutor turn.
// - `TeacherArchivedAppNotice` — the slim notice a teacher reading the
//   archived session sees, with Restore app. The teacher can still read the
//   app and transcript underneath it.
// - `useArchiveAppConfirm` — Archive app with the shared confirm dialog. The
//   Dialog.Root stays mounted and only toggles `open` (the Ark body-lock leak,
//   engineering-principles.md).
//
// All copy comes from shared/teacherArchive.ts so web and iPad say the same
// words.

import { useState } from "react";
import { useMutation } from "convex/react";
import {
  Box,
  Button,
  Dialog,
  Flex,
  HStack,
  Portal,
  Text,
  VStack,
} from "@chakra-ui/react";
import { Archive } from "@phosphor-icons/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { TEACHER_ARCHIVE_COPY } from "@/shared/teacherArchive";
import { StyledDialogContent } from "@/components/ui/StyledDialogContent";
import { toaster } from "@/lib/toaster";
import { serverErrorMessage } from "@/lib/serverErrorMessage";

export function ScholarArchivedAppPane({
  title,
  onBackHome,
}: {
  title: string;
  onBackHome: () => void;
}) {
  return (
    <Flex flex={1} align="center" justify="center" bg="gray.50" p={6}>
      <VStack
        gap={3}
        maxW="420px"
        w="100%"
        bg="white"
        borderWidth="1px"
        borderColor="gray.200"
        borderRadius="xl"
        p={6}
        textAlign="center"
        role="status"
      >
        <Box color="charcoal.400" lineHeight="0">
          <Archive size={32} weight="duotone" />
        </Box>
        <Text fontFamily="heading" fontWeight="600" fontSize="lg" color="navy.500">
          {title}
        </Text>
        <Text fontFamily="heading" fontSize="sm" color="charcoal.500">
          {TEACHER_ARCHIVE_COPY.scholarLabel}
        </Text>
        <Text fontFamily="body" fontSize="sm" color="charcoal.400">
          {TEACHER_ARCHIVE_COPY.scholarExplain}
        </Text>
        <Button
          mt={2}
          size="sm"
          colorPalette="violet"
          fontFamily="heading"
          onClick={onBackHome}
        >
          {TEACHER_ARCHIVE_COPY.backHome}
        </Button>
      </VStack>
    </Flex>
  );
}

export function TeacherArchivedAppNotice({
  sessionId,
}: {
  sessionId: Id<"sessions">;
}) {
  const restoreApp = useMutation(api.sessions.restoreApp);
  const [busy, setBusy] = useState(false);
  const restore = async () => {
    setBusy(true);
    try {
      await restoreApp({ id: sessionId });
      toaster.success({ title: TEACHER_ARCHIVE_COPY.restoredToast });
    } catch (e) {
      toaster.error({
        title: "Couldn't restore the app",
        description: serverErrorMessage(e) || undefined,
      });
    } finally {
      setBusy(false);
    }
  };
  return (
    <HStack
      gap={3}
      px={3}
      py={1.5}
      bg="gray.50"
      borderBottom="1px solid"
      borderColor="gray.200"
      flexShrink={0}
    >
      <Archive size={14} color="var(--chakra-colors-charcoal-400)" />
      <Text fontFamily="heading" fontSize="sm" color="charcoal.500" flex={1}>
        {TEACHER_ARCHIVE_COPY.archivedLabel}
      </Text>
      <Button
        size="xs"
        variant="outline"
        colorPalette="violet"
        fontFamily="heading"
        loading={busy}
        onClick={() => void restore()}
      >
        {TEACHER_ARCHIVE_COPY.restoreAction}
      </Button>
    </HStack>
  );
}

/** Archive app, confirmed. Returns `open(name)` for a menu item and the
 *  always-mounted dialog element to render once. A page listing many apps
 *  passes no session here and names one per `open(name, id)`, so one dialog
 *  stays mounted while the card it was opened from unmounts. */
export function useArchiveAppConfirm(sessionId?: Id<"sessions">) {
  const archiveApp = useMutation(api.sessions.archiveApp);
  const [name, setName] = useState<string | null>(null);
  const [targetId, setTargetId] = useState<Id<"sessions"> | null>(null);
  const [busy, setBusy] = useState(false);

  const confirm = async () => {
    const id = targetId ?? sessionId;
    if (!id) return;
    setBusy(true);
    try {
      await archiveApp({ id });
      toaster.success({ title: TEACHER_ARCHIVE_COPY.archivedToast });
      setName(null);
    } catch (e) {
      toaster.error({
        title: "Couldn't archive the app",
        description: serverErrorMessage(e) || undefined,
      });
    } finally {
      setBusy(false);
    }
  };

  const dialog = (
    <Dialog.Root
      open={name !== null}
      onOpenChange={(e) => {
        if (!e.open && !busy) setName(null);
      }}
      placement="center"
      role="alertdialog"
    >
      <Portal>
        <Dialog.Backdrop />
        <Dialog.Positioner>
          <StyledDialogContent>
            <Dialog.Header px={6} pt={5} pb={2}>
              <Dialog.Title fontFamily="heading" fontSize="lg" color="navy.500">
                {TEACHER_ARCHIVE_COPY.confirmTitle(name ?? "")}
              </Dialog.Title>
            </Dialog.Header>
            <Dialog.Body px={6} py={3}>
              <Text fontSize="sm" color="charcoal.500">
                {TEACHER_ARCHIVE_COPY.confirmBody}
              </Text>
            </Dialog.Body>
            <Dialog.Footer px={6} pb={5} pt={2} gap={2}>
              <Button
                size="sm"
                variant="ghost"
                fontFamily="heading"
                disabled={busy}
                onClick={() => setName(null)}
              >
                Cancel
              </Button>
              <Button
                size="sm"
                colorPalette="red"
                fontFamily="heading"
                loading={busy}
                onClick={() => void confirm()}
              >
                {TEACHER_ARCHIVE_COPY.archiveAction}
              </Button>
            </Dialog.Footer>
          </StyledDialogContent>
        </Dialog.Positioner>
      </Portal>
    </Dialog.Root>
  );

  return {
    open: (appName: string, id?: Id<"sessions">) => {
      setTargetId(id ?? null);
      setName(appName);
    },
    dialog,
  };
}
