"use client";

import { useState } from "react";
import { IconButton } from "@chakra-ui/react";
import { ArrowCounterClockwise } from "@phosphor-icons/react";
import { useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { toaster } from "@/lib/toaster";
import { serverRefusal } from "@/lib/serverErrorMessage";
import { HOME_ARCHIVE_COPY } from "@/shared/homeArchive";
import { DismissButton } from "@/components/ui/DismissButton";

/**
 * The scholar Home's ONE archive control for a session-backed item: the plate
 * rows and the Archived list's own rows (review/home-finished-filter.html).
 *
 * Archiving draws the same quiet × the wonder rows dismiss with
 * (components/ui/DismissButton), always visible, after the row's verb. The
 * iPad's Home rows carry the same ×. Unarchiving is a restore, so it keeps
 * its own small icon, quiet until its card is hovered (the card supplies the
 * group) and always shown on touch and to keyboard focus.
 *
 * Callers must not render it for a teacher-archived session: only a teacher
 * restores that (shared/teacherArchive.ts), and the server refuses anyway.
 */
export function HomeArchiveButton({
  sessionId,
  archived,
  title,
}: {
  sessionId: Id<"sessions">;
  /** True when the session is already archived: the control unarchives. */
  archived: boolean;
  /** The row's title, for the accessible name ("Archive <title>"). */
  title: string;
}) {
  const archive = useMutation(api.sessions.archive);
  const unarchive = useMutation(api.sessions.unarchive);
  const [pending, setPending] = useState(false);
  const label = archived
    ? HOME_ARCHIVE_COPY.unarchiveAction
    : HOME_ARCHIVE_COPY.archiveAction;

  const run = async () => {
    if (pending) return;
    setPending(true);
    try {
      if (archived) await unarchive({ id: sessionId });
      else await archive({ id: sessionId });
    } catch (error) {
      console.error(`[home-archive] ${label} failed`, error);
      // A deliberate refusal (e.g. a teacher archived it meanwhile) says why.
      const refusal = serverRefusal(error);
      toaster.error({
        title: archived
          ? HOME_ARCHIVE_COPY.unarchiveFailed
          : HOME_ARCHIVE_COPY.archiveFailed,
        ...(refusal ? { description: refusal } : {}),
      });
    } finally {
      setPending(false);
    }
  };

  if (!archived) {
    return (
      <DismissButton
        action={HOME_ARCHIVE_COPY.archiveAction}
        label={title}
        disabled={pending}
        onPress={() => void run()}
      />
    );
  }

  return (
    <IconButton
      aria-label={label}
      title={label}
      size="xs"
      variant="ghost"
      color="charcoal.300"
      _hover={{ color: "charcoal.600", bg: "gray.100" }}
      opacity={0}
      _groupHover={{ opacity: 1 }}
      _focusVisible={{ opacity: 1 }}
      css={{ "@media (pointer: coarse)": { opacity: 1 } }}
      transition="opacity .15s"
      disabled={pending}
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        void run();
      }}
    >
      <ArrowCounterClockwise size={14} />
    </IconButton>
  );
}
