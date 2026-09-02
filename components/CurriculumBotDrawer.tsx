"use client";

import { Box, Drawer, Portal } from "@chakra-ui/react";
import CurriculumAssistant from "./CurriculumAssistant";
import type { Id } from "@/convex/_generated/dataModel";

/** The Curriculum Bot is always unit-scoped; kept as a discriminated union for
 *  back-compat with the `scope` prop (callers may pass either `unitId` or this). */
export type CurriculumChatScope = { kind: "unit"; id: Id<"units"> };

interface CurriculumBotDrawerProps {
  open: boolean;
  onClose: () => void;
  /** Back-compat: when set, treated as scope { kind: "unit", id: unitId }. */
  unitId?: Id<"units">;
  /** Preferred polymorphic shape. Pass either unitId OR scope. */
  scope?: CurriculumChatScope;
  selectedLessonId?: Id<"lessons"> | null;
  selectedActivityId?: Id<"activities"> | null;
  /** When the drawer is opened from a test-drive session, the project id of
   *  that test drive. Curriculum Bot pulls the test-drive transcript +
   *  flags as additional context so it can ground prompt-refinement
   *  suggestions in what actually just happened. */
  testDriveProjectId?: Id<"sessions"> | null;
  /** Flags the teacher just placed on tutor messages (👍 / 👎). When
   *  non-empty, the chat renders a stack of chips above the input
   *  prompting them to type a "why" note that gets attached to every
   *  flag in the stack when they send. */
  pendingFlags?: Array<{
    messageId: string;
    kind: "good" | "bad";
    snippet: string;
  }>;
  /** Called with the user's typed note when they send while the
   *  pending-flag stack is non-empty. Attaches the note to every flag. */
  onAttachNoteToFlags?: (note: string) => void;
  /** Called when the teacher × dismisses one chip from the stack. */
  onDismissPendingFlag?: (messageId: string) => void;
}

/**
 * Sidecar Curriculum Bot panel for Test Drive (and remote) mode.
 *
 * Wraps the unit-scoped `<CurriculumAssistant>` in a right-edge slide-in Drawer
 * so the teacher can give live feedback ("this prompt is too hard", "add a hint
 * about X") without leaving the scholar view. The bot's existing tools —
 * `update_activity`, `generate_activity_prompt`, `create_slides_deck` — already
 * do the right thing once the activity is selected.
 *
 * The chat thread is the unit-scoped Curriculum Bot history (same one the
 * teacher uses in the unit designer), so feedback noticed during a test
 * drive is continuous with prior design conversations about the same unit.
 *
 * Stays mounted (not unmounted on close) so chat / streaming state isn't
 * lost when the teacher peeks back at the scholar view; the drawer just
 * hides via Chakra's open/close transition.
 */
export function CurriculumBotDrawer({
  open,
  onClose,
  unitId,
  scope,
  selectedLessonId,
  selectedActivityId,
  testDriveProjectId,
  pendingFlags,
  onAttachNoteToFlags,
  onDismissPendingFlag,
}: CurriculumBotDrawerProps) {
  const resolvedUnitId: Id<"units"> | undefined = scope ? scope.id : unitId;
  if (!resolvedUnitId) {
    throw new Error("CurriculumBotDrawer requires either unitId or scope");
  }

  return (
    <Drawer.Root
      open={open}
      onOpenChange={(d) => {
        if (!d.open) onClose();
      }}
      placement="end"
      size="md"
      // Don't dismiss when the teacher clicks the scholar UI behind the
      // drawer — they're often switching attention back-and-forth between
      // the test drive and the bot. Only the explicit × should close it.
      closeOnInteractOutside={false}
      closeOnEscape={false}
    >
      <Portal>
        {/* No backdrop — teacher should be able to read scholar UI behind */}
        <Drawer.Positioner>
          {/* Portaled overlays are position:fixed, so the body's
              env(safe-area-inset-top) padding doesn't reach them — pad the
              drawer so its header clears the iPad status bar. env() is 0 in
              desktop browsers, so this is a no-op on web. */}
          <Drawer.Content
            display="flex"
            flexDirection="column"
            bg="white"
            shadow="lg"
            pt="env(safe-area-inset-top)"
            pb="env(safe-area-inset-bottom)"
          >
            <Box flex={1} display="flex" flexDirection="column" minH={0}>
              <CurriculumAssistant
                key={`unit:${String(resolvedUnitId)}`}
                compact
                onClose={onClose}
                unitContext={{
                  unitId: resolvedUnitId,
                  selectedLessonId: selectedLessonId ?? null,
                  selectedActivityId: selectedActivityId ?? null,
                  testDriveProjectId: testDriveProjectId ?? null,
                  pendingFlags: pendingFlags ?? [],
                  onAttachNoteToFlags,
                  onDismissPendingFlag,
                }}
              />
            </Box>
          </Drawer.Content>
        </Drawer.Positioner>
      </Portal>
    </Drawer.Root>
  );
}
