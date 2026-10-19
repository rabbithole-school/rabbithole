"use client";

import { useState } from "react";
import { IconButton } from "@chakra-ui/react";
import { Archive, ArrowCounterClockwise } from "@phosphor-icons/react";
import { useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { toaster } from "@/lib/toaster";
import { serverRefusal } from "@/lib/serverErrorMessage";
import { HOME_ARCHIVE_COPY } from "@/shared/homeArchive";

/**
 * The scholar Home's ONE archive control for a session-backed item: the plate
 * rows, the Now tab's homework rows, and the Archived list's own rows
 * (review/home-finished-filter.html). Web's equivalent of the iPad's long
 * press. Quiet until its card is hovered — the card (ActivityCard,
 * UnitGroupRow, or a row that sets `role="group"`) supplies the group — and
 * always shown on touch and to keyboard focus.
 *
 * Callers must not render it for a teacher-archived session: only a teacher
 * restores that (shared/teacherArchive.ts), and the server refuses anyway.
 */
export function HomeArchiveButton({
  sessionId,
  archived,
}: {
  sessionId: Id<"sessions">;
  /** True when the session is already archived: the control unarchives. */
  archived: boolean;
}) {
  const archive = useMutation(api.sessions.archive);
  const unarchive = useMutation(api.sessions.unarchive);
  const [pending, setPending] = useState(false);
  const label = archived
    ? HOME_ARCHIVE_COPY.unarchiveAction
    : HOME_ARCHIVE_COPY.archiveAction;

  const handleClick = async (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
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
      onClick={handleClick}
    >
      {archived ? <ArrowCounterClockwise size={14} /> : <Archive size={14} />}
    </IconButton>
  );
}
