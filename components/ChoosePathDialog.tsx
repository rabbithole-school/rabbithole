"use client";

/**
 * Fallback "choose your path" dialog — used only for non-drawer entry points
 * into a TOPIC-seed quest (the star-map drawer hosts the picker inline so it's a
 * single click). Shares the live picker (`BakePathPicker`) with the drawer so the
 * two never diverge.
 *
 * Design principle (review/seed-to-unit-bake-plan.md): choice over the SHAPE of
 * an exploration, never its rigor — every option is the bot's own judgment of a
 * good gifted way in, so the outcome is worthwhile no matter which they pick.
 */
import { useState } from "react";
import {
  Box,
  Button,
  Dialog,
  Heading,
  IconButton,
  Portal,
  Stack,
  Text,
} from "@chakra-ui/react";
import { X } from "@phosphor-icons/react";
import { StyledDialogContent } from "@/components/ui/StyledDialogContent";
import { BakePathPicker } from "@/components/BakePathPicker";
import type { Id } from "@/convex/_generated/dataModel";
import type { PathChoice } from "@/lib/bakePaths";

interface ChoosePathDialogProps {
  open: boolean;
  seedId: Id<"seeds"> | null;
  topic: string | null;
  domain: string | null;
  submitting: boolean;
  onClose: () => void;
  onPick: (choice: PathChoice) => void;
}

export function ChoosePathDialog({
  open,
  seedId,
  topic,
  domain,
  submitting,
  onClose,
  onPick,
}: ChoosePathDialogProps) {
  const [chosen, setChosen] = useState<PathChoice | null>(null);

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(d) => !d.open && !submitting && onClose()}
      placement="center"
      motionPreset="slide-in-bottom"
    >
      <Portal>
        <Dialog.Backdrop />
        <Dialog.Positioner>
          <StyledDialogContent maxW="md">
            <Dialog.Header px={6} pt={6} pb={2}>
              <Stack gap={0} flex={1}>
                <Text
                  fontSize="xs"
                  color="charcoal.400"
                  fontFamily="heading"
                  fontWeight="600"
                  textTransform="uppercase"
                  letterSpacing="0.05em"
                >
                  Your quest
                </Text>
                <Heading size="md" color="navy.500" fontFamily="heading" fontWeight="700">
                  How do you want to explore it?
                </Heading>
                {topic && (
                  <Text fontSize="sm" color="charcoal.500" mt={1} lineClamp={2}>
                    {topic}
                    {domain ? ` · ${domain}` : ""}
                  </Text>
                )}
              </Stack>
              <Dialog.CloseTrigger asChild>
                <IconButton
                  aria-label="Close"
                  size="sm"
                  variant="ghost"
                  color="charcoal.400"
                  _hover={{ bg: "gray.100" }}
                  disabled={submitting}
                >
                  <X />
                </IconButton>
              </Dialog.CloseTrigger>
            </Dialog.Header>

            <Dialog.Body px={6} py={3}>
              {open && seedId && (
                <BakePathPicker source={{ kind: "seed", seedId }} onSelect={setChosen} />
              )}
            </Dialog.Body>

            <Box px={6} pb={5} pt={3}>
              <Button
                w="full"
                bg="violet.500"
                color="white"
                _hover={{ bg: "violet.600" }}
                onClick={() => chosen && onPick(chosen)}
                disabled={!chosen}
                loading={submitting}
                loadingText="Starting…"
                fontWeight="700"
              >
                Start exploring →
              </Button>
              <Text textAlign="center" fontSize="2xs" color="charcoal.300" mt={2.5}>
                Every path goes somewhere real — these are just different ways in.
              </Text>
            </Box>
          </StyledDialogContent>
        </Dialog.Positioner>
      </Portal>
    </Dialog.Root>
  );
}
