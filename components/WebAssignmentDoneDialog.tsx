"use client";

/**
 * "All done?" prompt shown after a Web Assignment session ends without
 * auto-completion (the XP-goal signal wasn't detected). Pairs with
 * useWebAssignment(): mount this next to any surface that calls
 * launch(), pass it the hook's donePrompt + resolveDonePrompt.
 *
 * Dialog.Root stays mounted (open toggles) — never remount an Ark
 * dialog scope while open; see engineering-principles.md "Chakra/Ark
 * Dialog Gotchas".
 */

import { Button, Dialog, Portal, Text } from "@chakra-ui/react";
import { StyledDialogContent } from "@/components/ui/StyledDialogContent";
import type { WebDonePrompt } from "@/hooks/useWebAssignment";

export function WebAssignmentDoneDialog({
  prompt,
  onResolve,
}: {
  prompt: WebDonePrompt | null;
  onResolve: (markDone: boolean) => void;
}) {
  return (
    <Dialog.Root
      open={!!prompt}
      onOpenChange={(e) => {
        if (!e.open) onResolve(false);
      }}
      placement="center"
    >
      <Portal>
        <Dialog.Backdrop />
        <Dialog.Positioner>
          <StyledDialogContent>
            <Dialog.Header px={6} pt={5} pb={2}>
              <Dialog.Title fontFamily="heading" fontSize="lg" color="navy.500">
                Done with {prompt?.activityTitle ?? "your assignment"}?
              </Dialog.Title>
            </Dialog.Header>
            <Dialog.Body px={6} py={3}>
              <Text fontSize="sm" fontFamily="body" color="charcoal.500">
                When you&apos;ve finished on the website, mark it done here.
              </Text>
            </Dialog.Body>
            <Dialog.Footer px={6} pb={5} pt={2} gap={2}>
              <Button
                size="sm"
                variant="ghost"
                fontFamily="heading"
                onClick={() => onResolve(false)}
              >
                Not yet
              </Button>
              <Button
                size="sm"
                bg="green.500"
                color="white"
                _hover={{ bg: "green.600" }}
                fontFamily="heading"
                onClick={() => onResolve(true)}
              >
                I&apos;m done
              </Button>
            </Dialog.Footer>
          </StyledDialogContent>
        </Dialog.Positioner>
      </Portal>
    </Dialog.Root>
  );
}
