"use client";

/**
 * ManipulativeRehearseModal — the teacher "play it" (Rehearse) preview for a
 * stored manipulative item. It renders the EXACT scholar-facing `Manipulative`
 * frame in STANDALONE mode (no `onCommit`), so a teacher can actually DO the
 * manipulative — drag the strips, sweep the number line — precisely what a
 * scholar gets, but ungraded and writing NOTHING.
 *
 * Zero writes, structurally: standalone `Manipulative` (the Manipulative
 * Library / authoring-preview path) takes no `scholarId` and no `onCommit`, so
 * it runs its own local
 * self-check chip and never calls a mutation. This is the SAME renderer path
 * scholars, the instruction-atom Rehearse (`LaunchpadContent`), and the
 * authoring preview all use — no second renderer is minted.
 *
 * Body-lock safety (engineering-principles.md → "Chakra/Ark Dialog Gotchas"):
 * this is mounted conditionally by the caller (`{spec && <…/>}`) exactly like
 * `InstructionRehearseModal`, and NEVER carries a changing `key` — so Ark's
 * body lock applies on mount and releases on unmount, balanced.
 */

import { Dialog, Portal } from "@chakra-ui/react";
import { Manipulative } from "@/components/manipulative/Manipulative";
import type { ManipulativeSpec } from "@/lib/manipulative/types";

export function ManipulativeRehearseModal({
  spec,
  title,
  onClose,
}: {
  spec: ManipulativeSpec;
  /** The item's teacher-facing prompt, shown in the dialog title. */
  title: string;
  onClose: () => void;
}) {
  return (
    <Dialog.Root open={true} onOpenChange={(e) => !e.open && onClose()} placement="center">
      <Portal>
        <Dialog.Backdrop />
        <Dialog.Positioner>
          {/* 508px = the scholar's own stage width (the 460px practice column in
              PracticeSession/Placement) + this dialog's p={4} and body px={2}.
              Rehearse is supposed to be what a scholar gets; a roomier preview
              is a fidelity bug in the flattering direction — a manipulative that
              fits here and not in the run is exactly what shipped the
              place-value wrap. Keep these in step if the practice column moves. */}
          <Dialog.Content maxW="508px" bg="#f6f3ec" borderRadius="20px" p={4}>
            <Dialog.Header px={2} pt={2} pb={1}>
              <Dialog.Title fontFamily="heading" fontSize="sm" color="charcoal.600">
                Rehearse · {title}
              </Dialog.Title>
              <Dialog.CloseTrigger />
            </Dialog.Header>
            <Dialog.Body
              px={2}
              py={3}
              maxH="80vh"
              overflowY="auto"
              display="flex"
              justifyContent="center"
              data-testid="manipulative-rehearse-body"
            >
              <Manipulative spec={spec} />
            </Dialog.Body>
          </Dialog.Content>
        </Dialog.Positioner>
      </Portal>
    </Dialog.Root>
  );
}
