"use client";

/**
 * The honest capability notice for a kind="game" activity opened in a browser.
 *
 * Games are native-only as POLICY, not as a gap waiting to be filled — so this
 * dialog states a fact and offers no fallback, no "open anyway", and no
 * degraded web substitute. The sentence comes from the game's own platform
 * declaration (`platformNotice()`), which is the same declaration the teacher
 * sees when authoring and assigning, so a scholar can never be the first person
 * to discover the requirement.
 *
 * Pairs with useGameActivity(): mount this next to any surface that calls
 * launch(), pass it the hook's prompt + dismiss.
 *
 * Dialog.Root stays mounted (open toggles) — never remount an Ark dialog scope
 * while open; see engineering-principles.md "Chakra/Ark Dialog Gotchas".
 */

import { Button, Dialog, Portal, Text } from "@chakra-ui/react";
import { StyledDialogContent } from "@/components/ui/StyledDialogContent";
import type { GameCapabilityPrompt } from "@/hooks/useGameActivity";

export function GameCapabilityNotice({
  prompt,
  onDismiss,
}: {
  prompt: GameCapabilityPrompt | null;
  onDismiss: () => void;
}) {
  return (
    <Dialog.Root
      open={!!prompt}
      onOpenChange={(e) => {
        if (!e.open) onDismiss();
      }}
      placement="center"
    >
      <Portal>
        <Dialog.Backdrop />
        <Dialog.Positioner>
          <StyledDialogContent>
            <Dialog.Header px={6} pt={5} pb={2}>
              <Dialog.Title fontFamily="heading" fontSize="lg" color="navy.500">
                {prompt?.notice ?? "This game runs on your iPad."}
              </Dialog.Title>
            </Dialog.Header>
            <Dialog.Body px={6} py={3}>
              <Text fontSize="sm" fontFamily="body" color="charcoal.500">
                Open it from the Rabbithole app on your iPad. Everything you do
                there shows up here afterwards.
              </Text>
            </Dialog.Body>
            <Dialog.Footer px={6} pb={5} pt={2} gap={2}>
              <Button
                size="sm"
                bg="navy.500"
                color="white"
                _hover={{ bg: "navy.600" }}
                fontFamily="heading"
                onClick={onDismiss}
              >
                Got it
              </Button>
            </Dialog.Footer>
          </StyledDialogContent>
        </Dialog.Positioner>
      </Portal>
    </Dialog.Root>
  );
}
