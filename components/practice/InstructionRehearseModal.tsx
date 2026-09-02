"use client";

/**
 * InstructionRehearseModal — the teacher "play it" (Rehearse) preview for a
 * strand's instructional content. It renders the EXACT scholar `LaunchpadCard`
 * (in `preview` mode) inside a dialog, so a teacher can walk both forks and,
 * once an interactive atom is present, actually DO the move a scholar will do —
 * finish the faded `try_it` step, drag the `manipulative`.
 *
 * Zero lifecycle writes, structurally: `LaunchpadCard preview` gates every
 * instruction mutation on `!preview` and takes no `scholarId`, so there is no
 * offer row, no choice/view/completion, and no retrieval. Rehearse is a pure
 * read of authored content — building it before an interactive atom existed
 * would have been decoration (see review/instructional-content-plan.html §7);
 * with `try_it`/`manipulative` it shows something you cannot get by reading the
 * atom JSON in the inventory table.
 */

import { Dialog, Portal } from "@chakra-ui/react";
import { LaunchpadCard } from "@/components/practice/LaunchpadCard";
import {
  SHOW_ME_LABEL,
  TRY_FIRST_LABEL,
  type InstructionAtom,
  type InstructionEntry,
} from "@/convex/lib/practice/instructionEntries";

export type RehearseLaunchpad = {
  key: string;
  domain: string;
  strand: string;
  title: string;
  subtitle: string | null;
  atoms: InstructionAtom[];
  version: number;
};

/** Build the scholar-wire `InstructionEntry` from a stored catalog row so the
 *  preview renders through the identical scholar code path. */
function toEntry(lp: RehearseLaunchpad): InstructionEntry {
  return {
    id: `rehearse:${lp.key}`,
    offerId: `rehearse:${lp.key}`,
    kind: "launchpad",
    level: "strand",
    key: lp.key,
    target: { domain: lp.domain, strand: lp.strand },
    title: lp.title,
    subtitle: lp.subtitle ?? undefined,
    fork: { tryFirstLabel: TRY_FIRST_LABEL, showMeLabel: SHOW_ME_LABEL },
    atoms: lp.atoms,
    contentVersion: lp.version,
    masteryEffect: "none",
  };
}

export function InstructionRehearseModal({
  launchpad,
  onClose,
}: {
  launchpad: RehearseLaunchpad;
  onClose: () => void;
}) {
  return (
    <Dialog.Root open={true} onOpenChange={(e) => !e.open && onClose()} placement="center">
      <Portal>
        <Dialog.Backdrop />
        <Dialog.Positioner>
          <Dialog.Content maxW="520px" bg="#f6f3ec" borderRadius="20px" p={4}>
            <Dialog.Header px={2} pt={2} pb={1}>
              <Dialog.Title fontFamily="heading" fontSize="sm" color="charcoal.600">
                Rehearse · {launchpad.strand}
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
              data-testid="instruction-rehearse-body"
            >
              <LaunchpadCard preview entry={toEntry(launchpad)} onProceed={onClose} />
            </Dialog.Body>
          </Dialog.Content>
        </Dialog.Positioner>
      </Portal>
    </Dialog.Root>
  );
}
